import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Service } from './service.js';
import { launch, terminate } from './codex.js';
import type { Task } from './domain.js';

export class Runner {
  private active: {
    taskId: string;
    process: ChildProcessWithoutNullStreams;
    progress: string;
    sessionId: string | null;
    stopping: boolean;
    started: number;
  } | null = null;
  private busy = false;
  constructor(readonly service: Service) {}
  isActive(taskId: string) {
    return this.active?.taskId === taskId;
  }
  recoverInterrupted() {
    this.service.store.remove('settings', 'activeRun');
    for (const task of this.service.store.tasks().filter((t) => t.status === 'running')) {
      this.service.store.updateTask(task.id, {
        status: 'paused',
        checkpoint: `上次服务未正常结束。先检查工作目录、Codex 进程和已运行的验证，再恢复。\n${task.checkpoint}`,
      });
      this.service.store.notice(
        `interrupted:${task.id}:${task.updatedAt}`,
        'task',
        '上次任务执行被中断',
        `${task.title} 已暂停，等待检查后恢复。`,
      );
    }
  }
  async start(taskId: string) {
    if (!this.service.executionEnabled || this.service.demo)
      throw new Error('执行未启用；请以 QUOTACRAFT_ALLOW_EXEC=1 启动正常模式');
    if (this.active) throw new Error('已有任务正在执行；当前版本串行执行，避免争用额度和工作目录');
    const task = this.service.store.get<Task>('task', taskId);
    if (!task || task.status !== 'queued') throw new Error('任务必须处于排队状态');
    const q = this.service.store.quota();
    if (!q || q.source !== 'codex') throw new Error('执行需要真实 Codex 额度；手动输入只用于规划');
    const decision = this.service.preflight(taskId);
    if (decision.action !== 'ready') throw new Error(decision.reason);
    if (!task.prompt.trim()) throw new Error('请先为任务填写执行说明');
    if (
      !isAbsolute(task.workspace) ||
      !existsSync(task.workspace) ||
      !statSync(task.workspace).isDirectory()
    )
      throw new Error('请填写存在的绝对工作目录');
    // Atomic claim also prevents a second process from dispatching into an occupied database.
    this.service.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.service.store.tasks().some((t) => t.status === 'running'))
        throw new Error('数据库中已有执行中的任务');
      this.service.store.updateTask(taskId, {
        status: 'running',
        quotaBefore: Object.fromEntries(q.windows.map((w) => [w.id, w.usedPercent])),
      });
      this.service.store.db.exec('COMMIT');
    } catch (error) {
      this.service.store.db.exec('ROLLBACK');
      throw error;
    }
    const prompt = [
      task.prompt,
      `Acceptance criteria: ${task.acceptance || 'Report what changed and which verification ran.'}`,
      'Work only inside this project. Do not publish, push, send messages, or make purchases. Preserve requested quality. Finish with verification results and a concise checkpoint.',
      task.checkpoint
        ? `Previous checkpoint (verify current files before continuing):\n${task.checkpoint}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = launch(
        [
          '--ask-for-approval',
          'never',
          'exec',
          '--json',
          '--sandbox',
          'workspace-write',
          '--cd',
          task.workspace,
          '--model',
          decision.model,
          '-c',
          `model_reasoning_effort="${decision.effort}"`,
          prompt,
        ],
        true,
      );
    } catch (error) {
      this.service.store.updateTask(taskId, {
        status: 'paused',
        checkpoint: '未能启动。检查 Codex 路径和任务配置后恢复。',
      });
      throw error;
    }
    const active = {
      taskId,
      process: child,
      progress: '',
      sessionId: null as string | null,
      stopping: false,
      started: Date.now(),
    };
    this.active = active;
    this.service.store.put('settings', 'activeRun', { taskId, started: active.started });
    this.service.store.audit('run_started', {
      taskId,
      model: decision.model,
      effort: decision.effort,
      budget: decision.budget,
    });
    let buffer = '';
    let failed = false;
    let finalized = false;
    child.stderr.resume();
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      if (buffer.length > 1024 * 1024) {
        buffer = '';
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const e = JSON.parse(line);
          if (e.type === 'thread.started' && typeof e.thread_id === 'string')
            active.sessionId = e.thread_id;
          if (
            e.type === 'item.completed' &&
            e.item?.type === 'agent_message' &&
            typeof e.item.text === 'string'
          )
            active.progress = e.item.text.slice(-6000);
          if (e.type === 'turn.failed' || e.type === 'error') failed = true;
        } catch {
          /* Never persist raw subprocess logs. */
        }
      }
    });
    const finish = (code: number | null) => {
      if (finalized) return;
      finalized = true;
      const current = this.service.store.get<Task>('task', taskId);
      if (!current) return;
      const after = this.service.store.quota();
      const same =
        after &&
        after.accountKey === q.accountKey &&
        after.plan === q.plan &&
        after.source === 'codex' &&
        q.windows.every((w) =>
          after.windows.some(
            (x) => x.id === w.id && x.resetsAt === w.resetsAt && x.usedPercent >= w.usedPercent,
          ),
        );
      const cost =
        same && Date.parse(after!.observedAt) > active.started
          ? Math.max(
              ...q.windows.map(
                (w) => after!.windows.find((x) => x.id === w.id)!.usedPercent - w.usedPercent,
              ),
            )
          : null;
      const status = code === 0 && !active.stopping && !failed ? 'review' : 'paused';
      this.service.store.updateTask(taskId, {
        status,
        sessionId: active.sessionId,
        actualCost: cost,
        checkpoint: `${status === 'review' ? '执行结束，等待人工验收。' : '任务已暂停。检查工作目录中的改动后恢复。'}\n${active.progress || '尚无可用的最终摘要；重新开始前检查文件和测试状态。'}`,
      });
      this.service.store.notice(
        `run:${taskId}:${active.started}`,
        'task',
        status === 'review' ? '任务等待验收' : '任务已暂停',
        current.title,
      );
      this.service.store.audit('run_finished', { taskId, status, observedAccountCost: cost });
      this.service.store.remove('settings', 'activeRun');
      if (this.active === active) this.active = null;
    };
    child.on('error', () => finish(null));
    child.on('exit', finish);
    return { taskId, action: 'started', model: decision.model };
  }
  pause(taskId: string, reason = '用户暂停') {
    const active = this.active;
    if (!active || active.taskId !== taskId)
      throw new Error('当前进程未运行这个任务；可通过保存断点恢复异常退出的任务');
    active.stopping = true;
    this.service.store.updateTask(taskId, {
      checkpoint: `${reason}\n${active.progress}`,
      sessionId: active.sessionId,
    });
    terminate(active.process);
    this.service.store.audit('run_pause_requested', { taskId, reason });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.service.tickNotices();
      const q = this.service.store.quota();
      const p = this.service.store.policy();
      if (this.active) {
        const task = this.service.store.get<Task>('task', this.active.taskId)!;
        if (
          !q ||
          !this.service.snapshot().plan.fresh ||
          Math.min(...q.windows.map((w) => 100 - w.usedPercent)) <= p.reservePercent ||
          Date.now() - this.active.started > Math.min(180, task.minutes * 3) * 60_000
        ) {
          if (!this.active.stopping)
            this.pause(this.active.taskId, '额度预留线、过期数据或运行时间上限触发暂停');
        }
      } else if (p.autoRun && this.service.executionEnabled && !this.service.demo) {
        const next = this.service.snapshot().plan.decisions.find((d) => d.action === 'ready');
        if (next) {
          try {
            await this.start(next.taskId);
          } catch (error) {
            this.service.store.updateTask(next.taskId, {
              status: 'paused',
              checkpoint: error instanceof Error ? error.message : '启动失败',
            });
            this.service.store.notice(
              `start-failed:${next.taskId}`,
              'error',
              '自动任务未启动',
              '请检查任务配置，然后恢复。',
            );
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
  shutdown() {
    if (this.active && !this.active.stopping) this.pause(this.active.taskId, 'QuotaCraft 服务关闭');
  }
}

import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import {
  taskInput,
  signalSchema,
  policySchema,
  type QuotaSnapshot,
  type Signal,
  type Task,
} from './domain.js';
import { makePlan, burnRate, forecast, isFresh } from './planner.js';
import { readQuota } from './codex.js';
import { readCommunityForecast, readTibo, signalKey } from './signals.js';

export class Service {
  constructor(
    readonly store: Store,
    readonly demo = false,
    readonly executionEnabled = false,
  ) {}
  snapshot(now = Date.now()) {
    const quota = this.store.quota(),
      policy = this.store.policy(),
      tasks = this.store.tasks(),
      signals = this.store.signals();
    const completed = tasks.filter((t) => t.status === 'done');
    return {
      demo: this.demo,
      executionEnabled: this.executionEnabled && !this.demo,
      quota,
      policy,
      tasks,
      signals: [...signals].reverse(),
      plan: makePlan(tasks, quota, policy, signals, now),
      burn: burnRate(this.store.snapshots().slice(-500), now),
      forecast: forecast(signals, now),
      externalForecast: this.store.get<any>('settings', 'externalForecast'),
      notices: this.store.notices(),
      audit: this.store.all<any>('audit').slice(-40).reverse(),
      stats: {
        completed: completed.length,
        onTime: completed.filter(
          (t) => !t.deadline || Date.parse(t.completedAt!) <= Date.parse(t.deadline),
        ).length,
        accepted: tasks.filter((t) => t.accepted).length,
        paused: tasks.filter((t) => t.status === 'paused').length,
        costSamples: completed.filter((t) => t.actualCost !== null).length,
        averageEstimateError: completed.filter((t) => t.actualCost !== null).length
          ? completed
              .filter((t) => t.actualCost !== null)
              .reduce(
                (n, t) => n + Math.abs(t.actualCost! - (t.estimateLow + t.estimateHigh) / 2),
                0,
              ) / completed.filter((t) => t.actualCost !== null).length
          : null,
      },
    };
  }
  saveQuota(q: QuotaSnapshot) {
    const previous = this.store.quota();
    this.store.put('snapshot', q.id, q, q.observedAt);
    // Bounded local history; signals and task evidence are retained.
    this.store.db
      .prepare(
        "DELETE FROM records WHERE kind='snapshot' AND id NOT IN (SELECT id FROM records WHERE kind='snapshot' ORDER BY at DESC,rowid DESC LIMIT 2000)",
      )
      .run();
    for (const w of q.windows) {
      if (w.usedPercent >= 100 - this.store.policy().reservePercent)
        this.store.notice(
          `reserve:${q.accountKey}:${w.id}:${w.resetsAt}`,
          'reserve',
          '额度接近预留线',
          `${w.name} 剩余 ${(100 - w.usedPercent).toFixed(1)}%，优先完成当前任务收尾。`,
        );
      const before = previous?.windows.find((p) => p.id === w.id);
      if (
        previous &&
        previous.source === q.source &&
        previous.accountKey === q.accountKey &&
        previous.plan === q.plan &&
        before &&
        before.usedPercent - w.usedPercent >= 10
      ) {
        const scheduled =
          before.resetsAt && Date.parse(before.resetsAt) <= Date.parse(q.observedAt);
        this.store.notice(
          `restore:${q.accountKey}:${w.id}:${q.observedAt}`,
          'restore',
          scheduled ? '已观察到周期额度恢复' : '本账号额度已恢复',
          `${w.name} 从 ${before.usedPercent.toFixed(1)}% 已用降至 ${w.usedPercent.toFixed(1)}%。${scheduled ? '' : '属于账号观测，不能据此认定全员重置。'}`,
        );
      }
    }
    return q;
  }
  async refreshQuota() {
    if (this.demo) throw new Error('演示空间不读取真实账号；请启动正常模式');
    return this.saveQuota(await readQuota());
  }
  async syncSignals(source: 'x' | 'community') {
    if (this.demo) throw new Error('演示空间不连接外部源');
    if (source === 'community') {
      const data = await readCommunityForecast();
      this.store.put('settings', 'externalForecast', data);
      return data;
    }
    const signals = await readTibo();
    for (const signal of signals) this.addSignal(signal);
    return { imported: signals.length };
  }
  addSignal(input: unknown) {
    const parsed = signalSchema.parse(input);
    const existing = this.store.get<Signal>('signal', parsed.id);
    const unchanged =
      existing &&
      signalKey(existing) === signalKey({ ...parsed, knownAt: '' }) &&
      existing.scope === parsed.scope;
    const s = { ...parsed, knownAt: unchanged ? existing.knownAt : new Date().toISOString() };
    this.store.put('signal', s.id, s, s.occurredAt);
    if (s.kind === 'announced' || s.kind === 'confirmed' || s.kind === 'banked')
      this.store.notice(
        `signal:${s.id}:${signalKey(s)}`,
        'signal',
        s.kind === 'announced'
          ? '收到重置预告'
          : s.kind === 'banked'
            ? '收到重置次数消息'
            : '收到重置记录',
        `${s.title} · 范围：${s.scope} · 来源：${s.origin}`,
      );
    return s;
  }
  addTask(input: unknown) {
    return this.store.addTask(taskInput.parse(input));
  }
  savePolicy(input: unknown) {
    const p = policySchema.parse(input);
    if (p.autoRun && (!this.executionEnabled || this.demo))
      throw new Error('自动执行需要在启动时设置 QUOTACRAFT_ALLOW_EXEC=1；演示模式仅提供计划');
    this.store.put('settings', 'policy', p);
    this.store.audit('policy_changed', p);
    return p;
  }
  preflight(taskId: string) {
    const d = this.snapshot().plan.decisions.find((d) => d.taskId === taskId);
    if (!d) throw new Error('任务不存在');
    return {
      ...d,
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      advisory: true,
      note: '所有成本为额度百分点的保守估计，不是 token 限额；MCP 准入依赖宿主遵守，不能打断已经生成的请求。',
    };
  }
  checkpoint(id: string, text: string) {
    const task = this.store.updateTask(id, { checkpoint: text, status: 'paused' });
    this.store.audit('checkpoint_saved', { taskId: id });
    return task;
  }
  complete(id: string, accepted: boolean, actualCost?: number) {
    if (this.store.get<{ taskId: string }>('settings', 'activeRun')?.taskId === id)
      throw new Error('请等待任务进程结束后再验收');
    const task = this.store.get<Task>('task', id);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'review' && task.status !== 'paused')
      throw new Error('请先执行任务或保存断点，再确认验收');
    const result = this.store.updateTask(id, {
      status: accepted ? 'done' : 'queued',
      accepted,
      actualCost: actualCost ?? task.actualCost,
      completedAt: accepted ? new Date().toISOString() : null,
    });
    this.store.audit('task_reviewed', { taskId: id, accepted, actualCost: result.actualCost });
    return result;
  }
  tickNotices(now = Date.now()) {
    const q = this.store.quota();
    if (!isFresh(q, this.store.policy(), now)) return;
    for (const w of q!.windows) {
      const minutes = w.resetsAt ? (Date.parse(w.resetsAt) - now) / 60_000 : Infinity;
      if (minutes > 0 && minutes <= 30)
        this.store.notice(
          `upcoming:${q!.accountKey}:${w.id}:${w.resetsAt}`,
          'upcoming',
          '额度将在 30 分钟内恢复',
          `${w.name}：${w.resetsAt}。到期后会重新读取，确认实际恢复。`,
        );
    }
  }
  seedDemo() {
    if (!this.demo || this.store.tasks().length) return;
    const now = Date.now();
    const iso = (offset: number) => new Date(now + offset).toISOString();
    for (let i = 0; i < 6; i++)
      this.saveQuota({
        id: randomUUID(),
        observedAt: iso((i - 5) * 5 * 60_000),
        source: 'demo',
        accountKey: 'demo',
        plan: 'Demo',
        windows: [
          {
            id: 'demo:primary',
            name: '短期窗口 · 5 小时',
            usedPercent: 24 + i * 2,
            windowMinutes: 300,
            resetsAt: iso(3 * 3600_000),
          },
          {
            id: 'demo:weekly',
            name: '每周窗口 · 7 天',
            usedPercent: 36 + i,
            windowMinutes: 10080,
            resetsAt: iso(3 * 86400_000),
          },
        ],
      });
    const templates = [
      {
        title: '修复登录回调异常',
        project: 'atlas-web',
        priority: 'must',
        estimateLow: 6,
        estimateHigh: 9,
        finishReserve: 3,
        quality: 'high',
        minutes: 40,
        deadline: iso(6 * 3600_000),
        acceptance: '回调测试通过，覆盖过期会话',
      },
      {
        title: '完成任务 API 集成测试',
        project: 'atlas-api',
        priority: 'must',
        estimateLow: 5,
        estimateHigh: 8,
        finishReserve: 2,
        quality: 'balanced',
        minutes: 30,
        deadline: iso(12 * 3600_000),
        acceptance: '正常路径和权限边界测试通过',
      },
      {
        title: '整理部署文档',
        project: 'atlas-web',
        priority: 'should',
        estimateLow: 2,
        estimateHigh: 4,
        finishReserve: 1,
        quality: 'economy',
        minutes: 20,
        deadline: iso(36 * 3600_000),
        acceptance: '新环境可按文档成功启动',
      },
      {
        title: '重构历史数据导出',
        project: 'atlas-api',
        priority: 'could',
        estimateLow: 15,
        estimateHigh: 22,
        finishReserve: 5,
        quality: 'high',
        minutes: 60,
        deadline: null,
        acceptance: '导出结果与现有版本一致',
      },
    ];
    for (const t of templates) this.addTask({ ...t, prompt: '', workspace: '' });
    this.addSignal({
      id: 'demo:signal',
      title: '演示：新模型发布讨论',
      kind: 'hint',
      occurredAt: iso(-3 * 3600_000),
      resetAt: null,
      scope: 'unknown',
      sourceUrl: 'https://example.com/demo',
      evidence: '合成信号，不是实时推文。',
      origin: 'demo',
    });
  }
}

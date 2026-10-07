import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Service } from './service.js';
import { taskInput, type Task } from './domain.js';

export async function startMcp(service: Service) {
  const server = new McpServer({ name: 'quotacraft', version: '0.1.0' });
  const output = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  });
  const safe = (fn: () => unknown | Promise<unknown>) =>
    Promise.resolve()
      .then(fn)
      .then(output)
      .catch((error) => ({
        ...output({ error: error instanceof Error ? error.message : '请求失败' }),
        isError: true,
      }));
  server.registerTool(
    'quota_status',
    {
      description:
        'Read quota windows, freshness and task budget. Missing data blocks admission; no inference calls.',
      inputSchema: { refresh: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    ({ refresh }) =>
      safe(async () => {
        if (refresh) await service.refreshQuota();
        const s = service.snapshot();
        return { quota: s.quota, plan: s.plan, burn: s.burn, demo: s.demo };
      }),
  );
  server.registerTool(
    'task_create',
    {
      description:
        'Queue a deadline-aware task. Estimates are percentage points, conservatively applied to every exposed window. Does not execute.',
      inputSchema: { task: z.record(z.string(), z.unknown()) },
    },
    ({ task }) => safe(() => service.addTask(task)),
  );
  server.registerTool(
    'task_preflight',
    {
      description:
        'Check before an expensive stage. Honor ready/wait and expire after 60 seconds. Advisory: cannot interrupt model generation.',
      inputSchema: { taskId: z.string(), refresh: z.boolean().default(true) },
    },
    ({ taskId, refresh }) =>
      safe(async () => {
        if (refresh && !service.demo) await service.refreshQuota();
        return service.preflight(taskId);
      }),
  );
  server.registerTool(
    'task_checkpoint',
    {
      description:
        'Save progress and pause an externally managed task. Include changed files, checks, remaining work and a safe next step.',
      inputSchema: { taskId: z.string(), text: z.string().min(1).max(12000) },
    },
    ({ taskId, text }) =>
      safe(() => {
        if (service.store.get<Task>('task', taskId)?.status === 'running')
          throw new Error('请在控制台暂停受管任务，再保存断点');
        return service.checkpoint(taskId, text);
      }),
  );
  server.registerTool(
    'task_resume',
    {
      description: 'Requeue a paused task. Recheck quota before doing work.',
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) =>
      safe(() => {
        const t = service.store.get<Task>('task', taskId);
        if (t?.status !== 'paused') throw new Error('任务未暂停');
        return service.store.updateTask(taskId, { status: 'queued' });
      }),
  );
  server.registerTool(
    'task_complete',
    {
      description:
        'Record verified acceptance after checkpoint or run. Never mark done merely because a process exited.',
      inputSchema: {
        taskId: z.string(),
        accepted: z.boolean(),
        actualCost: z.number().min(0).max(100).optional(),
      },
    },
    ({ taskId, accepted, actualCost }) =>
      safe(() => service.complete(taskId, accepted, actualCost)),
  );
  server.registerTool(
    'schedule_plan',
    {
      description:
        'Explain deadline order, model/effort, finishing budget, and deferred tasks. No execution.',
      annotations: { readOnlyHint: true },
    },
    () => safe(() => service.snapshot().plan),
  );
  await server.connect(new StdioServerTransport());
}

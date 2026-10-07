import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Service } from './service.js';
import { Runner } from './runner.js';
import { iso, windowSchema, taskInput, type Task } from './domain.js';

export function createApp(service: Service, port: number, runner = new Runner(service)) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) {
      res.status(403).json({ error: '仅允许本机访问' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) {
      res.status(403).json({ error: '跨站请求已拒绝' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
        res.status(415).json({ error: '请求必须为 JSON' });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/state', (_req, res) => res.json(service.snapshot()));
  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, version: '0.1.1', demo: service.demo }),
  );
  app.post('/api/tasks', (req, res) => res.status(201).json(service.addTask(req.body)));
  app.patch('/api/tasks/:id', (req, res) => {
    const task = service.store.get<Task>('task', req.params.id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'running') throw new Error('请先暂停任务再修改');
    const parsed = taskInput.parse({ ...task, ...req.body });
    res.json(service.store.updateTask(task.id, parsed));
  });
  app.delete('/api/tasks/:id', (req, res) => {
    const task = service.store.get<Task>('task', req.params.id);
    if (task?.status === 'running') throw new Error('请先暂停任务');
    service.store.remove('task', req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/tasks/:id/checkpoint', (req, res) => {
    const { text } = z.object({ text: z.string().min(1).max(12000) }).parse(req.body);
    if (runner.isActive(req.params.id)) runner.pause(req.params.id, '保存断点');
    res.json(service.checkpoint(req.params.id, text));
  });
  app.post('/api/tasks/:id/resume', (req, res) => {
    if (service.store.get<{ taskId: string }>('settings', 'activeRun')?.taskId === req.params.id)
      throw new Error('请等待任务进程结束后再恢复');
    const task = service.store.get<Task>('task', req.params.id);
    if (!task || task.status !== 'paused') throw new Error('任务必须已暂停');
    res.json(service.store.updateTask(task.id, { status: 'queued' }));
  });
  app.post('/api/tasks/:id/review', (req, res) => {
    const data = z
      .object({ accepted: z.boolean(), actualCost: z.number().min(0).max(100).optional() })
      .parse(req.body);
    res.json(service.complete(req.params.id, data.accepted, data.actualCost));
  });
  app.post('/api/tasks/:id/start', async (req, res) => res.json(await runner.start(req.params.id)));
  app.post('/api/tasks/:id/pause', (req, res) => {
    runner.pause(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/tasks/:id/preflight', (req, res) => res.json(service.preflight(req.params.id)));
  app.put('/api/policy', (req, res) => res.json(service.savePolicy(req.body)));
  app.post('/api/quota/refresh', async (_req, res) => res.json(await service.refreshQuota()));
  app.post('/api/quota/manual', (req, res) => {
    const body = z
      .object({
        windows: z
          .array(windowSchema)
          .min(1)
          .max(20)
          .refine((w) => new Set(w.map((x) => x.id)).size === w.length, '窗口 ID 不能重复'),
      })
      .parse(req.body);
    res.json(
      service.saveQuota({
        id: randomUUID(),
        observedAt: new Date().toISOString(),
        source: service.demo ? 'demo' : 'manual',
        accountKey: service.demo ? 'demo' : 'manual',
        plan: null,
        windows: body.windows,
      }),
    );
  });
  app.post('/api/signals', (req, res) =>
    res
      .status(201)
      .json(service.addSignal({ ...req.body, origin: service.demo ? 'demo' : 'manual' })),
  );
  app.post('/api/signals/sync', async (req, res) => {
    const { source } = z.object({ source: z.enum(['x', 'community']) }).parse(req.body);
    res.json(await service.syncSignals(source));
  });
  app.post('/api/notices/read', (_req, res) => {
    for (const n of service.store.notices())
      service.store.put('notice', n.id, { ...n, read: true }, n.createdAt);
    res.json({ ok: true });
  });
  app.get('/api/export', (_req, res) =>
    res.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), ...service.snapshot() }),
  );
  app.post('/api/import/signals', (req, res) => {
    const input = z.object({ signals: z.array(z.unknown()).max(500) }).parse(req.body);
    for (const s of input.signals) service.addSignal(s);
    res.json({ imported: input.signals.length });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof z.ZodError ? 400 : err.status === 413 ? 413 : 400).json({
      error:
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')
          : err instanceof Error
            ? err.message
            : '请求失败',
    });
  });
  return { app, runner };
}

export async function serve(service: Service, port: number, dev = false) {
  const previousOwner = service.store.get<{ pid: number; at: number }>('settings', 'serverOwner');
  if (
    previousOwner &&
    previousOwner.pid !== process.pid &&
    Date.now() - previousOwner.at < 120_000
  ) {
    let alive = false;
    try {
      process.kill(previousOwner.pid, 0);
      alive = true;
    } catch {
      /* Owner no longer exists. */
    }
    if (alive) throw new Error('这个数据目录已有服务运行；请使用现有控制台，或指定独立数据目录');
  }
  const { app, runner } = createApp(service, port);
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: `${root}web`,
      configFile: `${root}vite.config.ts`,
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const path = fileURLToPath(new URL('../web-dist', import.meta.url));
    if (!existsSync(path)) throw new Error('找不到前端构建，请先运行 npm run build');
    app.use(express.static(path));
    app.get('/{*path}', (_req, res) => res.sendFile(`${path}/index.html`));
  }
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  runner.recoverInterrupted();
  service.store.put('settings', 'serverOwner', { pid: process.pid, at: Date.now() });
  console.log(`QuotaCraft ${service.demo ? '(DEMO)' : ''} http://127.0.0.1:${port}`);
  // Shared store owner: quota polling uses no inference requests. No hidden daemon or task installation.
  let polling = false;
  const refresh = async () => {
    if (service.demo || polling) return;
    polling = true;
    try {
      await service.refreshQuota();
    } catch (error) {
      service.store.notice(
        `provider-error:${Math.floor(Date.now() / 3600_000)}`,
        'error',
        '额度同步失败',
        error instanceof Error ? error.message : '请检查 Codex 登录',
      );
    } finally {
      polling = false;
    }
  };
  const quotaTimer = setInterval(() => void refresh(), 120_000);
  const tickTimer = setInterval(() => {
    service.store.put('settings', 'serverOwner', { pid: process.pid, at: Date.now() });
    void runner.tick();
  }, 15_000);
  let xTicks = 0;
  const signalTimer = setInterval(() => {
    if (process.env.X_BEARER_TOKEN && !service.demo && ++xTicks % 15 === 0)
      void service
        .syncSignals('x')
        .catch(() =>
          service.store.notice(
            `x-error:${Math.floor(Date.now() / 3600_000)}`,
            'error',
            '推文同步失败',
            '请检查 X API 配置；现有信号保留。',
          ),
        );
  }, 60_000);
  void refresh();
  const stop = () => {
    clearInterval(quotaTimer);
    clearInterval(tickTimer);
    clearInterval(signalTimer);
    runner.shutdown();
    service.store.remove('settings', 'serverOwner');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}

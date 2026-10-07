import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../src/store';
import { Service } from '../src/service';
import { createApp } from '../src/server';
import { defaultPolicy } from '../src/domain';
import { request } from 'node:http';
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  return new Service(store);
}
describe('task lifecycle and notification evidence', () => {
  it('requires a checkpoint or run and explicit acceptance before recording success', () => {
    const s = setup();
    const t = s.addTask({ title: 'test', project: 'app', estimateLow: 1, estimateHigh: 2 });
    expect(() => s.complete(t.id, true)).toThrow();
    s.checkpoint(t.id, 'Code updated; test passed.');
    s.complete(t.id, true, 3);
    expect(s.snapshot().stats.completed).toBe(1);
    expect(s.store.get<any>('task', t.id).accepted).toBe(true);
  });
  it('does not let a rejected task count as completed', () => {
    const s = setup();
    const t = s.addTask({ title: 'test', project: 'app', estimateLow: 1, estimateHigh: 2 });
    s.checkpoint(t.id, 'Needs review');
    s.complete(t.id, false);
    expect(s.snapshot().stats.completed).toBe(0);
    expect(s.store.get<any>('task', t.id).status).toBe('queued');
  });
  it('guards execution opt-in and validates cost intervals', () => {
    const s = setup();
    expect(() => s.savePolicy({ ...defaultPolicy, autoRun: true })).toThrow();
    expect(() =>
      s.addTask({ title: 'bad', project: 'app', estimateLow: 10, estimateHigh: 1 }),
    ).toThrow();
  });
  it('deduplicates signal notifications and separates banked credits from confirmed resets', () => {
    const s = setup();
    const input = {
      id: '1',
      title: 'Banked reset',
      kind: 'banked',
      scope: 'all',
      occurredAt: new Date().toISOString(),
      sourceUrl: 'https://example.com/reset',
      evidence: 'grant',
    };
    s.addSignal(input);
    s.addSignal(input);
    expect(s.store.notices()).toHaveLength(1);
    expect(s.snapshot().forecast.lastResetAt).toBeNull();
  });
  it('does not interpret switching accounts as a reset', () => {
    const s = setup();
    const q = {
      id: '1',
      observedAt: new Date().toISOString(),
      source: 'manual' as const,
      accountKey: 'a',
      plan: 'plus',
      windows: [
        {
          id: 'w',
          name: 'Weekly',
          usedPercent: 95,
          windowMinutes: 10080,
          resetsAt: new Date(Date.now() + 86400_000).toISOString(),
        },
      ],
    };
    s.saveQuota(q);
    s.saveQuota({ ...q, id: '2', accountKey: 'b', windows: [{ ...q.windows[0], usedPercent: 0 }] });
    expect(s.store.notices().filter((n) => n.kind === 'restore')).toHaveLength(0);
    s.saveQuota({
      ...q,
      id: '3',
      accountKey: 'b',
      windows: [{ ...q.windows[0], usedPercent: 70 }],
    });
    s.saveQuota({ ...q, id: '4', accountKey: 'b', windows: [{ ...q.windows[0], usedPercent: 0 }] });
    expect(s.store.notices().filter((n) => n.kind === 'restore')).toHaveLength(1);
  });
});
describe('loopback API boundary', () => {
  it('rejects cross-site mutations, DNS rebinding and non-JSON writes', async () => {
    const s = setup();
    const port = 4329;
    const { app } = createApp(s, port);
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    try {
      const url = `http://127.0.0.1:${port}`;
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${url}/api/state`, { headers: { Host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
      expect(
        (
          await fetch(`${url}/api/tasks`, {
            method: 'POST',
            headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${url}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: '{}',
          })
        ).status,
      ).toBe(415);
      expect(
        (
          await fetch(`${url}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: 'valid',
              project: 'app',
              estimateLow: 1,
              estimateHigh: 2,
            }),
          })
        ).status,
      ).toBe(201);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

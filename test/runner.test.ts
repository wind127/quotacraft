import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { Service } from '../src/service';
import { Runner } from '../src/runner';
import * as codex from '../src/codex';
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
});
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  const service = new Service(store, false, true);
  const now = new Date().toISOString();
  service.saveQuota({
    id: 'q',
    observedAt: now,
    source: 'codex',
    accountKey: 'test',
    plan: 'plus',
    windows: [
      {
        id: 'weekly',
        name: 'weekly',
        usedPercent: 40,
        windowMinutes: 10080,
        resetsAt: new Date(Date.now() + 86400000).toISOString(),
      },
    ],
  });
  const task = service.addTask({
    title: 'runner-test',
    project: 'test',
    estimateLow: 1,
    estimateHigh: 3,
    prompt: 'Fix the test',
    workspace: tmpdir(),
    acceptance: 'tests pass',
  });
  return { store, service, task, runner: new Runner(service) };
}
function child() {
  const p = new EventEmitter() as any;
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.stdin = new PassThrough();
  p.pid = 12345;
  p.kill = vi.fn(() => p.emit('exit', null));
  return p;
}
describe('managed execution boundaries', () => {
  it('blocks acceptance while a managed process still owns the task', async () => {
    const { runner, task, service } = setup();
    const p = child();
    vi.spyOn(codex, 'launch').mockReturnValue(p);
    await runner.start(task.id);
    service.checkpoint(task.id, 'Pause requested, process still exiting');
    expect(() => service.complete(task.id, true)).toThrow('进程结束');
    p.emit('exit', null);
    expect(() => service.complete(task.id, true)).not.toThrow();
  });
  it('recovers interrupted tasks without automatic resumption', () => {
    const { runner, task, store } = setup();
    store.updateTask(task.id, { status: 'running' });
    store.put('settings', 'activeRun', { taskId: task.id });
    runner.recoverInterrupted();
    expect(store.get<any>('task', task.id).status).toBe('paused');
    expect(store.get('settings', 'activeRun')).toBeNull();
  });
  it('launches argument arrays without a shell and waits for acceptance after normal exit', async () => {
    const { runner, task, store } = setup();
    const p = child();
    const spy = vi.spyOn(codex, 'launch').mockReturnValue(p);
    await runner.start(task.id);
    expect(spy.mock.calls[0][0]).toContain('workspace-write');
    expect(spy.mock.calls[0][0]).toContain('gpt-6.1-sol');
    expect(spy.mock.calls[0][0].at(-1)).toContain('tests pass');
    p.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }) + '\n');
    p.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Updated test.ts; tests passed.' },
      }) + '\n',
    );
    p.emit('exit', 0);
    expect(store.get<any>('task', task.id).status).toBe('review');
    expect(store.get<any>('task', task.id).checkpoint).toContain('tests passed');
    expect(store.get<any>('task', task.id).accepted).toBe(false);
  });
  it('pauses the owned process tree at reserve and preserves progress', async () => {
    const { runner, task, service, store } = setup();
    const p = child();
    vi.spyOn(codex, 'launch').mockReturnValue(p);
    vi.spyOn(codex, 'terminate').mockImplementation((process) => {
      process.emit('exit', null);
    });
    await runner.start(task.id);
    p.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Working checkpoint' },
      }) + '\n',
    );
    const before = store.quota()!;
    service.saveQuota({
      ...before,
      id: 'q-after',
      observedAt: new Date(Date.now() + 1).toISOString(),
      windows: before.windows.map((w) => ({ ...w, usedPercent: 81 })),
    });
    await runner.tick();
    expect(store.get<any>('task', task.id).status).toBe('paused');
    expect(store.get<any>('task', task.id).checkpoint).toContain('Working checkpoint');
  });
  it('never dispatches with manual data or disabled execution', async () => {
    const { runner, task, service, store } = setup();
    const before = store.quota()!;
    service.saveQuota({
      ...before,
      id: 'q-manual',
      observedAt: new Date(Date.now() + 1).toISOString(),
      source: 'manual',
    });
    await expect(runner.start(task.id)).rejects.toThrow('真实 Codex');
    const disabled = new Runner(new Service(store, false, false));
    await expect(disabled.start(task.id)).rejects.toThrow('执行未启用');
  });
  it('serializes runs and handles startup failure without retry loops', async () => {
    const { runner, task, service, store } = setup();
    const p = child();
    vi.spyOn(codex, 'launch').mockReturnValue(p);
    await runner.start(task.id);
    const second = service.addTask({
      title: 'second',
      project: 'test',
      estimateLow: 1,
      estimateHigh: 2,
    });
    await expect(runner.start(second.id)).rejects.toThrow('已有任务');
    p.emit('error', new Error('spawn failed'));
    expect(store.get<any>('task', task.id).status).toBe('paused');
  });
});

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  defaultPolicy,
  type Notice,
  type Policy,
  type QuotaSnapshot,
  type Signal,
  type Task,
  type TaskInput,
} from './domain.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS records_time ON records(kind,at);',
    );
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
  }
  all<T>(kind: string): T[] {
    return this.db
      .prepare('SELECT data FROM records WHERE kind=? ORDER BY at,rowid')
      .all(kind)
      .map((r) => JSON.parse(r.data as string));
  }
  get<T>(kind: string, id: string): T | null {
    const r = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
    return r ? JSON.parse(r.data as string) : null;
  }
  put(kind: string, id: string, data: unknown, at = new Date().toISOString()) {
    this.db
      .prepare(
        'INSERT INTO records(kind,id,data,at) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,at=excluded.at',
      )
      .run(kind, id, JSON.stringify(data), at);
  }
  remove(kind: string, id: string) {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  }
  policy(): Policy {
    return this.get<Policy>('settings', 'policy') ?? { ...defaultPolicy };
  }
  tasks() {
    return this.all<Task>('task');
  }
  snapshots() {
    return this.all<QuotaSnapshot>('snapshot');
  }
  quota() {
    return this.snapshots().at(-1) ?? null;
  }
  signals() {
    return this.all<Signal>('signal');
  }
  notices() {
    return this.all<Notice>('notice').slice(-100).reverse();
  }
  addTask(input: TaskInput): Task {
    const now = new Date().toISOString();
    const task: Task = {
      ...input,
      id: randomUUID(),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      checkpoint: '',
      sessionId: null,
      actualCost: null,
      completedAt: null,
      accepted: false,
      quotaBefore: {},
    };
    this.put('task', task.id, task);
    this.audit('task_created', { taskId: task.id });
    return task;
  }
  updateTask(id: string, patch: Partial<Task>): Task {
    const task = this.get<Task>('task', id);
    if (!task) throw new Error('任务不存在');
    const updated = {
      ...task,
      ...patch,
      id,
      createdAt: task.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.put('task', id, updated);
    return updated;
  }
  notice(key: string, kind: string, title: string, body: string) {
    if (this.get('notice', key)) return;
    this.put('notice', key, {
      id: key,
      kind,
      title,
      body,
      createdAt: new Date().toISOString(),
      read: false,
    } satisfies Notice);
  }
  audit(event: string, data: unknown) {
    const at = new Date().toISOString();
    this.put('audit', randomUUID(), { event, data, at }, at);
  }
  close() {
    this.db.close();
  }
}

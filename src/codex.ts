import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { windowSchema, type QuotaSnapshot, type QuotaWindow } from './domain.js';

export function command(): { file: string; prefix: string[] } {
  const explicit = process.env.QUOTACRAFT_CODEX_BIN;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error('QUOTACRAFT_CODEX_BIN 路径不存在');
    if (/\.(cmd|bat|ps1)$/i.test(explicit))
      throw new Error('请指定 codex.exe 或 bin/codex.js；不执行 shell 包装脚本');
    return extname(explicit) === '.js'
      ? { file: process.execPath, prefix: [explicit] }
      : { file: explicit, prefix: [] };
  }
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (process.platform !== 'win32') {
      const file = join(folder, 'codex');
      if (existsSync(file)) return { file, prefix: [] };
    } else {
      const exe = join(folder, 'codex.exe');
      if (existsSync(exe)) return { file: exe, prefix: [] };
      const launcher = join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(launcher)) return { file: process.execPath, prefix: [launcher] };
    }
  }
  throw new Error('未找到 Codex CLI。安装并登录后重试，或设置 QUOTACRAFT_CODEX_BIN');
}
export function launch(args: string[], managed = false): ChildProcessWithoutNullStreams {
  const c = command();
  return spawn(c.file, [...c.prefix, ...args], {
    stdio: 'pipe',
    windowsHide: true,
    shell: false,
    detached: managed && process.platform !== 'win32',
    env: { ...process.env, X_BEARER_TOKEN: undefined },
  });
}
export function terminate(child: ChildProcessWithoutNullStreams) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill();
    }
  }
}

export async function readQuota(): Promise<QuotaSnapshot> {
  const child = launch(['app-server', '--listen', 'stdio://'], true);
  let buffer = '';
  let finished = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ id: key, method, ...(params === undefined ? {} : { params }) }) + '\n',
      );
    });
  const rejectAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const timer = setTimeout(() => {
    rejectAll(new Error('Codex 额度读取超时（20 秒）'));
    terminate(child);
  }, 20_000);
  child.on('error', () => rejectAll(new Error('无法启动 Codex CLI')));
  child.on('exit', () => {
    if (!finished) rejectAll(new Error('Codex app-server 提前退出；请检查登录状态和 CLI 版本'));
  });
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    if (buffer.length > 4 * 1024 * 1024) {
      rejectAll(new Error('Codex 响应超过允许大小'));
      terminate(child);
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error)
          p.reject(new Error(`Codex 接口错误 ${msg.error.code ?? ''}；请确认已使用 ChatGPT 登录`));
        else p.resolve(msg.result);
      } catch {
        /* Ignore non-JSON diagnostics; never store or forward them. */
      }
    }
  });
  child.stderr.resume();
  try {
    await request('initialize', {
      clientInfo: { name: 'quotacraft', version: '0.1.1' },
      capabilities: { experimentalApi: false },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const account = await request('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt')
      throw new Error(
        '请先运行 codex login，使用 ChatGPT 订阅登录；API Key 账号没有可读取的订阅额度',
      );
    const response = await request('account/rateLimits/read');
    const windows = normalizeLimits(response);
    if (!windows.length) throw new Error('服务未返回可用的额度窗口；不会把缺失数据当成 0% 使用');
    const accountKey = createHash('sha256')
      .update(String(account.account.id ?? account.account.email ?? 'local-profile'))
      .digest('hex')
      .slice(0, 16);
    return {
      id: randomUUID(),
      observedAt: new Date().toISOString(),
      source: 'codex',
      accountKey,
      plan: account.account.planType ?? null,
      windows,
    };
  } finally {
    finished = true;
    clearTimeout(timer);
    rejectAll(new Error('读取结束'));
    child.stdin.end();
    terminate(child);
  }
}

export function normalizeLimits(response: any): QuotaWindow[] {
  const map = response?.rateLimitsByLimitId;
  const buckets =
    map && typeof map === 'object' && Object.keys(map).length
      ? Object.entries(map)
      : [['codex', response?.rateLimits]];
  const windows: QuotaWindow[] = [];
  for (const [key, raw] of buckets) {
    const bucket = raw as any;
    for (const variant of ['primary', 'secondary']) {
      const w = bucket?.[variant];
      if (!w) continue;
      const parsed = windowSchema.safeParse({
        id: `${key}:${variant}`,
        name: `${bucket.limitName ?? key} · ${w.windowDurationMins >= 10080 ? '每周' : `${w.windowDurationMins / 60} 小时`}`,
        usedPercent: w.usedPercent,
        windowMinutes: w.windowDurationMins,
        resetsAt:
          typeof w.resetsAt === 'number' && w.resetsAt > 0 && w.resetsAt < 8_640_000_000_000
            ? new Date(w.resetsAt * 1000).toISOString()
            : null,
      });
      if (parsed.success) windows.push(parsed.data);
    }
  }
  return windows;
}

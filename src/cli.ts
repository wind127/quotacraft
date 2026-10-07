#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { Store } from './store.js';
import { Service } from './service.js';
import { serve } from './server.js';
import { startMcp } from './mcp.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'serve';
const demo = args.includes('--demo');
const dataDir = process.env.QUOTACRAFT_DATA_DIR ?? join(homedir(), '.quotacraft');
const store = new Store(join(dataDir, demo ? 'demo.sqlite' : 'state.sqlite'));
const service = new Service(store, demo, process.env.QUOTACRAFT_ALLOW_EXEC === '1');
service.seedDemo();
try {
  if (command === 'serve') {
    const port = Number(process.env.QUOTACRAFT_PORT ?? 4318);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error('端口必须为 1024–65535 的整数');
    await serve(service, port, args.includes('--dev'));
  } else if (command === 'mcp') await startMcp(service);
  else if (command === 'status' || command === 'plan') {
    if (args.includes('--refresh') && !demo) await service.refreshQuota();
    console.log(
      JSON.stringify(command === 'plan' ? service.snapshot().plan : service.snapshot(), null, 2),
    );
    store.close();
  } else if (command === 'add') {
    if (!args[1]) throw new Error('用法：node dist/cli.js add task.json');
    console.log(
      JSON.stringify(service.addTask(JSON.parse(readFileSync(args[1], 'utf8'))), null, 2),
    );
    store.close();
  } else if (command === 'import-signals') {
    if (!args[1]) throw new Error('用法：node dist/cli.js import-signals signals.json');
    const input = JSON.parse(readFileSync(args[1], 'utf8'));
    if (!Array.isArray(input)) throw new Error('信号文件必须为数组');
    for (const s of input) service.addSignal(s);
    console.log(`Imported ${input.length} signals`);
    store.close();
  } else {
    console.log(
      'QuotaCraft: serve [--demo] [--dev] | mcp | status [--refresh] | plan | add task.json | import-signals signals.json',
    );
    store.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '操作失败');
  store.close();
  process.exitCode = 1;
}

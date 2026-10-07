import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('stdio MCP contract', () => {
  it('completes a real handshake, lists tools, and persists a task checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quotacraft-mcp-'));
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli.ts', 'mcp', '--demo'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        QUOTACRAFT_DATA_DIR: dir,
      },
      stderr: 'pipe',
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('task_preflight');
      expect(tools.tools).toHaveLength(7);
      const created = await client.callTool({
        name: 'task_create',
        arguments: {
          task: { title: 'MCP task', project: 'test', estimateLow: 1, estimateHigh: 2 },
        },
      });
      expect(created.isError).not.toBe(true);
      const task = JSON.parse((created.content as any)[0].text);
      const checkpoint = await client.callTool({
        name: 'task_checkpoint',
        arguments: { taskId: task.id, text: 'Files checked, safe to resume.' },
      });
      expect(JSON.parse((checkpoint.content as any)[0].text).status).toBe('paused');
      const completed = await client.callTool({
        name: 'task_complete',
        arguments: { taskId: task.id, accepted: true, actualCost: 1 },
      });
      expect(JSON.parse((completed.content as any)[0].text).status).toBe('done');
    } finally {
      await client.close();
    }
  }, 20000);
});

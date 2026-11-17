import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

test('MCP server exposes status and explicit-confirmation publish tools', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'reposend-mcp-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync('git', ['init', repository], { stdio: 'ignore' });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repository,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'reposend-test', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['reposend_publish', 'reposend_status'],
  );
  const publishTool = tools.tools.find((tool) => tool.name === 'reposend_publish');
  assert.equal(publishTool.inputSchema.properties.confirmed.const, true);

  const status = await client.callTool({ name: 'reposend_status', arguments: {} });
  assert.equal(status.isError, undefined);
  assert.match(status.content[0].text, /##/);
});

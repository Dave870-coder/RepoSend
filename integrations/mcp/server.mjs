#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const cliPath = fileURLToPath(new URL('../../bin/reposend.mjs', import.meta.url));
const repoRoot = resolve(process.env.REPOSEND_REPO_ROOT || process.cwd());
const server = new McpServer({ name: 'reposend', version: '0.1.0' });

server.tool(
  'reposend_status',
  'Read the Git branch and working-tree status for the configured repository.',
  {},
  async () => {
    try {
      const output = await runCommand('git', ['status', '--short', '--branch'], repoRoot);
      return { content: [{ type: 'text', text: output.trim() || 'The working tree is clean.' }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  'reposend_publish',
  'Publish only the selected paths from the configured local Git checkout. Call only after the user explicitly confirms this publish. Git credentials come from the configured Git credential helper.',
  {
    paths: z.array(z.string().min(1)).min(1),
    remote: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    newBranch: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    confirmed: z.literal(true),
  },
  async ({ paths, remote, branch, newBranch, message }) => {
    if (branch && newBranch) {
      return toolError(new Error('Use either branch or newBranch, not both.'));
    }
    const args = [];
    if (remote) args.push('--remote', remote);
    if (branch) args.push('--branch', branch);
    if (newBranch) args.push('--new-branch', newBranch);
    if (message) args.push('--message', message);
    args.push('--', ...paths);

    try {
      const output = await runCommand(process.execPath, [cliPath, ...args], repoRoot);
      return { content: [{ type: 'text', text: output.trim() || 'Publish completed.' }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

function runCommand(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let exceededLimit = false;
    const maxOutputBytes = 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        exceededLimit = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        exceededLimit = true;
        child.kill();
        return;
      }
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (exceededLimit) {
        reject(new Error('Command output exceeded the 1 MiB RepoSend MCP limit.'));
        return;
      }
      if (code === 0) {
        resolvePromise([stdout, stderr].filter(Boolean).join('\n'));
      } else {
        reject(new Error(stderr.trim() || `Command failed with exit code ${code}.`));
      }
    });
  });
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : 'Unexpected RepoSend MCP error.' }],
  };
}

await server.connect(new StdioServerTransport());

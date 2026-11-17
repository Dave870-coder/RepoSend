import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveRepoPaths } from './reposend.mjs';

const cliPath = fileURLToPath(new URL('./reposend.mjs', import.meta.url));

test('parses options and preserves paths containing spaces', () => {
  assert.deepEqual(
    parseArgs(['--remote', 'upstream', '--new-branch', 'feature/send', '--message', 'First commit', '--', 'src/my file.ts']),
    {
      remote: 'upstream',
      branch: '',
      newBranch: 'feature/send',
      message: 'First commit',
      paths: ['src/my file.ts'],
      help: false,
    },
  );
});

test('rejects paths outside the checkout', () => {
  assert.throws(() => resolveRepoPaths('/workspace/project', ['../secrets.txt']), /outside the Git checkout/);
});

test('resolves paths relative to the invocation directory', () => {
  assert.deepEqual(
    resolveRepoPaths('/workspace/project', ['nested file.ts'], '/workspace/project/src'),
    ['src/nested file.ts'],
  );
});

test('commits selected files and pushes a new branch to a local Git remote', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'reposend-cli-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const repository = join(temporaryDirectory, 'working-copy');
  const remote = join(temporaryDirectory, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', repository], { stdio: 'ignore' });
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'RepoSend Test']);
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'reposend-test@example.invalid']);
  execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', remote]);
  await writeFile(join(repository, 'seed.txt'), 'seed\n');
  execFileSync('git', ['-C', repository, 'add', 'seed.txt']);
  execFileSync('git', ['-C', repository, 'commit', '-m', 'Initial commit'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repository, 'branch', '-M', 'main']);
  execFileSync('git', ['-C', repository, 'push', '--set-upstream', 'origin', 'main'], { stdio: 'ignore' });

  const sourceDirectory = join(repository, 'src');
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, 'file with spaces.txt'), 'published\n');
  const result = spawnSync(
    process.execPath,
    [cliPath, '--new-branch', 'feature/send', '--', 'file with spaces.txt'],
    { cwd: sourceDirectory, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Published branch "feature\/send" to remote "origin"/);
  assert.equal(
    execFileSync(
      'git',
      ['--git-dir', remote, 'show', 'feature/send:src/file with spaces.txt'],
      { encoding: 'utf8' },
    ),
    'published\n',
  );
});

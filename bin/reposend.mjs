#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = `RepoSend CLI — publish selected files through Git

Usage:
  node ./bin/reposend.mjs [options] <path>...

Options:
  --remote <name>       Git remote to push to (default: origin)
  --branch <name>       Require the current branch to match this name
  --new-branch <name>   Create and switch to a new local branch before publishing
  --message <text>      Commit message
  --                    Treat remaining arguments as file paths
  --help                Show this help

Run inside an existing Git checkout. Authentication is handled by Git's
credential manager; do not put access tokens in remote URLs or command arguments.
`;

export function parseArgs(argv) {
  const options = {
    remote: 'origin',
    branch: '',
    newBranch: '',
    message: '',
    paths: [],
    help: false,
  };
  let pathsOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (pathsOnly) {
      options.paths.push(argument);
      continue;
    }
    if (argument === '--') {
      pathsOnly = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (['--remote', '--branch', '--new-branch', '--message'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}.`);
      }
      index += 1;
      if (argument === '--remote') options.remote = value;
      else if (argument === '--branch') options.branch = value;
      else if (argument === '--new-branch') options.newBranch = value;
      else options.message = value;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    }
    options.paths.push(argument);
  }

  if (options.branch && options.newBranch) {
    throw new Error('Use either --branch or --new-branch, not both.');
  }
  if (!options.help && options.paths.length === 0) {
    throw new Error('Specify at least one file or directory to publish. Use --help for usage.');
  }
  return options;
}

export function resolveRepoPaths(root, inputs, baseDirectory = root) {
  return inputs.map((input) => {
    if (!input) throw new Error('File paths must not be empty.');
    const absolutePath = resolve(baseDirectory, input);
    const repositoryPath = relative(root, absolutePath);
    if (
      isAbsolute(repositoryPath)
      || repositoryPath === '..'
      || repositoryPath.startsWith(`..${sep}`)
    ) {
      throw new Error(`Path is outside the Git checkout: ${input}`);
    }
    return (repositoryPath || '.').split(sep).join('/');
  });
}

function runGit(args, cwd, { inherit = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(inherit ? { stdio: 'inherit' } : {}),
  });
  if (result.error) {
    throw new Error(`Could not start Git: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr?.trim() || `Git ${args[0]} failed.`);
  }
  return result;
}

function validateBranchName(branch, cwd) {
  const result = runGit(['check-ref-format', '--branch', branch], cwd, { allowFailure: true });
  if (result.status !== 0) throw new Error(`Invalid Git branch name: ${branch}`);
}

export function run(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const rootResult = runGit(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true });
  const root = rootResult.stdout?.trim();
  if (rootResult.status !== 0 || !root) {
    throw new Error('Run RepoSend inside an existing Git checkout.');
  }

  if (!options.remote || options.remote.startsWith('-')) {
    throw new Error('Use a configured Git remote name, such as "origin".');
  }
  const remoteResult = runGit(['remote'], root);
  const remotes = remoteResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!remotes.includes(options.remote)) {
    throw new Error(`Git remote "${options.remote}" was not found. Configure it with git remote add.`);
  }
  const remoteUrl = runGit(['remote', 'get-url', options.remote], root).stdout.trim();
  if (/^https?:\/\//i.test(remoteUrl)) {
    const url = new URL(remoteUrl);
    if (url.username || url.password) {
      throw new Error('The Git remote URL contains embedded credentials. Remove them and use a Git credential helper.');
    }
  }

  const branchResult = runGit(['branch', '--show-current'], root);
  const currentBranch = branchResult.stdout.trim();
  if (!currentBranch) {
    throw new Error('The checkout is in detached HEAD state. Switch to a branch before publishing.');
  }
  const targetBranch = options.newBranch || options.branch || currentBranch;
  validateBranchName(targetBranch, root);
  if (options.branch && options.branch !== currentBranch) {
    throw new Error(
      `Current branch is "${currentBranch}", not "${options.branch}". Switch branches first, or use --new-branch.`,
    );
  }

  const stagedChanges = runGit(['diff', '--cached', '--quiet'], root, { allowFailure: true });
  if (stagedChanges.status === 1) {
    throw new Error('There are already staged changes. Commit or unstage them before using RepoSend.');
  }
  if (stagedChanges.status !== 0) {
    throw new Error('Could not inspect staged changes. Check the Git checkout and try again.');
  }

  const paths = resolveRepoPaths(root, options.paths, resolve(cwd));
  if (options.newBranch) {
    runGit(['switch', '-c', targetBranch], root, { inherit: true });
  }

  runGit(['--literal-pathspecs', 'add', '--', ...paths], root, { inherit: true });

  const stagedDiff = runGit(['diff', '--cached', '--quiet'], root, { allowFailure: true });
  if (stagedDiff.status !== 0 && stagedDiff.status !== 1) {
    throw new Error('Could not inspect the selected changes. Check the Git checkout and try again.');
  }
  if (stagedDiff.status === 1) {
    const message = options.message || `Publish ${options.paths.length} path${options.paths.length === 1 ? '' : 's'} with RepoSend`;
    runGit(['commit', '-m', message], root, { inherit: true });
  } else {
    process.stdout.write('No new changes in the selected paths; attempting to push existing local commits.\n');
  }

  try {
    runGit(['push', '--set-upstream', options.remote, targetBranch], root, { inherit: true });
  } catch (error) {
    throw new Error(
      `Push to "${options.remote}" failed. Any new commit is still local; check credentials, network, branch permissions, and retry.`,
      { cause: error },
    );
  }
  process.stdout.write(`Published branch "${targetBranch}" to remote "${options.remote}".\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`RepoSend: ${error instanceof Error ? error.message : 'Unexpected error.'}\n`);
    process.exitCode = 1;
  }
}

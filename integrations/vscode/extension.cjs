const vscode = require('vscode');
const { spawn } = require('node:child_process');
const path = require('node:path');

function activate(context) {
  const output = vscode.window.createOutputChannel('RepoSend');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('reposend.publish', async () => {
    const folder = await chooseWorkspaceFolder();
    if (!folder) return;

    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      '**/{.git,node_modules,dist,coverage}/**',
      2000,
    );
    if (!files.length) {
      void vscode.window.showInformationMessage('RepoSend did not find files in this workspace folder.');
      return;
    }

    const choices = files.map((uri) => ({
      label: vscode.workspace.asRelativePath(uri, false),
      description: '',
      uri,
    }));
    const selected = await vscode.window.showQuickPick(choices, {
      canPickMany: true,
      placeHolder: 'Choose the files to publish (at most 2,000 files are listed)',
      ignoreFocusOut: true,
    });
    if (!selected?.length) return;

    const branch = await vscode.window.showInputBox({
      prompt: 'Create a new branch for this publish',
      placeHolder: 'feature/update',
      validateInput: (value) => value.trim() ? undefined : 'Enter a branch name.',
      ignoreFocusOut: true,
    });
    if (!branch) return;

    const message = await vscode.window.showInputBox({
      prompt: 'Commit message',
      value: `Publish ${selected.length} selected file${selected.length === 1 ? '' : 's'} with RepoSend`,
      ignoreFocusOut: true,
    });
    if (!message) return;

    const confirmation = await vscode.window.showWarningMessage(
      `Commit and push ${selected.length} selected file${selected.length === 1 ? '' : 's'} to a new branch on the configured remote?`,
      { modal: true, detail: 'RepoSend uses your local Git credential helper. Existing staged changes are not included.' },
      'Publish',
    );
    if (confirmation !== 'Publish') return;

    try {
      const executable = await resolveCli(folder);
      const args = [...executable.args, '--new-branch', branch, '--message', message, '--'];
      args.push(...selected.map(({ uri }) => path.relative(folder.uri.fsPath, uri.fsPath)));
      output.show(true);
      output.appendLine(`Publishing ${selected.length} selected paths from ${folder.name}…`);
      await run(executable.command, args, folder.uri.fsPath, output);
      void vscode.window.showInformationMessage('RepoSend published the selected files.');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unexpected RepoSend error.';
      output.appendLine(`RepoSend: ${detail}`);
      void vscode.window.showErrorMessage(`RepoSend could not publish: ${detail}`);
    }
  }));
}

async function chooseWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Open a Git workspace folder before using RepoSend.');
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: 'Choose the Git workspace folder to publish from' },
  );
  return selected?.folder;
}

async function resolveCli(folder) {
  const configured = vscode.workspace.getConfiguration('reposend').get('cliPath');
  let cliPath = configured;
  if (!cliPath) {
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, 'bin/reposend.mjs'),
      '**/node_modules/**',
      1,
    );
    cliPath = matches[0]?.fsPath;
  }
  if (!cliPath) {
    throw new Error('Set reposend.cliPath to the absolute path of RepoSend’s bin/reposend.mjs.');
  }
  if (!path.isAbsolute(cliPath)) cliPath = path.resolve(folder.uri.fsPath, cliPath);
  if (cliPath.endsWith('.mjs') || cliPath.endsWith('.js')) {
    return { command: process.execPath, args: [cliPath] };
  }
  return { command: cliPath, args: [] };
}

function run(command, args, cwd, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => output.append(text));
    child.stderr.on('data', (text) => output.append(text));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`RepoSend exited with code ${code}. See the RepoSend output channel for details.`));
    });
  });
}

function deactivate() {}

module.exports = { activate, deactivate };

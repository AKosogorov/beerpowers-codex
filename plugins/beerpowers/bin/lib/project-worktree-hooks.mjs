// Запускает проектные хуки при создании и удалении рабочих деревьев.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, safe, git, fail } from './git-repositories.mjs';

export function runProjectHook(kind, code, name, checkout, { flags = [], preview = false } = {}) {
  const base = '.codex/bin/worktree-' + kind;
  const hook = [base + '.mjs', base, base + '.ps1'].find(file => fs.existsSync(safe(file)));
  if (!hook) return null;
  let program = safe(hook);
  let argv = [code, name, safe(checkout), ...flags];
  if (preview && !/^(?:#|\/\/) supports: --dry-run\r?$/m.test(fs.readFileSync(program, 'utf8'))) return { hook };
  if (preview) argv.push('--dry-run');
  if (hook.endsWith('.mjs')) { argv.unshift(program); program = process.execPath; }
  else if (hook.endsWith('.ps1')) { argv.unshift('-NoProfile', '-NonInteractive', '-File', program); program = 'powershell.exe'; }
  else if (process.platform === 'win32') {
    const gitDir = git(root, ['--exec-path']);
    argv.unshift(program);
    program = path.resolve(gitDir, '../../../bin/bash.exe');
    if (!fs.existsSync(program)) fail('Git for Windows Bash missing for ' + hook);
  }
  const result = spawnSync(program, argv, { cwd: root, stdio: preview ? 'pipe' : 'ignore', encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WORKSPACE_ROOT: root } });
  if (result.status !== 0) fail(hook + ' failed for ' + checkout + ' (exit ' + (result.error?.code ?? result.status) + ')');
  return preview ? { hook, output: (result.stdout + result.stderr).trimEnd() } : hook;
}

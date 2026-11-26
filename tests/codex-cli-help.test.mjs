import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const bin = resolve(import.meta.dirname, '../plugins/beerpowers/bin');
// Required by workspace.pl or imported by other programs; no command of their own.
const libraries = new Set(['feature-state.pl', 'handover.pl', 'review-diff.pl', 'role-packet.pl',
  'task-integrations.pl', 'task-start.pl', 'git-flow-format.mjs']);
const subcommands = {
  'workspace.pl': ['task-start', 'review-diff', 'feature-state', 'role-packet', 'handover'],
  'git-workspace.mjs': ['task-plan', 'task-start', 'worktrees-clear'],
  'retro.mjs': ['status', 'plan', 'distill'],
  'token-audit.mjs': ['project', 'window'],
  'update.mjs': ['plan', 'apply'],
  'publication.mjs': ['prepare'],
  'tracker.mjs': ['read', 'write'],
  'ui-acceptance.mjs': ['discover', 'matrix'],
  'workspace-clean': ['worktree', 'task'],
};
function interpreter(file) {
  const tool = file === 'make-shim' ? 'bash' : file.endsWith('.pl') ? 'perl' : 'node';
  if (tool === 'node') return process.execPath;
  if (tool === 'perl' && process.env.BEERPOWERS_PERL) return process.env.BEERPOWERS_PERL;
  if (process.platform !== 'win32') return tool;
  return execFileSync('where.exe', ['git.exe'], {encoding: 'utf8'}).trim().split(/\r?\n/)
    .map(git => resolve(dirname(git), '../usr/bin', tool + '.exe')).find(existsSync);
}
for (const file of readdirSync(bin, {withFileTypes: true}).filter(f => f.isFile() && !libraries.has(f.name))) {
  test(file.name + ' prints help outside a workspace', t => {
    const cwd = mkdtempSync(join(tmpdir(), 'beerpowers-help-'));
    t.after(() => rmSync(cwd, {recursive: true, force: true}));
    for (const command of ['', ...(subcommands[file.name] ?? [])]) {
      const args = [join(bin, file.name), ...(command ? [command] : []), '--help'];
      const result = spawnSync(interpreter(file.name), args, {cwd, encoding: 'utf8', timeout: 10000,
        env: {...process.env, CODEX_HOME: join(cwd, 'unused'), GIT_CEILING_DIRECTORIES: dirname(cwd)}});
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.ok(result.stdout.trim(), args.join(' '));
    }
    assert.deepEqual(readdirSync(cwd), []);
  });
}

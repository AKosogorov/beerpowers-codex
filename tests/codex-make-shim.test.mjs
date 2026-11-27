import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const win = process.platform === 'win32';
const packageDir = resolve(import.meta.dirname, '../plugins/beerpowers');
const whereGit = win && spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' });
const bash = win ? whereGit.stdout?.trim().split(/\r?\n/)
  .map(path => resolve(dirname(path), '../bin/bash.exe')).find(existsSync) : 'bash';
const msysMake = win && existsSync(join(process.env.BEERPOWERS_MSYS2_ROOT || 'C:/msys64', 'usr/bin/make.exe'));
const makeAvailable = win ? bash && msysMake : spawnSync('make', ['--version']).status === 0;

function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), 'beerpowers make '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'worktrees', 'TASK-1', 'product');
  const bin = join(root, 'plugin cache #$', '0.0.0', 'bin');
  const temp = join(root, 'recipe temp');
  for (const dir of [cwd, join(bin, 'lib'), temp]) mkdirSync(dir, { recursive: true });
  const shim = join(bin, 'make-shim');
  copyFileSync(join(packageDir, 'bin/make-shim'), shim);
  copyFileSync(join(packageDir, 'bin/lib/make-shim.mk'), join(bin, 'lib/make-shim.mk'));
  return { root, cwd, shim, temp };
}

test('make-shim runs the recorded product goal with spaces and special characters in package paths', {
  skip: !makeAvailable,
}, t => {
  const { root, cwd, shim, temp } = checkout(t);
  const env = {
    ...process.env,
    TMP: temp,
    TEMP: temp,
  };
  const recipe = 'SHELL := /bin/bash\ncheck:\n\t@[[ -n "$$BASH_VERSION" ]] && "$(CHECK_NODE)" probe.cjs "$(CHECK_VALUE)"\n';
  writeFileSync(join(cwd, 'Makefile'), recipe + 'recursive:\n\t@$(MAKE) --no-print-directory check\n');
  writeFileSync(join(cwd, 'test rules.mk'), recipe.replace('check:', 'verify:'));
  writeFileSync(join(cwd, 'probe.cjs'), 'console.log(JSON.stringify([process.env.TMP, process.env.TEMP, process.argv[2]]));\n');

  for (const flags of [['check'], ['-f', 'test rules.mk', 'verify'], ['recursive']]) {
    const args = [shim, '-C', cwd, '--no-print-directory', ...flags,
      'CHECK_VALUE=with spaces', 'CHECK_NODE=' + process.execPath.replaceAll('\\', '/')];
    const result = spawnSync(bash, args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const [tmp, temporary, value] = JSON.parse(result.stdout.trim());
    assert.equal(resolve(tmp), temp);
    assert.equal(resolve(temporary), temp);
    assert.equal(value, 'with spaces');
  }
});

test('parallel-tests runs a Make goal using paths from the environment', { skip: !makeAvailable }, t => {
  const { root, cwd, shim } = checkout(t);
  const docs = readFileSync(join(packageDir, 'reference/parallel-tests.md'), 'utf8');
  const config = docs.split('запускает полный набор через `make check`')[1].match(/```json\r?\n([\s\S]*?)\r?\n```/)[1];
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/workspace.json'), JSON.stringify({ tests: { repos: { product: JSON.parse(config) } } }));
  const product = join(root, 'projects/product');
  mkdirSync(product, { recursive: true });
  writeFileSync(join(product, 'Makefile'), 'SHELL := /bin/bash\ncheck:\n\t@pwd\n');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'unused.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    BEERPOWERS_MAKE_BASH: bash,
    BEERPOWERS_MAKE_SHIM: shim,
    BEERPOWERS_TEST_SLOTS_DIR: join(root, 'slots'),
  };
  for (const args of [['init', '-q'], ['add', 'Makefile'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'],
    ['worktree', 'add', '-qb', 'TASK-1', cwd]]) {
    const git = spawnSync('git', args, { cwd: product, env, encoding: 'utf8' });
    assert.equal(git.status, 0, git.error?.message ?? git.stderr);
  }
  const result = spawnSync(process.execPath, [join(packageDir, 'bin/parallel-tests.mjs'), '--task', 'TASK-1', '--out', 'logs'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.match(readFileSync(join(root, 'logs/product/native.log'), 'utf8'), /worktrees\/TASK-1\/product/);
});

test('documented PowerShell command runs make-shim from the recorded checkout and preserves exit status', {
  skip: !win || !bash || !msysMake,
}, t => {
  const { root, cwd, shim } = checkout(t);
  writeFileSync(join(cwd, 'Makefile'), 'SHELL := /bin/bash\ncheck:\n\t@pwd\n\t@exit 23\n');
  const runtime = readFileSync(join(packageDir, 'reference/command-runtime.md'), 'utf8');
  const example = runtime.split('## Проверки проекта через Make')[1].match(/```powershell\r?\n([\s\S]*?)\r?\n```/)[1];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$packageRoot = $env:MAKE_SHIM_TEST_PACKAGE; $checkout = $env:MAKE_SHIM_TEST_CHECKOUT',
    example,
    'exit $makeExit',
  ].join('\n')], {
    cwd: root,
    env: { ...process.env, MAKE_SHIM_TEST_PACKAGE: resolve(dirname(shim), '..'), MAKE_SHIM_TEST_CHECKOUT: cwd },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /worktrees\/TASK-1\/product/);
  assert.match(result.stderr, /Error 23/);
});

test('make-shim reports a missing MSYS2 make', { skip: !win || !bash }, t => {
  const { root, cwd, shim } = checkout(t);
  const result = spawnSync(bash, [shim, 'check'], {
    cwd,
    env: { ...process.env, BEERPOWERS_MSYS2_ROOT: join(root, 'missing MSYS2') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /make-shim:.*MSYS2/);
});

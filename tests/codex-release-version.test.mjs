import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../.github/scripts/check_release.mjs', import.meta.url));
const manifest = 'plugins/beerpowers/.codex-plugin/plugin.json';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'beerpowers-release-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  const write = (path, contents) => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, contents);
  };
  const version = value => write(manifest, JSON.stringify({version: value}));
  const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${join(cwd, 'unused-hooks')}`, ...args], {cwd, stdio: 'pipe'});
  version('0.10.9');
  write('CHANGELOG.md', '## 0.10.9 — 2026-11-26\n\n- Предыдущий выпуск.\n');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const check = () => spawnSync(process.execPath, [checker, 'HEAD'], {cwd, encoding: 'utf8'});
  return {write, version, check};
}

test('изменение пакета требует версии выше базовой', t => {
  const f = fixture(t);
  f.write('plugins/beerpowers/bin/new.mjs', 'export {};\n');
  const unchanged = f.check();
  assert.equal(unchanged.status, 1);
  assert.match(unchanged.stderr, /Повысьте версию/);
  f.version('0.10.8');
  const downgraded = f.check();
  assert.equal(downgraded.status, 1);
  assert.match(downgraded.stderr, /Повысьте версию/);
});

test('повышение версии требует непустых заметок именно для нового выпуска', t => {
  const f = fixture(t);
  f.version('0.10.10');
  const missing = f.check();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /нет раздела «## 0\.10\.10 —/);
  f.write('CHANGELOG.md', '## 0.10.10 — 2026-11-27\n\n');
  const empty = f.check();
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /пустой раздел версии 0\.10\.10/);
  f.write('CHANGELOG.md', '## 0.10.10 — 2026-11-27\n\n- Исправление.\n');
  const ready = f.check();
  assert.equal(ready.status, 0, ready.stderr);
});

test('изменения вне пакета проходят без повышения версии', t => {
  const f = fixture(t);
  f.write('README.md', '# Документация репозитория\n');
  const result = f.check();
  assert.equal(result.status, 0, result.stderr);
});

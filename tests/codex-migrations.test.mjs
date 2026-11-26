import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../.github/scripts/check_migrations.mjs', import.meta.url));
const source = fileURLToPath(new URL('../plugins/beerpowers/', import.meta.url));
const registry = 'reference/migrations.md';
const section = '`entry`';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'beerpowers-migrations-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  const pkg = join(cwd, 'plugins', 'beerpowers');
  for (const file of ['.codex-plugin/plugin.json', registry, 'templates/AGENTS.md',
    'templates/charter/team-charter.md', 'templates/charter/team-lead.md', 'templates/memory/MEMORY.md',
    'bin/memory-template.mjs', 'bin/workspace.pl']) {
    const destination = join(pkg, file);
    mkdirSync(dirname(destination), {recursive: true});
    cpSync(join(source, file), destination, {recursive: true});
  }
  const version = JSON.parse(readFileSync(join(pkg, '.codex-plugin/plugin.json'), 'utf8')).version;
  const put = (file, text) => {
    mkdirSync(dirname(join(pkg, file)), {recursive: true});
    writeFileSync(join(pkg, file), text);
  };
  const append = (file, text) => put(file, readFileSync(join(pkg, file), 'utf8') + text);
  const replace = (file, before, after) => {
    const text = readFileSync(join(pkg, file), 'utf8');
    assert.ok(text.includes(before), file);
    put(file, text.replace(before, after));
  };
  const register = body => {
    const existing = readFileSync(join(pkg, registry), 'utf8').split(new RegExp(`^## ${version.replaceAll('.', '\\.')}\\s*$`, 'm'))[0];
    put(registry, existing + `\n## ${version}\n\n${body}\n`);
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=' + join(cwd, 'unused-hooks'), ...args],
      {cwd, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('add', 'plugins');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const run = (...args) => spawnSync(process.execPath, [checker, ...args], {cwd, encoding: 'utf8'});
  return {put, append, replace, register, run};
}

test('requires an explicit available Git base', t => {
  const f = fixture(t);
  assert.match(f.run().stderr, /--base/);
  const result = f.run('--base', 'missing-reference');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-reference/);
});

test('new templates and changed managed blocks require a new entry under the package version', t => {
  const f = fixture(t);
  f.put('templates/roles/presets/new-role.md', 'New role\n');
  assert.match(f.run('--base', 'HEAD').stderr, /new-role\.md/);
  f.put('templates/AGENTS.md', '<!-- beerpowers:engine entry -->\nNew managed text\n<!-- /beerpowers:engine -->\n');
  assert.match(f.run('--base', 'HEAD').stderr, /Добавьте или обновите запись/);
  f.register('Добавлен шаблон роли.');
  const incomplete = f.run('--base', 'HEAD');
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /блок `entry`/);
  f.register('Добавлен шаблон роли и обновлён блок ' + section + '.');
  const result = f.run('--base', 'HEAD');
  assert.equal(result.status, 0, result.stderr);
});

test('project prose outside a managed block can change independently', t => {
  const f = fixture(t);
  f.append('templates/charter/team-charter.md', '\nДобро пожаловать в проект.\n');
  f.append('templates/memory/MEMORY.md', '\nПроектный текст.\n');
  const result = f.run('--base', 'HEAD');
  assert.equal(result.status, 0, result.stderr);
});

test('changing managed generation names its emitted block', t => {
  const f = fixture(t);
  f.put('bin/memory-template.mjs', 'Output changed\n');
  f.register('Изменён генератор индекса.');
  assert.match(f.run('--base', 'HEAD').stderr, /блок `codex-memory`/);
  f.register('Изменён генератор блока `codex-memory`.');
  const result = f.run('--base', 'HEAD');
  assert.equal(result.status, 0, result.stderr);
});

test('shared setup file creation requires a migration naming the seeded blocks', t => {
  const f = fixture(t);
  f.replace('bin/workspace.pl', 'push @changes, [$path, undef, $initial];',
    'push @changes, [$path, undef, $initial . "\\nAdded by setup\\n"];');
  const missing = f.run('--base', 'HEAD');
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stderr, /bin\/workspace\.pl/);
  assert.match(missing.stderr, /Добавьте или обновите запись/);
  f.register('Изменено начальное содержимое файлов с блоками `codex-team` и `codex-lead`.');
  const incomplete = f.run('--base', 'HEAD');
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /блок `codex-memory`/);
  f.register('Изменено начальное содержимое файлов с блоками `codex-team`, `codex-lead` и `codex-memory`.');
  const result = f.run('--base', 'HEAD');
  assert.equal(result.status, 0, result.stderr);
});

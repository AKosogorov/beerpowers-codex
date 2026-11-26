import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFormServer } from './fixtures/ui-qa/server.mjs';

const pkg = fileURLToPath(new URL('../plugins/beerpowers/', import.meta.url));
const template = join(pkg, 'templates/memory');
const renderer = join(pkg, 'bin/memory-template.mjs');
const ui = fileURLToPath(new URL('./fixtures/ui-qa/', import.meta.url));
const exec = promisify(execFile);
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

function temp(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'beerpowers-memory-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}
function files(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix + entry.name;
    return entry.isDirectory() ? files(root, path + '/') : [path];
  }).sort();
}
function linksExist(path) {
  for (const [, link] of read(path).matchAll(/\]\(([^\s)]+)\)/g)) {
    const [file] = link.split('#');
    assert.ok(!file || existsSync(resolve(dirname(path), file)), path + ': ' + link);
  }
}

test('rendered Codex memory contains the required templates and resolves project links and engine markers', t => {
  const root = temp(t);
  const resources = files(template);
  for (const required of [
    'MEMORY.md', 'adr/.gitkeep', 'commands/README.md',
    'issues/accepted-risks.md', 'issues/known-issues.md',
    'project/domain-invariants.md', 'project/glossary.md', 'project/modules/.gitkeep',
    'project/project-map.md', 'project/safety-rules.md', 'retro-log.md', 'tech-debt/tech-debt.md',
    'tests/backend.md', 'tests/frontend.md', 'tests/probes.md', 'tests/unverified.md',
  ]) {
    assert.ok(resources.includes(required), 'missing memory template: ' + required);
  }
  for (const file of resources) {
    const result = join(root, 'memory', file);
    mkdirSync(dirname(result), { recursive: true });
    if (file.endsWith('.gitkeep')) {
      assert.equal(read(join(template, file)), '');
      writeFileSync(result, '');
    } else {
      const body = execFileSync(process.execPath, [renderer, file, 'catalog'], { cwd: root, encoding: 'utf8' });
      assert.doesNotMatch(body, /\{\{|\}\}|\.claude\/|(?:^|\s|`)\/beerpowers:(?!engine\b)|CLAUDE_PLUGIN_ROOT/);
      assert.match(body, /^# \S/m);
      writeFileSync(result, body);
    }
  }
  for (const file of resources.filter(file => file.endsWith('.md'))) linksExist(join(root, 'memory', file));
  const index = read(join(root, 'memory/MEMORY.md'));
  assert.match(index, /^# Память команды catalog$/m);
  const markers = [...index.matchAll(/<!-- beerpowers:engine [^\n]+ -->[\s\S]+?<!-- \/beerpowers:engine -->/g)];
  assert.equal(markers.length, 1);
  assert.equal(markers[0][0], read(join(template, 'MEMORY.md')).match(/<!-- beerpowers:engine codex-memory -->[\s\S]*?<!-- \/beerpowers:engine -->/)[0]);
  for (const file of resources.filter(file => file.endsWith('.md') && file !== 'MEMORY.md')) {
    assert.ok(index.includes('](' + file + ')'), 'full index covers ' + file);
  }
  assert.equal(JSON.parse(read(join(pkg, 'templates/settings/figma-settings.json.example'))).token, '');
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/team-charter.md'), '# Команда\n');
  mkdirSync(join(root, 'projects/catalog'), { recursive: true });
  writeFileSync(join(root, 'projects/catalog/README.md'), '# Каталог книг\n');
  const topic = join(root, 'memory/project/project-map.md');
  writeFileSync(topic, read(topic) + '\n- Факт: продукт содержит каталог книг. `projects/catalog/README.md:1`\n');
  const evidence = execFileSync(process.execPath, [join(pkg, 'bin/onboard-check.mjs'), 'onboard', 'memory/project/project-map.md'],
    { cwd: root, encoding: 'utf8' });
  assert.match(evidence, /facts=1 references=1/);
});

test('selective rendering writes nothing in the existing project or shared index', t => {
  const root = temp(t);
  mkdirSync(join(root, 'memory'));
  const index = join(root, 'memory/MEMORY.md');
  writeFileSync(index, 'Ручной индекс другого трека.\r\n');
  execFileSync(process.execPath, [renderer, 'tests/probes.md', 'catalog'], { cwd: root });
  for (const args of [['../team-charter.md', 'catalog'], ['tests/probes.md', 'catalog/../other']]) {
    assert.notEqual(spawnSync(process.execPath, [renderer, ...args], { cwd: root }).status, 0);
  }
  assert.deepEqual(files(root), ['memory/MEMORY.md']);
  assert.equal(readFileSync(index, 'utf8'), 'Ручной индекс другого трека.\r\n');
});

test('UI fixture produces a checked local PNG and rejects incomplete browser evidence', async t => {
  const root = temp(t);
  const task = 'fix/ui';
  mkdirSync(join(root, 'memory/tasks', task), { recursive: true });
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/workspace.json'), '{}');
  const server = createFormServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const report = join(root, 'memory/tasks', task, 'form-save.jsonl');
  await exec(process.execPath, [join(pkg, 'bin/cdp-run.mjs'), join(ui, 'form-save.json'),
    '--base-url', 'http://127.0.0.1:' + server.address().port, '--out', report], {
    cwd: root, env: { ...process.env, SCREENSHOT_TASK: task }, timeout: 90000, windowsHide: true,
  });
  const args = [join(ui, 'assert.mjs'), report, join(root, 'memory/tasks', task, 'screenshots')];
  const pass = execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.match(pass, /PASS 3 scenarios/);
  writeFileSync(report, read(report).trim().split('\n').slice(1).join('\n'));
  assert.notEqual(spawnSync(process.execPath, args).status, 0, 'a result row is required for each scenario');
});

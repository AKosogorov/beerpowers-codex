import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../plugins/beerpowers/', import.meta.url));
const cli = join(packageRoot, 'bin', 'update.mjs');
const { version: targetVersion } = JSON.parse(readFileSync(join(packageRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const charter = '.codex/team-charter.md';
const workspace = '.codex/workspace.json';
const entry = [
  '<!-- beerpowers:engine entry -->',
  'Прочитай [.codex/team-charter.md](.codex/team-charter.md). Тимлид также читает [.codex/team-lead.md](.codex/team-lead.md).',
  '<!-- /beerpowers:engine -->',
].join('\n');
const manualCharter = '# Команда каталога\r\n\r\nРучное правило с двумя пробелами.  \r\n';
const unknownBlock = '<!-- beerpowers:engine inventory-local -->\r\nСловарь склада.\r\n<!-- /beerpowers:engine -->\r\n';
const legacyState = { schemaVersion: 1, beerpowers: '0.5.0', custom: { deploy: false, languages: ['ru'] } };
const guidePath = 'roles/guides/product.md';
const oldGuide = '# Продуктовый аналитик\n\nСохрани список вопросов в каталоге задачи.\n';
const oldTeamBlock = [
  '<!-- beerpowers:engine codex-team -->',
  'Тимлид передаёт постановку выбранной роли.',
  '<!-- /beerpowers:engine -->',
].join('\n');
const oldMemoryBlock = [
  '<!-- beerpowers:engine codex-memory -->',
  'Передай сведения в существующую память.',
  '<!-- /beerpowers:engine -->',
].join('\n');

function previousPackage(t, version = '0.5.0') {
  const path = mkdtempSync(join(tmpdir(), 'beerpowers-previous-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const previousManifest = { name: 'beerpowers-codex', version, upstream: { name: 'beerpowers' } };
  for (const [file, content] of [
    ['.codex-plugin/plugin.json', JSON.stringify(previousManifest)],
    ['templates/engine/team-charter.md', oldTeamBlock + '\n'],
    ['templates/engine/memory-index.md', oldMemoryBlock + '\n'],
    ['templates/' + guidePath, oldGuide],
  ]) {
    mkdirSync(join(path, dirname(file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  return path;
}

function fixture(t, state = legacyState) {
  const root = mkdtempSync(join(tmpdir(), 'beerpowers-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'unused.gitconfig'), XDG_CONFIG_HOME: root,
    GIT_ALLOW_PROTOCOL: 'file', GIT_AUTHOR_NAME: 'Catalog fixture', GIT_COMMITTER_NAME: 'Catalog fixture',
    GIT_AUTHOR_EMAIL: 'catalog@example.invalid', GIT_COMMITTER_EMAIL: 'catalog@example.invalid',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(root, 'unused-hooks'),
  };
  execFileSync('git', ['init', '--quiet'], { cwd: root, env });
  function put(relative, content) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  function read(relative) {
    return readFileSync(join(root, relative), 'utf8');
  }
  function run(...args) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  }
  function plan(...args) {
    const result = run('plan', ...args);
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout);
    assert.equal(document.to, targetVersion);
    assert.equal(typeof document.planId, 'string');
    assert.ok(document.planId.length);
    return document;
  }
  function apply(planId, ...args) {
    const result = run('apply', planId, ...args);
    assert.equal(result.status, 0, result.stderr);
  }
  function snapshot(relative = '.') {
    const files = {};
    for (const item of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (item.name === '.git') continue;
      const path = relative === '.' ? item.name : relative + '/' + item.name;
      if (item.isDirectory()) Object.assign(files, snapshot(path));
      else files[path] = read(path);
    }
    return files;
  }

  put(workspace, JSON.stringify(state, null, 2) + '\n');
  put(charter, manualCharter + unknownBlock);
  put('AGENTS.md', '# Правила оператора\n\nПеред изменением прочитай задачу.\n\n' + entry + '\n\nХвост файла.\n');
  put('.neighbor/workspace.json', '{"custom":true}\n');
  put('.neighbor/team-charter.md', '# Соседний трек\n\n' + entry + '\n');
  put('TEAM.md', '# Правила соседней команды\n');
  put('memory/project/notes.md', 'Проектная память.\r\n');
  put('memory/MEMORY.md', '# Общий индекс\n\n[Проект](project/notes.md)\n');
  put('projects/catalog/README.md', '# Каталог\n\nПроверка: `git diff --check`.\n');
  const product = join(root, 'projects', 'catalog');
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: product, env });
  execFileSync('git', ['add', 'README.md'], { cwd: product, env });
  execFileSync('git', ['commit', '-qm', 'Catalog product'], { cwd: product, env });
  put('memory/commands/catalog.md', '# Проверки catalog\n\nКаталог запуска: `projects/catalog/`\nИсточник: `README.md`\n\n```text\ngit diff --check\n```\n');
  put('.codex/git-settings.json', '{"standArchive":false,"removeSourceBranch":true,"repos":{"catalog":"main-default"}}\n');
  put('.gitignore', '/projects/\n/worktrees/\n');
  execFileSync('git', ['add', '.'], { cwd: root, env });
  execFileSync('git', ['commit', '-qm', 'Legacy workspace'], { cwd: root, env });
  return { root, env, put, read, run, plan, apply, snapshot };
}

test('update drops only exact legacy rule bindings and preserves rule files and hand-edited rules', t => {
  const ws = fixture(t);
  const settings = '.codex/role-settings.json';
  const backend = '.codex/rules/backend.md';
  const frontend = '.codex/rules/frontend.md';
  const oldBackend = '# Серверный код\n\nПроверь валидацию входа, права на ресурс и существующие границы модулей. Для Laravel проверь Request и Policy проекта. Авторизацию проверяй на сервере для каждого защищённого действия.\n';
  const handEdited = '# Клиентский код\r\n\r\nОсобые требования к каталогу.  \r\n';
  ws.put('projects/catalog/composer.json', '{"require":{"laravel/framework":"*"}}');
  ws.put('projects/catalog/package.json', '{"dependencies":{"nuxt":"*"}}');
  execFileSync('git', ['-C', join(ws.root, 'projects/catalog'), 'add', 'composer.json', 'package.json'], {env:ws.env});
  ws.put(settings, JSON.stringify({
    stacks: ['laravel', 'nuxt'],
    rules: {backend: ['app'], frontend: ['app', 'components', 'composables', 'layouts', 'pages', 'plugins']},
  }));
  ws.put(backend, oldBackend.replaceAll('\n', '\r\n'));
  ws.put(frontend, handEdited);
  const plan = ws.plan();
  assert.equal(plan.changes.some(change => change.path === settings), true);
  assert.equal(JSON.parse(ws.read(settings)).rules.backend[0], 'app');
  assert.equal(plan.changes.some(change => change.path === backend || change.path === frontend), false);
  ws.apply(plan.planId);
  assert.equal(Object.hasOwn(JSON.parse(ws.read(settings)).rules, 'backend'), false);
  assert.deepEqual(JSON.parse(ws.read(settings)).rules.frontend, ['app', 'components', 'composables', 'layouts', 'pages', 'plugins']);
  assert.equal(ws.read(backend), oldBackend.replaceAll('\n', '\r\n'));
  assert.equal(ws.read(frontend), handEdited);
  assert.equal(ws.plan().changes.some(change => change.path === settings), false);
});

test('update plans against the manifest and preserves manual bytes, custom settings and the other track', t => {
  const ws = fixture(t);
  const before = ws.snapshot();
  const plan = ws.plan();
  assert.equal(plan.from, '0.5.0');
  assert.deepEqual(ws.snapshot(), before, 'plan is read only');
  const paths = plan.changes.map(change => change.path);
  assert.ok(paths.includes(charter));
  assert.ok(paths.includes(workspace));
  for (const change of plan.changes) assert.ok(change.actions?.length, change.path);

  ws.apply(plan.planId);
  const after = ws.snapshot();
  for (const path of ['.neighbor/workspace.json', '.neighbor/team-charter.md', 'TEAM.md', 'memory/MEMORY.md', 'memory/project/notes.md']) {
    assert.equal(after[path], before[path], path);
  }
  assert.ok(after[charter].includes(manualCharter));
  assert.ok(after[charter].includes(unknownBlock));
  assert.match(after[charter].replace(unknownBlock, ''), /<!-- beerpowers:engine [\w-]+ -->/);
  assert.ok(after['AGENTS.md'].includes('Перед изменением прочитай задачу.\n'));
  assert.match(after['AGENTS.md'], /Вложенные \x60AGENTS\.md\x60.*только по явному запросу/);
  assert.match(after['AGENTS.md'], /Автопамять для них не используй/);
  assert.ok(after['AGENTS.md'].includes('Хвост файла.\n'));
  assert.deepEqual(JSON.parse(after[workspace]), { ...legacyState, beerpowers: targetVersion });
  const repeat = ws.plan();
  assert.equal(repeat.from, targetVersion);
  assert.deepEqual(repeat.changes, []);
  ws.apply(repeat.planId);
  assert.deepEqual(ws.snapshot(), after, 're-applying an empty plan preserves every byte');
});

test('update rejects a stale plan ID before writing and offers a new plan', t => {
  const ws = fixture(t);
  const earlier = ws.plan();
  ws.put(charter, ws.read(charter) + 'Добавлено во время согласования.\r\n');
  const edited = ws.snapshot();
  assert.notEqual(ws.run('apply', earlier.planId).status, 0);
  assert.deepEqual(ws.snapshot(), edited);
  const next = ws.plan();
  assert.notEqual(next.planId, earlier.planId);
  ws.apply(next.planId);
  assert.ok(ws.read(charter).includes('Добавлено во время согласования.\r\n'));
});

test('examples of engine markers and charter stamps inside fences stay byte-identical', t => {
  const ws = fixture(t);
  const example = '~~~html\n<!-- generated-by: beerpowers-codex v0.0.1 · mode: plugin-linked -->\n'
    + '<!-- beerpowers:engine codex-team -->\nExample only.\n<!-- /beerpowers:engine -->\n~~~\n';
  ws.put(charter, example + ws.read(charter));
  ws.apply(ws.plan().planId);
  assert.ok(ws.read(charter).includes(example));
  assert.deepEqual(ws.plan().changes, []);
});

test('update fixes the journal pointer in prose and preserves its fenced example', t => {
  const ws = fixture(t);
  ws.apply(ws.plan().planId);
  const index = 'memory/MEMORY.md';
  const canonical = readFileSync(join(packageRoot, 'templates/memory/MEMORY.md'), 'utf8')
    .match(/<!-- beerpowers:engine codex-memory -->[\s\S]*?<!-- \/beerpowers:engine -->/)[0];
  const journal = '- [Журнал уроков](retro-log.md) — приёмы, которые стоит повторять; раздел «Прецеденты правил» — даты и задачи, на которых написаны правила charter и `team-lead.md`';
  const example = '~~~markdown\r\n' + journal + '\r\n~~~\r\n';
  ws.put(index, example + '\r\n' + journal + '\r\n\r\n' + canonical + '\r\n');
  ws.apply(ws.plan().planId);
  assert.equal(ws.read(index), example + '\r\n' + journal.replace('team-lead.md', '.codex/team-lead.md') + '\r\n\r\n' + canonical + '\r\n');
  assert.deepEqual(ws.plan().changes, []);
});

test('update changes the generated debt commands while preserving quoted historical commands', t => {
  const ws = fixture(t);
  ws.apply(ws.plan().planId);
  const index = 'memory/MEMORY.md';
  const active = readFileSync(join(packageRoot, 'templates/memory/MEMORY.md'), 'utf8')
    .replace(/^{{OWNERS_EXTRA}}\r?\n?/m, '').replaceAll('\r\n', '\n');
  const oldCall = '`doctor.mjs tech-debt-index`';
  const currentCall = '`$beerpowers tech-debt-index`';
  const historic = '~~~markdown\n' + active.split('\n').find(line => line.includes(currentCall))
    .replace(currentCall, oldCall) + '\n~~~\n\nРучная запись о старом прогоне: ' + oldCall + '.\n';
  ws.put(index, (active.replaceAll(currentCall, oldCall) + '\n' + historic).replaceAll('\n', '\r\n'));
  ws.apply(ws.plan().planId);
  assert.equal(ws.read(index), (active + '\n' + historic).replaceAll('\n', '\r\n'));
  assert.deepEqual(ws.plan().changes, []);
});

test('partial migration resumes with the old version stamp and no duplicate blocks', t => {
  const reference = fixture(t);
  reference.apply(reference.plan().planId);
  const partial = fixture(t);
  partial.put(charter, reference.read(charter));
  const resume = partial.plan();
  assert.equal(resume.from, '0.5.0');
  assert.ok(!resume.changes.some(change => change.path === charter));
  partial.apply(resume.planId);
  assert.deepEqual(partial.snapshot(), reference.snapshot());
  assert.deepEqual(partial.plan().changes, []);
});

test('a workspace from 0.8 keeps legacy skill copies and task links byte for byte', t => {
  const ws = fixture(t, { ...legacyState, beerpowers: '0.8.0' });
  const preserved = {
    '.codex/disciplines/minimal-diff.md': '\uFEFF# Правило проекта\r\n\r\nРучное дополнение.  \r\n',
    '.codex/disciplines/THIRD_PARTY_NOTICES.txt': 'Notice without a final newline',
    'memory/tasks/OLD-42/preflight.md': '# Постановка\r\n\r\nПравило: `.codex/disciplines/minimal-diff.md`  ',
  };
  for (const [path, content] of Object.entries(preserved)) ws.put(path, content);
  const plan = ws.plan();
  assert.ok(!plan.changes.some(({path}) => path.startsWith('.codex/disciplines/') || path.startsWith('memory/tasks/')));
  ws.apply(plan.planId);
  for (const [path, content] of Object.entries(preserved)) assert.equal(ws.read(path), content, path);
  assert.deepEqual(ws.plan().changes, []);
});

test('current version stamp does not hide manual edits inside a managed charter block', t => {
  const ws = fixture(t);
  ws.apply(ws.plan().planId);
  const original = ws.read(charter);
  const managedStart = /<!-- beerpowers:engine (?!inventory-local\b)[\w-]+ -->\r?\n/;
  assert.match(original, managedStart);
  ws.put(charter, original.replace(managedStart, '$&Ручная вставка.\n'));
  const before = ws.snapshot();
  assert.notEqual(ws.run('plan').status, 0);
  assert.deepEqual(ws.snapshot(), before);
});

for (const [name, content] of Object.entries({
  'duplicate engine entry': entry + '\n' + entry,
  'unterminated engine entry': entry.replace('<!-- /beerpowers:engine -->', ''),
  'unmatched closing marker': '<!-- /beerpowers:engine -->\n' + entry,
  'nested engine blocks': entry.replace('Прочитай', '<!-- beerpowers:engine nested -->\nПрочитай'),
  'manual edit inside known block': entry.replace('Прочитай', 'Прочитай с владельцем'),
})) {
  test('update surfaces a conflict for ' + name, t => {
    const ws = fixture(t);
    ws.put('AGENTS.md', content + '\n');
    const before = ws.snapshot();
    assert.notEqual(ws.run('plan').status, 0);
    assert.deepEqual(ws.snapshot(), before);
  });
}

for (const [name, state] of Object.entries({
  'unknown source version': { schemaVersion: 1, beerpowers: '0.1.9' },
  'newer release': { schemaVersion: 1, beerpowers: (Number(targetVersion.split('.')[0]) + 1) + '.0.0' },
  'unknown schema': { schemaVersion: 99, beerpowers: '0.5.0' },
  'missing version': { schemaVersion: 1 },
})) {
  test('update rejects ' + name + ' without changing the workspace', t => {
    const ws = fixture(t, state);
    const before = ws.snapshot();
    assert.notEqual(ws.run('plan').status, 0);
    assert.deepEqual(ws.snapshot(), before);
  });
}

test('the original schema-less 0.2.0 layout upgrades to schema 1', t => {
  const ws = fixture(t, { beerpowers: '0.2.0' });
  const plan = ws.plan();
  assert.equal(plan.from, '0.2.0');
  ws.apply(plan.planId);
  assert.deepEqual(JSON.parse(ws.read(workspace)), { schemaVersion: 1, beerpowers: targetVersion });
  assert.deepEqual(ws.plan().changes, []);
});

test('update requires a product checkout and a saved test source before any writes', t => {
  const ws = fixture(t);
  const product = join(ws.root, 'projects/catalog');
  const parked = join(ws.root, 'parked-product');
  renameSync(product, parked);
  const missingProduct = ws.snapshot();
  assert.notEqual(ws.run('plan').status, 0);
  assert.deepEqual(ws.snapshot(), missingProduct);
  renameSync(parked, product);
  const checks = 'memory/commands/catalog.md';
  ws.put(checks, ws.read(checks).replace('README.md', 'nonexistent.md'));
  const missingSource = ws.snapshot();
  assert.notEqual(ws.run('plan').status, 0);
  assert.deepEqual(ws.snapshot(), missingSource);
});

test('a verified previous package replaces the old engine block while preserving project bytes and legacy guides', t => {
  const ws = fixture(t);
  const previous = previousPackage(t);
  const oldBlockCrlf = oldTeamBlock.replaceAll('\n', '\r\n');
  const oldStamp = '<!-- generated-by: beerpowers-codex v0.5.0 · mode: plugin-linked -->';
  ws.put(charter, '\uFEFF' + oldStamp + '\r\n' + manualCharter + oldBlockCrlf + '\r\n' + unknownBlock);
  const memoryIntro = '\uFEFF# Ручной индекс\r\n\r\n';
  const memoryTail = '\r\n\r\nРучная заметка.  \r\n';
  const safety = 'memory/project/safety-rules.md';
  const manualSafety = '# Правила владельца\r\n\r\nСогласуй доступ к стенду.  \r\n';
  ws.put('memory/MEMORY.md', memoryIntro + oldMemoryBlock.replaceAll('\n', '\r\n') + memoryTail);
  ws.put(safety, manualSafety);
  ws.put('.codex/' + guidePath, oldGuide);
  const originalJson = '\uFEFF{\r\n  "custom": {"beerpowers":"0.5.0","count":900719925474099312345},\r\n'
    + '  "schemaVersion": 1,\r\n  "beerpowers" : "0.5.0"\r\n}\r\n';
  ws.put(workspace, originalJson);
  const before = ws.snapshot();
  const unverified = ws.run('plan');
  assert.notEqual(unverified.status, 0);
  assert.match(unverified.stderr, /codex-team|team-charter/);
  const wrongVersion = ws.run('plan', '--previous', previousPackage(t, '0.4.0'));
  assert.notEqual(wrongVersion.status, 0);
  assert.match(wrongVersion.stderr, /0\.5\.0/);
  assert.deepEqual(ws.snapshot(), before);

  const args = ['--previous', previous];
  const accepted = ws.plan(...args);
  assert.ok(accepted.changes.some(change => change.path === charter));
  assert.ok(accepted.changes.some(change => change.path === 'memory/MEMORY.md'));
  assert.ok(!accepted.changes.some(change => change.path === '.codex/' + guidePath));
  ws.apply(accepted.planId, ...args);
  const newTeamBlock = readFileSync(join(packageRoot, 'templates/charter/team-charter.md'), 'utf8')
    .match(/<!-- beerpowers:engine codex-team -->[\s\S]*?<!-- \/beerpowers:engine -->/)[0].replace(/\r?\n/g, '\r\n');
  const newStamp = oldStamp.replace(' v0.5.0 ', ' v' + targetVersion + ' ');
  assert.equal(ws.read(charter), '\uFEFF' + newStamp + '\r\n' + manualCharter + newTeamBlock + '\r\n' + unknownBlock);
  const newMemoryBlock = readFileSync(join(packageRoot, 'templates/memory/MEMORY.md'), 'utf8')
    .match(/<!-- beerpowers:engine codex-memory -->[\s\S]*?<!-- \/beerpowers:engine -->/)[0].replace(/\r?\n/g, '\r\n');
  assert.equal(ws.read('memory/MEMORY.md'), memoryIntro + newMemoryBlock + memoryTail);
  assert.equal(ws.read(safety), manualSafety);
  assert.equal(ws.read(workspace), originalJson.replace('"beerpowers" : "0.5.0"', '"beerpowers" : "' + targetVersion + '"'));
  assert.equal(ws.read('.codex/' + guidePath), oldGuide);
  assert.match(ws.read('.codex/agents/architect-agent.md'), /beerpowers:engine/);
  assert.deepEqual(ws.plan().changes, []);
});

test('rollback of a known schema changes only the two stamps, preserving newer project files', t => {
  const ws = fixture(t);
  ws.apply(ws.plan().planId);
  const newer = '1.0.0';
  ws.put(workspace, ws.read(workspace).replace(targetVersion, newer));
  ws.put(charter, ws.read(charter).replace('v' + targetVersion + ' ·', 'v' + newer + ' ·'));
  ws.put('.codex/local-newer.md', 'Ручной файл новой версии.\n');
  const before = ws.snapshot();
  const plan = ws.plan();
  assert.deepEqual(plan.changes.map(c => c.path).sort(), [charter, workspace].sort());
  ws.apply(plan.planId);
  const after = ws.snapshot();
  assert.equal(after[charter], before[charter].replace('v' + newer + ' ·', 'v' + targetVersion + ' ·'));
  assert.equal(after[workspace], before[workspace].replace(newer, targetVersion));
  for (const key of Object.keys(before).filter(k => k !== charter && k !== workspace)) assert.equal(after[key], before[key]);
  assert.deepEqual(ws.plan().changes, []);
});

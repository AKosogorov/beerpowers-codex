import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('../plugins/beerpowers/', import.meta.url));
const version = JSON.parse(readFileSync(join(pkg, '.codex-plugin/plugin.json'), 'utf8')).version;
function findPerl() {
  if (process.env.BEERPOWERS_PERL) return process.env.BEERPOWERS_PERL;
  if (process.platform !== 'win32') return 'perl';
  return execFileSync('where.exe', ['git.exe'], {encoding: 'utf8'}).trim().split(/\r?\n/)
    .map(git => resolve(dirname(git), '../usr/bin/perl.exe')).find(file => existsSync(file)) ?? 'perl';
}
function fixture(t, product = 'api') {
  const root = mkdtempSync(join(tmpdir(), 'beerpowers-tracks-'));
  t.after(() => rmSync(root, {recursive: true, force: true, maxRetries: 3}));
  const env = {...process.env, BEERPOWERS_PERL: findPerl(), BEERPOWERS_TEST_SOURCE: 'README.md', BEERPOWERS_TEST_COMMAND: 'git diff --check',
    XDG_CONFIG_HOME: root, GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1'};
  delete env.BEERPOWERS_TRACK;
  delete env.BEERPOWERS_TESTS_JSON;
  delete env.BEERPOWERS_PARALLEL_TESTS_JSON;
  delete env.BEERPOWERS_CHARTER_SLOTS_JSON;
  delete env.BEERPOWERS_MEMORY_JSON;
  delete env.BEERPOWERS_PROJECT_NAME;
  delete env.BEERPOWERS_ROLE_SLOTS_JSON;
  delete env.BEERPOWERS_SETUP_DEPENDENCIES_JSON;
  const put = (file, body) => { mkdirSync(dirname(join(root, file)), {recursive: true}); writeFileSync(join(root, file), body); };
  const read = file => readFileSync(join(root, file), 'utf8');
  put(`projects/${product}/README.md`, 'Tests: git diff --check\n');
  for (const cwd of [root, join(root, 'projects', product)]) execFileSync('git', ['init', '-q'], {cwd, env});
  function run(binary, args, track, options = {}) {
    const result = spawnSync(binary, args, {cwd: root, encoding: 'utf8',
      env: {...env, ...(track ? {BEERPOWERS_TRACK: track} : {}), ...options}});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  return {root, put, read, has: file => existsSync(join(root, file)),
    git: (cwd, ...args) => run('git', ['-C', join(root, cwd), ...args]),
    node: (name, ...args) => JSON.parse(run(process.execPath, [join(pkg, 'bin', name), ...args])),
    packet: role => run(env.BEERPOWERS_PERL, [join(pkg, 'bin/workspace.pl'), 'role-packet', role]),
    setup: (mode, track, options) => run(env.BEERPOWERS_PERL, [join(pkg, 'bin/workspace.pl'), mode], track, options),
    update: track => JSON.parse(run(process.execPath, [join(pkg, 'bin/update.mjs'), 'plan'], track))};
}

test('setup preserves the existing gate notes for both school landing products', t => {
  const products = ['online-school-1-com', 'school-landing-clone'];
  const f = fixture(t, products[0]);
  const notes = products.map(name => `memory/commands/${name}.md`);
  const checks = {};
  for (const name of products) {
    const product = `projects/${name}`;
    f.put(`${product}/package.json`, JSON.stringify({scripts: {build: 'node -e "process.exit(99)"'}}));
    if (name !== products[0]) f.git(product, 'init', '-q');
    checks[name] = {command: 'npm run build', source: 'package.json', profile: 'main-default'};
  }
  f.put(notes[0], '# Команды — форк `online-school-1-com`\n\n## Запуск\n\n' +
    '- `npm --prefix projects/online-school-1-com ci`.\n\n## Гейты\n\n' +
    '- **Сборка** — проверка типов:\n' +
    '  `npm --prefix projects/online-school-1-com run build > <лог> 2>&1; echo CODE=$? >> <лог>`.\n' +
    '  Код выхода — по маркеру `CODE=`.\n\n## Линт\n');
  f.put(notes[1], '\uFEFF' + ('# Команды — клон `school-landing-clone`\n\n## Запуск\n\n' +
    '- `PATH="/opt/node:$PATH" npm --prefix projects/school-landing-clone run build`.\n\n## Гейты\n\n' +
    '- **Сборка** — проверка типов:\n' +
    '  `npm --prefix projects/school-landing-clone run build > <лог> 2>&1; echo CODE=$? >> <лог>`.\n' +
    '  При setup не прогонялась.\n\n## Линт\n').replaceAll('\n', '\r\n'));
  const before = notes.map(path => readFileSync(join(f.root, path)));
  const options = {BEERPOWERS_TESTS_JSON: JSON.stringify(checks)};
  assert.doesNotMatch(f.setup('plan', undefined, options), /^(?:CREATE|UPDATE) memory\/commands\/.*-.*\.md$/m);
  f.setup('apply', undefined, options);
  const doctor = f.setup('doctor', undefined, {BEERPOWERS_TEST_SOURCE: undefined, BEERPOWERS_TEST_COMMAND: undefined});
  for (const [index, path] of notes.entries()) {
    assert.ok(doctor.includes(`Project OK: ${path}`));
    assert.deepEqual(readFileSync(join(f.root, path)), before[index]);
  }
  assert.deepEqual(readdirSync(join(f.root, 'memory/commands')).sort(), products.map(name => name + '.md'));
  assert.deepEqual(f.update().changes, []);
});

test('setup validates a legacy npm gate, its arguments and source without running it', t => {
  const f = fixture(t);
  const guide = 'memory/commands/api.md';
  const manifest = 'projects/api/package.json';
  const command = 'npm --prefix projects/api run build -- --mode production';
  const options = {BEERPOWERS_TEST_COMMAND: 'npm run build -- --mode production', BEERPOWERS_TEST_SOURCE: 'package.json'};
  const putGate = (...lines) => f.put(guide, '## Гейты\n\n' + lines.map(line => '- `' + line + '`\n').join(''));
  f.put(manifest, JSON.stringify({scripts: {build: 'node -e "require(\'node:fs\').writeFileSync(\'gate-ran\', \'\')"'}}));
  putGate(command);
  f.setup('plan', undefined, options);
  f.setup('apply', undefined, options);
  assert.equal(f.has('projects/api/gate-ran'), false);
  assert.equal(f.has('gate-ran'), false);
  f.put(guide, f.read(guide) + '<!-- `' + command + '` -->\n');
  f.setup('plan', undefined, options);
  f.put(guide, '## Гейты\n\n<!-- `' + command + '` -->\n');
  assert.throws(() => f.setup('plan', undefined, options), /memory\/commands\/api\.md: .*missing inline npm gate/);

  for (const [lines, reason] of [
    [[command.replace('projects/api', 'projects/other')], /--prefix.*projects\/other.*projects\/api/],
    [[command.replace('production', 'development')], /command or arguments differ/],
    [[command, command], /ambiguous.*npm/],
    [[command + ' > first.log 2>&1; echo CODE=$? >> second.log'], /same log/],
    [[command + '; echo unexpected'], /unsupported npm gate/],
    [[command.replace(' -- --mode', ' --prefix projects/other -- --mode')], /unsupported npm gate/],
  ]) {
    putGate(...lines);
    assert.throws(() => f.setup('plan', undefined, options), {message: new RegExp(guide + ': .*' + reason.source)});
  }
  putGate(command);
  assert.throws(() => f.setup('plan', undefined, {...options, BEERPOWERS_TEST_SOURCE: 'README.md'}),
    /memory\/commands\/api\.md: .*source.*package\.json/);
  f.put(manifest, '{"scripts":{"build":1}}');
  assert.throws(() => f.setup('plan', undefined, options), /memory\/commands\/api\.md: .*invalid scripts\.build.*package\.json/);
  f.put(manifest, '{"scripts":{"dev":"nuxt"}}');
  assert.throws(() => f.setup('plan', undefined, options), /memory\/commands\/api\.md: .*scripts\.build.*package\.json/);
  assert.throws(() => f.setup('doctor', undefined, {BEERPOWERS_TEST_SOURCE: undefined, BEERPOWERS_TEST_COMMAND: undefined}),
    /memory\/commands\/api\.md: .*scripts\.build.*package\.json/);
});

test('setup and a new doctor process reuse a short-named project guide', t => {
  const f = fixture(t, 'school-landing');
  const guide = 'memory/commands/front.md';
  const notes = '# Команды\n\n## Запуск\n\nВерсия Node из Dockerfile.\n\n## Гейты\n\n' +
    '- `npm --prefix projects/school-landing run typecheck > <лог> 2>&1; echo CODE=$? >> <лог>`\n' +
    '- `npm --prefix projects/school-landing run build`\n\n## Линт\n';
  f.put(guide, notes);
  f.put('memory/commands/notes.md', '<!--\n## Гейты\n\n- \x60npm --prefix projects/school-landing run build\x60\n-->\n');
  f.put('projects/school-landing/package.json', JSON.stringify({scripts:{typecheck:'tsc', build:'nuxt build'}}));
  const options = {BEERPOWERS_TEST_COMMAND:'npm run typecheck', BEERPOWERS_TEST_SOURCE:'package.json'};
  assert.match(f.setup('plan', undefined, options), /Tests \(cwd projects\/school-landing\): npm run typecheck/);
  f.setup('apply', undefined, options);
  assert.equal(f.read(guide), notes);
  assert.equal(f.has('memory/commands/school-landing.md'), false);
  assert.match(f.packet('tester'), /FILE memory\/commands\/front\.md sha256=/);
  assert.match(f.setup('doctor', undefined, {BEERPOWERS_TEST_COMMAND:undefined, BEERPOWERS_TEST_SOURCE:undefined}), /Project OK: memory\/commands\/front\.md/);
  assert.deepEqual(f.update().changes, []);
});

test('setup still validates an existing Codex command note', t => {
  const f = fixture(t);
  const path = 'memory/commands/api.md';
  const guide = '# Команды — api\n\nКаталог запуска: `projects/api/`\nИсточник: `README.md`\n\n```text\ngit diff --check\n```\n';
  f.put(path, guide);
  f.setup('plan');
  f.setup('apply');
  assert.match(f.setup('doctor'), /^Project OK: memory\/commands\/api\.md$/m);
  assert.equal(f.read(path), guide);
  assert.throws(() => f.setup('plan', undefined, {BEERPOWERS_TEST_COMMAND: 'git diff --stat'}),
    /memory\/commands\/api\.md: .*command or arguments differ/);
  f.put(path, guide.replace('git diff', 'git\0 diff'));
  assert.throws(() => f.update(), /memory\/commands\/api\.md: .*invalid single-line command/);
});

test('setup saves a selected Make guide for doctor and the tester packet', t => {
  const f = fixture(t, 'demo');
  const guide = 'memory/commands/api.md';
  const notes = '# Команды API\n\n## Гейты\n\n- `make -C projects/demo check`\n';
  f.put(guide, notes);
  f.put('projects/demo/Makefile', 'check:\n\t@echo fixture\n');
  const options = {BEERPOWERS_TESTS_JSON:JSON.stringify({demo:{guide, command:'make check', source:'Makefile'}})};
  assert.doesNotMatch(f.setup('plan', undefined, options), /^CREATE memory\/commands\/demo\.md$/m);
  f.setup('apply', undefined, options);
  assert.equal(f.read(guide), notes);
  assert.equal(f.has('memory/commands/demo.md'), false);
  assert.deepEqual(JSON.parse(f.read('.codex/workspace.json')).commandGuides, {demo:guide});
  assert.match(f.read('memory/MEMORY.md'), /\]\(commands\/api\.md\)/);
  f.put('memory/commands/demo.md', '# Другие команды\n');
  assert.match(f.packet('tester'), /FILE memory\/commands\/api\.md sha256=/);
  assert.match(f.setup('doctor'), /^Project OK: memory\/commands\/api\.md$/m);
  assert.match(f.setup('plan', undefined, options), /^No changes\.$/m);
  assert.deepEqual(f.update().changes, []);
});

test('changing a saved guide updates generated pointers and preserves edited table cells', t => {
  const f = fixture(t, 'demo');
  const charter = '.codex/team-charter.md';
  const memory = 'memory/MEMORY.md';
  const commands = 'memory/commands/README.md';
  f.setup('apply');
  f.put(memory, f.read(memory) + '\nРучная ссылка [справка](commands/demo.md).\n');
  f.put(commands, f.read(commands).replace('Штатные проверки проекта demo', 'Ручное описание проверок'));
  f.put(charter, f.read(charter).replace(/^(\| `tester` \|.*) \|$/m, '$1, `memory/tests/extra.md` |'));

  const guide = 'memory/commands/api.md';
  f.put(guide, '# API\n\n## Гейты\n\n- `make -C projects/demo check`\n');
  f.put('projects/demo/Makefile', 'check:\n\t@echo fixture\n');
  const options = {BEERPOWERS_TESTS_JSON:JSON.stringify({demo:{guide, command:'make check', source:'Makefile'}})};
  const before = [memory, commands, charter].map(f.read);
  const plan = f.setup('plan', undefined, options);
  for (const file of [memory, commands, charter]) assert.ok(plan.includes('UPDATE ' + file));
  const [index, commandIndex, roster] = before;
  f.setup('apply', undefined, options);
  assert.equal(f.read(memory), index.replace('[Проверки demo](commands/demo.md)', '[Проверки demo](commands/api.md)'));
  assert.equal(f.read(commands), commandIndex.replace('[demo.md](demo.md)', '[api.md](api.md)'));
  assert.equal(f.read(charter), roster.replaceAll('`memory/commands/demo.md`', '`memory/commands/api.md`'));
  assert.match(f.packet('tester'), /FILE memory\/commands\/api\.md sha256=/);
  assert.match(f.setup('apply', undefined, options), /^No changes\.$/m);
  assert.deepEqual(f.update().changes, []);
  const updated = [memory, commands, charter].map(f.read);
  [memory, commands, charter].forEach((file, i) => f.put(file, before[i]));
  f.setup('apply', undefined, options);
  assert.deepEqual([memory, commands, charter].map(f.read), updated, 'reconciles pointers when the binding was already written');
});

test('setup previews and seeds selected discovery notes, preserving manual memory on repeat', t => {
  const f = fixture(t);
  f.put('projects/api/package.json', '{"scripts":{"test":"node --test"}}\n');
  f.put('projects/api/test/orders.test.mjs', "import test from 'node:test';\ntest('order status', () => {});\n");
  f.git('projects/api', 'add', '.');
  const input = {
    projectMap: '- Факт: проверки заказов расположены в test/. `projects/api/test/orders.test.mjs:2`',
    commands: {api: '- `node --test --test-name-pattern="order status" test/orders.test.mjs` — не прогнано. `projects/api/package.json:1`, `projects/api/test/orders.test.mjs:2`'},
  };
  const parallel = {slots: 2, repos: {api: {mode: 'split', command: 'node --test {files}', files: ['test/*.test.mjs']}}};
  const options = {
    BEERPOWERS_MEMORY_JSON: JSON.stringify({...input, ownersExtra: '| `Сверяй статус заказа` | `memory/project/domain-invariants.md` |'}),
    BEERPOWERS_CHARTER_SLOTS_JSON: JSON.stringify({
      'team-charter': {PURPOSE: 'Проверка заказов', STACK_TABLE: 'Node.js'},
      'team-lead': {GATES_EXTRA: 'Сверь контрольный заказ.'},
    }),
    BEERPOWERS_PARALLEL_TESTS_JSON: JSON.stringify(parallel),
    BEERPOWERS_NODE: process.execPath,
  };
  assert.throws(() => f.setup('apply', undefined, {
    ...options,
    BEERPOWERS_PARALLEL_TESTS_JSON: JSON.stringify({repos: {api: {command: 'node --test'}}}),
  }), /Invalid parallel tests configuration/);
  assert.ok(!f.has('.codex/workspace.json'));
  const plan = f.setup('plan', undefined, options);
  assert.match(plan, /Факт: проверки заказов/);
  assert.match(plan, /node --test --test-name-pattern=.*не прогнано/);
  assert.ok(!f.has('memory/project/project-map.md'));
  f.setup('apply', undefined, options);
  assert.match(f.read('memory/project/project-map.md'), /Факт: проверки заказов/);
  assert.match(f.read('.codex/team-charter.md'), /## Назначение\s+Проверка заказов/);
  assert.match(f.read('.codex/team-charter.md'), /## Intake-режим\s+Intake: plan/);
  assert.match(f.read('.codex/team-lead.md'), /Сверь контрольный заказ\./);
  assert.match(f.read('memory/MEMORY.md'), /Сверяй статус заказа/);
  assert.match(f.read('memory/commands/README.md'), /\| \[api\.md\]\(api\.md\) \| Штатные проверки проекта api \| Роли этого проекта и тимлид \|/);
  assert.deepEqual(JSON.parse(f.read('.codex/workspace.json')).tests, parallel);
  assert.doesNotMatch(f.read('memory/project/safety-rules.md'), /## Проектные запреты/);
  assert.match(f.read('memory/commands/api.md'), /```text\ngit diff --check\n```\n\n## Памятка команд/);
  assert.match(f.read('memory/commands/api.md'), /node --test --test-name-pattern=.*не прогнано/);
  assert.match(f.setup('doctor'), /^Project OK: memory\/commands\/api.md$/m);
  f.put('memory/project/project-map.md', '# Ручная карта\n');
  assert.match(f.setup('apply', undefined, options), /No changes\./);
  assert.throws(() => f.setup('apply', undefined, {
    ...options,
    BEERPOWERS_PARALLEL_TESTS_JSON: JSON.stringify({repos: {api: {mode: 'native', command: 'node --test'}}}),
  }), /Conflicting parallel tests settings for api/);
  assert.deepEqual(JSON.parse(f.read('.codex/workspace.json')).tests, parallel);
  assert.equal(f.read('memory/project/project-map.md'), '# Ручная карта\n');
  assert.deepEqual(f.update().changes, []);
});

test('PM-only setup delivers project identity, confirmed slots and table rows for two products', t => {
  const f = fixture(t);
  f.put('projects/api/package.json', '{"dependencies":{"express":"5.0.0"}}');
  f.put('projects/web/README.md', 'Tests: git diff --check\n');
  f.put('projects/web/package.json', '{"dependencies":{"nuxt":"4.0.0"}}');
  f.git('projects/web', 'init', '-q');
  for (const repo of ['api', 'web']) f.git('projects/' + repo, 'add', '.');
  const checks = Object.fromEntries(['api', 'web'].map(repo => [repo, {
    command: 'git diff --check', source: 'README.md', profile: 'main-default',
  }]));
  const options = {
    BEERPOWERS_PROJECT_NAME: 'Каталог заказов',
    BEERPOWERS_TESTS_JSON: JSON.stringify(checks),
    BEERPOWERS_ROLE_SLOTS_JSON: JSON.stringify({
      architect: {BACKEND: 'Express', FRONTEND_FRAMEWORK: 'Nuxt'},
      frontend: {FRONTEND_FRAMEWORK: 'Nuxt', ROLE_CONTEXT: 'Контекст витрины.'},
      tester: {TEST_RUNNER: 'Vitest'},
    }),
    BEERPOWERS_CHARTER_SLOTS_JSON: JSON.stringify({'team-charter': {
      PURPOSE: 'Продажа товаров.', STACK_TABLE: 'Таблица подтверждённого стека.',
      COMMANDS: 'Единый указатель команд продукта.',
    }}),
    BEERPOWERS_MEMORY_JSON: JSON.stringify({
      commandIndex: [{file:'lint.md', contents:'Проверка стиля', readers:'frontend', markdown:'# Линт\n'}],
      ownersExtra: '| `Проверяй экраны заказов` | `memory/tests/frontend.md` |',
    }),
  };
  const plan = f.setup('plan', 'pm', options);
  assert.match(plan, /Контекст витрины\./);
  assert.match(plan, /Раннер проекта — Vitest/);
  assert.ok(!f.has('.codex/workspace.json'));
  f.setup('apply', 'pm', options);
  const readMarkdown = file => f.read(file).replaceAll('\r\n', '\n');
  const charter = readMarkdown('.codex/team-charter.md');
  assert.match(charter, /^# Team Charter — Каталог заказов$/m);
  assert.match(charter, /## Назначение\s+Продажа товаров\.\s+## Стек/);
  assert.match(charter, /## Стек\s+Таблица подтверждённого стека\.\s+## Команды/);
  assert.match(charter, /## Команды\s+Единый указатель команд продукта\.\s+## Состав/);
  assert.match(charter, /\| Роль \| Проекты \| Read on spawn \|/);
  assert.match(charter, /\| `product` \| api, web \|/);
  const roster = charter.match(/^## Состав\n([\s\S]*?)^## /m)[1];
  assert.doesNotMatch(roster, /^\| `reviewer` \|/m);
  assert.match(charter, /Draft через Approved и In Development до Done/);
  const memory = readMarkdown('memory/MEMORY.md');
  assert.match(memory, /^# Память команды Каталог заказов$/m);
  assert.match(memory, /коммитится отдельно от всего остального.*\n\| `Проверяй экраны заказов`/);
  assert.match(readMarkdown('memory/commands/README.md'), /\| Файл \| Что внутри \| Кому \|[\s\S]*\| \[lint\.md\]\(lint\.md\) \| Проверка стиля \| frontend \|/);
  assert.equal(readMarkdown('memory/commands/lint.md'), '# Линт\n');
  assert.match(readMarkdown('memory/project/domain-invariants.md'), /При setup не выявлены\./);
  assert.match(readMarkdown('.codex/agents/architect-agent.md'), /Серверный стек — Express\.\nКлиентский фреймворк — Nuxt\./);
  assert.match(readMarkdown('.codex/agents/frontend-agent.md'), /Каталог заказов[\s\S]+Контекст витрины\.[\s\S]+Клиентский фреймворк — Nuxt\./);
  assert.match(readMarkdown('.codex/agents/testing-agent.md'), /Раннер проекта — Vitest\./);
  for (const role of ['architect', 'backend', 'database', 'product']) {
    const brief = readMarkdown('.codex/agents/' + role + '-agent.md');
    assert.match(brief, /Каталог заказов/);
    assert.doesNotMatch(brief, /Область назначения уточняет|Ты -разработчик|СУБД — \.|\*\*Не трогаешь:\*\* \./);
  }
  assert.equal(JSON.parse(f.read('.codex/workspace.json')).projectName, 'Каталог заказов');
  assert.match(f.setup('apply', undefined, {BEERPOWERS_TESTS_JSON: options.BEERPOWERS_TESTS_JSON}), /No changes\./);
});

test('repeated setup updates the roster and command index without replacing project edits', t => {
  const f = fixture(t);
  f.setup('apply', 'pm');
  const charterPath = '.codex/team-charter.md';
  const indexPath = 'memory/commands/README.md';
  const authoredRole = '|`product`| api | Ручной список чтения |';
  const charter = f.read(charterPath).replace(/^\| `product` \|[^\r\n]*/m, authoredRole) + '\n## Местные правила\n\nРучной текст.\n';
  f.put(charterPath, charter);
  const index = f.read(indexPath).replace(/^\| \[api\.md\]\(api\.md\) \|[^\r\n]*/m, '| [Проверки](api.md) | Ручное назначение | Команда |');
  f.put(indexPath, index.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') + '\r\nСм. также [заметку](lint.md).\r\n');
  const options = {BEERPOWERS_MEMORY_JSON:JSON.stringify({
    commandIndex: [{file:'lint.md', contents:'Проверка стиля', readers:'frontend', markdown:'# Линт\n'}],
  })};
  const plan = f.setup('plan', 'both', options);
  assert.match(plan, /UPDATE \.codex\/team-charter\.md/);
  assert.match(plan, /UPDATE memory\/commands\/README\.md/);
  assert.match(plan, /CREATE memory\/commands\/lint\.md/);
  assert.equal(f.read(charterPath), charter);
  assert.ok(!f.has('memory/commands/lint.md'));
  f.setup('apply', 'both', options);
  const after = f.read(charterPath);
  const roster = after.match(/^## Состав\r?\n([\s\S]*?)^## /m)[1];
  assert.match(roster, /^\| `reviewer` \| api \|/m);
  assert.ok(roster.includes(authoredRole));
  assert.equal([...roster.matchAll(/^\|[ \t]*`product`[ \t]*\|/gm)].length, 1);
  assert.match(after, /## Местные правила\n\nРучной текст\./);
  assert.match(after, /^## Команда разработки$/m);
  assert.ok(JSON.parse(f.read('.codex/role-settings.json')).team.includes('reviewer'));
  const updatedIndex = f.read(indexPath);
  assert.match(updatedIndex, /Ручное назначение \| Команда \|\r\n\| \[lint\.md\]\(lint\.md\) \| Проверка стиля \| frontend \|\r\n\r\nСм\. также \[заметку\]\(lint\.md\)\./);
  assert.equal(f.read('memory/commands/lint.md'), '# Линт\n');
  assert.match(f.setup('apply', 'both', options), /No changes\./);
  assert.equal(f.read(indexPath), updatedIndex);
  assert.equal(f.read(charterPath), after);
});

test('setup extends a project roster with reordered columns and a manual mission', t => {
  const f = fixture(t);
  const row = '| Определяет продуктовый объём \\| сохраняет контекст | `product` | Ручной список чтения | api |';
  const table = ['| Миссия | Роль | Read on spawn | Продукты |', '|---|---|:---|---|', row].join('\n');
  f.setup('apply', 'pm', {
    BEERPOWERS_CHARTER_SLOTS_JSON: JSON.stringify({'team-charter': {ROLES_TABLE: table}}),
  });
  const charterPath = '.codex/team-charter.md';
  const original = f.read(charterPath);
  assert.match(f.setup('plan', 'both'), /UPDATE \.codex\/team-charter\.md/);
  assert.equal(f.read(charterPath), original);
  f.setup('apply', 'both');
  const charter = f.read(charterPath);
  const roster = charter.match(/^## Состав\r?\n([\s\S]*?)^## /m)[1];
  assert.ok(roster.includes(table));
  assert.match(roster, /^\|\s*\| `reviewer` \| `\.codex\/agents\/reviewer-agent\.md`[^\r\n]+ \| api \|$/m);
  assert.ok(JSON.parse(f.read('.codex/role-settings.json')).team.includes('reviewer'));
  assert.match(f.setup('apply', 'both'), /No changes\./);
  assert.equal(f.read(charterPath), charter);
});

test('setup seeds only chosen missing topics beside shared memory', t => {
  const f = fixture(t);
  const index = '# Общая память\r\nРучной индекс.\r\n';
  f.put('memory/MEMORY.md', index);
  f.put('memory/project/project-map.md', '# Ручная карта\n');
  f.put('projects/api/README.md', 'Tests: git diff --check\nNever run tests on the production database.\n');
  const options = {BEERPOWERS_MEMORY_JSON: JSON.stringify({
    projectMap: '- Новая карта.',
    safetyRules: '- Никогда не запускайте тесты на рабочей базе. `projects/api/README.md:2`',
  })};
  const plan = f.setup('plan', undefined, options);
  assert.match(plan, /CREATE memory\/project\/safety-rules.md/);
  assert.doesNotMatch(plan, /Новая карта/);
  f.setup('apply', undefined, options);
  assert.match(f.read('memory/project/safety-rules.md'), /## Проектные запреты\n\n- Никогда.*README.md:2/);
  assert.equal(f.read('memory/MEMORY.md'), index);
  assert.equal(f.read('memory/project/project-map.md'), '# Ручная карта\n');
  assert.doesNotMatch(f.read('memory/commands/api.md'), /## Памятка команд/);
  assert.match(f.setup('apply', undefined, options), /No changes\./);
});

test('setup preserves intake, manual roster, assigned skills and three project widths', t => {
  const f = fixture(t);
  f.put('projects/api/package.json', '{"dependencies":{"nuxt":"^4.0.0"}}');
  f.put('projects/api/screen.css', '@media (min-width: 375px) {}\n@media (min-width: 53rem) {}\n@media (min-width: 1440px) {}\n');
  f.git('projects/api', 'add', '.');
  const points = f.node('ui-acceptance.mjs', 'discover', 'api');
  assert.deepEqual(points.map(item => item.width), [375, 848, 1440]);
  assert.equal(points[1].source, 'projects/api/screen.css:2');
  const options = {BEERPOWERS_TEAM_SIZE:'extended', BEERPOWERS_INTAKE:'stages',
    BEERPOWERS_SESSION_SKILLS_JSON:'["nuxt"]', BEERPOWERS_ROLE_SKILLS_JSON:'{"api":{"frontend":["nuxt"]}}',
    BEERPOWERS_VIEWPORTS_JSON:JSON.stringify(points.map(({width}, index) => ({width, name:'v'+width, height:800, mobile:index===0})))};
  f.setup('apply', 'dev', options);
  const settings = JSON.parse(f.read('.codex/role-settings.json'));
  assert.deepEqual(settings.team, ['architect', 'frontend', 'tester', 'reviewer', 'explorer', 'devops', 'auditor']);
  assert.match(f.read('.codex/team-charter.md'), /^Intake: stages$/m);
  assert.match(f.packet('frontend'), /Assigned skills \(frontend\): nuxt/);
  assert.match(f.packet('frontend'), /FILE memory\/project\/domain-invariants.md sha256=/);
  assert.deepEqual(JSON.parse(f.read('.codex/workspace.json')).viewports.map(item => item.width), [375, 848, 1440]);
  settings.team = ['architect', 'tester'];
  f.put('.codex/role-settings.json', JSON.stringify(settings));
  assert.match(f.setup('apply'), /UPDATE \.codex\/team-charter\.md/);
  const roster = f.read('.codex/team-charter.md').match(/^## Состав\r?\n([\s\S]*?)^## /m)[1];
  assert.deepEqual([...roster.matchAll(/^\| `([a-z-]+)` \|/gm)].map(match => match[1]), settings.team);
  assert.match(f.setup('apply', 'dev', options), /No changes\./);
  assert.match(f.setup('apply', undefined, {BEERPOWERS_INTAKE:'autonomous'}), /No changes\./);
  assert.match(f.read('.codex/team-charter.md'), /^Intake: stages$/m);
  assert.deepEqual(JSON.parse(f.read('.codex/role-settings.json')).team, settings.team);
  assert.deepEqual(f.update().changes, []);
});

test('setup plans missing assigned skills and unavailable integrations without changing configuration', t => {
  const f = fixture(t);
  const settingsFile = '.codex/role-settings.json';
  f.setup('apply', undefined, {
    BEERPOWERS_SESSION_SKILLS_JSON: '["nuxt"]',
    BEERPOWERS_ROLE_SKILLS_JSON: '{"api":{"frontend":["nuxt"]}}',
  });
  const settings = f.read(settingsFile);
  const options = {
    BEERPOWERS_SESSION_SKILLS_JSON: '[]',
    BEERPOWERS_SETUP_DEPENDENCIES_JSON: JSON.stringify([
      {product:'api', role:'product', dependency:'Figma', reason:'Инструмент отсутствует в чате',
        connection:'Каталог плагинов → Figma → подключить аккаунт'},
    ]),
  };
  const plan = f.setup('plan', undefined, options);
  assert.match(plan, /api\/frontend \| nuxt \| Навык отсутствует в списке текущего чата \| Способ подключения не подтверждён/);
  assert.match(plan, /api\/product \| Figma \| Инструмент отсутствует в чате \| Каталог плагинов → Figma → подключить аккаунт/);
  assert.match(f.setup('plan', undefined, {BEERPOWERS_SESSION_SKILLS_JSON: undefined}), /nuxt \| Список навыков текущего чата недоступен/);
  assert.match(f.setup('apply', undefined, options), /No changes\./);
  assert.equal(f.read(settingsFile), settings);
  assert.match(f.packet('frontend'), /Assigned skills \(frontend\): nuxt/);
});

test('compact setup keeps the single implementation layer and installs the optional read-only brief', t => {
  const f = fixture(t);
  f.put('projects/api/package.json', '{"dependencies":{"vue":"^3.0.0"}}');
  f.git('projects/api', 'add', '.');
  f.setup('apply', 'dev', {BEERPOWERS_TEAM_SIZE:'compact', BEERPOWERS_INTAKE:'autonomous'});
  assert.match(f.read('.codex/team-charter.md'), /^Intake: autonomous$/m);
  const roster = JSON.parse(f.read('.codex/role-settings.json'));
  assert.deepEqual(roster.team, ['architect', 'frontend', 'tester', 'reviewer']);
  assert.match(f.packet('explorer'), /FILE \.codex\/agents\/explorer-agent.md sha256=/);
  assert.match(f.setup('apply'), /No changes\./);
});

test('UI matrix honors refusal and loses reduction when the real diff affects layout', t => {
  const f = fixture(t);
  const base = '<template><button placeholder="one">Open</button></template>\n';
  f.put('projects/api/Form.vue', base);
  f.git('projects/api', 'add', '.');
  f.git('projects/api', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const main = f.git('projects/api', 'branch', '--show-current').trim();
  f.git('projects/api', 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + main);
  f.setup('apply', 'dev', {BEERPOWERS_VIEWPORTS_JSON:JSON.stringify([375, 848, 1440].map(width =>
    ({width, height:800, name:'v'+width, mobile:width===375})))});
  f.git('projects/api', 'checkout', '-qb', 'ui-case');
  const brief = 'memory/tasks/ui-case/preflight.md';
  f.put(brief, '# UI case\n');
  f.put('projects/api/Form.vue', base.replace('one', 'two'));
  const matrix = () => f.node('ui-acceptance.mjs', 'matrix', 'ui-case', 'api');
  assert.equal(matrix().canPropose, true);
  assert.equal(matrix().proposed.width, 1440);
  f.put(brief, '# UI case\nUI widths [api]: declined 2026-11-25 — Все ширины.\n');
  assert.equal(matrix().canPropose, false);
  assert.deepEqual(matrix().viewports.map(item => item.width), [375, 848, 1440]);
  f.put(brief, f.read(brief) + 'UI widths [api]: approved v848 2026-11-25 — Проверить 848.\n');
  assert.deepEqual(matrix().viewports.map(item => item.width), [848]);
  f.put('projects/api/Form.vue', base.replace('<button', '<button class="grid"'));
  assert.equal(matrix().revoke, true);
  assert.deepEqual(matrix().viewports.map(item => item.width), [375, 848, 1440]);
  f.put(brief, f.read(brief) + 'UI widths [api]: revoked 2026-11-25 — Изменилась вёрстка.\n');
  f.put('projects/api/Form.vue', base.replace('one', 'two'));
  assert.deepEqual(matrix().viewports.map(item => item.width), [375, 848, 1440]);
});

test('economy leaves unknown, long and gated phases separate and protects independent review', () => {
  const decide = input => {
    const result = spawnSync(process.execPath, [join(pkg, 'bin', 'team-economy.mjs')], {
      input:JSON.stringify(input), encoding:'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const lowRisk = {economy:true, files:1, largeDiff:false, sharedComponent:false, invariant:false, critical:false,
    independentReview:false, phases:[{name:'tests', requests:null}, {name:'browser', requests:70},
      {name:'mutations', requests:20}, {name:'other', requests:71}]};
  assert.deepEqual(decide(lowRisk), {reviewBy:'team-lead', runs:[['tests'], ['browser', 'mutations'], ['other']]});
  const staged = lowRisk.phases.map(phase => phase.name === 'browser' ? {...phase, stopAfter:true} : phase);
  assert.deepEqual(decide({...lowRisk, phases:staged}).runs, [['tests'], ['browser'], ['mutations'], ['other']]);
  for (const risk of ['invariant', 'critical', 'largeDiff', 'sharedComponent', 'independentReview']) {
    assert.equal(decide({...lowRisk, [risk]:true}).reviewBy, 'reviewer');
  }
});

for (const track of [undefined, 'pm', 'both']) {
  test('fresh setup: ' + (track ?? 'default dev') + ' composition, canonical engine blocks, empty update', t => {
    const f = fixture(t);
    f.setup('plan', track);
    assert.equal(f.has('.codex/workspace.json'), false);
    f.setup('apply', track);
    const charter = f.read('.codex/team-charter.md');
    assert.equal(/^## PM-конвейер\r?$/m.test(charter), Boolean(track));
    assert.equal(/^## Команда разработки\r?$/m.test(charter), track !== 'pm');
    assert.ok(charter.includes('generated-by: beerpowers-codex v' + version + ' · mode: plugin-linked'));
    const blocks = {'entry': 'AGENTS.md', 'team-charter': '.codex/team-charter.md',
      'team-lead': '.codex/team-lead.md', 'memory-index': 'memory/MEMORY.md'};
    for (const [name, target] of Object.entries(blocks)) {
      const source = {entry: 'AGENTS.md', 'memory-index': 'memory/MEMORY.md'}[name] ?? 'charter/' + name + '.md';
      const marker = {entry: 'entry', 'memory-index': 'codex-memory', 'team-charter': 'codex-team', 'team-lead': 'codex-lead'}[name];
      const canonical = readFileSync(join(pkg, 'templates', source), 'utf8').replaceAll('\r\n', '\n').match(new RegExp('<!-- beerpowers:engine ' + marker + ' -->[\\s\\S]*?<!-- /beerpowers:engine -->'))[0];
      assert.equal(f.read(target).replaceAll('\r\n', '\n').split(canonical).length, 2, target + ' has exactly one canonical block');
    }
    assert.ok(f.has('memory/tests/probes.md'));
    assert.ok(f.has('memory/adr/.gitkeep'));
    assert.ok(!f.read('memory/project/project-map.md').includes('{{PROJECT}}'));
    assert.match(f.setup('apply'), /No changes\./);
    assert.deepEqual(f.update('both').changes, [], 'update ignores stale track selection');
    if (!track) {
      const beforePM = charter + '\n```md\n## PM-конвейер\n```\n';
      f.put('.codex/team-charter.md', beforePM);
      f.setup('apply', 'pm');
      const extended = f.read('.codex/team-charter.md');
      assert.equal(extended.replace(/^\| `product` \|[^\r\n]*\r?\n/m, '').slice(0, beforePM.length), beforePM,
        'activating PM adds only its roster row and section');
      assert.match(extended, /^## PM-конвейер\r?$/m);
      assert.match(f.setup('apply', 'pm'), /No changes\./);
    }
  });
}

test('enable the second track explicitly and retain manual charter, foreign engine markers, old index and Claude files', t => {
  const f = fixture(t);
  const oldIndex = '\uFEFF# Память\r\nРучной индекс.\r\n~~~md\r\n<!-- beerpowers:engine codex-memory -->\r\n~~~\r\n';
  const oldAgents = '# Rules\r\n<!-- beerpowers:engine other-track -->\r\nOther content.\r\n<!-- /beerpowers:engine -->\r\n';
  f.put('AGENTS.md', oldAgents);
  f.put('memory/MEMORY.md', oldIndex);
  f.put('.neighbor/workspace.json', '{"owner":"neighbor"}');
  f.setup('apply', 'pm');
  const manual = f.read('.codex/team-charter.md') + '\nМоя ручная поправка.\n';
  f.put('.codex/team-charter.md', manual);
  f.setup('apply', 'dev');
  const extended = f.read('.codex/team-charter.md');
  for (const role of ['reviewer', 'explorer']) assert.match(extended, new RegExp('^\\| `' + role + '` \\|', 'm'));
  assert.equal(extended.replace(/^\| `(?:reviewer|explorer)` \|[^\r\n]*\r?\n/gm, '').slice(0, manual.length), manual);
  assert.equal(extended.match(/^## PM-конвейер$/gm).length, 1);
  assert.ok(f.read('AGENTS.md').startsWith(oldAgents));
  assert.equal(f.read('memory/MEMORY.md'), oldIndex);
  assert.equal(f.has('memory/tests/probes.md'), false);
  assert.equal(f.read('.neighbor/workspace.json'), '{"owner":"neighbor"}');
  assert.match(f.setup('plan', 'both'), /No changes\./);
});

test('a neighboring tool without shared memory does not change fresh setup', t => {
  const f = fixture(t);
  f.put('.claude/workspace.json', '{"owner":"neighbor"}');
  f.setup('apply', 'dev');
  assert.ok(f.has('memory/tests/probes.md'));
  assert.match(f.read('memory/MEMORY.md'), /^<!-- beerpowers:engine codex-memory -->/m);
  assert.equal(f.read('.claude/workspace.json'), '{"owner":"neighbor"}');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readCharter } from '../plugins/beerpowers/bin/lib/role-context.mjs';
import { parseFrontmatter } from '../plugins/beerpowers/bin/lib/role-metadata.mjs';
import { refreshRole } from '../plugins/beerpowers/bin/lib/role-setup.mjs';
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

test('setup plan and two applies place distinct charter and lead slots at the intended sections', t => {
  const f = fixture(t);
  const table = '| Роль | Проекты | Read on spawn | Миссия |\n|---|---|---|---|\n| `architect` | api | `memory/MEMORY.md` | ROLES-TABLE |';
  const slots = {'team-charter': {
    PURPOSE:'PURPOSE-ONE', STACK_TABLE:'STACK-TWO', COMMANDS:'COMMANDS-THREE', ROLES_TABLE:table,
    MODELS:'| Роль | Модель | Причина |\n|---|---|---|\n| architect | gpt-6.2-astra | MODELS-FOUR |',
    PROJECT_RULES:'PROJECT-FIVE\n\n~~~~md\n## Состав\n~~~\n<!-- beerpowers:engine example -->\n~~~~',
    UNIVERSAL_SKILLS:'SKILLS-SIX', MEMORY_FILES_EXTRA:'MEMORY-SEVEN',
  }, 'team-lead':{
    CLASS_EXTRA:'CLASS-ONE', EFFORT_TABLE:'EFFORT-TWO', MODEL_EXTRA:'MODEL-THREE', GATES_EXTRA:'GATES-FOUR', CLOSING_EXTRA:'CLOSING-FIVE',
  }};
  const options = {BEERPOWERS_PROJECT_NAME:'Fixture', BEERPOWERS_INTAKE:'stages', BEERPOWERS_CHARTER_SLOTS_JSON:JSON.stringify(slots)};
  const plan = f.setup('plan', undefined, options);
  assert.match(plan,/CLOSING-FIVE/);
  assert.ok(!f.has('.codex/team-charter.md'));
  f.setup('apply', undefined, options);
  for (const [file, sequence] of Object.entries({
    'team-charter':['# Team Charter — Fixture','## Назначение','PURPOSE-ONE','## Стек','STACK-TWO','## Команды','COMMANDS-THREE','## Состав','ROLES-TABLE','roles-issues','MODELS-FOUR','## Intake-режим','Intake: stages','evidence-discipline','PROJECT-FIVE','SKILLS-SIX','memory-files','MEMORY-SEVEN','task-artifacts'],
    'team-lead':['task-class','CLASS-ONE','## Effort и модель роли','EFFORT-TWO','effort-questions','MODEL-THREE','## Порядок гейтов','GATES-FOUR','## Git','## Закрытие задачи','CLOSING-FIVE','## Запись в трекер'],
  })) {
    const body = f.read('.codex/' + file + '.md');
    let offset = -1;
    for (const value of sequence) {
      offset = body.indexOf(value,offset+1);
      assert.ok(offset >= 0, file + ': ' + value);
    }
    assert.doesNotMatch(body,/beerpowers:engine ui-findings/);
  }
  assert.match(f.setup('apply', undefined, options),/No changes\./);
  assert.deepEqual(f.update().changes,[]);
});

test('migration resolves active instruction owners and pins only proven historical references to the archive', t => {
  const f = fixture(t);
  const memory = 'memory/MEMORY.md';
  const report = 'memory/tasks/UNIT-1/design-brief.md';
  const local = 'memory/project/domain-invariants.md';
  const fenced = '\r\n~~~~md\r\n`workspace.json` и `team-lead.md`\r\n~~~\r\n~~~~\r\n';
  const note = 'Снимок `workspace.json` и `guide.md`.  \r\n';
  const index = '# Память\r\n\r\nЖурнал — `team-lead.md`.\r\n### Владельцы правил\r\n\r\n| Маркер | Владелец |\r\n|---|---|\r\n| `Маркер` | `.claude/team-charter.md` |\r\n';
  f.put('.claude/team-charter.md','# Team Charter — Archive\n');
  f.put('.claude/team-lead.md','# Team-lead — Archive\n');
  f.put('.claude/workspace.json','{}\n');
  f.put('.claude/rules/guide.md','---\npaths: [projects/api/src/**]\n---\n# Проверка\n');
  f.put(memory,index + fenced);
  f.put(report,note + fenced);
  f.put(local,'Местный файл `workspace.json`.\n');
  f.put('memory/project/workspace.json','{}\n');
  f.git('.','add','.claude','memory');
  f.git('.','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Архив');
  const sha = f.git('.','rev-parse','HEAD').trim();
  const newLine = 'Новая запись: `workspace.json`.\r\n';
  f.put(report,note + fenced + newLine);
  const preview = f.setup('plan');
  assert.ok(preview.includes(sha + ':.claude/workspace.json'));
  assert.equal(f.read(report),note + fenced + newLine);
  f.setup('apply');
  const want = note.replace('workspace.json',sha + ':.claude/workspace.json').replace('guide.md',sha + ':.claude/rules/guide.md');
  assert.equal(f.read(report),want + fenced + newLine);
  assert.equal(f.read(memory),index.replace('team-lead.md','.codex/team-lead.md').replace('.claude/team-charter','.codex/team-charter') + fenced);
  assert.equal(f.read(local),'Местный файл `workspace.json`.\n');
  assert.match(f.setup('apply'),/No changes\./);
  f.put(report,note + fenced);
  const plan = f.update();
  assert.ok(plan.changes.some(change => change.path === report));
  f.node('update.mjs','apply',plan.planId);
  assert.equal(f.read(report),want + fenced);
  assert.deepEqual(f.update().changes,[]);
});

test('migration restores the original project name and autonomous intake from the archived charter', t => {
  const f = fixture(t);
  f.put('.claude/team-charter.md','# Team Charter — Магазин\n\n## Intake-режим\n\n**Сами от начала до конца.** Свой текст режима.\n');
  f.setup('apply');
  const charter = f.read('.codex/team-charter.md');
  assert.match(charter,/^# Team Charter — Магазин$/m);
  assert.match(charter,/^Intake: autonomous\s+\*\*Сами от начала до конца\.\*\* Свой текст режима\./m);
  assert.equal(JSON.parse(f.read('.codex/workspace.json')).projectName,'Магазин');
  assert.match(f.setup('apply'),/No changes\./);
});

test('setup imports the ordered project role, preserves feedback bytes and repairs only a missing header', t => {
  const f = fixture(t);
  const header = '---\r\nname: architect-agent\r\ndescription: "Project: scope"\r\nmodel: custom-model\r\ncolor: purple\r\nmemory: project\r\ntools:\r\n  - Read\r\nskills: []\r\n---\r\n';
  const body = '\r\n## DESIGN\r\n1. Intake\r\n\r\n2. Кто меняет значение?\r\n   - редактор\r\n\r\n3. Слои\r\n4. ADR\r\n~~~~markdown\r\n## Решение\r\n~~~\r\n## Последствия\r\n~~~~\r\n5. Срезы\r\n6. Проверка\r\n';
  const memory = Buffer.from('\ufeff---\r\nsource: meeting\r\n---\r\n> «Точные слова»  ');
  const path = '.codex/agents/architect-agent.md';
  f.put('.claude/agents/architect-agent.md', header + body);
  f.put('.claude/agent-memory/architect-agent/feedback_example.md', memory);
  f.setup('apply');
  assert.equal(f.read(path), header + body);
  assert.deepEqual(readFileSync(join(f.root, '.codex/agent-memory/architect/feedback_example.md')), memory);
  const edited = body + 'Собственное дополнение.';
  f.put(path, edited);
  assert.match(f.setup('plan'), /UPDATE \.codex\/agents\/architect-agent\.md/);
  assert.equal(f.read(path), edited);
  const plan = f.update();
  f.node('update.mjs', 'apply', plan.planId);
  assert.equal(f.read(path), header + edited);
  f.put(path, (header + edited).replace('custom-model', 'manual-model'));
  assert.deepEqual(f.update().changes, []);
  assert.match(f.setup('apply'), /^No changes\.$/m);
});

test('role engine update keeps project paragraphs, fenced examples and a manual YAML value byte for byte', () => {
  const block = (key, value, condition = '') => '<!-- beerpowers:engine ' + key + condition + ' -->\n' + value + '\n<!-- /beerpowers:engine -->';
  const old = block('phase', 'Старое требование'), replacement = block('phase', 'Новое требование');
  const ui = block('screen', 'Проверить экран', ' if=ui:true');
  const existing = '---\nname: testing-agent\nmodel: "manual"\ndescription: |-\n  ~~~~\n---\n## Порядок\nАвторский пункт 2.\n\n' +
    old + '\n\n## Пример\n~~~~md\n## Порядок\n' + old + '\n~~~~\nПосле примера.\n\n' + ui;
  const newTemplate = '## Порядок\n' + replacement + '\n\n## Пример\n' + ui;
  const crlf = value => value.replaceAll('\n', '\r\n');
  assert.equal(refreshRole(crlf(existing), newTemplate, newTemplate.replace(replacement, old), true, 'testing'),
    crlf(existing.replace(old, replacement)));
  assert.equal(refreshRole(crlf(existing), newTemplate, newTemplate.replace(replacement, old), false, 'testing'),
    crlf(existing.replace(old, replacement).replace(ui, '')));
  assert.throws(() => refreshRole(existing.replace(old, old.replace('Старое', 'Ручное')), newTemplate,
    newTemplate.replace(replacement, old), true, 'testing'), /Conflict.*phase/);
});

test('migration replaces the archived role index guidance once and preserves notes, links and conflicting feedback', t => {
  const f = fixture(t);
  const source = '.claude/agent-memory/architect-agent/', target = '.codex/agent-memory/architect/';
  const policy = 'Сюда — только `feedback_*.md`: поправки человека к работе роли. Знание о проекте — в `memory/`\r\n' +
    'по таблице «Куда класть находку» `memory/MEMORY.md`; правило — charter, «Память роли — только\r\nобратная связь человека».';
  const intro = '# Память роли architect-agent\r\n\r\n' + policy + '\r\n\r\n';
  const notes = 'Прочитай до оценки.\r\n\r\n- [Слова автора](feedback_topic.md) — по запросу.\r\n  Подпункт.  \r\n\r\nПосле ссылки.';
  const detail = Buffer.from('\ufeff---\r\nsource: transcript\r\n---\r\n«Слова автора»  ');
  f.put(source + 'MEMORY.md', intro + notes);
  f.put(source + 'feedback_topic.md', detail);
  f.setup('apply');
  const canonical = readFileSync(join(pkg,'templates/role-memory/MEMORY.md'),'utf8').replace(/\r?\n/g,'\r\n');
  const expected = canonical + '\r\n' + notes;
  assert.equal(f.read(target + 'MEMORY.md'), expected);
  assert.deepEqual(readFileSync(join(f.root, target + 'feedback_topic.md')), detail);
  assert.match(f.setup('apply'), /^No changes\.$/m);
  f.put(target + 'MEMORY.md', intro + notes);
  assert.match(f.setup('plan'), /UPDATE \.codex\/agent-memory\/architect\/MEMORY.md/);
  f.setup('apply');
  assert.equal(f.read(target + 'MEMORY.md'), expected);
  const own = '# Своя памятка\r\nМоё правило.  ';
  f.put(target + 'MEMORY.md', own);
  assert.match(f.setup('apply'), /^No changes\.$/m);
  f.put(target + 'feedback_topic.md', 'Сохранённая правка владельца');
  assert.throws(() => f.setup('apply'), /conflict.*feedback_topic\.md/i);
  assert.equal(f.read(target + 'MEMORY.md'), own);
  assert.equal(f.read(target + 'feedback_topic.md'), 'Сохранённая правка владельца');
  assert.deepEqual(readFileSync(join(f.root, source + 'feedback_topic.md')), detail);
});

test('setup moves legacy scoped skills and path bindings to their owners before removing configuration', t => {
  const f = fixture(t), meta = path => parseFrontmatter(f.read(path)).fields;
  f.put('projects/web/README.md', 'Tests: git diff --check\n');
  f.git('projects/web', 'init', '-q');
  const checks = Object.fromEntries(['api','web'].map(name => [name, {command:'git diff --check', source:'README.md', profile:'main-default'}]));
  const options = {BEERPOWERS_TESTS_JSON:JSON.stringify(checks)};
  f.setup('apply', 'both', options);
  const base = '.codex/role-settings', brief = '.codex/agents/testing-agent.md', rule = '.codex/rules/status.md';
  f.put(rule, '# Проверка статуса\n');
  f.put(base + '.json', '{"rules":{}}');
  for (const name of ['api','web']) f.put(base + '/' + name + '.json', JSON.stringify({
    team:['architect','tester'], skills:{tester:['skill-' + name], 'team-lead':['lead-' + name]}, rules:{status:[name === 'api' ? 'src' : 'ui']},
  }));
  const preview = f.setup('plan', undefined, options);
  assert.match(preview, /DELETE \.codex\/role-settings\/api\.json/);
  assert.deepEqual(meta(brief).skills, []);
  f.setup('apply', undefined, options);
  assert.deepEqual(meta(brief).project_skills, {api:['skill-api'], web:['skill-web']});
  assert.deepEqual(meta('.codex/team-lead.md').project_skills, {api:['lead-api'], web:['lead-web']});
  assert.deepEqual(meta(rule).paths, ['projects/api/src', 'projects/web/ui']);
  assert.ok(f.read(rule).endsWith('# Проверка статуса\n'));
  assert.ok(!f.has(base + '.json') && !f.has(base + '/api.json') && !f.has(base + '/web.json'));
  assert.match(f.setup('apply', undefined, options), /^No changes\.$/m);
});

test('local Git settings migrate privately on setup and update', t => {
  const old = '.claude/git-settings.local.json';
  const dest = '.codex/git-settings.local.json';
  const settings = '{\r\n  "reviewer": "synthetic-personal-marker"\r\n}';
  const f = fixture(t);
  f.setup('apply');
  assert.equal(f.has(dest), false);
  f.put(old, settings);
  for (const mode of ['plan', 'plan-json']) {
    const preview = f.setup(mode);
    assert.doesNotMatch(preview, /synthetic-personal-marker/);
    assert.ok(!preview.includes(Buffer.from(settings).toString('base64')));
  }
  assert.equal(f.has(dest), false);
  const plan = f.update();
  assert.ok(plan.changes.some(change => change.path === dest));
  f.node('update.mjs', 'apply', plan.planId);
  assert.equal(f.read(dest), settings);
  assert.equal(f.read(old), settings);
  assert.equal(f.git('.', 'check-ignore', '--', dest, old).trim().split(/\r?\n/).length, 2);
  assert.match(f.setup('apply'), /^No changes\.$/m);
  f.put(dest, '{"reviewer":"other-synthetic-marker"}');
  assert.throws(() => f.setup('apply'), /git-settings\.local\.json.*conflict/i);
  assert.equal(f.read(dest), '{"reviewer":"other-synthetic-marker"}');
  const fresh = fixture(t);
  fresh.put(old, settings);
  assert.doesNotMatch(fresh.setup('apply'), /synthetic-personal-marker/);
  assert.equal(fresh.read(dest), settings);
  assert.match(fresh.setup('apply'), /^No changes\.$/m);
});

test('setup previews and installs the workspace safety policy without overwriting project config', t => {
  const config = '.codex/config.toml';
  const rules = '.codex/rules/beerpowers-safety.rules';
  const fresh = fixture(t);
  const plan = fresh.setup('plan');
  for (const path of [config, rules]) {
    assert.ok(plan.includes('CREATE ' + path));
    assert.equal(fresh.has(path), false);
  }
  fresh.setup('apply');
  assert.match(fresh.read(config), /^default_permissions = "beerpowers"$/m);
  assert.match(fresh.read(config), /^"\*\*\/\.env\.\*" = "deny"$/m);
  assert.match(fresh.read(rules), /"migrate:fresh", "migrate:reset", "db:wipe"/);
  assert.doesNotMatch(fresh.read(rules), /shop-backend/);
  assert.match(fresh.setup('apply'), /^No changes\.$/m);
  assert.deepEqual(fresh.update().changes, []);
  for (const path of [config, rules]) rmSync(join(fresh.root, path));
  const upgrade = fresh.update();
  assert.deepEqual(upgrade.changes.map(change => change.path).sort(), [config, rules]);
  fresh.node('update.mjs', 'apply', upgrade.planId);
  assert.deepEqual(fresh.update().changes, []);

  const existing = fixture(t);
  const manual = 'model = "project-model"\r\n';
  existing.put(config, manual);
  assert.match(existing.setup('plan'), /Existing \.codex\/config\.toml/);
  existing.setup('apply');
  assert.equal(existing.read(config), manual);
  assert.equal(existing.read(rules), fresh.read(rules));
  assert.match(existing.update().advisories.join('\n'), /\.codex\/config\.toml.*beerpowers/);
});

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
  const gates = '.codex/quality-gates.txt';
  f.setup('apply');
  const customGate = '*/projects/demo/src/*.ts|*/worktrees/*/demo/src/*.ts Ручной гейт: git diff --check\r\n';
  const previousGate = '*/projects/demo/*|*/worktrees/*/demo/* Проверка проекта: git diff --check\r\n';
  assert.equal(f.read(gates), previousGate.replaceAll('\r\n', '\n'));
  f.put(gates, customGate + previousGate);
  f.put(memory, f.read(memory) + '\nРучная ссылка [справка](commands/demo.md).\n');
  f.put(commands, f.read(commands).replace('Штатные проверки проекта demo', 'Ручное описание проверок'));
  f.put('memory/tests/extra.md', '# Проектное дополнение к проверкам\n');
  f.put(charter, f.read(charter).replace(/^(\| `tester` \|[^|]*\|[^|]+?) \|/m, '$1, `memory/tests/extra.md` |'));

  const guide = 'memory/commands/api.md';
  f.put(guide, '# API\n\n## Гейты\n\n- `make -C projects/demo check`\n');
  f.put('projects/demo/Makefile', 'check:\n\t@echo fixture\n');
  const options = {BEERPOWERS_TESTS_JSON:JSON.stringify({demo:{guide, command:'make check', source:'Makefile'}})};
  const before = [memory, commands, charter].map(f.read);
  const plan = f.setup('plan', undefined, options);
  for (const file of [memory, commands, charter, gates]) assert.ok(plan.includes('UPDATE ' + file), file);
  const [index, commandIndex, roster] = before;
  f.setup('apply', undefined, options);
  assert.equal(f.read(memory), index.replace('[Проверки demo](commands/demo.md)', '[Проверки demo](commands/api.md)'));
  assert.equal(f.read(commands), commandIndex.replace('[demo.md](demo.md)', '[api.md](api.md)'));
  const updatedGates = customGate + previousGate.replace('git diff --check', 'make check');
  assert.equal(f.read(gates), updatedGates);
  assert.equal(f.read(charter), roster.replaceAll('`memory/commands/demo.md`', '`memory/commands/api.md`'));
  assert.match(f.packet('tester'), /FILE memory\/commands\/api\.md sha256=/);
  assert.match(f.setup('apply', undefined, options), /^No changes\.$/m);
  assert.deepEqual(f.update().changes, []);
  const updated = [memory, commands, charter].map(f.read);
  [memory, commands, charter].forEach((file, i) => f.put(file, before[i]));
  f.put(gates, customGate + previousGate);
  f.setup('apply', undefined, options);
  assert.deepEqual([memory, commands, charter].map(f.read), updated, 'reconciles pointers when the binding was already written');
  assert.equal(f.read(gates), updatedGates);
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
  assert.match(charter, /## Стек \(фиксированный\)\s+Таблица подтверждённого стека\.\s+## Команды/);
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
  const authoredRole = '|`product`| api | Ручной список чтения | Ручная миссия | Свой триггер | Своя практика |';
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
  assert.ok(!f.has('.codex/role-settings.json'));
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
  assert.ok(!f.has('.codex/role-settings.json'));
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
  const path = '.codex/team-charter.md';
  const roles = () => [...readCharter(f.root, 'api').team.keys()];
  const active = ['architect', 'frontend', 'tester', 'reviewer', 'explorer', 'devops', 'auditor'];
  assert.deepEqual(roles().sort(), active.sort());
  assert.match(f.read('.codex/team-charter.md'), /^Intake: stages$/m);
  assert.match(f.packet('frontend'), /Assigned skills \(frontend\): nuxt/);
  assert.match(f.packet('frontend'), /FILE memory\/project\/domain-invariants.md sha256=/);
  assert.deepEqual(JSON.parse(f.read('.codex/workspace.json')).viewports.map(item => item.width), [375, 848, 1440]);
  f.put(path, f.read(path).replace(/(^## Состав\r?\n)([\s\S]*?)(?=^## )/m, (_, heading, table) =>
    heading + table.split(/(?<=\n)/).filter(line => !/^\| `(?:auditor|devops|explorer|frontend|reviewer)`/.test(line)).join('')));
  assert.match(f.setup('apply'), /No changes\./);
  assert.deepEqual(roles(), ['architect', 'tester']);
  assert.match(f.setup('apply', 'dev', options), /No changes\./);
  assert.match(f.setup('apply', undefined, {BEERPOWERS_INTAKE:'autonomous'}), /No changes\./);
  assert.match(f.read('.codex/team-charter.md'), /^Intake: stages$/m);
  assert.deepEqual(roles(), ['architect', 'tester']);
  assert.deepEqual(f.update().changes, []);
});

test('setup plans missing assigned skills and unavailable integrations without changing configuration', t => {
  const f = fixture(t);
  const settingsFile = '.codex/agents/frontend-agent.md';
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
  assert.deepEqual([...readCharter(f.root, 'api').team.keys()].sort(), ['architect', 'frontend', 'reviewer', 'tester']);
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

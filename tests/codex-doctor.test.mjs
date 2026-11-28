import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../plugins/beerpowers/bin/', import.meta.url));
function workspace(t, {setup = true} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'beerpowers-doctor-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const env = {...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:join(root, 'no-global-config'),
    GIT_ALLOW_PROTOCOL:'file', BEERPOWERS_TEST_COMMAND:'git status --short', BEERPOWERS_TEST_SOURCE:'README.md'};
  const run = (binary, args, cwd = root) => execFileSync(binary, args, {cwd, env, windowsHide:true, encoding:'utf8'});
  const product = join(root, 'projects', 'app');
  mkdirSync(product, {recursive:true});
  run('git', ['init', '-q']);
  run('git', ['init', '-q'], product);
  writeFileSync(join(product, 'README.md'), 'Checks: git status --short\n');
  const perl = env.BEERPOWERS_PERL ?? (process.platform === 'win32'
    ? join(dirname(dirname(run('where.exe', ['git.exe']).split(/\r?\n/)[0])), 'usr/bin/perl.exe') : 'perl');
  if (setup) run(perl, [join(bin, 'workspace.pl'), 'apply']);
  else {
    for (const folder of ['.codex', 'memory/project', 'memory/tech-debt']) mkdirSync(join(root, folder), {recursive:true});
    writeFileSync(join(root, 'memory/MEMORY.md'), '# Memory\n');
  }
  return {root, run, env, report:() => {
    const r = spawnSync(process.execPath, [join(bin, 'doctor.mjs')], {cwd:root, env, encoding:'utf8'});
    return {code:r.status, checks:Object.fromEntries(JSON.parse(r.stdout).checks.map(row => [row.id, row]))};
  }, workspaceCheck:(...args) => spawnSync(process.execPath, [join(bin, 'workspace-check.mjs'), ...args],
    {cwd:root, env, encoding:'utf8'})};
}

test('doctor rejects an unpreparable split run before executing the product command', t => {
  const {root,report} = workspace(t);
  const file = join(root,'.codex/workspace.json');
  const cfg = JSON.parse(readFileSync(file,'utf8'));
  cfg.tests = {repos:{app:{files:['missing/**/*.test.js'],command:'node --test {files}'}}};
  writeFileSync(file,JSON.stringify(cfg));
  const {code,checks} = report();
  assert.equal(code,1);
  assert.equal(checks['test-machine'].status,'fail');
});

test('doctor fails on a missing configured UI browser and tracked mutation resources', t => {
  const {root,run,env,report} = workspace(t);
  const file = join(root,'.codex/workspace.json');
  const cfg = JSON.parse(readFileSync(file,'utf8'));
  cfg.ui = true;
  env.BEERPOWERS_CHROME = join(root,'missing-browser');
  run('git',['add','README.md'],join(root,'projects/app'));
  run('git',['-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-qm','test'],join(root,'projects/app'));
  cfg.tests = {repos:{app:{mode:'native',command:'node --test', mutate:{command:'node --test {filter}',copy:['README.md'],link:['missing-dir']}}}};
  writeFileSync(file,JSON.stringify(cfg));
  const {code,checks} = report();
  assert.equal(code,1);
  assert.equal(checks.ui.status,'fail');
  assert.match(JSON.stringify(checks['test-machine'].evidence),/README\.md/);
  assert.match(JSON.stringify(checks['test-machine'].evidence),/missing-dir/);
});

test('doctor names the project and role when an assigned skill is missing from this session', t => {
  const {root,env,report} = workspace(t);
  const file = join(root,'.codex/agents/architect-agent.md');
  writeFileSync(file,readFileSync(file,'utf8').replace(/^skills:.*$/m, 'skills: [nuxt, nuxt-ui]'));
  delete env.BEERPOWERS_SESSION_SKILLS_JSON;
  assert.equal(report().checks['role-skills'].status,'unavailable');
  env.BEERPOWERS_SESSION_SKILLS_JSON = '["nuxt"]';
  assert.deepEqual(report().checks['role-skills'].evidence, [{product:'app',role:'architect',skill:'nuxt-ui'}]);
  env.BEERPOWERS_SESSION_SKILLS_JSON = '["nuxt","nuxt-ui"]';
  assert.equal(report().checks['role-skills'].status,'pass');
});

test('workspace-check lists checks outside a workspace and warnings leave the exit code zero', t => {
  const {root, workspaceCheck} = workspace(t);
  const list = spawnSync(process.execPath, [join(bin, 'workspace-check.mjs'), '--list'],
    {cwd:join(root, 'projects/app'), encoding:'utf8'});
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /workspace-config/);
  assert.match(list.stdout, /rule-snapshots/);

  const rule = join(root, '.codex/rules/test-rule.md');
  mkdirSync(dirname(rule), {recursive:true});
  const body = '# Правило\nДержи совместимость с widget 2.3.1.\n\n```text\nwidget 5.4.3\n```\n';
  writeFileSync(rule, body);
  const result = workspaceCheck();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /WARN\s+rule-snapshots/);
  assert.match(result.stdout, /test-rule\.md:2/);
  assert.doesNotMatch(result.stdout, /5\.4\.3/);
  assert.equal(readFileSync(rule, 'utf8'), body);
});

test('workspace checks report configuration, rule ownership and template drift together in doctor', t => {
  const {root, report, workspaceCheck} = workspace(t);
  const workspaceConfig = join(root, '.codex/workspace.json');
  const config = JSON.parse(readFileSync(workspaceConfig, 'utf8'));
  writeFileSync(workspaceConfig, JSON.stringify({...config, ui:'yes'}));
  const gitSettings = join(root, '.codex/git-settings.json');
  const profiles = JSON.parse(readFileSync(gitSettings, 'utf8'));
  writeFileSync(gitSettings, JSON.stringify({...profiles, repos:{...profiles.repos, missing:'main-default'}}));
  const charter = join(root, '.codex/team-charter.md');
  const charterText = readFileSync(charter, 'utf8') + '\n{{UNFILLED}}\n';
  writeFileSync(charter, charterText);
  const index = join(root, 'memory/MEMORY.md');
  writeFileSync(index, readFileSync(index, 'utf8') + '\n### Владельцы правил\n\n' +
    '| Маркер | Владелец |\n| --- | --- |\n| `уникальное правило` | `.codex/rules/owner.md` |\n');
  mkdirSync(join(root,'.codex/rules'), {recursive:true});
  writeFileSync(join(root, '.codex/rules/owner.md'), 'уникальное правило\n');
  writeFileSync(join(root, '.codex/rules/other.md'), 'уникальное правило\n');
  mkdirSync(join(root, '.codex/agent-memory/tester'), {recursive:true});
  writeFileSync(join(root, '.codex/agent-memory/tester/extra.txt'), 'old notes\n');

  const {code, checks} = report();
  assert.equal(code, 1, JSON.stringify(checks));
  for (const id of ['workspace-config', 'git-settings', 'template-slots', 'rule-owners', 'role-memory']) {
    assert.equal(checks[id]?.status, 'fail', id);
  }
  assert.match(JSON.stringify(checks['rule-owners'].evidence), /\.codex\/rules\/other\.md/);
  assert.doesNotMatch(JSON.stringify(checks['rule-owners'].evidence), /memory\/MEMORY\.md/);
  assert.equal(workspaceCheck().status, 1);
  assert.equal(readFileSync(charter, 'utf8'), charterText);
});

test('workspace checks understand namespaced tasks and per-product artifacts', t => {
  const {root, workspaceCheck} = workspace(t);
  const code = 'feature/BP-123';
  const task = join(root, 'memory/tasks', code);
  mkdirSync(join(task, 'repos/app'), {recursive:true});
  mkdirSync(join(task, 'tracker/task-attachment'), {recursive:true});
  mkdirSync(join(task, 'screenshots'), {recursive:true});
  for (const file of ['checkouts.json', 'repos/app/feature-state.json', 'repos/app/early-review.md',
    'repos/app/opponent-report.md', 'tracker/task.md', 'tracker/task-attachment/raw.txt', 'qa.jsonl', 'BP-123-qa.html']) {
    writeFileSync(join(task, file), 'fixture\n');
  }
  const clean = workspaceCheck();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  writeFileSync(join(task, 'repos/app/draft.md'), 'draft\n');
  writeFileSync(join(root, 'memory/tasks/loose.tmp'), 'temporary\n');
  const result = workspaceCheck();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL\s+task-artifacts/);
  assert.match(result.stdout, /memory\/tasks\/feature\/BP-123\/repos\/app\/draft\.md/);
  assert.match(result.stdout, /memory\/tasks\/loose\.tmp/);
});

test('workspace checks require shared ignore rules and report ignored team settings', t => {
  const {root, run, report} = workspace(t);
  const ignore = join(root, '.gitignore');
  const teamFile = '.codex/barriers.json';
  const localFile = '.codex/git-settings.local.json';
  writeFileSync(ignore, readFileSync(ignore, 'utf8').replace(/^\/worktrees\/\r?\n/m, '') + '/' + teamFile + '\n');
  writeFileSync(join(root, '.git/info/exclude'), '/worktrees/\n');
  writeFileSync(join(root, localFile), 'fixture value need not be read\n');
  run('git', ['add', '-f', localFile]);
  const {code, checks} = report();
  assert.equal(code, 1);
  assert.equal(checks['checkout-ignores'].status, 'fail');
  assert.match(JSON.stringify(checks['checkout-ignores'].evidence), /worktrees\//);
  assert.equal(checks['git-settings'].status, 'fail');
  assert.match(JSON.stringify(checks['git-settings'].evidence), /git-settings\.local\.json/);
  assert.doesNotMatch(JSON.stringify(checks), /fixture value need not be read/);
  assert.equal(checks['shared-settings'].status, 'fail');
  assert.match(JSON.stringify(checks['shared-settings'].evidence), /barriers\.json/);
});
test('expanded doctor reconciles installed resources without writing or reading private usage', t => {
  const {root, run, report} = workspace(t);
  const update = join(bin, 'update.mjs');
  const plan = JSON.parse(run(process.execPath, [update, 'plan']));
  run(process.execPath, [update, 'apply', plan.planId]);
  run('git', ['add', '.']);
  run('git', ['-c','user.name=Doctor fixture','-c','user.email=doctor@example.invalid','commit','-qm','Workspace']);
  const {code, checks} = report();
  assert.equal(code, 0);
  for (const id of ['package','workspace','migration','role-briefs','barriers','memory-links','ui','qa-settings']) {
    assert.equal(checks[id].status, 'pass', id);
  }
  assert.equal(checks.host.evidence.hookTrust, null);
  assert.equal(checks.usage.status, 'unavailable');
  assert.equal(checks.usage.evidence.tokens, null);
  assert.equal(run('git', ['status', '--porcelain']), '');
  assert.deepEqual(JSON.parse(run(process.execPath, [update, 'plan'])).changes, []);
  assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes('.codex/team-charter.md'));
});

test('multi-product migration reuses each saved command and extended doctor reports both scopes', t => {
  const {root, run, report} = workspace(t);
  const second = join(root, 'projects/web');
  mkdirSync(second);
  run('git',['init','-q'],second);
  writeFileSync(join(second,'web.md'),'Checks: npm test\n');
  writeFileSync(join(root,'memory/commands/web.md'),
    '# Web\n\nКаталог запуска: \x60projects/web/\x60\nИсточник: \x60web.md\x60\n\n\x60\x60\x60text\nnpm test\n\x60\x60\x60\n');
  const update = join(bin,'update.mjs');
  const preview = JSON.parse(run(process.execPath,[update,'plan']));
  assert.ok(preview.changes.some(change => change.path === '.codex/team-charter.md'));
  run(process.execPath,[update,'apply',preview.planId]);
  const {checks,code} = report();
  assert.equal(code,0,JSON.stringify(checks));
  assert.equal(checks.workspace.evidence.length,2);
  assert.deepEqual(Object.keys(checks['role-briefs'].evidence).sort(),['app','web']);
  assert.deepEqual(checks.migration.evidence.changes,[]);
});

test('expanded doctor returns separate failures and keeps hand-edited files intact', t => {
  const {root, report} = workspace(t);
  const index = join(root, 'memory/MEMORY.md');
  const original = readFileSync(index, 'utf8') + '\n[Перенесённый глоссарий](project/missing.md)\n';
  writeFileSync(index, original);
  writeFileSync(join(root, '.codex/barriers.json'), '{"guard-push":"yes"}\n');
  const {code, checks} = report();
  assert.equal(code, 1);
  assert.equal(checks.barriers.status, 'fail');
  assert.deepEqual(checks['memory-links'].evidence.missing, ['project/missing.md']);
  assert.equal(checks.host.status, 'unavailable');
  assert.equal(readFileSync(index, 'utf8'), original);
});

test('doctor catches shortened Codex paths in retro and task artefacts', t => {
  const {root, report} = workspace(t);
  const retro = 'memory/retro-log.md';
  const task = 'memory/tasks/vue-tsc';
  mkdirSync(join(root, task), {recursive:true});
  mkdirSync(join(root, '.codex/rules'), {recursive:true});
  writeFileSync(join(root, '.codex/rules/front-components.md'), '# Правила компонентов\n');
  writeFileSync(join(root, retro), 'Правило записано в `team-lead.md`.\n');
  for (const name of ['handover', 'preflight', 'test-cases']) {
    const reference = name === 'test-cases' ? 'workspace.json' : 'front-components.md';
    writeFileSync(join(root, task, name + '.md'), 'Источник: `' + reference + '`.\n');
  }
  const {code, checks} = report();
  assert.equal(code, 1);
  assert.deepEqual(checks['memory-links'].evidence.broken.map(({source, reference}) => [source, reference]), [
    [retro, 'team-lead.md'], [task + '/handover.md', 'front-components.md'],
    [task + '/preflight.md', 'front-components.md'], [task + '/test-cases.md', 'workspace.json'],
  ]);
  writeFileSync(join(root, retro), 'Правило записано в `.codex/team-lead.md`.\n');
  for (const name of ['handover', 'preflight', 'test-cases']) {
    writeFileSync(join(root, task, name + '.md'), 'Снимок настройки: `9d81bd5:.claude/workspace.json`.\n');
  }
  assert.equal(report().checks['memory-links'].status, 'pass');
});

test('doctor flags appended brief and memory instructions and Claude masks in the entry', t => {
  const {root, report} = workspace(t);
  const add = (file, suffix) => {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8') + suffix);
  };
  const role = '.codex/agents/architect-agent.md';
  const index = '.codex/agent-memory/architect/MEMORY.md';
  add(role, '\n## Свои правила\n\nТы архитектор проекта Demo. Детали роли.\n\nТы архитектор проекта Demo.\n');
  add(index, '\n# Память роли architect-agent\n\nСюда — только \x60feedback_*.md\x60: поправки человека к работе роли.\n');
  add('AGENTS.md', '\n- \x60Read(./**/.env)\x60\n');
  const {code, checks} = report();
  assert.equal(code, 1);
  assert.match(JSON.stringify(checks['instruction-duplicates'].evidence), /architect-agent\.md/);
  assert.match(JSON.stringify(checks['role-memory'].evidence), /architect\/MEMORY\.md/);
  assert.match(JSON.stringify(checks['entry-policy'].evidence), /AGENTS\.md/);
});

test('doctor detects shadowed quality gates while preserving distinct fallbacks', t => {
  const {root, report} = workspace(t);
  const file = join(root, '.codex/quality-gates.txt');
  const specific = '*/projects/app/src/*.ts|*/worktrees/*/app/src/*.ts Линт по файлу\n';
  const fallback = '*/projects/app/*|*/worktrees/*/app/* Сборка по проекту\n';
  writeFileSync(file, fallback + specific);
  const {checks} = report();
  assert.equal(checks['quality-gates'].status, 'fail');
  assert.equal(checks['quality-gates'].evidence.filter(line => line.includes('скрыта общим правилом')).length, 2);
  writeFileSync(file, specific + fallback);
  assert.equal(report().checks['quality-gates'].status, 'pass');
});

test('doctor resolves Markdown links from task artefacts into Codex settings', t => {
  const {root, report} = workspace(t);
  const file = 'memory/tasks/DEMO/preflight.md';
  mkdirSync(join(root, 'memory/tasks/DEMO'), {recursive:true});
  writeFileSync(join(root, file), '[правило](../../../.codex/missing.json)\n' +
    '[рабочая настройка](../../../.codex/workspace.json)\n[старое вложение](missing.jpg)\n');
  const {checks} = report();
  assert.equal(checks['memory-links'].status, 'fail');
  assert.deepEqual(checks['memory-links'].evidence.broken, [{source:file, reference:'../../../.codex/missing.json'}]);
});

test('doctor checks local links across project memory and Codex docs without following junctions', t => {
  const {root, report} = workspace(t, {setup:false});
  writeFileSync(join(root, 'memory/project/with space.md'), '# Title\n');
  writeFileSync(join(root, 'memory/project/nested.md'),
    '[ok](<with space.md#title>)\n[ok](with%20space.md)\n[bad](missing.md)\n' +
    '[escape](../../../outside.md)\n[bad encoding](%ZZ.md)\n[web](https://example.invalid/404)\n' +
    '`memory/project/missing.md` и `memory/product-map.md`\n');
  writeFileSync(join(root, '.codex/links.md'), '[ok](../memory/MEMORY.md)\n[bad](missing.md)\n');
  symlinkSync(join(root, 'projects/app'), join(root, 'memory/project/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(root, 'memory/project/link.md'), '[linked](linked/README.md)\n');
  mkdirSync(join(root, 'memory/tasks/active/tracker'), {recursive:true});
  writeFileSync(join(root, 'memory/tasks/active/tracker/task.md'), '[external snapshot](ignored.md)\n');
  for (const dir of ['.codex/agent-memory-local/tester', '.codex/.cache']) {
    mkdirSync(join(root, dir), {recursive:true});
    writeFileSync(join(root, dir, 'MEMORY.md'), '[local note](ignored.md)\n');
  }
  const {code, checks} = report();
  assert.equal(code, 1);
  assert.deepEqual(checks['memory-links'].evidence.broken.map(({source, reference}) => [source, reference]), [
    ['.codex/links.md', 'missing.md'], ['memory/project/link.md', 'linked/README.md'],
    ['memory/project/nested.md', 'missing.md'], ['memory/project/nested.md', '../../../outside.md'],
    ['memory/project/nested.md', '%ZZ.md'], ['memory/project/nested.md', 'memory/project/missing.md'],
  ]);
});

test('doctor checks manual and generated debt indexes, with explicit refresh preserving manual text', t => {
  const {root, run, report} = workspace(t, {setup:false});
  const index = join(root, 'memory/tech-debt/tech-debt.md');
  const item = join(root, 'memory/tech-debt/001-first.md');
  const note = '# Технический долг\r\n\r\nРучная заметка.\r\n';
  const body = '---\nstatus: открыт\narea: API\nchecked: 2026-11-24\n---\n# 1. Первый пункт\n';
  writeFileSync(index, note);
  writeFileSync(item, body);
  assert.equal(report().checks['tech-debt-index'].status, 'fail');
  writeFileSync(index, note + '[Пункт](001-first.md)\r\n');
  assert.equal(report().checks['tech-debt-index'].status, 'pass');

  const args = [join(bin, 'tech-debt-index.mjs')];
  assert.equal(JSON.parse(run(process.execPath, args)).changed, true);
  const generated = readFileSync(index, 'utf8');
  assert.ok(generated.startsWith(note));
  assert.match(generated, /\| 1 \| открыт \| API \| \[Первый пункт\]\(001-first.md\) \| 2026-11-24 \|/);
  assert.equal(report().checks['tech-debt-index'].status, 'pass');
  assert.equal(JSON.parse(run(process.execPath, args)).changed, false);
  assert.equal(readFileSync(index, 'utf8'), generated);
  writeFileSync(item, body.replace('открыт', 'закрыт'));
  assert.equal(report().checks['tech-debt-index'].status, 'fail');
  assert.equal(readFileSync(index, 'utf8'), generated);
  assert.equal(JSON.parse(run(process.execPath, args)).changed, true);
  assert.equal(report().checks['tech-debt-index'].status, 'pass');
  writeFileSync(item, body.replace('открыт', 'ошибка'));
  assert.match(JSON.stringify(report().checks['tech-debt-index'].evidence), /001-first\.md/);
  assert.throws(() => run(process.execPath, args), /001-first\.md/);
});

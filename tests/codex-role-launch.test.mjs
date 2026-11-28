import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { parseFrontmatter, setFrontmatterField } from '../plugins/beerpowers/bin/lib/role-metadata.mjs';
import { rolePacket } from '../plugins/beerpowers/bin/lib/role-context.mjs';
import { readerCommand } from '../plugins/beerpowers/bin/role-launch.mjs';

const pkg = resolve(import.meta.dirname, '../plugins/beerpowers');
const cli = join(pkg, 'bin/role-launch.mjs');
const inventory = {'gpt-6.2-astra':['medium','xhigh','max'], 'gpt-6.2-sol':['low','medium','high']};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'beerpowers-spawn-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  function put(p, body) { const path = join(root, p); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, body); }
  const roles = {architect:'architect-agent', tester:'testing-agent', database:'database-agent'};
  const charter = ['## Состав', '| Роль | Проекты | Read on spawn | Mandatory practices |', '|---|---|---|---|',
    ...Object.keys(roles).map(role => '| `' + role + '` | demo | `memory/project/' + role + '.md` | beerpowers:minimal-diff |'),
    '', '| Роль | Модель | Причина |','|---|---|---|',
    '', '```','## Состав','| Роль | Read on spawn |','|---|---|','| fake | секрет |','```'].join('\n');
  put('.codex/team-charter.md', charter);
  put('.codex/workspace.json', '{}'); put('projects/demo/.git', 'synthetic\n');
  put('memory/commands/demo.md', 'guide'); put('memory/MEMORY.md', '# index');
  put('.codex/rules/demo.md', '---\npaths:\n  - "projects/demo/app/**"\n---\ndomain\n');
  for (const [role, name] of Object.entries(roles)) {
    put('.codex/agents/' + name + '.md', ['---', 'name: ' + name, 'description: >-', '  роль', '  проекта', 'color: purple',
      'tools: [Read, SendMessage, Skill]', 'skills:\n  - sample', 'model: ' + (role === 'tester' ? 'gpt-6.2-sol' : 'gpt-6.2-astra'),
      ...(role === 'tester' ? [] : ['memory: project']), '---','# задача'].join('\n'));
    put('memory/project/' + role + '.md', 'read:' + role);
    put('.codex/agent-memory/' + role + '/MEMORY.md', 'personal:' + role);
    put('.codex/agent-memory/' + role + '/feedback_fixture.md', '---\nsource: human\n---\n«Не терять»\r\n');
  }
  put('test-skill/SKILL.md', '# skill\nfixture instruction');
  const env = {...process.env, BEERPOWERS_SESSION_MODELS_JSON:JSON.stringify(inventory),
    BEERPOWERS_SESSION_SKILL_PATHS_JSON:JSON.stringify({sample:join(root,'test-skill/SKILL.md')})};
  const run = (args, task) => spawnSync(process.execPath, [cli, ...args], {cwd:root, env, input:task, encoding:'utf8'});
  return {root, charter, env, put, run};
}

test('YAML сохраняет типы, многострочную строку, комментарии и конец строк; дубли отвергаются', () => {
  const md = '---\r\nname: a\r\nskills:\r\n  - "a,b"\r\n# чужой комментарий\r\ndescription: >-\r\n  x: y\r\n  z\r\n---\r\nТело\r\n';
  assert.deepEqual(parseFrontmatter(md).fields, {name:'a', skills:['a,b'], description:'x: y z'});
  assert.equal(setFrontmatterField(md, 'skills', ['x:y','b']), md.replace('skills:\r\n  - "a,b"', 'skills: ["x:y","b"]'));
  assert.throws(() => parseFrontmatter(md.replace('name: a','name: a\nname: b')), /duplicated/);
});

test('Три назначения приходят на границу вызова под фактическими именами полей', t => {
  const {root, env, charter, put, run} = fixture(t);
  delete env.BEERPOWERS_SESSION_MODELS_JSON;
  const missing = run(['database','--effort','medium'],'Исправь индекс на колонке');
  assert.equal(missing.status,1);
  assert.equal(missing.stdout,'');
  assert.match(missing.stderr,/Нет BEERPOWERS_SESSION_MODELS_JSON/);
  env.BEERPOWERS_SESSION_MODELS_JSON = JSON.stringify(inventory);
  const implementation = run(['database','--effort','medium'],'Исправь индекс на колонке');
  assert.equal(implementation.status,0,implementation.stderr);
  assert.match(JSON.parse(implementation.stdout).message,/локальные гейты.*каталог запуска, точную команду, проверенную ревизию.*код выхода и результат/);
  for (const [task, role, name, model, effort] of [
    ['Перепроверить снимки после фикса','tester','testing-agent','gpt-6.2-sol','medium'],
    ['Выбрать границу блока между слоями','architect','architect-agent','gpt-6.2-astra','xhigh'],
    ['Спроектировать очередь без тихой потери заявок','architect','architect-agent','gpt-6.2-astra','max'],
  ]) {
    const r = run([role, '--effort', effort, '--path', 'app/file.ts'], task);
    assert.equal(r.status, 0, r.stderr);
    const {message, ...args} = JSON.parse(r.stdout);
    assert.deepEqual(args, {task_name:name.replaceAll('-', '_'), fork_turns:'none', model, reasoning_effort:effort});
    for (const text of [task, 'роль проекта', 'read:' + role, 'fixture instruction', 'FILE .codex/rules/demo.md']) assert.ok(message.includes(text), text);
    assert.equal(message.includes('personal:' + role), role !== 'tester');
    assert.match(r.stderr, /\[purple\]/);
  }
  put('memory/commands/second.md', 'Явно названная памятка');
  put('.codex/team-charter.md', charter.replace('`memory/project/database.md`','`memory/project/database.md`, `memory/commands/second.md` (при работе над вторым контуром)'));
  const db = rolePacket(root,'demo','memory/commands/demo.md','database', ['other/path'],env);
  assert.match(db.body,/Явно названная памятка/);
  assert.equal(db.fields.name,'database-agent'); assert.ok(db.files.includes('.codex/agent-memory/database/MEMORY.md'));
  assert.ok(!db.files.includes('.codex/rules/demo.md'));
  assert.ok(!db.files.some(v => /tester|testing/.test(v)));
  assert.throws(() => rolePacket(root,'demo','memory/commands/demo.md','db',[],env));
  assert.throws(() => rolePacket(root,'demo','memory/commands/demo.md','testing-agent',[],env));
  assert.equal(run(['tester','--effort','max'],'Проверка').status,1);
  put('.codex/team-charter.md', charter.replace('|---|---|---|\n\n', '|---|---|---|\n| architect | gpt-6.2-sol | правило проекта |\n\n'));
  assert.equal(JSON.parse(run(['architect','--effort','medium'],'Задача').stdout).model,'gpt-6.2-sol');
  assert.equal(JSON.parse(run(['architect','--effort','medium','--model','gpt-6.2-astra'],'Задача').stdout).model,'gpt-6.2-astra');
  put('.codex/team-charter.md', charter + '\n| Роль | Модель | Причина |\n|---|---|---|\n| gpt-6.2-astra | gpt-6.2-sol | имя пользователя имеет приоритет |');
  assert.equal(JSON.parse(run(['architect','--effort','medium','--model','gpt-6.2-astra'],'Задача').stdout).model,'gpt-6.2-astra');
  assert.equal(run(['architect','--effort','medium','--model','missing'],'Задача').stdout,'');
  put('.codex/team-charter.md', charter + '\n| Роль | Модель | Причина |\n|---|---|---|\n| opus | gpt-6.2-astra | старая запись |');
  assert.equal(run(['architect','--effort','medium','--model','opus'],'Задача').status,1);
  const brief = '.codex/agents/database-agent.md';
  let custom = readFileSync(join(root, brief),'utf8');
  for (const [key,value] of Object.entries({name:'storage-owner', color:'cyan', memory:'local',
    project_skills:{demo:[]}})) custom = setFrontmatterField(custom, key, value);
  put(brief, custom); put('.codex/agent-memory-local/database/MEMORY.md','локальное правило данных');
  const alternate = run(['database','--effort','medium'],'Проверь запись');
  assert.equal(alternate.status,0,alternate.stderr);
  const fields = JSON.parse(alternate.stdout);
  assert.equal(fields.task_name,'storage_owner');
  assert.match(alternate.stderr,/storage-owner \[cyan\]/);
  assert.ok(fields.message.includes('локальное правило данных'));
  assert.ok(!fields.message.includes('personal:database') && !fields.message.includes('fixture instruction'));
  put(brief,setFrontmatterField(custom,'name','testing-agent'));
  assert.equal(run(['check','demo']).status,1);
  env.BEERPOWERS_SESSION_SKILLS_JSON = '[]';
  const noSkill = run(['tester','--effort','medium'],'Постановка');
  assert.equal(noSkill.status,1); assert.match(noSkill.stderr,/Недоступны назначенные навыки: sample/);
  const partial = run(['tester','--effort','medium','--without-skill','sample'],'Постановка');
  assert.equal(partial.status,0,partial.stderr);
  assert.match(partial.stdout,/явно согласовал работу без навыков: sample/);
  assert.ok(!partial.stdout.includes('fixture instruction'));
  const tester = '.codex/agents/testing-agent.md', oldBrowser = 'mcp__Claude_Browser__navigate';
  put(tester,setFrontmatterField(readFileSync(join(root,tester),'utf8'),'tools',['Read',oldBrowser]));
  env.BEERPOWERS_SESSION_TOOLS_JSON = '["mcp__cua_repl__js"]';
  const browser = run(['tester','--effort','medium','--without-skill','sample','--need-tool',oldBrowser],'Проверить UI');
  assert.equal(browser.status,1); assert.ok(browser.stderr.includes(oldBrowser));
});

test('beerpowers:reference читает доставленные с пакетом справочники из внешнего workspace', t => {
  const {root, charter, put, env} = fixture(t);
  const installed = mkdtempSync(join(tmpdir(), 'beerpowers-reference-'));
  t.after(() => rmSync(installed, {recursive:true, force:true}));
  cpSync(join(pkg, 'bin'), join(installed, 'bin'), {recursive:true});
  const dir = join(installed, 'reference');
  mkdirSync(join(dir, 'ui'), {recursive:true});
  const ns = 'beerpowers:reference';
  const label = ns + '/ui/new-guide.md';
  const cli = (name, args) => spawnSync(process.execPath, [join(installed, 'bin', name), ...args], {cwd:root, env, encoding:'utf8'});
  const read = target => cli('role-files.mjs', ['Read', target]);
  const empty = read(ns);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '');
  writeFileSync(join(dir, 'ui/new-guide.md'), 'Документ поставки\n');
  writeFileSync(join(dir, 'internal.txt'), 'другой формат');
  symlinkSync(join(root, 'memory'), join(dir, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  put('reference/ui/new-guide.md', 'Документ проекта');
  const index = read(ns);
  assert.equal(index.status, 0, index.stderr);
  assert.deepEqual(index.stdout.trim().split(/\r?\n/), [label]);
  assert.equal(read(label).stdout, 'Документ поставки\n');
  assert.equal(read(label + '#проверки').stdout, 'Документ поставки\n');
  assert.equal(read('reference/ui/new-guide.md').stdout, 'Документ проекта');
  const doc = 'memory/обычная заметка.md', href = 'reference/ui/new-guide.md';
  const marked = '[Новый справочник](' + href + ' "' + label + '#проверки")';
  const missingLink = '[Другой](' + href + ' "' + ns + '/missing.md")';
  const workspaceLink = '[Проект](' + href + ')';
  const examples = ['~~~md', marked, '~~~', '`' + marked + '`', '<!-- ' + marked + ' -->'].join('\r\n');
  const note = [marked, missingLink, workspaceLink, examples].join('\r\n');
  put(doc, note);
  const view = read(doc);
  assert.equal(view.status, 0, view.stderr);
  assert.equal(view.stdout, ['[Новый справочник](' + label + '#проверки)', '[Другой](' + ns + '/missing.md)', workspaceLink, examples].join('\r\n'));
  assert.equal(readFileSync(join(root,doc),'utf8'), note);
  assert.equal(read(marked).stdout, 'Документ поставки\n');
  assert.equal(read('[Новый справочник](' + label + '#проверки)').stdout, 'Документ поставки\n');
  const standalone = spawnSync(process.execPath, [join(installed,'bin/role-files.mjs'), 'Read', marked], {cwd:installed, env, encoding:'utf8'});
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.equal(standalone.stdout, 'Документ поставки\n');
  assert.notEqual(read(missingLink).status, 0);
  for (const name of ['missing.md', 'internal.txt', 'external/MEMORY.md', '../bin/role-files.mjs']) {
    assert.notEqual(read(ns + '/' + name).status, 0, name);
  }
  const packet = () => cli('role-launch.mjs', ['packet','demo','memory/commands/demo.md','tester']);
  const withReading = list => put('.codex/team-charter.md', charter.replace('`memory/project/tester.md`', list));
  put('memory/commands/demo.md', note);
  const ordinary = packet();
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.ok(ordinary.stdout.includes(view.stdout));
  assert.ok(!ordinary.stdout.includes('FILE ' + ns + '/') && !ordinary.stdout.includes('Документ поставки'));
  withReading('[Правила](' + label + '#проверки), `' + ns + '/optional.md` (при наличии)');
  const result = packet();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('FILE ' + label + ' sha256='));
  assert.match(result.stdout, /sha256=[0-9a-f]{64}\nДокумент поставки/);
  withReading('[Правила](reference/ui/new-guide.md#проверки "' + label + '#проверки"), [Память](memory/project/tester.md "Проект")');
  const dual = packet();
  assert.equal(dual.status, 0, dual.stderr);
  assert.ok(dual.stdout.includes('FILE ' + label + ' sha256='));
  assert.ok(dual.stdout.includes('FILE memory/project/tester.md sha256='));
  withReading(label + ', `' + label + '`');
  assert.equal(packet().stdout.split('FILE ' + label + ' sha256=').length, 2);
  withReading('`' + ns + '/missing.md`');
  const missing = packet();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing\.md/);
});

test('Привязанный ID передаёт YAML tools в зарегистрированный PreToolUse', t => {
  const {root, put, run} = fixture(t);
  const id = 'returned-by-host-fixture';
  const bind = run(['bind','architect', id]); assert.equal(bind.status,0,bind.stderr);
  assert.match(bind.stdout, /Read 'beerpowers:reference'/);
  const registration = JSON.parse(readFileSync(join(pkg,'hooks/hooks.json'))).hooks.PreToolUse;
  const perl = process.env.BEERPOWERS_PERL ?? (process.platform === 'win32'
    ? join(dirname(dirname(execFileSync('where.exe', ['git.exe'], {encoding:'utf8'}).split(/\r?\n/)[0])), 'usr/bin/perl.exe') : 'perl');
  function event(tool_name, agent_id = id, tool_input = {}) {
    assert.ok(registration.some(row => new RegExp(row.matcher).test(tool_name)));
    const r = spawnSync(perl,[join(pkg,'hooks/dispatch.pl')],{cwd:root,encoding:'utf8',
      input:JSON.stringify({hook_event_name:'PreToolUse',agent_id,session_id:'fixture-session',tool_name,cwd:root,tool_input})});
    assert.equal(r.status,0,r.stderr); return r.stdout ? JSON.parse(r.stdout) : {};
  }
  assert.equal(event('Read').hookSpecificOutput, undefined);
  assert.equal(event('collaboration.send_message').hookSpecificOutput, undefined);
  assert.equal(event('Bash').hookSpecificOutput.permissionDecision,'deny');
  assert.equal(event('functions.exec').hookSpecificOutput.permissionDecision,'deny');
  assert.equal(event('functions.exec', id, {code:'text(await tools.exec_command({"cmd":"pwd"}))'}).hookSpecificOutput.permissionDecision,'deny');
  assert.equal(event('Write','unrelated').hookSpecificOutput,undefined);
  const file = '.codex/agents/architect-agent.md';
  put(file,setFrontmatterField(readFileSync(join(root,file),'utf8'),'tools',['Bash']));
  assert.equal(run(['bind','architect','other-id']).status,0);
  const literal = 'text(await tools.exec_command({"cmd":"pwd"}))';
  assert.notEqual(event('functions.exec','other-id',{code:literal}).hookSpecificOutput?.permissionDecision,'deny');
  assert.equal(event('functions.exec','other-id',{code:literal + ';text(1)'}).hookSpecificOutput.permissionDecision,'deny');
  put(file,setFrontmatterField(readFileSync(join(root,file),'utf8'),'tools',['Read','Grep','Glob','WebSearch']));
  assert.equal(run(['bind','architect','reader-id']).status,0);
  const inner = (tool, input) => ({code:'text(await tools.' + tool + '(' + JSON.stringify(input) + '))'});
  const reader = readerCommand();
  const grepOnly = reader + " Grep 'memory/project' 'database'";
  assert.equal(event('functions.exec',id,inner('exec_command',{cmd:grepOnly,login:false})).hookSpecificOutput.permissionDecision,'deny');
  for (const [args, expected] of [
    ["Read 'memory/project/architect.md'", /read:architect/],
    ["Read 'beerpowers:reference/git-flow.md#qa-чеклист'", /QA-чеклист/],
    [`Read '[Проверки Node](../reference/node-runtime.md "beerpowers:reference/node-runtime.md")'`, /Node/],
    ["Grep 'memory/project' 'read:database'", /memory\/project\/database.md:1:read:database/],
    ["Glob 'memory' 'project/*.md'", /memory\/project\/architect.md/],
  ]) {
    const cmd = reader + ' ' + args;
    assert.notEqual(event('functions.exec','reader-id',inner('exec_command',{cmd,login:false})).hookSpecificOutput?.permissionDecision,'deny', cmd);
    const output = process.platform === 'win32' ? execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{cwd:root})
      : execFileSync('/bin/sh',['-c',cmd],{cwd:root});
    assert.match(output.toString(),expected);
  }
  const good = reader + " Read 'memory/project/architect.md'";
  for (const opts of [{cmd:good+'; pwd'}, {cmd:good,shell:'other'}, {cmd:good,workdir:'other'}, {cmd:good,sandbox_permissions:'require_escalated'}]) {
    assert.equal(event('functions.exec','reader-id',inner('exec_command',opts)).hookSpecificOutput.permissionDecision,'deny');
  }
  const readerBin = join(pkg,'bin/role-files.mjs');
  for (const hidden of ['../outside','.git/config','nested/.claude/settings.local.json']) {
    assert.notEqual(spawnSync(process.execPath,[readerBin,'Read',hidden],{cwd:root}).status,0);
  }
  const search = {search_query:[{q:'Тест'}]}, open = {open:[{ref_id:'https://example.invalid/'}]};
  assert.notEqual(event('functions.exec','reader-id',inner('web__run',search)).hookSpecificOutput?.permissionDecision,'deny');
  for (const request of [open,{...search,...open},{finance:[{}]}]) {
    assert.equal(event('functions.exec','reader-id',inner('web__run',request)).hookSpecificOutput.permissionDecision,'deny');
  }
  put(file,setFrontmatterField(readFileSync(join(root,file),'utf8'),'tools',['WebFetch']));
  assert.equal(run(['bind','architect','fetch-id']).status,0);
  assert.notEqual(event('functions.exec','fetch-id',inner('web__run',open)).hookSpecificOutput?.permissionDecision,'deny');
  assert.equal(event('functions.exec','fetch-id',inner('web__run',search)).hookSpecificOutput.permissionDecision,'deny');
});

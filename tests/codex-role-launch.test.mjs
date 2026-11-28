import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    '', '| Роль | Модель | Причина |','|---|---|---|','| opus | gpt-6.2-astra | политика |','| sonnet | gpt-6.2-sol | политика |',
    '', '```','## Состав','| Роль | Read on spawn |','|---|---|','| fake | секрет |','```'].join('\n');
  put('.codex/team-charter.md', charter);
  put('.codex/workspace.json', '{}'); put('projects/demo/.git', 'synthetic\n');
  put('memory/commands/demo.md', 'guide'); put('memory/MEMORY.md', '# index');
  put('.codex/rules/demo.md', '---\npaths:\n  - "projects/demo/app/**"\n---\ndomain\n');
  for (const [role, name] of Object.entries(roles)) {
    put('.codex/agents/' + name + '.md', ['---', 'name: ' + name, 'description: >-', '  роль', '  проекта', 'color: purple',
      'tools: [Read, SendMessage, Skill]', 'skills:\n  - sample', 'model: ' + (role === 'tester' ? 'sonnet' : 'opus'),
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
  put('.codex/team-charter.md', charter.replace('| opus |','| architect | gpt-6.2-sol | правило проекта |\n| opus |'));
  assert.equal(JSON.parse(run(['architect','--effort','medium'],'Задача').stdout).model,'gpt-6.2-sol');
  assert.equal(JSON.parse(run(['architect','--effort','medium','--model','gpt-6.2-astra'],'Задача').stdout).model,'gpt-6.2-astra');
  put('.codex/team-charter.md', charter + '\n| Роль | Модель | Причина |\n|---|---|---|\n| gpt-6.2-astra | gpt-6.2-sol | имя пользователя имеет приоритет |');
  assert.equal(JSON.parse(run(['architect','--effort','medium','--model','gpt-6.2-astra'],'Задача').stdout).model,'gpt-6.2-astra');
  assert.equal(run(['architect','--effort','medium','--model','missing'],'Задача').stdout,'');
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

test('Привязанный ID передаёт YAML tools в зарегистрированный PreToolUse', t => {
  const {root, put, run} = fixture(t);
  const id = 'returned-by-host-fixture';
  const bind = run(['bind','architect', id]); assert.equal(bind.status,0,bind.stderr);
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

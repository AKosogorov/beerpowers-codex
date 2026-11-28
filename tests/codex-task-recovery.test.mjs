import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const handler = fileURLToPath(new URL('../plugins/beerpowers/bin/workspace.pl', import.meta.url));
const journal = '.git/beerpowers-task-start-7.json';
const first = 'winter-route', second = 'dependent-form';
const brief = {class:'lean',statement:'Show the order date.',scope:'One field.',reason:'Existing screen.',
  acceptance:'Visible date.',forks:'None.',stops:'Schema change.'};

function fixture(t) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'beerpowers-recovery-')));
  const root = path.join(temp, 'outer workspace');
  const repo = path.join(root, 'projects/api');
  fs.mkdirSync(repo,{recursive:true});
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(temp)),fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:4});
  });
  const env = {...process.env, GIT_CONFIG_GLOBAL:path.join(temp,'empty.gitconfig'), GIT_CONFIG_NOSYSTEM:'1',
    GIT_ALLOW_PROTOCOL:'file', GIT_TERMINAL_PROMPT:'0', GIT_AUTHOR_NAME:'Fixture', GIT_COMMITTER_NAME:'Fixture',
    GIT_AUTHOR_EMAIL:'fixture@example.invalid', GIT_COMMITTER_EMAIL:'fixture@example.invalid',
    BEERPOWERS_NODE:process.execPath, BEERPOWERS_TASK_JSON:JSON.stringify(brief),
    BEERPOWERS_TESTS_JSON:JSON.stringify({api:{command:'git diff --check',source:'README.md',profile:'dev-default'}}),
    BEERPOWERS_GIT_TASKS:JSON.stringify({[first]:{repos:['api']},[second]:{repos:['api'],bases:{api:first},dependencies:[first]}})};
  let perl = process.env.BEERPOWERS_PERL || 'perl';
  if (!process.env.BEERPOWERS_PERL && process.platform === 'win32') {
    perl = execFileSync('where.exe',['git.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)
      .map(file=>path.resolve(path.dirname(file),'../usr/bin/perl.exe')).find(file=>fs.existsSync(file));
    assert.ok(perl,'Git for Windows Perl');
  }
  const git = (cwd,...args) => execFileSync('git',['-C',cwd,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const call = (...args) => spawnSync(perl,[handler,...args],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:90000});
  const pass = (...args) => { const r=call(...args); assert.equal(r.status,0,r.stderr || r.error?.message); return r.stdout; };
  const reject = (pattern,...args) => { const r=call(...args); assert.notEqual(r.status,0); assert.match(r.stderr,pattern); };
  const put = (name,data) => {
    const file = path.join(root,name);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,data);
  };
  const read = name => fs.readFileSync(path.join(root,name),'utf8');
  const exists = name => fs.existsSync(path.join(root,name));
  git(root,'init','-qb','workspace');
  git(repo,'init','-qb','dev');
  put('projects/api/README.md','Run git diff --check.\n');
  git(repo,'add','README.md'); git(repo,'commit','-qm','seed');
  git(repo,'branch','main');
  git(repo,'switch','-qc','release/winter');
  put('projects/api/release.txt','Winter release.\n');
  git(repo,'add','release.txt'); git(repo,'commit','-qm','release only');
  const release = git(repo,'rev-parse','HEAD');
  git(repo,'switch','-q','dev');
  const origin = path.join(temp,'origin.git');
  git(repo,'clone','-q','--bare','.',origin);
  git(repo,'remote','add','origin',origin);
  pass('apply');
  put('.codex/bin/worktree-setup.mjs',[
    "import fs from 'node:fs';", "import path from 'node:path';",
    "const p = path.join(process.env.WORKSPACE_ROOT,'.git');",
    "fs.appendFileSync(path.join(p,'fixture-hooks.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');",
    "if (fs.existsSync(path.join(p,'fixture-block-setup'))) process.exit(2);",
  ].join('\n'));
  git(root,'add','.'); git(root,'commit','-qm','configured');
  return {root,repo,release,git,pass,reject,exists,read,put,head:git(root,'rev-parse','HEAD')};
}

test('Perl entry retries a failed artifact commit and preserves manual preflight edits',t=>{
  const f = fixture(t);
  const args = ['task-start',first,'--worktree'];
  const hook = '.git/hooks/pre-commit';
  f.put(hook,'#!/bin/sh\nexit 3\n');
  fs.chmodSync(path.join(f.root,hook),0o755);
  f.reject(/commit failed/i,...args);
  const preflight = 'memory/tasks/' + first + '/preflight.md';
  const prepared = f.read(preflight);
  assert.ok(f.exists(journal));
  assert.equal(f.git(f.root,'rev-parse','HEAD'),f.head);
  fs.unlinkSync(path.join(f.root,hook));
  f.put(preflight,prepared + 'Manual clarification.\n');
  f.reject(/artifact changed|manual edit/i,...args);
  assert.equal(f.read(preflight),prepared + 'Manual clarification.\n');
  assert.equal(f.git(f.root,'rev-parse','HEAD'),f.head);
  f.put(preflight,prepared);
  f.pass(...args);
  assert.equal(f.git(f.root,'rev-parse','HEAD^'),f.head);
  assert.equal(f.git(f.root,'status','--porcelain'),'');
  assert.equal(f.exists(journal),false);
  assert.equal(f.read('.git/fixture-hooks.jsonl').trim().split('\n').length,1);
});

test('two release tasks recover after failed setup, preserving dependency base and literal hook tail',t=>{
  const f = fixture(t);
  const tail = ['--mode','name with spaces','$literal'];
  const args = [first + '@release/winter',second,'--','--no-deps',...tail];
  f.pass('task-plan',...args);
  assert.equal(f.git(f.repo,'branch','--show-current'),'dev');
  assert.equal(f.exists('memory/tasks/' + first),false);
  f.put('.git/fixture-block-setup','block fixture hook once\n');
  f.reject(/worktree-setup.*failed/i,'task-start',...args);
  assert.ok(f.exists(journal));
  assert.equal(f.git(f.root,'rev-parse','HEAD'),f.head);
  fs.unlinkSync(path.join(f.root,'.git/fixture-block-setup'));
  f.pass('task-start',...args);
  assert.equal(f.exists(journal),false);
  assert.equal(f.git(f.root,'rev-parse','HEAD^'),f.head);
  const resolver = path.join(path.dirname(handler),'git-workspace.mjs');
  const records = [first,second].map(code=>JSON.parse(execFileSync(process.execPath,[resolver,'resolve',code,'api'],{cwd:f.root})));
  assert.deepEqual(records.map(r=>r.base),['release/winter',first]);
  for (const [i,code] of [first,second].entries()) {
    const r = records[i];
    assert.equal(f.exists('memory/tasks/' + code + '/checkouts.json'),false);
    assert.equal(r.baseSha,f.release);
    assert.equal(f.git(path.join(f.root,r.checkout),'branch','--show-current'),code);
    assert.equal(f.git(path.join(f.root,r.checkout),'rev-parse','HEAD'),f.release);
  }
  assert.match(f.read('memory/tasks/' + second + '/git-flow.md'),/## Зависимости[\s\S]*winter-route/);
  const argsLog = f.read('.git/fixture-hooks.jsonl').trim().split('\n').map(s=>JSON.parse(s));
  const expected = [second,'api',path.join(f.root,records[1].checkout),...tail];
  assert.deepEqual(argsLog,[expected,expected]);
  assert.equal(f.git(f.root,'status','--porcelain'),'');
});

test('unavailable local origin blocks preparation before branches or task artifacts',t=>{
  const f = fixture(t);
  f.git(f.repo,'remote','set-url','origin',path.join(f.root,'.git','nonexistent-bare'));
  f.reject(/ls-remote failed|Cannot resolve origin/i,'task-start',first,'--worktree');
  assert.equal(f.git(f.repo,'branch','--show-current'),'dev');
  assert.equal(f.git(f.repo,'branch','--list',first),'');
  assert.equal(f.git(f.root,'rev-parse','HEAD'),f.head);
  assert.equal(f.exists('memory/tasks/' + first),false);
  assert.equal(f.exists(journal),false);
});

test('reviewed lean resume distinguishes missing, pending and delivered QA', t => {
  const f = fixture(t);
  f.pass('task-start', first);
  const base = f.git(f.repo, 'rev-parse', 'HEAD');
  f.put('projects/api/README.md', 'Show the date in the order form.\n');
  f.git(f.repo, 'commit', '-am', 'implement and test order date');
  const head = f.git(f.repo, 'rev-parse', 'HEAD');
  const dir = 'memory/tasks/' + first;
  const file = `${dir}/${first}-qa.html`;
  const reports = [`Full run: ${head} exit=0\n`, `APPROVED ${head}\n`];
  f.put(`${dir}/test-cases.md`, reports[0]);
  f.put(`${dir}/review-report.md`, reports[1]);
  const qa = fileURLToPath(new URL('../plugins/beerpowers/bin/qa-checklist.mjs', import.meta.url));
  const resume = () => {
    assert.match(f.pass('task-start', first), /Resume existing lean task \(read only\)/);
    assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(f.read(`${dir}/test-cases.md`), reports[0]);
    assert.equal(f.read(`${dir}/review-report.md`), reports[1]);
    const result = spawnSync(process.execPath, [qa, '--status', first], {cwd: f.root, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(resume().status, 'missing');
  assert.equal(f.exists(file), false, 'resume is read only');

  const draft = {title: 'Order date', reason: 'Visible date', revisions: {api: head}, data: 'Existing order',
    limits: 'One screen', cases: [{screen: 'Order', tag: 'новое', action: 'Open', expected: 'Visible date'}]};
  const generated = spawnSync(process.execPath, [qa, first], {cwd: f.root, encoding: 'utf8', input: JSON.stringify(draft)});
  assert.equal(generated.status, 0, generated.stderr);
  const page = f.read(file);
  assert.ok(page.includes(head));
  assert.ok(!page.includes(base));
  assert.equal(resume().status, 'pending');

  const digest = createHash('sha256').update(page).digest('hex');
  const handover = `## QA\n\nQA delivered: ${digest} fixture-comment-12\n`;
  f.put(`${dir}/handover.md`, `Possibly delivered.\n\n\`\`\`markdown\n${handover}\`\`\`\n`);
  assert.equal(resume().status, 'pending');
  f.put(`${dir}/handover.md`, handover);
  assert.deepEqual(resume(), {status: 'delivered', file, revisions: {api: head}, digest, operation: 'fixture-comment-12'});
  assert.equal(f.read(file), page);
  assert.equal(f.read(`${dir}/handover.md`), handover);
  f.put(`${dir}/handover.md`, handover.replace('fixture-comment-12', 'manual'));
  assert.equal(resume().operation, 'manual');

  f.put(file, page.replace(/(· [0-9a-f]+ · )[^<]+/, '$1localized diffstat'));
  assert.equal(resume().status, 'pending');
  f.put(file, page.replace(head, base));
  assert.equal(resume().status, 'stale');
});

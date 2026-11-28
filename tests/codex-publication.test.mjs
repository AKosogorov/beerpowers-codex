import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const cli = fileURLToPath(new URL('../plugins/beerpowers/bin/publication.mjs', import.meta.url));
const task = 'SHOP-41';
const repo = 'product';
const brief = '# SHOP-41\n\nКласс: bug. fixture\n';
const request = {
  account: 'fixture-author', summary: 'Покажи дату заказа', deploy: 'Действий нет.', reason: 'Оператор сверяет день покупки.',
  changes: 'В карточку добавлена дата.', tested: 'Регрессионный тест карточки.',
  unverified: 'Внешний аккаунт.', extra: 'Нет.',
};
const hash = value => createHash('sha256').update(value).digest('hex');
function qa(f, revisions = { [repo]: f.head }) {
  const cli = fileURLToPath(new URL('../plugins/beerpowers/bin/qa-checklist.mjs', import.meta.url));
  return spawnSync(process.execPath,[cli,task],{cwd:f.root,env:f.env,encoding:'utf8',input:JSON.stringify({
    title:'QA <draft>', reason:'Общий сценарий покупки', revisions, data:'Тестовый заказ',
    limits:'Только тестовый аккаунт', cases:[{screen:'Заказ', tag:'критично', action:'Открыть', expected:'Видна дата'}]
  })});
}
test('tester delivers the same offline checklist after resume only at the final approved revision', t => {
  const f = fixture(t);
  const file = path.join(f.root,'memory/tasks',task,task + '-qa.html');
  f.put('review-report.md','NOT APPROVED ' + f.head);
  assert.notEqual(qa(f).status,0);
  assert.equal(fs.existsSync(file),false);
  f.put('preflight.md',brief.replace('bug.','trivial.'));
  assert.equal(JSON.parse(qa(f).stdout).reason,'trivial');
  assert.equal(fs.existsSync(file),false);
  f.put('preflight.md',brief);
  f.put('review-report.md','APPROVED ' + f.head);
  assert.notEqual(qa(f,{[repo]:f.base}).status,0);
  const result = qa(f);
  assert.equal(result.status,0,result.stderr);
  const page = fs.readFileSync(file,'utf8');
  assert.ok(page.includes(f.head) && page.includes('QA &lt;draft&gt;'));
  for (const text of ['Ожидается:','Сбросить','Прогресс','Тестовые данные','Известные ограничения','Сообщить о дефекте']) assert.ok(page.includes(text));
  const storage = new Map();
  const load = () => {
    const box = {}, output = {}, button = {};
    runInNewContext(page.match(/<script>([\s\S]+?)<\/script>/)[1],{
      document:{querySelectorAll:() => [box],querySelector:key => key === 'output' ? output : button},
      localStorage:{getItem:key => storage.get(key),setItem:(key,value) => storage.set(key,value)}
    });
    return {box,output,button};
  };
  const first = load();
  assert.equal(first.output.textContent,'0 / 1');
  first.box.checked = true;
  first.box.onchange();
  const again = load();
  assert.equal(again.output.textContent,'1 / 1');
  again.button.onclick();
  assert.equal(load().output.textContent,'0 / 1');
  f.put('handover.md','## Пауза\nЧеклист подготовлен, ожидание передачи.');
  assert.equal(JSON.parse(qa(f).stdout).status,'unchanged');
  assert.equal(fs.readFileSync(file,'utf8'),page);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beerpowers-publication-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(dir)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(dir, { recursive: true });
  });
  const root = path.join(dir, 'workspace');
  const origin = path.join(dir, 'origin.git');
  const product = path.join(root, 'projects', repo);
  const evidence = path.join(root, 'memory', 'tasks', task);
  const code = path.join(product, 'code.txt');
  for (const d of [evidence, path.join(root, '.codex'), product]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, BEERPOWERS_MODEL: 'gpt-6.2-sol', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore','pipe','pipe'] }).trim();
  git(root, 'init', '-b', 'main');
  git(product, 'init', '-b', 'main');
  fs.writeFileSync(code, 'initial\n');
  git(product, 'add', 'code.txt');
  git(product, 'commit', '-m', 'initial');
  const base = git(product, 'rev-parse', 'HEAD');
  git(dir, 'clone', '--bare', product, origin);
  git(product, 'remote', 'add', 'origin', origin);
  git(product, 'fetch', 'origin');
  git(product, 'remote', 'set-head', 'origin', 'main');
  git(product, 'switch', '-c', task);
  fs.writeFileSync(code, 'updated\n');
  git(product, 'commit', '-am', 'updated');
  const head = git(product, 'rev-parse', 'HEAD');
  const put = (file, data) => fs.writeFileSync(path.join(evidence, file), data);
  put('preflight.md', brief);
  put('test-cases.md', `Full run: ${head} exit=0\n`);
  put('review-report.md', `APPROVED ${head}\n`);
  fs.writeFileSync(path.join(root, '.gitignore'), '/projects/\n/worktrees/\n/.codex/git-settings.local.json\n/.codex/.cache/\n');
  fs.writeFileSync(path.join(root, '.codex', 'workspace.json'), JSON.stringify({ schemaVersion: 1, beerpowers: '0.6.0' }));
  fs.writeFileSync(path.join(root, '.codex', 'git-settings.json'), JSON.stringify({ repos: { [repo]: 'main-default' }, removeSourceBranch: true }));
  const privateFile = path.join(root, '.codex', 'git-settings.local.json');
  fs.writeFileSync(privateFile, JSON.stringify({ reviewers: { [repo]: ['tester'] } }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'prepared');
  function run(provider, input = {}, extraArgs = [], indent) {
    return spawnSync(process.execPath, [cli, 'prepare', task, repo, ...extraArgs], { cwd: root, env, encoding: 'utf8',
      input: JSON.stringify({ ...request, fixture: { provider, project: provider === 'github' ? 'team/app' : 'group/team/app' }, ...input }, null, indent) });
  }
  return { root, product, origin, privateFile, put, git, head, base, code, run, env };
}

async function stub(t) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, path: req.url, contentType: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"number":7,"iid":7}');
  });
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { received, origin: `http://127.0.0.1:${server.address().port}` };
}

test('local bare origin and local HTTP stubs accept provider-specific reviewed requests', async t => {
  const f = fixture(t);
  const api = await stub(t);
  for (const provider of ['gitlab', 'github']) {
    const input = provider === 'gitlab' ? { gitlab: { iid: 7, assigneeId: 10, reviewerIds: { tester: 11 } } } :
      { deploy: '1. Открыть [инструкцию](doc/run.md).\n2. Применить миграцию.' };
    const r = f.run(provider, input);
    assert.equal(r.status, 0, r.stderr);
    const preview = JSON.parse(r.stdout);
    assert.equal(preview.status, 'prepared');
    const confirmed = f.run(provider, input, ['--confirm', preview.digest]);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const plan = JSON.parse(confirmed.stdout);
    assert.deepEqual(plan, { ...preview, status: 'confirmed' });
    assert.equal(plan.sourceSha, f.head);
    assert.equal(plan.targetSha, f.base);
    assert.equal(plan.target, 'main');
    assert.equal(plan.source, task);
    assert.deepEqual(plan.reviewers, ['tester']);
    assert(plan.description.startsWith('## Для выкладки на стенд\n'));
    assert.match(plan.signature, /\(gpt-6\.2-sol\)$/);
    assert(plan.description.endsWith('\n' + plan.signature));
    assert(plan.pushArgs.includes(`${f.head}:refs/heads/${task}`));
    if (provider === 'gitlab') {
      assert(!plan.pushArgs.includes('merge_request.create'));
      assert(plan.pushArgs.every(arg => !/[\r\n]/.test(arg)));
    } else {
      assert(plan.createArgs.includes('--body-file'));
      assert(plan.createArgs.includes('fixture-author'));
    }
    const { method, path: route, body, headers } = plan.request;
    const res = await fetch(api.origin + route, { method, headers, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    const sent = api.received.at(-1);
    assert.equal(sent.contentType, 'application/json');
    if (provider === 'gitlab') {
      assert.equal(sent.path, '/api/v4/projects/group%2Fteam%2Fapp/merge_requests/7');
      assert.equal(sent.method, 'PUT');
      assert.equal(sent.body.description, plan.description);
      assert.equal(sent.body.target_branch, 'main');
      assert.deepEqual(sent.body.assignee_ids, [10]);
      assert.deepEqual(sent.body.reviewer_ids, [11]);
    } else {
      assert.equal(sent.path, '/repos/team/app/pulls');
      assert.equal(sent.method, 'POST');
      assert.equal(sent.body.body, plan.description);
      assert.equal(sent.body.head, task);
      assert.equal(sent.body.base, 'main');
    }
    const tracker = fileURLToPath(new URL('../plugins/beerpowers/bin/tracker.mjs', import.meta.url));
    const github = provider === 'github';
    const url = github ? 'https://github.com/team/app/pull/7' : 'https://gitlab.invalid/group/team/app/-/merge_requests/7';
    const comments = spawnSync(process.execPath,[tracker,'mr-comments',task,task,url,github ? 'yes' : 'no'],{
      cwd:f.root,env:f.env,encoding:'utf8',input:github ? sent.body.body : sent.body.description
    });
    assert.equal(comments.status,0,comments.stderr);
    assert.deepEqual(JSON.parse(comments.stdout).comments.map(c => c.text),
      github ? ['## Для выкладки на стенд\n\n' + input.deploy] : []);
  }
  assert.equal(f.git(f.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/main');
  assert.equal(f.git(f.root, 'status', '--porcelain'), '');
});

test('explicit draft is provider-specific and both default paths stay ready for review', t => {
  const f = fixture(t);
  const prepare = (provider, extra) => {
    const result = f.run(provider, extra);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const gitlab = prepare('gitlab', { draft: true, summary: 'Draft: Draft: ' + request.summary });
  const title = `Draft: ${task}: ${request.summary}`;
  assert.equal(gitlab.title, title);
  assert.deepEqual(gitlab.pushArgs.filter(o => o.startsWith('merge_request.title=')), ['merge_request.title=' + title]);
  assert.equal(gitlab.request.body.title, title);
  const github = prepare('github', { draft: true });
  assert.equal(github.title, `${task}: ${request.summary}`);
  assert.equal(github.createArgs.filter(arg => arg === '--draft').length, 1);
  assert.equal(github.request.body.draft, true);
  for (const provider of ['gitlab', 'github']) {
    const ordinary = prepare(provider, {});
    const explicit = prepare(provider, { draft: false });
    assert.notEqual(explicit.digest, ordinary.digest);
    assert.deepEqual({ ...explicit, digest: ordinary.digest }, ordinary);
    assert.equal(ordinary.request.body.title, `${task}: ${request.summary}`);
    assert.equal(Object.hasOwn(ordinary.request.body, 'draft'), false);
    assert(!ordinary.createArgs?.includes('--draft'));
    assert.match(f.run(provider, { draft: 'true' }).stderr, /boolean draft/);
  }
  assert.equal(f.git(f.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/main');
});

test('publication confirmation binds JSON bytes, author and destination and keeps the signature on retries', t => {
  const f = fixture(t);
  const input = { draft: true, gitlab: { assigneeId: 10, reviewerIds: { tester: 11 } } };
  const preview = JSON.parse(f.run('gitlab', input).stdout);
  assert(!preview.initialDescription.includes(preview.signature));
  assert(preview.pushArgs.includes(`merge_request.description=${preview.initialDescription}`));
  assert.deepEqual(JSON.parse(f.run('gitlab', input).stdout), preview);
  const args = ['--confirm', preview.digest];
  const confirmed = f.run('gitlab', input, args);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(f.run('gitlab', input, args).stdout, confirmed.stdout);
  assert.match(f.run('gitlab', input, args, 2).stderr, /digest mismatch/);
  assert.match(f.run('gitlab', { ...input, summary: 'Другой заголовок' }, args).stderr, /digest mismatch/);
  assert.match(f.run('gitlab', { ...input, account: 'different-author' }, args).stderr, /digest mismatch/);
  assert.match(f.run('gitlab', { ...input, gitlab: { ...input.gitlab, iid: 9 } }, args).stderr, /digest mismatch/);
  f.env.BEERPOWERS_MODEL = 'gpt-6.1-terra';
  assert.match(f.run('gitlab', input, args).stderr, /digest mismatch/);
  const anonymous = { account: undefined };
  const draft = JSON.parse(f.run('github', anonymous).stdout);
  assert.match(f.run('github', anonymous, ['--confirm', draft.digest]).stderr, /publication account/);
  f.env.BEERPOWERS_MODEL = 'gpt-6.2-sol';
  const otherOrigin = path.join(path.dirname(f.origin), 'other.git');
  f.git(f.root, 'clone', '--bare', f.origin, otherOrigin);
  f.git(f.product, 'remote', 'set-url', 'origin', otherOrigin);
  assert.match(f.run('gitlab', input, args).stderr, /digest mismatch/);
});

test('stale, failed, ambiguous, dirty and incomplete gates block preparation', t => {
  const f = fixture(t);
  function blocked(regex) {
    const r = f.run('github');
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, regex);
  }
  f.put('review-report.md', `APPROVED ${f.head}\n**NOT APPROVED** для source SHA \`${f.head}\`\n`);
  blocked(/review/i);
  f.put('review-report.md', `APPROVED ${f.head}\nAPPROVED ${f.base}\n`);
  blocked(/review/i);
  f.put('review-report.md', `NOT APPROVED ${f.head}\n~~~text\nAPPROVED ${f.head}\n~~~\n`);
  blocked(/review/i);
  f.put('review-report.md', `APPROVED ${repo} ${f.head}\nNOT APPROVED other ${f.base}\n`);
  f.put('test-cases.md', `Full run: ${repo} ${f.head} exit=1\n`);
  blocked(/full run/i);
  f.put('test-cases.md', `Full run: ${repo} ${f.head} exit=0\n`);
  assert.equal(f.run('github').status, 0);
  fs.writeFileSync(f.code, 'uncommitted');
  blocked(/clean/i);
  f.git(f.product, 'restore', 'code.txt');
  f.put('preflight.md', brief.replace('bug.', 'feature.'));
  blocked(/feature/i);
  f.put('feature-state.json', JSON.stringify({ format: 'beerpowers-feature-1', next: 'final-review', head: f.head }));
  blocked(/feature/i);
});

test('feature publication checks report digests and review range', t => {
  const f = fixture(t);
  const feature = brief.replace('bug.', 'feature.') + `Base-SHA: ${f.base}\n`;
  const reviewed = `APPROVED ${f.head}\n`;
  const tested = `Full run: ${f.head} exit=0\n`;
  f.put('preflight.md', feature);
  f.put('design-brief.md', 'fixture design');
  f.put('early-review.md', 'fixture source review');
  const state = { format: 'beerpowers-feature-1', next: 'done', head: f.head, base: f.base, brief: hash(feature), mode: 'C', ui: 'no', requires_opponent: 'no',
    history: [{ event: 'final-approve', head: f.head, next: 'done' }],
    observations: {}, reports: { 'design-brief.md': hash('fixture design'), 'early-review.md': hash('fixture source review'),
      'test-cases.md': hash(tested), 'review-report.md': hash(reviewed) } };
  f.put('feature-state.json', JSON.stringify(state));
  assert.equal(f.run('github').status, 0);
  f.put('review-report.md', 'new evidence\n' + reviewed);
  assert.notEqual(f.run('github').status, 0);
});

test('Git worktree and release override select the reviewed product and exact target', t => {
  const f = fixture(t);
  f.git(f.product, 'push', 'origin', `${f.base}:refs/heads/release/next`);
  f.put('git-flow.md', '| Репозиторий | База | Выпуск |\n|---|---|---|\n| product | `release/next` | — |\n');
  f.git(f.product, 'switch', 'main');
  const linked = path.join(f.root, 'worktrees', task, repo);
  f.git(f.product, 'worktree', 'add', linked, task);
  const accepted = f.run('gitlab');
  assert.equal(accepted.status, 0, accepted.stderr);
  const plan = JSON.parse(accepted.stdout);
  assert.equal(plan.checkout, `worktrees/${task}/${repo}`);
  assert.equal(plan.target, 'release/next');
  assert(plan.pushArgs.includes('merge_request.target=release/next'));
  // Simulate another user's movement on the origin without refreshing local tracking refs.
  f.git(f.product, 'push', 'origin', `${f.head}:refs/heads/temp`);
  f.git(f.origin, 'update-ref', 'refs/heads/release/next', f.head, f.base);
  const moved = f.run('gitlab');
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /target moved/i);
});

test('multi-product feature binds the shared brief to the selected product reports and SHA', t => {
  const f = fixture(t);
  const other = 'storefront';
  const otherRepo = path.join(f.root,'projects',other);
  f.git(f.root,'clone',f.origin,otherRepo);
  f.git(otherRepo,'switch','-c',task);
  fs.writeFileSync(path.join(otherRepo,'code.txt'),'independent storefront change\n');
  f.git(otherRepo,'commit','-am','storefront implementation');
  const otherHead = f.git(otherRepo,'rev-parse','HEAD');
  assert.notEqual(f.head,otherHead);
  const feature = brief.replace('bug.', 'feature.') + `Base-SHA ${repo}: ${f.base}\nBase-SHA ${other}: ${f.base}\n`;
  f.put('preflight.md',feature);
  f.put('checkouts.json',JSON.stringify({code:task,repos:[repo,other].map(name => ({
    name,checkout:'projects/' + name,base:'main',baseSha:f.base,
  }))}));
  const selectedFolder = 'repos/' + repo + '/';
  for (const [name,head] of [[repo,f.head],[other,otherHead]]) {
    const prefix = 'repos/' + name + '/';
    fs.mkdirSync(path.join(f.root,'memory/tasks',task,prefix),{recursive:true});
    const docs = {'test-cases.md':`Full run: ${head} exit=0\n`,'review-report.md':`APPROVED ${head}\n`,
      'early-review.md':'early pass in '+name,'design-brief.md':'design for '+name};
    for (const [file,content] of Object.entries(docs)) f.put(prefix + file,content);
    const state = {format:'beerpowers-feature-1',next:'done',head,base:f.base,brief:hash(feature),requires_opponent:'no',
      history:[{event:'final-approve',head,next:'done'}],reports:Object.fromEntries(Object.entries(docs).map(([file,s])=>[file,hash(s)]))};
    f.put(prefix + 'feature-state.json',JSON.stringify(state));
  }
  const ok = f.run('gitlab',{draft:true});
  assert.equal(ok.status,0,ok.stderr);
  assert.notEqual(qa(f).status,0);
  const combined = qa(f,{[repo]:f.head,[other]:otherHead});
  assert.equal(combined.status,0,combined.stderr);
  const page = fs.readFileSync(path.join(f.root,JSON.parse(combined.stdout).file),'utf8');
  assert.ok(page.includes(f.head) && page.includes(otherHead));
  assert.equal(JSON.parse(ok.stdout).sourceSha,f.head);
  const state = JSON.parse(fs.readFileSync(path.join(f.root,'memory/tasks',task,selectedFolder,'feature-state.json'),'utf8'));
  const wrongApproval = `APPROVED ${otherHead}\n`;
  f.put(selectedFolder + 'review-report.md',wrongApproval);
  state.reports['review-report.md'] = hash(wrongApproval);
  f.put(selectedFolder + 'feature-state.json',JSON.stringify(state));
  const rejected = f.run('gitlab',{draft:true});
  assert.notEqual(qa(f,{[repo]:f.head,[other]:otherHead}).status,0);
  assert.notEqual(rejected.status,0);
  assert.match(rejected.stderr,/final review/i);
  f.put(selectedFolder + 'feature-state.json',JSON.stringify({...state,head:otherHead}));
  assert.match(f.run('gitlab').stderr,/stale/i);
});

test('renamed default target blocks a stale local origin/HEAD', t => {
  const f = fixture(t);
  f.git(f.origin, 'update-ref', 'refs/heads/trunk', f.base);
  f.git(f.origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  const stale = f.run('github');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /default target changed/i);
});

test('reviewers require explicit choice and fixture cannot disguise a remote origin', t => {
  const f = fixture(t);
  fs.unlinkSync(f.privateFile);
  assert.match(f.run('github').stderr, /reviewers/i);
  const r = f.run('github', { reviewers: [] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).reviewers, []);
  assert.notEqual(f.run('github', { reviewers: [], deploy: ' ' }).status, 0);
  assert.notEqual(f.run('github', { reviewers: [], summary: 'title\nwrong' }).status, 0);
  assert.notEqual(f.run('github', { reviewers: [], target: 'production' }).status, 0);
  f.git(f.product, 'remote', 'set-url', '--push', 'origin', 'https://github.invalid/example/app.git');
  assert.notEqual(f.run('github', { reviewers: [] }).status, 0);
});

test('squash keeps the approved tree and requires one fix commit per published round', t => {
  const f = fixture(t);
  f.git(f.product, 'commit', '--allow-empty', '-m', 'этап ревью');
  const reviewedSha = f.git(f.product, 'rev-parse', 'HEAD');
  f.put('review-report.md', `APPROVED ${reviewedSha}\n`);
  f.put('test-cases.md', `Full run: ${reviewedSha} exit=0\n`);
  assert.match(f.run('github').stderr, /one task commit/);
  f.git(f.product, 'reset', '--soft', f.base);
  f.git(f.product, 'commit', '-m', 'feat(SHOP-41): добавь дату');
  assert.equal(f.run('github', { reviewedSha }).status, 0);
  f.git(f.product, 'push', 'origin', task);
  fs.writeFileSync(f.code, 'different\n');
  f.git(f.product, 'commit', '-am', 'этап');
  assert.match(f.run('github', { reviewedSha }).stderr, /tree changed/);
  const fixReviewed = f.git(f.product, 'rev-parse', 'HEAD');
  f.put('review-report.md', `APPROVED ${fixReviewed}\n`);
  f.put('test-cases.md', `Full run: ${fixReviewed} exit=0\n`);
  assert.match(f.run('github').stderr, /one fix commit/);
  f.git(f.product, 'commit', '--amend', '-m', 'fix(SHOP-41): исправь дату');
  const round = f.run('github', { reviewedSha: fixReviewed, githubPr: 42 });
  assert.equal(round.status, 0, round.stderr);
  const prepared = JSON.parse(round.stdout);
  assert.equal(prepared.request.method, 'PATCH');
  assert(prepared.request.path.endsWith('/pulls/42'));
  assert.deepEqual(prepared.editArgs.slice(0, 3), ['pr', 'edit', '42']);
  assert.equal(prepared.createArgs, undefined);
});

function operation(f, cliName, ...args) {
  return spawnSync(process.execPath, [path.join(path.dirname(cli), cliName + '-plan.mjs'), repo, ...args],
    { cwd: f.root, env: f.env, encoding: 'utf8' });
}

test('stand rebuild checks missing work, conflict, stale base, archive setting and interrupted push', t => {
  const f = fixture(t);
  f.git(f.product, 'switch', '-c', 'stage', f.base);
  fs.writeFileSync(path.join(f.product, 'kept.txt'), 'keep\n');
  f.git(f.product, 'add', 'kept.txt');
  f.git(f.product, 'commit', '-m', 'feat(KEEP-9): сохрани настройку');
  const kept = f.git(f.product, 'rev-parse', 'HEAD');
  fs.writeFileSync(f.code, 'old stand\n');
  f.git(f.product, 'commit', '-am', 'fix(OLD-12): проверка');
  const old = f.git(f.product, 'rev-parse', 'HEAD');
  f.git(f.product, 'push', 'origin', 'stage');
  const tree = path.join(f.root, 'worktrees', 'chore-stage-rebuild', repo);
  f.git(f.product, 'worktree', 'add', '--detach', tree, f.base);
  f.git(tree, 'cherry-pick', kept);
  f.git(tree, 'cherry-pick', f.head);
  assert.throws(() => f.git(tree, 'cherry-pick', old));
  const plan = () => operation(f, 'stand', 'stage', 'main', old, f.base);
  assert.notEqual(plan().status, 0);
  f.git(tree, 'cherry-pick', '--abort');
  f.git(f.product, 'push', 'origin', f.head + ':refs/heads/main');
  assert.match(plan().stderr, /База/);
  f.git(f.product, 'push', '--force-with-lease', 'origin', f.base + ':refs/heads/main');
  const first = JSON.parse(plan().stdout);
  assert.deepEqual(first.oldTasks, ['KEEP-9', 'OLD-12']);
  assert.deepEqual(first.newTasks, ['KEEP-9']);
  assert.deepEqual(first.missingTasks, ['OLD-12']);
  assert(first.lost.some(s => s.includes(old)));
  assert.equal(first.archiveArgs, null);
  fs.writeFileSync(path.join(f.root, '.codex', 'git-settings.json'), JSON.stringify({standArchive:true}));
  const archive = JSON.parse(plan().stdout);
  f.git(f.product, ...archive.archiveArgs);
  const retry = JSON.parse(plan().stdout);
  assert.equal(retry.archiveArgs, null);
  const clean = () => spawnSync(process.execPath, [path.join(path.dirname(cli), 'workspace-clean'),
    'worktree', 'chore-stage-rebuild', '--no-cache', '--apply'], {cwd:f.root, encoding:'utf8', env:{...f.env, WORKSPACE_ROOT:f.root}});
  assert.notEqual(clean().status, 0);
  assert(fs.existsSync(tree));
  f.git(f.product, ...retry.pushArgs);
  assert.equal(JSON.parse(plan().stdout).alreadyPublished, true);
  assert.equal(f.git(f.origin, 'rev-parse', archive.archiveArgs.at(-1).split(':')[1]), old);
  const cleaned = clean();
  assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
  assert(!fs.existsSync(tree));
});

test('release plans follow server branches and named project instructions', t => {
  const f = fixture(t);
  f.git(f.product, 'push', 'origin', task + ':refs/heads/release/batch');
  let plan = JSON.parse(operation(f, 'release', 'planned', 'release/batch').stdout);
  assert.equal(plan.merge, 'fast-forward');
  f.git(f.product, 'switch', '-c', 'fixture-batch', plan.targetSha);
  f.git(f.product, 'merge', '--ff-only', plan.sourceSha);
  assert.equal(f.git(f.product, 'rev-parse', 'HEAD'), f.head);
  f.git(f.product, 'switch', task);
  const settings = profile => fs.writeFileSync(path.join(f.root, '.codex', 'git-settings.json'),
    JSON.stringify({ repos: { [repo]: profile } }));
  f.git(f.product, 'commit', '--amend', '-m', 'feat(SHOP-41): добавь дату');
  const selected = f.git(f.product, 'rev-parse', 'HEAD');
  f.git(f.product, 'push', 'origin', 'HEAD:refs/heads/dev');
  f.git(f.origin, 'symbolic-ref', 'HEAD', 'refs/heads/dev');
  settings('dev-default');
  plan = JSON.parse(operation(f, 'release', 'planned').stdout);
  assert.equal(plan.merge, 'merge-commit');
  assert.equal(plan.target, 'main');
  f.git(f.product, 'switch', '-c', 'fixture-planned', plan.targetSha);
  f.git(f.product, 'merge', '--no-ff', '-m', 'плановый выпуск', plan.sourceSha);
  assert.equal(f.git(f.product, 'show', '-s', '--format=%P', 'HEAD'), plan.targetSha + ' ' + plan.sourceSha);
  plan = JSON.parse(operation(f, 'release', 'urgent', task, selected).stdout);
  f.git(f.product, 'switch', '-c', plan.source, plan.targetSha);
  f.git(f.product, ...plan.cherryPick);
  assert(f.git(f.product, 'show', '-s', '--format=%B').includes('(cherry picked from commit ' + selected + ')'));
  settings('custom');
  const dir = path.join(f.root, 'memory', 'commands');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'git.md'), '## other\nЧужой порядок\n## product\nВыпуск через QA.\n## next\nИной путь\n');
  assert.equal(JSON.parse(operation(f, 'release', 'planned').stdout).instructions, 'Выпуск через QA.');
});

test('closing restores a clean main checkout and preserves a foreign index', t => {
  const f = fixture(t);
  const restore = () => spawnSync(process.execPath, [path.join(path.dirname(cli), 'restore-checkout.mjs'), repo, task],
    {cwd:f.root, encoding:'utf8', env:f.env});
  fs.writeFileSync(f.code, 'foreign change\n');
  f.git(f.product, 'add', 'code.txt');
  const index = f.git(f.product, 'write-tree');
  assert.notEqual(restore().status, 0);
  assert.equal(f.git(f.product, 'write-tree'), index);
  assert.equal(f.git(f.product, 'branch', '--show-current'), task);
  f.git(f.product, 'restore', '--source=HEAD', '--staged', '--worktree', 'code.txt');
  const restored = restore();
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).head, f.base);
  assert.equal(f.git(f.product, 'branch', '--show-current'), 'main');
  assert.equal(restore().status, 0);
});

test('multi-task stand aligns to a newer base, resumes cherry-pick conflict and publishes both tasks', t => {
  const f = fixture(t);
  f.git(f.product, 'switch', '-c', 'APP-10', f.base);
  fs.writeFileSync(f.code, 'первая задача\n');
  f.git(f.product, 'commit', '-am', 'feat(APP-10): уточни подсказку');
  const firstTask = f.git(f.product, 'rev-parse', 'HEAD');
  f.git(f.product, 'switch', '-c', 'APP-11');
  fs.writeFileSync(path.join(f.product, 'second.txt'), 'зависимая задача\n');
  f.git(f.product, 'add', 'second.txt');
  f.git(f.product, 'commit', '-m', 'feat(APP-11): добавь перевод');
  const old = f.git(f.product, 'rev-parse', 'HEAD');
  f.git(f.product, 'push', 'origin', 'HEAD:refs/heads/stage');
  f.git(f.product, 'switch', 'main');
  fs.writeFileSync(f.code, 'свежая база\n');
  f.git(f.product, 'commit', '-am', 'chore: уточни термин');
  f.git(f.product, 'push', 'origin', 'main');
  const baseSha = f.git(f.product, 'rev-parse', 'HEAD');
  const tree = path.join(f.root, 'worktrees', 'chore-stage-rebuild', repo);
  f.git(f.product, 'worktree', 'add', '--detach', tree, baseSha);
  assert.throws(() => f.git(tree, 'cherry-pick', firstTask));
  const plan = () => operation(f, 'stand', 'stage', 'main', old, baseSha);
  assert.notEqual(plan().status, 0);
  fs.writeFileSync(path.join(tree, 'code.txt'), 'свежая база и первая задача\n');
  f.git(tree, 'add', 'code.txt');
  f.git(tree, '-c', 'core.editor=true', 'cherry-pick', '--continue');
  f.git(tree, 'cherry-pick', firstTask + '..' + old);
  const candidate = JSON.parse(plan().stdout);
  assert.deepEqual(candidate.oldTasks, ['APP-10', 'APP-11']);
  assert.deepEqual(candidate.newTasks, candidate.oldTasks);
  assert.deepEqual(candidate.missingTasks, []);
  assert(candidate.lost.some(line => line.startsWith(firstTask)));
  assert.equal(f.git(tree, 'show', 'HEAD:code.txt'), 'свежая база и первая задача');
  assert.equal(f.git(tree, 'show', 'HEAD:second.txt'), 'зависимая задача');
  f.git(f.product, ...candidate.pushArgs);
  assert.equal(f.git(f.origin, 'rev-parse', 'stage'), candidate.head);
  assert.equal(JSON.parse(plan().stdout).pushArgs, null);
  const clear = (...args) => spawnSync(process.execPath, [path.join(path.dirname(cli), 'git-workspace.mjs'),
    'worktrees-clear', 'chore-stage-rebuild', ...args], {cwd:f.root, encoding:'utf8', env:f.env});
  const removal = JSON.parse(clear().stdout);
  assert.equal(removal.candidates[0].head, candidate.head);
  assert.equal(removal.candidates[0].eligible, true);
  const applied = clear('--apply', '--confirm', removal.planHash);
  assert.equal(applied.status, 0, applied.stderr);
  assert(!fs.existsSync(tree));
});

test('publication lists exact changed paths and verifies the out-of-scope explanation', t => {
  const f = fixture(t);
  const input = {scopeFiles:['doc.txt']};
  assert.match(f.run('github', input).stderr, /out-of-scope file in extra: code.txt/);
  const planned = f.run('github', {...input, extra:'code.txt — сопутствующая правка, согласована.'});
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(JSON.parse(planned.stdout).outsideScope, ['code.txt']);
  assert.deepEqual(JSON.parse(f.run('github', {scopeFiles:['code.txt']}).stdout).outsideScope, []);
});

test('rebase of an already published round needs fresh evidence and an exact source lease', t => {
  const f = fixture(t);
  f.git(f.product, 'push', 'origin', task);
  f.git(f.product, 'switch', 'main');
  fs.writeFileSync(path.join(f.product, 'base-only.txt'), 'new target\n');
  f.git(f.product, 'add', 'base-only.txt');
  f.git(f.product, 'commit', '-m', 'обнови базу');
  f.git(f.product, 'push', 'origin', 'main');
  f.git(f.product, 'switch', task);
  f.git(f.product, 'rebase', 'origin/main');
  const replayedHead = f.git(f.product, 'rev-parse', 'HEAD');
  const input = {githubPr:12, rebase:{oldBase:f.base, oldHead:f.head, replayedHead}};
  assert.notEqual(f.run('github', input).status, 0);
  f.put('review-report.md', `APPROVED ${replayedHead}\n`);
  f.put('test-cases.md', `Full run: ${replayedHead} exit=0\n`);
  const plan = JSON.parse(f.run('github', input).stdout);
  assert(plan.pushArgs.includes('--force-with-lease=refs/heads/' + task + ':' + f.head));
  f.git(f.product, ...plan.pushArgs);
  assert.equal(f.git(f.origin, 'rev-parse', task), replayedHead);
});

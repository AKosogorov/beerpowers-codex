import test from 'node:test';
import { createHash } from 'node:crypto';
import { linkSync, utimesSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const handler = fileURLToPath(new URL('../plugins/beerpowers/bin/retro.mjs', import.meta.url));
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'beerpowers-retro-'));
  t.after(() => rmSync(temp, {recursive: true, force: true, maxRetries: 4}));
  const root = join(temp, 'workspace'), product = join(root, 'projects/books');
  mkdirSync(product, {recursive: true});
  const env = {...process.env, GIT_CONFIG_GLOBAL: join(temp, 'empty-config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', XDG_CONFIG_HOME: temp, CODEX_HOME: join(temp, 'unused-profile'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_EMAIL: 'test@example.invalid'};
  function write(rel, body) {
    const path = join(root, rel);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, body);
  }
  function invoke(args, input) {
    return spawnSync(process.execPath, [handler, ...args], {cwd: root, encoding: 'utf8', env, input: JSON.stringify(input)});
  }
  function run(args, input) {
    const r = invoke(args, input);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  }
  function git(cwd, ...args) {
    const r = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8', env});
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  git(product, 'init', '-qb', 'main');
  write('projects/books/readme', 'book\n');
  git(product, 'add', '.'); git(product, 'commit', '-qm', 'base');
  git(product, 'clone', '-q', '--bare', '.', join(temp, 'origin.git'));
  git(product, 'remote', 'add', 'origin', join(temp, 'origin.git'));
  git(product, 'branch', 'fix/done');
  git(product, 'switch', '-qc', 'active');
  write('projects/books/unmerged', 'Unmerged change\n');
  git(product, 'add', '.'); git(product, 'commit', '-qm', 'active');
  git(product, 'switch', '-q', 'main');
  git(root, 'init', '-qb', 'outer');
  write('.gitignore', '/projects/\n/worktrees/\n');
  write('memory/tasks/fix/done/preflight.md', 'Класс: feature. fixture\n');
  write('memory/tasks/fix/done/review-report.md', 'APPROVED abc123\n');
  write('memory/tasks/fix/done/test-cases.md', 'Full run: abc123 exit=0\n');
  write('memory/tasks/fix/done/feature-state.json', '{"next":"done","history":[{"next":"fix"},{"next":"final-review"}]}');
  write('memory/tasks/active/preflight.md', 'Класс: lean. fixture\n');
  write('memory/MEMORY.md', '# Manual index\r\n');
  write('memory/retro-log.md', '# Manual lessons\r\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'task evidence');
  return {temp, root, product, write, git, run, invoke, read: rel => readFileSync(join(root, rel), 'utf8')};
}

test('retro scopes task evidence to registered products and protects manual files and paused work', t => {
  const f = fixture(t), code = 'fix/done', dir = 'memory/tasks/' + code;
  const api = join(f.root, 'projects/api');
  f.git(f.root, 'clone', '-q', join(f.temp, 'origin.git'), api);
  f.git(api, 'branch', code);
  f.write(dir + '/checkouts.json', JSON.stringify({repos: ['books','api'].map(name =>
    ({name, checkout: 'projects/' + name, base: 'main'}))}));
  const source = 'repos/api/test-cases.md';
  f.write(dir + '/' + source, 'API test passed\n');
  f.write(dir + '/repos/books/test-cases.md', 'Books test passed\n');
  f.git(f.root, 'add', dir);
  f.git(f.root, 'commit', '-qm', 'product evidence');
  const plan = () => f.run(['plan', code]).tasks[0];
  const row = plan();
  const lesson = {source, line: 1, trigger: 'меняется API', action: 'проверь API',
    verification: {author:'tester', checkedBy:'team-lead', repo:'api', sha:row.targets.api.sha,
      observed:'2026-01-14', kind:'fact', status:'reproduced', proof:'API test passed'}};
  const proposal = {date:'2026-01-15', evidenceId:row.evidenceId, review:'Проверены оба продукта.', lessons:[lesson]};
  assert.equal(f.run(['distill', code], proposal).written, 2);
  assert.ok(Object.hasOwn(row.sources, source));
  assert.ok(Object.hasOwn(row.sources, 'repos/books/test-cases.md'));
  assert.equal(plan().cleanupCandidate, true);
  const journal = f.read('memory/retro-log.md');
  const spoofed = {...lesson, verification:{...lesson.verification, repo:'books', sha:row.targets.books.sha}};
  assert.match(f.invoke(['distill', code], {...proposal, lessons:[spoofed]}).stderr, /product/i);
  f.write(dir + '/' + source, 'API report revised\n');
  assert.notEqual(plan().evidenceId, row.evidenceId);
  assert.match(f.invoke(['distill', code], proposal).stderr, /Evidence changed/);
  assert.equal(f.read('memory/retro-log.md'), journal);
  f.write(dir + '/repos/api/handover.md', '## Пауза\n');
  f.write(dir + '/repos/api/local-notes.md', 'Manual notes\n');
  f.write(dir + '/repos/unknown/test-cases.md', 'Unregistered\n');
  linkSync(join(api, 'readme'), join(f.root, dir, 'repos/api/review-report.md'));
  symlinkSync(api, join(f.root, dir, 'repos/api/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const guarded = plan();
  assert.equal(guarded.paused, true);
  assert.deepEqual(guarded.manual.sort(), ['repos/api/linked','repos/api/local-notes.md','repos/api/review-report.md','repos/unknown']);
  assert.ok(!Object.hasOwn(guarded.sources, 'repos/unknown/test-cases.md'));
  assert.equal(guarded.cleanupCandidate, false);
  f.git(api, 'remote', 'remove', 'origin');
  assert.notEqual(plan().mergeProof.merged, true);
});

test('retro reports local per-worktree fetch observation without contacting origin', t => {
  const f = fixture(t);
  const linked = join(f.root, 'projects/linked');
  f.git(f.product, 'worktree', 'add', '--detach', linked, 'HEAD');
  function observation() {
    return f.run(['status', 'active']).products.find(repo => repo.name === 'linked');
  }
  assert.equal(observation().freshness, 'unknown');
  assert.equal(observation().lastFetchAt, null);
  f.git(linked, 'fetch', 'origin');
  const fetchHead = f.git(linked, 'rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD');
  assert.equal(observation().freshness, 'fresh');
  const old = new Date('2020-01-10T12:00:00Z');
  utimesSync(fetchHead, old, old);
  f.git(linked, 'remote', 'set-url', 'origin', join(f.temp, 'absent.git'));
  const stale = observation();
  assert.equal(stale.lastFetchAt, old.toISOString());
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.fetch, 'skipped');
  assert.deepEqual(stale.problems, []);
});

test('retro distills referenced evidence once; a fresh merge proof and clean reviewed inputs precede cleanup', t => {
  const f = fixture(t);
  f.git(f.product, 'switch', '-q', 'active');
  f.write('projects/books/in-flight', 'Uncommitted work in the active checkout\n');
  const args = ['plan', 'fix/done', 'active', '--force'];
  const plan = f.run(args);
  const [done, active] = plan.tasks;
  assert.equal(done.taskClass, 'feature');
  assert.equal(done.fixCycles, 1);
  assert.equal(done.featureGate, 'done');
  assert.equal(done.lastRun.exit, 0);
  assert.equal(done.lastVerdict, 'APPROVED abc123');
  assert.equal(done.mergeProof.repos[0].target, 'main');
  assert.equal(done.mergeProof.merged, true);
  assert.equal(done.cleanupCandidate, false);
  assert.equal(active.mergeProof.merged, false);
  assert.equal(active.cleanupCandidate, false);
  const activeBrief = f.read('memory/tasks/active/preflight.md');
  const activeWork = f.read('projects/books/unmerged');
  const inFlight = f.read('projects/books/in-flight');
  assert.equal(plan.metrics.project.totals.total_tokens, null);
  assert.deepEqual(plan.worktrees.args, ['worktrees-clear', 'fix/done', 'active', '--force']);
  const proposal = {date: '2026-01-15', evidenceId: done.evidenceId, review: 'Результат проверки сохранён в журнале.',
    lessons: [{source: 'test-cases.md', line: 1, trigger: 'изменился формат', action: 'проверь сохранённый полный прогон',
      verification: {author:'tester', checkedBy:'team-lead', repo:'books', sha:done.targets.books.sha, observed:'2026-01-14',
        kind:'fact', status:'reproduced', proof:'git show зафиксировал текущий формат вывода.'}}]};
  const record = ['distill', 'fix/done'];
  assert.notEqual(f.invoke(record, {...proposal, lessons: [{...proposal.lessons[0], source: '../outside'}]}).status, 0);
  assert.equal(f.run(record, proposal).written, 2);
  const journal = f.read('memory/retro-log.md'), index = f.read('memory/MEMORY.md');
  assert.ok(journal.startsWith('# Manual lessons\r\n'));
  assert.ok(journal.includes('## Уроки эпика (fix/done)\r\n\r\n2026-01-15'));
  assert.ok(index.startsWith('# Manual index\r\n'));
  assert.equal(f.run(record, proposal).written, 0);
  const tomorrow = {...proposal, date: '2026-01-16'};
  assert.equal(f.run(record, tomorrow).written, 0);
  assert.equal(f.read('memory/retro-log.md'), journal);
  assert.equal(f.read('memory/MEMORY.md'), index);
  // The previous release hashed the rendered proof, including the date.
  const {trigger, action} = proposal.lessons[0];
  const proof = journal.match(/(Воспроизведено · [^\r\n]+?) Основание:/)[1];
  const legacyKey = createHash('sha256').update(JSON.stringify([trigger, action, proof])).digest('hex');
  const legacy = journal.replace(/<!-- beerpowers:lesson [a-f0-9]{64}/, '<!-- beerpowers:lesson ' + legacyKey);
  assert.notEqual(legacy, journal);
  f.write('memory/retro-log.md', legacy);
  assert.equal(f.run(record, tomorrow).written, 0);
  assert.equal(f.read('memory/retro-log.md'), legacy);
  const changedLesson = structuredClone(tomorrow);
  changedLesson.lessons[0].verification.proof += ' Дополнительное наблюдение.';
  assert.equal(f.run(record, changedLesson).written, 1);
  assert.deepEqual(f.run(args).tasks.map(row => row.cleanupCandidate), [true, false]);
  assert.equal(f.read('memory/tasks/active/preflight.md'), activeBrief);
  assert.equal(f.read('projects/books/unmerged'), activeWork);
  assert.equal(f.read('projects/books/in-flight'), inFlight);
  f.write('memory/tasks/fix/done/handover.md', '## Пауза\n\nРучной комментарий\n');
  assert.notEqual(f.invoke(record, proposal).status, 0);
  const changed = f.run(['plan', 'fix/done']).tasks[0];
  assert.equal(changed.paused, true);
  assert.equal(changed.cleanupCandidate, false);
  assert.equal(changed.distilled, false);
  assert.ok(existsSync(join(f.root, 'memory/tasks/fix/done/preflight.md')));
  mkdirSync(join(f.root, 'projects/second'));
  f.git(join(f.root, 'projects/second'), 'init', '-qb', 'main');
  const incomplete = f.run(['plan', 'fix/done']).tasks[0];
  assert.equal(incomplete.scopeResolved, false);
  assert.equal(incomplete.cleanupCandidate, false);
});

test('retro discovers nested task names and retains custom files, junctions and missing origin', t => {
  const f = fixture(t);
  f.write('memory/tasks/fix/done/manual-note.md', 'Keep me\n');
  f.write('memory/tasks/fix/done/done-qa.html', '<!doctype html><title>Manual QA</title>');
  mkdirSync(join(f.temp, 'outside'));
  writeFileSync(join(f.temp, 'outside/canary'), 'Untouched\n');
  symlinkSync(join(f.temp, 'outside'), join(f.root, 'memory/tasks/fix/done/archive'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(f.temp, 'outside'), join(f.root, 'memory/tasks/linked-root'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run(['plan']);
  assert.deepEqual(result.tasks.map(row => row.code).sort(), ['active', 'fix/done']);
  const done = result.tasks.find(row => row.code === 'fix/done');
  assert.deepEqual(done.manual.sort(), ['archive', 'done-qa.html', 'manual-note.md']);
  assert.deepEqual(result.worktrees.args, ['worktrees-clear']);
  assert.deepEqual(result.skippedLinks, ['memory/tasks/linked-root']);
  assert.equal(done.cleanupCandidate, false);
  assert.notEqual(f.invoke(['plan', '../outside']).status, 0);
  assert.notEqual(f.invoke(['plan', 'fix/done/archive']).status, 0);
  f.git(f.product, 'remote', 'remove', 'origin');
  const unavailable = f.run(['plan', 'fix/done']).tasks[0];
  assert.equal(unavailable.mergeProof.merged, null);
  assert.equal(unavailable.cleanupCandidate, false);
  assert.equal(readFileSync(join(f.temp, 'outside/canary'), 'utf8'), 'Untouched\n');
});

test('first retro creates the project journal with the rule precedent and named epic', t => {
  const f = fixture(t);
  rmSync(join(f.root,'memory/retro-log.md'));
  const {evidenceId} = f.run(['plan','fix/done']).tasks[0];
  f.run(['distill','fix/done'], {date:'2026-01-15', topic:'Проверка повторного запуска',
    evidenceId, review:'Новых уроков нет.', lessons:[]});
  const journal = f.read('memory/retro-log.md');
  assert.ok(journal.startsWith('---'));
  assert.match(journal,/guard-approval-link/);
  assert.match(journal,/## Проверка повторного запуска \(fix\/done\)/);
});

test('an explicit synthetic Codex export supplies only the measured corpus', t => {
  const f = fixture(t);
  f.write('counts.jsonl', [
    {timestamp: '2026-01-15T10:00:00Z', type: 'session_meta', payload: {id: 'demo'}},
    {timestamp: '2026-01-15T10:05:00Z', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {total_tokens: 12}}}}
  ].map(JSON.stringify).join('\n'));
  const plan = f.run(['plan', 'absent', '--metrics', 'counts.jsonl']);
  assert.deepEqual(plan.tasks, [{code: 'absent', present: false}]);
  assert.equal(plan.metrics.project.totals.total_tokens, 12);
  assert.equal(plan.metrics.project.requests, null);
  assert.deepEqual(plan.worktrees.args, ['worktrees-clear', 'absent']);
});

test('retro status inventories artifacts and distinguishes cached proof from server branch presence', t => {
  const f = fixture(t);
  f.write('memory/tasks/PROJ-42/tracker/task.md', 'Task snapshot\n');
  f.write('memory/tasks/PROJ-42/tracker/task-attachment/example.txt', 'Attachment\n');
  f.git(f.product, 'push', '-q', 'origin', 'active');
  const cached = f.run(['status']);
  assert.deepEqual(cached.tasks.map(task => task.code), ['active', 'fix/done', 'PROJ-42']);
  assert.equal(cached.tasks[2].artifacts.files, 2);
  assert.equal(cached.tasks[0].repos[0].remoteBranch, null);
  assert.equal(cached.tasks[0].repos[0].merged, null);
  assert.equal(f.git(f.product, 'branch', '-r', '--list', 'origin/main'), '');

  const result = f.run(['status', '--fetch', '--remote']);
  const repos = Object.fromEntries(result.tasks.map(task => [task.code, task.repos[0]]));
  assert.equal(result.products[0].fetch, 'ok');
  assert.equal(repos.active.remoteBranch, true);
  assert.equal(repos.active.merged, false);
  assert.equal(repos['fix/done'].remoteBranch, false);
  assert.equal(repos['fix/done'].merged, true);
  assert.equal(repos['fix/done'].target, 'main');
  assert.equal(repos['PROJ-42'].localHead, null);
  assert.equal(repos['PROJ-42'].merged, null);

  f.git(f.product, 'remote', 'set-url', 'origin', join(f.temp, 'missing.git'));
  assert.equal(f.run(['status', 'fix/done']).tasks[0].repos[0].merged, true);
  const unavailable = f.run(['status', 'active', '--remote']);
  assert.equal(unavailable.tasks[0].repos[0].remoteBranch, null);
  assert.ok(unavailable.products[0].problems.length);
  assert.notEqual(f.invoke(['plan', '--remote']).status, 0);
  f.write('memory/tasks/fix/screenshots/preflight.md', 'Task named after an artifact folder\n');
  assert.ok(f.run(['status']).tasks.some(task => task.code === 'fix/screenshots'));
});

test('distillation requires fresh target, exact red-base probe, dated correction and role ownership', t => {
  const f = fixture(t), code = 'fix/done';
  f.write('memory/tasks/' + code + '/bug-log.md','Красная база: `git status --porcelain`.\n');
  const plan = () => f.run(['plan',code]).tasks[0];
  const row = plan(), proof = 'git status --porcelain: пустой вывод';
  const proposal = {date:'2026-01-15', evidenceId:row.evidenceId, review:'Проверка артефакта на базе.',
    lessons:[{source:'bug-log.md', line:1, trigger:'база красная', action:'учти исходный сбой',
      verification:{author:'tester',checkedBy:'team-lead',repo:'books',sha:row.targets.books.sha,
        observed:'2026-01-10',kind:'red-base',status:'refuted',proof,command:'git status --porcelain',
        ran:'git status --porcelain',exit:0,closedDuplicates:[{path:'memory/issues/known-issues.md',line:1}]}}]};
  const v = proposal.lessons[0].verification;
  const run = () => f.invoke(['distill',code],proposal);
  const before = f.read('memory/retro-log.md');
  f.write('memory/issues/known-issues.md','Открыто: красная база.\n');
  assert.notEqual(run().status,0);
  f.write('memory/issues/known-issues.md','Закрыто 2026-01-15. ' + proof + '\n');
  v.ran = 'git status';
  assert.notEqual(run().status,0);
  v.ran = v.command;
  v.checkedBy = 'tester';
  assert.notEqual(run().status,0);
  assert.equal(f.read('memory/retro-log.md'),before);
  v.checkedBy = 'team-lead';
  assert.equal(f.git(f.product,'status','--porcelain'),'');
  const ok = run();
  assert.equal(ok.status,0,ok.stderr);
  assert.match(f.read('memory/retro-log.md'),/Опровергнуто.+исходная дата 2026-01-10/);
  assert.match(f.read('memory/retro-log.md'),/Автор вывода: tester, проверил: team-lead/);
  const closed = f.read('memory/retro-log.md');
  proposal.date = '2026-01-16';
  assert.equal(f.run(['distill',code],proposal).written,0);
  assert.equal(f.read('memory/retro-log.md'),closed);
  f.git(f.product,'push','origin','active:main');
  assert.notEqual(run().status,0);
  const moved = plan();
  assert.notEqual(moved.evidenceId,row.evidenceId);
  assert.equal(moved.distilled,false);
  f.git(f.product,'remote','remove','origin');
  const offline = plan();
  Object.assign(v,{status:'unavailable',sha:null,proof:'Цель недоступна'});
  proposal.evidenceId = offline.evidenceId;
  assert.equal(run().status,0);
  assert.match(f.read('memory/retro-log.md'),/Требует перепроверки.+исходная дата 2026-01-10/);
});

test('reproduced red baseline records exact dated command at target SHA', t => {
  const f = fixture(t), code = 'fix/done', command = 'git grep -q missing-baseline-token HEAD';
  f.write('memory/tasks/' + code + '/bug-log.md','Проверка отсутствующего токена\n' + command + '\n');
  const row = f.run(['plan',code]).tasks[0];
  assert.equal(f.git(f.product,'rev-parse','HEAD'),row.targets.books.sha);
  const probe = spawnSync('git',command.split(' ').slice(1),{cwd:f.product});
  assert.equal(probe.status,1);
  const review = {date:'2026-01-15',evidenceId:row.evidenceId,review:'Подтверждено на текущей базе.',
    lessons:[{source:'bug-log.md',line:1,trigger:'ищем отсутствующий токен',action:'учти красную базу',
      verification:{author:'tester',checkedBy:'team-lead',repo:'books',sha:row.targets.books.sha,
        observed:'2026-01-10',kind:'red-base',status:'reproduced',proof:'Токен отсутствует в дереве.',
        command,ran:command,exit:probe.status}}]};
  assert.equal(f.run(['distill',code],review).written,2);
  const journal=f.read('memory/retro-log.md');
  assert.ok(journal.includes('Воспроизведено · 2026-01-15, исходная дата 2026-01-10'));
  assert.ok(journal.includes(command + ', exit=1'));
});

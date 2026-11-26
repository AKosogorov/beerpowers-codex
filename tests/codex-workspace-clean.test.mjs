import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../plugins/beerpowers/bin/workspace-clean', import.meta.url));
const mutantsCli = fileURLToPath(new URL('../plugins/beerpowers/bin/mutants.mjs', import.meta.url));

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-clean-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(temp, 'work space');
  const abs = rel => path.join(root, rel);
  fs.mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(temp, 'empty-config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid',
    GIT_COMMITTER_EMAIL: 'f@example.invalid', GIT_ALLOW_PROTOCOL: 'file', WORKSPACE_ROOT: root,
    BEERPOWERS_TEST_SLOTS_DIR: path.join(temp, 'slots') };
  const git = (rel, ...args) => {
    const result = spawnSync('git', ['-C', abs(rel), ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trimEnd();
  };
  const put = (rel, data = 'fixture\n') => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), data);
  };
  const call = (entry, cwd, args, status) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', env });
    assert.equal(result.status, status, result.stdout + '\n' + result.stderr);
    return result.stdout + result.stderr;
  };
  const run = (args, status = 0) => call(cli, temp, args, status);
  const runMutants = () => call(mutantsCli, root, ['--clean', '--dry-run'], 0);
  const project = name => {
    const repo = 'projects/' + name;
    put(repo + '/.gitignore', '/.output/\n/.env\n');
    put(repo + '/keep.txt');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'seed');
    git(repo, 'clone', '-q', '--bare', '.', path.join(temp, name + '.git'));
    git(repo, 'remote', 'add', 'origin', path.join(temp, name + '.git'));
    return repo;
  };
  const link = (rel, to) => fs.symlinkSync(abs(to), abs(rel), process.platform === 'win32' ? 'junction' : 'dir');
  const exists = rel => Boolean(fs.lstatSync(abs(rel), { throwIfNoEntry: false }));
  put('.gitignore', '/projects/\n/worktrees/\n/.codex/.cache/\n/memory/tasks/**/figma/\n/memory/tasks/**/screenshots/\n/memory/tasks/**/tracker/task-attachment/\n');
  put('.codex/workspace.json', '{"schemaVersion":1,"beerpowers":"0.10.0"}');
  git('.', 'init', '-q', '-b', 'main');
  git('.', 'add', '.');
  git('.', 'commit', '-qm', 'seed');
  return {abs, git, put, run, runMutants, project, link, exists, env};
}

test('output scopes by product or nested task and refuses tracked files, links and nested repositories', t => {
  const f = fixture(t);
  const api = f.project('api');
  const web = f.project('web');
  const checkout = 'worktrees/fix/issue/api';
  const sibling = 'worktrees/fix/other/api';
  f.git(api, 'worktree', 'add', '-qb', 'fix/issue', f.abs(checkout));
  f.git(api, 'worktree', 'add', '-qb', 'fix/other', f.abs(sibling));
  for (const rel of [api, web, checkout, sibling]) f.put(`${rel}/.output/generated`);
  const run = (...args) => f.run(['output', ...args, '--no-cache']);
  assert.match(run('fix/issue'), /worktrees\/fix\/issue\/api\/\.output/);
  assert(f.exists(checkout + '/.output/generated'));
  run('fix/issue', '--apply');
  assert(!f.exists(checkout + '/.output'));
  run('web', '--apply');
  assert(!f.exists(web + '/.output'));
  assert(f.exists(api + '/.output/generated'));
  assert(f.exists(sibling + '/.output/generated'));
  f.git(api, 'add', '-f', '.output/generated');
  assert.match(f.run(['output', '--apply'], 1), /\.output\/generated/);
  assert(f.exists(sibling + '/.output/generated'));
  f.git(api, 'reset', 'HEAD', '--', '.output/generated');
  f.put('outside/keep');
  f.link(api + '/.output/link', 'outside');
  assert.match(f.run(['output', 'api', '--apply'], 1), /[Сс]сылк/);
  assert(f.exists('outside/keep'));
  fs.unlinkSync(f.abs(api + '/.output/link'));
  f.git(api + '/.output', 'init', '-q');
  assert.match(f.run(['output', 'api', '--apply'], 1), /Git/);
  assert(f.exists(api + '/.output/.git'));
  f.put('worktrees/api/api/.output/generated');
  run('api', '--apply');
  assert(!f.exists('worktrees/api/api/.output'));
  assert(f.exists(api + '/.output/.git'));
});

test('only current or legacy BeerPowers workspace formats allow cleanup', t => {
  const f = fixture(t);
  const rel = 'memory/tasks/QA-5/figma/picture.png';
  f.put(rel);
  f.put('.codex/workspace.json', '{}');
  assert.match(f.run(['task', 'QA-5', '--apply'], 1), /штампа BeerPowers/);
  assert(f.exists(rel));
  f.put('.codex/workspace.json', '{"beerpowers":"0.2.0"}');
  f.run(['task', 'QA-5', '--apply']);
  assert(!f.exists(rel));
});

test('task cleans only named media, preserves ordinary and tracked files, and removes empty task containers', t => {
  const f = fixture(t);
  const task = 'memory/tasks/fix/issue';
  const medias = ['figma', 'screenshots', 'tracker/task-attachment'];
  for (const rel of medias) f.put(`${task}/${rel}/image.png`);
  f.put(task + '/tracker/task.md');
  f.put(task + '/handwritten.md');
  f.put('memory/tasks/QA-15/figma/framed');
  f.put('memory/tasks/QA-16/figma/other');
  assert.match(f.run(['task', 'fix/issue']), /удалил бы/);
  for (const rel of medias) assert(f.exists(`${task}/${rel}/image.png`));
  f.git('.', 'add', '-f', `${task}/figma/image.png`);
  assert.match(f.run(['task', 'fix/issue', '--apply'], 1), /figma\/image.png/);
  assert(f.exists(task + '/screenshots/image.png'));
  f.git('.', 'reset', 'HEAD', '--', `${task}/figma/image.png`);
  f.run(['task', 'fix/issue', '--apply']);
  for (const rel of medias) assert(!f.exists(`${task}/${rel}`));
  assert(f.exists(task + '/tracker/task.md'));
  assert(f.exists(task + '/handwritten.md'));
  f.run(['task', 'QA-15', '--apply']);
  assert(!f.exists('memory/tasks/QA-15'));
  assert(f.exists('memory/tasks/QA-16/figma/other'));
  assert.match(f.run(['task', 'fix/../QA-16', '--apply'], 1), /код/);
  f.git('memory/tasks/QA-16', 'init', '-q');
  f.git('memory/tasks/QA-16', 'add', 'figma/other');
  assert.match(f.run(['task', 'QA-16', '--apply'], 1), /Git-репозиторий memory\/tasks\/QA-16/);
  assert(f.exists('memory/tasks/QA-16/figma/other'));
});

test('worktree verifies all candidates and preserves branches, orphans and ignored files', t => {
  const f = fixture(t);
  const api = f.project('api');
  const web = f.project('web');
  const checkout = 'worktrees/fix/issue/api';
  const other = 'worktrees/fix/issue/web';
  f.git(api, 'worktree', 'add', '-qb', 'fix/issue', f.abs(checkout));
  f.git(web, 'worktree', 'add', '-qb', 'fix/issue', f.abs(other));
  f.put('.codex/bin/worktree-teardown.mjs', `// supports: --dry-run
if (process.argv.includes('--dry-run')) console.log('dry hook');
else if (process.argv[3] === 'web') process.exit(1);
`);
  const plan = f.run(['worktree', 'fix/issue']);
  const approved = /planHash: ([a-f0-9]{64})/.exec(plan)?.[1];
  assert.match(plan, /удалил бы/);
  assert.match(plan, /dry hook/);
  assert(approved);
  assert(f.exists(checkout + '/.git'));
  f.put(other + '/.env');
  assert.match(f.run(['worktree', 'fix/issue', '--merged-anyway', '--apply'], 1), /\.env/);
  assert(f.exists(checkout + '/.git'));
  assert(f.exists(other + '/.env'));
  fs.unlinkSync(f.abs(other + '/.env'));
  assert.match(f.run(['worktree', 'fix/issue', '--apply', '--confirm', '0'.repeat(64)], 1), /plan changed/);
  assert.match(f.run(['worktree', 'fix/issue', '--apply', '--confirm', approved], 1), /teardown.*failed/);
  assert(f.exists(checkout + '/.git'));
  assert(f.exists(other + '/.git'));
  fs.unlinkSync(f.abs('.codex/bin/worktree-teardown.mjs'));
  f.run(['worktree', 'fix/issue', '--apply', '--confirm', approved]);
  assert(!f.exists('worktrees/fix/issue'));
  assert.match(f.git(api, 'branch', '--list', 'fix/issue'), /fix\/issue/);
  f.put('worktrees/OLD-1/api/build');
  assert.match(f.run(['worktree', 'OLD-1'], 1), /--orphan/);
  f.put('.codex/bin/worktree-teardown.mjs', `// supports: --dry-run
import fs from 'node:fs';
if (process.argv.includes('--dry-run')) console.log('orphan hook');
else fs.writeFileSync('teardown.log', process.argv[2]);
`);
  assert.match(f.run(['worktree', 'OLD-1', '--orphan']), /orphan hook/);
  assert(!f.exists('teardown.log'));
  f.run(['worktree', 'OLD-1', '--orphan', '--apply']);
  assert(!f.exists('worktrees/OLD-1'));
  assert.equal(fs.readFileSync(f.abs('teardown.log'), 'utf8'), 'OLD-1');

  const orphan = 'worktrees/fix/orphan/api';
  const nested = 'worktrees/fix/nested/web';
  f.put(orphan + '/generated');
  f.put(nested + '/repo/keep');
  f.git(nested + '/repo', 'init', '-q');
  f.put('worktrees/fix/orphan/unknown/keep');
  assert.match(f.run(['orphans']), /fix\/orphan\/api/);
  assert(f.exists(orphan));
  f.run(['orphans', '--apply']);
  assert(!f.exists(orphan));
  assert(f.exists(nested + '/repo/.git'));
  assert(f.exists('worktrees/fix/orphan/unknown/keep'));

  const bare = 'worktrees/foreign';
  f.git('.', 'init', '-q', '--bare', f.abs(bare));
  f.project('refs');
  assert.match(f.run(['orphans', '--apply']), /foreign.*Git-репозиторий/);
  assert(f.exists(bare + '/refs'));
});

test('worktree honors detached HEAD, stand publication and missing locally advertised commits', t => {
  const f = fixture(t);
  const repo = f.project('api');
  const checkout = 'worktrees/_archive/api';
  f.git(repo, 'worktree', 'add', '-q', '--detach', f.abs(checkout));
  f.git(repo, 'clone', '-q', f.abs('../api.git'), f.abs('../publisher'));
  const publisher = '../publisher';
  f.put(publisher + '/addition');
  f.git(publisher, 'add', 'addition');
  f.git(publisher, 'commit', '-qm', 'publish');
  f.git(publisher, 'push', '-q', 'origin', 'main');
  const refs = f.git(repo, 'show-ref');
  assert.match(f.run(['worktree', '_archive', '--no-cache'], 1), /Нет локальных объектов.*origin\/main/);
  assert.equal(f.git(repo, 'show-ref'), refs);
  f.run(['worktree', '_archive', '--no-cache', '--apply']);
  assert(!f.exists(checkout));
  assert.equal(f.git(repo, 'show-ref'), refs);
  assert(!f.exists(`${repo}/.git/FETCH_HEAD`));

  const stand = 'worktrees/chore-qa-rebuild/api';
  f.git(repo, 'worktree', 'add', '-qb', 'local-rebuild', f.abs(stand));
  f.put(stand + '/changes');
  f.git(stand, 'add', 'changes');
  f.git(stand, 'commit', '-qm', 'rebuild');
  const rebuild = f.git(stand, 'rev-parse', 'HEAD');
  assert.match(f.run(['worktree', 'chore-qa-rebuild', '--no-cache'], 1), /origin\/qa/);
  assert.match(f.run(['worktree', 'chore-qa-rebuild', '--no-cache', '--merged-anyway']), new RegExp(rebuild));
  f.git(stand, 'push', '-q', 'origin', 'HEAD:refs/heads/qa');
  f.run(['worktree', 'chore-qa-rebuild', '--no-cache', '--apply']);
  assert(!f.exists(stand));
  assert.equal(f.git(repo, 'rev-parse', 'refs/heads/local-rebuild'), rebuild);
});

test('cache preserves live and unknown state and delegates mutant worktree unregistering', t => {
  const f = fixture(t);
  const api = f.project('api');
  const cache = '.codex/.cache';
  const runs = cache + '/parallel-tests/runs';
  const sessions = cache + '/screenshots-reminder';
  const copy = cache + '/mutants/api-s1';
  const busyCopy = cache + '/mutants/api-s2';
  const live = `20200101-000000-${process.pid}`;
  const dead = '20200101-000000-2147483647';
  for (const rel of [`${runs}/${dead}`, `${runs}/${live}`, `${runs}/manual`, `${sessions}/old`]) {
    f.put(rel + '/log');
    fs.utimesSync(f.abs(rel), new Date(2000, 0, 1), new Date(2000, 0, 1));
  }
  for (const rel of [`${runs}/20991231-000000-2147483647/log`, `${sessions}/new/log`,
    `${cache}/parallel-tests/api.junit.xml`, `${cache}/user-files-window`, `${cache}/personal`]) f.put(rel);
  f.git(api, 'worktree', 'add', '-q', '--detach', f.abs(copy));
  f.git(api, 'worktree', 'add', '-q', '--detach', f.abs(busyCopy));
  assert.match(f.runMutants(), /убрал бы: api-s1/);
  assert(!fs.existsSync(f.env.BEERPOWERS_TEST_SLOTS_DIR));
  fs.mkdirSync(f.env.BEERPOWERS_TEST_SLOTS_DIR);
  fs.writeFileSync(path.join(f.env.BEERPOWERS_TEST_SLOTS_DIR, 'slot-2'), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(path.join(f.env.BEERPOWERS_TEST_SLOTS_DIR, 'slot-3'), '{"pid":2147483647}\n');
  const locks = () => fs.readdirSync(f.env.BEERPOWERS_TEST_SLOTS_DIR).sort()
    .map(name => [name, fs.readFileSync(path.join(f.env.BEERPOWERS_TEST_SLOTS_DIR, name), 'utf8')]);
  const savedLocks = locks();
  assert.match(f.runMutants(), /занята: api-s2/);
  assert.deepEqual(locks(), savedLocks);
  assert.match(f.run(['cache']), /удалил бы: .codex\/.cache\/mutants\/api-s1/);
  assert.deepEqual(locks(), savedLocks);
  assert(f.exists(copy));
  assert(f.exists(`${runs}/${dead}`));
  f.run(['output', '--no-cache', '--apply']);
  assert(f.exists(copy));
  assert(f.exists(`${runs}/${dead}`));
  assert.match(f.run(['output', '--apply']), /кеш/);
  assert(!f.exists(copy));
  assert(!f.exists(`${runs}/${dead}`));
  assert(!f.exists(`${sessions}/old`));
  assert.doesNotMatch(f.git(api, 'worktree', 'list', '--porcelain'), /api-s1/);
  for (const rel of [busyCopy, `${runs}/${live}`, `${runs}/manual`, `${sessions}/new`,
    `${cache}/parallel-tests/api.junit.xml`, `${cache}/user-files-window`, `${cache}/personal`]) assert(f.exists(rel), rel);
  f.run(['cache', '--keep-days', '0', '--apply']);
  assert(!f.exists(`${sessions}/new`));
  assert(f.exists(`${runs}/${live}`));
});

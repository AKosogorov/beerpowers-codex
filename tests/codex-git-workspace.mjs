import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../plugins/beerpowers/bin/git-workspace.mjs', import.meta.url));

test('Git product flow, busy checkout, local bare origins, confirmed cleanup', t => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-product-')));
  const root = path.join(temp, 'work space');
  // Only this test's freshly created directory is disposable.
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(temp, 'empty-config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid',
    GIT_COMMITTER_EMAIL: 'f@example.invalid', GIT_ALLOW_PROTOCOL: 'file' };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trimEnd();
  };
  const put = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const run = (args, spec = {}, expected = true) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8',
      env: { ...env, BEERPOWERS_GIT_TASKS: JSON.stringify(spec) } });
    if (!expected) { assert.notEqual(r.status, 0); return r.stderr; }
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  put('.gitignore', '/projects/\n/worktrees/\n');
  git(root, 'init', '-q', '-b', 'main');
  const products = { api: 'dev', web: 'main', old: 'trunk' };
  for (const [name, base] of Object.entries(products)) {
    const rel = 'projects/' + name, repo = path.join(root, rel);
    put(rel + '/.gitignore', '.env\n');
    git(repo, 'init', '-q', '-b', base);
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'seed');
    if (name === 'api') {
      git(repo, 'branch', 'main');
      git(repo, 'branch', 'release/nov');
    }
    const bare = path.join(temp, name + '.git');
    git(repo, 'clone', '-q', '--bare', '.', bare);
    git(repo, 'remote', 'add', 'origin', bare);
  }
  put('.codex/git-settings.json', JSON.stringify({ repos: { api: 'dev-default', web: 'main-default', old: 'custom' } }));
  const setups = run(['setup']).repos;
  assert.equal(setups.length, 3);
  assert.deepEqual(run(['doctor']).repos, setups);
  assert.deepEqual(Object.fromEntries(run(['profiles']).repos.map(r => [r.name, r.proposal])),
    { api: 'dev-default', old: 'custom', web: 'main-default' });
  assert.match(run(['task-plan', 'PRJ-1', '--repo', 'old'], {}, false), /custom requires explicit base/);
  const custom = { 'PRJ-100': { repos: ['old'], bases: { old: 'trunk' } } };
  assert.equal(run(['task-plan', 'PRJ-100'], custom).tasks[0].repos[0].base, 'trunk');
  const inputs = { 'PRJ-1': { repos: ['api', 'web'] }, 'PRJ-2': { repos: ['api'], bases: { api: 'PRJ-1' }, dependencies: ['PRJ-1'] } };
  const options = ['PRJ-1@release/nov', 'PRJ-2', '--', '--no-deps', '--database', 'name with spaces', '$literal'];
  const preview = run(['task-plan', ...options], inputs).tasks;
  assert.equal(preview[0].repos[0].base, 'release/nov');
  assert.equal(preview[0].repos[0].release, 'main');
  assert.equal(preview[0].repos[1].base, 'main');
  assert.equal(preview[1].repos[0].checkout, 'worktrees/PRJ-2/api');
  assert.equal(fs.existsSync(path.join(root, 'worktrees')), false);
  env.BEERPOWERS_GIT_PLAN = 'bad-digest';
  assert.match(run(['task-start', ...options], inputs, false), /plan changed/);
  assert.equal(fs.existsSync(path.join(root, 'memory/tasks/PRJ-1')), false);
  env.BEERPOWERS_GIT_PLAN = run(['task-plan', ...options], inputs).planHash;
  put('projects/api/.env', 'synthetic\n');
  put('.codex/bin/worktree-setup.mjs', "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.WORKSPACE_ROOT, 'seen.json'), JSON.stringify(process.argv.slice(2)));");
  const tasks = run(['task-start', ...options], inputs).tasks;
  delete env.BEERPOWERS_GIT_PLAN;
  assert.equal(tasks[0].repos[0].flagsUnused, true);
  const r = tasks[1].repos[0];
  const tree = path.join(root, r.checkout), api = path.join(root, 'projects/api');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'seen.json'), 'utf8')), ['PRJ-2', 'api', tree, '--database', 'name with spaces', '$literal']);
  assert.equal(r.environment['.env'], 'available');
  assert.equal(fs.existsSync(path.join(tree, '.env')), false);
  assert.equal(git(api, 'branch', '--show-current'), 'PRJ-1');
  assert.equal(git(tree, 'branch', '--show-current'), 'PRJ-2');
  assert.match(fs.readFileSync(path.join(root, 'memory/tasks/PRJ-2/git-flow.md'), 'utf8'), /## Зависимости/);
  assert.equal(run(['resolve', 'PRJ-2', 'api']).checkout, r.checkout);
  const copy = run(['task-start', 'PRJ-2', '--repo', 'api', '--', '--copy-env']);
  assert.equal(copy.tasks[0].repos[0].environment['.env'], 'copied');
  fs.writeFileSync(path.join(tree, '.env'), 'existing');
  run(['task-start', 'PRJ-2', '--repo', 'api', '--copy-env']);
  assert.equal(fs.readFileSync(path.join(tree, '.env'), 'utf8'), 'existing');
  assert.equal(run(['worktrees-clear', 'PRJ-2']).candidates[0].eligible, false);
  fs.unlinkSync(path.join(tree, '.env'));
  fs.writeFileSync(path.join(tree, 'unique'), 'fix\n');
  git(tree, 'add', 'unique'); git(tree, 'commit', '-qm', 'work');
  assert.equal(run(['merged', 'PRJ-2']).merged, false);
  assert.equal(run(['worktrees-clear']).candidates[0].eligible, false);
  const force = run(['worktrees-clear', 'PRJ-2', '--force']);
  assert.equal(force.candidates[0].eligible, true);
  assert.deepEqual(force.candidates[0].unpublished, [git(tree, 'rev-parse', 'HEAD')]);
  assert.match(run(['worktrees-clear', 'PRJ-2', '--apply', '--confirm', force.planHash], {}, false), /plan changed/);
  // Cherry-pick onto another parent; merge proof must come from patch equivalence.
  git(api, 'switch', 'dev');
  fs.writeFileSync(path.join(api, 'next'), 'next\n');
  git(api, 'add', 'next'); git(api, 'commit', '-qm', 'advance');
  git(api, 'cherry-pick', git(tree, 'rev-parse', 'HEAD'));
  git(api, 'push', '-q', 'origin', 'dev');
  assert.equal(run(['merged', 'PRJ-2']).repos[0].by, 'patch');
  const dry = run(['worktrees-clear', 'PRJ-2']);
  assert.equal(dry.candidates[0].eligible, true);
  assert.match(run(['worktrees-clear', 'PRJ-2', '--apply'], {}, false), /Confirmation/);
  fs.writeFileSync(path.join(tree, 'unfinished'), 'dirty');
  assert.match(run(['worktrees-clear', 'PRJ-2', '--apply', '--confirm', dry.planHash], {}, false), /plan changed/);
  fs.unlinkSync(path.join(tree, 'unfinished'));
  put('.codex/bin/worktree-teardown.mjs', 'process.exit(2)');
  assert.match(run(['worktrees-clear', 'PRJ-2', '--apply', '--confirm', dry.planHash], {}, false), /teardown.*failed/);
  fs.unlinkSync(path.join(root, '.codex/bin/worktree-teardown.mjs'));
  assert.deepEqual(run(['worktrees-clear', 'PRJ-2', '--apply', '--confirm', dry.planHash]).removed, [r.checkout]);
  assert.equal(fs.existsSync(tree), false);
  git(api, 'rev-parse', '--verify', 'refs/heads/PRJ-2');
  const forced = run(['task-start', 'PRJ-3', '--repo', 'api', '--worktree']).tasks[0].repos[0];
  assert.equal(forced.checkout, 'worktrees/PRJ-3/api');
  assert.equal(git(api, 'branch', '--show-current'), 'dev');
  put('memory/tasks/PRJ-3/checkouts.json', JSON.stringify({ repos: [forced] }));
  git(api, 'commit', '--allow-empty', '-qm', 'advance default after task checkout');
  git(api, 'push', '-q', 'origin', 'dev');
  assert.notEqual(git(api, 'rev-parse', 'refs/remotes/origin/dev'), forced.baseSha);
  assert.equal(run(['resolve', 'PRJ-3', 'api']).baseSha, forced.baseSha, 'review resolves recorded task base');
  fs.unlinkSync(path.join(root,'memory/tasks/PRJ-3/checkouts.json'));
  put('memory/tasks/PRJ-3/preflight.md', 'Base-SHA api: ' + forced.baseSha + '\n');
  assert.equal(run(['resolve', 'PRJ-3', 'api']).baseSha, forced.baseSha, 'current preflight pins the same base');
  assert.equal(run(['task-plan', 'PRJ-3']).tasks[0].repos[0].baseSha, forced.baseSha, 're-entry cannot move the review base');
  put('projects/api/unfinished', 'preserve\n');
  const busy = run(['task-start', 'PRJ-4', '--repo', 'api']).tasks[0].repos[0];
  assert.equal(busy.checkout, 'worktrees/PRJ-4/api');
  assert.equal(git(api, 'branch', '--show-current'), 'dev');
  assert.match(run(['task-plan', 'PRJ-5@absent', '--repo', 'api'], {}, false), /Release branch missing/);
  assert.deepEqual(run(['merged', 'PRJ-404']), { code: 'PRJ-404', merged: false, repos: [] });
  put('worktrees/PRJ-404/api/notes.txt', 'preserve');
  const orphan = run(['worktrees-clear', 'PRJ-404']);
  assert.equal(orphan.candidates[0].reason, 'unregistered directory');
  assert.deepEqual(run(['worktrees-clear', 'PRJ-404', '--apply', '--confirm', orphan.planHash]).removed, []);
  put('memory/tasks/PRJ-3/checkouts.json', JSON.stringify({ repos: [{ name: 'api' }, { name: 'web' }] }));
  assert.equal(run(['merged', 'PRJ-3']).merged, false, 'missing product branch prevents closure');
  put('.codex/bin/worktree-setup.mjs', 'process.exit(2)');
  assert.match(run(['task-start', 'PRJ-6', '--repo', 'api', '--worktree'], {}, false), /setup.*failed/);
  fs.unlinkSync(path.join(root, '.codex/bin/worktree-setup.mjs'));
  put('.codex/bin/worktree-setup', '#!/bin/bash\nprintf "%s\\n" "$1" "$2" "$4" > setup-args.txt\n');
  fs.chmodSync(path.join(root, '.codex/bin/worktree-setup'), 0o755);
  assert.equal(run(['task-start', 'PRJ-6', '--repo', 'api', '--', 'two words']).tasks[0].repos[0].setup,
    '.codex/bin/worktree-setup', 'retry pending project hook using Git Bash on Windows');
  assert.equal(fs.readFileSync(path.join(root, 'setup-args.txt'), 'utf8').replaceAll('\r\n', '\n'), 'PRJ-6\napi\ntwo words\n');
});

test('confirmed cleanup inventories ignored dependency trees and protects user files', t => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bp-dependency-cleanup-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
  });
  const root = path.join(temp, 'outer'), repo = path.join(root, 'projects', 'api');
  const origin = path.join(temp, 'origin.git');
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'empty'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trimEnd();
  };
  const run = (args, success = true) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
    if (!success) { assert.notEqual(r.status, 0); return r.stderr; }
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(root, '.codex/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex/bin/worktree-setup.mjs'), [
    "import fs from 'node:fs'; import path from 'node:path';",
    "for (const name of ['node_modules', 'vendor']) {",
    "  const dir = path.join(process.argv[4], name); fs.mkdirSync(dir);",
    "  fs.writeFileSync(path.join(dir, 'synthetic-dependency'), 'fixture');",
    "}",
  ].join('\n'));
  git(root, 'init', '-q', '-b', 'outer');
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), '/node_modules/\n/vendor/\n/.env\n/notes.local\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'synthetic');
  git(repo, 'clone', '-q', '--bare', '.', origin); git(repo, 'remote', 'add', 'origin', origin);
  const checkout = run(['task-start', 'QA-1', '--worktree']).tasks[0].repos[0].checkout;
  const tree = path.join(root, checkout);
  const plan = () => run(['worktrees-clear', 'QA-1']);
  const first = plan();
  assert.equal(first.candidates[0].eligible, true);
  assert.deepEqual(first.candidates[0].ignoredDerived.map(d => [d.path, d.topLevelEntries]), [
    [checkout + '/node_modules', 1], [checkout + '/vendor', 1],
  ]);
  fs.writeFileSync(path.join(tree, 'node_modules/another-entry'), 'fixture');
  assert.match(run(['worktrees-clear', 'QA-1', '--apply', '--confirm', first.planHash], false), /plan changed/);
  for (const name of ['notes.local', 'untracked.md', '.env']) {
    fs.writeFileSync(path.join(tree, name), 'synthetic placeholder');
    const blocked = run(['worktrees-clear', '--force']).candidates[0];
    assert.equal(blocked.eligible, false, name);
    assert(blocked.status.includes(name));
    if (name === '.env') assert.deepEqual(blocked.retainedEnv, [checkout + '/.env']);
    fs.unlinkSync(path.join(tree, name));
  }
  fs.writeFileSync(path.join(tree, 'tracked.txt'), 'manual\n');
  assert.equal(plan().candidates[0].eligible, false);
  git(tree, 'restore', 'tracked.txt');
  // A project teardown may remove its own dependencies. User files introduced
  // by teardown must still stop the final Git removal.
  const hook = path.join(root, '.codex/bin/worktree-teardown.mjs');
  fs.writeFileSync(hook, "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.argv[4], 'keep.txt'), 'manual');");
  assert.match(run(['worktrees-clear', 'QA-1', '--apply', '--confirm', plan().planHash], false), /candidate changed/);
  assert(fs.existsSync(path.join(tree, 'keep.txt')));
  fs.unlinkSync(path.join(tree, 'keep.txt'));
  fs.writeFileSync(hook, "import fs from 'node:fs'; import path from 'node:path'; const dir = path.join(process.argv[4], 'vendor'); fs.unlinkSync(path.join(dir, 'synthetic-dependency')); fs.rmdirSync(dir);");
  assert.deepEqual(run(['worktrees-clear', 'QA-1', '--apply', '--confirm', plan().planHash]).removed, [checkout]);
  assert.equal(fs.existsSync(tree), false);
  git(repo, 'rev-parse', '--verify', 'refs/heads/QA-1');
  const next = run(['task-start', 'QA-2', '--worktree']).tasks[0].repos[0].checkout;
  const nextDir = path.join(root, next);
  fs.writeFileSync(path.join(nextDir, 'tracked.txt'), 'pending\n');
  git(nextDir, 'commit', '-qam', 'unpublished');
  assert.equal(run(['worktrees-clear']).candidates[0].eligible, false);
  const forced = run(['worktrees-clear', '--force']);
  assert.equal(forced.candidates[0].unpublished.length, 1);
  assert.deepEqual(run(['worktrees-clear', '--force', '--apply', '--confirm', forced.planHash]).removed, [next]);
  git(repo, 'rev-parse', '--verify', 'refs/heads/QA-2');
});

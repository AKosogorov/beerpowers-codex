import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../plugins/beerpowers/bin/', import.meta.url));
const key = 'PROJECT-42';
const tests = Object.fromEntries(['api', 'web'].map(name => [name, { command: 'git diff --check', source: 'README.md' }]));
const brief = { class: 'lean', reason: 'Existing form', scope: 'One field', acceptance: 'Order date is visible', forks: 'None', stops: 'Migration' };

function perl() {
  if (process.platform !== 'win32') return 'perl';
  const candidates = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const candidate of candidates) {
    const file = path.resolve(path.dirname(candidate), '../usr/bin/perl.exe');
    if (fs.existsSync(file)) return file;
  }
  throw new Error('Git for Windows Perl missing');
}

function workspace(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beerpowers-integrations-'));
  const root = path.join(temp, 'workspace with spaces');
  fs.mkdirSync(root);
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4 });
  });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(temp, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'example@example.invalid',
    GIT_COMMITTER_EMAIL: 'example@example.invalid', GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    BEERPOWERS_NODE: process.execPath, BEERPOWERS_TESTS_JSON: JSON.stringify(tests),
    BEERPOWERS_TASK_JSON: JSON.stringify(brief), BEERPOWERS_GIT_TASKS: JSON.stringify({ [key]: { repos: ['api','web'] } }) };
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore','pipe','pipe'] }).trim();
  const put = (rel, value) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
  const run = (cmd, ...args) => exec(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: 90000, windowsHide: true });
  const perlPath = perl();
  const route = (...args) => run(perlPath, path.join(bin, 'workspace.pl'), ...args);
  const node = (command, ...args) => run(process.execPath, path.join(bin, command + '.mjs'), ...args);
  git(root, 'init', '-qb', 'workspace');
  put('.codex/git-settings.json', JSON.stringify({ repos: { api: 'dev-default', web: 'main-default' } }));
  const heads = {};
  for (const [name, base] of [['api','dev'], ['web','main']]) {
    const repo = path.join(root, 'projects', name);
    put(`projects/${name}/README.md`, `# ${name}\n\nRun git diff --check.\n`);
    put(`projects/${name}/index.html`, '<button id="buy" style="width: 120px">Buy</button>\n');
    git(repo, 'init', '-qb', base);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'seed ' + name);
    if (name === 'api') git(repo, 'branch', 'main');
    const bare = path.join(temp, name + '.git');
    git(repo, 'clone', '-q', '--bare', '.', bare);
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'remote', 'set-head', 'origin', base);
    heads[name] = git(repo, 'rev-parse', 'HEAD');
  }
  return { temp, root, git, put, read, route, node, env, heads };
}

async function server(t, handler) {
  const srv = http.createServer(handler);
  await new Promise((resolve,reject) => srv.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    srv.closeAllConnections();
    await new Promise(resolve => srv.close(resolve));
  });
  return 'http://127.0.0.1:' + srv.address().port;
}

test('task-start selects a project tracker, caches its snapshot and accepts without a second fetch', async t => {
  const {root,git,put,route,env} = workspace(t);
  await route('apply');
  const source = `
    import fs from 'node:fs';
    const [action,key,,,file, ,directory] = process.argv.slice(2);
    if (action !== 'read' || !file || !directory) throw Error('Bad read arguments');
    fs.writeFileSync(file,'# ' + key + ' · проектный трекер\\n');
    fs.mkdirSync(directory);
    console.log(JSON.stringify({key}));
  `;
  put('.codex/bin/acme-tracker.mjs',source);
  put('.codex/bin/second-tracker.mjs',source);
  git(root,'add','.');
  git(root,'commit','-qm','configured adapters');
  await assert.rejects(route('task-start',key,'--preview'),/acme.*second/);
  env.BEERPOWERS_TRACKER_ADAPTER = 'acme';
  await route('task-start',key,'--preview');
  assert.match(fs.readFileSync(path.join(root,'.codex/.cache/task-start',key,'task.md'),'utf8'),/проектный трекер/);
  const {digest} = JSON.parse(fs.readFileSync(path.join(root,'.codex/.cache/task-start',key,'plan.json'),'utf8'));
  env.BEERPOWERS_TRACKER_DIGESTS = JSON.stringify({[key]:digest});
  delete env.BEERPOWERS_TRACKER_ADAPTER;
  await route('task-start',key);
  assert.match(fs.readFileSync(path.join(root,'memory/tasks',key,'tracker/task.md'),'utf8'),/проектный трекер/);
});

test('workspace.pl configures two repositories, previews and resumes the tracker task through the public route', async t => {
  const { root, git, put, read, route, env, heads } = workspace(t);
  const issue = { key, summary: 'Изменить карточку', description: 'Показать дату заказа.', status: { display: 'Открыта' } };
  let denied = false;
  const requests = [];
  env.YANDEX_TRACKER_API_HOST = await server(t, (req, res) => {
    requests.push(req.method + ' ' + req.url);
    const route = new URL(req.url, 'http://localhost').pathname;
    const prefix = '/v2/issues/' + key;
    if (denied) { res.writeHead(403); res.end('{}'); return; }
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'OAuth fixture');
    if (route === '/download/sample.txt') { res.end('sample fixture'); return; }
    const payload = route === prefix ? issue : route === prefix + '/comments' ? [{ id: 1, text: 'Сохранить порядок строк.', createdBy: { display: 'Оператор' } }] :
      route === prefix + '/attachments' ? [{ id: '10', name: 'sample.txt', content: '/download/sample.txt' }] : null;
    res.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });

  await route('plan');
  assert(!fs.existsSync(path.join(root, 'memory')));
  await route('apply');
  await route('doctor');
  for (const name of Object.keys(tests)) assert.match(read('memory/commands/' + name + '.md'), /git diff --check/);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'configured');
  const before = git(root, 'rev-parse', 'HEAD');
  const api = path.join(root, 'projects/api');
  const web = path.join(root, 'projects/web');
  const folder = 'memory/tasks/' + key;
  put('projects/api/local.txt', 'existing checkout state\n');
  denied = true;
  await assert.rejects(route('task-start', key, '--preview'), /403|unavailable/i);
  assert(!fs.existsSync(path.join(root, folder)));
  denied = false;
  await route('task-start', key, '--preview');
  assert(!fs.existsSync(path.join(root, folder)));
  assert.match(read('.codex/.cache/task-start/' + key + '/task.md'), /Сохранить порядок строк/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(api, 'branch', '--show-current'), 'dev');
  assert.equal(git(web, 'branch', '--show-current'), 'main');

  await route('task-start', key);
  assert.equal(read('projects/api/local.txt'), 'existing checkout state\n');
  assert.equal(git(api, 'branch', '--show-current'), 'dev');
  assert.equal(git(web, 'branch', '--show-current'), key);
  const linked = path.join(root, 'worktrees', key, 'api');
  assert.equal(git(linked, 'branch', '--show-current'), key);
  const recorded = JSON.parse(read(folder + '/checkouts.json')).repos;
  for (const [name, base, checkout] of [['api','dev','worktrees/' + key + '/api'], ['web','main','projects/web']]) {
    const row = recorded.find(r => r.name === name);
    assert.equal(row.base, base);
    assert.equal(row.baseSha, heads[name]);
    assert.equal(row.checkout, checkout);
    assert.equal(git(path.join(root, checkout), 'rev-parse', 'HEAD'), heads[name]);
  }
  const start = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(start, before);
  const paths = git(root, 'diff', '--name-only', before, start).split(/\r?\n/);
  for (const name of ['preflight.md', 'checkouts.json', 'tracker/task.md']) assert(paths.includes(folder + '/' + name), name);
  assert(!paths.some(p => p.includes('task-attachment')));
  assert.match(read(folder + '/preflight.md'), /Показать дату заказа|tracker\/task\.md/);
  assert.equal(read(folder + '/tracker/task-attachment/sample.txt'), 'sample fixture');
  const original = read(folder + '/tracker/task.md');
  const beforeResume = requests.length;
  await route('task-start', key);
  assert(requests.length > beforeResume, 'resume checks the current tracker state');
  assert.equal(git(root, 'rev-parse', 'HEAD'), start);
  assert.equal(read(folder + '/tracker/task.md'), original);

  issue.description += ' Добавить дату возврата.';
  const preview = await route('task-start', key, '--preview');
  assert.match(preview.stdout, /Добавить дату возврата|Описание/);
  assert.equal(read(folder + '/tracker/task.md'), original);
  assert.equal(git(root, 'rev-parse', 'HEAD'), start);
  await route('task-start', key);
  const changed = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(changed, start);
  assert.match(git(root, 'show', 'HEAD:' + folder + '/tracker/task.md'), /Добавить дату возврата/);
  await route('task-start', key);
  assert.equal(git(root, 'rev-parse', 'HEAD'), changed);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(linked, 'rev-parse', 'HEAD'), heads.api);
  assert.equal(git(web, 'rev-parse', 'HEAD'), heads.web);
});

test('layout-check separates a label edit from a measured change to button width', async t => {
  const { root, git, put, read, node } = workspace(t);
  const checkout = path.join(root, 'projects/web');
  put('.codex/workspace.json', JSON.stringify({ schemaVersion: 1 }));
  git(checkout, 'switch', '-c', key);
  put('projects/web/index.html', '<button id="buy" style="width: 120px">Pay</button>\n');
  assert.match((await node('layout-check', key, 'web')).stdout, /^pass  index\.html$/m);
  const uri = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(read('projects/web/index.html'));
  });
  put('scenario.json', JSON.stringify({ baseUrl: uri, scenarios: [{ name: 'width', viewport: 'desktop',
    steps: [{ goto: '/' }, { wait: { selector: '#buy' } }], state: { width: 'document.querySelector("#buy").getBoundingClientRect().width' } }] }));
  async function width(out) {
    await node('cdp-run', 'scenario.json', '--out', out);
    const row = JSON.parse(read(out).trim());
    assert.equal(row.ok, true);
    return row.state.width;
  }
  assert.equal(await width('before.jsonl'), 120);
  put('projects/web/index.html', '<button id="buy" style="width: 260px">Pay</button>\n');
  await assert.rejects(node('layout-check', key, 'web'), err => err.code === 1 && /^fail  index\.html.*style/m.test(err.stdout));
  assert.equal(await width('after.jsonl'), 260);
});

// Управляет Git-базами задач, инвентарём репозиториев и жизненным циклом рабочих деревьев.
import fs from 'node:fs';
import {formatFlow} from './git-flow-format.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cleanupTaskCode, cleanupInventory } from './lib/cleanup-paths.mjs';
import { runProjectHook as invokeHook } from './lib/project-worktree-hooks.mjs';
import { root, safe, fail, git, branchName, discover, remoteState, profileDetails, proposeProfile, taskData,
  worktrees, checkedOut, taskCheckout, localSha, resolveLocal, mergeEvidence, fetchBranch } from './lib/git-repositories.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp(`git-workspace.mjs setup|doctor|profiles
git-workspace.mjs resolve TASK REPO
git-workspace.mjs task-checkout TASK [REPO]
git-workspace.mjs merged TASK [--repo REPO]
git-workspace.mjs task-plan|task-start TASK... [--repo REPO] [--worktree] [--copy-env] [--no-deps] [-- HOOK_ARGS...]
git-workspace.mjs worktrees-clear [TASK...] [--force] [--apply --confirm HASH]`,
  ['setup', 'doctor', 'profiles', 'resolve', 'task-checkout', 'merged', 'task-plan', 'task-start', 'worktrees-clear']);

const [command, ...args] = process.argv.slice(2);
const options = { codes: [], repo: [], flags: [], copyEnv: false, noDeps: false, worktree: false, apply: false };
function parse() {
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { if (literal) options.flags.push(arg); literal = true; }
    else if (arg === '--copy-env') options.copyEnv = true;
    else if (arg === '--no-deps') options.noDeps = true;
    else if (literal) options.flags.push(arg);
    else if (arg === '--worktree') options.worktree = true;
    else if (arg === '--force' && command === 'worktrees-clear') options.force = true;
    else if (arg === '--workspace-clean' && command === 'worktrees-clear') options.workspaceClean = true;
    else if (arg === '--refresh-evidence' && command === 'worktrees-clear') options.refreshEvidence = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--confirm' && args[i + 1]) options.confirm = args[++i];
    else if (arg === '--repo' && args[i + 1]) options.repo.push(args[++i]);
    else if (arg.startsWith('-')) fail('Unknown flag: ' + arg);
    else options.codes.push(arg);
  }
}

const repoByName = (repos, name) => repos.find(r => r.name === name) || fail('Unknown product: ' + name);
const envFiles = ['.env', '.env.testing', '.env.local'];
const runProjectHook = (kind, code, repo, checkout) => invokeHook(kind, code, repo.name, checkout, { flags: options.flags });
function installDependencies(checkout) {
  const jobs = [];
  if (fs.existsSync(safe(checkout + '/pnpm-lock.yaml'))) jobs.push(['pnpm', 'install', '--frozen-lockfile']);
  else if (fs.existsSync(safe(checkout + '/package-lock.json'))) jobs.push(['npm', 'ci']);
  if (fs.existsSync(safe(checkout + '/composer.lock'))) jobs.push(['composer', 'install', '--no-interaction']);
  const results = [];
  for (const [program, ...argv] of jobs) {
    // Windows package managers are commonly .cmd/.bat. Only fixed program names and
    // constant arguments enter cmd.exe; cwd is passed separately as a native path.
    const windows = process.platform === 'win32';
    if (windows && spawnSync('where.exe', [program], { windowsHide: true, stdio: 'ignore' }).status !== 0) {
      results.push({ program, status: 'missing' }); continue;
    }
    const p = spawnSync(windows ? 'cmd.exe' : program, windows ? ['/d', '/c', program, ...argv] : argv,
      { cwd: safe(checkout), stdio: 'ignore', windowsHide: true });
    if (p.error?.code === 'ENOENT') results.push({ program, status: 'missing' });
    else if (p.status !== 0) fail('Dependency install failed (' + program + ') in ' + checkout);
    else results.push({ program, status: 'installed' });
  }
  return results;
}
function prepare(record, code, fresh) {
  if (record.checkout === record.path) {
    if (options.flags.length || options.copyEnv || options.noDeps) record.flagsUnused = true;
    return;
  }
  const marker = git(safe(record.checkout), ['rev-parse', '--path-format=absolute', '--git-path', 'beerpowers-setup-pending']);
  if (fresh) fs.writeFileSync(marker, 'pending\n', { flag: 'wx' });
  record.environment = {};
  for (const name of envFiles) {
    const source = safe(record.path + '/' + name);
    if (!fs.existsSync(source)) continue;
    if (!fs.statSync(source).isFile()) fail('Invalid environment file: ' + name);
    record.environment[name] = 'available';
    if (options.copyEnv) {
      const dest = safe(record.checkout + '/' + name);
      if (fs.existsSync(dest)) record.environment[name] = 'already present';
      else { fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL); record.environment[name] = 'copied'; }
    }
  }
  if (!fs.existsSync(marker)) {
    if (options.flags.length) record.flagsUnused = true;
    return;
  }
  record.installs = options.noDeps ? [] : installDependencies(record.checkout);
  record.setup = runProjectHook('setup', code, record, record.checkout);
  if (!record.setup && options.flags.length) record.flagsUnused = true;
  fs.unlinkSync(marker);
}

function projectFree(repo, state) {
  const abs = safe(repo.path);
  if (git(abs, ['branch', '--show-current']) !== state.defaultBranch ||
      git(abs, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) return false;
  const gitDir = git(abs, ['rev-parse', '--absolute-git-dir']);
  return !['index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply',
    'BISECT_START', 'sequencer'].some(f => fs.existsSync(path.join(gitDir, f)));
}
function selected(repos, names) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) fail('Expected distinct product names');
  return names.map(name => repoByName(repos, name));
}
function plan(repos) {
  if (!options.codes.length) fail('Expected at least one task');
  let input;
  try { input = JSON.parse(process.env.BEERPOWERS_GIT_TASKS || '{}'); } catch { fail('Invalid BEERPOWERS_GIT_TASKS'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Expected object in BEERPOWERS_GIT_TASKS');
  const tasks = [];
  const remote = new Map();
  const occupied = new Set();
  const seenCodes = new Set();
  for (const token of options.codes) {
    const [code, release, ...extra] = token.split('@');
    branchName(code, true);
    if (release !== undefined) branchName(release);
    if (extra.length || seenCodes.has(code.toLowerCase())) fail('Invalid or repeated task: ' + token);
    seenCodes.add(code.toLowerCase());
    const data = taskData(code);
    const spec = Object.hasOwn(input, code) ? input[code] : {};
    const dependencies = spec.dependencies ?? data.dependencies;
    if (!Array.isArray(dependencies)) fail('Expected dependencies array');
    for (const d of dependencies) { branchName(d, true); if (d === code) fail('Task depends on itself: ' + code); }
    let names = spec.repos ?? (options.repo.length ? options.repo : data.saved.repos?.map(r => r.name));
    if (!names && repos.length !== 1) fail('Select task products with --repo or BEERPOWERS_GIT_TASKS');
    names ??= [repos[0].name];
    const task = { code, dependencies, repos: [] };
    let releaseFound = false;
    for (const repo of selected(repos, names)) {
      if (!remote.has(repo.name)) remote.set(repo.name, remoteState(repo));
      const state = remote.get(repo.name);
      const details = profileDetails(repo, state);
      const explicit = spec.bases && Object.hasOwn(spec.bases, repo.name) ? branchName(spec.bases[repo.name]) : null;
      const releaseBase = release && state.heads.has(release) ? release : null;
      if (releaseBase) releaseFound = true;
      if (explicit && releaseBase && explicit !== releaseBase) fail('Conflicting bases in ' + repo.name);
      const savedBase = data.rows.get(repo.name)?.base;
      const chosen = explicit || releaseBase;
      if (savedBase && chosen && savedBase !== chosen) fail('Base differs from git-flow.md for ' + repo.name);
      const base = savedBase || chosen || (repo.profile !== 'custom' && details.defaultBranch);
      if (!base) fail('custom requires explicit base for ' + repo.name);
      if (code.toLowerCase() === base.toLowerCase() || [details.defaultBranch, 'master', 'main'].some(b => b.toLowerCase() === code.toLowerCase())) {
        fail('Task collides with protected branch or base: ' + code);
      }
      const previous = tasks.flatMap(t => t.repos.map(r => ({ code: t.code, repo: r })))
        .find(t => t.code === base && t.repo.name === repo.name);
      const baseTip = state.heads.get(base) || localSha(repo, 'refs/heads/' + base) || previous?.repo.baseSha;
      if (!baseTip) fail('Missing base ' + base + ' in ' + repo.name);
      const saved = data.saved.repos?.find(r => r.name === repo.name);
      const pinned = data.pins.get(repo.name) ?? data.pins.get(undefined) ?? saved?.baseSha;
      const existing = taskCheckout(repo, code, saved, pinned);
      const baseSha = pinned ?? baseTip;
      if (existing === repo.path && options.worktree) fail('Task branch already in product checkout: ' + repo.path);
      const taskTree = 'worktrees/' + code + '/' + repo.name;
      const free = !occupied.has(repo.name) && projectFree(repo, state);
      const checkout = existing || (options.worktree || !free ? taskTree : repo.path);
      if (checkout === repo.path) occupied.add(repo.name);
      else if (!existing && fs.existsSync(safe(checkout))) fail('Unregistered checkout path: ' + checkout);
      const localTask = localSha(repo, 'refs/heads/' + code);
      if (!localTask && !existing) {
        const refs = git(safe(repo.path), ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/']).split('\n');
        for (const other of [...refs, ...state.heads.keys(), ...tasks.filter(t => t.repos.some(r => r.name === repo.name)).map(t => t.code)]) {
          if (other === code) continue;
          const l = other.toLowerCase(), r = code.toLowerCase();
          if (l === r || l.startsWith(r + '/') || r.startsWith(l + '/')) fail('Conflicting task ref: ' + other);
        }
      }
      task.repos.push({ ...repo, ...details, checkout, base, baseSha, baseTip, target: base,
        releaseMode: data.rows.get(repo.name)?.releaseMode || (repo.profile === 'dev-default' ? 'плановый' : null),
        existing: Boolean(existing), branchSha: localTask || state.heads.get(code) || null,
        baseOnOrigin: state.heads.has(base), taskOnOrigin: state.heads.has(code),
        override: Boolean(chosen || savedBase) });
    }
    if (release && !releaseFound) fail('Release branch missing on selected origins: ' + release);
    if (fs.existsSync(data.file)) {
      for (const r of task.repos) {
        if (r.override && data.rows.get(r.name)?.base !== r.base) fail('Record base in existing git-flow.md for ' + r.name);
      }
      if (spec.dependencies && dependencies.some(d => !data.dependencies.includes(d))) fail('Record dependencies in existing git-flow.md');
    }
    tasks.push(task);
  }
  return tasks;
}
function persistFlow(task) {
  const data = taskData(task.code);
  const changes = task.repos.filter(r => r.override);
  if (fs.existsSync(data.file) || (!changes.length && !task.dependencies.length)) return;
  fs.mkdirSync(safe(data.dir), { recursive: true });
  const tmp = path.join(safe('.git'), 'beerpowers-flow-' + randomUUID());
  fs.writeFileSync(tmp, formatFlow(task), { flag: 'wx' });
  try { fs.linkSync(tmp, data.file); } finally { fs.unlinkSync(tmp); }
}
function start(task) {
  persistFlow(task);
  for (const r of task.repos) {
    const abs = safe(r.path);
    const code = task.code;
    const existing = checkedOut(r, code);
    if (!existing) {
      if (r.baseOnOrigin && fetchBranch(r, r.base) !== r.baseTip) fail('Base moved; replan ' + code);
      const localTask = localSha(r, 'refs/heads/' + code);
      if (!localTask && r.taskOnOrigin && fetchBranch(r, code) !== r.branchSha) fail('Remote task changed; replan ' + code);
      const startSha = r.branchSha || r.baseSha;
      if (r.checkout === r.path) {
        if (!projectFree(r, r)) fail('Product became busy: ' + r.name);
        git(abs, localTask ? ['checkout', '--no-overwrite-ignore', code] :
          ['checkout', '--no-overwrite-ignore', '--no-track', '-b', code, startSha]);
      } else {
        fs.mkdirSync(path.dirname(safe(r.checkout)), { recursive: true });
        git(abs, localTask ? ['worktree', 'add', safe(r.checkout), code] :
          ['worktree', 'add', '--no-track', '-b', code, safe(r.checkout), startSha]);
      }
    }
    if (checkedOut(r, code) !== r.checkout) fail('Task checkout changed: ' + r.checkout);
    // Клоны с вручную добавленным origin могут ещё не знать его HEAD локально.
    if (r.base === r.defaultBranch && !git(abs, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], true))
      git(abs, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + r.defaultBranch]);
    prepare(r, code, !existing);
  }
}
function merged(repo, code, state) {
  const head = localSha(repo, 'refs/heads/' + code);
  if (!head) return null;
  const data = taskData(code);
  const base = data.rows.get(repo.name)?.base ?? data.saved.repos?.find(r => r.name === repo.name)?.base;
  for (const target of new Set([base, state.defaultBranch])) {
    if (!target || target === code || !state.heads.has(target)) continue;
    const sha = fetchBranch(repo, target);
    const by = mergeEvidence(repo, head, sha);
    if (by) return { name: repo.name, branch: code, head, target, targetSha: sha, merged: true, by };
  }
  return { name: repo.name, branch: code, head, target: base || state.defaultBranch, merged: false, by: null };
}
function cleanupStatus(checkout) {
  const cwd = safe(checkout);
  const entries = git(cwd, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--ignore-submodules=none']);
  const blocked = [], ignoredDerived = [], retainedEnv = [];
  for (const entry of entries.split('\0').filter(Boolean)) {
    // Only Git's exact whole-directory ignore is eligible. Mixed tracked and
    // ignored subpaths, links, and independently checked-out roots stay blocked.
    const dependency = /^!! (node_modules|vendor)\/$/.exec(entry)?.[1];
    if (dependency) {
      const rel = checkout + '/' + dependency;
      const dir = path.join(cwd, dependency);
      const stat = fs.lstatSync(dir, { bigint: true });
      if (stat.isDirectory() && !fs.existsSync(path.join(dir, '.git')) && !git(cwd, ['ls-files', '-z', '--', dependency])) {
        const children = fs.readdirSync(dir).sort();
        const inventory = createHash('sha256').update(JSON.stringify([String(stat.dev), String(stat.ino), String(stat.mtimeNs), children])).digest('hex');
        ignoredDerived.push({ path: rel, topLevelEntries: children.length, inventory });
        continue;
      }
    }
    blocked.push(entry);
    if (envFiles.includes(entry.slice(3))) retainedEnv.push(checkout + '/' + entry.slice(3));
  }
  const result = { status: blocked.join('\n'), ignoredDerived };
  if (retainedEnv.length) {
    result.retainedEnv = retainedEnv;
    result.reason = 'Environment files retained; copy approval does not establish unchanged content or authorize removal';
  }
  return result;
}
function scopedHead(repo, entry) {
  const checkout = safe(entry.checkout);
  if (!fs.lstatSync(safe(entry.checkout + '/.git'), { throwIfNoEntry: false })?.isFile() ||
      git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !==
      git(safe(repo.path), ['rev-parse', '--path-format=absolute', '--git-common-dir']) ||
      (git(checkout, ['symbolic-ref', '-q', '--short', 'HEAD'], true) ?? undefined) !== entry.branch) {
    fail('Unexpected checkout: ' + entry.checkout);
  }
  return git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}']);
}
function scopedEvidence(repo, entry, code) {
  const head = scopedHead(repo, entry);
  const stand = /^chore-(.+)-rebuild$/.exec(code)?.[1];
  const data = stand ? null : taskData(code, { legacy: true });
  const base = stand ?? data.rows.get(repo.name)?.base ?? data.saved.repos?.find(r => r.name === repo.name)?.base;
  let state, remoteError;
  try { state = remoteState(repo); }
  catch (error) {
    if (!options.force || !entry.branch) throw error;
    remoteError = error.message;
  }
  const targets = stand ? [stand] : [base, state?.defaultBranch];
  const result = { name: repo.name, head, target: base ?? state?.defaultBranch, merged: false, by: null };
  const unavailable = new Set();
  function targetObject(target) {
    const sha = state?.heads.get(target);
    if (!sha) return;
    if (!localSha(repo, sha) && options.refreshEvidence) {
      // Receive objects only. Do not update remote-tracking refs or FETCH_HEAD.
      git(safe(repo.path), ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance',
        '--refmap=', 'origin', 'refs/heads/' + branchName(target)]);
    }
    if (localSha(repo, sha) === sha) return sha;
    unavailable.add('origin/' + target);
  }
  for (const target of new Set(targets)) {
    const targetSha = targetObject(target);
    if (!targetSha) continue;
    const by = mergeEvidence(repo, head, targetSha);
    if (by && (!stand || by === 'ancestor')) {
      Object.assign(result, { target, targetSha, merged: true, by });
      break;
    }
  }
  if (options.force && entry.branch) {
    const against = [entry.branch, result.target, state?.defaultBranch].find(target => state?.heads.has(target));
    const upstream = targetObject(against);
    if (upstream) {
      result.unpublishedAgainst = 'origin/' + against;
      result.unpublished = git(safe(repo.path), ['rev-list', head, '^' + upstream]).split('\n').filter(Boolean);
    } else {
      result.unpublishedReason = remoteError || 'Нет доступной вершины origin для проверки неопубликованных коммитов';
    }
  }
  if (!result.merged) {
    if (!entry.branch && options.force) result.reason = 'Detached HEAD: сначала сохрани вершину в локальной ветке';
    else if (unavailable.size) result.reason = 'Нет локальных объектов для ' + [...unavailable].join(', ') + '; получи их через git fetch origin';
    else if (stand) result.reason = 'Вершина не отправлена в origin/' + stand;
  }
  return result;
}
function clear(repos) {
  const candidates = [];
  const seen = new Set();
  if (options.workspaceClean && options.codes.length !== 1) fail('Expected one task checkout path');
  if (options.refreshEvidence && !options.workspaceClean) fail('Invalid cleanup evidence refresh');
  const codes = options.codes.map(c => {
    if (!options.workspaceClean) return branchName(c, true);
    if (!cleanupTaskCode(c)) fail('Invalid task path: ' + c);
    return c;
  });
  const scope = options.workspaceClean ? codes[0] : null;
  for (const repo of repos) {
    let state;
    for (const entry of worktrees(repo)) {
      if (!entry.checkout.startsWith('worktrees/')) continue;
      const standTask = /^worktrees\/(chore-[^/]+-rebuild)\/[^/]+$/.exec(entry.checkout)?.[1];
      const code = standTask ?? entry.branch;
      seen.add(entry.checkout);
      if (scope ? entry.checkout !== 'worktrees/' + scope + '/' + repo.name : codes.length && !codes.includes(code)) continue;
      if (!scope && (!code || entry.checkout !== 'worktrees/' + branchName(code, true) + '/' + repo.name)) {
        candidates.push({ ...entry, eligible: false, reason: 'unexpected worktree layout' }); continue;
      }
      if (entry.locked || !fs.existsSync(safe(entry.checkout))) {
        candidates.push({ ...entry, eligible: false, reason: 'locked or missing worktree' }); continue;
      }
      if (!scope && !standTask && checkedOut(repo, code) !== entry.checkout) fail('Unexpected checkout: ' + code);
      if (!scope) state ??= remoteState(repo);
      const evidence = scope || standTask ? scopedEvidence(repo, entry, scope ?? standTask) : merged(repo, code, state);
      if (scope) cleanupInventory(safe(entry.checkout), entry.checkout, { gitFile: true });
      const stateOfFiles = cleanupStatus(entry.checkout);
      const result = { ...entry, ...evidence, ...stateOfFiles,
        eligible: (evidence.merged || Boolean(options.force && entry.branch && (scope || !standTask))) && !stateOfFiles.status };
      if (standTask) result.standTask = standTask;
      if (options.force && !scope) {
        // The branch itself always survives removal. Report commits absent from
        // its advertised remote branch, falling back to its nearest remote target.
        const against = state.heads.has(code) ? code :
          (state.heads.has(evidence.target) ? evidence.target : state.defaultBranch);
        const upstream = fetchBranch(repo, against);
        result.unpublishedAgainst = 'origin/' + against;
        result.unpublished = git(safe(repo.path), ['rev-list', evidence.head, '^' + upstream]).split('\n').filter(Boolean);
      }
      candidates.push(result);
    }
  }
  // Unregistered directories have no Git evidence; expose them without deleting files.
  const treeRoot = safe('worktrees');
  function inspect(rel) {
    for (const item of fs.readdirSync(safe(rel), { withFileTypes: true })) {
      const next = rel + '/' + item.name;
      if (seen.has(next)) continue;
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      const code = rel.slice('worktrees/'.length);
      if (repos.some(r => r.name === item.name) && code) {
        if (!codes.length || codes.includes(code)) candidates.push({ checkout: next, eligible: false, reason: 'unregistered directory' });
      } else if (!fs.existsSync(safe(next + '/.git'))) inspect(next);
    }
  }
  if (!scope && fs.existsSync(treeRoot)) inspect('worktrees');
  candidates.sort((a, b) => a.checkout.localeCompare(b.checkout));
  const hash = createHash('sha256').update(JSON.stringify([root, candidates, options.flags, Boolean(options.force)])).digest('hex');
  const removed = [];
  if (options.apply) {
    if (hash !== options.confirm) fail('Confirmation missing or cleanup plan changed; review worktrees-clear again');
    if (scope && candidates.some(r => !r.eligible)) fail('A checkout blocks workspace-clean for ' + scope);
    const eligible = candidates.filter(r => r.eligible);
    function verify(r, afterTeardown) {
      const repo = repoByName(repos, r.name);
      if (afterTeardown && (!options.force || !r.branch || (r.standTask && !scope))) {
        const latest = scope || r.standTask ? scopedEvidence(repo, r, scope ?? r.standTask) : merged(repo, r.branch, remoteState(repo));
        if (!latest?.merged || latest.target !== r.target || latest.targetSha !== r.targetSha) {
          fail('Merge evidence changed during cleanup: ' + r.checkout);
        }
      }
      if (scope) cleanupInventory(safe(r.checkout), r.checkout, { gitFile: true });
      const now = cleanupStatus(r.checkout);
      // Teardown can remove a directory it owns. Any remaining directory
      // must still have the top-level inventory shown in the approved plan.
      const known = new Map(r.ignoredDerived.map(d => [d.path, d.inventory]));
      const changed = scope || r.standTask ? scopedHead(repo, r) !== r.head :
        checkedOut(repo, r.branch) !== r.checkout || localSha(repo, 'refs/heads/' + r.branch) !== r.head;
      if (changed || now.status || (!afterTeardown && now.ignoredDerived.length !== known.size) ||
          now.ignoredDerived.some(d => known.get(d.path) !== d.inventory)) {
        fail('Cleanup candidate changed: ' + r.checkout);
      }
    }
    if (scope) {
      for (const r of eligible) verify(r, false);
      for (const r of eligible) runProjectHook('teardown', scope, repoByName(repos, r.name), r.checkout);
      for (const r of eligible) verify(r, true);
    }
    for (const r of eligible) {
      const repo = repoByName(repos, r.name);
      if (!scope) {
        verify(r, false);
        runProjectHook('teardown', r.standTask ?? r.branch, repo, r.checkout);
        verify(r, true);
      }
      git(safe(repo.path), ['worktree', 'remove', safe(r.checkout)]);
      if (fs.existsSync(safe(r.checkout))) fail('Git left checkout directory: ' + r.checkout);
      const parent = path.dirname(safe(r.checkout));
      if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      removed.push(r.checkout);
    }
  }
  return { candidates, planHash: hash, removed };
}
function main() {
  parse();
  const repos = discover();
  if (command === 'setup' || command === 'doctor') return { repos };
  if (command === 'profiles') return { repos: repos.map(proposeProfile) };
  if (command === 'resolve' && options.codes.length === 2) return resolveLocal(repoByName(repos, options.codes[1]), options.codes[0]);
  if (command === 'task-checkout' && [1,2].includes(options.codes.length)) {
    const [code, selected] = options.codes;
    const {saved, pins} = taskData(code);
    const scope = saved.repos ?? repos;
    const name = selected || (scope.length === 1 && scope[0].name);
    if (!name || !scope.some(r => r.name === name)) fail('Choose BEERPOWERS_REPO for ' + code);
    const repo = repoByName(repos, name);
    const record = saved.repos?.find(r => r.name === name);
    const baseSha = pins.get(name) ?? pins.get(undefined) ?? record?.baseSha;
    const checkout = taskCheckout(repo, code, record, baseSha);
    if (!checkout) fail('Task branch not checked out: ' + code + ' in ' + name);
    return {name, checkout, multi:scope.length > 1 && Boolean(saved.repos), baseSha};
  }
  if (command === 'merged' && options.codes.length === 1) {
    const code = branchName(options.codes[0], true);
    const data = taskData(code);
    const expected = data.saved.repos?.map(r => r.name) ?? [];
    const names = options.repo.length ? options.repo : expected;
    const involved = names.length ? selected(repos, names) : repos;
    const rows = [];
    for (const r of involved) if (localSha(r, 'refs/heads/' + code)) rows.push(merged(r, code, remoteState(r)));
    return { code, merged: rows.length > 0 && rows.every(r => r.merged) && (!names.length || rows.length === involved.length), repos: rows };
  }
  if (command === 'task-plan') {
    const tasks = plan(repos);
    return { tasks, planHash: createHash('sha256').update(JSON.stringify(tasks)).digest('hex') };
  }
  if (!['task-start', 'worktrees-clear'].includes(command)) fail('Unknown or incomplete Git command: ' + command);
  if (command === 'worktrees-clear' && options.workspaceClean && !options.apply && !options.refreshEvidence) {
    return clear(options.repo.length ? selected(repos, options.repo) : repos);
  }
  // Git locks individual references; this lock also serializes checkout selection across repositories.
  const lock = safe('.git/beerpowers-products.lock');
  const fd = fs.openSync(lock, 'wx');
  try {
    if (command === 'worktrees-clear') return clear(options.repo.length ? selected(repos, options.repo) : repos);
    const tasks = plan(repos);
    if (process.env.BEERPOWERS_GIT_PLAN && createHash('sha256').update(JSON.stringify(tasks)).digest('hex') !== process.env.BEERPOWERS_GIT_PLAN) {
      fail('Git plan changed; inspect a fresh task plan');
    }
    for (const t of tasks) start(t);
    return { tasks };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
try { process.stdout.write(JSON.stringify(main()) + '\n'); }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }

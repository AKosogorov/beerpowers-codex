// Находит Git-репозитории в projects/ и читает их профили веток и рабочие деревья.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupTaskCode } from './cleanup-paths.mjs';
import { markupLines } from './markdown-engine.mjs';

export function fail(message) { throw new Error(message); }
export const root = fs.realpathSync.native('.');
export const modes = ['main-default', 'dev-default', 'custom'];

// Validate every existing component, including dangling links and junctions.
export function safe(rel) {
  let current = root;
  for (const part of rel.split('/')) {
    if (!part || /^\.{1,2}$/.test(part) || /[\\:\x00-\x1f]/.test(part)) fail('Unsafe path: ' + rel);
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) fail('Linked path: ' + rel);
  }
  return current;
}
export function branchName(value, task = false) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
      value.length > 200 || value.split('/').some(p => !p || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
      p.startsWith('.') || p.endsWith('.') || /\.lock$/i.test(p)) || value.includes('..') ||
      /^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|REVERT_HEAD|AUTO_MERGE)$/i.test(value)) {
    fail('Invalid ' + (task ? 'task' : 'branch') + ' name: ' + value);
  }
  return value;
}
export function git(cwd, args, optional = false) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 45000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error) fail('Git ' + args[0] + ' failed: ' + result.error.code);
  if (result.status !== 0) {
    if (optional) return null;
    // Remote and credential helper errors may contain authenticated URLs.
    fail('Git ' + args[0] + ' failed in ' + path.relative(root, cwd) + ' (exit ' + result.status + ')');
  }
  return result.stdout.trimEnd();
}
export function readJson(rel, fallback) {
  const file = safe(rel);
  if (!fs.existsSync(file)) return fallback;
  if (!fs.statSync(file).isFile()) fail('Expected file: ' + rel);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { fail('Invalid JSON: ' + rel); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected object: ' + rel);
  return value;
}
export function discover() {
  if (!fs.statSync(safe('.git')).isDirectory() || git(root, ['rev-parse', '--show-prefix'])) fail('Open the outer workspace');
  if (git(root, ['ls-files', '--', 'projects/', 'worktrees/'])) fail('Product checkouts tracked by outer repository');
  const settings = readJson('.codex/git-settings.json', {});
  const profiles = settings.repos ?? {};
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) fail('Invalid repos in git-settings.json');
  const repos = [];
  for (const entry of fs.readdirSync(safe('projects'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const rel = 'projects/' + name;
    if (!fs.existsSync(safe(rel + '/.git'))) continue;
    branchName(name);
    if (git(safe(rel), ['rev-parse', '--show-prefix'])) fail('Invalid product checkout: ' + rel);
    const profile = Object.hasOwn(profiles, name) ? profiles[name] : 'main-default';
    if (!modes.includes(profile)) fail('Invalid Git profile for ' + name);
    repos.push({ name, path: rel, profile, configured: Object.hasOwn(profiles, name) });
  }
  if (!repos.length) fail('No Git products under projects/');
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}
export function remoteState(repo) {
  const refs = git(safe(repo.path), ['ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*']);
  const defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(refs)?.[1];
  if (!defaultBranch) fail('Cannot resolve origin HEAD for ' + repo.name);
  const heads = new Map();
  for (const line of refs.split('\n')) {
    const match = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line);
    if (match) heads.set(match[2], match[1]);
  }
  return { defaultBranch, heads };
}
export function profileDetails(repo, state) {
  const releases = ['master', 'main'].filter(b => state.heads.has(b));
  if (repo.profile === 'dev-default' && (state.defaultBranch !== 'dev' || releases.length !== 1)) {
    fail('dev-default requires origin HEAD dev and one release branch (master or main): ' + repo.name);
  }
  return { defaultBranch: state.defaultBranch, release: repo.profile === 'dev-default' ? releases[0] : null };
}
// Use advertised refs for the current default; the last ten first-parent commits
// distinguish a main-based flow from a release branch fed by dev merges.
export function proposeProfile(repo) {
  const state = remoteState(repo);
  const def = state.defaultBranch;
  const releases = ['master', 'main'].filter(b => state.heads.has(b));
  let proposal = 'custom', reason = 'nonstandard default or ambiguous release branch';
  if (def === 'dev' && releases.length === 1) {
    proposal = 'dev-default'; reason = 'dev is default, release to ' + releases[0];
  } else if (releases.length === 1 && releases[0] === def) {
    const log = git(safe(repo.path), ['log', '--first-parent', '-10', '--format=%P%x09%s', state.heads.get(def)], true);
    if (log === null) { proposal = null; reason = 'advertised history is unavailable locally'; }
    else {
      const history = log.split('\n').map(l => l.split('\t'));
      const direct = history.filter(([p]) => !p.includes(' ')).length;
      const devMerges = history.filter(([p, s]) => p.includes(' ') && /^Merge (?:branch '(?:dev|develop)'|remote-tracking branch 'origin\/(?:dev|develop)')/.test(s)).length;
      if (devMerges && devMerges >= direct) reason = 'release history follows dev but server default is ' + def;
      else { proposal = 'main-default'; reason = 'default ' + def + ', recent history uses direct development'; }
    }
  }
  return { ...repo, defaultBranch: def, releases, proposal, reason };
}
export function taskData(code, { legacy = false } = {}) {
  if (legacy) {
    if (!cleanupTaskCode(code)) fail('Invalid task path: ' + code);
  } else branchName(code, true);
  let parent = 'memory/tasks';
  for (const part of code.split('/')) {
    if (fs.existsSync(safe(parent))) {
      if (fs.readdirSync(safe(parent)).some(p => p !== part && p.toLowerCase() === part.toLowerCase())) {
        fail('Case collision in task path: ' + code);
      }
      if (parent !== 'memory/tasks' && ['preflight.md', 'checkouts.json', 'git-flow.md'].some(f => fs.existsSync(safe(parent + '/' + f)))) {
        fail('Nested task under ' + parent);
      }
    }
    parent += '/' + part;
  }
  const dir = 'memory/tasks/' + code;
  const file = safe(dir + '/git-flow.md');
  // Старые задачи могли хранить состав и базу только в checkouts.json.
  const saved = readJson(dir + '/checkouts.json', {});
  const brief = safe(dir + '/preflight.md');
  const pins = new Map();
  if (fs.existsSync(brief)) {
    for (const {content} of markupLines(fs.readFileSync(brief, 'utf8'))) {
      if (!/^Base-SHA(?: |:)/.test(content)) continue;
      const match = /^Base-SHA(?: ([A-Za-z0-9_][\w.-]*))?: ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(content);
      if (!match || pins.has(match[1])) fail('Invalid or duplicate Base-SHA in ' + dir + '/preflight.md');
      pins.set(match[1], match[2]);
    }
  }
  if (pins.size > 1 && pins.has(undefined)) fail('Ambiguous unqualified Base-SHA in ' + dir + '/preflight.md');
  if (saved.repos) {
    for (const [name, sha] of pins) {
      const record = name ? saved.repos.find(r => r.name === name) : saved.repos.length === 1 && saved.repos[0];
      if (!record && name) saved.repos.push({name, baseSha:sha});
      else if (!record || (record.baseSha && record.baseSha !== sha)) fail('Base-SHA differs from legacy checkouts.json: ' + code);
    }
  } else if (pins.size && !pins.has(undefined)) {
    saved.repos = [...pins].map(([name, baseSha]) => ({name, baseSha}));
  }
  const rows = new Map();
  let dependencies = saved.dependencies ?? [];
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    let table = false;
    for (const line of content.split(/\r?\n/)) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim().replace(/^`|`$/g, ''));
      if (cells.length < 2) { table = false; continue; }
      if (cells[0] === 'Репозиторий' && cells[1] === 'База') { table = true; continue; }
      if (table && !/^:?-+:?$/.test(cells[0])) {
        if (rows.has(cells[0])) fail('Duplicate git-flow row: ' + cells[0]);
        rows.set(cells[0], { base: /^[—-]?$/.test(cells[1]) ? null : branchName(cells[1]), releaseMode: cells[2] });
      }
    }
    const section = /^## Зависимости\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(content)?.[1];
    if (section && !dependencies.length) dependencies = [...section.matchAll(/`([A-Za-z0-9._/-]+)`/g)].map(m => m[1]);
  }
  return { dir, file, saved, rows, dependencies, pins };
}
export function worktrees(repo) {
  const records = [];
  for (const block of git(safe(repo.path), ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
    const fields = block.split('\0');
    const location = fields.find(f => f.startsWith('worktree '));
    if (!location) continue;
    const branch = fields.find(f => f.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);
    const checkout = path.relative(root, path.resolve(location.slice(9))).split(path.sep).join('/');
    records.push({ checkout, branch, locked: fields.some(f => /^locked(?: |$)/.test(f)) });
  }
  return records;
}
export function checkedOut(repo, code) {
  const wt = worktrees(repo).find(r => r.branch === code);
  if (wt && wt.checkout !== repo.path && wt.checkout !== 'worktrees/' + code + '/' + repo.name) {
    fail('Branch ' + code + ' already checked out outside its task path: ' + wt.checkout);
  }
  if (wt && git(safe(wt.checkout), ['symbolic-ref', '-q', '--short', 'HEAD']) !== code) fail('Branch changed: ' + code);
  return wt?.checkout;
}
export function localSha(repo, ref) {
  return git(safe(repo.path), ['rev-parse', '--verify', '-q', ref + '^{commit}'], true);
}
export function taskCheckout(repo, code, record, pinned) {
  const checkout = checkedOut(repo, code);
  if (!checkout) return null;
  if (record?.checkout && record.checkout !== checkout) fail('Legacy checkout differs from Git: ' + repo.name);
  if (pinned && (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pinned) ||
      git(safe(checkout), ['merge-base', '--is-ancestor', pinned, 'HEAD'], true) === null)) {
    fail('Invalid saved base SHA for ' + repo.name);
  }
  return checkout;
}
export function resolveLocal(repo, code) {
  const { rows, saved, pins } = taskData(code);
  const record = saved.repos?.find(r => r.name === repo.name);
  if (saved.repos && !record) fail('Product missing from task: ' + repo.name);
  if (record?.override && !rows.get(repo.name)?.base) fail('Restore explicit base in git-flow.md for ' + repo.name);
  const pinned = pins.get(repo.name) ?? pins.get(undefined) ?? record?.baseSha;
  const checkout = taskCheckout(repo, code, record, pinned);
  if (!checkout) fail('Task branch not checked out: ' + code + ' in ' + repo.name);
  const remoteDefault = git(safe(repo.path), ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], true)?.replace(/^origin\//, '');
  const base = branchName(rows.get(repo.name)?.base || record?.base || (repo.profile !== 'custom' && remoteDefault));
  let baseSha = pinned;
  if (!baseSha) {
    const tip = localSha(repo, 'refs/remotes/origin/' + base) || localSha(repo, 'refs/heads/' + base);
    if (tip) baseSha = git(safe(checkout), ['merge-base', 'HEAD', tip], true);
  }
  if (!baseSha) fail('Local base unavailable: ' + base);
  return { ...repo, checkout, base, baseSha, target: base,
    baseFromProfile: !rows.get(repo.name)?.base && repo.profile !== 'custom' && !record?.override };
}
export function mergeEvidence(repo, head, target) {
  const cwd = safe(repo.path);
  if (git(cwd, ['merge-base', '--is-ancestor', head, target], true) !== null) return 'ancestor';
  // git cherry omits merge commits; conflict resolution in a merge may be unique.
  if (git(cwd, ['rev-list', '--max-count=1', '--merges', head, '^' + target])) return null;
  const cherries = git(cwd, ['cherry', target, head]);
  return cherries && cherries.split('\n').every(l => l.startsWith('- ')) ? 'patch' : null;
}
export function fetchBranch(repo, branch) {
  branchName(branch);
  git(safe(repo.path), ['fetch', '-q', '--no-tags', 'origin', '+refs/heads/' + branch + ':refs/remotes/origin/' + branch]);
  return localSha(repo, 'refs/remotes/origin/' + branch);
}

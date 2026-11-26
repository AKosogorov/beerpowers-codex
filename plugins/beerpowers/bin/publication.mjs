#!/usr/bin/env node
// Проверяет Git-назначение и собирает точный план открытия или правки MR и PR.
// Prepare the host-specific request. Only the caller may authorize a publication.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authorModel, draftStyle, modelSignature } from './lib/model-signature.mjs';

import { showHelp } from './lib/cli-help.mjs';

if (import.meta.main) showHelp('publication.mjs prepare TASK REPO [--confirm DIGEST] < publication.json', ['prepare']);

const hash = data => createHash('sha256').update(data).digest('hex');
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sectionNames = {
  deploy: 'Для выкладки на стенд', reason: 'Зачем', changes: 'Что сделано',
  tested: 'Чем проверено', unverified: 'Что осталось непроверенным', extra: 'За пределами задачи',
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function localPath(relative) {
  let file = process.cwd();
  for (const part of relative.split('/')) {
    check(part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f]/.test(part), 'Unsafe workspace path');
    file = path.join(file, part);
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Linked workspace path');
  }
  return file;
}

function read(file) {
  const resolved = localPath(file);
  check(fs.statSync(resolved, { throwIfNoEntry: false })?.isFile(), `Missing file: ${file}`);
  return fs.readFileSync(resolved);
}

function json(bytes) {
  try { return JSON.parse(bytes.toString().replace(/^\uFEFF/, '')); }
  catch { throw new Error('Expected valid UTF-8 JSON'); }
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  check(result.status === 0, `Git check failed: ${args[0]}`);
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}

export function checkout(task, repo) {
  const resolver = fileURLToPath(new URL('git-workspace.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [resolver, 'resolve', task, repo], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  check(result.status === 0, 'Cannot resolve task checkout and target; run git-workspace resolve');
  const plan = json(result.stdout);
  check(plan.name === repo && typeof plan.checkout === 'string' && oid.test(plan.baseSha), 'Invalid Git resolution');
  return plan;
}

export function reportLines(file) {
  const lines = [];
  let fence;
  for (const line of read(file).toString().split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = undefined;
    } else if (marker) fence = marker;
    else lines.push(line);
  }
  return lines;
}

export function reviewed(task, repo, head, targetSha, cwd) {
  const taskFolder = `memory/tasks/${task}/`;
  const brief = read(taskFolder + 'preflight.md');
  const records = taskFolder + 'checkouts.json';
  const selected = fs.existsSync(localPath(records)) ? json(read(records)).repos : null;
  if (selected) check(Array.isArray(selected) && selected.filter(r => r.name === repo).length === 1, 'Product missing from task checkouts');
  const multi = selected?.length > 1;
  const feature = /^Класс: feature\./m.test(brief.toString());
  const productFolder = taskFolder + 'repos/' + repo + '/';
  const hasScopedReports = ['test-cases.md','review-report.md','feature-state.json'].some(name =>
    fs.existsSync(localPath(productFolder + name)));
  const folder = multi && (feature || hasScopedReports) ? productFolder : taskFolder;
  const requireRepoLabel = multi && folder === taskFolder;
  if (feature || fs.existsSync(localPath(folder + 'feature-state.json'))) {
    const state = json(read(folder + 'feature-state.json'));
    const widthLine = /^UI widths \[[A-Za-z0-9_.,-]+\]: (?:approved|declined|revoked) [^\r\n]+\r?\n/gm;
    const briefText = brief.toString('latin1');
    const widthDecisions = (briefText.match(widthLine) ?? []).join('');
    const briefBody = Buffer.from(briefText.replace(widthLine, '')
      .replace(/^Economy local review: [a-f0-9]{40,64} \xe2\x80\x94 [^\r\n]+\r?\n/gm, ''), 'latin1');
    check(state.format === 'beerpowers-feature-1' && state.next === 'done' && state.head === head
      && state.base === targetSha && state.brief === hash(briefBody), 'Feature gates incomplete or stale');
    if (state.ui === 'yes') check((state.widths_hash ?? hash('')) === hash(Buffer.from(widthDecisions, 'latin1')),
      'UI matrix changed; repeat browser phase');
    const approval = state.history?.findLast(e => e.event !== 'team-up');
    check(approval?.event === 'final-approve' && approval.head === head && approval.next === 'done', 'Missing final feature approval event');
    const required = ['design-brief.md', 'early-review.md', 'test-cases.md', 'review-report.md'];
    if (state.requires_opponent === 'yes' || state.money === 'yes') required.push('opponent-report.md');
    check(required.every(name => state.reports?.[name]), 'Missing feature gate evidence');
    for (const [name, digest] of Object.entries(state.reports)) {
      check(/^(design-brief|early-review|test-cases|opponent-report|review-report)\.md$/.test(name)
        && hash(read(folder + name)) === digest, 'Feature report changed');
    }
  }
  // Both the pilot verdict and the current single-line verdict carry the reviewed SHA.
  // Multi-repo reports may qualify a decision with the checkout name.
  const decisions = reportLines(folder + 'review-report.md');
  const actor = decisions.findLast(line => /^Review by: (?:team-lead|reviewer) [0-9a-f]+$/.test(line));
  if (actor?.startsWith('Review by: team-lead ')) {
    const files = git(cwd, ['diff', '--no-renames', '--name-only', '-z', targetSha, head, '--']).split('\0').filter(Boolean);
    check(actor === `Review by: team-lead ${head}` && files.length === 1 &&
      reportLines(taskFolder + 'preflight.md').some(line => line.startsWith(`Economy local review: ${head} — `)),
      'Local economy review requires a scoped decision and one changed file at HEAD');
  }
  const runs = reportLines(folder + 'test-cases.md');
  let approval;
  let tested;
  for (const line of decisions.filter(line => /^(?:\*\*)?(?:NOT APPROVED|APPROVED)\b/.test(line))) {
    const m = line.match(/^(?:\*\*)?(NOT APPROVED|APPROVED)(?:\*\*)?\s+(?:(?:для source SHA|at)\s+)?(?:([A-Za-z0-9_.-]+)\s+)?`?([0-9a-f]{40,64})`?\s*$/);
    if (!m || !m[2] || m[2] === repo) approval = m?.[1] === 'APPROVED' && m[3] === head && (!requireRepoLabel || m[2] === repo);
  }
  for (const line of runs.filter(line => /^Full (?:run:|suite at)\s/.test(line))) {
    const m = line.match(/^Full (?:run: |suite at )(?:(\S+) )?([0-9a-f]{40,64})(?: exit=|, exit )(\d+)$/);
    if (!m || !m[1] || m[1] === repo) tested = m?.[2] === head && m[3] === '0' && (!requireRepoLabel || m[1] === repo);
  }
  check(approval, 'Latest final review must approve this checkout SHA');
  check(tested, 'Latest full run must pass at this checkout SHA');
}

function hosting(origin, input, cwd) {
  let provider, project, host;
  if (input.fixture !== undefined) {
    const local = path.resolve(cwd, origin);
    check(!origin.startsWith('//') && !origin.startsWith('\\\\') && fs.existsSync(local)
      && git(local, ['rev-parse', '--is-bare-repository']) === 'true', 'Fixture requires a local bare origin');
    ({ provider, project } = input.fixture);
    host = provider === 'github' ? 'github.com' : 'gitlab.invalid';
  } else {
    // Parse conventional HTTPS, ssh:// and SCP-like Git origins. Never echo an origin.
    const scp = /^git@([A-Za-z0-9.-]+):([\w./-]+)$/.exec(origin);
    let hostname;
    if (scp) { [, hostname, project] = scp; host = hostname; }
    else {
      let url;
      try { url = new URL(origin); } catch { throw new Error('Cannot identify hosting from origin'); }
      check(['https:', 'ssh:'].includes(url.protocol) && !url.password && !url.search && !url.hash &&
        (!url.username || (url.protocol === 'ssh:' && url.username === 'git')), 'Expected credential-free host URL');
      hostname = url.hostname;
      host = url.protocol === 'ssh:' ? hostname : url.host;
      project = url.pathname.slice(1);
    }
    project = project.replace(/\.git$/, '');
    const inferred = /(^|\.)github\./i.test(hostname) ? 'github' : /(^|\.)gitlab\./i.test(hostname) ? 'gitlab' : undefined;
    check(!input.provider || !inferred || inferred === input.provider, 'Hosting provider disagrees with origin');
    provider = inferred || input.provider;
  }
  check(provider === 'gitlab' || provider === 'github', 'Specify github or gitlab for the self-hosted origin');
  check(typeof project === 'string' && project.split('/').length >= 2
    && project.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..'), 'Invalid hosting project');
  if (provider === 'github') check(project.split('/').length === 2, 'Expected GitHub owner/repository');
  return { provider, project, host };
}

function prepare(task, repo, input, model) {
  check(input && !Array.isArray(input) && typeof input === 'object', 'Expected publication JSON object');
  const allowed = new Set(['summary', ...Object.keys(sectionNames), 'account', 'reviewers', 'provider', 'fixture', 'gitlab', 'githubPr', 'draft', 'reviewedSha', 'scopeFiles', 'rebase']);
  check(Object.keys(input).every(k => allowed.has(k)), 'Unexpected publication field');
  check(!Object.hasOwn(input, 'draft') || typeof input.draft === 'boolean', 'Expected boolean draft');
  const getText = key => {
    const value = input[key];
    check(typeof value === 'string' && value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), `Missing or invalid publication field: ${key}`);
    return value.trim().replace(/\r\n/g, '\n');
  };
  const summary = getText('summary');
  check(!/[\r\n]/.test(summary), 'Expected single-line summary');
  const unsigned = Object.entries(sectionNames).map(([k, heading]) => `## ${heading}\n\n${getText(k)}`).join('\n\n');
  const plan = checkout(task, repo);
  const cwd = localPath(plan.checkout);
  const source = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  const sourceSha = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  check(source === task, 'Wrong task checkout');
  check(!git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']), 'Expected clean product checkout');
  const origin = git(cwd, ['remote', 'get-url', 'origin']);
  check(origin === git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']), 'Fetch and push origin must identify one destination');
  const { provider, project, host } = hosting(origin, input, cwd);
  const gitlabDraft = provider === 'gitlab' && input.draft === true;
  const titleSummary = gitlabDraft ? summary.replace(/^(?:draft:\s*)+/i, '') : summary;
  check(titleSummary, 'Expected summary after draft prefix');
  const title = `${gitlabDraft ? 'Draft: ' : ''}${task}: ${titleSummary}`;
  const target = plan.target;
  git(cwd, ['check-ref-format', '--branch', target]);
  const refs = git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD', `refs/heads/${target}`, `refs/heads/${source}`]).split(/\r?\n/);
  const defaultRef = refs.find(line => line.startsWith('ref: ') && line.endsWith('\tHEAD'));
  const defaultBranch = defaultRef?.match(/^ref: refs\/heads\/(.+)\tHEAD$/)?.[1];
  check(defaultBranch && ![target, 'main', 'master', defaultBranch].includes(source), 'Protected or unknown source branch');
  check(!plan.baseFromProfile || target === defaultBranch, 'Default target changed; reconcile task base before publication');
  const targetSha = refs.find(line => line.endsWith(`\trefs/heads/${target}`))?.split('\t')[0];
  check(targetSha === plan.baseSha && oid.test(targetSha), 'Target moved; verify Git base and final review again');
  git(cwd, ['merge-base', '--is-ancestor', targetSha, sourceSha]);
  const paths = git(cwd, ['diff', '--no-renames', '--name-only', '-z', targetSha, sourceSha, '--']);
  check(paths, 'Empty reviewed diff');
  const changedFiles = paths.split('\0').filter(Boolean);
  let outsideScope;
  if (Object.hasOwn(input, 'scopeFiles')) {
    check(Array.isArray(input.scopeFiles) && input.scopeFiles.every(name => typeof name === 'string' && name),
      'Expected scopeFiles from the task or design brief');
    const scope = new Set(input.scopeFiles);
    outsideScope = changedFiles.filter(name => !scope.has(name));
    for (const file of outsideScope) check(getText('extra').includes(file), 'Explain out-of-scope file in extra: ' + file);
  }
  const reviewedSha = input.reviewedSha ?? sourceSha;
  check(oid.test(reviewedSha), 'Invalid reviewed SHA');
  git(cwd, ['merge-base', '--is-ancestor', targetSha, reviewedSha]);
  const reviewedTree = git(cwd, ['rev-parse', reviewedSha + '^{tree}']);
  check(reviewedTree === git(cwd, ['rev-parse', sourceSha + '^{tree}']), 'Reviewed tree changed; repeat gates');
  reviewed(task, repo, reviewedSha, targetSha, cwd);
  const published = refs.find(line => line.endsWith(`\trefs/heads/${source}`))?.split('\t')[0];
  let boundary = published ?? targetSha;
  if (input.rebase) {
    const {oldBase, oldHead, replayedHead} = input.rebase;
    check([oldBase, oldHead, replayedHead].every(sha => oid.test(sha)) && oldHead === published && oldBase !== targetSha,
      'Rebase needs the original published head and moved target');
    git(cwd, ['merge-base', '--is-ancestor', oldBase, oldHead]);
    git(cwd, ['merge-base', '--is-ancestor', targetSha, replayedHead]);
    const subjects = (base, head) => git(cwd, ['log', '--reverse', '--format=%s', base + '..' + head]);
    const oldSubjects = subjects(oldBase, oldHead);
    check(oldSubjects && oldSubjects === subjects(targetSha, replayedHead), 'Published rounds changed during rebase');
    boundary = replayedHead;
  }
  if (boundary !== sourceSha) {
    check(git(cwd, ['show', '-s', '--format=%P', sourceSha]) === boundary,
      'Expected one task commit before first push or one fix commit per review round');
    if (published) check(git(cwd, ['show', '-s', '--format=%s', sourceSha]).startsWith(`fix(${task}): `),
      'Expected one fix commit for this review round');
  }

  const local = '.codex/git-settings.local.json';
  let saved;
  if (fs.existsSync(localPath(local))) {
    git('.', ['check-ignore', '-q', '--', local]);
    saved = json(read(local)).reviewers?.[repo];
  }
  const reviewers = input.reviewers ?? saved;
  const login = user => typeof user === 'string' && /^[\w][\w.-]*$/.test(user);
  check(Array.isArray(reviewers) && reviewers.every(login), 'Expected explicit reviewers for this repository ([] for none)');
  check(input.account === undefined || login(input.account), 'Expected publication account login');
  const removeSourceBranch = json(read('.codex/git-settings.json')).removeSourceBranch ?? true;
  check(typeof removeSourceBranch === 'boolean', 'Invalid removeSourceBranch setting');
  const style = draftStyle(['publication', provider, host, project, source, target, title, unsigned]);
  const signature = modelSignature(model, style);
  const description = `${unsigned}\n\n${signature}`;
  const pushArgs = ['push'];
  if (input.rebase) pushArgs.push('--force-with-lease=refs/heads/' + source + ':' + published);
  const out = { provider, host, project, gitDestination:origin, checkout:plan.checkout, source, sourceSha, target, targetSha,
    reviewedSha, reviewedTree, published, changedFiles, outsideScope, title, description, signature, draft:input.draft === true, reviewers, assignee:input.account ?? null, removeSourceBranch, pushArgs };
  if (provider === 'gitlab') {
    check(input.githubPr === undefined, 'Unexpected GitHub PR for a GitLab origin');
    const projectPath = `/api/v4/projects/${encodeURIComponent(project)}`;
    out.lookup = { method: 'GET', path: `${projectPath}/merge_requests?state=opened&source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}` };
    out.request = { method: 'PUT', path: `${projectPath}/merge_requests/{iid}`, body: { title, target_branch: target, description, remove_source_branch: removeSourceBranch } };
    out.assigneeLookup = '/api/v4/user';
    out.reviewerLookups = reviewers.map(user => `/api/v4/users?username=${encodeURIComponent(user)}`);
    if (input.gitlab) {
      const { iid, assigneeId, reviewerIds } = input.gitlab;
      const validId = value => Number.isSafeInteger(value) && value > 0;
      check((iid === undefined || validId(iid)) && validId(assigneeId) && reviewerIds && typeof reviewerIds === 'object'
        && reviewers.every(user => Object.hasOwn(reviewerIds, user) && validId(reviewerIds[user])), 'Expected verified GitLab assignee and reviewer IDs and optional MR IID');
      if (iid !== undefined) out.request.path = `${projectPath}/merge_requests/${iid}`;
      out.request.body.assignee_ids = [assigneeId];
      out.request.body.reviewer_ids = reviewers.map(user => reviewerIds[user]);
    }
    if (input.gitlab?.iid === undefined) {
      out.initialDescription = [titleSummary, getText('tested'), getText('unverified')]
        .map(value => value.replace(/\\n|\s+/g, ' ')).join(' · ');
      const options = ['merge_request.create', `merge_request.target=${target}`, `merge_request.title=${title}`,
        `merge_request.description=${out.initialDescription}`];
      if (input.account) options.push(`merge_request.assign=${input.account}`);
      if (removeSourceBranch) options.push('merge_request.remove_source_branch');
      for (const option of options) pushArgs.push('-o', option);
    }
  } else {
    check(!input.gitlab, 'Unexpected GitLab IDs for a GitHub origin');
    out.createArgs = ['pr', 'create', '--repo', `${host}/${project}`, '--base', target, '--head', source, '--title', title, '--body-file', '-'];
    if (input.account) out.createArgs.push('--assignee', input.account);
    if (input.draft) out.createArgs.push('--draft');
    for (const user of reviewers) out.createArgs.push('--reviewer', user);
    out.apiHost = host === 'github.com' ? 'api.github.com' : host;
    out.request = { method: 'POST', path: `${host === 'github.com' ? '' : '/api/v3'}/repos/${project}/pulls`, body: { title, head: source, base: target, body: description } };
    if (input.draft) out.request.body.draft = true;
    if (input.githubPr !== undefined) {
      check(Number.isSafeInteger(input.githubPr) && input.githubPr > 0, 'Expected verified GitHub PR number');
      delete out.createArgs;
      out.lookup = {method:'GET', path:out.request.path + '/' + input.githubPr};
      out.request = {method:'PATCH', path:out.lookup.path, body:{title, base:target, body:description}};
      out.editArgs = ['pr', 'edit', String(input.githubPr), '--repo', `${host}/${project}`, '--base', target, '--title', title, '--body-file', '-'];
      if (input.account) out.editArgs.push('--add-assignee', input.account);
      if (reviewers.length) out.editArgs.push('--add-reviewer', reviewers.join(','));
    }
  }
  out.request.headers = { 'Content-Type': 'application/json' };
  // Pin the exact reviewed source. A branch could advance after this preparation.
  pushArgs.push('origin', `${sourceSha}:refs/heads/${source}`);
  return out;
}

if (import.meta.main) try {
  const [mode, task, repo, ...extra] = process.argv.slice(2);
  const confirm = extra[1];
  check(mode === 'prepare' && task && repo && (!extra.length || (extra.length === 2 && extra[0] === '--confirm' && /^[a-f0-9]{64}$/.test(confirm))),
    'Usage: publication.mjs prepare <task> <repo> [--confirm DIGEST] (JSON on stdin)');
  check(/^[\w.-]+$/.test(repo) && /^[\w.-]+(?:\/[\w.-]+)*$/.test(task), 'Invalid task or repository');
  const bytes = fs.readFileSync(0);
  const input = json(bytes);
  const result = prepare(task, repo, input, await authorModel());
  const digest = hash(JSON.stringify([hash(bytes), result]));
  if (confirm) {
    check(confirm === digest, 'Publication preview digest mismatch');
    check(result.assignee, 'Expected an explicit publication account');
    check(result.provider !== 'gitlab' || result.request.body.assignee_ids, 'Expected verified GitLab assignee and reviewer IDs before confirmation');
  }
  process.stdout.write(JSON.stringify({ status: confirm ? 'confirmed' : 'prepared', ...result, digest }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}

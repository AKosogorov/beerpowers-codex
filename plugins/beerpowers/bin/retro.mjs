// Показывает статус закрываемых задач и записывает согласованные итоги ретроспективы.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { branchName, discover, git, localSha, mergeEvidence, remoteState, root, safe, taskData } from './lib/git-repositories.mjs';

const productReports = new Set(['handover.md', 'review-report.md', 'early-review.md', 'test-cases.md',
  'bug-log.md', 'design-brief.md', 'plan-delta.md', 'opponent-report.md', 'feature-state.json']);
const known = new Set([...productReports, 'preflight.md', 'git-flow.md', 'checkouts.json']);
const hash = value => createHash('sha256').update(value).digest('hex');
const help = 'Usage: retro.mjs status [TASK ...] [--fetch] [--remote] | plan [TASK ...] [--force] [--metrics EXPORT] | distill TASK < lesson.json';
function call(script, args) {
  const path = fileURLToPath(new URL(script, import.meta.url));
  return JSON.parse(execFileSync(process.execPath, [path, ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, windowsHide: true
  }));
}
function read(rel) {
  const path = safe(rel);
  if (!lstatSync(path, {throwIfNoEntry: false})?.isFile()) throw Error('Expected regular file: ' + rel);
  return readFileSync(path, 'utf8');
}
function artifactFolder(rel, entry) {
  if (!entry.isDirectory()) return false;
  if (entry.name === 'tracker') {
    return readdirSync(safe(rel + '/tracker'), {withFileTypes:true})
      .some(child => (child.name === 'task.md' && child.isFile()) ||
        (child.name === 'task-attachment' && child.isDirectory()));
  }
  if (entry.name !== 'screenshots' && entry.name !== 'figma') return false;
  return readdirSync(safe(rel + '/' + entry.name), {withFileTypes:true})
    .some(child => child.isFile() && /\.(?:png|jpe?g|webp)$/i.test(child.name));
}
function findTasks(skippedLinks, rel = 'memory/tasks') {
  if (!existsSync(safe(rel))) return [];
  const entries = readdirSync(safe(rel), {withFileTypes: true});
  if (rel !== 'memory/tasks' && entries.some(entry => entry.isFile() || known.has(entry.name) || artifactFolder(rel, entry))) {
    return [rel.slice('memory/tasks/'.length)];
  }
  for (const entry of entries.filter(entry => entry.isSymbolicLink())) skippedLinks.push(rel + '/' + entry.name);
  return entries.filter(entry => entry.isDirectory()).flatMap(entry => findTasks(skippedLinks, rel + '/' + entry.name));
}

function artifacts(directory, cutoff) {
  const result = {files: 0, modifiedInLast30Days: 0, skippedLinks: []};
  function visit(path) {
    for (const entry of readdirSync(safe(path), {withFileTypes: true})) {
      const rel = path + '/' + entry.name;
      if (entry.isSymbolicLink()) result.skippedLinks.push(rel);
      else if (entry.isDirectory()) visit(rel);
      else if (entry.isFile()) {
        result.files++;
        if (lstatSync(safe(rel)).mtimeMs >= cutoff) result.modifiedInLast30Days++;
      }
    }
  }
  visit(directory);
  return result;
}

function statusProduct(repo, options) {
  const cwd = safe(repo.path);
  const problems = [];
  let fetch = 'skipped', server = null;
  if (options.fetch || options.remote) {
    try { server = remoteState(repo); }
    catch (error) { problems.push(error.message); }
  }
  if (options.fetch) {
    try {
      git(cwd, ['fetch', '--quiet', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
      fetch = 'ok';
    } catch (error) {
      fetch = 'failed';
      problems.push(error.message);
    }
    if (fetch === 'ok' && server) {
      try {
        branchName(server.defaultBranch);
        git(cwd, ['remote', 'set-head', 'origin', server.defaultBranch]);
      } catch (error) { problems.push(error.message); }
    }
  }
  const cachedDefault = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], true)?.replace(/^origin\//, '');
  const defaultBranch = server?.defaultBranch ?? cachedDefault ?? null;
  const fetchHead = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD']);
  const observation = lstatSync(fetchHead, {throwIfNoEntry: false});
  const observed = observation?.isFile() && observation.size > 0;
  const lastFetchAt = observed ? observation.mtime.toISOString() : null;
  const freshness = observed ? (Date.now() - observation.mtimeMs > 86400000 ? 'stale' : 'fresh') : 'unknown';
  return {repo, defaultBranch, fetch, lastFetchAt, freshness, server, problems};
}

function statusTask(code, products, options, cutoff) {
  const {dir, rows, saved} = taskData(code);
  const present = !!lstatSync(safe(dir), {throwIfNoEntry: false})?.isDirectory();
  const expected = saved.repos?.map(repo => repo.name) ?? [];
  const repos = products.filter(({repo}) => !expected.length || expected.includes(repo.name)).map(product => {
    const {repo, defaultBranch, server} = product;
    const localHead = localSha(repo, 'refs/heads/' + code);
    const base = rows.get(repo.name)?.base ?? saved.repos?.find(item => item.name === repo.name)?.base;
    const targets = [];
    for (const target of new Set([base, defaultBranch])) {
      if (!target || target === code) continue;
      branchName(target);
      const targetSha = localSha(repo, 'refs/remotes/origin/' + target);
      const by = localHead && targetSha ? mergeEvidence(repo, localHead, targetSha) : null;
      targets.push({target, targetSha, by});
    }
    const matched = targets.find(target => target.by);
    const compared = matched ?? targets.find(target => target.targetSha);
    return {name: repo.name, localHead, cachedRemoteHead: localSha(repo, 'refs/remotes/origin/' + code),
      remoteBranch: options.remote && server ? server.heads.has(code) : null,
      merged: !localHead || !compared ? null : Boolean(matched),
      target: compared?.target ?? null, targetSha: compared?.targetSha ?? null, by: matched?.by ?? null, targets};
  });
  return {code, present, artifacts: present ? artifacts(dir, cutoff) : null, repos,
    missingProducts: expected.filter(name => !products.some(({repo}) => repo.name === name))};
}

function status(codes, options, repos) {
  const skippedLinks = [];
  const selected = codes.length ? codes : findTasks(skippedLinks).sort((a, b) => a.localeCompare(b));
  const products = repos.map(repo => statusProduct(repo, options));
  const cutoff = Date.now() - 30 * 86400000;
  return {
    comparison: 'Origin tracking refs in the local clone. Use plan for fresh cleanup proof.',
    products: products.map(({repo, server, ...summary}) => ({...repo, ...summary})),
    tasks: selected.map(code => statusTask(code, products, options, cutoff)),
    skippedLinks,
  };
}

function facts(code, dir, saved) {
  const sources = {}, manual = [];
  const content = {};
  const products = new Set(saved.repos?.map(repo => repo.name));
  const entries = path => readdirSync(safe(path), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries(dir)) {
    if (entry.name === 'repos' && entry.isDirectory() && products.size > 0) {
      for (const product of entries(dir + '/repos')) {
        const prefix = 'repos/' + product.name;
        if (!product.isDirectory() || !products.has(product.name)) { manual.push(prefix); continue; }
        for (const report of entries(dir + '/' + prefix)) {
          const relative = prefix + '/' + report.name;
          if (!report.isFile() || !productReports.has(report.name) || lstatSync(safe(dir + '/' + relative)).nlink > 1) {
            manual.push(relative);
            continue;
          }
          content[relative] = read(dir + '/' + relative);
          sources[relative] = hash(content[relative]);
        }
      }
      continue;
    }
    const checklist = entry.name === code.split('/').at(-1) + '-qa.html';
    if (!entry.isFile() || (!known.has(entry.name) && !checklist)) { manual.push(entry.name); continue; }
    const body = read(dir + '/' + entry.name);
    if (checklist && !body.startsWith('<!doctype html><!-- beerpowers:qa-checklist -->')) {
      manual.push(entry.name);
      continue;
    }
    content[entry.name] = body;
    sources[entry.name] = hash(body);
  }
  const feature = content['feature-state.json'] ? JSON.parse(content['feature-state.json']) : null;
  const history = feature?.history;
  const preflight = content['preflight.md'] ?? '';
  const taskClass = [...preflight.matchAll(/^Класс:\s*(lean|feature|trivial|фича|тривиальная)(?=[\s.,;]|$)/gmu)].at(-1)?.[1] ?? null;
  const checks = [...(content['test-cases.md'] ?? '').matchAll(/^Full run: (\S+) exit=(\d+)\r?$/gm)];
  const verdicts = [...(content['review-report.md'] ?? '').matchAll(/^(?:\*\*)?(NOT APPROVED|APPROVED)\b[^\r\n]*/gm)];
  const id = hash(JSON.stringify([code, sources]));
  const handovers = Object.entries(content).filter(([name]) => name.split('/').at(-1) === 'handover.md');
  return {code, present: true, directory: dir, evidenceId: id, sources, manual,
    taskClass, paused: handovers.length ? handovers.some(([, text]) => /^## Пауза\s*$/m.test(text)) : null,
    featureGate: feature?.next ?? null,
    fixCycles: Array.isArray(history) ? history.filter(event => event.next === 'fix').length : null,
    lastRun: checks.length ? {head: checks.at(-1)[1], exit: Number(checks.at(-1)[2])} : null,
    lastVerdict: verdicts.at(-1)?.[0] ?? null};
}

function currentFacts(code, products) {
  const {dir, saved, rows} = taskData(code);
  if (!existsSync(safe(dir))) return {code, present: false};
  const evidence = facts(code, dir, saved);
  const targets = {};
  for (const repo of products.filter(repo => !saved.repos || saved.repos.some(row => row.name === repo.name))) {
    let branch = rows.get(repo.name)?.base ?? saved.repos?.find(row => row.name === repo.name)?.base ?? null;
    let sha = null;
    try {
      const state = remoteState(repo);
      branch ??= state.defaultBranch;
      sha = state.heads.get(branch) ?? null;
    } catch { /* Offline evidence must carry the original date. */ }
    targets[repo.name] = {branch, sha};
  }
  return {...evidence, targets, evidenceId: hash(JSON.stringify([evidence.evidenceId, targets]))};
}

function textField(object, name) {
  const value = object?.[name];
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]|<!--/.test(value)) throw Error('Expected one line: ' + name);
  return value.trim();
}
function append(rel, body) {
  const path = safe(rel);
  if ((lstatSync(path, {throwIfNoEntry: false})?.nlink ?? 1) > 1) throw Error('Linked journal or index: ' + rel);
  const old = existsSync(path) ? read(rel) : '';
  const newline = old.includes('\r\n') ? '\r\n' : '\n';
  const prefix = (!old || old.endsWith(newline + newline)) ? '' : old.endsWith(newline) ? newline : newline + newline;
  appendFileSync(path, prefix + body.replaceAll('\n', newline) + newline, 'utf8');
}
function verification(lesson, evidence, date, sourceText) {
  const v = lesson.verification;
  const author = textField(v, 'author');
  const repo = textField(v, 'repo');
  const target = evidence.targets[repo];
  if (!target || !Object.hasOwn(v, 'sha') || v.sha !== target.sha ||
      (!target.sha && v.status !== 'unavailable')) throw Error('Target changed or unavailable; rebuild retro plan');
  if (!['reproduced','refuted','unavailable'].includes(v.status) ||
      !['red-base','fact'].includes(v.kind) || v.checkedBy !== 'team-lead') throw Error('Team-lead verification required');
  const proof = textField(v, 'proof');
  const observed = textField(v, 'observed');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observed) || observed > date) throw Error('Invalid original observation date');
  let command = '';
  if (v.kind === 'red-base') {
    const exact = textField(v,'command');
    if (!sourceText.split(/\r?\n/).some(line => line.trim() === exact || line.includes('`' + exact + '`'))) throw Error('Missing original exact command');
    if (v.status !== 'unavailable' && (v.ran !== exact || !Number.isSafeInteger(v.exit) || v.exit < 0 ||
        (v.status === 'reproduced' && v.exit === 0))) throw Error('Record exact command executed and its exit code');
    command = ' Команда: ' + exact + (v.status === 'unavailable' ? '.' : ', exit=' + v.exit + '.');
  }
  if (v.status === 'refuted') {
    if (!Array.isArray(v.closedDuplicates)) throw Error('Check long-term memory for refuted duplicates');
    for (const duplicate of v.closedDuplicates) {
      if (!/^memory\/(?!tasks\/).+\.md$/.test(duplicate.path) || !Number.isSafeInteger(duplicate.line) || duplicate.line < 1)
        throw Error('Invalid long-term memory reference');
      const closure = read(duplicate.path).split(/\r?\n/)[duplicate.line - 1] ?? '';
      const dated = [...closure.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].some(([day]) => observed <= day && day <= date);
      if (!dated || !closure.includes(proof)) throw Error('Missing dated correction at duplicate');
    }
  }
  const status = {reproduced:'Воспроизведено', refuted:'Опровергнуто', unavailable:'Требует перепроверки'}[v.status];
  return checkedOn => status + ' · ' + checkedOn + ', исходная дата ' + observed + '. ' + repo + '@' + (v.sha ?? 'недоступно') +
    '. Автор вывода: ' + author + ', проверил: team-lead. ' + proof + command;
}
function distill(code, products) {
  const project = products.length === 1 ? products[0].name : '<репо>';
  const request = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  const evidence = currentFacts(code, products);
  if (!evidence.present || request.evidenceId !== evidence.evidenceId) throw Error('Evidence changed or task missing; rebuild retro plan');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date) || !Array.isArray(request.lessons)) throw Error('Expected date and lesson list');
  const review = textField(request, 'review');
  const topic = request.topic === undefined ? 'Уроки эпика' : textField(request, 'topic');
  const records = request.lessons.map(lesson => {
    const trigger = textField(lesson, 'trigger'), action = textField(lesson, 'action');
    const source = textField(lesson, 'source'), line = lesson.line;
    if (!Object.hasOwn(evidence.sources, source) || !Number.isSafeInteger(line) || line < 1 ||
        !read(evidence.directory + '/' + source).split(/\r?\n/)[line - 1]?.trim()) throw Error('Invalid task evidence line');
    const sourceText = read(evidence.directory + '/' + source);
    if (source.startsWith('repos/') && source.split('/')[1] !== lesson.verification?.repo) {
      throw Error('Task report and verification refer to different products');
    }
    const renderProof = verification(lesson, evidence, request.date, sourceText);
    const proof = renderProof(request.date);
    const markerFor = day => '<!-- beerpowers:lesson ' + hash(JSON.stringify([trigger, action, renderProof(day)])) + ' -->';
    const marker = markerFor('');
    const instruction = lesson.verification.status === 'reproduced' ? `Когда ${trigger}, ${action}.` : `Историческая запись: «${sourceText.split(/\r?\n/)[line - 1].trim()}».`;
    return {marker, markerFor, body: `- ${instruction} ${proof} Основание: ${source}:${line} (${evidence.sources[source].slice(0, 12)}).\n${marker}`};
  });
  const journal = 'memory/retro-log.md', index = 'memory/MEMORY.md';
  const lock = safe('.git/beerpowers-retro.lock');
  const fd = openSync(lock, 'wx');
  try {
    if (currentFacts(code, products).evidenceId !== request.evidenceId) throw Error('Evidence changed before write');
    const existing = existsSync(safe(journal)) ? read(journal) : '';
    const indexBody = existsSync(safe(index)) ? read(index) : '';
    const seen = new Set(existing.split(/\r?\n/));
    // Earlier journals hashed the displayed verification date along with the fact.
    const oldDates = new Set(Array.from(existing.matchAll(/ · (\d{4}-\d{2}-\d{2}), исходная дата /g), match => match[1]));
    const additions = [];
    for (const record of records) {
      if (seen.has(record.marker)) continue;
      if (![...oldDates].some(day => seen.has(record.markerFor(day)))) additions.push(record.body);
      seen.add(record.marker);
    }
    const reviewMarker = '<!-- beerpowers:distilled ' + evidence.evidenceId + ' -->';
    if (!seen.has(reviewMarker)) additions.push(review + '\n' + reviewMarker);
    if (additions.length) {
      const header = existing ? '' : readFileSync(new URL('../templates/memory/retro-log.md', import.meta.url), 'utf8')
        .replaceAll('{{PROJECT}}', project).trimEnd().replaceAll('\r\n','\n') + '\n\n';
      append(journal, header + `## ${topic} (${code})\n\n${request.date}\n\n` + additions.join('\n\n'));
    }
    if (!/\]\((?:\.\/)?retro-log\.md\)/.test(indexBody)) append(index, '[Журнал уроков](retro-log.md)');
    return {code, written: additions.length, journal, index};
  } finally { closeSync(fd); unlinkSync(lock); }
}

function plan(codes, options, products) {
  const skippedLinks = [];
  const selected = codes.length ? codes : findTasks(skippedLinks);
  const rows = [];
  const journal = existsSync(safe('memory/retro-log.md')) ? read('memory/retro-log.md').split(/\r?\n/) : [];
  for (const code of selected) {
    const row = currentFacts(code, products);
    if (row.present) {
      let proof;
      try { proof = call('./git-workspace.mjs', ['merged', code]); }
      catch { proof = {merged: null, reason: 'Fresh Git merge evidence unavailable. Keep artifacts.'}; }
      const work = git(root, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', row.directory]);
      const tracked = git(root, ['ls-files', '-z', '--', row.directory]).split('\0').filter(Boolean);
      const expected = Object.hasOwn(row.sources, 'checkouts.json') ? JSON.parse(read(row.directory + '/checkouts.json')).repos : null;
      const scopeResolved = expected == null ? products.length === 1 : Array.isArray(expected) && expected.length > 0 &&
        expected.every(repo => products.some(product => product.name === repo.name));
      const distilled = journal.includes('<!-- beerpowers:distilled ' + row.evidenceId + ' -->');
      Object.assign(row, {mergeProof: proof, scopeResolved, distilled, worktreeStatus: work, trackedFiles: tracked,
        cleanupCandidate: scopeResolved && proof.merged === true && distilled && !row.paused && !work && !row.manual.length && tracked.length > 0});
    }
    rows.push(row);
  }
  const args = ['worktrees-clear', ...codes, ...(options.force ? ['--force'] : [])];
  let worktrees;
  try { worktrees = call('./git-workspace.mjs', args); }
  catch { worktrees = {reason: 'Cannot verify worktree plan. Keep working directories.'}; }
  const metrics = call('./token-audit.mjs', ['project', ...(options.metrics ? ['--input', options.metrics] : [])]);
  return {tasks: rows, skippedLinks, metrics, metricsScope: 'The selected Codex export; task attribution requires a task-scoped export.',
    worktrees: {args, ...worktrees}, cleanup: 'Review individual tracked paths, references and distillation before approval.'};
}

try {
  const {values, positionals: [operation, ...codes]} = parseArgs({allowPositionals: true, options: {
    help: {type: 'boolean'}, force: {type: 'boolean'}, metrics: {type: 'string'},
    fetch: {type: 'boolean'}, remote: {type: 'boolean'}
  }});
  if (values.help) console.log(help);
  else {
    const valid = (operation === 'plan' && !values.fetch && !values.remote) ||
      (operation === 'distill' && codes.length === 1 && Object.keys(values).length === 0) ||
      (operation === 'status' && !values.force && values.metrics === undefined);
    if (!valid) throw Error(help);
    const products = discover();
    for (const code of codes) branchName(code, true);
    if (new Set(codes).size !== codes.length) throw Error('Duplicate task');
    const result = operation === 'status' ? status(codes, values, products)
      : operation === 'plan' ? plan(codes, values, products) : distill(codes[0], products);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

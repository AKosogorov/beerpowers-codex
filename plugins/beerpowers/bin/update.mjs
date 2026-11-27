// Строит и применяет миграции управляемых файлов workspace из установленного пакета.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { workspacePath } from './lib/ui-workspace.mjs';
import { setupAdditions, workspaceCheck } from './lib/update-setup.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('update.mjs plan [--previous PACKAGE] | apply PLAN_ID [--previous PACKAGE]', ['plan', 'apply']);

const pkg = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync.native('.');
const configPath = '.codex/workspace.json';
const rules = [
  ['AGENTS.md', 'entry', 'entry'],
  ['.codex/team-charter.md', 'team-charter', 'codex-team'],
  ['.codex/team-lead.md', 'team-lead', 'codex-lead'],
  ['memory/MEMORY.md', 'memory-index', 'codex-memory'],
];
// Accept only exact published engine blocks when no previous package is available.
const publishedBlocks = {
  'codex-team': '40baef3528485aa5e825f2ca020bb0f7b12f18c5ef3026c12227e59ca0d3d35b',
  'codex-lead': '451aed984556a4374844fb36ad00407a08bbe86ea606a583501c80610d58bf09',
  'codex-memory': 'ae32770c5daec0a7978a84c5812945ad23b8a666bda116d30825436c9867664e',
  entry: '18d8e222f7982cae3aab4545c356415fe200d05fcb6dcafe7dbbd605a4626307',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = text => text.replaceAll('\r\n', '\n');
const validVersion = value => typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(value);
function compareVersion(left, right) {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  const different = a.findIndex((v, i) => v !== b[i]);
  return different < 0 ? 0 : Math.sign(Number(a[different] - b[different]));
}
function read(path) {
  if (!lstatSync(path).isFile()) throw Error('Expected regular file: ' + path);
  return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(readFileSync(path));
}
function json(text) { return JSON.parse(text.replace(/^\uFEFF/, '')); }
function manifest(dir) {
  const data = json(read(workspacePath(dir, '.codex-plugin/plugin.json')));
  if (data.name !== 'beerpowers-codex' || !validVersion(data.version) || data.upstream?.name !== 'beerpowers') {
    throw Error('Invalid BeerPowers Codex package: ' + dir);
  }
  return data;
}

// Keep every byte outside the two version fields, including large project JSON numbers.
function configUpdate(text, to) {
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g)];
  const keys = new Map();
  let depth = 0;
  for (const [i, token] of tokens.entries()) {
    const value = token[0];
    if (depth === 1 && value.startsWith('"') && tokens[i + 1]?.[0] === ':') {
      const key = JSON.parse(value);
      if (keys.has(key)) throw Error('Duplicate workspace.json key: ' + key);
      keys.set(key, tokens[i + 2]);
    }
    if (value === '{' || value === '[') depth++;
    if (value === '}' || value === ']') depth--;
  }
  const version = keys.get('beerpowers');
  if (!version) throw Error('Missing workspace version');
  const changed = text.slice(0, version.index) + JSON.stringify(to) + text.slice(version.index + version[0].length);
  return keys.has('schemaVersion') ? changed : changed.replace('{', '{"schemaVersion":1,');
}

function* markupLines(text) {
  let fence;
  for (const line of text.matchAll(/^[^\r\n]+/gm)) {
    const content = line[0].replace(/^\uFEFF/, '');
    const mark = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (mark && mark[1].startsWith(fence) && !mark[2].trim()) fence = null;
    } else if (mark) fence = mark[1];
    else yield {content, start:line.index + line[0].length - content.length, end:line.index + line[0].length};
  }
  if (fence) throw Error('Unclosed Markdown code fence around the migration target');
}

function blocks(text, path) {
  const found = new Map();
  let open;
  for (const {content, start, end} of markupLines(text)) {
    if (!/^\s*<!--\s*\/?beerpowers:engine\b/.test(content)) continue;
    const begin = /^<!-- beerpowers:engine ([a-zA-Z0-9-]+)(?: if=[\w-]+:[\w.-]+)? -->$/.exec(content);
    if (begin && !open && !found.has(begin[1])) {
      open = { name: begin[1], start };
    } else if (content === '<!-- /beerpowers:engine -->' && open) {
      found.set(open.name, { ...open, end, text: text.slice(open.start, end) });
      open = null;
    } else throw Error('Ambiguous engine marker in ' + path + ': ' + content);
  }
  if (open) throw Error('Unclosed engine block ' + open.name + ': ' + path);
  return found;
}

function template(dir, file, name) {
  if (!dir) return null;
  const source = {entry: 'AGENTS.md', 'memory-index': 'memory/MEMORY.md'}[file] ?? 'charter/' + file + '.md';
  const path = workspacePath(dir, 'templates/' + source);
  const legacy = workspacePath(dir, 'templates/engine/' + file + '.md');
  const selected = lstatSync(path, {throwIfNoEntry:false}) ? path
    : lstatSync(legacy, {throwIfNoEntry:false}) ? legacy : null;
  if (!selected) return null;
  const block = blocks(normalize(read(selected)), selected).get(name)?.text;
  if (!block || /\{\{.*?\}\}/.test(block)) throw Error('Invalid engine template: ' + selected);
  return block;
}

function migrateText(text, path, file, name, from, to, previous) {
  const canonical = template(pkg, file, name);
  if (!canonical) throw Error('Missing engine template: ' + file);
  const current = blocks(text, path).get(name);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const addition = canonical.replaceAll('\n', newline);
  const actions = [];
  let after = text;
  if (!current) {
    // Preserve the existing shared memory index when it has no Codex-managed block.
    if (name === 'codex-memory') {
      return {after, actions};
    }
    after += (after.endsWith('\n') ? newline : newline + newline) + addition + newline;
    actions.push('add ' + name);
  } else if (normalize(current.text) !== canonical) {
    const prior = template(previous, file, name);
    if (normalize(current.text) !== prior && sha(normalize(current.text)) !== publishedBlocks[name]) {
      throw Error('Conflict ' + path + ' [' + name + ']\nWorkspace:\n' + current.text + '\nPackage:\n' + canonical);
    }
    after = after.slice(0, current.start) + addition + after.slice(current.end);
    actions.push('replace ' + name);
  }
  if (name === 'codex-memory' && current) {
    const oldJournal = /^(- \[Журнал уроков\]\(retro-log\.md\) — приёмы, которые стоит повторять; раздел «Прецеденты правил» — даты и задачи, на которых написаны правила charter и )\x60team-lead\.md\x60$/;
    const journals = [...markupLines(after)].filter(({content}) => oldJournal.test(content));
    if (journals.length === 1) {
      const {content, start, end} = journals[0];
      after = after.slice(0, start) + content.replace(oldJournal, '$1\x60.codex/team-lead.md\x60') + after.slice(end);
      actions.push('fix generated retro index path');
    }
    const oldDebt = '\x60doctor.mjs tech-debt-index\x60';
    const newDebt = '\x60$beerpowers tech-debt-index\x60';
    const memoryTemplate = read(workspacePath(pkg, 'templates/memory/MEMORY.md'));
    const lines = [...markupLines(after)];
    const debtEdits = [...markupLines(memoryTemplate)].filter(({content}) => content.includes(newDebt))
      .flatMap(({content}) => {
        const original = content.replace(newDebt, oldDebt);
        const matches = lines.filter(line => line.content === original);
        return matches.length === 1 ? [{...matches[0], replacement:content}] : [];
      });
    for (const {start, end, replacement} of debtEdits.sort((left, right) => right.start - left.start)) {
      after = after.slice(0, start) + replacement + after.slice(end);
    }
    if (debtEdits.length) actions.push('replace generated tech-debt command');
  }
  const beforeStamp = after;
  if (name === 'codex-team') {
    const stamp = '<!-- generated-by: beerpowers-codex v' + to + ' · mode: plugin-linked -->';
    const old = [...markupLines(after)].filter(line => line.content.startsWith('<!-- generated-by: beerpowers-codex '));
    if (!old.length) {
      after = after.replace(/^(\uFEFF?)/, '$1' + stamp + newline);
      actions.push('add charter stamp');
    } else {
      const {content:line, start, end} = old[0];
      if (old.length !== 1 || ![from, to].some(v => line === stamp.replace(' v' + to + ' ', ' v' + v + ' '))) {
        throw Error('Conflicting Codex version stamp: ' + path);
      }
      if (line !== stamp) { after = after.slice(0,start) + stamp + after.slice(end); actions.push('update charter stamp'); }
    }
  }
  return {after, actions, beforeStamp};
}


function plan(previous) {
  const to = manifest(pkg).version;
  const original = read(workspacePath(root, configPath));
  const config = json(original);
  const from = config?.beerpowers;
  const legacy = from === '0.2.0' && Object.keys(config).length === 1;
  if (!validVersion(from) || (!legacy && config.schemaVersion !== 1) || compareVersion(from, '0.2.0') < 0) {
    throw Error('Unsupported workspace version or schema: ' + from);
  }
  if (previous) {
    const priorVersion = manifest(previous).version;
    if (from === to && compareVersion(priorVersion, to) < 0) previous = null;
    else if (priorVersion !== from) throw Error('Previous package must match ' + from);
  }
  const projected = new Map();
  function document(path) {
    if (projected.has(path)) return projected.get(path);
    const target = workspacePath(root, path);
    const before = lstatSync(target, {throwIfNoEntry:false}) ? read(target) : null;
    const doc = {path, before, after:before, actions:[]};
    projected.set(path, doc);
    return doc;
  }
  const downgrade = compareVersion(from, to) > 0;
  if (downgrade) {
    const doc = document('.codex/team-charter.md');
    const stamp = version => '<!-- generated-by: beerpowers-codex v' + version + ' · mode: plugin-linked -->';
    const matches = [...markupLines(doc.after ?? '')].filter(({content}) => content.startsWith('<!-- generated-by: beerpowers-codex '));
    if (matches.length !== 1 || ![stamp(from), stamp(to)].includes(matches[0].content)) throw Error('Rollback requires a matching charter stamp');
    const {start, end} = matches[0];
    doc.beforeStamp = doc.before;
    doc.after = doc.after.slice(0, start) + stamp(to) + doc.after.slice(end);
    doc.actions.push('rollback charter stamp only');
  }
  for (const {path, action, addition} of downgrade ? [] : setupAdditions(root, pkg)) {
    const doc = document(path);
    if ((action === 'CREATE') !== (doc.after === null) || path === configPath) {
      throw Error('Setup preview conflicts with current workspace: ' + path);
    }
    doc.after = action === 'APPEND' ? doc.after + addition : addition;
    doc.actions.push('setup ' + action);
  }
  for (const [path, file, name] of downgrade ? [] : rules) {
    const doc = document(path);
    if (doc.after === null) throw Error('Missing setup document: ' + path);
    const edit = migrateText(doc.after, path, file, name, from, to, previous);
    doc.after = edit.after;
    doc.actions.push(...edit.actions);
    if (name === 'codex-team') doc.beforeStamp = edit.beforeStamp;
  }
  const state = document(configPath);
  state.after = configUpdate(original, to);
  state.actions.push('update workspace version/schema');
  const changes = [...projected.values()].filter(doc => doc.before !== doc.after).map(doc => ({
    ...doc, beforeHash:doc.before === null ? null : sha(doc.before), afterHash:sha(doc.after),
  }));
  const summary = {from, to, changes: changes.map(({path, actions, beforeHash, afterHash}) => ({path, actions, beforeHash, afterHash}))};
  return {changes, summary: {...summary, planId: sha(JSON.stringify([root, summary]))}};
}

function replaceFile(change) {
  const path = workspacePath(root, change.path);
  mkdirSync(dirname(path), {recursive:true});
  const tmp = join(dirname(path), '.beerpowers-update-' + randomUUID() + '.tmp');
  const mode = lstatSync(path, {throwIfNoEntry:false})?.mode ?? (0o666 & ~process.umask());
  const fd = openSync(tmp, 'wx', mode);
  try {
    try { writeFileSync(fd, change.after); chmodSync(tmp, mode); fsyncSync(fd); }
    finally { closeSync(fd); }
    workspacePath(root, change.path);
    if (change.beforeHash === null) linkSync(tmp, path);  // O_EXCL publication of a complete file
    else {
      if (sha(read(path)) !== change.beforeHash) throw Error('Workspace changed: ' + change.path);
      renameSync(tmp, path);
    }
  } finally {
    if (lstatSync(tmp, {throwIfNoEntry: false})) unlinkSync(tmp);
  }
}

// A prepared, never committed Git reference transaction serializes two applies.
// Git releases its reference lock on EOF even if the Node parent is interrupted.
const gitOptions = ['-c', 'core.hooksPath=/dev/null'];
async function withWorkspaceLock(apply) {
  const git = spawn('git', [...gitOptions, 'update-ref', '--stdin'], {windowsHide: true});
  const closed = once(git, 'close');
  let stderr = '', prepared = false;
  git.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  git.stdin.on('error', () => {}); // The exit status below carries Git's diagnostic.
  const output = createInterface({input: git.stdout});
  git.stdin.write('start\nverify refs/beerpowers-codex-update\nprepare\n');
  try {
    for await (const line of output) {
      if (line !== 'prepare: ok') continue;
      prepared = true;
      try { apply(); }
      finally { git.stdin.end('abort\n'); }
    }
  } finally { git.stdin.end(); }
  const [code] = await closed;
  if (code !== 0 || !prepared) throw Error('Update lock unavailable: ' + stderr.trim());
}

async function main(args) {
  const mode = args.shift();
  const id = mode === 'apply' ? args.shift() : null;
  let previous;
  if (args.length === 2 && args[0] === '--previous') { previous = realpathSync(resolve(args[1])); args.length = 0; }
  if (args.length || (mode !== 'plan' && mode !== 'apply') || (mode === 'apply' && !/^[0-9a-f]{64}$/.test(id))) {
    throw Error('Usage: node update.mjs plan|apply <planId> [--previous <package>]');
  }
  const outer = execFileSync('git', [...gitOptions, 'rev-parse', '--show-toplevel'], {encoding:'utf8', windowsHide:true}).trimEnd();
  if (relative(root, realpathSync.native(outer))) throw Error('Run update from the outer Git workspace root');
  if (mode === 'plan') return plan(previous).summary;
  let result;
  await withWorkspaceLock(() => {
    const {summary, changes} = plan(previous);
    if (summary.planId !== id) throw Error('Stale plan ID. Run plan again.');
    const stamps = [];
    for (const change of changes) {
      if (change.path === configPath) continue;
      if (change.beforeStamp !== undefined && change.beforeStamp !== change.after) {
        if (change.before !== change.beforeStamp) replaceFile({...change, after:change.beforeStamp});
        stamps.push({...change, beforeHash:sha(change.beforeStamp)});
      } else replaceFile(change);
    }
    workspaceCheck(root, pkg, 'doctor');
    const version = changes.find(item => item.path === configPath);
    if (version) stamps.push(version);
    for (const change of stamps) replaceFile(change);
    result = summary;
  });
  return result;
}
try {
  console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

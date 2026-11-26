#!/usr/bin/env node
// Выбирает адаптер трекера, получает снимок постановки и направляет запросы записи.
// Tracker snapshots for BeerPowers. Run from the outer workspace.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fingerprints} from './lib/tracker-attachments.mjs';
import {read as readYandex} from './lib/yandex-tracker-read.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('tracker.mjs adapters [read|write] | read|write OPERATION [ARGS...] | preview|sync KEY | cached|accept KEY DIGEST', ['adapters', 'read', 'write', 'preview', 'sync', 'cached', 'accept']);

const root = fs.realpathSync('.');
const hash = data => createHash('sha256').update(data).digest('hex');

function checked(relative) {
  let base = root;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\:]/.test(part)) throw new Error('Unsafe tracker path');
    base = path.join(base, part);
    const stat = fs.lstatSync(base, {throwIfNoEntry:false});
    if (stat && (stat.isSymbolicLink() || fs.realpathSync(base) !== base)) throw new Error('Unsafe tracker path: ' + relative);
  }
  return base;
}

function adapter(kind, selected = process.env.BEERPOWERS_TRACKER_ADAPTER) {
  const bin = checked('.codex/bin');
  const suffix = kind === 'write' ? '-tracker-write.mjs' : '-tracker.mjs';
  const files = fs.existsSync(bin) ? fs.readdirSync(bin,{withFileTypes:true}) : [];
  const candidates = files.filter(entry => entry.isFile() && entry.name.endsWith(suffix))
    .map(entry => entry.name.slice(0,-suffix.length)).filter(name => /^[a-z][a-z0-9-]*$/.test(name)).sort();
  if (!selected && candidates.length > 1) throw new Error('Choose a tracker adapter: ' + candidates.join(', '));
  const name = selected || candidates[0] || 'yandex';
  if (!candidates.includes(name) && name !== 'yandex') throw new Error('No ' + kind + ' adapter for ' + name);
  return {name,file:candidates.includes(name) ? checked('.codex/bin/' + name + suffix) : null};
}

function invoke(file, args) {
  const result = spawnSync(process.execPath,[file,...args],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw result.error || new Error('Project tracker adapter failed');
  return JSON.parse(result.stdout);
}

function digestOf(snapshot) {
  return snapshot && hash(JSON.stringify([snapshot.statement,snapshot.files]));
}

async function inspect(dir, isCache=false) {
  if (!fs.existsSync(dir)) return null;
  const allowed = ['task.md','task-attachment',...(isCache ? ['plan.json'] : [])];
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (!allowed.includes(entry.name) || (entry.name === 'task-attachment' ? !entry.isDirectory() : !entry.isFile()))
      throw new Error('Unexpected file in tracker snapshot: ' + entry.name);
  }
  return {statement:fs.readFileSync(path.join(dir,'task.md'),'utf8').replace(/\r\n/g,'\n'),
    files:await fingerprints(path.join(dir,'task-attachment'))};
}

// Keep headings in the description as ordinary user text. Only the exported
// Tracker sections and metadata rows delimit semantic groups.
function fields(statement) {
  const entries = new Map();
  let field = 'Название';
  for (const line of statement.trimEnd().split('\n')) {
    if (line === '## Описание' || line === '## Связанные') { field = line.slice(3); continue; }
    if (/^## Комментарии — \d+$/.test(line)) { field = 'Комментарии'; continue; }
    if ((field === 'Комментарии' || field.startsWith('Комментарий ')) && line.startsWith('### ')) {
      field = 'Комментарий ' + line.slice(4);
      continue;
    }
    const row = field === 'Название' && /^\| (.*?) \| (.*) \|$/.exec(line);
    if (row) { if (!['Поле','Обновлена'].includes(row[1])) entries.set(row[1],row[2]); continue; }
    if (field === 'Название' && line === '|---|---|') continue;
    if (line || entries.has(field)) entries.set(field, (entries.get(field) || '') + line + '\n');
  }
  return new Map([...entries].map(([k,v]) => [k,v.trim()]));
}

function changesOf(before, after) {
  if (!before) return [];
  const changes = [];
  function compare(a,b,kind) {
    for (const name of new Set([...a.keys(),...b.keys()])) {
      if (a.get(name) === b.get(name)) continue;
      changes.push({kind,name,action:!a.has(name) ? 'added' : !b.has(name) ? 'removed' : 'changed',
        before:a.get(name) ?? null, after:b.get(name) ?? null});
    }
  }
  compare(fields(before.statement),fields(after.statement),'field');
  compare(new Map(before.files),new Map(after.files),'attachment');
  return changes;
}

async function download(key,dir,provider) {
  const rel = file => path.relative(root,path.join(dir,file)).split(path.sep).join('/');
  const args = ['read',key,'--comments','--out',rel('task.md'),'--attachments',rel('task-attachment')];
  if (provider.file) {
    invoke(provider.file,args);
    if (!fs.lstatSync(path.join(dir,'task-attachment')).isDirectory()) throw new Error('Project tracker adapter did not create the attachment directory');
  } else await readYandex(args.slice(1), checked);
}

function replaceDirectory(stage,target) {
  const backup = target + '.previous';
  if (fs.existsSync(backup)) throw new Error('Inspect interrupted tracker snapshot: ' + backup);
  const exists = fs.existsSync(target);
  if (exists) fs.renameSync(target,backup);
  try { fs.renameSync(stage,target); }
  catch (err) { if (exists) fs.renameSync(backup,target); throw err; }
  if (exists) fs.rmSync(backup,{recursive:true});
}

async function readPreview(cache,key,digest,before,{allowReplay=false}={}) {
  const after = await inspect(cache,true);
  if (!after) throw new Error('Preview the issue before reading its cached snapshot');
  const plan = JSON.parse(fs.readFileSync(path.join(cache,'plan.json'),'utf8'));
  const identity = [key,plan.baseline,digestOf(after)];
  if (plan.adapter !== undefined) identity.push(plan.adapter);
  if (digest !== plan.digest || digest !== hash(JSON.stringify(identity)))
    throw new Error('Tracker preview digest mismatch');
  if (digestOf(before) !== plan.baseline && !(allowReplay && digestOf(before) === digestOf(after)))
    throw new Error('Saved tracker snapshot changed after preview');
  const changes = changesOf(before,after);
  const status = !before ? 'initial' : changes.length ? 'changed' : 'unchanged';
  return {after,report:{key,status,changes,statement:after.statement,adapter:plan.adapter ?? 'yandex',
    attachments:after.files.map(([name,sha256])=>({name,sha256})),digest,
    path:path.relative(root,path.join(cache,'task.md')).split(path.sep).join('/')}};
}

async function run(action,key,digest) {
  if (!/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(key || '') || key.length > 150) throw new Error('Expected a PROJECT-NNN issue key');
  const cacheRoot = checked('.codex/.cache/task-start');
  const cache = checked('.codex/.cache/task-start/' + key);
  const saved = checked('memory/tasks/' + key + '/tracker');
  if (action === 'cached') {
    return (await readPreview(cache,key,digest,await inspect(saved))).report;
  }
  fs.mkdirSync(cacheRoot,{recursive:true});
  const lock = checked('.codex/.cache/task-start/' + key + '.lock');
  try { fs.mkdirSync(lock); } catch(err) {
    if (err.code === 'EEXIST') throw new Error('Another tracker operation or interrupted lock: ' + lock);
    throw err;
  }
  try {
    const before = await inspect(saved);
    if (action !== 'accept') {
      const provider = adapter('read');
      await inspect(cache,true);
      const stage = fs.mkdtempSync(path.join(cacheRoot,key + '.stage-'));
      try {
        await download(key,stage,provider);
        const after = await inspect(stage);
        const baseline = digestOf(before);
        digest = hash(JSON.stringify([key,baseline,digestOf(after),provider.name]));
        fs.writeFileSync(path.join(stage,'plan.json'),JSON.stringify({baseline,digest,adapter:provider.name}));
        replaceDirectory(stage,cache);
      } finally { fs.rmSync(stage,{recursive:true,force:true}); }
    }
    const {after,report} = await readPreview(cache,key,digest,before,{allowReplay:action === 'accept'});
    if (action !== 'preview' && report.status !== 'unchanged') {
      fs.mkdirSync(path.dirname(saved),{recursive:true});
      const stage = fs.mkdtempSync(saved + '.stage-');
      try {
        fs.copyFileSync(path.join(cache,'task.md'),path.join(stage,'task.md'));
        fs.cpSync(path.join(cache,'task-attachment'),path.join(stage,'task-attachment'),{recursive:true});
        if (digestOf(await inspect(stage)) !== digestOf(after)) throw new Error('Tracker cache changed during copy');
        replaceDirectory(stage,saved);
      } finally { fs.rmSync(stage,{recursive:true,force:true}); }
    }
    if (action !== 'preview') report.path = path.relative(root,path.join(saved,'task.md')).split(path.sep).join('/');
    return report;
  } finally { fs.rmdirSync(lock); }
}

try {
  const [action,...args] = process.argv.slice(2);
  if (action === 'adapters' && args.length <= 1) {
    if (args.length && !['read','write'].includes(args[0])) throw new Error('Expected adapters [read|write]');
    console.log(JSON.stringify(adapter(args[0] ?? 'read').name));
  } else if (action === 'write' || action === 'read') {
    const provider = adapter(action);
    if (provider.file) console.log(JSON.stringify(invoke(provider.file,[action,...args])));
    else if (action === 'read') console.log(JSON.stringify(await readYandex(args, checked)));
    else {
      const {write} = await import('./lib/yandex-tracker-write.mjs');
      await write(args,checked);
    }
  } else {
    if (!['sync','preview','cached','accept'].includes(action) || args.length !== (['accept','cached'].includes(action) ? 2 : 1))
      throw new Error('Expected read|preview|sync KEY, cached|accept KEY DIGEST, adapters [read|write], or write OPERATION');
    console.log(JSON.stringify(await run(action,...args)));
  }
} catch(err) { console.error(err.message); process.exitCode = 1; }

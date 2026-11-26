// Готовит чеклист приёмки по постановке и фактическому состоянию checkout.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { checkout, reportLines, reviewed } from './publication.mjs';
import { discover, git, safe, taskData } from './lib/git-repositories.mjs';

const usage = 'Usage: qa-checklist.mjs TASK < tester.json | qa-checklist.mjs --status TASK';
const prefix = '<!doctype html><!-- beerpowers:qa-checklist --><html lang="ru">';
const esc = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function field(text) {
  if (typeof text !== 'string' || !text.trim()) throw Error('Expected nonempty tester text');
  return esc(text.trim());
}
function checklist(task, statusOnly) {
  const repos = discover();
  const {dir, saved} = taskData(task);
  const brief = safe(dir + '/preflight.md');
  if (!existsSync(brief)) return {status:'skipped', reason:'no-preflight'};
  const cls = [...readFileSync(brief, 'utf8').matchAll(/^Класс:\s*([^\s.]+)/gm)].at(-1)?.[1];
  if (['trivial','тривиальная'].includes(cls)) return {status:'skipped', reason:'trivial'};
  if (!cls) throw Error('Missing task class');
  const names = saved.repos?.map(row => row.name) ?? (repos.length === 1 ? [repos[0].name] : []);
  if (!names.length || new Set(names).size !== names.length) throw Error('Missing or ambiguous task product scope');
  const file = dir + '/' + basename(task) + '-qa.html', target = safe(file);
  const revisions = Object.create(null);
  const metrics = [];
  for (const name of names) {
    if (!repos.some(repo => repo.name === name)) throw Error('Missing task product');
    const plan = checkout(task, name), cwd = safe(plan.checkout);
    const sha = git(cwd, ['rev-parse','HEAD']);
    if (git(cwd, ['symbolic-ref','--short','HEAD']) !== task) throw Error('Expected reviewed task branch');
    if (git(cwd,['status','--porcelain','--untracked-files=all'])) throw Error('Expected clean reviewed checkout');
    reviewed(task, name, sha, plan.baseSha, cwd);
    revisions[name] = sha;
    if (!statusOnly) metrics.push(field(name) + ' · ' + sha + ' · ' + field(git(cwd,['diff','--shortstat',plan.baseSha,sha])));
  }
  if (statusOnly) return deliveryStatus(dir, file, target, revisions);
  const draft = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  if (names.some(name => draft.revisions?.[name] !== revisions[name])) throw Error('Tester draft has stale checkout SHA');
  if (Object.keys(draft.revisions).length !== names.length) throw Error('Unexpected product in draft');
  if (!Array.isArray(draft.cases) || !draft.cases.length) throw Error('Expected test cases');
  const rows = draft.cases.map(row => {
    if (!['критично','новое','не проверялось'].includes(row.tag)) throw Error('Invalid scenario tag');
    return '<li><label><input type="checkbox"> <strong>' + field(row.screen) + '</strong> · ' +
      field(row.tag) + ' · Сделать: ' + field(row.action) + '. Ожидается: ' + field(row.expected) + '</label></li>';
  }).join('\n');
  const header = '<h1>' + field(task) + ' · ' + field(draft.title) + '</h1><p>' + field(draft.reason) +
    '</p>' + metricsList(metrics);
  const body = header + '<h2>Тестовые данные</h2><p>' + field(draft.data) + '</p><h2>Проверки</h2><ul>' + rows +
    '</ul><h2>Известные ограничения</h2><p>' + field(draft.limits) + '</p>';
  const key = createHash('sha256').update(body).digest('hex');
  const html = prefix + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + field(task) + ' — QA</title><style>body{font:1rem/1.5 system-ui;max-width:60rem;margin:auto;padding:1rem}nav{position:sticky;top:0;background:white;padding:.5rem}li{margin:.75rem 0}textarea{width:100%}</style>' +
    '<nav>Прогресс <output></output> <button type="button">Сбросить</button></nav>' + body +
    '<footer><h2>Сообщить о дефекте</h2><label>Скопируйте заполненное сообщение в трекер<textarea rows="7">Задача: ' + field(task) +
    '\nСценарий:\nОкружение и данные:\nШаги:\nОжидалось:\nПолучено:\nДоказательство:</textarea></label></footer>' +
    '<script>const key="beerpowers-qa-' + key + '",boxes=[...document.querySelectorAll("input")];' +
    'let saved=[];try{saved=JSON.parse(localStorage.getItem(key))||[]}catch{}' +
    'function update(){const state=boxes.map(x=>x.checked);document.querySelector("output").textContent=state.filter(Boolean).length+" / "+boxes.length;try{localStorage.setItem(key,JSON.stringify(state))}catch{}}' +
    'boxes.forEach((x,i)=>{x.checked=saved[i]===true;x.onchange=update});document.querySelector("button").onclick=()=>{boxes.forEach(x=>x.checked=false);update()};update()</script></html>\n';
  if (existsSync(target)) {
    const existing = readFileSync(target,'utf8');
    if (existing === html) return {status:'unchanged', file};
    if (!existing.startsWith(prefix)) throw Error('Existing manual QA file; reconcile it before generating the checklist');
  }
  const temp = target + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temp,html,{flag:'wx'}); renameSync(temp,target); }
  finally { rmSync(temp,{force:true}); }
  return {status:'ready', file};
}

function metricsList(metrics) {
  return '<ul><li>' + metrics.join('</li><li>') + '</li></ul>';
}

function deliveryStatus(dir, file, target, revisions) {
  if (!existsSync(target)) return {status:'missing', file, revisions};
  const bytes = readFileSync(target), html = bytes.toString('utf8');
  if (!html.startsWith(prefix)) throw Error('Existing manual QA file; reconcile it before resuming QA');
  const rows = /<\/h1><p>[^<]*<\/p><ul><li>([\s\S]*?)<\/li><\/ul>/.exec(html)?.[1].split('</li><li>') ?? [];
  const approved = Object.entries(revisions);
  if (rows.length !== approved.length || approved.some(([name, sha]) =>
    !rows.some(row => row.startsWith(field(name) + ' · ' + sha + ' · ')))) return {status:'stale', file, revisions};
  const digest = createHash('sha256').update(bytes).digest('hex');
  const handover = dir + '/handover.md';
  const receipt = existsSync(safe(handover)) && reportLines(handover).join('\n').match(
    new RegExp('^## QA\\n\\nQA delivered: ' + digest + ' ([A-Za-z0-9._:-]+)$', 'm'));
  return receipt ? {status:'delivered', file, revisions, digest, operation:receipt[1]} :
    {status:'pending', file, revisions, digest};
}
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log(usage);
  else if (args.length === 1) console.log(JSON.stringify(checklist(args[0], false)));
  else if (args.length === 2 && args[0] === '--status') console.log(JSON.stringify(checklist(args[1], true)));
  else throw Error(usage);
} catch (error) { console.error(error.message); process.exitCode = 1; }

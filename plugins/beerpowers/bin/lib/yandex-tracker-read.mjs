// Читает задачи, комментарии и вложения через API Яндекс Трекера.
import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {parseArgs} from 'node:util';
import {connection, issueKey} from './yandex-tracker-api.mjs';
import {filename, fingerprints} from './tracker-attachments.mjs';

function render(issue, comments) {
  const display = v => String(v?.display || v?.key || v?.id || '—').replace(/[\r\n]+/g, ' ');
  const date = v => v ? String(v).slice(0,10) : '—';
  const lines = ['# ' + issue.key + ' · ' + String(issue.summary || '').replace(/[\r\n]+/g,' '),'',
    '| Поле | Значение |','|---|---|'];
  for (const [label, prop] of [['Статус','status'],['Тип','type'],['Приоритет','priority'],['Автор','createdBy'],['Исполнитель','assignee']])
    lines.push('| ' + label + ' | ' + display(issue[prop]) + ' |');
  if (issue.dueDate) lines.push('| Дедлайн | ' + date(issue.dueDate) + ' |');
  lines.push('| Создана | ' + date(issue.createdAt) + ' |','| Обновлена | ' + date(issue.updatedAt) + ' |',
    '| Ссылка | https://tracker.yandex.ru/' + issue.key + ' |','');
  if (issue.description) lines.push('## Описание','',issue.description.trim(),'');
  const links = [issue.parent,...(issue.links || []).map(link => link.object)].filter(Boolean);
  if (links.length) lines.push('## Связанные','',...links.map(link => '- ' + (link.key || link.id)), '');
  if (comments.length) {
    lines.push('## Комментарии — ' + comments.length,'');
    for (const c of comments) lines.push('### ' + display(c.createdBy) + ' · ' + date(c.createdAt) + ' · #' + c.id,'',(c.text || '').trim(),'');
  }
  return lines.join('\n').replace(/\r\n/g,'\n') + '\n';
}

async function issueOf(api,key,route) {
  const issue = await api('GET',route);
  if (issue?.key !== key) throw new Error('Tracker returned unexpected issue');
  return issue;
}

async function commentsOf(api,route) {
  const comments = new Map();
  let cursor = '';
  while (true) {
    const page = await api('GET', route + '/comments?perPage=50' + (cursor ? '&id=' + encodeURIComponent(cursor) : ''));
    if (!Array.isArray(page)) throw new Error('Invalid tracker comments');
    for (const c of page) {
      if (c?.id === undefined) throw new Error('Tracker comment has no id');
      comments.set(String(c.id),c);
    }
    if (page.length < 50) break;
    const last = String(page.at(-1).id);
    if (last === cursor) throw new Error('Tracker comment cursor did not advance');
    cursor = last;
  }
  return [...comments.values()];
}

async function attachmentsOf({api,attachment},route,target) {
  const list = await api('GET',route + '/attachments');
  if (!Array.isArray(list)) throw new Error('Invalid tracker attachments');
  const used = new Set();
  for (const item of list) {
    const name = filename(item.name);
    const folded = name.normalize().toLowerCase();
    if (!item.content || used.has(folded)) throw new Error('Missing attachment URL or duplicate filename');
    used.add(folded);
    const res = await attachment(item.content);
    await pipeline(res.body, fs.createWriteStream(path.join(target,name),{flags:'wx'}));
  }
  return await fingerprints(target);
}

export async function read(args, checked) {
  const {values,positionals} = parseArgs({args,allowPositionals:true,options:{
    comments:{type:'boolean'},'comments-limit':{type:'string'},json:{type:'boolean'},
    out:{type:'string'},attachments:{type:'string'}
  }});
  const [key] = positionals;
  if (positionals.length !== 1 || !issueKey.test(key || '') || key.length > 150) throw new Error('Expected a PROJECT-NNN issue key');
  const limit = Number(values['comments-limit'] ?? 0);
  if (values['comments-limit'] !== undefined && (!/^\d+$/.test(values['comments-limit']) || !Number.isSafeInteger(limit)))
    throw new Error('Expected a nonnegative integer for --comments-limit');
  const route = '/issues/' + key;
  const client = connection();
  const wantsComments = values.comments || values['comments-limit'] !== undefined;
  const issue = !values.attachments || values.out || values.json || wantsComments ? await issueOf(client.api,key,route) : null;
  if (values.json && !values.attachments && !values.out) return issue;
  const all = wantsComments && !values.json ? await commentsOf(client.api,route) : [];
  const comments = limit ? all.slice(-limit) : all;
  const statement = issue ? render(issue,comments) : null;
  const target = values.out && checked(values.out);
  if (target) {
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,values.json ? JSON.stringify(issue,null,2) + '\n' : statement,{flag:'wx'});
  }
  let attachments = [];
  if (values.attachments) {
    const dir = checked(values.attachments);
    fs.mkdirSync(path.dirname(dir),{recursive:true});
    const stage = fs.mkdtempSync(dir + '.stage-');
    try {
      attachments = (await attachmentsOf(client,route,stage)).map(([name,sha256])=>({name,sha256}));
      if (fs.existsSync(dir)) {
        if (!fs.lstatSync(dir).isDirectory()) throw new Error('Expected attachment directory');
        for (const {name} of attachments) {
          if (fs.lstatSync(path.join(dir,name),{throwIfNoEntry:false})) throw new Error('Attachment already exists: ' + name);
        }
        for (const {name} of attachments) fs.copyFileSync(path.join(stage,name),path.join(dir,name),fs.constants.COPYFILE_EXCL);
      } else fs.renameSync(stage,dir);
    } finally { fs.rmSync(stage,{recursive:true,force:true}); }
  }
  if (values.json) return issue;
  return {key,statement,comments,commentCount:all.length,attachments};
}

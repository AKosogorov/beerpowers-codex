import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {authorModel, modelSignature} from '../plugins/beerpowers/bin/lib/model-signature.mjs';

const exec = promisify(execFile);
const tool = fileURLToPath(new URL('../plugins/beerpowers/bin/tracker.mjs',import.meta.url));
const key = 'TEST-14';

test('signature follows the latest turn context in the exact current session', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beerpowers-author-'));
  t.after(() => fs.rmSync(home, {recursive:true,force:true}));
  const id = '01a20c55-0000-7000-a000-000000000001';
  const dir = path.join(home, 'sessions', '2026', '11', '24');
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, 'rollout-a-' + id + '.jsonl'), [
    {type:'turn_context',payload:{model:'gpt-6.2-astra'}},
    {type:'turn_context',ordinal:2,payload:{model:'gpt-6.2-sol'}},
    {type:'response_item',payload:{type:'turn_context',model:'gpt-6.1-terra'}},
  ].map(row => JSON.stringify(row)).join('\n'));
  fs.writeFileSync(path.join(dir, 'rollout-unrelated.jsonl'), JSON.stringify({type:'turn_context',payload:{model:'gpt-6.1-terra'}}));
  const env = {CODEX_HOME:home,CODEX_THREAD_ID:id};
  assert.equal(await authorModel(env), 'gpt-6.2-sol');
  await assert.rejects(authorModel({...env, BEERPOWERS_MODEL:'gpt-6.1-terra'}), /disagrees/);
  const missing = {...env, CODEX_THREAD_ID:id.replace(/1$/, '2')};
  await assert.rejects(authorModel(missing), /Unknown author model/);
  assert.equal(await authorModel({...missing, BEERPOWERS_MODEL:'gpt-6.1-terra'}), 'gpt-6.1-terra');
});

test('all signature styles keep exact model IDs and match the model family', () => {
  const expected = {
    'gpt-6.2-sol': ['ИИльич Солнечный', 'ВЗаконе, погоняло Солнце', '006.2: Позывной «Солнцепёк»'],
    'gpt-6.2-astra': ['ИИльич Астральный', 'ВЗаконе, в народе Астра', '006.2: Позывной «Астра»'],
    'gpt-6.1-terra': ['ИИльич Земляков', 'ВЗаконе, авторитет Терра', '006.1: Позывной «Земляк»'],
  };
  for (const [model, styles] of Object.entries(expected)) {
    styles.forEach((name, style) => {
      assert.equal(modelSignature(model, style), `© ${style === 2 ? 'Агент ' : ''}Кодекс ${name} (${model})`);
    });
  }
  assert.match(modelSignature('gpt-5.6-luna', 0), /Лунный \(gpt-5\.6-luna\)$/);
  assert.match(modelSignature('gpt-5.6-luna', 1), /Луноход \(gpt-5\.6-luna\)$/);
  assert.match(modelSignature('gpt-5.6-luna', 2), /005\.6:.*«Лунатик» \(gpt-5\.6-luna\)$/);
  assert.match(modelSignature('o3', 2), /Агент Кодекс Позывной «Кодекс» \(o3\)$/);
});

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'beerpowers-tracker-'));
  const issue = {key,summary:'Список заказов',description:'Показываем открытые заказы.',status:{key:'open',display:'Открыта'},
    type:{display:'Задача'},assignee:{display:'Иван'},updatedAt:'2026-02-01'};
  const state = {issue,files:new Map([['макет 1.txt','fixture attachment']]),
    comments:[{id:1,createdBy:{display:'Тест',id:'7'},createdAt:'2026-02-01',text:'Сортировка по дате.'}],
    requests:[],denied:false,broken:false,failComment:false,writes:[],links:[],uploads:[],
    transitions:[{id:'closed',to:{key:'closed',display:'Закрыта'}}]};
  const server = http.createServer(async (req,res)=>{
    const url = new URL(req.url,'http://localhost');
    state.requests.push(req.method + ' ' + url.pathname);
    assert.equal(req.headers.authorization,'OAuth fixture');
    const send = (status,value) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if (state.denied || !req.headers['x-org-id']) return send(403,{});
    const route = '/v2/issues/' + key;
    if (url.pathname === '/v2/myself') return send(200,{uid:7,display:'Тест'});
    if (url.pathname === route && req.method === 'GET') return send(200,issue);
    if (url.pathname === route && req.method === 'PATCH') {
      state.writes.push(await body());
      return send(200,issue);
    }
    async function body() {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks));
    }
    if (url.pathname === route + '/transitions') return send(200,state.transitions);
    if (url.pathname === route + '/links' && req.method === 'GET') return send(200,state.links);
    if (url.pathname === route + '/links' && req.method === 'POST') {
      const link = await body();
      state.links.push({id:9,type:{id:link.relationship},object:{key:link.issue}});
      return send(201,state.links.at(-1));
    }
    if (url.pathname === route + '/links/9' && req.method === 'DELETE') {
      state.links = state.links.filter(link => link.id !== 9);
      return send(200,{});
    }
    if (url.pathname === route + '/transitions/closed/_execute' && req.method === 'POST') {
      state.writes.push(await body());
      return send(200,{});
    }
    if (url.pathname === route + '/comments/1') {
      if (req.method === 'GET') return send(200,state.comments[0]);
      if (req.method === 'DELETE') {
        state.comments.shift();
        return send(200,{});
      }
      if (req.method === 'PATCH') {
        state.writes.push(await body());
        return send(200,{});
      }
    }
    if (url.pathname === route + '/comments' && req.method === 'POST') {
      const comment = await body();
      if (state.failComment) return send(503,{});
      state.writes.push(comment);
      if (state.loseCommentResponse) {
        state.comments.push({id:2,createdBy:{id:'7',display:'Тест'},text:comment.text});
        return res.destroy();
      }
      return send(201,{id:2});
    }
    if (url.pathname === '/v2/issues' && req.method === 'POST') {
      state.writes.push(await body());
      return send(201,{key:'TEST-15'});
    }
    if (url.pathname === route + '/comments') {
      const offset = url.searchParams.has('id') ? state.comments.findIndex(c=>String(c.id) === url.searchParams.get('id')) + 1 : 0;
      return send(200,state.comments.slice(offset,offset + 50));
    }
    if (url.pathname === route + '/attachments' || url.pathname === '/v2/attachments') {
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        state.uploads.push(Buffer.concat(chunks).toString());
        return send(201,{id:12});
      }
      return send(200,[...state.files.keys()].map((name,i)=>({id:i+1,name,content:'/download/' + i})));
    }
    if (url.pathname.startsWith('/download/')) {
      if (state.broken) return send(503,{});
      res.writeHead(302,{location:'/storage/' + url.pathname.split('/').pop()});
      return res.end();
    }
    if (url.pathname.startsWith('/storage/')) {
      res.end([...state.files.values()][Number(url.pathname.split('/').pop())]); return;
    }
    return send(404,{});
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(async ()=>{
    await new Promise(resolve=>server.close(resolve));
    if (fs.realpathSync(path.dirname(directory)) === fs.realpathSync(os.tmpdir()) && path.basename(directory).startsWith('beerpowers-tracker-'))
      fs.rmSync(directory,{recursive:true,force:true});
  });
  const env = {SystemRoot:process.env.SystemRoot || '',YANDEX_TRACKER_API_HOST:'http://127.0.0.1:' + server.address().port,
    BEERPOWERS_MODEL: 'gpt-6.2-astra'};
  const run = async (...argv) => {
    const {stdout} = await exec(process.execPath,[tool,...argv],{cwd:directory,env});
    return JSON.parse(stdout);
  };
  return {directory,state,run,env,saved:path.join(directory,'memory','tasks',key,'tracker')};
}

test('selective read can return latest comments, raw JSON or one artifact without downloading other data', async t => {
  const {directory,state,run,env} = await fixture(t);
  env.YANDEX_TRACKER_ORG_TYPE = 'yandex360';
  for (let id = 2; id <= 52; id++) state.comments.push({id,text:'Комментарий ' + id});
  const recent = await run('read',key,'--comments-limit','3');
  assert.deepEqual(recent.comments.map(c => c.id),[50,51,52]);
  assert.ok(state.requests.every(route => !route.includes('attachments') && !route.includes('download')));
  state.requests.length = 0;
  assert.deepEqual(await run('read',key,'--json'),state.issue);
  assert.deepEqual(state.requests,['GET /v2/issues/' + key]);
  await run('read',key,'--out','description.md');
  assert.match(fs.readFileSync(path.join(directory,'description.md'),'utf8'),/Показываем открытые заказы/);
  state.requests.length = 0;
  await run('read',key,'--attachments','downloads');
  assert.equal(fs.readFileSync(path.join(directory,'downloads','макет 1.txt'),'utf8'),'fixture attachment');
  assert.ok(state.requests.every(route => !route.endsWith(key) && !route.includes('comments')));
});

test('project write adapters receive the tracker command and require a choice when ambiguous', async t => {
  const {directory,state,run,env} = await fixture(t);
  const bin = path.join(directory,'.codex','bin');
  fs.mkdirSync(bin,{recursive:true});
  const code = 'console.log(JSON.stringify({args:process.argv.slice(2)}))';
  for (const name of ['acme','other']) fs.writeFileSync(path.join(bin,name+'-tracker-write.mjs'),code);
  const args = ['write','comment',key,'draft.md','--request','test-1'];
  await assert.rejects(run(...args),/acme, other/);
  env.BEERPOWERS_TRACKER_ADAPTER = 'acme';
  assert.deepEqual(await run(...args),{args});
  assert.deepEqual(state.requests,[]);
});

test('explicit comment request sends immediately and replay returns the prior result', async t => {
  const {directory,state,run} = await fixture(t);
  fs.writeFileSync(path.join(directory,'note.md'),'Готово.\n');
  const args = ['write','comment',key,'note.md','--request','turn-note-1'];
  const applied = await run(...args);
  assert.equal(applied.status,'ok');
  assert.deepEqual(await run(...args),applied);
  assert.equal(state.writes.length,1);
  fs.writeFileSync(path.join(directory,'note.md'),'Другой текст.\n');
  await assert.rejects(run(...args),/request.*changed/i);
  assert.equal(state.writes.length,1);
  const remove = ['write','delete-comment',key,'1'];
  await assert.rejects(run(...remove,'--request','turn-delete-1'), /requires preview and confirmation/);
  const deletion = await run(...remove);
  assert.equal(deletion.comment.text,'Сортировка по дате.');
  assert.equal(deletion.comment.author,'Тест');
  const removed = await run(...remove,'--confirm',deletion.digest);
  assert.equal(removed.status,'ok');
  assert.deepEqual(state.comments,[]);
  assert.deepEqual(await run(...remove,'--confirm',deletion.digest),removed);
});

test('snapshot preview, paginated comments, unchanged resume and semantic delta',async t=>{
  const {directory,state,run,saved} = await fixture(t);
  for (let id=2;id<=52;id++) state.comments.push({id,text:'Комментарий ' + id,createdBy:{display:'Тест'}});
  const first = await run('preview',key);
  assert.equal(first.status,'initial');
  assert.match(first.statement,/Комментарий 52/);
  assert.match(first.path,/^\.codex\/\.cache\/task-start\//);
  assert.ok(fs.existsSync(path.join(directory,first.path)));
  assert.equal(fs.existsSync(saved),false);
  const requests = state.requests.length;
  assert.deepEqual(await run('cached',key,first.digest),first);
  assert.equal(state.requests.length,requests);
  assert.equal(fs.existsSync(saved),false);
  const accepted = await run('accept',key,first.digest);
  assert.equal(accepted.status,'initial');
  const statement = fs.readFileSync(path.join(saved,'task.md'),'utf8');
  assert.equal(first.statement,statement);
  state.issue.updatedAt = '2026-02-02';
  assert.equal((await run('sync',key)).status,'unchanged');
  assert.equal(fs.readFileSync(path.join(saved,'task.md'),'utf8'),statement);
  state.issue.description += ' Только за неделю.';
  state.issue.assignee.display = 'Анна';
  state.issue.status.display = 'В работе';
  state.comments[0].text = 'Новый порядок.';
  state.comments.pop();
  state.files.set('макет 1.txt','замена');
  state.files.set('схема.txt','новая');
  const preview = await run('preview',key);
  assert.equal(preview.status,'changed');
  assert.deepEqual(new Set(preview.changes.map(c=>c.name)),new Set(['Описание','Статус','Исполнитель',
    'Комментарий Тест · 2026-02-01 · #1','Комментарий Тест · — · #52','макет 1.txt','схема.txt']));
  assert.equal(fs.readFileSync(path.join(saved,'task.md'),'utf8'),statement);
  await run('accept',key,preview.digest);
  assert.equal(fs.readFileSync(path.join(saved,'task-attachment','макет 1.txt'),'utf8'),'замена');
  state.files.delete('макет 1.txt');
  const removed = await run('sync',key);
  assert.equal(removed.changes[0].action,'removed');
  assert.equal(fs.existsSync(path.join(saved,'task-attachment','макет 1.txt')),false);
});

test('access errors, failed attachment and changed cache preserve last accepted snapshot',async t=>{
  const {run,saved,state,directory} = await fixture(t);
  await run('sync',key);
  const file = path.join(saved,'task.md');
  const original = fs.readFileSync(file,'utf8');
  state.denied = true;
  await assert.rejects(run('preview',key),/HTTP 403/);
  state.denied = false;
  state.broken = true;
  await assert.rejects(run('sync',key),/HTTP 503/);
  assert.equal(fs.readFileSync(file,'utf8'),original);
  state.broken = false;
  state.files.set('../bad','no');
  await assert.rejects(run('sync',key),/Unsafe attachment/);
  state.files.delete('../bad');
  state.issue.summary = 'Поменялось';
  const preview = await run('preview',key);
  fs.appendFileSync(file,'manual edit\n');
  await assert.rejects(run('cached',key,preview.digest),/changed after preview/);
  await assert.rejects(run('accept',key,preview.digest),/changed after preview/);
  fs.writeFileSync(file,original);
  fs.appendFileSync(path.join(directory,preview.path),'cache edit\n');
  await assert.rejects(run('cached',key,preview.digest),/digest mismatch/);
  await assert.rejects(run('accept',key,preview.digest),/digest mismatch/);
  assert.equal(fs.readFileSync(file,'utf8'),original);
});

test('explicit QA comment uploads its checklist and replay sends it only once',async t=>{
  const {directory,run,state} = await fixture(t);
  const html = key + '-qa.html';
  fs.writeFileSync(path.join(directory,html),'<!doctype html><title>QA</title>');
  fs.writeFileSync(path.join(directory,'qa.md'),'[Чеклист](' + html + ')');
  const args = ['write','comment',key,'qa.md'];
  const prepared = await run(...args);
  assert.equal(prepared.status,'needs-confirmation');
  assert.deepEqual(prepared.attachments.map(file => file.path),[html]);
  assert.deepEqual(state.uploads,[]);
  const result = await run(...args,'--request','qa-checklist-1');
  assert.equal(result.status,'ok');
  assert.deepEqual(await run(...args,'--request','qa-checklist-1'),result);
  assert.equal(state.uploads.length,1);
  assert.match(state.uploads[0],/Content-Type: text\/html/i);
  assert.match(state.uploads[0],/<!doctype html><title>QA<\/title>/);
  assert.equal(state.writes.length,1);
  assert.deepEqual(state.writes[0].attachmentIds,[12]);
});

test('team lead can manage links and own comment, separate attachments and deletion require confirmation',async t=>{
  const {directory,run,state} = await fixture(t);
  const file = 'note.md';
  fs.writeFileSync(path.join(directory,file),'Исправлено [с файлом](proof.txt)');
  fs.writeFileSync(path.join(directory,'proof.txt'),'доказательство');
  await run('write','link',key,'связана','TEST-1','--request','add-link');
  assert.equal(state.links[0].object.key,'TEST-1');
  await run('write','unlink',key,'TEST-1','--request','remove-link');
  assert.deepEqual(state.links,[]);
  const edit = ['write','edit-comment',key,'1',file];
  const change = await run(...edit);
  assert.equal(change.comment.text,state.comments[0].text);
  assert.equal((await run(...edit,'--request','correct-note')).status,'ok');
  assert.deepEqual(state.writes[0].attachmentIds,[12]);
  assert.ok(state.requests.includes('POST /v2/attachments'));
  assert.ok(!state.requests.includes('POST /v2/issues/' + key + '/attachments'));
  for (const args of [['attach',key,'proof.txt'], ['detach',key,'12'], ['delete-comment',key,'1']]) {
    await assert.rejects(run('write',...args,'--request','direct'), /requires preview and confirmation/);
    assert.equal((await run('write',...args)).status,'needs-confirmation');
  }
  state.comments[0].createdBy = {id:'8',display:'Другой автор'};
  state.requests.length = 0;
  await assert.rejects(run(...edit,'--request','foreign-edit'),/чужой комментарий/);
  await assert.rejects(run('write','delete-comment',key,'1'),/чужой комментарий/);
  assert.ok(state.requests.every(request => request.startsWith('GET ')));
});

test('a created MR independently supplies QA and verbatim deployment comments, replay resumes a partial delivery',async t=>{
  const {directory,run,state,env} = await fixture(t);
  const task = 'feature/' + key;
  const folder = path.join(directory,'memory','tasks',task);
  fs.mkdirSync(folder,{recursive:true});
  const html = path.join(folder,key + '-qa.html');
  const section = ['## Для выкладки на стенд','','1. Открыть [инструкцию](doc/run.md).  ',
    '2. Проверить журнал.', '', '~~~', '## пример заголовка', '~~~', '### Данные', 'Таблица orders.'].join('\r\n');
  async function prepare(n,actions) {
    const url = 'https://gitlab.example/team/repo/-/merge_requests/' + n;
    const args = ['mr-comments',key,task,url,actions ? 'yes' : 'no'];
    const child = exec(process.execPath,[tool,...args],{cwd:directory,env});
    const body = actions ? section : '## Для выкладки на стенд\n\nДействий нет.';
    child.child.stdin.end(body + '\r\n\r\n## Зачем\r\n\r\nЗадача.');
    return JSON.parse((await child).stdout).comments;
  }
  async function send(item,retry=false) {
    const args = ['write','comment',key,'-',...(item.verbatim ? ['--verbatim'] : []),
      ...(retry ? ['--retry'] : []),'--request',item.request];
    const command = exec(process.execPath,[tool,...args],{cwd:directory,env});
    command.child.stdin.end(item.text);
    return JSON.parse((await command).stdout);
  }
  for (const qa of [false,true]) for (const steps of [false,true]) {
    if (qa) fs.writeFileSync(html,'<title>QA</title>');
    const mr = 1 + Number(qa) * 2 + Number(steps);
    const comments = await prepare(mr,steps);
    assert.deepEqual(comments.map(c => c.kind),[...(qa ? ['qa'] : []),...(steps ? ['deploy'] : [])]);
    const initialWrites = state.writes.length;
    for (const c of comments) {
      if (qa && c.kind === 'deploy') {
        state.failComment = true;
        await assert.rejects(send(c),/HTTP 503/);
        state.failComment = false;
        const repeated = await prepare(mr,steps);
        assert.deepEqual(repeated,comments);
        await send(repeated[0]);
        assert.equal(state.writes.length,initialWrites + 1);
        await assert.rejects(send(repeated[1]),/check Tracker/i);
        await send(repeated[1],true);
      } else await send(c);
      const written = state.writes.at(-1);
      if (c.kind === 'deploy') {
        assert.equal(c.text,section);
        assert.equal(written.text.split('\n\n{orange}')[0],section);
        assert.equal(written.attachmentIds,undefined);
      } else assert.deepEqual(written.attachmentIds,[12]);
    }
    assert.equal(state.writes.length-initialWrites,comments.length);
  }
  assert.equal(state.uploads.length,2);

  // Сервер сохранил запись, но соединение закрылось до получения ID.
  const lost = (await prepare(7,true))[1];
  const before = state.writes.length;
  state.loseCommentResponse = true;
  await assert.rejects(send(lost));
  state.loseCommentResponse = false;
  await assert.rejects(send(lost),/check Tracker/i);
  const remote = await run('read',key,'--comments');
  assert.equal(remote.comments.find(c => c.text.startsWith(section))?.id,2);
  assert.equal(state.writes.length,before + 1);
});

test('separate confirmation binds target, content and attachments before writing to local API',async t=>{
  const {directory,run,state} = await fixture(t);
  fs.writeFileSync(path.join(directory,'comment.md'),'Проверены заказы.\n');
  const preview = await run('write','comment',key,'comment.md');
  assert.equal(preview.status,'needs-confirmation');
  assert.equal(preview.body.text, `Проверены заказы.\n\n{orange}(*${preview.signature}*)`);
  assert.deepEqual(await run('write','comment',key,'comment.md'), preview);
  assert.deepEqual(state.requests,[]);
  fs.appendFileSync(path.join(directory,'comment.md'),'Новая деталь.');
  await assert.rejects(run('write','comment',key,'comment.md','--confirm',preview.digest),/digest mismatch/);
  assert.deepEqual(state.writes,[]);
  const current = await run('write','comment',key,'comment.md');
  assert.equal((await run('write','comment',key,'comment.md','--confirm',current.digest)).status,'ok');
  assert.equal(state.writes.length,1);
  assert.equal(state.writes[0].text,current.body.text);
  assert.match((await run('write','template','bug')).text,/## Доказательства/);
  const draft = '# Заказы за неделю (front)\n\n| Поле | Значение |\n|---|---|\n| Очередь | TEST |\n| Тип | Задача |\n| Доска | 2 |\n| Теги | Frontend |\n\n---\n\n## Цель\n\nНайти заказ.\n\n## Что делаем\n\nСписок заказов.\n\n## Критерии приёмки\n\nВиден заказ.\n';
  fs.writeFileSync(path.join(directory,'draft.md'),draft);
  assert.equal((await run('write','check','draft.md')).status,'ok');
  await assert.rejects(run('write','create','draft.md','--request','create-1'),/requires preview and confirmation/);
  const creation = await run('write','create','draft.md');
  assert.deepEqual(creation.body.boards, [{id:2}]);
  assert.equal(creation.body.summary, 'Заказы за неделю (front)');
  assert.equal(creation.body.assignee ?? null, null);
  assert.match(creation.body.description, /## Критерии приёмки\n\nВиден заказ\./);
  assert.equal((await run('write','create','draft.md','--confirm',creation.digest)).status,'ok');
  assert.equal(state.writes[1].queue,'TEST');
  assert.deepEqual(state.writes[1], creation.body);
  const edited = draft.replace('| Теги | Frontend |', '| Теги | Frontend |\n| Исполнитель | ivan |');
  fs.writeFileSync(path.join(directory,'draft.md'),edited);
  const edit = await run('write','edit',key,'draft.md');
  assert.equal(edit.body.assignee,'ivan');
  assert.deepEqual(edit.target,{issue:key});
  await run('write','edit',key,'draft.md','--confirm',edit.digest);
  assert.deepEqual(state.writes[2],edit.body);
  fs.writeFileSync(path.join(directory,'note.md'),'[приложение](brief.txt)');
  fs.writeFileSync(path.join(directory,'brief.txt'),'данные');
  const linked = await run('write','comment',key,'note.md');
  assert.equal(linked.files.length,2);
  assert.deepEqual(linked.attachments.map(file => file.path), ['brief.txt']);
  fs.writeFileSync(path.join(directory,'brief.txt'),'другие данные');
  await assert.rejects(run('write','comment',key,'note.md','--confirm',linked.digest),/digest mismatch/);
  const revise = ['write','edit-comment',key,'1','note.md'];
  const revised = await run(...revise);
  await run(...revise,'--confirm',revised.digest);
  assert.equal(state.uploads.length,1);
  assert.match(state.uploads[0],/filename="brief.txt"[\s\S]*другие данные/);
  assert.equal(state.writes[3].text,revised.body.text.replace('[приложение](brief.txt)',
    ':file[приложение](/ajax/v2/attachments/12?inline=true){type="text/plain"}'));
});

test('an older footer is replaced and the approved model cannot change before sending', async t => {
  const {directory, run, env, state} = await fixture(t);
  const file = path.join(directory, 'note.md');
  fs.writeFileSync(file, 'Проверка.\n\n© Codex\n');
  const prepared = await run('write', 'comment', key, 'note.md');
  env.BEERPOWERS_MODEL = 'gpt-6.1-terra';
  await assert.rejects(run('write', 'comment', key, 'note.md', '--confirm', prepared.digest), /digest mismatch/);
  const current = await run('write', 'comment', key, 'note.md');
  assert.match(current.signature, /\(gpt-6\.1-terra\)$/);
  const confirm = ['write', 'comment', key, 'note.md', '--confirm', current.digest];
  state.failComment = true;
  await assert.rejects(run(...confirm), /HTTP 503/);
  assert.deepEqual(state.writes, []);
  state.failComment = false;
  assert.deepEqual(await run('write', 'comment', key, 'note.md'), current);
  await assert.rejects(run(...confirm), /check Tracker/i);
  const result = await run(...confirm.slice(0,-2),'--retry',...confirm.slice(-2));
  assert.deepEqual(await run(...confirm),result);
  assert.equal(state.writes.length,1);
  assert.equal(state.writes[0].text, 'Проверка.\n\n{orange}(*' + current.signature + '*)');
  fs.writeFileSync(file, 'Проверка.\n\n' + prepared.signature + '\n');
  await assert.rejects(run('write', 'comment', key, 'note.md'), /подпись текущей модели/);
  delete env.BEERPOWERS_MODEL;
  await assert.rejects(run('write', 'comment', key, 'note.md'), /Unknown author model/);
});

test('transition preview shows exact fields and signed comment, and rejects changed bytes', async t => {
  const {directory, run, state} = await fixture(t);
  const file = path.join(directory, 'move.md');
  fs.writeFileSync(file,'Готово.\n');
  const args = ['write','move',key,'closed','--resolution','fixed','--field','assignee=ivan','--comment','move.md'];
  const preview = await run(...args);
  assert(state.requests.every(request => request.startsWith('GET ')));
  assert.deepEqual(preview.transition, {id:'closed',from:state.issue.status,to:state.transitions[0].to});
  assert.deepEqual(preview.body, {assignee:'ivan',resolution:'fixed',comment:`Готово.\n\n{orange}(*${preview.signature}*)`});
  fs.appendFileSync(file,'\n');
  await assert.rejects(run(...args,'--confirm',preview.digest), /digest mismatch/);
  assert(state.requests.every(request => request.startsWith('GET ')));
  const changed = await run(...args);
  state.issue.status = {key:'inProgress',display:'В работе'};
  await assert.rejects(run(...args,'--confirm',changed.digest), /digest mismatch/);
  const final = await run(...args);
  await assert.rejects(run(...args,'--request','transition-1'), /requires preview and confirmation/);
  await run(...args,'--confirm',final.digest);
  assert.deepEqual(state.writes,[final.body]);
  await assert.rejects(run('write','move',key,'closed','--field','comment=Подмена'), /move field/i);
});

test('unlink confirms the exact existing relation before deleting it', async t => {
  const {run, state} = await fixture(t);
  state.links = [{id:8,type:{id:'relates'},object:{key:'TEST-1'}}];
  const args = ['write','unlink',key,'TEST-1'];
  const preview = await run(...args);
  assert.deepEqual(preview.currentLink,{id:8,kind:'связана'});
  state.links[0].id = 9;
  await assert.rejects(run(...args,'--confirm',preview.digest), /digest mismatch/);
  assert(state.requests.every(request => request.startsWith('GET ')));
  const changed = await run(...args);
  await run(...args,'--confirm',changed.digest);
  assert.equal(state.requests.at(-1), `DELETE /v2/issues/${key}/links/9`);
});

test('signed storage redirect receives no Tracker credentials (mock transport)',async ()=>{
  const apiModule = new URL('../plugins/beerpowers/bin/lib/yandex-tracker-api.mjs',import.meta.url).href;
  const probe = [
    "import assert from 'node:assert/strict';",
    'const {connection} = await import(' + JSON.stringify(apiModule) + ');',
    "const calls = [];",
    "globalThis.fetch = async (url,options) => {",
    "  calls.push({host:url.hostname,auth:options.headers?.Authorization});",
    "  if (calls.length === 1) return new Response(null,{status:302,headers:{location:'https://storage.yandexcloud.net/files/sample'}});",
    "  return new Response('fixture content');",
    "};",
    "const {attachment} = connection();",
    "assert.equal(await (await attachment('/v2/issues/TEST-1/attachments/1')).text(),'fixture content');",
    "assert.deepEqual(calls,[{host:'api.tracker.yandex.net',auth:'OAuth dummy'},{host:'storage.yandexcloud.net',auth:undefined}]);",
    "await assert.rejects(attachment('https://invalid.example/file'),/Unexpected attachment origin/);",
    "assert.equal(calls.length,2);"
  ].join('\n');
  await exec(process.execPath,['--input-type=module','--eval',probe],{env:{
    SystemRoot:process.env.SystemRoot || '',YANDEX_TRACKER_TOKEN:'dummy',YANDEX_TRACKER_ORG_ID:'dummy',YANDEX_TRACKER_ORG_TYPE:'cloud'}});
});

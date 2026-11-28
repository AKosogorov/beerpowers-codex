// Формирует черновики и преобразует Markdown в поля API Яндекс Трекера.
// Формирует черновики Трекера и сопоставляет Markdown с полями API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {connection,issueKey} from './yandex-tracker-api.mjs';
import {authorModel, draftStyle, modelSignature} from './model-signature.mjs';

const WEB = 'https://tracker.yandex.ru';
const die = message => { throw new Error(message); };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function writeJournal(checked) {
  let file;
  let lock;
  let receipt;
  let created = false;
  let sent = false;
  return {
    open(confirmed,requested,requestHash,retry) {
      fs.mkdirSync(checked('.codex/.cache/tracker-writes'),{recursive:true});
      const id = hash(JSON.stringify(requested === undefined ? ['confirm',confirmed] : ['request',requested]));
      file = checked('.codex/.cache/tracker-writes/' + id + '.json');
      const lockDir = checked('.codex/.cache/tracker-writes/' + id + '.lock');
      try { fs.mkdirSync(lockDir); }
      catch (error) {
        if (error.code === 'EEXIST') die('Tracker write is running or was interrupted. Check Tracker before recovering ' + lockDir);
        throw error;
      }
      lock = lockDir;
      try { receipt = JSON.parse(fs.readFileSync(file,'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (receipt && receipt.requestHash !== requestHash) die('Tracker request changed since the earlier attempt (digest mismatch)');
      if (receipt?.result) return receipt.result;
      if (receipt && !retry) die('Tracker write outcome is unknown. Check Tracker before retrying with the original request and --retry');
      if (!receipt && retry) die('No uncertain tracker write to retry');
      receipt ??= {requestHash};
    },
    begin(digest) {
      if (receipt.digest) {
        if (receipt.digest !== digest) die('Tracker plan changed since the earlier attempt (digest mismatch)');
        return;
      }
      receipt.digest = digest;
      fs.writeFileSync(file,JSON.stringify(receipt),{flag:'wx'});
      created = true;
    },
    sent() { sent = true; },
    complete(result) {
      if (!lock) return;
      const temporary = path.join(lock,'complete.json');
      fs.writeFileSync(temporary,JSON.stringify({...receipt,result}),{flag:'wx'});
      fs.renameSync(temporary,file);
      created = false;
    },
    close() {
      if (created && !sent) fs.rmSync(file,{force:true});
      if (lock) {
        fs.rmSync(path.join(lock,'complete.json'),{force:true});
        fs.rmdirSync(lock);
      }
    }
  };
}

export async function write(argv,checked) {
  const journal = writeJournal(checked);
  try { await execute(argv,journal); }
  finally { journal.close(); }
}

async function execute(argv,journal) {
  const [cmd,...args] = argv;
  let model;
  const inputs = new Map();
  let client;
  const api = (...params) => {
    if (params[0] !== 'GET') journal.sent();
    return (client ||= connection()).api(...params);
  };
  const root = fs.realpathSync('.');
  function input(file) {
    const absolute = path.resolve(file);
    if (inputs.has(absolute)) return inputs.get(absolute);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
        relative.split(path.sep).some(part => /^(?:\.git|\.codex|\.ssh|\.aws|\.env(?:\..*)?|\.npmrc|\.netrc)$/i.test(part)) ||
        fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isFile()) die('Unsafe tracker input file');
    inputs.set(absolute,fs.readFileSync(absolute));
    return inputs.get(absolute);
  }
  let message = '';
  const emit = text => { message += text; };
  const SECTIONS = {
    task: [
      ['Цель', true],
      ['Контекст', false],
      ['Где', false],
      ['Что делаем', true],
      ['Критерии приёмки', true],
      ['Вне объёма', false],
    ],
    bug: [
      ['Где', true],
      [['Шаги воспроизведения', 'Как обнаружено'], true],
      ['Фактический результат', true],
      ['Ожидаемый результат', true],
      ['Доказательства', true],
      ['Влияние', true],
      ['Вне объёма', false],
    ],
  };

  const TYPES = { 'Задача': 'task', 'Ошибка': 'bug' };
  const FIELDS = ['Очередь', 'Тип', 'Доска', 'Теги', 'Исполнитель', 'QA', 'Ревьюер', 'Связи'];
  const HEADER_LABELS = ['Зависит от:', 'Блокирует:', '⚠️ При выкладке:'];
  // Ключ задачи, но не имя файла по ключу: SHOP-44-tech.md связи не требует.
  const KEY = /\b[A-Z][A-Z0-9]+-\d+\b(?!-[a-zа-яё])/g;

  // Вид связи с точки зрения задачи-источника → relationship API и обратно по type/direction.
  const KINDS = {
    'зависит-от': 'depends on',
    'блокирует': 'is dependent by',
    'связана': 'relates',
    'подзадача-для': 'is subtask for',
    'родитель-для': 'is parent task for',
  };
  // Подписи вида в поле «Связи» черновика.
  const KIND_WORDS = [
    ['зависит от', 'зависит-от'],
    ['блокирует', 'блокирует'],
    ['связана с', 'связана'],
    ['подзадача для', 'подзадача-для'],
    ['родитель для', 'родитель-для'],
  ];

  function kindOf(link) {
    const t = link.type?.id;
    const d = link.direction;
    if (t === 'relates') return 'связана';
    if (t === 'depends') return d === 'outward' ? 'зависит-от' : 'блокирует';
    if (t === 'subtask') return d === 'inward' ? 'подзадача-для' : 'родитель-для';
    return `${t}/${d}`;
  }

  function skeleton(type) {
    const head = [
      `# <${type === 'bug' ? 'где: что не так' : 'результат глазами пользователя'} (front|back)>`,
      '',
      '| Поле | Значение |',
      '|---|---|',
      '| Очередь | <ОЧЕРЕДЬ> |',
      `| Тип | ${type === 'bug' ? 'Ошибка' : 'Задача'} |`,
      '| Доска | <id доски> |',
      '| Теги | Frontend |',
      '| Исполнитель | — |',
      '| QA | — |',
      '| Ревьюер | — |',
      '| Связи | — |',
      '',
      '---',
      '',
      '**Зависит от:**',
      '- <КОД — что ждём, или внешнее: что и от кого>',
      '',
    ];
    const body = SECTIONS[type].flatMap(([name, required]) => [
      `## ${Array.isArray(name) ? name[0] : name}`,
      '',
      required ? '<обязательно>' : '<необязательно: нечего писать — секцию убрать>',
      ...(name === 'Где' ? ['- <сайт>: <полный адрес страницы> (сейчас 404 — если страницы ещё нет)'] : []),
      '',
    ]);
    return [...head, ...body, '© Codex', ''].join('\n');
  }

  // ---------- черновик ----------

  function parseDraft(file) {
    const lines = input(file).toString("utf8").replace(/\r\n/g, '\n').split('\n');
    const errors = [];
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    const title = /^# (.+)$/.exec(lines[i] || '');
    if (!title) return { errors: ['первая строка черновика — «# название задачи»'] };
    const summary = title[1].trim();
    i++;
    // Служебная заметка под названием («> черновик…») в Трекер не уходит.
    while (i < lines.length && (!lines[i].trim() || lines[i].startsWith('>'))) i++;
    const fields = {};
    let rows = 0;
    while (i < lines.length && lines[i].startsWith('|')) {
      const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
      rows++;
      if (rows > 2 && cells.length >= 2) fields[cells[0]] = cells[1];
      i++;
    }
    if (!rows) errors.push('после названия — таблица полей «| Поле | Значение |»');
    while (i < lines.length && !lines[i].trim()) i++;
    if (lines[i] !== '---') errors.push('таблицу полей и описание разделяет строка «---»');
    const description = lines.slice(i + 1).join('\n').trim();
    return { summary, fields, description, errors, dir: path.dirname(path.resolve(file)) };
  }

  const none = (v) => !v || v === '—' || v === '-';
  const list = (v) => (none(v) ? [] : v.split(/[;,]/).map((x) => x.trim()).filter(Boolean));

  function parseLinks(value, errors) {
    const out = [];
    for (const item of none(value) ? [] : value.split(';').map((x) => x.trim()).filter(Boolean)) {
      const hit = KIND_WORDS.find(([w]) => item.toLowerCase().startsWith(w + ' '));
      const key = item.match(KEY);
      if (!hit || !key) {
        errors.push(`связь «${item}»: форма «<вид> <КОД>», вид — ${KIND_WORDS.map(([w]) => w).join(', ')}`);
        continue;
      }
      for (const k of key) out.push({ kind: hit[1], key: k });
    }
    return out;
  }

  function sectionsOf(description) {
    const lines = description.split('\n');
    const first = lines.findIndex((l) => l.startsWith('## '));
    const header = first < 0 ? lines : lines.slice(0, first);
    const sections = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^## (.+)$/.exec(lines[i]);
      if (m) sections.push({ name: m[1].trim(), body: [] });
      else if (sections.length) sections[sections.length - 1].body.push(lines[i]);
    }
    return { header, sections };
  }

  // Список пунктов шапки: «**Зависит от:**» и строки «- …» под ним.
  function headerLists(header) {
    const out = {};
    let cur = null;
    const errors = [];
    for (const l of header) {
      if (!l.trim()) continue;
      const label = /^\*\*(.+?)\*\*\s*$/.exec(l.trim());
      if (label && HEADER_LABELS.includes(label[1])) { cur = label[1]; out[cur] = []; continue; }
      if (cur && /^\s*- /.test(l)) { out[cur].push(l.replace(/^\s*- /, '').trim()); continue; }
      errors.push(`до первой секции — только шапка (${HEADER_LABELS.map((x) => `**${x}**`).join(', ')}), лишнее: «${l.trim().slice(0, 60)}»`);
    }
    for (const [k, v] of Object.entries(out)) if (!v.length) errors.push(`**${k}** без пунктов — строку убрать`);
    return { lists: out, errors };
  }

  // Локальная ссылка — не адрес в сети, не якорь и не вложение, уже загруженное в Трекер.
  const isLocal = (target) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target);

  function localRefs(text) {
    const refs = [];
    const img = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
    // Ссылка на файл — обычная markdown-ссылка, но не картинка и не :file[…] Трекера.
    const file = /(?<![!\w])\[([^\]]+)\]\(([^)\s]+)\)/g;
    for (const m of text.matchAll(img)) if (isLocal(m[2])) refs.push({ kind: 'img', all: m[0], name: m[1], target: m[2] });
    for (const m of text.matchAll(file)) if (isLocal(m[2])) refs.push({ kind: 'file', all: m[0], name: m[1], target: m[2] });
    return refs;
  }

  function unsignedText(text, errors) {
    const lines = text.trim().split('\n');
    const last = lines.at(-1).trim().replace(/^\{orange\}\(\*(.*)\*\)$/, '$1');
    if (!last.startsWith('©')) return text.trim();
    const known = [0, 1, 2].some(style => last === modelSignature(model, style));
    if (!known && last !== '© Codex' && !(last.startsWith('© Кодекс Кодексыч ') && last.endsWith(` (${model})`))) {
      errors.push('Ожидается подпись текущей модели: ' + model);
    }
    return lines.slice(0, -1).join('\n').trimEnd();
  }

  function checkText(text, dir, errors, warnings) {
    text = unsignedText(text, errors);
    for (const m of text.matchAll(/<[а-яё][^<>\n]*>/gi)) errors.push(`незаполненное место шаблона: ${m[0]}`);
    for (const r of localRefs(text)) if (!fs.existsSync(path.resolve(dir, r.target))) errors.push(`нет файла для ${r.all}`);
    if (/\.(php|tsx?|jsx?|vue|py|go|java|rb|cs|kt|swift)(:\d+)\b/.test(text)) warnings.push('путь к коду с номером строки — номера устаревают, место в коде — во вложении <КОД>-tech.md по имени модуля или функции');
    if (/(^|[\s(])![0-9]+\b/.test(text)) warnings.push('номер MR в тексте — описание для людей, MR видно в Трекере');
    if (/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/.test(text)) warnings.push('похоже на SHA коммита — описание для людей, SHA не нужен');
    if (/₽|\bруб\.|ставк[аи]\s+\d/i.test(text)) errors.push('деньги в тексте: оценок, бюджета и ставок в задаче нет — оценка комментарием');
    return text;
  }

  function checkDraft(d) {
    const errors = [...d.errors];
    const warnings = [];
    if (errors.length) return { errors, warnings };
    const f = d.fields;
    for (const k of Object.keys(f)) if (!FIELDS.includes(k)) errors.push(`поля «${k}» в шаблоне нет: ${FIELDS.join(', ')}`);
    const type = TYPES[f['Тип']];
    if (!type) errors.push(`поле «Тип»: ${Object.keys(TYPES).join(' или ')}`);
    if (!/^[A-Z][A-Z0-9]+$/.test(f['Очередь'] || '')) errors.push('поле «Очередь»: ключ очереди латиницей, например SHOP');
    if (!/^\d+$/.test(f['Доска'] || '')) errors.push('поле «Доска»: числовой id доски');
    const tags = list(f['Теги']);
    const front = tags.includes('Frontend');
    const back = tags.includes('Backend');
    if (front && back) errors.push('теги Frontend и Backend сразу — это две задачи, по одной на сторону, со связью «зависит от»');
    if (front && !/\(front\)$/.test(d.summary)) errors.push('тег Frontend — название кончается на «(front)»');
    if (back && !/\(back\)$/.test(d.summary)) errors.push('тег Backend — название кончается на «(back)»');
    if (!front && !back) warnings.push('нет тега Frontend или Backend — верно только для задачи не по разработке');
    const links = parseLinks(f['Связи'], errors);
    if (!type) return { errors, warnings };

    const description = checkText(d.description, d.dir, errors, warnings);
    const { header, sections } = sectionsOf(description);
    const h = headerLists(header);
    errors.push(...h.errors);
    const want = SECTIONS[type];
    let at = 0;
    for (const s of sections) {
      const idx = want.findIndex(([n]) => (Array.isArray(n) ? n.includes(s.name) : n === s.name));
      if (idx < 0) { errors.push(`секции «${s.name}» в шаблоне ${type === 'bug' ? 'бага' : 'задачи'} нет`); continue; }
      if (idx < at) errors.push(`секция «${s.name}» не на своём месте: порядок — ${want.map(([n]) => (Array.isArray(n) ? n[0] : n)).join(' → ')}`);
      at = Math.max(at, idx);
      if (!s.body.join('').trim()) errors.push(`секция «${s.name}» пустая — необязательную убрать, обязательную заполнить`);
      else if (s.name === 'Где' && type === 'bug' && !hasPage(s.body.join('\n'), false)) errors.push('## Где: нет адреса страницы, только корень стенда или ничего — укажи полный адрес той страницы, где баг воспроизводится');
      else if (s.name === 'Где' && type === 'task' && !hasPage(s.body.join('\n'), true)) errors.push('## Где: нет ни одного адреса сайта или страницы — укажи полный адрес каждой страницы, которую задача создаёт или меняет (новая страница — адресом, по которому появится, даже если сейчас 404; сквозной элемент — адресом любой страницы, где он виден, главная тоже подходит)');
    }
    for (const [n, required] of want) {
      const names = Array.isArray(n) ? n : [n];
      if (required && !sections.some((s) => names.includes(s.name))) errors.push(`нет обязательной секции «${names.join('» или «')}»`);
    }
    if (sections.filter((s) => s.name === 'Шаги воспроизведения' || s.name === 'Как обнаружено').length > 1) errors.push('«Шаги воспроизведения» и «Как обнаружено» — одна из двух');

    // Зависимость из шапки — связью нужного вида; ключ из текста — хоть какой-то связью.
    const has = (kind, key) => links.some((l) => l.kind === kind && l.key === key);
    for (const [label, kind] of [['Зависит от:', 'зависит-от'], ['Блокирует:', 'блокирует']]) {
      for (const item of h.lists[label] || []) {
        for (const key of item.match(KEY) || []) {
          if (!has(kind, key)) errors.push(`«${label.slice(0, -1)}» ${key} — в поле «Связи» нужно «${KIND_WORDS.find(([, k]) => k === kind)[0]} ${key}»`);
        }
      }
    }
    const mentioned = new Set([...(description.match(KEY) || [])]);
    for (const key of mentioned) if (!links.some((l) => l.key === key)) warnings.push(`${key} упомянута в тексте, связи с ней нет`);

    return { errors, warnings, type, links, description };
  }

  // В «## Где» есть адрес страницы: ссылка с путём длиннее «/», а с rootOk — и корень сайта.
  // Корень годится задаче: у сквозного элемента бывает только адрес главной. Багу — нет: ему
  // нужна страница, где он воспроизводится. Макет Figma страницей не считается.
  function hasPage(text, rootOk) {
    for (const m of text.matchAll(/https?:\/\/[^\s)<>\]]+/g)) {
      let u;
      // Знак препинания после адреса — часть фразы, не пути: «https://site.ru/, телефон».
      try { u = new URL(m[0].replace(/[.,;:!?]+$/, '')); } catch { continue; }
      if (/(^|\.)figma\.com$/.test(u.hostname)) continue;
      if (rootOk || u.pathname.replace(/\/+$/, '')) return true;
    }
    return false;
  }

  function report({ errors, warnings }) {
    for (const w of warnings) process.stderr.write(`предупреждение: ${w}\n`);
    for (const e of errors) process.stderr.write(`ошибка: ${e}\n`);
  }

  // ---------- доступ к API ----------

  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', md: 'text/markdown', txt: 'text/plain', html: 'text/html', pdf: 'application/pdf', json: 'application/json', csv: 'text/csv', zip: 'application/zip', mov: 'video/quicktime', mp4: 'video/mp4', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const mimeOf = (file) => MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

  function formOf(file) {
    const f = new FormData();
    f.append('file', new Blob([input(file)], { type: mimeOf(file) }), path.basename(file));
    return f;
  }

  // Replace local links with the handles returned for the approved attachments.
  // issue задан — файл кладётся прямо в задачу, иначе временной загрузкой, которую привяжет
  // создание задачи или комментария.
  async function upload(text, dir, issue) {
    const ids = [];
    const done = new Map();
    for (const r of localRefs(text)) {
      const file = path.resolve(dir, r.target);
      let id = done.get(file);
      if (!id) {
        const a = await api('POST', issue ? `/issues/${issue}/attachments` : '/attachments', formOf(file));
        id = a.id;
        done.set(file, id);
        ids.push(id);
        process.stderr.write(`загружено: ${path.basename(file)} → вложение ${id}\n`);
      }
      const url = `/ajax/v2/attachments/${id}?inline=true`;
      const repl = r.kind === 'img'
        ? `![${r.name}](${url})`
        : `:file[${r.name}](${url}){type="${mimeOf(file)}"}`;
      text = text.split(r.all).join(repl);
    }
    return { text, ids };
  }

  function fieldsBody(d) {
    const f = d.fields;
    const body = { summary: d.summary, boards: [{ id: Number(f['Доска']) }], tags: list(f['Теги']) };
    if (!none(f['Исполнитель'])) body.assignee = f['Исполнитель'];
    if (!none(f['QA'])) body.qaEngineer = f['QA'];
    if (!none(f['Ревьюер'])) body.reviewer = f['Ревьюер'];
    return body;
  }

  async function linksOf(key) {
    return (await api('GET', `/issues/${key}/links`)) || [];
  }

  async function findLink(key, other) {
    const link = (await linksOf(key)).find(l => l.object?.key === other);
    return link ? {id:link.id,kind:kindOf(link)} : null;
  }

  // Связь с проверкой пары: та же — ничего не делаем, другая — только с replace.
  async function addLink(key, kind, other, replace, existing) {
    if (!KINDS[kind]) die(`вид связи: ${Object.keys(KINDS).join(', ')}`);
    if (existing === undefined) existing = await findLink(key, other);
    if (existing) {
      const was = existing.kind;
      if (was === kind) { process.stderr.write(`связь уже есть: ${key} ${kind} ${other}\n`); return false; }
      if (!replace) die(`у ${key} и ${other} уже есть связь «${was}»: у пары задач Трекер держит одну связь, новая заменит прежнюю — повтори с --replace, если так и нужно`);
    }
    await api('POST', `/issues/${key}/links`, { relationship: KINDS[kind], issue: other });
    process.stderr.write(`связь: ${key} ${kind} ${other}${existing ? ` (была «${existing.kind}»)` : ''}\n`);
    return true;
  }

  // Владелец токена: Трекер называет пользователя разными id, и автор комментария может прийти
  // любым из них.
  let owner = null;
  async function myself() {
    if (!owner) {
      const u = await api('GET', '/myself');
      const ids = ['uid', 'trackerUid', 'passportUid', 'cloudUid', 'login'].map((k) => u[k]).filter(Boolean).map(String);
      owner = { ids: new Set(ids), display: u.display || u.login };
    }
    return owner;
  }

  const authorOf = (c) => c.createdBy?.display || c.createdBy?.id || '—';
  const isMine = (c, who) => who.ids.has(String(c.createdBy?.id ?? ''));

  // Комментарии страницами: следующая страница — от id последнего комментария предыдущей.
  async function commentsOf(key) {
    const out = [];
    let after = '';
    for (;;) {
      const page = (await api('GET', `/issues/${key}/comments?perPage=50${after ? `&id=${after}` : ''}`)) || [];
      const fresh = page.filter((c) => !out.some((o) => o.id === c.id));
      out.push(...fresh);
      if (page.length < 50 || !fresh.length) return out;
      after = page[page.length - 1].id;
    }
  }

  // Комментарий задачи, только свой: чужой правкой и удалением не трогается.
  async function ownComment(key, id) {
    const c = await api('GET', `/issues/${key}/comments/${id}`);
    const who = await myself();
    if (!isMine(c, who)) die(`комментарий ${id} в ${key} написал ${authorOf(c)}, а токен — ${who.display}: чужой комментарий скрипт не правит и не удаляет`);
    return c;
  }

  // ---------- команды ----------


  const syntax = {
    template:[1,1],check:[1,1],create:[1,1],edit:[2,2],comment:[2,2],comments:[1,2],
    'edit-comment':[3,3],'delete-comment':[2,2],links:[1,1],link:[3,4],unlink:[2,2],
    transitions:[1,1],move:[2,Infinity],attach:[2,Infinity],detach:[2,2],
  };
  const at = args.indexOf('--confirm');
  let confirmed;
  if (at >= 0) {
    if (at !== args.length - 2) die('--confirm DIGEST must be last');
    confirmed = args.splice(at)[1];
  }
  const requestAt = args.indexOf('--request');
  let requested;
  if (requestAt >= 0) {
    if (confirmed !== undefined || requestAt !== args.length - 2) die('--request ID must be last and replaces --confirm');
    requested = args.splice(requestAt)[1];
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(requested)) die('Invalid tracker request ID');
    if (!['comment','edit-comment','link','unlink'].includes(cmd)) die('This operation requires preview and confirmation');
  }
  const retry = args.at(-1) === '--retry';
  if (retry) {
    args.pop();
    if (!confirmed && !requested) die('--retry requires the original confirmation or request ID');
  }
  const verbatim = cmd === 'comment' && args.at(-1) === '--verbatim';
  if (verbatim) args.pop();
  if (!Object.hasOwn(syntax,cmd) || args.length < syntax[cmd][0] || args.length > syntax[cmd][1]) die('Unexpected tracker write arguments');
  const keyed = !['template','check','create'].includes(cmd);
  if (keyed && !issueKey.test(args[0])) die('Expected PROJECT-NNN');
  if ((cmd.endsWith('-comment') || cmd === 'detach' || (cmd === 'comments' && args.length > 1)) && !/^\d+$/.test(args[1]))
    die('Expected numeric object id');
  if (cmd === 'link' && (!Object.hasOwn(KINDS,args[1]) || !issueKey.test(args[2]) || (args[3] && args[3] !== '--replace'))) die('Invalid link');
  if (cmd === 'unlink' && !issueKey.test(args[1])) die('Expected linked issue key');
  const moveFields = {};
  let moveComment;
  if (cmd === 'move') {
    if (!/^[\w-]+$/.test(args[1])) die('Invalid transition id');
    for (let i = 2; i < args.length; i += 2) {
      const [option, value] = args.slice(i, i + 2);
      if (!value || value.startsWith('--')) die('Invalid move option');
      if (option === '--comment' && !moveComment) moveComment = value;
      else if (option === '--resolution' && !Object.hasOwn(moveFields, 'resolution')) moveFields.resolution = value;
      else if (option === '--field') {
        const match = /^([\w.-]+)=([\s\S]*)$/.exec(value);
        if (!match || match[1] === 'comment' || match[1] in moveFields) die('Invalid move field');
        moveFields[match[1]] = match[2];
      } else die('Invalid move option');
    }
  }
  const mutating = !['template','check','comments','links','transitions'].includes(cmd);
  if (requested !== undefined && !mutating) die('Expected a write operation with the request ID');
  if (confirmed !== undefined && (!mutating || !/^[a-f0-9]{64}$/.test(confirmed))) die('Expected a write operation and its SHA-256 preview digest');
  const taskDraft = cmd === 'create' || cmd === 'edit';
  const commentFile = moveComment ?? (['comment','edit-comment'].includes(cmd) ? args.at(-1) : undefined);
  if (taskDraft || commentFile || cmd === 'check') model = await authorModel();
  let plan;
  let draftDir;
  if (mutating) {
    let body;
    let links;
    let text;
    let textField;
    let stdinDigest;
    const attachments = new Set();
    if (taskDraft) {
      const doc = parseDraft(args.at(-1));
      const result = checkDraft(doc);
      report(result);
      if (result.errors.length) die('некорректный черновик');
      draftDir = doc.dir;
      text = result.description;
      textField = 'description';
      links = result.links;
      body = { ...fieldsBody(doc), markupType:'md' };
      if (cmd === 'create') {
        body.queue = doc.fields['Очередь'];
        body.type = result.type;
      }
    } else if (commentFile) {
      const errors = [];
      const warnings = [];
      const stdin = cmd === 'comment' && commentFile === '-';
      draftDir = stdin ? root : path.dirname(path.resolve(commentFile));
      const bytes = stdin ? fs.readFileSync(0) : input(commentFile);
      if (stdin) stdinDigest = hash(bytes);
      const source = bytes.toString('utf8').replace(/^\uFEFF/, '');
      if (verbatim) text = source.replace(/(?:\r?\n)+$/, '');
      else {
        const normalized = source.replace(/\r\n/g,'\n').trim();
        text = cmd === 'move' ? unsignedText(normalized,errors) : checkText(normalized,draftDir,errors,warnings);
      }
      if (!text.trim()) errors.push('пустой комментарий');
      report({errors,warnings});
      if (errors.length) die('некорректный комментарий');
      textField = cmd === 'move' ? 'comment' : 'text';
      body = cmd === 'move' ? moveFields : {markupType:'md'};
    } else if (cmd === 'move') {
      body = moveFields;
    }
    if (textField && !verbatim) for (const ref of localRefs(text)) attachments.add(path.resolve(draftDir, ref.target));
    if (cmd === 'attach') for (const file of args.slice(1)) attachments.add(path.resolve(file));
    for (const file of attachments) input(file);
    client = connection();
    const filePlan = file => ({path:path.relative(root,file),sha256:hash(inputs.get(file))});
    const files = [...inputs.keys()].map(filePlan);
    const target = keyed ? {issue:args[0]} : {queue:body.queue};
    plan = {operation:cmd,arguments:args.slice(),target,files,attachments:[...attachments].map(filePlan),
      endpoint:client.endpoint,version:client.version,organization:client.orgId,orgType:client.orgType};
    if (verbatim) plan.verbatim = true;
    if (stdinDigest) plan.stdinSha256 = stdinDigest;
    if (body) plan.body = body;
    if (links) plan.links = links;
    if (textField) {
      plan.signature = modelSignature(model, draftStyle(['tracker', plan]));
      body[textField] = `${text}\n\n{orange}(*${plan.signature}*)`;
      if (cmd === 'create') {
        // Tracker rejects duplicate creations with the same unique value.
        body.unique = crypto.createHash('sha1').update([body.queue, body.summary, text].join('\n')).digest('hex');
      }
    }
    if (confirmed !== undefined || requested !== undefined) {
      const previous = journal.open(confirmed,requested,hash(JSON.stringify(plan)),retry);
      if (previous) {
        console.log(JSON.stringify(previous));
        return;
      }
    }
    if (cmd === 'delete-comment' || cmd === 'edit-comment') {
      const c = await ownComment(args[0],args[1]);
      plan.comment = {author:authorOf(c),text:c.text};
    }
    if (cmd === 'move') {
      const [key, transition] = args;
      const issue = await api('GET', `/issues/${key}`);
      const available = await api('GET', `/issues/${key}/transitions`);
      const next = available.find(item => String(item.id) === transition);
      if (!next?.to) die(`переход ${transition} недоступен для ${key}`);
      const status = ({key,display}) => ({key,display});
      plan.transition = {id:transition,from:status(issue.status),to:status(next.to)};
    }
    if (cmd === 'link' || cmd === 'unlink') {
      const other = cmd === 'link' ? args[2] : args[1];
      plan.currentLink = await findLink(args[0], other);
      if (cmd === 'unlink' && !plan.currentLink) die(`связи ${args[0]} — ${other} нет`);
    }
    const digest = hash(JSON.stringify(plan));
    if (confirmed === undefined && requested === undefined) {
      console.log(JSON.stringify({status:'needs-confirmation',...plan,digest}));
      return;
    }
    if (confirmed !== undefined && digest !== confirmed) die('Tracker write preview digest mismatch');
    journal.begin(digest);
  }
  const switchOn = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const need = (n, usage) => { if (args.length < n) die(`использование: ${usage}`); };

  switch (cmd) {
    case 'template': {
      need(1, 'template task|bug');
      if (!Object.hasOwn(SECTIONS,args[0])) die('template task или template bug');
      emit(skeleton(args[0]));
      break;
    }
    case 'check': {
      need(1, 'check <черновик.md>');
      const res = checkDraft(parseDraft(args[0]));
      report(res);
      if (res.errors.length) die('некорректный черновик');
      emit('черновик сходится с шаблоном\n');
      break;
    }
    case 'create': {
      const { text, ids } = await upload(plan.body.description, draftDir, null);
      const issue = await api('POST', '/issues', { ...plan.body, description:text, ...(ids.length ? { attachmentIds:ids } : {}) });
      // Черновик — полное состояние задачи: его вид связи заменяет «связана», которую Трекер
      // сам ставит каждому ключу из описания.
      for (const l of plan.links) await addLink(issue.key, l.kind, l.key, true);
      emit(`создана: ${issue.key} ${WEB}/${issue.key}\n`);
      break;
    }
    case 'edit': {
      const [key] = args;
      const { text } = await upload(plan.body.description, draftDir, key);
      const fresh = await api('GET', `/issues/${key}`);
      // Тег пишется заменой, а не добавлением: черновик — полное состояние задачи.
      await api('PATCH', `/issues/${key}?version=${fresh.version}`, { ...plan.body, description:text });
      for (const l of plan.links) await addLink(key, l.kind, l.key, true);
      emit(`изменена: ${key} ${WEB}/${key}\n`);
      break;
    }
    case 'comment': {
      const [key] = args;
      const { text, ids } = verbatim ? {text:plan.body.text, ids:[]} : await upload(plan.body.text, draftDir, null);
      const c = await api('POST', `/issues/${key}/comments`, { ...plan.body, text, ...(ids.length ? { attachmentIds:ids } : {}) });
      emit(`комментарий ${c.id}: ${WEB}/${key}\n`);
      break;
    }
    case 'comments': {
      need(1, 'comments <КОД> [<id комментария>]');
      const [key, id] = args;
      if (id) {
        const c = await api('GET', `/issues/${key}/comments/${id}`);
        emit(`комментарий ${c.id}, автор ${authorOf(c)}, ${c.createdAt || ''}\n\n${c.text || ''}\n`);
        break;
      }
      const who = await myself();
      for (const c of await commentsOf(key)) {
        const first = (c.text || '').trim().split('\n')[0].slice(0, 80);
        emit(`${c.id}  ${authorOf(c)}${isMine(c, who) ? ' (свой)' : ''}  ${first}\n`);
      }
      break;
    }
    case 'edit-comment': {
      const [key, id] = args;
      const { text, ids } = await upload(plan.body.text, draftDir, null);
      await api('PATCH', `/issues/${key}/comments/${id}`, { ...plan.body, text, ...(ids.length ? {attachmentIds:ids} : {}) });
      emit(`комментарий ${id} изменён: ${WEB}/${key}\n`);
      break;
    }
    case 'delete-comment': {
      need(2, 'delete-comment <КОД> <id комментария>');
      const [key, id] = args;
      await api('DELETE', `/issues/${key}/comments/${id}`);
      emit(`комментарий ${id} удалён из ${key}\n`);
      const att = [...new Set([...(plan.comment.text || '').matchAll(/\/attachments\/(\d+)/g)].map((m) => m[1]))];
      if (att.length) process.stderr.write(`вложения из него остались в задаче: ${att.join(', ')} — убрать: detach\n`);
      break;
    }
    case 'links': {
      need(1, 'links <КОД>');
      for (const l of await linksOf(args[0])) emit(`${kindOf(l)} ${l.object?.key} — ${l.object?.display || ''}\n`);
      break;
    }
    case 'link': {
      const replace = switchOn('--replace');
      need(3, 'link <КОД> <вид> <КОД2> [--replace]');
      await addLink(args[0], args[1], args[2], replace, plan.currentLink);
      break;
    }
    case 'unlink': {
      need(2, 'unlink <КОД> <КОД2>');
      const l = plan.currentLink;
      await api('DELETE', `/issues/${args[0]}/links/${l.id}`);
      emit(`связь удалена: ${args[0]} ${l.kind} ${args[1]}\n`);
      break;
    }
    case 'transitions': {
      need(1, 'transitions <КОД>');
      const issue = await api('GET', `/issues/${args[0]}`);
      const tr = await api('GET', `/issues/${args[0]}/transitions`);
      const q = await api('GET', `/queues/${issue.queue.key}?expand=issueTypesConfig`);
      const cfg = (q.issueTypesConfig || []).find((c) => c.issueType?.key === issue.type?.key);
      emit(`статус: ${issue.status.display} (${issue.status.key})\n`);
      emit('переходы:\n' + tr.map((t) => `  ${t.id} → ${t.to?.display}`).join('\n') + '\n');
      emit(`резолюции для типа «${issue.type?.display}»: ${(cfg?.resolutions || []).map((r) => r.key).join(', ') || '—'}\n`);
      emit('обязательные поля перехода Трекер называет только отказом 422 — их значения спрашиваются у человека\n');
      break;
    }
    case 'move': {
      const body = { ...plan.body };
      if (body.comment) body.comment = (await upload(body.comment, draftDir, args[0])).text;
      await api('POST', `/issues/${args[0]}/transitions/${args[1]}/_execute`, body);
      const issue = await api('GET', `/issues/${args[0]}`);
      emit(`статус ${args[0]}: ${issue.status.display}${issue.resolution ? `, резолюция «${issue.resolution.display}»` : ''}\n`);
      break;
    }
    case 'attach': {
      need(2, 'attach <КОД> <файл>…');
      const [key, ...files] = args;
      for (const file of files) {
        if (!fs.existsSync(file)) die(`нет файла: ${file}`);
        const a = await api('POST', `/issues/${key}/attachments`, formOf(file));
        emit(`вложение ${a.id}: ${a.name} — в тексте :file[${a.name}](/ajax/v2/attachments/${a.id}?inline=true){type="${mimeOf(file)}"}\n`);
      }
      break;
    }
    case 'detach': {
      need(2, 'detach <КОД> <id вложения>');
      const [key, id] = args;
      const issue = await api('GET', `/issues/${key}`);
      if ((issue.description || '').includes(`/attachments/${id}`)) die(`вложение ${id} упомянуто в описании ${key}: сначала убери ссылку правкой описания (edit), иначе в тексте останется мёртвая ссылка`);
      const comments = await commentsOf(key);
      const inComment = comments.filter((c) => (c.text || '').includes(`/attachments/${id}`)).map((c) => c.id);
      await api('DELETE', `/issues/${key}/attachments/${id}`);
      emit(`вложение ${id} удалено из ${key}\n`);
      if (inComment.length) process.stderr.write(`ссылка на него осталась в комментариях: ${inComment.join(', ')}\n`);
      break;
    }
    default:
      die(`неизвестная команда: ${cmd} (см. --help)`);
  }


  const result = {status:'ok',operation:cmd,text:message.trimEnd()};
  journal.complete(result);
  console.log(JSON.stringify(result));
}

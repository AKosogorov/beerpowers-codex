// Переносит проектные вставки между заголовками и именованными блоками устава.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { blocks, markupLines } from './markdown-engine.mjs';

const asset = name => readFileSync(new URL('../../templates/charter/' + name, import.meta.url), 'utf8').replaceAll('\r\n','\n');
const previous = JSON.parse(asset('previous.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const modelAliases = {opus:'gpt-6.2-astra', sonnet:'gpt-6.2-sol', haiku:'gpt-6.1-terra'};
const quote = value => '\x60' + value + '\x60';
const intakeDescriptions = {
  plan:'**План вместе, дальше сами.** Архитектор готовит design brief для задачи крупнее мелкой правки. Пользователь утверждает план. Реализация, тесты и ревью идут до готового MR с остановкой на необратимой развилке.',
  stages:'**Стоп после каждого этапа.** Пользователь утверждает design brief. После реализации, тестов и ревью тимлид показывает результат и ждёт согласия продолжать.',
  autonomous:'**Сами от начала до конца.** Команда выбирает подход и записывает design brief. Пользователь получает готовый MR. До этого команда останавливается только на необратимом.',
};
const sectionAliases = new Map([
  ['## Стек','## Стек (фиксированный)'],
  ['## Workflow — предложением, не запуском','## Пакет однотипных проверок — по предложению тимлида'],
  ['## Однотипные проверки','## Пакет однотипных проверок — по предложению тимлида'],
  ['## Git и закрытие задачи','## Git'],
]);
const names = {'team-charter': {
  '## Назначение':'PURPOSE', '## Стек (фиксированный)':'STACK_TABLE', '## Команды':'COMMANDS',
  '## Состав':'ROLES_TABLE', 'roles-issues':'MODELS', '## Intake-режим':'INTAKE_MODE',
  'evidence-discipline':'PROJECT_RULES', '## Правила работы':'PROJECT_RULES',
  '## PM-конвейер':'PM_PIPELINE', 'memory-files':'MEMORY_FILES_EXTRA',
}, 'team-lead': {
  'task-class':'CLASS_EXTRA', 'effort':'EFFORT_TABLE', 'effort-questions':'MODEL_EXTRA',
  '## Effort и модель роли':'EFFORT_TABLE', 'gates':'GATES_EXTRA', '## Порядок гейтов':'GATES_EXTRA',
  'closing':'CLOSING_EXTRA','## Закрытие задачи — чеклист одним проходом':'CLOSING_EXTRA',
}};

function anchors(text, file) {
  const engines = [...blocks(text, file).values()];
  const template = asset(file + '.md');
  const headers = new Set([...markupLines(template)].map(row => row.content).filter(line => line.startsWith('## ')));
  headers.add('## PM-конвейер');
  headers.add('## Команда разработки');
  const result = engines.map(block => ({...block, key:block.name}));
  for (const line of markupLines(text)) {
    if (!line.content.startsWith('#') || engines.some(block => block.start <= line.start && line.end <= block.end)) continue;
    const key = line.content.startsWith('# ') ? 'title' : (sectionAliases.get(line.content) ?? line.content);
    if (key === 'title' || headers.has(key)) result.push({...line, key});
  }
  return result.sort((a,b) => a.start-b.start);
}

function adaptProse(text) {
  const replacements = line => line.replaceAll('/beerpowers:', '$beerpowers ')
    .replace(/beerpowers:(brainstorm|debug-loop|economy|grill|minimal-diff|page-screenshot|prototype|summarizing-mr-links|tracker-task)\b/g,'beerpowers-codex:$1')
    .replaceAll('\x60front\x60','\x60frontend\x60').replaceAll('\x60db\x60','\x60database\x60')
    .replaceAll('.claude/reference/', 'reference/').replaceAll('.claude/bin/', '<пакет>/bin/')
    .replaceAll('.claude/', '.codex/');
  for (const line of [...markupLines(text)].reverse()) {
    text = text.slice(0,line.start) + replacements(line.content) + text.slice(line.end);
  }
  return text;
}

function models(raw) {
  const header = '| Роль | Модель | Причина |';
  const aliases = Object.entries(modelAliases).map(([tier,model]) => [tier,'| ' + quote(tier) + ' | ' + quote(model) + ' | Соответствие исходного тира роли. Доступность проверяется перед запуском. |']);
  const lines = raw.split('\n');
  const tableHeader = [...markupLines(raw)].find(row => row.content === header);
  if (tableHeader) {
    const start = raw.slice(0,tableHeader.start).split('\n').length - 1;
    let end = start + 1;
    const present = new Set();
    while (end < lines.length && lines[end].startsWith('|')) {
      present.add(lines[end].split('|')[1].trim().replaceAll('\x60',''));
      end++;
    }
    lines.splice(end,0,...aliases.filter(([tier]) => !present.has(tier)).map(([,row]) => row));
    return lines.join('\n');
  }
  const rows = [header,'|---|---|---|',...aliases.map(([,row]) => row)];
  // Старый setup описывал проектные исключения строкой «роль — тир: причина».
  const declaration = /^\*\*Модели:\*\*\s*(.+)$/m.exec(raw);
  if (declaration) {
    const parts = declaration[1].split(/;\s*/);
    const entries = parts.map(part => /^\x60?([a-z][\w-]*)\x60?\s+[—–-]\s+\x60?([\w.-]+)\x60?\s*:\s*(.+)$/.exec(part));
    if (entries.every(Boolean)) {
      for (const [,role,model,reason] of entries) {
        rows.push('| ' + quote(({db:'database',front:'frontend'})[role] ?? role) + ' | ' + quote(modelAliases[model] ?? model) + ' | ' + reason + ' |');
      }
      raw = raw.replace(declaration[0], '').trim();
    } else throw Error('Не удалось разобрать проектные модели. Передайте MODELS таблицей «Роль | Модель | Причина».');
  }
  return [raw, '**Модели**\n\n' + rows.join('\n')].filter(Boolean).join('\n\n');
}

function archiveRoster(value, rosters) {
  if (!value.includes('\x60subagent_type\x60')) return value;
  const cells = line => line.trim().slice(1,-1).split(/(?<!\\)\|/).map(cell => cell.trim());
  const lines = value.split('\n');
  const start = lines.findIndex(line => /^\|/.test(line) && line.includes('Read on spawn') && line.includes('subagent_type'));
  if (start < 0) return value;
  const cols = cells(lines[start]);
  const end = lines.findIndex((line,i) => i > start + 1 && !line.startsWith('|'));
  const stop = end < 0 ? lines.length : end;
  const out = ['| Роль | Проекты | Read on spawn | Миссия | Триггеры | Mandatory practices |','|---|---|---|---|---|---|'];
  for (const line of lines.slice(start+2,stop)) {
    const cellsByName = Object.fromEntries(cells(line).map((v,i)=>[cols[i],v]));
    const role = cellsByName['Роль'].replaceAll('\x60','');
    const brief = role === 'tester' ? 'testing' : role;
    // В исходном составе ограничения по репозиториям не было. Эвристика стека
    // иной дорожки не может запретить, например, database сверить потребителя схемы.
    const projects = cellsByName['Проекты'] ?? cellsByName['Продукты'] ?? Object.keys(rosters).join(', ');
    const read = [quote('.codex/agents/' + brief + '-agent.md'),quote('memory/MEMORY.md'),cellsByName['Read on spawn']].join(', ');
    const row = [quote(role),projects,read,
      cellsByName['Миссия'],cellsByName['Триггеры'],cellsByName['Mandatory practices']];
    out.push('| ' + row.join(' | ') + ' |');
  }
  return [...lines.slice(0,start), ...out, ...lines.slice(stop)].join('\n');
}

function recover(template, source, file, rosters, allowed) {
  const expected = blocks(template, file);
  // Проектный engine может принадлежать другому расширению. Он остаётся частью
  // проектной вставки, пока в шаблоне пакета нет блока с таким именем.
  const entries = anchors(source, file).filter(row => !row.name || expected.has(row.name));
  const legacyLayout = !entries.some(entry => entry.key === 'charter-intro' || entry.key === 'lead-intro');
  const saved = {}, extra = new Map();
  function put(key,value) {
    if (value) saved[key] = [saved[key],value].filter(Boolean).join('\n\n');
  }
  const preamble = source.slice(0, entries[0]?.start ?? source.length);
  for (const [i,row] of entries.entries()) {
    const canonical = expected.get(row.key);
    if (row.name && canonical && row.text !== canonical.text &&
        !previous[file].blocks[row.key]?.includes(hash(row.text)) && allowed?.get(row.key)?.text !== row.text) {
      throw Error('Conflict ' + file + ' [' + row.key + ']: изменён управляемый блок');
    }
    let content = source.slice(row.end,entries[i+1]?.start ?? source.length).trim();
    if (row.key === 'title') content = content.replace(/^(?:\*\*Версия charter:\*\* 2\.0 · \*\*generated-by: beerpowers v[\d.]+ · mode: plugin-linked\*\*|<!-- generated-by: beerpowers-codex v[\d.]+ · mode: plugin-linked -->)$/gm,'').trim();
    // Удаляются только известные печатные абзацы сокращённых версий шаблона.
    if (legacyLayout) {
      content = content.split(/\n[ \t]*\n/).filter(p => !previous[file].paragraphs.includes(hash(p))).join('\n\n').trim();
    }
    if (row.key === '## Команда разработки') { put('DEV_SECTION', row.key + '\n\n' + content); continue; }
    if (row.key === '## PM-конвейер') { put('PM_PIPELINE', adaptProse(row.key + '\n\n' + content)); continue; }
    if (!content) continue;
    let slot = names[file][row.key];
    content = adaptProse(content);
    if (slot === 'ROLES_TABLE') {
      const end = /^(?:\*\*Модели:?\*\*|Модели:)/m.exec(content)?.index;
      if (end !== undefined) { put('MODELS',content.slice(end)); content=content.slice(0,end).trim(); }
      content = archiveRoster(content,rosters);
    }
    if (slot === 'PROJECT_RULES') {
      const universal = /^\*\*Universal skills:\*\*.*$/m.exec(content);
      if (universal) { put('UNIVERSAL_SKILLS', universal[0]); content = content.replace(universal[0],'').trim(); }
      content = content.replace(/ закрыт маской\n\x60claudeMdExcludes\x60:/g,' исключён из источников инструкций проекта:');
    }
    if (slot === 'EFFORT_TABLE' && row.key.startsWith('## ')) {
      const end = content.search(/\n\n(?!\|)/);
      if (end >= 0) { put('MODEL_EXTRA',content.slice(end).trim()); content=content.slice(0,end).trim(); }
    }
    if (slot) put(slot,content);
    else extra.set(row.key,[extra.get(row.key),content].filter(Boolean).join('\n\n'));
  }
  return {saved,extra,preamble};
}

function insertExtras(text, file, extra) {
  for (const row of anchors(text,file).reverse()) {
    if (!extra.has(row.key)) continue;
    text = text.slice(0,row.end) + '\n\n' + extra.get(row.key) + text.slice(row.end);
    extra.delete(row.key);
  }
  if (extra.size) throw Error('Не найдено место для проектного текста в ' + file + ': ' + [...extra.keys()].join(', '));
  return text;
}

export function renderCharter({file,template,slots,overrides={},source='',rosters={},guides={},ui=false,intake='',priorBlocks}) {
  const active = new Set(Object.values(rosters).flat());
  const {saved,extra,preamble} = recover(template, source.replaceAll('\r\n','\n'), file, rosters, priorBlocks);
  const fields = {...slots,...saved,...overrides};
  if (file === 'team-charter') {
    fields.MODELS = models(fields.MODELS ?? '');
    const sourceMode = /^Intake: (plan|stages|autonomous)$/m.exec(fields.INTAKE_MODE ?? '')?.[1] ??
      Object.keys(intakeDescriptions).find(key => fields.INTAKE_MODE?.includes(intakeDescriptions[key].split('**')[1]));
    const mode = intake || sourceMode || /^Intake: (plan|stages|autonomous)$/m.exec(slots.INTAKE_MODE ?? '')?.[1] || 'plan';
    const description = (fields.INTAKE_MODE ?? '').replace(/^Intake: (plan|stages|autonomous)\s*$/m,'').trim();
    fields.INTAKE_MODE = 'Intake: ' + mode + '\n\n' + ((sourceMode && sourceMode !== mode) ? intakeDescriptions[mode] : description || intakeDescriptions[mode]);
  } else if (!fields.EFFORT_TABLE) {
    let role;
    fields.EFFORT_TABLE = asset('effort-table.md').trimEnd().split('\n').filter((line,i) => {
      if (i < 2) return true;
      const cell = line.split('|')[1].trim().replaceAll('\x60','');
      if (cell) role = cell;
      return active.has(role) || role === 'независимый оппонент';
    }).join('\n');
  }
  if (file === 'team-lead' && fields.GATES_EXTRA?.includes('**Сборка — единственный гейт CI.** На MR в каждом репозитории CI гоняет только')) {
    fields.GATES_EXTRA = fields.GATES_EXTRA.replace(/\*\*Сборка — единственный гейт CI\.\*\* На MR в каждом репозитории CI гоняет только [\s\S]*?только внутри \x60build\x60\./,
      'Локальная сборка каждого затронутого репозитория обязательна до push. Наличие и состав проверок CI по репозиториям приведены в таблице «Стек (фиксированный)» устава. Выполни также локальные гейты из раздела «Гейты» памятки каждого изменённого проекта.');
  }
  if (file === 'team-lead' && Object.keys(guides).length) {
    const rows = Object.entries(guides).map(([repo,guide]) => '| ' + quote(repo) + ' | ' + quote(guide) + ', раздел «Гейты» |');
    fields.GATES_EXTRA = [fields.GATES_EXTRA, ['| Проект | Команды обязательных проверок |','|---|---|',...rows].join('\n')].filter(Boolean).join('\n\n');
  }
  let result = insertExtras(template, file, extra);
  for (const block of [...blocks(result,file).values()].reverse()) {
    if (block.condition === 'ui:true' && !ui) result = result.slice(0,block.start) + result.slice(block.end).replace(/^\n\n/,'');
  }
  // Значения слотов — данные: заголовки и похожие на токены строки в них не разбираются повторно.
  for (const {start,end,content} of [...markupLines(result)].reverse()) {
    const match = /^\{\{([A-Z_]+)\}\}$/.exec(content);
    if (match) result = result.slice(0,start) + (fields[match[1]] ?? '') + result.slice(end);
  }
  return preamble + result;
}

// У существующего документа владелец всего текста за границами маркеров — проект.
// Для выпусков с сокращённым шаблоном извлекаются его слоты до восстановления структуры.
export function refreshCharter({file,text,template,prior,ui,version,rosters={},guides={}}) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = str => str.replaceAll('\n',eol);
  const plain = str => str.replaceAll('\r\n','\n');
  const expected = blocks(template,file);
  const existing = blocks(text,file);
  const historic = prior ? blocks(plain(prior),file) : new Map();
  const intro = file === 'team-charter' ? 'charter-intro' : 'lead-intro';
  if (!existing.has(intro) && !existing.has(file === 'team-charter' ? 'intake' : 'effort-questions')) {
    const headings = new Set(anchors(text,file).map(row => row.key));
    const built = file === 'team-charter' ? headings.has('## Состав') && headings.has('## Назначение')
      : headings.has('## Effort и модель роли') && headings.has('## Порядок гейтов');
    if (!built) return text;
    const title = anchors(text,file).find(row => row.key === 'title')?.content;
    if (!title) throw Error('Не найден заголовок ' + file);
    const stamp = '<!-- generated-by: beerpowers-codex v' + version + ' · mode: plugin-linked -->';
    const source = plain(text);
    const dev = [...markupLines(source)].find(row => row.content === '## Команда разработки');
    if (dev) template += '\n{{DEV_SECTION}}\n';
    return line(renderCharter({file,template:template.replace(/^# .*$/m,() => title), source, ui, rosters,guides,priorBlocks:historic,
      slots:{BEERPOWERS_VERSION:stamp}}));
  }
  for (const [name,canonical] of expected) {
    const found = blocks(text,file).get(name);
    const enabled = !canonical.condition || (canonical.condition === 'ui:true' && ui);
    if (found) {
      const current = plain(found.text);
      if (enabled && canonical.text === current) continue;
      if (current !== canonical.text && historic.get(name)?.text !== current &&
          !previous[file].blocks[name]?.includes(hash(current))) throw Error('Conflict ' + file + ' [' + name + ']: изменён управляемый блок');
      const after = text.slice(found.end);
      const suffix = !enabled && after.startsWith(eol + eol) ? after.slice(eol.length * 2) : after;
      text = text.slice(0,found.start) + (enabled ? line(canonical.text) : '') + suffix;
    } else if (enabled) {
      const actual = new Map(anchors(text,file).map(row => [row.key,row]));
      const following = anchors(template,file).find(row => row.start > canonical.end && actual.has(row.key));
      const offset = following ? actual.get(following.key).start : text.length;
      const gap = offset && !text.slice(0,offset).endsWith(eol+eol) ? eol : '';
      text = text.slice(0,offset) + gap + line(canonical.text) + eol + eol + text.slice(offset);
    }
  }
  if (file === 'team-lead' && Object.keys(guides).length) {
    let table = false;
    const updates = [];
    for (const row of markupLines(text)) {
      if (row.content === '| Проект | Команды обязательных проверок |') { table = true; continue; }
      if (!row.content.startsWith('|')) table = false;
      const match = table && /^\| \x60([\w.-]+)\x60 \| \x60(memory\/commands\/[\w.-]+\.md)\x60, раздел «Гейты» \|$/.exec(row.content);
      if (match && guides[match[1]] && match[2] !== guides[match[1]]) updates.push({...row,value:row.content.replace(match[2],guides[match[1]])});
    }
    for (const row of updates.reverse()) text = text.slice(0,row.start) + row.value + text.slice(row.end);
  }
  return text;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(request.text !== undefined ? refreshCharter(request) : renderCharter(request));
}

// Планирует перенос исходного Markdown, не разбивая бриф на заголовки и абзацы.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { workspacePath } from './ui-workspace.mjs';
import { readCharter } from './role-context.mjs';
import { blocks, markupLines } from './markdown-engine.mjs';
import { isClaudeModel, parseFrontmatter, roleFilename, roleMetadata, setFrontmatterField } from './role-metadata.mjs';

const templates = fileURLToPath(new URL('../../templates/', import.meta.url));
const template = path => readFileSync(resolve(templates, path), 'utf8');
const root = process.cwd();
const read = file => {
  const path = workspacePath(root, file);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw Error('Ожидается файл: ' + file);
  return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(readFileSync(path));
};
const entries = dir => {
  const path = workspacePath(root, dir);
  return existsSync(path) ? readdirSync(path).sort() : [];
};
const hasHeader = text => /^\uFEFF?---[ \t]*\r?\n/.test(text);
const normalize = text => text.replaceAll('\r\n', '\n');
const nl = text => text?.includes('\r\n') ? '\r\n' : '\n';
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const digest = text => createHash('sha256').update(normalize(text)).digest('hex');
const strings = list => Array.isArray(list) && list.every(v => typeof v === 'string' && v.trim()) && new Set(list).size === list.length;
const validSkill = skill => /^[a-z][\w-]*(?::[a-z][\w-]*)?$/.test(skill);
const roleId = role => ({db:'database', front:'frontend', testing:'tester'})[role] ?? role;

function roleTerms(text) {
  return text.replaceAll('`db`', '`database`').replaceAll('`front`', '`frontend`')
    .replaceAll('backend/db/front/tester', 'backend/database/frontend/tester');
}

export function adaptBrief(body) {
  return roleTerms(body)
    .replace(/\/beerpowers:(product-onboard|setup|update|feature|task-start|team-up|onboard)\b/g, '$$beerpowers $1')
    .replace(/beerpowers:(?!engine\b)(?=[a-z-]+)/g, 'beerpowers-codex:')
    .replaceAll('Ты серверный разработчик', 'Ты backend-разработчик')
    .replace(/скажи `frontend` через( *\r?\n[ \t]*)(?:SendMessage|сообщением в текущей команде)/g, 'уведомь `frontend`$1сообщением в текущей команде')
    .replaceAll('через `SendMessage`', 'сообщением в текущей команде')
    .replaceAll('node .claude/bin/git-base.mjs <репо> <КОД>', 'node <пакет>/bin/git-workspace.mjs resolve <КОД> <репо>')
    .replaceAll('из ответа `git-base.mjs`', 'из ответа `git-workspace.mjs resolve`')
    .replaceAll('`.claude/bin/cdp-run.mjs`', '`node <пакет>/bin/cdp-run.mjs`')
    .replace(/\.claude\/agent-memory\/([\w-]+)-agent\//g, (_, name) => '.codex/agent-memory/' + roleId(name) + '/')
    .replace(/\.claude\/(?=(?:team-charter|team-lead)\.md|agents\/|rules\/)/g, '.codex/');
}

function renderRole(file, overrides, project) {
  const source = template('roles/' + file);
  if (!object(overrides)) throw Error('Ожидаются слоты роли ' + file);
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[A-Z_]+$/.test(key) || ['PROJECT','ROLE_SKILLS'].includes(key) || !source.includes('{{' + key + '}}') ||
        typeof value !== 'string' || !value.trim() || /\0|\{\{|<!--\s*\/?beerpowers:engine/.test(value)) {
      throw Error('Invalid role slot: ' + file + '/' + key);
    }
  }
  const [raw, rawHeader, rawBody] = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source) ?? [];
  if (!raw) throw Error(file + ': отсутствует шапка шаблона');
  const description = {BACKEND:file === 'architect-agent.md' ? 'серверного приложения' : 'серверной платформе проекта',
    FRONTEND_FRAMEWORK:file === 'architect-agent.md' ? 'веб-приложения' : 'клиентском фреймворке проекта',
    DATABASE:'базы проекта', TEST_RUNNER:'проекта', ...overrides};
  const header = rawHeader.replace(/^description: (.+)$/m, (_, value) => 'description: ' + JSON.stringify(
    JSON.parse(value).replace(/\{\{([A-Z_]+)\}\}/g, (slot, key) => description[key] ?? slot)))
    .replaceAll('[{{ROLE_SKILLS}}]', '[]');
  const slots = {PROJECT:project, ...overrides};
  // Шаг 2 задаёт первый проектный вопрос. Без пресета оставляем общий вопрос в той же позиции.
  slots.DESIGN_FIRST_QUESTION ??= '2. **Первый вопрос** — кто меняет это значение, как часто и требует ли это релиза?';
  const body = rawBody.replace(/^\s*(?:>[^\n]*\n)+\s*/, '').replace(/^([^\r\n]*\{\{[A-Z_]+\}\}[^\r\n]*)(\r?\n|$)/gm, (_, line, end) =>
    [...line.matchAll(/\{\{([A-Z_]+)\}\}/g)].some(match => !(match[1] in slots)) ? '' :
      line.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => slots[key]) + end);
  return '---\n' + normalize(header) + '\n---\n\n' + body.trimStart();
}

function conditionalBlocks(body, file, ui) {
  const edits = [...blocks(body, file).values()].filter(block => block.condition === 'ui:true' && !ui);
  for (const block of edits.reverse()) body = body.slice(0, block.start) + body.slice(block.end).replace(/^\r?\n/, '');
  return body;
}

const archiveMemoryGuidance = 'Сюда — только `feedback_*.md`: поправки человека к работе роли. Знание о проекте — в `memory/` ' +
  'по таблице «Куда класть находку» `memory/MEMORY.md`; правило — charter, «Память роли — только обратная связь человека».';

function migrateMemoryIndex(archive, canonical, agentName) {
  if (archive === null) return canonical;
  const text = archive.replace(/^\uFEFF/, '');
  const eol = nl(text);
  const owned = new Set(['# Память роли ' + agentName, archiveMemoryGuidance, ...canonical.trim().split(/\r?\n\s*\r?\n/)]);
  const prose = new Set([...markupLines(text)].map(row => row.start));
  // Пропускаем только целые служебные абзацы. Текст вокруг ссылок, сами ссылки
  // и фрагменты в fenced-примерах остаются с исходными пробелами и окончаниями строк.
  const parts = text.split(/(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/);
  let notes = '', offset = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const paragraph = parts[i], space = parts[i+1] ?? '';
    const recognized = prose.has(offset) && owned.has(paragraph.trim().replace(/\s+/g, ' '));
    if (paragraph.trim() && !recognized) notes += paragraph + space;
    offset += paragraph.length + space.length;
  }
  return canonical.replace(/\r?\n/g, eol) + (notes ? eol + notes : '');
}

// Два независимых якоря для вставки нового блока: следующий реальный заголовок или
// следующий именованный блок. Заголовки из примеров ADR/PRD за якоря не принимаются.
export function refreshRole(text, canonical, previous, ui, file) {
  const header = hasHeader(text) ? parseFrontmatter(text, file).header : '';
  text = text.slice(header.length);
  const templateBody = doc => doc.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  canonical = templateBody(canonical);
  if (previous) previous = templateBody(previous);
  const current = blocks(text, file);
  if (!current.size) return header + text; // Полностью авторский бриф.
  const expected = blocks(normalize(canonical), file);
  const prior = previous ? blocks(normalize(previous), file) : null;
  const headings = (doc, markers) => [...markupLines(doc)].filter(row => /^#{1,6}\s+/.test(row.content) &&
    ![...markers.values()].some(marker => marker.start <= row.start && row.end <= marker.end));
  const anchors = [...expected.values(), ...headings(normalize(canonical), expected)].sort((a,b) => a.start - b.start);
  const eol = nl(text);
  for (const [name, block] of expected) {
    const live = blocks(text, file), found = live.get(name);
    const enabled = block.condition !== 'ui:true' || ui;
    if (!found) {
      if (!enabled || (prior?.has(name) && !block.condition) || (!prior && !block.condition)) continue;
      const headingsInBody = headings(text, live);
      const following = anchors.slice(anchors.indexOf(block) + 1).map(anchor =>
        anchor.name ? live.get(anchor.name) : headingsInBody.find(h => h.content === anchor.content)).find(Boolean);
      const position = following?.start ?? text.length;
      const prefix = position && !text.slice(0,position).endsWith(eol) ? eol : '';
      text = text.slice(0,position) + prefix + block.text.replaceAll('\n', eol) + eol + eol + text.slice(position);
      continue;
    }
    const old = normalize(found.text), priorText = prior?.get(name)?.text;
    if (enabled && old === block.text) continue;
    if (old !== block.text && adaptBrief(old) !== block.text && old !== priorText) {
      if (priorText && priorText !== block.text) throw Error('Conflict ' + file + ' [' + name + ']');
      continue; // Без известной предыдущей редакции проектная запись сохраняется.
    }
    text = text.slice(0, found.start) + (enabled ? block.text.replaceAll('\n',eol) : '') + text.slice(found.end);
  }
  return header + text;
}

export function planRoles(input) {
  const {detected, roles, project, track, ui, preview, inputs} = input;
  const products = Object.keys(detected);
  const changes = [], report = inputs.dependencies ?? [];
  const assigned = {}, bindings = new Map();
  const charter = read('.codex/team-charter.md') ?? '';
  const hasRoster = /^## Состав[ \t]*\r?$/m.test(charter) && /^ *\|[^\r\n]*Read on spawn/m.test(charter);
  const teams = {}, skills = inputs.skills ?? {}, available = inputs.available;
  if (!object(skills) || !object(inputs.slots ?? {}) || !object(inputs.rules ?? {}) || (available && !strings(available)) ||
      !Array.isArray(report)) throw Error('Неверные параметры настройки ролей');
  for (const role of Object.keys(inputs.slots ?? {})) if (!roles.includes(role)) throw Error('Unknown role: ' + role);
  for (const name of [...Object.keys(skills), ...Object.keys(inputs.rules ?? {})]) if (!products.includes(name)) throw Error('Unknown project: ' + name);
  for (const row of report) {
    if (!products.includes(row?.product) || ![...roles, 'team-lead'].includes(row?.role) ||
        [row.dependency, row.reason, row.connection ?? ' '].some(v => typeof v !== 'string' || !v || /[\r\n\0|]/.test(v))) {
      throw Error('Expected product, role, dependency, reason and optional connection');
    }
  }
  const change = (path, before, after) => {
    if (before !== after) changes.push({path, action: before === null ? 'CREATE' : 'UPDATE',
      content: Buffer.from(after).toString('base64')});
  };
  for (const name of products) {
    const defaults = detected[name];
    const selected = hasRoster ? [...readCharter(root, name).team.keys()] : [];
    const team = selected.length ? selected : defaults.team;
    teams[name] = [...new Set([...team, ...(track ? (track === 'pm' ? ['product'] : defaults.team) : [])])];
    for (const [role, values] of Object.entries(skills[name] ?? {})) {
      const id = roleId(role);
      if (![...roles,'team-lead'].includes(id) || !strings(values) || !values.every(validSkill)) throw Error('Invalid role skills: ' + role);
      if (available && values.some(skill => !available.includes(skill))) throw Error('Unavailable assigned skill for ' + name + '/' + role);
      (assigned[id] ??= {})[name] = values;
    }
    for (const [id, rule] of Object.entries(inputs.rules?.[name] ?? {})) {
      if (!/^[\w-]+$/.test(id) || !strings(rule.paths) || !rule.paths.length || typeof rule.text !== 'string' || !rule.text.trim() || rule.text.includes('\0')) throw Error('Invalid project rule: ' + id);
      for (const relative of rule.paths) {
        const checkout = workspacePath(root, 'projects/' + name), target = workspacePath(root, 'projects/' + name + '/' + relative);
        const tracked = execFileSync('git',['-C',checkout,'--literal-pathspecs','ls-files','-z','--',relative],{encoding:'utf8'});
        if (!existsSync(target) || !tracked.split('\0').some(p => p === relative || p.startsWith(relative + '/'))) throw Error('Project rule path has no tracked files: ' + name + '/' + relative);
      }
      const text = rule.text.replace(/\n?$/, '\n');
      const record = bindings.get(id) ?? {scopes:{}, text};
      if (normalize(record.text) !== normalize(text)) throw Error('Rule conflicts with existing text: ' + id);
      record.scopes[name] = rule.paths;
      bindings.set(id, record);
    }
  }
  for (const name of new Set([...entries('.claude/rules').filter(n => /^[\w-]+\.md$/.test(n)), ...[...bindings.keys()].map(id => id + '.md')])) {
    const path = '.codex/rules/' + name, before = read(path);
    let result = before ?? read('.claude/rules/' + name);
    const record = bindings.get(name.slice(0,-3));
    if (record) {
      const parsed = result && hasHeader(result) ? parseFrontmatter(result, path) : null;
      if (result && normalize(parsed?.body ?? result).trimEnd() !== normalize(record.text).trimEnd()) throw Error('Rule conflicts with existing text: ' + path);
      result ??= record.text;
      const paths = Object.entries(record.scopes).flatMap(([repo, values]) => values.map(p => 'projects/' + repo + (p === '.' ? '' : '/' + p)));
      if (!parsed) result = ['---', 'paths: ' + JSON.stringify(paths), '---', ''].join(nl(result)) + result;
      else {
        if (!strings(parsed.fields.paths)) throw Error(path + ': invalid paths');
        const combined = [...new Set([...parsed.fields.paths, ...paths])];
        result = setFrontmatterField(result, 'paths', combined, path);
      }
    }
    if (!record && before === null && result !== null) {
      // В Claude файл без paths действует во всех продуктах этого внешнего workspace.
      const defaults = products.map(repo => 'projects/' + repo);
      if (!hasHeader(result)) result = ['---', 'paths: ' + JSON.stringify(defaults), '---', ''].join(nl(result)) + result;
      else if (!('paths' in parseFrontmatter(result, path).fields)) result = setFrontmatterField(result, 'paths', defaults, path);
    }
    if (result !== null) change(path, before, result);
  }
  function applySkills(text, role, existingHeader) {
    const scoped = assigned[role];
    const fields = parseFrontmatter(text).fields;
    if (scoped && !existingHeader) {
      const values = products.map(repo => scoped[repo] ?? fields.skills ?? []);
      if (values.every(v => JSON.stringify(v) === JSON.stringify(values[0]))) text = setFrontmatterField(text, 'skills', values[0]);
      else text = setFrontmatterField(text, 'project_skills', scoped);
    }
    const selected = parseFrontmatter(text).fields;
    for (const repo of preview ? products : []) for (const skill of selected.project_skills?.[repo] ?? selected.skills ?? []) {
      if (!available?.includes(skill) && !report.some(row => row.product === repo && row.role === role && row.dependency === skill)) {
        report.push({product:repo, role, dependency:skill, reason:available ? 'Навык отсутствует в списке текущего чата' : 'Список навыков текущего чата недоступен'});
      }
    }
    return text;
  }
  const memoryTemplate = template('role-memory/MEMORY.md');
  for (const role of roles) {
    const file = roleFilename(role), path = '.codex/agents/' + file, before = read(path);
    const legacyBrief = read('.codex/roles/' + role + '.md');
    if (role === 'implementer' && !before && !legacyBrief) continue;
    const raw = role === 'implementer' ? setFrontmatterField(
      renderRole('backend-agent.md', {}, project).replace(/^name: backend-agent$/m, 'name: implementer-agent'),
      'description', 'Исполнитель проектного брифа. Реализует назначенный срез в пределах его файлов и прогоняет гейты проекта.') :
      renderRole(file, inputs.slots?.[role] ?? {}, project);
    const archive = read('.claude/agents/' + file);
    const source = archive ?? raw, parsed = parseFrontmatter(source, file);
    let base = before;
    if (base === null && legacyBrief && !/Прочитай руководство из \.codex\/roles\/guides\/|Следуй назначенному режиму DESIGN, REVIEW или CONSULT из руководства роли/.test(legacyBrief)) base = legacyBrief;
    let result;
    if (base !== null && hasHeader(base)) result = base;
    else {
      const header = archive && typeof parsed.fields.description === 'string' ?
        setFrontmatterField(parsed.header, 'description', roleTerms(parsed.fields.description), path) : parsed.header;
      if (base !== null) result = header.replace(/\r?\n/g, nl(base)) + base.replace(/^\uFEFF/, '');
      else result = header + conditionalBlocks(archive ? adaptBrief(parsed.body) : parsed.body, file, ui);
    }
    const existingFields = parseFrontmatter(result, path).fields;
    const defaults = parseFrontmatter(raw, file).fields;
    for (const key of ['name','description','model','color','tools']) {
      if (!Object.hasOwn(existingFields, key)) result = setFrontmatterField(result, key, parsed.fields[key] ?? defaults[key], path);
    }
    if (isClaudeModel(parseFrontmatter(result, path).fields.model)) result = setFrontmatterField(result, 'model', defaults.model, path);
    result = applySkills(result, role, Boolean(base && hasHeader(base)) || Boolean(archive));
    const fields = roleMetadata(result, role, path);
    change(path, before, result);
    const sourceDir = '.claude/agent-memory/' + file.slice(0,-3);
    if (!fields.memory && !entries(sourceDir).length) continue;
    const dir = (fields.memory === 'local' ? '.codex/agent-memory-local/' : '.codex/agent-memory/') + role;
    const indexPath = dir + '/MEMORY.md', index = read(indexPath);
    const oldIndex = read(sourceDir + '/MEMORY.md');
    const oldGenerated = index && index === oldIndex && index.trimStart().replace(/\s+/g,' ').startsWith(
      '# Память роли ' + file.slice(0,-3) + ' ' + archiveMemoryGuidance);
    if (index === null || oldGenerated || normalize(index) === normalize(memoryTemplate) ||
        digest(index) === '730b34876ac4cbcbc3cc5de1fb33b4941aeb599988a5422cb098d90692896a28') {
      const canonical = memoryTemplate.replace(/\r?\n/g, nl(index));
      change(indexPath, index, migrateMemoryIndex(oldIndex, canonical, file.slice(0,-3)));
    }
    for (const name of entries(sourceDir).filter(n => /^feedback_[^/\\]+\.md$/.test(n))) {
      const target = dir + '/' + name, existing = read(target);
      const original = read(sourceDir + '/' + name);
      if (existing !== null && existing !== original) throw Error('Feedback conflict: ' + target + ' / ' + sourceDir + '/' + name);
      change(target, existing, original);
    }
  }
  let leadHeader;
  if (assigned['team-lead']) {
    const path = '.codex/team-lead.md', before = read(path);
    const withHeader = before && hasHeader(before);
    const seed = withHeader ? before : '---\nskills: []\n---\n';
    const edited = applySkills(seed, 'team-lead', withHeader);
    leadHeader = parseFrontmatter(edited).header;
    if (before) change(path, before, withHeader ? edited : leadHeader.replace(/\r?\n/g, nl(before)) + before);
  }
  return {changes, teams, report, leadHeader};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(JSON.stringify(planRoles(JSON.parse(readFileSync(process.argv[2], 'utf8'))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

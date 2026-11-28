import { readFileSync } from 'node:fs';
import { load, CORE_SCHEMA } from '../vendor/js-yaml/js-yaml.mjs';

export function parseFrontmatter(text, source = 'Markdown') {
  const match = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)^(---[ \t]*(?:\r?\n|$))/m.exec(text);
  if (!match || match.index) throw Error(source + ': отсутствует YAML frontmatter');
  let fields;
  try { fields = load(match[2], {schema: CORE_SCHEMA}); }
  catch (error) { throw Error(source + ': YAML ' + error.reason + ' (строка ' + ((error.mark?.line ?? 0) + 2) + ')'); }
  if (!fields || Array.isArray(fields) || typeof fields !== 'object') throw Error(source + ': ожидается YAML mapping');
  return {fields, header:match[0], body:text.slice(match[0].length)};
}

function list(value, source) {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim()) ||
      new Set(value).size !== value.length) throw Error(source + ': ожидается список разных непустых строк');
  return value;
}

export const roleFilename = role => (role === 'tester' ? 'testing' : role) + '-agent.md';

// Setup распознаёт старое значение, чтобы записать штатную модель роли.
export function isClaudeModel(value) {
  return typeof value === 'string' && /^(?:(?:anthropic[/:.])?claude(?:[-/:]|$)|(?:opus|sonnet|haiku)(?:$|[-:\[])|opusplan$|inherit$)/i.test(value);
}

export function roleMetadata(text, role, source) {
  const {fields} = parseFrontmatter(text, source);
  for (const key of ['name', 'description', 'color', 'model']) {
    if (typeof fields[key] !== 'string' || !fields[key].trim()) throw Error(source + ': поле ' + key + ' должно быть строкой');
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(fields.name)) throw Error(source + ': недопустимое имя агента ' + fields.name);
  const reserved = ['architect','auditor','backend','database','devops','explorer','frontend','implementer','product','reviewer','tester'];
  if (reserved.some(other => other !== role && roleFilename(other) === fields.name + '.md')) {
    throw Error(source + ': имя ' + fields.name + ' принадлежит другой роли');
  }
  if (fields.memory !== undefined && !['project', 'local'].includes(fields.memory)) throw Error(source + ': недоступная область memory');
  list(fields.tools, source + ': tools');
  if ('skills' in fields) list(fields.skills, source + ': skills');
  if ('project_skills' in fields) {
    if (!fields.project_skills || Array.isArray(fields.project_skills) || typeof fields.project_skills !== 'object') {
      throw Error(source + ': неверное поле project_skills');
    }
    for (const [project, skills] of Object.entries(fields.project_skills)) {
      if (!/^[\w.-]+$/.test(project)) throw Error(source + ': неверный проект ' + project);
      list(skills, source + ': project_skills.' + project);
    }
  }
  return fields;
}

export function setFrontmatterField(text, key, value, source) {
  if (!/^[a-z][a-z_]*$/.test(key)) throw Error('Неверное имя поля');
  const {fields, header, body} = parseFrontmatter(text, source);
  if (JSON.stringify(fields[key]) === JSON.stringify(value)) return text;
  const nl = header.includes('\r\n') ? '\r\n' : '\n';
  const lines = header.split(/\r?\n/);
  const closing = lines.findIndex((s, i) => i && /^---[ \t]*$/.test(s));
  const at = lines.findIndex((s, i) => i && new RegExp('^(?:' + key + '|"' + key + '"|\'' + key + '\')\\s*:').test(s));
  if (at === -1 && Object.hasOwn(fields, key)) throw Error('Сложное YAML-поле требует ручного разрешения: ' + key);
  let end = at + 1;
  while (at > 0 && end < closing && /^(?:\s|#|$|- )/.test(lines[end])) end++;
  while (at > 0 && end > at + 1 && /^\s*(?:#|$)/.test(lines[end - 1])) end--;
  lines.splice(at > 0 ? at : closing, at > 0 ? end - at : 0, key + ': ' + JSON.stringify(value));
  const result = lines.join(nl) + body;
  const next = parseFrontmatter(result).fields;
  if (JSON.stringify({...fields, [key]:value}) !== JSON.stringify(next)) throw Error('Изменение другого YAML-поля: ' + key);
  return result;
}

if (import.meta.main) {
  try {
    const [operation, name] = process.argv.slice(2);
    if (operation === 'read') console.log(JSON.stringify(parseFrontmatter(readFileSync(name, 'utf8'), name).fields));
    else if (operation === 'field') process.stdout.write(setFrontmatterField(readFileSync(0, 'utf8'), name, JSON.parse(process.env.BEERPOWERS_FIELD_JSON)));
    else throw Error('role-metadata.mjs read FILE | field KEY');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

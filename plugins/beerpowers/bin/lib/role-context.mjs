import { createHash } from 'node:crypto';
import { existsSync, globSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePath } from './ui-workspace.mjs';
import { parseFrontmatter, roleFilename, roleMetadata } from './role-metadata.mjs';
import { referenceFile, referenceNamespace } from './role-references.mjs';

const pkg = fileURLToPath(new URL('../../', import.meta.url));
const charterFile = '.codex/team-charter.md';
const read = (root, file) => readFileSync(workspacePath(root, file), 'utf8');
const namePattern = /^[a-z][\w-]*$/;
const stripTicks = s => s.trim().replace(/^`(.*)`$/u, '$1');

function tables(text) {
  const tables = [];
  let section = '', fence = '';
  const lines = text.split(/\r?\n/);
  const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(v => v.replace(/\\\|/g, '|').trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) { if (marker?.[1].startsWith(fence) && !marker[2].trim()) fence = ''; continue; }
    if (marker) { fence = marker[1]; continue; }
    if (/^#{1,2} /.test(line)) section = line.slice(line.indexOf(' ') + 1).trim();
    if (!/^ {0,3}\|/.test(line) || !/^ {0,3}\|/.test(lines[i + 1] ?? '')) continue;
    const keys = cells(line);
    if (!keys.includes('Роль') || !(keys.includes('Модель') || keys.includes('Read on spawn'))) continue;
    const divider = cells(lines[i + 1]);
    if (divider.length !== keys.length || !divider.every(v => /^:?-{3,}:?$/.test(v))) continue;
    const rows = [];
    i++;
    while (/^ {0,3}\|/.test(lines[i + 1] ?? '')) {
      const values = cells(lines[++i]);
      if (values.length !== keys.length) throw Error(charterFile + ':' + (i + 1) + ': количество колонок расходится с заголовком');
      rows.push(Object.fromEntries(keys.map((k, j) => [k, values[j]])));
    }
    tables.push({section, keys, rows});
  }
  return tables;
}

export function readCharter(root, repo) {
  const all = tables(read(root, charterFile));
  const roster = all.filter(t => t.section === 'Состав' && t.keys.includes('Роль') && t.keys.includes('Read on spawn'));
  if (roster.length !== 1) throw Error(charterFile + ': нужна одна таблица Состав с Read on spawn');
  const team = new Map();
  for (const row of roster[0].rows) {
    const role = stripTicks(row['Роль']);
    const projects = (row['Проекты'] ?? row['Продукты'] ?? 'все').replaceAll('`', '').split(/\s*,\s*/);
    if (!projects.some(p => [repo, 'все', 'Все', '—', '*'].includes(p))) continue;
    if (!namePattern.test(role) || team.has(role)) throw Error(charterFile + ': неверная или повторная роль ' + role);
    team.set(role, row);
  }
  const models = new Map();
  for (const table of all.filter(t => t.keys.includes('Роль') && t.keys.includes('Модель'))) {
    for (const row of table.rows) {
      const key = stripTicks(row['Роль']), model = stripTicks(row['Модель']);
      if (models.has(key)) throw Error(charterFile + ': повторное назначение модели для ' + key);
      models.set(key, model);
    }
  }
  return {team, models};
}

export function readRole(root, role) {
  if (!namePattern.test(role)) throw Error('Неверное имя роли: ' + role);
  if (role === 'team-lead') {
    const file = '.codex/team-lead.md', text = read(root, file);
    return {file, fields:/^\uFEFF?---\s*\r?\n/.test(text) ? parseFrontmatter(text, file).fields : {}};
  }
  const file = '.codex/agents/' + roleFilename(role);
  return {file, fields:roleMetadata(read(root, file), role, file)};
}

export function roleSkills(fields, repo) { return fields.project_skills?.[repo] ?? fields.skills ?? []; }

export function verifyRoles(root, repos) {
  const briefs = readdirSync(workspacePath(root, '.codex/agents'), {withFileTypes:true})
    .filter(entry => entry.isFile() && entry.name.endsWith('-agent.md'));
  if (!briefs.length) throw Error('Отсутствуют брифы .codex/agents/');
  const names = new Set();
  for (const {name} of briefs) {
    const stem = basename(name, '-agent.md');
    const fields = readRole(root, stem === 'testing' ? 'tester' : stem).fields;
    if (names.has(fields.name)) throw Error('Повторное имя роли во frontmatter: ' + fields.name);
    names.add(fields.name);
  }
  return Object.fromEntries(repos.map(repo => {
    const {team} = readCharter(root, repo);
    if (!team.size) throw Error('Пустой состав команды для ' + repo);
    const roles = [...team.keys()];
    for (const role of roles) readRole(root, role);
    return [repo, {source:charterFile, roles, rules:pathRules(root, repo)}];
  }));
}

export function pathRules(root, repo, paths = []) {
  for (const p of paths) workspacePath(root, p);
  const dir = '.codex/rules';
  if (!existsSync(workspacePath(root, dir))) return [];
  const result = [];
  for (const name of readdirSync(workspacePath(root, dir)).filter(f => f.endsWith('.md')).sort()) {
    const file = dir + '/' + name;
    const text = read(root, file);
    // Старые самостоятельные заметки без paths остаются справочными.
    if (!/^\uFEFF?---[ \t]*\r?\n/.test(text)) continue;
    const {fields} = parseFrontmatter(text, file);
    if (!('paths' in fields)) continue;
    if (!Array.isArray(fields.paths) || !fields.paths.length) throw Error(file + ': paths должен быть непустым списком');
    let selected = false;
    for (const pattern of fields.paths) {
      if (typeof pattern !== 'string' || /[\\:\x00-\x1f]/.test(pattern) ||
          pattern.split('/').some(p => !p || ['.', '..'].includes(p))) throw Error(file + ': неверный путь правила');
      const parts = pattern.split('/');
      const project = parts[0] === 'projects' ? 1 : parts[0] === 'worktrees' ? 2 : 0;
      if (project && (!parts[project] || !matchesGlob(repo, parts[project]))) continue;
      const relative = project ? parts.slice(project + 1).join('/') : pattern;
      if (!paths.length || !relative || paths.some(p => matchesGlob(p, relative) || p.startsWith(relative + '/'))) selected = true;
    }
    if (selected) result.push(file);
  }
  return result;
}

function addReading(root, row, add) {
  const cell = row?.['Read on spawn'] ?? '';
  // Условия в свободном тексте остаются у тимлида. Все названные документы доступны в пакете.
  const references = /(?:`([^`]+)`|\[[^\]]*\]\(([^)]+)\)|((?:beerpowers:reference\/|memory\/|\.codex\/(?:agents\/|roles\/))[^\s`,;()]+?\.md\b))/gu;
  for (const match of cell.matchAll(references)) {
    const path = match[1] ?? match[2] ?? match[3];
    const after = cell.slice(match.index + match[0].length);
    const optional = /^\s*\((?:если создан[аоы]?|при наличии)\)/i.test(after);
    if (path.startsWith(referenceNamespace + '/')) {
      const label = path.split('#', 1)[0];
      const file = referenceFile(label, optional);
      if (file) add(label, file);
      continue;
    }
    if (!/^(?:memory\/|\.codex\/(?:agents\/|roles\/))/.test(path) || !path.endsWith('.md')) continue;
    const local = workspacePath(root, path.replaceAll('*', 'x'));
    if (!path.includes('*')) {
      if (!optional || existsSync(local)) add(path, local);
      continue;
    }
    const expanded = globSync(path, {cwd:root}).sort();
    if (!expanded.length && !optional) throw Error('Read on spawn: отсутствуют файлы ' + path);
    for (const entry of expanded) {
      const label = entry.replaceAll('\\', '/');
      add(label, workspacePath(root, label));
    }
  }
}

export function rolePacket(root, repo, guide, role, paths = [], env = process.env) {
  const {team, models} = readCharter(root, repo);
  const {file, fields} = readRole(root, role);
  const row = team.get(role);
  const files = new Map();
  function add(label, path) {
    if (!files.has(label)) files.set(label, readFileSync(path));
  }
  for (const path of [charterFile, file, 'memory/MEMORY.md', guide]) add(path, workspacePath(root, path));
  addReading(root, row, add);
  const pathsToRead = [];
  if (role === 'team-lead' && existsSync(workspacePath(root, 'memory/project/domain-invariants.md'))) pathsToRead.push('memory/project/domain-invariants.md');
  if (fields.memory) {
    const dir = (fields.memory === 'project' ? '.codex/agent-memory/' : '.codex/agent-memory-local/') + role;
    const local = workspacePath(root, dir);
    if (fields.memory === 'project' || existsSync(local)) {
      pathsToRead.push(dir + '/MEMORY.md', ...readdirSync(local).filter(f => /^feedback_.+\.md$/.test(f)).sort().map(f => dir + '/' + f));
    }
  }
  pathsToRead.push(...pathRules(root, repo, paths));
  for (const path of pathsToRead) add(path, workspacePath(root, path));
  const skills = roleSkills(fields, repo);
  const charterPractices = row?.['Mandatory practices'] ?? '';
  const declaredPractices = charterPractices + '\n' + files.get(file).toString('utf8');
  const practices = [...declaredPractices.matchAll(/beerpowers(?:-codex)?:([a-z-]+)/g)].map(m => m[1])
    .filter(name => existsSync(join(pkg, 'skills', name, 'SKILL.md')));
  const missing = [];
  const skillFiles = JSON.parse(env.BEERPOWERS_SESSION_SKILL_PATHS_JSON ?? '{}');
  const available = env.BEERPOWERS_SESSION_SKILLS_JSON ? JSON.parse(env.BEERPOWERS_SESSION_SKILLS_JSON) : null;
  if (available !== null && (!Array.isArray(available) || available.some(s => typeof s !== 'string'))) throw Error('Неверный список навыков сессии');
  for (const name of new Set([...practices, ...skills, ...(role === 'team-lead' ? ['minimal-diff','economy','brainstorm','grill','prototype','tracker-task','summarizing-mr-links'] : [])])) {
    const short = name.replace(/^beerpowers(?:-codex)?:/, '');
    const bundled = /^[a-z][a-z-]*$/.test(short) ? join(pkg, 'skills', short, 'SKILL.md') : '';
    const path = bundled && existsSync(bundled) ? bundled :
      (!available || available.includes(name)) && Object.hasOwn(skillFiles, name) ? skillFiles[name] : '';
    if (!path) { missing.push(name); continue; }
    if (!isAbsolute(path) || basename(path) !== 'SKILL.md' || !lstatSync(path).isFile()) throw Error('Неверный путь навыка ' + name);
    add(path.replaceAll('\\', '/'), path);
  }
  const body = [...files].map(([label, bytes]) => '\nFILE ' + label + ' sha256=' + createHash('sha256').update(bytes).digest('hex') + '\n' + bytes.toString('utf8') + '\n').join('');
  const info = 'Roster: ' + [...team.keys()].join(', ') + '\nAssigned skills (' + role + '): ' + skills.join(', ') + '\n' +
    (missing.length ? 'Недоступен текст навыка в этой сессии: ' + missing.join(', ') + '\n' : '') +
    (row ? 'Read on spawn: ' + row['Read on spawn'] + '\n' : 'Роль вне состава проекта: ' + role + '\n');
  return {role, fields, row, models, files:[...files.keys()], missing, body:info + body};
}

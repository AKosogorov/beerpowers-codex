#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { findRoot, workspacePath } from './lib/ui-workspace.mjs';
import { readCharter, readRole, rolePacket, verifyRoles } from './lib/role-context.mjs';
import { showHelp } from './lib/cli-help.mjs';

showHelp('role-launch.mjs ROLE --effort LEVEL [--task-name NAME] [--model MODEL] [--path PATH] < task.txt\n' +
  '  [--without-skill NAME] [--need-tool NAME]\nrole-launch.mjs packet REPO GUIDE ROLE [PATH...]\nrole-launch.mjs bind ROLE HOST_AGENT_ID');

export function spawnArguments(packet, task, values, inventory, root) {
  if (!packet.row) throw Error('Роль отсутствует в составе выбранного проекта: ' + packet.role);
  const {fields, models} = packet;
  const skipped = values['without-skill'] ?? [];
  if (packet.missing.some(name => !skipped.includes(name))) throw Error('Недоступны назначенные навыки: ' + packet.missing.join(', '));
  if (skipped.some(name => !packet.missing.includes(name))) throw Error('--without-skill указывает навык вне списка недоступных');
  const model = values.model ?? models.get(packet.role) ?? fields.model;
  const reasoning_effort = values.effort;
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) ||
      !Object.hasOwn(inventory, model) || !Array.isArray(inventory[model]) || !inventory[model].includes(reasoning_effort)) {
    throw Error('Схема текущего spawn_agent не подтверждает сочетание ' + model + ' / ' + reasoning_effort);
  }
  const task_name = values['task-name'] ?? fields.name.replaceAll('-', '_');
  if (!/^[a-z0-9_]+$/.test(task_name) || !task.trim()) throw Error('Укажи task_name и текст задачи');
  const message = [fields.name + ' · ' + fields.description, 'Workspace: ' + root,
    'Постановка: ' + task.trim(),
    'До привязки выданного хостом ID возврати только готовность и дождись followup_task. Затем прочитай пакет. ' +
    'Верни прочитанные источники, конкретное правило, результат и блокеры. Разрешённые операции: ' + fields.tools.join(', '),
    packet.body].join('\n\n');
  const limitations = [];
  if (skipped.length) limitations.push('Тимлид явно согласовал работу без навыков: ' + skipped.join(', '));
  const browser = fields.tools.filter(tool => /^mcp__(?:Claude_Browser|claude-in-chrome)__/.test(tool));
  if (browser.length) {
    const ui = fields.tools.includes('Bash') ? 'Для проверки UI через разрешённый терминал используй ' +
      'bin/cdp-run.mjs и bin/cdp-screenshot.mjs пакета: переходы, действия, размеры окна, DOM, console, сеть и снимки в отдельном Chrome. ' : '';
    limitations.push(ui + 'Если задание требует конкретную сессию или операцию Claude Browser, ' +
      'проверь одноимённый инструмент хоста и сообщи тимлиду о его отсутствии.');
  }
  return {task_name, fork_turns:'none', model, reasoning_effort, message:[message,...limitations].join('\n\n')};
}

export function readerCommand() {
  const paths = [process.execPath, fileURLToPath(new URL('role-files.mjs', import.meta.url))]
    .map(p => realpathSync.native(p).replaceAll('\\', '/'));
  if (paths.some(p => !/^[\p{L}\p{M}\p{N} _.:/()\-]+$/u.test(p))) throw Error('Путь обработчика чтения не поддерживает безопасную форму команды');
  return (process.platform === 'win32' ? '& ' : '') + paths.map(p => "'" + p + "'").join(' ');
}

function selected(root) {
  const products = readdirSync(workspacePath(root, 'projects'), {withFileTypes:true})
    .filter(item => item.isDirectory() && existsSync(workspacePath(root, 'projects/' + item.name + '/.git'))).map(item => item.name);
  const repo = process.env.BEERPOWERS_REPO || (products.length === 1 ? products[0] : '');
  if (!products.includes(repo)) throw Error('Укажи BEERPOWERS_REPO из состава workspace');
  const settings = JSON.parse(readFileSync(workspacePath(root, '.codex/workspace.json'), 'utf8').replace(/^\uFEFF/, ''));
  const guide = settings.commandGuides?.[repo] ?? 'memory/commands/' + repo + '.md';
  if (!/^memory\/commands\/[\w.\/-]+\.md$/.test(guide)) throw Error('Неверный путь команд проекта ' + repo);
  return {repo, guide};
}

const ansi = {red:31, orange:33, yellow:93, green:32, blue:34, purple:35, pink:95, cyan:36, gray:90, grey:90};
function label(fields) {
  const title = fields.name + ' [' + fields.color + ']';
  return process.stderr.isTTY && Object.hasOwn(ansi, fields.color) ? '\x1b[' + ansi[fields.color] + 'm' + title + '\x1b[0m' : title;
}

if (import.meta.main) {
  try {
    const root = findRoot(), [operation, ...args] = process.argv.slice(2);
    if (operation === 'check') {
      verifyRoles(root, args);
    } else if (operation === 'packet') {
      const [repo, guide, role, ...paths] = args;
      process.stdout.write(rolePacket(root, repo, guide, role, paths).body);
    } else if (operation === 'bind') {
      const [role, id] = args;
      if (args.length !== 2 || !id || id.length > 512 || /[\x00-\x1f]/.test(id)) throw Error('Ожидается идентификатор хоста');
      const {repo} = selected(root);
      if (!readCharter(root, repo).team.has(role)) throw Error('Роль вне состава: ' + role);
      const {fields} = readRole(root, role);
      const dir = '.codex/.cache/role-tools';
      mkdirSync(workspacePath(root, dir), {recursive:true});
      const file = workspacePath(root, dir + '/' + createHash('sha256').update(id).digest('hex') + '.json');
      const data = JSON.stringify({role, tools:fields.tools});
      try { writeFileSync(file, data, {flag:'wx'}); }
      catch (error) { if (error.code !== 'EEXIST' || readFileSync(file, 'utf8') !== data) throw error; }
      console.error(label(fields) + ' · ' + id);
      if (fields.tools.some(tool => ['Read','Grep','Glob'].includes(tool))) {
        console.log('Из корня workspace через exec_command с login:false используй обработчик ' + readerCommand() +
          ". Аргументы по выданной операции: Read 'путь', Grep 'путь' 'текст', Glob 'каталог' 'маска'.");
      }
      if (fields.tools.includes('WebSearch') || fields.tools.includes('WebFetch')) {
        console.log('Для web__run применяй search_query при WebSearch и open при WebFetch.');
      }
    } else {
      const {values} = parseArgs({args, options:{effort:{type:'string'}, model:{type:'string'}, 'task-name':{type:'string'},
        path:{type:'string', multiple:true}, 'without-skill':{type:'string',multiple:true}, 'need-tool':{type:'string',multiple:true}}});
      if (!values.effort) throw Error('Тимлид выбирает --effort для конкретного захода');
      const {repo, guide} = selected(root);
      const packet = rolePacket(root, repo, guide, operation, values.path);
      for (const name of values['need-tool'] ?? []) {
        const live = JSON.parse(process.env.BEERPOWERS_SESSION_TOOLS_JSON ?? 'null');
        const adapters = {Read:'exec_command', Grep:'exec_command', Glob:'exec_command', Bash:'exec_command',
          WebSearch:'web__run', WebFetch:'web__run', SendMessage:'collaboration.send_message', Edit:'apply_patch', Write:'apply_patch'};
        if (!packet.fields.tools.includes(name) || !Array.isArray(live) ||
            !(live.includes(name) || (Object.hasOwn(adapters,name) && live.includes(adapters[name])))) {
          throw Error('Требуемый инструмент не подтверждён брифом и схемой хоста: ' + name);
        }
      }
      const launch = spawnArguments(packet, readFileSync(0, 'utf8'), values, JSON.parse(process.env.BEERPOWERS_SESSION_MODELS_JSON ?? 'null'), root);
      console.error(label(packet.fields) + ' · ' + launch.model + ' / ' + launch.reasoning_effort);
      if (packet.fields.tools.some(name => ['Read','Grep','Glob'].includes(name))) console.error('Обработчик чтения: ' + readerCommand());
      process.stdout.write(JSON.stringify(launch));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

#!/usr/bin/env node
// Проверяет конфигурацию, команды тестов, управляемые файлы и раскладку workspace.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, modes } from './lib/git-repositories.mjs';
import { findRoot, loadWorkspace as loadUiSettings, workspacePath } from './lib/ui-workspace.mjs';
import { loadWorkspace as loadTestSettings, SAFE_NAME } from './lib/test-workspace.mjs';
import { techDebtIndex } from './lib/tech-debt-index.mjs';
import { workspaceLinks } from './lib/workspace-links.mjs';

const roles = readdirSync(new URL('../templates/roles/', import.meta.url))
  .filter(file => file.endsWith('-agent.md')).map(file => basename(file, '-agent.md')).map(role => role === 'testing' ? 'tester' : role);
const stacks = readdirSync(new URL('../templates/roles/presets/', import.meta.url), {withFileTypes:true})
  .filter(entry => entry.isDirectory()).map(entry => entry.name);
const flags = ['guard-push', 'guard-kill', 'guard-stdin-code', 'guard-comments', 'guard-commit-split', 'guard-approval-link'];
const taskFiles = new Set(['design-brief.md', 'plan-delta.md', 'test-cases.md', 'bug-log.md', 'review-report.md',
  'handover.md', 'preflight.md', 'git-flow.md', 'audit-report.md', 'checkouts.json', 'feature-state.json',
  'early-review.md', 'opponent-report.md']);
const taskFolders = new Set(['tracker', 'figma', 'screenshots']);
const index = 'memory/MEMORY.md';
const charter = ['.codex/team-charter.md', '.codex/team-lead.md'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const row = (status, evidence, action) => ({status, evidence, action});
const issues = (paths, status = 'fail') => row(paths.length ? status : 'pass', paths);

// Keep line numbers for diagnostics while ignoring fenced examples and managed rules.
function prose(text, skipEngine = false) {
  let fence = '', engine = false;
  return text.split(/\r?\n/).map(line => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close?.startsWith(fence)) fence = '';
      return '';
    }
    fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
    if (fence) return '';
    if (skipEngine && /^<!-- beerpowers:engine /.test(line)) engine = true;
    if (skipEngine && /^<!-- \/beerpowers:engine -->/.test(line)) engine = false;
    return engine ? '' : line;
  });
}

const date = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\.\d{4}\b/;
const snapshots = [
  [new RegExp(`[Сс]верено .{0,80}?(?:${date.source})`), 'дата сверки', false],
  [/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{1,5}:\d+\b/, 'номер строки', true],
  [/[\w@/.-]+ (?:\^|~|>=)?\d+\.\d+\.\d+/, 'версия', true],
  [/(?:^|\s)\d+\s+(?:тестов|теста|файлов|файла|строк|строки|коммитов|коммита)(?=\s|[,.!?)]|$)/, 'счёт', true],
  [/не влит|на ветке [A-Z][A-Z0-9]*-\d+/, 'статус ветки', false],
];

function inspect(root) {
  const stat = file => lstatSync(workspacePath(root, file), {throwIfNoEntry:false});
  const text = file => readFileSync(workspacePath(root, file), 'utf8').replace(/^\uFEFF/, '');
  const config = file => {
    let value;
    try { value = JSON.parse(text(file)); }
    catch (error) {
      if (error instanceof SyntaxError) throw Error(file + ': неверный JSON');
      throw error;
    }
    if (!isObject(value)) throw Error(file + ': ожидается объект');
    return value;
  };
  const entries = file => stat(file)?.isDirectory()
    ? readdirSync(workspacePath(root, file), {withFileTypes:true}).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const products = () => entries('projects').filter(entry => entry.isDirectory() && stat('projects/' + entry.name + '/.git'))
    .map(entry => entry.name);
  function markdown(dir, skip = []) {
    return entries(dir).flatMap(entry => {
      const file = dir + '/' + entry.name;
      if (skip.includes(file)) return [];
      if (entry.isDirectory()) return markdown(file, skip);
      return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
    });
  }
  const memory = () => markdown('memory', ['memory/tasks']);
  const instructions = () => markdown('.codex', ['.codex/.cache', '.codex/agent-memory', '.codex/agent-memory-local']);
  const files = paths => paths.filter(file => stat(file)?.isFile());
  function ignored(paths) {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '-v', '-z', '--no-index', '--stdin'], {
      cwd:root, encoding:'utf8', input:paths.join('\0') + '\0', windowsHide:true,
      timeout:45000, env:{...process.env, GIT_TERMINAL_PROMPT:'0', GIT_OPTIONAL_LOCKS:'0'},
    });
    if (![0, 1].includes(result.status)) throw Error('git check-ignore: ' + (result.error?.code ?? result.status));
    const fields = result.stdout.split('\0');
    const matches = new Map();
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const [source, , pattern, file] = fields.slice(i, i + 4);
      if (!pattern.startsWith('!')) matches.set(file, {source, pattern});
    }
    return matches;
  }

  function workspaceConfig() {
    const source = '.codex/workspace.json';
    const cfg = config(source);
    const legacy = cfg.beerpowers === '0.2.0' && Object.keys(cfg).length === 1;
    if (typeof cfg.beerpowers !== 'string' || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(cfg.beerpowers) ||
        (!legacy && cfg.schemaVersion !== 1)) throw Error(source + ': проверь beerpowers и schemaVersion');
    if ('ui' in cfg && typeof cfg.ui !== 'boolean') throw Error(source + ': ui должен быть логическим');
    if ('viewports' in cfg && (!Array.isArray(cfg.viewports) || cfg.viewports.some(view =>
      !isObject(view) || typeof view.name !== 'string' || !SAFE_NAME.test(view.name)))) {
      throw Error(source + ': viewports должен содержать именованные размеры экрана');
    }
    loadUiSettings(root);
    return row('pass', {source, schemaVersion:cfg.schemaVersion ?? null, beerpowers:cfg.beerpowers});
  }

  function gitSettings() {
    const source = '.codex/git-settings.json';
    const settings = config(source);
    const repos = products();
    const problems = [];
    if (!isObject(settings.repos)) throw Error(source + ': ожидается объект repos');
    for (const key of ['standArchive', 'removeSourceBranch']) {
      if (key in settings && typeof settings[key] !== 'boolean') problems.push(source + ': ' + key + ' должен быть логическим');
    }
    for (const repo of repos) {
      if (!Object.hasOwn(settings.repos, repo)) problems.push(source + ': отсутствует профиль ' + repo);
    }
    for (const [repo, profile] of Object.entries(settings.repos)) {
      if (!repos.includes(repo)) problems.push(source + ': неизвестный продукт ' + repo);
      if (!modes.includes(profile)) problems.push(source + ': неверный профиль ' + repo);
    }
    const local = '.codex/git-settings.local.json';
    if (git(root, ['ls-files', '--', local])) problems.push(local + ': личный файл в индексе Git');
    if (ignored([local]).get(local)?.source !== '.gitignore') problems.push(local + ': нужна запись в корневом .gitignore');
    return issues(problems);
  }

  function productCheckouts() {
    if (!stat('.git') || git(root, ['rev-parse', '--show-prefix'])) throw Error('Открой корень внешнего Git workspace');
    const names = products();
    if (!names.length) return issues(['В projects/ нет репозиториев Git']);
    const problems = [];
    if (git(root, ['ls-files', '--', 'projects/', 'worktrees/'])) problems.push('Внешний Git отслеживает projects/ или worktrees/');
    for (const name of names) {
      const product = 'projects/' + name;
      if (!SAFE_NAME.test(name)) problems.push(product + ': имя продукта вне [A-Za-z0-9_.-]');
      else if (git(workspacePath(root, product), ['rev-parse', '--show-prefix'], true) !== '') {
        problems.push(product + ': недействительный checkout Git');
      }
    }
    return problems.length ? issues(problems) : row('pass', names.map(name => 'projects/' + name));
  }

  function repoIgnores() {
    const problems = [];
    const matches = ignored(['projects/', 'worktrees/']);
    for (const dir of ['projects', 'worktrees']) {
      const match = matches.get(dir + '/');
      if (match?.source !== '.gitignore' || ![dir + '/', '/' + dir + '/'].includes(match.pattern)) {
        problems.push(dir + '/: нужна запись /' + dir + '/ в корневом .gitignore');
      }
    }
    return issues(problems);
  }

  function roleSettings() {
    const productsFound = products();
    const evidence = Object.create(null);
    for (const repo of productsFound) {
      const scoped = '.codex/role-settings/' + repo + '.json';
      const source = productsFound.length > 1 || stat(scoped) ? scoped : '.codex/role-settings.json';
      const cfg = config(source);
      const validList = (list, values) => Array.isArray(list) && new Set(list).size === list.length &&
        list.every(item => values.includes(item));
      if (!validList(cfg.stacks, stacks) || !isObject(cfg.rules) ||
          ('team' in cfg && (!validList(cfg.team, [...roles, 'implementer']) || !cfg.team.length))) throw Error('Неверная схема ' + source);
      for (const [name, dirs] of Object.entries(cfg.rules)) {
        const file = '.codex/rules/' + name + '.md';
        if (!/^[A-Za-z0-9_-]+$/.test(name) || !Array.isArray(dirs) || dirs.some(dir => typeof dir !== 'string' ||
            (dir !== '.' && (/[\\:*\x00-\x1f]/.test(dir) || dir.split('/').some(part => !part || part === '.' || part === '..')))) ||
            !stat(file)?.isFile() || !text(file).trim()) throw Error('Неверное правило ' + file + ' в ' + source);
      }
      const selected = new Set(cfg.team ?? roles);
      const briefs = [...charter, ...[...selected].map(role => {
        const agent = '.codex/agents/' + (role === 'tester' ? 'testing' : role) + '-agent.md';
        return stat(agent) ? agent : '.codex/roles/' + role + '.md';
      })];
      for (const file of briefs) {
        if (!stat(file)?.isFile() || !text(file).trim()) throw Error('Отсутствует или пуст файл ' + file);
      }
      evidence[repo] = {source, stacks:cfg.stacks, rules:cfg.rules};
    }
    if (!productsFound.length) throw Error('Каталоги продуктов не найдены');
    return row('pass', evidence);
  }

  function barriers() {
    const source = '.codex/barriers.json';
    const cfg = config(source);
    const configured = Object.fromEntries(flags.map(name => [name, cfg[name] ?? true]));
    configured['screenshots-reminder'] = cfg['screenshots-reminder'] ?? false;
    const excludeDirs = cfg.comments?.excludeDirs ?? [];
    if (('comments' in cfg && (!Array.isArray(cfg.comments?.excludeDirs) || excludeDirs.some(dir => typeof dir !== 'string' || !dir.length))) ||
        Object.keys(cfg).some(key => key !== 'comments' && (!Object.hasOwn(configured, key) || typeof cfg[key] !== 'boolean'))) {
      throw Error(source + ': неверные флаги барьеров');
    }
    return row('pass', {source, configured, excludeDirs, always:['guard-user-files', 'guard-agent-memory']});
  }

  function sharedSettings() {
    const names = ['.codex/workspace.json', '.codex/git-settings.json', '.codex/role-settings.json', '.codex/barriers.json',
      '.codex/quality-gates.txt', ...products().map(repo => '.codex/role-settings/' + repo + '.json')];
    const matches = ignored(names);
    const tracked = new Set(git(root, ['ls-files', '-z', '--', ...names]).split('\0'));
    return issues(files(names).filter(name => matches.has(name) && !tracked.has(name))
      .map(name => name + ': общий файл игнорируется Git'));
  }

  function qaSettings() {
    config('.codex/workspace.json');
    const {tests, problems} = loadTestSettings(root);
    const evidence = {repos:Object.keys(tests.repos), slots:tests.slots, problems:problems.map(issue => issue.msg)};
    return row(problems.some(issue => issue.testsFatal) ? 'fail' : problems.length ? 'warn' : 'pass', evidence,
      problems.length ? 'Исправь указанные настройки тестов.' : undefined);
  }

  function taskArtifacts() {
    const base = 'memory/tasks';
    const problems = [];
    const allowedFile = (entry, code) => entry.isFile() && (taskFiles.has(entry.name) ||
      entry.name === basename(code) + '-qa.html' || entry.name.endsWith('.jsonl'));
    function scope(dir, code, shared) {
      for (const entry of entries(dir)) {
        const file = dir + '/' + entry.name;
        if (allowedFile(entry, code) || (entry.isDirectory() && taskFolders.has(entry.name))) continue;
        if (shared && entry.isDirectory() && entry.name === 'repos') {
          for (const repo of entries(file)) {
            if (repo.isDirectory() && SAFE_NAME.test(repo.name)) scope(file + '/' + repo.name, code, false);
            else problems.push(file + '/' + repo.name + ': ожидается каталог продукта');
          }
        } else problems.push(file + ': артефакт вне списка');
      }
    }
    function namespace(dir, code) {
      const children = entries(dir);
      if (code && (children.length === 0 || children.some(entry => allowedFile(entry, code) ||
        (entry.isDirectory() && (taskFolders.has(entry.name) || entry.name === 'repos'))))) {
        scope(dir, code, true);
        return;
      }
      for (const entry of children) {
        if (!code && entry.name === '.gitkeep' && entry.isFile()) continue;
        const file = dir + '/' + entry.name;
        if (entry.isDirectory()) namespace(file, code ? code + '/' + entry.name : entry.name);
        else problems.push(file + ': вне каталога задачи');
      }
    }
    if (stat(base) && !stat(base).isDirectory()) return issues([base + ': ожидается каталог']);
    namespace(base, '');
    return issues(problems);
  }

  function roleMemory() {
    const problems = [];
    for (const base of ['.codex/agent-memory', '.codex/agent-memory-local']) {
      if (stat(base) && !stat(base).isDirectory()) problems.push(base + ': ожидается каталог');
      for (const role of entries(base)) {
        const dir = base + '/' + role.name;
        if (!role.isDirectory()) { problems.push(dir + ': ожидается каталог роли'); continue; }
        for (const entry of entries(dir)) {
          if (!entry.isFile() || !/^(?:MEMORY\.md|feedback_[^\\/]+\.md)$/.test(entry.name)) problems.push(dir + '/' + entry.name);
        }
      }
    }
    return issues(problems);
  }

  function ruleOwners() {
    if (!stat(index)?.isFile()) return issues([]);
    const indexLines = prose(text(index));
    let ownersSection = false;
    const rows = indexLines.flatMap(line => {
      if (/^#{1,3} /.test(line)) ownersSection = /^### Владельцы правил\s*$/.test(line);
      if (!ownersSection) return [];
      const parts = /^\s*\|\s*`([^`]+)`\s*\|([^|]+)\|/.exec(line);
      return parts ? [{marker:parts[1], owners:parts[2].split(',').map(owner => owner.trim().replace(/^`|`$/g, ''))}] : [];
    });
    if (!rows.length) return issues([]);
    const documents = [...files(['AGENTS.md']), ...instructions(), ...memory()].filter(file => file !== index);
    return issues(documents.flatMap(file => {
      const content = prose(text(file)).join('\n');
      return rows.filter(({marker, owners}) => content.includes(marker) && !owners.some(owner =>
        file === owner || file.endsWith('/' + owner)))
        .map(({marker, owners}) => `${file}: «${marker}», владелец ${owners.join(', ')}`);
    }));
  }

  function ruleSnapshots() {
    const documents = [...files(['AGENTS.md', ...charter]), ...markdown('.codex/rules'), ...markdown('memory/commands')];
    return issues(documents.flatMap(file => {
      let lessons = 0;
      return prose(text(file), true).flatMap((line, i) => {
        const heading = /^(#{1,6})\s+(.*)/.exec(line);
        if (heading) {
          if (lessons && heading[1].length <= lessons) lessons = 0;
          if (!lessons && /Грабли/.test(heading[2])) lessons = heading[1].length;
          return [];
        }
        if (lessons) return [];
        const content = line.replace(/(?:https?|ftp):\/\/[^\s)]+/g, '');
        const hit = snapshots.find(([re, , observation]) => re.test(content) && !(observation && date.test(content)));
        return hit ? [`${file}:${i + 1}: ${hit[1]} — ${line.trim().slice(0, 160)}`] : [];
      });
    }), 'warn');
  }

  return {
    'workspace-config': workspaceConfig,
    'git-settings': gitSettings,
    'product-checkouts': productCheckouts,
    'checkout-ignores': repoIgnores,
    'memory-links': () => {
      const evidence = workspaceLinks(root);
      return row(evidence.broken.length ? 'fail' : 'pass', evidence);
    },
    'template-slots': () => issues([...files(['AGENTS.md', ...charter]), ...markdown('.codex/agents'),
      ...markdown('.codex/rules'), ...memory()].flatMap(file => prose(text(file)).flatMap((line, i) =>
        [...line.matchAll(/\{\{[A-Z0-9_]+\}\}/g)].map(match => `${file}:${i + 1}: ${match[0]}`)))),
    'task-artifacts': taskArtifacts,
    'role-settings': roleSettings,
    'tech-debt-index': () => {
      const evidence = techDebtIndex(root);
      const action = evidence.mode === 'manual' ? 'Добавь ссылки на перечисленные пункты.'
        : 'После сверки пунктов запусти doctor.mjs tech-debt-index.';
      return row(evidence.current ? 'pass' : 'fail', evidence, evidence.current ? undefined : action);
    },
    'role-memory': roleMemory,
    'script-paths': () => issues(stat('.codex/scripts') ? ['.codex/scripts/'] : []),
    'barriers': barriers,
    'shared-settings': sharedSettings,
    'entry-override': () => {
      const file = 'AGENTS.override.md';
      if (!stat(file)?.isFile()) return issues([]);
      const body = prose(text(file)).join('\n');
      return issues(body.trim() && ![...charter, 'role-packet'].every(entry => body.includes(entry)) ? [file] : [], 'warn');
    },
    'rule-owners': ruleOwners,
    'rule-snapshots': ruleSnapshots,
    'qa-settings': qaSettings,
  };
}

const checks = [
  ['workspace-config', 'Схема .codex/workspace.json', 'Сверь поля с настройками workspace.'],
  ['git-settings', 'Профили продуктов и приватность личных настроек Git', 'Сверь профили продуктов и корневой .gitignore.'],
  ['product-checkouts', 'Внешний Git и репозитории в projects/', 'Открой внешний Git workspace и проверь названия продуктов.'],
  ['checkout-ignores', 'Каталоги projects/ и worktrees/ в корневом .gitignore', 'Добавь правила в корневой .gitignore.'],
  ['memory-links', 'Ссылки в памяти и проектных инструкциях', 'Исправь ссылки в указанных файлах.'],
  ['template-slots', 'Подстановка шаблонов в уставе, ролях, правилах и памяти', 'Заполни указанные слоты.'],
  ['task-artifacts', 'Состав каталогов задач', 'Сверь пути с допустимыми артефактами задачи.'],
  ['role-settings', 'Брифы, выбор команды, стеки и правила по путям', 'Проверь .codex/role-settings.json, брифы и проектные правила.'],
  ['tech-debt-index', 'Актуальность индекса техдолга', 'Проверь пункты и границы блока в memory/tech-debt/tech-debt.md.'],
  ['role-memory', 'Формат каталогов памяти ролей', 'Оставь MEMORY.md и feedback_*.md в каталогах ролей.'],
  ['script-paths', 'Пути проектных скриптов', 'Сверь пути скриптов в .codex/scripts/ с .codex/bin/.'],
  ['barriers', 'Схема .codex/barriers.json', 'Сверь переключатели с reference/hooks.md.'],
  ['shared-settings', 'Доступность общих настроек для Git', 'Сверь правила игнорирования общих настроек.'],
  ['entry-override', 'Вход в устав и пакет роли при наличии AGENTS.override.md', 'Сверь фактические проектные инструкции в Codex.'],
  ['rule-owners', 'Маркеры правил у владельцев из индекса памяти', 'Оставь правило в файле-владельце и добавь ссылку на него в остальных документах.'],
  ['rule-snapshots', 'Изменчивые факты в правилах и формах команд', 'Сверь предупреждения и перенеси наблюдения в тематическую память при необходимости.'],
  ['qa-settings', 'Конфигурация параллельных проверок и мутаций', 'Сверь tests с reference/parallel-tests.md и reference/mutants.md.'],
];

export function checkWorkspace(root) {
  const inspectCheck = inspect(root);
  return checks.map(([id, , repair]) => {
    try {
      const result = inspectCheck[id]();
      return {id, ...result, action:result.action ?? (result.status === 'pass' ? undefined : repair)};
    } catch (error) {
      return {id, ...row('fail', error.message.split('\n')[0], repair)};
    }
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = 'Запуск из корня workspace: node <пакет>/bin/workspace-check.mjs [--list]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(usage);
  else if (args.length === 1 && args[0] === '--list') {
    for (const [id, name] of checks) console.log(`- ${id}: ${name}`);
  } else if (args.length) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    for (const {id, status, evidence, action} of checkWorkspace(findRoot())) {
      console.log(`${status.toUpperCase()}  ${id}`);
      if (status === 'pass') continue;
      const problems = Array.isArray(evidence) ? evidence : [evidence];
      for (const problem of problems.slice(0, 40)) console.log('      ' + (typeof problem === 'string' ? problem : JSON.stringify(problem)));
      if (problems.length > 40) console.log(`      … ещё ${problems.length - 40}`);
      if (action) console.log('      ' + action);
      if (status === 'fail') process.exitCode = 1;
    }
  }
}

// Собирает результаты диагностики пакета, workspace и подключённых инструментов.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspace, workspacePath } from './lib/ui-workspace.mjs';
import { workspaceCheck } from './lib/update-setup.mjs';
import { findChrome } from './lib/chrome.mjs';
import { techDebtIndex } from './lib/tech-debt-index.mjs';
import { checkWorkspace } from './workspace-check.mjs';
import { loadWorkspace as loadTestSettings } from './lib/test-workspace.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('doctor.mjs [tech-debt-index]', ['tech-debt-index']);

const pkg = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync.native('.');
const checks = [];
const text = relative => readFileSync(workspacePath(root, relative), 'utf8').replace(/^\uFEFF/, '');
const config = relative => JSON.parse(text(relative));
const row = (status, evidence, action) => ({status, evidence, action});
function check(id, repair, inspect) {
  try { checks.push({id, ...inspect()}); }
  catch (error) {
    // Parsing errors should identify the source, without echoing possibly private input.
    const message = error instanceof SyntaxError ? 'Неверный формат JSON' : error.message.split('\n')[0];
    checks.push({id, ...row('fail', message, repair)});
  }
}

function inspect() {
  check('runtime', 'Проверь выбранный Node и установку Git с Bash и sh.', () => {
    const windows = process.platform === 'win32';
    const gitPath = windows && spawnSync('where.exe',['git.exe'],{encoding:'utf8',windowsHide:true}).stdout?.split(/\r?\n/)[0];
    const shell = name => gitPath ? join(dirname(dirname(gitPath)), 'bin', name + '.exe') : name;
    const versions = {node:process.version};
    for (const [name, executable, args] of [['git','git',['--version']],['bash',shell('bash'),['--version']],['sh',shell('sh'),['-c','exit 0']]]) {
      const result = spawnSync(executable,args,{encoding:'utf8',windowsHide:true,timeout:10000});
      if (result.status !== 0) throw Error('Не прошла проверка ' + name + ' ' + args.join(' '));
      versions[name] = result.stdout.split(/\r?\n/)[0] || 'OK';
    }
    return row(Number(process.versions.node.split('.')[0]) < 24 ? 'fail' : 'pass', versions);
  });
  check('package', 'Сверь выбранный путь с манифестом установленного пакета.', () => {
    const path = join(pkg, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.name !== 'beerpowers-codex' || manifest.upstream?.name !== 'beerpowers' ||
        !/^[a-f0-9]{40}$/.test(manifest.upstream?.commit ?? '')) throw Error('Несовместимый манифест');
    return row('pass', {path, version:manifest.version, upstream:manifest.upstream, node:process.version});
  });
  check('workspace', 'Проверь внешний Git, источники команд проекта и состояние setup.', () => {
    const out = workspaceCheck(root, pkg, 'doctor');
    const confirmed = out.split(/\r?\n/).filter(line => line.startsWith('Project OK: '));
    if (!confirmed.length) throw Error('Нет подтверждённых продуктов в выводе workspace.pl doctor');
    return row('pass', confirmed);
  });
  check('migration', 'Сверь указанный файл и выполни $beerpowers update для просмотра плана.', () => {
    const result = spawnSync(process.execPath, [join(pkg, 'bin/update.mjs'), 'plan'], {
      cwd:root, encoding:'utf8', windowsHide:true, maxBuffer:16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(result.stderr || 'План обновления недоступен');
    const {from, to, changes} = JSON.parse(result.stdout);
    const evidence = {from, to, changes:changes.map(({path, actions}) => ({path, actions}))};
    return changes.length ? row('warn', evidence, 'Рассмотри план $beerpowers update.') : row('pass', evidence);
  });
  checks.push(...checkWorkspace(root));
  check('ui', 'Исправь viewports либо укажи установленный Chromium через BEERPOWERS_CHROME.', () => {
    const {viewports, viewportsDefault} = loadWorkspace(root);
    const {ui} = config('.codex/workspace.json');
    if (ui !== undefined && typeof ui !== 'boolean') throw Error('Поле ui должно быть логическим');
    const evidence = {ui:ui ?? null, viewports, viewportsDefault};
    if (!ui) return row('pass', evidence);
    const browser = findChrome().path;
    return browser ? row('pass', {...evidence, browser}, 'Работу браузера подтверждает отдельный прогон UI.')
      : row('fail', evidence, 'Укажи доступный Chromium и выполни отдельный тест UI.');
  });
  check('test-machine', 'Проверь маски, окружение и ресурсы мутаций на этой машине.', () => {
    const {tests} = loadTestSettings(root);
    if (!Object.keys(tests.repos).length) return row('pass', 'Параллельные проверки не настроены.');
    const dry = spawnSync(process.execPath, [join(pkg,'bin/parallel-tests.mjs'),'--dry-run'],
      {cwd:root, encoding:'utf8', windowsHide:true, timeout:60000});
    if (dry.error || dry.status !== 0) throw Error(dry.error?.message || dry.stderr.trim() || 'Ошибка подготовки прогона');
    const problems = [];
    for (const [repo, cfg] of Object.entries(tests.repos)) {
      if (!cfg.mutate) continue;
      for (const kind of ['copy','link']) for (const file of cfg.mutate[kind]) {
        const product = workspacePath(root, 'projects/' + repo);
        const stat = statSync(workspacePath(product, file), {throwIfNoEntry:false});
        const tracked = spawnSync('git',['--literal-pathspecs','ls-files','-z','--',file],
          {cwd:product,encoding:'utf8',windowsHide:true});
        if (!(kind === 'copy' ? stat?.isFile() : stat?.isDirectory()) || tracked.status !== 0 || tracked.stdout) {
          problems.push(repo + ': mutate.' + kind + ' — проверь путь и индекс Git: ' + file);
        }
      }
    }
    if (problems.length) return row('fail', problems, 'Исправь пути ресурсов мутаций в workspace.json.');
    const evidence = dry.stdout.split(/\r?\n/).filter(line => /^(WARN |MACHINE )/.test(line));
    const oversized = Number(process.env.BEERPOWERS_TEST_SLOTS || tests.slots) > availableParallelism();
    return row(oversized || evidence.some(line => line.startsWith('WARN ')) ? 'warn' : 'pass', evidence);
  });
  check('test-cache', 'Посмотри план workspace-clean cache.', () => {
    const copies = workspacePath(root,'.codex/.cache/mutants');
    const runs = workspacePath(root,'.codex/.cache/parallel-tests/runs');
    const entries = dir => statSync(dir,{throwIfNoEntry:false})?.isDirectory() ? readdirSync(dir,{withFileTypes:true}) : [];
    const {tests} = loadTestSettings(root);
    const obsolete = [];
    let size = 0;
    const pending = [];
    for (const item of entries(copies)) {
      const match = /^(.*)-s[1-9]\d*$/.exec(item.name);
      if (match && !tests.repos[match[1]]?.mutate) obsolete.push(item.name);
      pending.push(join(copies,item.name));
    }
    while (pending.length) {
      const current = pending.pop();
      const stat = lstatSync(current,{throwIfNoEntry:false});
      if (stat?.isFile()) size += stat.size;
      if (stat?.isDirectory()) for (const item of entries(current)) pending.push(join(current,item.name));
    }
    const runCount = entries(runs).filter(item => item.isDirectory()).length;
    return row(obsolete.length || size > 500 * 1024 ** 2 || runCount > 20 ? 'warn' : 'pass',
      {bytes:size, runs:runCount, obsolete});
  });
  checks.push({id:'host', ...row('unavailable', {hookTrust:null, agentDelivery:null, connectorAccess:null},
    'Сверь фактические инструменты Desktop и статус доверия. Доставку подтверждает ответ роли в текущем чате.')});
  check('role-skills', 'Сверь список навыков, доступных в текущем чате.', () => {
    const products = readdirSync(workspacePath(root, 'projects'), {withFileTypes:true})
      .filter(item => item.isDirectory() && existsSync(workspacePath(root, `projects/${item.name}/.git`)));
    const assigned = products.flatMap(({name}) => {
      const scoped = `.codex/role-settings/${name}.json`;
      const settings = config(existsSync(workspacePath(root, scoped)) ? scoped : '.codex/role-settings.json');
      return Object.entries(settings.skills ?? {}).flatMap(([role, skills]) =>
        skills.map(skill => ({product:name, role, skill})));
    });
    if (!assigned.length) return row('pass', []);
    const inventory = process.env.BEERPOWERS_SESSION_SKILLS_JSON;
    if (inventory === undefined) return row('unavailable', assigned, 'Передай фактический список навыков текущего чата.');
    const available = JSON.parse(inventory);
    if (!Array.isArray(available) || available.some(name => typeof name !== 'string')) throw Error('Expected a session skill inventory array');
    const missing = assigned.filter(({skill}) => !available.includes(skill));
    return missing.length ? row('warn', missing, 'Роли работают по базовому брифу. Проверь подключение перечисленных навыков.')
      : row('pass', assigned);
  });
  checks.push({id:'usage', ...row('unavailable', {tokens:null, cost:null},
    'Для метрик передай разрешённую выгрузку команде $beerpowers token-audit.')});
}
if (process.argv.length === 3 && process.argv[2] === 'tech-debt-index') {
  try { console.log(JSON.stringify(techDebtIndex(root, true), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
else if (process.argv.length !== 2) { console.error('Usage: node doctor.mjs [tech-debt-index]'); process.exitCode = 2; }
else {
  inspect();
  console.log(JSON.stringify({workspace:root, checks}, null, 2));
  if (checks.some(check => check.status === 'fail')) process.exitCode = 1;
}

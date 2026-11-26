// Читает и проверяет настройки тестов из .codex/workspace.json.
import fs from 'node:fs';
import path from 'node:path';
import { findRoot, workspacePath } from './ui-workspace.mjs';
export { findRoot, workspacePath };

export const PROJECTS_DIR = 'projects';
export const WORKTREES_DIR = 'worktrees';
export const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function localPath(root, value) {
  const parts = path.relative(root, path.resolve(root, value)).split(path.sep);
  if (parts.some(part => part.toLowerCase() === '.git')) throw Error('Git metadata is outside the QA scope');
  return workspacePath(root, parts.join('/'));
}

export function loadWorkspace(root) {
  const file = workspacePath(root, '.codex/workspace.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const projects = fs.readdirSync(workspacePath(root, PROJECTS_DIR), { withFileTypes: true })
    .filter(entry => entry.isDirectory());
  const problems = [];
  const tests = parseTests(config, projects, msg => problems.push({ testsFatal: true, msg }),
    msg => problems.push({ msg }));
  return { tests, problems };
}

export const TEST_MODES = ['split', 'native'];
const TEST_REPO_KEYS = ['mode', 'command', 'files', 'exclude', 'workers', 'env', 'prepare', 'mutate'];
const MUTATE_KEYS = ['command', 'check', 'link', 'copy', 'timeout'];
// Подстановки parallel-tests.mjs и mutants.mjs. Что где допустимо — по режиму: в native
// воркеров создаёт фреймворк, поэтому номера слота {i} и списка файлов {files} у тест-команды
// нет. Мутант гоняется одним процессом на слот, и {i} у него есть в любом режиме.
export const TEST_PLACEHOLDERS = ['i', 'n', 'slots', 'repo', 'dir', 'root', 'tmp', 'junit', 'files', 'filter', 'file', 'env'];
const MUTATE_DENY = { mutate: ['files', 'junit', 'file'], check: ['files', 'junit', 'filter'] };
const TEST_DENY = {
  split: { command: ['filter', 'file'], env: ['files', 'filter', 'file'], prepare: ['files', 'junit', 'filter', 'file'], ...MUTATE_DENY },
  native: { command: ['i', 'files', 'filter', 'file'], env: ['files', 'filter', 'file'], prepare: ['files', 'junit', 'filter', 'file'], ...MUTATE_DENY },
};
export const MUTATE_TIMEOUT_S = 600;
export const placeholdersOf = (s) => [...s.matchAll(/\{([a-z]+)(?::([A-Za-z_][A-Za-z0-9_]*))?\}/g)]
  .map((m) => ({ name: m[1], arg: m[2] }));

export function parseTests(json, repos, fatal, soft) {
  const empty = { slots: null, repos: {} };
  if (!('tests' in json)) return empty;
  const t = json.tests;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(t)) { fatal('tests: ждётся объект'); return empty; }
  for (const k of Object.keys(t)) if (!['slots', 'repos'].includes(k)) soft(`tests: неизвестный ключ ${k}`);
  const posInt = (x) => Number.isInteger(x) && x > 0;
  let slots = null;
  if ('slots' in t) {
    if (!posInt(t.slots)) fatal(`tests.slots: ждётся целое больше нуля, получено ${JSON.stringify(t.slots)}`);
    else slots = t.slots;
  }
  const out = Object.create(null);
  if (!('repos' in t)) { soft('tests: нет repos — parallel-tests.mjs нечего запускать'); return { slots, repos: out }; }
  if (!isObj(t.repos)) { fatal('tests.repos: ждётся объект «имя репозитория → настройки прогона»'); return { slots, repos: out }; }
  for (const [name, e] of Object.entries(t.repos)) {
    const key = `tests.repos.${name}`;
    if (!SAFE_NAME.test(name)) { fatal(`${key}: имя репозитория — [A-Za-z0-9_.-]`); continue; }
    if (!isObj(e)) { fatal(`${key}: ждётся объект`); continue; }
    if (!repos.some((r) => r.name === name)) soft(`${key}: репозитория «${name}» в ${PROJECTS_DIR}/ нет`);
    for (const k of Object.keys(e)) if (!TEST_REPO_KEYS.includes(k)) soft(`${key}: неизвестный ключ ${k}`);
    const mode = e.mode === undefined ? 'split' : e.mode;
    if (!TEST_MODES.includes(mode)) { fatal(`${key}.mode: ждётся ${TEST_MODES.join(' или ')}`); continue; }
    let ok = true;
    const bad = (msg) => { fatal(`${key}${msg}`); ok = false; };
    const text = (k, v) => {
      if (typeof v !== 'string' || v.trim() === '') { bad(`.${k}: ждётся непустая строка`); return false; }
      if (/[\r\n]/.test(v)) { bad(`.${k}: перевод строки в значении`); return false; }
      return true;
    };
    const holders = (k, v, field) => {
      for (const p of placeholdersOf(v)) {
        if (!TEST_PLACEHOLDERS.includes(p.name)) bad(`.${k}: неизвестная подстановка {${p.name}}`);
        else if (TEST_DENY[mode][field].includes(p.name)) bad(`.${k}: {${p.name}} ${field in MUTATE_DENY ? 'здесь' : `в режиме ${mode}`} не подставляется`);
        else if (p.name === 'env' && !p.arg) bad(`.${k}: {env} без имени переменной — {env:ИМЯ}`);
      }
    };
    if (!('command' in e)) bad('.command: нет команды прогона');
    else if (text('command', e.command)) {
      holders('command', e.command, 'command');
      if (mode === 'split' && !placeholdersOf(e.command).some((p) => p.name === 'files')) {
        bad('.command: в режиме split нет {files} — каждый воркер прогнал бы все тесты');
      }
    }
    const list = (k, obj = e) => {
      if (!(k in obj)) return [];
      const v = obj[k];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) { bad(`.${k}: ждётся массив путей или масок`); return []; }
      for (const x of v) {
        if (x.startsWith('/') || /^[A-Za-z]:/.test(x) || x.split('/').includes('..')) bad(`.${k}: «${x}» — маска выходит за репозиторий`);
        if (x.includes('\\')) bad(`.${k}: «${x}» — разделитель путей прямой слэш`);
      }
      return v;
    };
    const files = list('files');
    const exclude = list('exclude');
    if (mode === 'split' && files.length === 0) bad('.files: в режиме split нужна маска тестовых файлов');
    if (mode === 'native') for (const k of ['files', 'exclude']) if (k in e) soft(`${key}.${k}: в режиме native не читается — набор файлов задаёт конфиг фреймворка`);
    let workers = null;
    if ('workers' in e) {
      if (!posInt(e.workers)) bad(`.workers: ждётся целое больше нуля`);
      else workers = e.workers;
    }
    const env = {};
    if ('env' in e) {
      if (!isObj(e.env)) bad('.env: ждётся объект «переменная → значение»');
      else {
        for (const [k, v] of Object.entries(e.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { bad(`.env: «${k}» — не имя переменной`); continue; }
          if (typeof v !== 'string' || /[\r\n]/.test(v)) { bad(`.env.${k}: ждётся строка в одну строку`); continue; }
          holders(`env.${k}`, v, 'env');
          env[k] = v;
        }
      }
    }
    let prepare = null;
    if ('prepare' in e && text('prepare', e.prepare)) { holders('prepare', e.prepare, 'prepare'); prepare = e.prepare; }
    const all = [e.command, ...Object.values(env)].filter((v) => typeof v === 'string');
    if (ok && !all.some((v) => placeholdersOf(v).some((p) => p.name === 'junit'))) {
      soft(`${key}: нет {junit} ни в команде, ни в env — счёт тестов и раскладка по времени недоступны`);
    }
    // mutate — как гонять мутант в копии дерева: команда с фильтром теста, проверка файла
    // после замены, что из рабочего дерева ссылкой (зависимости), что копией (env-файлы).
    let mutate = null;
    if ('mutate' in e) {
      const m = e.mutate;
      if (!isObj(m)) bad('.mutate: ждётся объект');
      else {
        for (const k of Object.keys(m)) if (!MUTATE_KEYS.includes(k)) soft(`${key}.mutate: неизвестный ключ ${k}`);
        if (!('command' in m)) bad('.mutate.command: нет команды прогона мутанта');
        else if (text('mutate.command', m.command)) {
          holders('mutate.command', m.command, 'mutate');
          if (!placeholdersOf(m.command).some((p) => p.name === 'filter')) bad('.mutate.command: нет {filter} — мутант гонял бы весь набор');
        }
        let check = null;
        if ('check' in m && text('mutate.check', m.check)) {
          holders('mutate.check', m.check, 'check');
          if (!placeholdersOf(m.check).some((p) => p.name === 'file')) bad('.mutate.check: нет {file} — проверять нечего');
          check = m.check;
        }
        let timeout = MUTATE_TIMEOUT_S;
        if ('timeout' in m) {
          if (!posInt(m.timeout)) bad('.mutate.timeout: ждётся целое число секунд больше нуля');
          else timeout = m.timeout;
        }
        const link = list('mutate.link', { 'mutate.link': m.link ?? [] });
        const copy = list('mutate.copy', { 'mutate.copy': m.copy ?? [] });
        const owned = [...link, ...copy];
        if (owned.some(p => p.split('/').some(s => !s || s === '.' || s.toLowerCase() === '.git')
          || owned.some(other => p.startsWith(other + '/'))) || new Set(owned).size !== owned.length) {
          bad('.mutate: paths in link and copy must be distinct, non-overlapping relative paths');
        }
        for (const x of [...link, ...copy]) if (/[*?]/.test(x)) bad(`.mutate: «${x}» — путь, а не маска`);
        mutate = { command: m.command, check, link, copy, timeout };
      }
    }
    if (ok) out[name] = { mode, command: e.command, files, exclude, workers, env, prepare, mutate };
  }
  return { slots, repos: out };
}

// Разрешает подпись модели для публикаций из подтверждённого контекста сессии.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createReadStream, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const variants = {
  sol: ['Солнечный', 'погоняло Солнце', 'Солнцепёк'],
  astra: ['Астральный', 'в народе Астра', 'Астра'],
  terra: ['Земляков', 'авторитет Терра', 'Земляк'],
  luna: ['Лунный', 'Луноход', 'Лунатик'],
};
const modelId = /^(?:gpt-[a-z0-9]|o\d)[a-z0-9.-]{0,94}$/i;

async function sessionModel(env) {
  const id = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (!/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/i.test(id ?? '')) return;
  // UUIDv7 contains the session start time. Only open the matching session;
  // adjacent calendar dates cover local/UTC directory layouts.
  const start = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  const home = env.CODEX_HOME || path.join(homedir(), '.codex');
  for (const days of [0, -1, 1]) {
    const date = new Date(start + days * 86400000).toISOString().slice(0, 10);
    const dir = path.join(home, 'sessions', ...date.split('-'));
    let names;
    try { names = await readdir(dir); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const matches = names.filter(name => name.startsWith('rollout-') && name.endsWith('-' + id + '.jsonl'));
    if (matches.length > 1) throw Error('Ambiguous current Codex session metadata');
    if (!matches.length) continue;
    const input = createReadStream(path.join(dir, matches[0]), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let model;
    try {
      for await (const line of lines) {
        if (!line.includes('"turn_context"')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type === 'turn_context') model = entry.payload?.model;
      }
    } finally { lines.close(); input.destroy(); }
    return model;
  }
}

export async function authorModel(env = process.env) {
  let actual;
  try { actual = await sessionModel(env); }
  catch (error) {
    if (!env.BEERPOWERS_MODEL || !['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  }
  if (actual && env.BEERPOWERS_MODEL && actual !== env.BEERPOWERS_MODEL) {
    throw Error('BEERPOWERS_MODEL disagrees with the current Codex turn model.');
  }
  const model = actual || env.BEERPOWERS_MODEL;
  if (typeof model !== 'string' || !modelId.test(model)) {
    throw Error('Unknown author model. Set BEERPOWERS_MODEL to the actual model ID of this turn.');
  }
  return model;
}

export function modelSignature(model, style) {
  const family = model.toLowerCase().split('-').find(part => Object.hasOwn(variants, part));
  const [surname, alias, callsign] = variants[family] ?? ['Джипитов', 'в народе Кодекс', 'Кодекс'];
  const version = /^gpt-(\d+)(\.\d+)?(?:-|$)/i.exec(model);
  const agent = version ? ` ${version[1].padStart(3, '0')}${version[2] ?? ''}:` : '';
  const prefixes = [
    `Кодекс ИИльич ${surname}`,
    `Кодекс ВЗаконе, ${alias}`,
    `Агент Кодекс${agent} Позывной «${callsign}»`,
  ];
  return `© ${prefixes[style]} (${model})`;
}

export function draftStyle(key) {
  let dir = process.cwd();
  for (const part of ['.codex', '.cache', 'draft-signatures']) {
    dir = path.join(dir, part);
    try { mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!lstatSync(dir).isDirectory()) throw Error('Unsafe draft signature cache path');
  }
  const digest = createHash('sha256').update(JSON.stringify(key)).digest('hex');
  const file = path.join(dir, digest);
  if (!lstatSync(file, { throwIfNoEntry: false })) {
    const tmp = path.join(dir, randomUUID() + '.tmp');
    writeFileSync(tmp, String(randomInt(3)), { flag: 'wx' });
    try {
      // Publish a complete entry atomically. Concurrent previews read the same choice.
      try { linkSync(tmp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { unlinkSync(tmp); }
  }
  if (!lstatSync(file).isFile()) throw Error('Unsafe draft signature cache entry');
  const style = readFileSync(file, 'utf8');
  if (!/^[012]$/.test(style)) throw Error('Invalid draft signature cache entry');
  return Number(style);
}

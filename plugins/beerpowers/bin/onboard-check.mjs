// Проверяет адреса новых записей памяти. Смысл факта по источнику сверяет тимлид.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { showHelp } from './lib/cli-help.mjs';

showHelp('onboard-check.mjs onboard|product-onboard TOPIC...', ['onboard', 'product-onboard']);

function workspaceFile(path) {
  let current = '.';
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part)) {
      throw new Error(`Недопустимый путь: ${path}`);
    }
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Ссылка в пути: ${path}`);
  }
  if (!lstatSync(current).isFile()) throw new Error(`Нужен обычный файл: ${path}`);
  return current;
}

function readWorkspaceFile(path) {
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(workspaceFile(path)));
}

function sourceLineCount(path, productTrack, wholeDocument) {
  const inProduct = /^projects\/[\w.-]+\/.+/.test(path);
  const inContext = productTrack && path.startsWith('docs/product-context/');
  if (!(inProduct || inContext) || /(?:^|\/)(?:\.git|\.aws|\.ssh|\.env(?:\..*)?|secrets?)(?:\/|$)|\.(?:key|pfx|pem)$/i.test(path)) {
    throw new Error(`Источник вне области чтения: ${path}`);
  }
  if (wholeDocument) {
    workspaceFile(path);
    return null;
  }
  const content = readWorkspaceFile(path);
  if (content.includes('\0')) throw new Error(`Нужен текстовый источник: ${path}`);
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

function check(mode, topics) {
  const productTrack = mode === 'product-onboard';
  if ((!productTrack && mode !== 'onboard') || !topics.length) {
    throw new Error('node onboard-check.mjs onboard|product-onboard memory/<тема>.md [...]');
  }
  const charter = readWorkspaceFile('.codex/team-charter.md');
  if (productTrack && (!/^## PM-конвейер\s*$/m.test(charter) || !readWorkspaceFile(existsSync('.codex/agents/product-agent.md') ? '.codex/agents/product-agent.md' : '.codex/roles/product.md').trim())) {
    throw new Error('Для product-onboard включи PM-конвейер через $beerpowers setup.');
  }
  const index = readWorkspaceFile('memory/MEMORY.md');
  const links = new Set([...index.matchAll(/\]\(<?(?:\.\/)?([^()>\r\n]+?)>?(?:#[^)>\s]+)?\)/g)].map(match => match[1]));
  const allowedTopic = productTrack
    ? /^product-(?:map|actors|glossary|metrics)\.md$/
    : /^(?:project\/(?:modules\/)?|commands\/|tests\/|issues\/|tech-debt\/)[\p{L}\p{N}_.-]+\.md$/u;
  const counts = new Map();
  for (const topic of new Set(topics)) {
    const name = topic.slice('memory/'.length);
    if (!topic.startsWith('memory/') || !allowedTopic.test(name)) throw new Error(`Тема вне трека: ${topic}`);
    if (!links.has(name)) throw new Error(`memory/MEMORY.md: добавь ссылку на ${name}`);
    let facts = 0, references = 0, open = 0;
    for (const line of readWorkspaceFile(topic).split(/\r?\n/)) {
      if (/^- (?:Гипотеза|Вопрос):\s+\S/.test(line)) open++;
      if (!line.startsWith('- Факт:')) continue;
      const evidence = [...line.matchAll(/`([^`\r\n]+?):([1-9]\d*)`/g)].map(([,path,number])=>({path,number}));
      if (productTrack) {
        for (const [,path] of line.matchAll(/`(docs\/product-context\/[^:`\r\n]+)`/g)) evidence.push({path});
      }
      if (!evidence.length) throw new Error(`${topic}: нужен источник в форме \`путь:строка\` или предоставленный продуктовый документ`);
      facts++;
      for (const {path,number} of evidence) {
        if (number === undefined) sourceLineCount(path,productTrack,true);
        else {
          if (!counts.has(path)) counts.set(path, sourceLineCount(path,productTrack,false));
          if (Number(number) > counts.get(path)) throw new Error(`${path}: нет строки ${number}`);
        }
        references++;
      }
    }
    if (facts + open === 0) throw new Error(`${topic}: нет записей «Факт», «Гипотеза» или «Вопрос»`);
    console.log(`${topic}: facts=${facts} references=${references} open=${open}`);
  }
}

try {
  check(process.argv[2], process.argv.slice(3));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

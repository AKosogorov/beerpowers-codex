import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePath } from './ui-workspace.mjs';

export const referenceNamespace = 'beerpowers:reference';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

// Формат ссылок, который печатает и проверяет пакет: [текст](путь "beerpowers:reference/имя.md#раздел").
// Каталог и документы открываются только при следующем Read выбранного адреса.
const markedLink = /(?<![!\\])(?<label>\[(?:\\.|[^\[\]\\\r\n]|\[[^\]\r\n]*\])*\])\((?:<[^>\r\n]+>|(?:\\.|[^\s()\\]|\([^()\r\n]*\))+)[ \t]+"(?<address>beerpowers:reference\/[^"\r\n]+)"[ \t]*\)/u;
const fullLink = new RegExp('^' + markedLink.source + '$', 'u');
const agentLink = /^\[[^\r\n]*\]\((beerpowers:reference\/[^"\r\n()]+)\)$/u;
// Литеральные блоки и фрагменты поглощаются раньше ссылок, вложенных в их текст.
const markdownTokens = new RegExp([
  /^ {0,3}(?<fence>(?<marker>[\x60~])\k<marker>{2,})[^\r\n]*\r?\n[\s\S]*?(?:^ {0,3}\k<fence>\k<marker>*[ \t]*(?=\r?$)|(?![\s\S]))/.source,
  /^ {4}[^\r\n]*|^\t[^\r\n]*|<!--[\s\S]*?(?:-->|(?![\s\S]))/.source,
  /(?<ticks>\x60+)(?!\x60)[\s\S]*?(?<!\x60)\k<ticks>(?!\x60)/.source,
  markedLink.source,
].join('|'), 'gmu');

export function selectedReference(target) {
  if (!target.startsWith('[')) return target;
  // Windows PowerShell 5 удаляет внутренние двойные кавычки при передаче аргумента в node.exe.
  const argument = target.replace(/([ \t]+)(beerpowers:reference\/[^"\r\n]+)\)$/, '$1"$2")');
  const annotated = fullLink.exec(argument);
  return annotated ? annotated.groups.address : agentLink.exec(target)?.[1] ?? target;
}

export function agentMarkdown(text) {
  if (!text.includes('"' + referenceNamespace + '/')) return text;
  return text.replace(markdownTokens, (token, ...captures) => {
    const {label, address} = captures.at(-1);
    return address ? label + '(' + address + ')' : token;
  });
}

// Имена и пути берутся из установленного пакета. Ссылки в каталог не входят.
export function referenceFiles() {
  const files = new Map();
  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, {withFileTypes:true})) {
      if (entry.name.startsWith('.')) continue;
      const label = prefix + '/' + entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, label);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.set(label, path);
    }
  }
  visit(workspacePath(packageRoot, 'reference'), referenceNamespace);
  return files;
}

export function referenceFile(label, optional = false) {
  const [address] = label.split('#', 1);
  const [namespace, ...parts] = address.split('/');
  if (namespace === referenceNamespace && parts.at(-1)?.endsWith('.md')) {
    let directory = workspacePath(packageRoot, 'reference');
    for (const [index, part] of parts.entries()) {
      if (!part || part.startsWith('.')) break;
      const entry = readdirSync(directory, {withFileTypes:true}).find(item => item.name === part);
      if (!entry) break;
      const path = join(directory, part);
      if (index === parts.length - 1 && entry.isFile()) return path;
      if (!entry.isDirectory()) break;
      directory = path;
    }
  }
  if (!optional) throw Error('Справочник отсутствует в установленном пакете: ' + label);
}

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePath } from './ui-workspace.mjs';

export const referenceNamespace = 'beerpowers:reference';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

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
  const path = referenceFiles().get(label);
  if (!path && !optional) throw Error('Справочник отсутствует в установленном пакете: ' + label);
  return path;
}

// Распознаёт вложенные Git-репозитории и проверяет имена старых задач при уборке workspace.
// Общие правила отбора путей для уборки workspace и проверки каталогов задач.
import fs from 'node:fs';
import path from 'node:path';

export const cleanupName = value => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) &&
  !value.includes('..') && !value.endsWith('.') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value);
export const cleanupTaskCode = value => value.length <= 200 && value.split('/').every(cleanupName);
export const hasBareGitLayout = names => ['HEAD', 'config', 'objects', 'refs'].every(name => names.includes(name));

// A Git worktree can own one regular .git file at its root. A second .git
// or the administrative layout of a bare repository protects the whole tree.
export function cleanupInventory(abs, rel, { gitFile = false, links = false } = {}) {
  const pending = [abs];
  let files = 0;
  while (pending.length) {
    const dir = pending.pop();
    if (!fs.lstatSync(dir).isDirectory()) throw Error(`каталог изменился во время проверки: ${rel}`);
    const names = fs.readdirSync(dir);
    if (hasBareGitLayout(names)) {
      throw Error(`вложенный Git-репозиторий в ${rel} (${path.relative(abs, dir) || '.'})`);
    }
    for (const name of names) {
      const child = path.join(dir, name);
      const stat = fs.lstatSync(child);
      if (name.toLowerCase() === '.git' && !(gitFile && dir === abs && stat.isFile())) {
        throw Error(`вложенный Git-репозиторий в ${rel} (${path.relative(abs, child)})`);
      }
      if (stat.isSymbolicLink() && !links) throw Error(`ссылка или junction в ${rel} (${path.relative(abs, child)})`);
      if (stat.isDirectory()) pending.push(child);
      else files++;
    }
  }
  return files;
}

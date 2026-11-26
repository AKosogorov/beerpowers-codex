// Проверяет имена вложений и вычисляет SHA-256 для снимка трекера.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function filename(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || name === '.' || name === '..' ||
      /[<>:"/\\|?*\x00-\x1f]|[ .]$/.test(name) || /^(con|aux|prn|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))
    throw new Error('Unsafe attachment filename');
  return name;
}

export async function fingerprints(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Expected attachment directory');
  for (const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name < b.name ? -1 : 1)) {
    filename(item.name);
    if (!item.isFile()) throw new Error('Expected a regular attachment');
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(dir,item.name))) digest.update(chunk);
    files.push([item.name,digest.digest('hex')]);
  }
  return files;
}

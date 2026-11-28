// Переносит только именованные секции общей памяти. Файлы и текст вне них принадлежат проекту.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { blocks, digest, engineBody, restoreBoundaries } from './markdown-engine.mjs';
import { workspacePath } from './ui-workspace.mjs';

// Число строк и SHA-256 целого тела (LF): опубликованный Claude и его перенос на 0.12.0.
// Ни заголовок раздела, ни соседний проектный абзац в поисковый диапазон не входят.
const history = {
  'memory-intro': [[10, '05ae65c7df2eefe87be669160ef39248222d498e752e3153840d282e3dd541a6'],
    [10, '8bf2805fb2a7244a89350f312ecaff73126546672465c230c377b757d6f30c5d']],
  'memory-layout': [[94, '899ddfa548e2fb8d8fc99bd981d38c87446e89a507ca7c08499a4eb5374bd1d1'],
    [94, '9c42d03fc1548f7c2a61d9a5a8a7e7a64cd8a8c3691e3918a4df5e5e2dc0d1ab'],
    [77, '3569d70e76ea5db96dfeb7663da24a7a39d0be12af7f83ee381e71f6457b7627'],
    [77, '914a0b3b2d1bc52bcc070d5278aaad0613d49d6ae86c72277d2787388e92d0f0']],
  'never-generic': [[22, 'ee14e8bed9f06409160ce3a72520157303dd0c3030675bfc2597ad8cfc63931c'],
    [22, '96cdd552eff1ab68c2c23faa1f42d6ca41491c0904e62270d2a2e8d2e4d1872a']],
  'confirm-generic': [[19, '3304222dd3d647afb7b45207c2c523a976e3e432ccf41b10c65e7a1d25b82c40']],
};

export function refreshMemory(text, template, path, previous, check = false) {
  const canonical = blocks(template.replaceAll('\r\n', '\n'), path);
  const prior = blocks((previous ?? '').replaceAll('\r\n', '\n'), path);
  const repaired = restoreBoundaries(text, path, canonical, prior, history);
  if (check && repaired !== text) throw Error('Утрачены границы beerpowers:engine в ' + path);
  // Содержимое этих секций прежних выпусков обновляет update.mjs.
  canonical.delete('entry');
  canonical.delete('codex-memory');
  const found = blocks(repaired, path);
  const safety = ['never-generic', 'confirm-generic'];
  if (canonical.has(safety[0]) && safety.some(name => found.has(name)) && !safety.every(name => found.has(name))) {
    throw Error('Неполные границы ' + path + ': ' + safety.filter(name => !found.has(name)).join(', '));
  }
  if (check) return text;
  text = repaired;
  for (const old of [...found.values()].reverse()) {
    const next = canonical.get(old.name);
    if (!next) continue;
    const content = old.text.replaceAll('\r\n', '\n');
    if (content === next.text) continue;
    if (content !== prior.get(old.name)?.text && !history[old.name]?.some(([, hash]) => digest(engineBody(old)) === hash)) {
      throw Error('Conflict ' + path + ' [' + old.name + ']: изменён управляемый блок');
    }
    const nl = old.text.includes('\r\n') ? '\r\n' : '\n';
    text = text.slice(0, old.start) + next.text.replaceAll('\n', nl) + text.slice(old.end);
  }
  if (found.has('codex-memory') && found.has('memory-layout') && !found.has('memory-intro')) {
    const offset = blocks(text, path).get('codex-memory').start;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    text = text.slice(0, offset) + canonical.get('memory-intro').text.replaceAll('\n', nl) + nl + nl + text.slice(offset);
  }
  if (found.has('memory-layout')) {
    // Комментарий завершает Markdown-таблицу. Следующие проектные строки
    // получают собственную шапку и остаются снаружи управляемой секции.
    const end = blocks(text, path).get('memory-layout').end;
    const rows = /^(\r?\n)(\|[^\r\n]+\|)(?:\r?\n([^\r\n]*))?/.exec(text.slice(end));
    if (rows && !/^\|(?:\s*:?-+:?\s*\|)+$/.test(rows[3] ?? '')) {
      const nl = rows[1];
      text = text.slice(0, end) + nl + nl + '| Маркер | Владелец |' + nl + '|---|---|' + text.slice(end);
    }
  }
  return text;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { documents, check, previous } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const changes = {};
  for (const [path, text] of Object.entries(documents)) {
    const resource = path.replace(/^\.codex\/agents\//, 'roles/').replace(/^\.codex\/team-/, 'charter/team-');
    const template = readFileSync(new URL('../../templates/' + resource, import.meta.url), 'utf8');
    if (check && resource !== path) {
      if (restoreBoundaries(text, path, blocks(template, resource)) !== text) throw Error('Утрачены границы beerpowers:engine в ' + path);
      continue;
    }
    const old = previous && workspacePath(previous, 'templates/' + resource);
    const updated = refreshMemory(text, template, path, old && existsSync(old) ? readFileSync(old, 'utf8') : null, check);
    if (text !== updated) changes[path] = updated;
  }
  process.stdout.write(JSON.stringify(changes));
}

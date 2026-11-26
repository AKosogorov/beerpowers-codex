// Выводит заготовку памяти проекта с подстановкой имени и пустыми секциями для проектных фактов.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workspacePath } from './lib/ui-workspace.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('memory-template.mjs RELATIVE_TEMPLATE.md PROJECT');

// Render one package resource to stdout. The calling command decides which project records to add.
try {
  const [relative, project, ...extra] = process.argv.slice(2);
  if (extra.length || !/^(?:[a-z-]+\/)*[a-zA-Z-]+\.md$/.test(relative ?? '') ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(project ?? '')) {
    throw Error('Usage: node memory-template.mjs <relative-template.md> <project-name>');
  }
  const root = fileURLToPath(new URL('../templates/memory/', import.meta.url));
  const body = readFileSync(workspacePath(root, relative), 'utf8').replaceAll('{{PROJECT}}', project)
    .replace(/^\{\{(?:PROJECT_MAP|INVARIANTS_DETAILED|NEVER_CODE|CONFIRM_EXTRA|BREAKPOINTS|COMMANDS_INDEX|OWNERS_EXTRA)\}\}\r?\n/gm, '');
  if (/\{\{|\}\}/.test(body)) throw Error('Unresolved template field in ' + relative);
  process.stdout.write(body);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

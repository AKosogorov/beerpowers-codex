// Явно пересобирает индекс технического долга из корня workspace.
import { realpathSync } from 'node:fs';
import { showHelp } from './lib/cli-help.mjs';
import { techDebtIndex } from './lib/tech-debt-index.mjs';

export function refreshTechDebtIndex(root) {
  try {
    console.log(JSON.stringify(techDebtIndex(root, true), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  showHelp('tech-debt-index.mjs');
  if (process.argv.length === 2) refreshTechDebtIndex(realpathSync.native('.'));
  else {
    console.error('Usage: node tech-debt-index.mjs');
    process.exitCode = 2;
  }
}

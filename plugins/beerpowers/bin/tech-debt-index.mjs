// Явно пересобирает индекс технического долга из корня workspace.
import { realpathSync } from 'node:fs';
import { showHelp } from './lib/cli-help.mjs';
import { techDebtIndex } from './lib/tech-debt-index.mjs';

showHelp('tech-debt-index.mjs');
if (process.argv.length !== 2) {
  console.error('Usage: node tech-debt-index.mjs');
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(techDebtIndex(realpathSync.native('.'), true), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

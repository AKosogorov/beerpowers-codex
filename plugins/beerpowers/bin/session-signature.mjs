// Читает и сохраняет подтверждённую модель текущей сессии для подписей.
import { authorModel, draftStyle, modelSignature } from './lib/model-signature.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('session-signature.mjs TASK PURPOSE');

try {
  const [task, purpose] = process.argv.slice(2);
  if (!task || !purpose) throw Error('Укажи код задачи и назначение подписи');
  const model = await authorModel();
  console.log(modelSignature(model, draftStyle(['git', model, task, purpose])));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

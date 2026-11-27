// Проверяет checkout задачи и восстанавливает его по сохранённой записи.
import { branchName, discover, fail, git, remoteState, safe } from './lib/git-repositories.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('restore-checkout.mjs REPO TASK');

function restore(name, task) {
  branchName(task, true);
  const repo = discover().find(r => r.name === name);
  if (!repo) fail('Неизвестный проект');
  const cwd = safe(repo.path);
  const { defaultBranch, heads } = remoteState(repo);
  const previous = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (previous !== task && previous !== defaultBranch) fail('Основной checkout занят другой задачей');
  if (git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])) fail('Сохрани изменения владельца checkout');
  const expected = heads.get(defaultBranch);
  git(cwd, ['fetch', '--no-tags', 'origin', 'refs/heads/' + defaultBranch]);
  if (git(cwd, ['rev-parse', 'FETCH_HEAD']) !== expected) fail('Ветка origin изменилась');
  const local = git(cwd, ['rev-parse', '--verify', 'refs/heads/' + defaultBranch], true);
  if (local && git(cwd, ['merge-base', '--is-ancestor', local, expected], true) === null) fail('Локальная ветка разошлась с origin');
  if (previous !== defaultBranch) {
    // Protect ignored files which checkout would otherwise overwrite without warning.
    git(cwd, ['checkout', '--no-overwrite-ignore', ...(local ? [defaultBranch] : ['-b', defaultBranch, expected])]);
  }
  git(cwd, ['merge', '--no-overwrite-ignore', '--ff-only', expected]);
  return { checkout: repo.path, defaultBranch, head: git(cwd, ['rev-parse', 'HEAD']) };
}

try {
  console.log(JSON.stringify(restore(...process.argv.slice(2))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

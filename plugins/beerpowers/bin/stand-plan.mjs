// Собирает план выкладки задачи на стенд с проверкой веток и ревизий.
import fs from 'node:fs';
import { branchName, discover, fail, git, readJson, remoteState, safe } from './lib/git-repositories.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('stand-plan.mjs REPO STAND BASE OLD_SHA BASE_SHA');

function plan(name, stand, base, old, baseSha) {
  branchName(stand);
  branchName(base);
  if (stand.includes('/') || ![old, baseSha].every(s => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s))) {
    fail('Ожидаются имя стенда без слеша и два исходных SHA');
  }
  const repo = discover().find(r => r.name === name);
  if (!repo) fail('Проект не найден');
  const state = remoteState(repo);
  if ([base, state.defaultBranch, 'master', 'main'].includes(stand)) fail('Защищённая ветка');
  const cwd = safe(repo.path);
  const tree = safe('worktrees/chore-' + stand + '-rebuild/' + name);
  const common = dir => git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common(cwd) !== common(tree) || git(tree, ['rev-parse', '--show-prefix'])) fail('Чужое дерево пересборки');
  if (git(tree, ['status', '--porcelain', '--untracked-files=all'])) fail('В дереве есть незавершённые изменения');
  // A paused rebase can have a clean index after a conflict was resolved.
  for (const ref of ['rebase-merge', 'rebase-apply', 'sequencer', 'CHERRY_PICK_HEAD', 'MERGE_HEAD']) {
    if (fs.existsSync(git(tree, ['rev-parse', '--path-format=absolute', '--git-path', ref]))) fail('Сначала заверши операцию Git');
  }
  const head = git(tree, ['rev-parse', 'HEAD']);
  if (state.heads.get(base) !== baseSha) fail('База стенда изменилась');
  if (![old, head].includes(state.heads.get(stand))) fail('Стенд обновлён другой сессией');
  git(tree, ['merge-base', '--is-ancestor', baseSha, head]);
  const subjects = tip => git(tree, ['log', '--format=%s', baseSha + '..' + tip]);
  const codes = tip => [...new Set(subjects(tip).match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [])].sort();
  const oldTasks = codes(old), newTasks = codes(head);
  const lost = git(tree, ['log', '--cherry-pick', '--right-only', '--format=%H %s', head + '...' + old]).split('\n').filter(Boolean);
  const alreadyPublished = state.heads.get(stand) === head;
  const archive = readJson('.codex/git-settings.json', {}).standArchive ?? false;
  if (typeof archive !== 'boolean') fail('Некорректное значение standArchive');
  // The old OID keeps a retry across midnight idempotent.
  const archiveRef = 'archive/' + stand + '-' + git(tree, ['show', '-s', '--format=%cs', old]) + '-' + old.slice(0, 12);
  if (archive && state.heads.has(archiveRef) && state.heads.get(archiveRef) !== old) fail('Имя архива занято');
  const pushArgs = ['push'];
  if (git(tree, ['merge-base', '--is-ancestor', old, head], true) === null) {
    pushArgs.push('--force-with-lease=refs/heads/' + stand + ':' + old);
  }
  pushArgs.push('origin', head + ':refs/heads/' + stand);
  return { old, baseSha, head, oldTasks, newTasks, missingTasks: oldTasks.filter(s => !newTasks.includes(s)), lost,
    alreadyPublished, archiveArgs: archive && head !== old && !state.heads.has(archiveRef)
      ? ['push', 'origin', old + ':refs/heads/' + archiveRef] : null,
    pushArgs: alreadyPublished ? null : pushArgs };
}

try {
  console.log(JSON.stringify(plan(...process.argv.slice(2)), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

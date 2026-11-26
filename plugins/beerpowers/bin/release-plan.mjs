// Строит dry-run плана выпуска по целевым веткам и ревизиям. Проверяет, что исходные ветки актуальны и выбранный способ выпуска разрешён профилем продукта.
// Строит план выпуска по проектному Git-профилю и проверенным ревизиям.
import fs from 'node:fs';
import { branchName, discover, fail, git, profileDetails, remoteState, safe } from './lib/git-repositories.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('release-plan.mjs REPO planned [RELEASE_BRANCH] | REPO urgent TASK SHA');

function release(name, mode, task, selection) {
  const repo = discover().find(r => r.name === name);
  if (!repo) fail('Неизвестный продукт');
  const state = remoteState(repo);
  const { defaultBranch, release: production } = profileDetails(repo, state);
  const result = { profile: repo.profile, defaultBranch };
  if (repo.profile === 'custom') {
    const lines = fs.readFileSync(safe('memory/commands/git.md'), 'utf8').split(/\r?\n/);
    const start = lines.findIndex(line => /^##\s+/.test(line) && line.replace(/^##\s+/, '').replaceAll('`', '').trim() === name);
    if (start < 0) fail('Нет раздела продукта в memory/commands/git.md');
    const next = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
    const instructions = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
    if (!instructions) fail('Пустой раздел проекта');
    return { ...result, instructions };
  }
  if (repo.profile === 'dev-default') {
    const targetSha = state.heads.get(production);
    if (mode === 'planned') return { ...result, source: defaultBranch, sourceSha: state.heads.get(defaultBranch),
      target: production, targetSha, merge: 'merge-commit' };
    if (mode !== 'urgent') fail('Ожидается planned или urgent');
    branchName(task, true);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(selection ?? '')) fail('Нужен коммит задачи в dev');
    const cwd = safe(repo.path);
    git(cwd, ['merge-base', '--is-ancestor', selection, state.heads.get(defaultBranch)]);
    if (!git(cwd, ['show', '-s', '--format=%s', selection]).includes('(' + task + '):')) fail('Проверь код задачи в коммите');
    return { ...result, source: task + '-release', existingSourceSha: state.heads.get(task + '-release'),
      target: production, targetSha, cherryPick: ['cherry-pick', '-x', selection] };
  }
  if (mode !== 'planned') fail('Для main-default ожидается planned');
  const source = branchName(task);
  if (source === defaultBranch || !state.heads.has(source)) fail('Нужна существующая ветка задачи или релиза на origin');
  const cwd = safe(repo.path);
  const targetSha = state.heads.get(defaultBranch), sourceSha = state.heads.get(source);
  git(cwd, ['merge-base', '--is-ancestor', targetSha, sourceSha]);
  return { ...result, source, sourceSha, target: defaultBranch, targetSha, merge: 'fast-forward' };
}

try {
  console.log(JSON.stringify(release(...process.argv.slice(2)), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

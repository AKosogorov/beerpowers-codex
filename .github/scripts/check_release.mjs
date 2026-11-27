#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = 'plugins/beerpowers';
const manifest = `${pkg}/.codex-plugin/plugin.json`;
const git = (...args) => execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

function checkRelease(reference) {
  if (!reference) throw new Error('Укажите базу: node .github/scripts/check_release.mjs <коммит>');
  const base = git('rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`).trim();
  const changed = git('diff', '--name-only', base, '--', pkg);
  const added = git('ls-files', '--others', '--exclude-standard', '--', pkg);
  if (!changed && !added) return;

  const previous = JSON.parse(git('show', `${base}:${manifest}`)).version;
  const {version} = JSON.parse(readFileSync(manifest, 'utf8'));
  if (typeof version !== 'string' || version.localeCompare(previous, 'en', {numeric: true}) <= 0) {
    throw new Error(`Повысьте версию в ${manifest} относительно ${previous} и добавьте раздел новой версии в CHANGELOG.md.`);
  }

  const notes = fileURLToPath(new URL('./release_notes.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [notes, version], {stdio: ['ignore', 'ignore', 'inherit']});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = 1;
}

try {
  checkRelease(process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

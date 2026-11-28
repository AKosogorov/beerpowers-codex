#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { blocks } from '../../plugins/beerpowers/bin/lib/markdown-engine.mjs';

const pkg = 'plugins/beerpowers';
const registry = `${pkg}/reference/migrations.md`;
const managedSources = new Map([
  ['AGENTS.md', 'entry'],
  ['charter/team-charter.md', 'codex-team'],
  ['charter/team-lead.md', 'codex-lead'],
  ['memory/MEMORY.md', 'codex-memory'],
]);
const managedBlocks = [...managedSources.values()];
const memorySources = new Map([
  ['memory/MEMORY.md', ['memory-intro', 'memory-layout']],
  ['memory/project/safety-rules.md', ['never-generic', 'confirm-generic']],
  ['memory/issues/known-issues.md', ['issues-rules']],
  ['memory/project/glossary.md', ['glossary-rules']],
]);
const git = (...args) => execFileSync('git', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024
});
const normalized = text => text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');

function file(path) {
  const info = lstatSync(path, {throwIfNoEntry: false});
  if (!info) return null;
  if (!info.isFile()) throw new Error(`Ожидался обычный файл: ${path}`);
  return normalized(readFileSync(path, 'utf8'));
}

export function validateEngineTemplates() {
  const migration = file(registry);
  for (const template of new Set([...managedSources.keys(), ...memorySources.keys()])) {
    const path = pkg + '/templates/' + template;
    const sections = blocks(file(path), path);
    const required = [managedSources.get(template), ...(memorySources.get(template) ?? [])].filter(Boolean);
    for (const name of required) assert.ok(sections.has(name), path + ': missing engine block ' + name);
    for (const [id, section] of sections) {
      assert.doesNotMatch(section.text, /\{\{[A-Z_]+\}\}/, path);
      assert.ok(migration.split('\n').some(line => line.includes('`' + id + '`') &&
        line.includes('../templates/' + template)), path + ': missing registry mapping ' + id);
    }
  }
  for (const version of ['0.2.0', 'schemaVersion']) assert.ok(migration.includes(version), version);
}

// Compare only generation sections in files that also implement CLI routing or diagnostics.
const generators = {
  'bin/memory-template.mjs': [
    [/const root = [\s\S]*?process\.stdout\.write\(body\);/, ['codex-memory']]
  ],
  'bin/update.mjs': [
    [/const rules = \[[\s\S]*?\n\];/, managedBlocks],
    [/function\* markupLines\([\s\S]*?(?=\nfunction plan\()/, managedBlocks]
  ],
  'bin/lib/update-setup.mjs': [
    [/export function setupAdditions\([\s\S]*/, []]
  ],
  'bin/lib/markdown-engine.mjs': [[/[\s\S]+/, managedBlocks]],
  'bin/lib/charter.mjs': [[/[\s\S]+/, ['codex-team', 'codex-lead']]],
  'bin/lib/role-setup.mjs': [[/[\s\S]+/, []]],
  'bin/lib/memory-links-migration.pl': [[/[\s\S]+/, []]],
  'bin/lib/memory-engine.mjs': [[/[\s\S]+/, [...memorySources.values()].flat()]],
  'bin/role-packet.pl': [
    [/^sub stage_six_setup \{[\s\S]*?(?=^sub role_packet \{)/m, []]
  ],
  'bin/workspace.pl': [
    [/^sub seed \{[\s\S]*?^\}/m, ['codex-team', 'codex-lead', 'codex-memory']],
    [/^sub engine_template \{[\s\S]*?(?=^my \$label = )/m, managedBlocks],
    [/^for my \$name \(qw\(team-charter[\s\S]*?(?=^my %workspace_defaults = )/m, ['codex-team', 'codex-lead']],
    [/^my %workspace_defaults = [\s\S]*?(?=^my \$index = )/m, []],
    [/^my \$index = [\s\S]*?(?=^sub append_lines \{)/m, []],
    [/^\s*if \(\$relative eq 'MEMORY\.md'\) \{[\s\S]*?^        \}/m, ['codex-memory']],
    [/^\} elsif \(!\$shared_memory && \$current_setup\) \{[\s\S]*?^\}/m, ['codex-memory']],
    [/^my \$begin = '<!-- beerpowers:engine entry -->';[\s\S]*?(?=^my \$role_begin = )/m, ['entry']]
  ]
};

function releaseEntry(text, version) {
  const sections = (text ?? '').split(/^## /m).slice(1);
  const entries = sections.map(section => section.split('\n')).filter(([title]) => title.trim() === version);
  if (entries.length > 1) throw new Error(`Дублируется раздел миграции ${version}`);
  return entries[0]?.slice(1).join('\n').trim() ?? '';
}

function checkMigrations(reference) {
  let base;
  try { base = git('rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`).trim(); }
  catch { throw new Error(`Git-база «${reference}» недоступна как коммит. Укажите доступную ревизию или загрузите её историю.`); }
  const relativePaths = ['templates', ...Object.keys(generators)].map(path => `${pkg}/${path}`);
  const names = new Set([
    ...git('diff', '--no-renames', '--name-only', '-z', base, '--', ...relativePaths).split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z', '--', ...relativePaths).split('\0')
  ].filter(Boolean));
  const tree = new Set(git('ls-tree', '-r', '--name-only', '-z', base, '--', registry, ...relativePaths).split('\0'));
  const previous = path => tree.has(path) ? normalized(git('show', `${base}:${path}`)) : null;
  const triggers = [];
  const affectedBlocks = new Set();
  for (const path of [...names].sort()) {
    const before = previous(path), after = file(path);
    if (before === after) continue;
    if (path.startsWith(pkg + '/templates/')) {
      const template = path.slice((pkg + '/templates/').length);
      if (managedSources.has(template) || memorySources.has(template)) {
        const oldBlocks = blocks(before ?? '', path), newBlocks = blocks(after ?? '', path);
        const changed = [...new Set([...oldBlocks.keys(), ...newBlocks.keys()])]
          .filter(id => oldBlocks.get(id)?.text !== newBlocks.get(id)?.text);
        if (!changed.length && before !== null && after !== null) continue;
        for (const id of changed) affectedBlocks.add(id);
      }
    } else {
      const changed = generators[path.slice(pkg.length + 1)].filter(([section]) =>
        section.exec(before ?? '')?.[0] !== section.exec(after ?? '')?.[0]);
      if (!changed.length) continue;
      for (const [, affected] of changed) for (const block of affected) affectedBlocks.add(block);
    }
    triggers.push(path);
  }
  validateEngineTemplates();
  if (!triggers.length) {
    console.log(`Управляемые шаблоны и генерация совпадают с базой ${base}.`);
    return;
  }
  const {version} = JSON.parse(file(`${pkg}/.codex-plugin/plugin.json`));
  const entry = releaseEntry(file(registry), version);
  const problems = [];
  if (!entry || entry === releaseEntry(previous(registry), version)) {
    problems.push(`Добавьте или обновите запись «## ${version}» в ${registry}.`);
  }
  for (const name of [...affectedBlocks].sort()) {
    if (!entry.includes('`' + name + '`')) problems.push('Укажите изменённый блок `' + name + '` в записи.');
  }
  if (problems.length) throw new Error([...triggers, ...problems].join('\n'));
  console.log(`Миграция ${version} описывает изменения относительно базы ${base}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const {values} = parseArgs({options: {base: {type: 'string'}, help: {type: 'boolean'}}});
    const usage = 'node .github/scripts/check_migrations.mjs --base <commit>';
    if (values.help) console.log(usage);
    else if (!values.base?.trim()) throw new Error(`Укажите Git-базу: ${usage}`);
    else checkMigrations(values.base);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Local package layout and workspace upgrade. Desktop's installer and hook trust are outside this test.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(repository, 'tests', 'fixtures', 'catalog');
const manifestPath = '.codex-plugin/plugin.json';
const load = path => JSON.parse(readFileSync(path, 'utf8'));
function perlPath() {
  if (process.env.BEERPOWERS_PERL) return process.env.BEERPOWERS_PERL;
  if (process.platform !== 'win32') return 'perl';
  const gitPaths = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const file of gitPaths) {
    const perl = resolve(dirname(file), '../usr/bin/perl.exe');
    if (existsSync(perl)) return perl;
  }
  throw Error('Set BEERPOWERS_PERL to a Perl executable or install Git for Windows');
}
function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

test('local marketplace package from a temporary versioned cache (Desktop installer excluded)', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'beerpowers install '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const catalog = load(join(repository, '.agents/plugins/marketplace.json'));
  assert.equal(catalog.name, 'akosogorov-codex');
  const entries = catalog.plugins.filter(entry => entry.name === 'beerpowers-codex');
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.source.source, 'local');
  const source = resolve(repository, entry.source.path);
  assert.equal(source, join(repository, 'plugins', 'beerpowers'));
  const manifest = load(join(source, manifestPath));
  assert.equal(manifest.name, entry.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const installed = join(temp, 'plugins/cache', catalog.name, entry.name, manifest.version);
  cpSync(source, installed, { recursive: true });
  const copy = load(join(installed, manifestPath));
  assert.deepEqual(copy, manifest);
  assert.deepEqual(copy.upstream, { name: 'beerpowers', version: '2.20.0', commit: '7c5bb1221d65b5c46c8af96fe7bc4ce979fc596e' });
  assert.deepEqual(readdirSync(join(installed, copy.skills), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
    ['beerpowers', 'brainstorm', 'debug-loop', 'economy', 'grill', 'minimal-diff', 'page-screenshot', 'prototype', 'summarizing-mr-links', 'tracker-task']);
  assert.match(readFileSync(join(installed, copy.skills, 'beerpowers/SKILL.md'), 'utf8'), /^name: beerpowers\r?$/m);

  const perl = perlPath();
  const env = {
    ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH, BEERPOWERS_PERL: perl,
    GIT_CONFIG_GLOBAL: join(temp, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: temp,
    GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(temp, 'unused-hooks'),
    GIT_AUTHOR_NAME: 'Catalog fixture', GIT_COMMITTER_NAME: 'Catalog fixture',
    GIT_AUTHOR_EMAIL: 'catalog@example.invalid', GIT_COMMITTER_EMAIL: 'catalog@example.invalid',
    BEERPOWERS_TASK_JSON: '{}',
  };
  const run = (cwd, command, args, extra = {}) => execFileSync(command, args, {
    cwd, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true,
  });
  const git = (cwd, ...args) => run(cwd, 'git', args).trimEnd();
  const handler = join(installed, 'bin/workspace.pl');
  const update = (cwd, ...args) => JSON.parse(run(cwd, process.execPath, [join(installed, 'bin/update.mjs'), ...args]));
  const read = (cwd, path) => readFileSync(join(cwd, path), 'utf8');

  await t.test('command routing in the installed package requires a literal invocation', () => {
    const route = prompt => JSON.parse(run(installed, perl, [join(installed, 'bin/command-route.pl'), prompt]));
    for (const prompt of ['Проверь диагностику проекта', 'doctor', 'Документируй `$beerpowers setup`', '```\n$beerpowers setup\n```',
      '[$beerpowers](https://example.invalid/skill) setup']) {
      assert.deepEqual(route(prompt), { status: 'ignored' }, prompt);
    }
    const names = ['decision-brief', 'doctor', 'feature', 'onboard', 'product-onboard', 'retro', 'setup', 'task-start',
      'team-down', 'team-lazy', 'team-up', 'tech-debt-index', 'token-audit', 'tracker', 'update', 'worktrees-clear'];
    for (const name of names) {
      assert.deepEqual(route('$beerpowers ' + name), { status: 'route', path: `commands/${name}.md`, tail: '' });
    }
    assert.deepEqual(route('[$beerpowers](skill://beerpowers) setup'), { status: 'route', path: 'commands/setup.md', tail: '' });
    assert.deepEqual(route('  $beerpowers task-start  --preview  пример\nвторая строка'), {
      status: 'route', path: 'commands/task-start.md', tail: '  --preview  пример\nвторая строка',
    });
    for (const name of ['', 'unknown', 'publication', 'integrations', 'product-git', 'feature-implementation', '../reference/publication', 'setup.md']) {
      assert.deepEqual(route('$beerpowers ' + name), { status: 'help', commands: names }, name);
    }
  });

  function makeWorkspace(name) {
    const root = join(temp, 'workspace ' + name);
    const product = join(root, 'projects/catalog');
    cpSync(join(fixture, 'frontend'), product, { recursive: true });
    cpSync(join(fixture, 'backend'), join(product, 'api'), { recursive: true });
    git(root, 'init', '-qb', 'main');
    git(product, 'init', '-qb', 'main');
    git(product, 'add', '.');
    git(product, 'commit', '-qm', 'Seed catalog product');
    const origin = join(temp, name + '.git');
    git(product, 'clone', '--quiet', '--bare', '.', origin);
    git(product, 'remote', 'add', 'origin', origin);
    put(root, '.claude/workspace.json', '{"beerpowers":"2.20.0","manual":true}\n');
    return { root, product };
  }

  await t.test('clean setup and doctor load templates from the cache', () => {
    const { root } = makeWorkspace('clean');
    const opts = { BEERPOWERS_TEST_COMMAND: 'perl t/catalog.t', BEERPOWERS_TEST_SOURCE: 'README.md' };
    const setup = mode => run(root, perl, [handler, mode], opts);
    assert.match(setup('plan'), /CREATE \.codex\/workspace\.json/);
    assert.equal(existsSync(join(root, '.codex/workspace.json')), false);
    setup('apply');
    assert.equal(load(join(root, '.codex/workspace.json')).beerpowers, manifest.version);
    assert.match(run(root, perl, [handler, 'doctor']), /Project OK: memory\/commands\/catalog\.md/);
    assert.match(read(root, '.codex/agents/product-agent.md'), /beerpowers:engine/);
    assert.equal(existsSync(join(root, '.codex/disciplines')), false);
    assert.match(setup('apply'), /No changes\./);
  });

  for (const [version, failDoctor] of [['0.2.0', false], ['0.5.0', false], ['0.5.0', true]]) {
    const name = failDoctor ? 'recover after the packaged doctor rejects a 0.5.0 upgrade'
      : 'migrate ' + version + ' and re-enter a completed legacy task';
    await t.test(name, () => {
      const { root, product } = makeWorkspace(version + (failDoctor ? '-recovery' : ''));
      const task = 'fix/catalog-caption';
      git(product, 'checkout', '-qb', task);
      const localeFile = 'app/locales/ru.json';
      put(product, localeFile, read(product, localeFile).replace('Книги', 'Каталог книг'));
      assert.match(run(product, perl, ['t/catalog.t']), /^ok \d+ - ru has text for catalogTitle$/m);
      git(product, 'add', localeFile);
      git(product, 'commit', '-qm', 'Change Russian caption');
      const sourceHead = git(product, 'rev-parse', 'HEAD');
      const taskDir = 'memory/tasks/' + task;
      const state = version === '0.2.0' ? { beerpowers: version } : { schemaVersion: 1, beerpowers: version, local: true };
      put(root, '.codex/workspace.json', JSON.stringify(state) + '\n');
      put(root, '.codex/git-settings.json', '{"repos":{"catalog":"main-default"},"standArchive":false,"removeSourceBranch":true}\n');
      const charter = '# Команда catalog\n\nПользовательская договорённость.\n';
      const priorStamp = '<!-- generated-by: beerpowers-codex v' + version + ' · mode: plugin-linked -->';
      put(root, '.codex/team-charter.md', (failDoctor ? priorStamp + '\n' : '') + charter);
      put(root, '.codex/team-lead.md', '# Тимлид\n\nПроектное правило.\n');
      put(root, '.gitignore', '/projects/\n/worktrees/\n');
      put(root, 'AGENTS.md', '# Правила\n\n<!-- beerpowers:engine entry -->\n'
        + 'Прочитай [.codex/team-charter.md](.codex/team-charter.md). Тимлид также читает [.codex/team-lead.md](.codex/team-lead.md).\n'
        + '<!-- /beerpowers:engine -->\n');
      const preserved = {
        '.codex/roles/architect.md': '# Архитектор\n\nУточни словарь у редактора.\n',
        '.claude/workspace.json': read(root, '.claude/workspace.json'),
        'memory/MEMORY.md': '# Память каталога\n\n[Проверка](commands/catalog.md)\n',
        'memory/commands/catalog.md': '# Проверки catalog\n\nКаталог запуска: `projects/catalog/`\nИсточник: `README.md`\n\n'
          + '```text\nperl t/catalog.t\n```\n',
        [taskDir + '/preflight.md']: '# ' + task + '\n\n## Исходная постановка\n\n> Измени заголовок.\n\nКласс: lean. Один словарь.\n',
        [taskDir + '/test-cases.md']: 'Full run: ' + sourceHead + ' exit=0\n',
        [taskDir + '/review-report.md']: 'APPROVED ' + sourceHead + '\n',
        [taskDir + '/handover.md']: '# Передача\n\nПолный прогон и итоговое ревью завершены.\n',
      };
      for (const [file, body] of Object.entries(preserved)) put(root, file, body);
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'Completed task in ' + version + ' workspace');
      const outerHead = git(root, 'rev-parse', 'HEAD');
      assert.equal(git(root, 'status', '--porcelain'), '');
      assert.equal(git(product, 'status', '--porcelain'), '');
      assert.equal(existsSync(join(root, '.codex/agents/product-agent.md')), false);

      let plan = update(root, 'plan');
      assert.equal(plan.from, version);
      assert.equal(plan.to, manifest.version);
      assert.equal(load(join(root, '.codex/workspace.json')).beerpowers, version);
      assert.equal(git(root, 'status', '--porcelain'), '', 'upgrade preview is read-only');
      if (failDoctor) {
        const guide = '.codex/agents/product-agent.md';
        assert.ok(plan.changes.some(change => change.path === guide && change.actions.includes('setup CREATE')));
        assert.ok(plan.changes.some(change => change.path === '.codex/workspace.json'));
        const originalHandler = readFileSync(handler);
        try {
          const guard = 'if (@ARGV && $ARGV[0] eq "doctor") { print STDERR "fixture doctor exit 73\\n"; exit 73; }\n';
          writeFileSync(handler, Buffer.concat([Buffer.from(guard), originalHandler]));
          const result = spawnSync(process.execPath, [join(installed, 'bin/update.mjs'), 'apply', plan.planId],
            { cwd: root, encoding: 'utf8', env, windowsHide: true });
          assert.equal(result.error, undefined);
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /workspace\.pl doctor: fixture doctor exit 73/);
        } finally {
          writeFileSync(handler, originalHandler);
        }
        assert.match(read(root, guide), /beerpowers:engine/);
        assert.deepEqual(load(join(root, '.codex/workspace.json')), state);
        const interrupted = read(root, '.codex/team-charter.md');
        assert.ok(interrupted.includes(priorStamp));
        assert.ok(!interrupted.includes('generated-by: beerpowers-codex v' + manifest.version + ' '));
        const resumedPlan = update(root, 'plan');
        assert.equal(resumedPlan.from, version);
        assert.deepEqual(resumedPlan.changes.map(change => change.path).sort(),
          ['.codex/team-charter.md', '.codex/workspace.json']);
        plan = resumedPlan;
      }
      update(root, 'apply', plan.planId);
      assert.match(run(root, perl, [handler, 'doctor']), /Project OK: memory\/commands\/catalog\.md/);
      assert.match(read(root, '.codex/agents/product-agent.md'), /beerpowers:engine/);
      assert.ok(read(root, '.codex/team-charter.md').includes(charter));
      assert.ok(read(root, '.codex/team-charter.md').includes('generated-by: beerpowers-codex v' + manifest.version + ' '));
      assert.deepEqual(load(join(root, '.codex/workspace.json')), { ...state, beerpowers: manifest.version, schemaVersion: 1 });
      for (const [file, body] of Object.entries(preserved)) assert.equal(read(root, file), body, file);
      assert.deepEqual(update(root, 'plan').changes, []);
      const afterUpgrade = git(root, 'status', '--porcelain');
      const resumed = run(root, perl, [handler, 'task-start', task]);
      assert.match(resumed, /Resume existing lean task \(read only\)\./);
      assert.ok(resumed.includes('Evidence: ' + taskDir + '/review-report.md'));
      assert.equal(git(product, 'branch', '--show-current'), task);
      assert.equal(git(product, 'rev-parse', 'HEAD'), sourceHead);
      assert.equal(git(root, 'rev-parse', 'HEAD'), outerHead);
      assert.equal(git(root, 'status', '--porcelain'), afterUpgrade);
      for (const [file, body] of Object.entries(preserved)) assert.equal(read(root, file), body, file);
    });
  }
});

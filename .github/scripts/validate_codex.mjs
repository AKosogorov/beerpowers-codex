#!/usr/bin/env node
// Run from a checkout. Each package check and test suite reports independently.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEngineTemplates } from './check_migrations.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
const pkg = 'plugins/beerpowers';
// Resource names from the BeerPowers 2.20.0 pin, mapped to their Codex counterparts.
// Keep this contract runnable with only the Codex checkout.
const upstream = {name: 'beerpowers', version: '2.20.0', commit: '7c5bb1221d65b5c46c8af96fe7bc4ce979fc596e'};
const publicCommands = ['decision-brief', 'doctor', 'feature', 'onboard', 'product-onboard', 'retro', 'setup',
  'task-start', 'team-down', 'team-lazy', 'team-up', 'tech-debt-index', 'token-audit', 'tracker', 'update', 'worktrees-clear'];
const automaticSkills = ['brainstorm', 'debug-loop', 'economy', 'grill', 'minimal-diff', 'page-screenshot',
  'prototype', 'summarizing-mr-links', 'tracker-task'];
const agents = ['architect','auditor','backend','database','devops','explorer','frontend','product','reviewer','testing'];
const stackPresets = {
  elasticsearch: ['architect', 'auditor', 'database', 'reviewer'],
  gitlab: ['devops'],
  laravel: ['architect', 'auditor', 'backend', 'database', 'reviewer', 'testing'],
  nuxt: ['architect', 'auditor', 'frontend', 'reviewer'],
  postgres: ['database', 'reviewer'],
  supabase: ['architect', 'database', 'frontend', 'reviewer', 'testing'],
};
const memoryTemplates = [
  'MEMORY.md', 'adr/.gitkeep', 'commands/README.md', 'issues/accepted-risks.md', 'issues/known-issues.md',
  'project/domain-invariants.md', 'project/glossary.md', 'project/modules/.gitkeep', 'project/project-map.md',
  'project/safety-rules.md', 'retro-log.md', 'tests/backend.md', 'tests/frontend.md', 'tests/probes.md', 'tests/unverified.md',
];
const replyRules = ['reply_blocking_asks', 'reply_file_links', 'reply_user_shell'];
const guardNames = ['guard-agent-memory', 'guard-approval-link', 'guard-comments', 'guard-commit-split',
  'guard-kill', 'guard-push', 'guard-stdin-code', 'guard-user-files'];
const results = [];
const text = path => readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
const json = path => JSON.parse(text(path));
const files = dir => readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap(entry => entry.isDirectory() ? files(dir + '/' + entry.name) : [dir + '/' + entry.name]);
const names = dir => readdirSync(dir).filter(name => name.endsWith('.md')).map(name => basename(name, '.md')).sort();
const mustExist = path => assert.ok(statSync(path, {throwIfNoEntry: false})?.isFile() && statSync(path).size, `Missing or empty: ${path}`);
const verifyAll = issues => { if (issues.length) throw new Error(issues.join('\n')); };

function check(name, run) {
  try {
    run();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push([name, false]);
    console.error(`FAIL  ${name}\n${error.message}`);
  }
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {cwd: root, encoding: 'utf8', windowsHide: true, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(binary)} ${args.join(' ')}: ${result.signal || result.status}\n${result.stderr ?? ''}`.trimEnd());
  return result.stdout;
}

function packageChecks() {
  check('Local marketplace, package identity and pinned upstream', () => {
    const catalog = json('.agents/plugins/marketplace.json');
    assert.equal(catalog.name, 'akosogorov-codex');
    const entries = catalog.plugins.filter(entry => entry.name === 'beerpowers-codex');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].source, {source: 'local', path: './' + pkg});
    const manifest = json(pkg + '/.codex-plugin/plugin.json');
    assert.equal(manifest.name, entries[0].name);
    assert.match(manifest.version, /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/);
    assert.equal(manifest.skills, './skills/');
    assert.deepEqual(manifest.upstream, upstream);
  });
  check('Nine automatic skills and an explicit adapter for 16 commands', () => {
    const installedSkills = ['beerpowers', ...automaticSkills];
    assert.deepEqual(files(pkg + '/skills').filter(path => basename(path) === 'SKILL.md').sort(),
      installedSkills.map(name => `${pkg}/skills/${name}/SKILL.md`));
    for (const name of installedSkills) {
      const dir = `${pkg}/skills/${name}`;
      const header = text(dir + '/SKILL.md').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? '';
      assert.match(header, new RegExp(`^name: ${name}\\r?$`, 'm'), name);
      assert.match(header, /^description: \S/m, name);
      const policy = dir + '/agents/openai.yaml';
      if (name === 'beerpowers') {
        assert.match(text(policy), /^policy:\r?\n  allow_implicit_invocation: false\r?$/m);
      } else if (existsSync(policy)) {
        assert.doesNotMatch(text(policy), /^\s*allow_implicit_invocation:\s*false\s*$/m, name);
      }
    }
    assert.deepEqual(names(pkg + '/commands'), publicCommands);
    for (const name of publicCommands) mustExist(`${pkg}/commands/${name}.md`);
    const adapter = text(pkg + '/skills/beerpowers/SKILL.md');
    assert.match(adapter, /\$beerpowers <имя>/);
    assert.match(adapter, /bin\/command-route\.pl/);
    assert.doesNotMatch(adapter, /commands\/[a-z-]+\.md/);
    mustExist(pkg + '/bin/command-route.pl');
    for (const name of ['feature-implementation', 'feature-pipeline', 'intake-protocol', 'workspace', 'worktrees', 'integrations', 'git-flow']) {
      mustExist(`${pkg}/reference/${name}.md`);
    }
  });
  check('Package excludes retired workflow entry points and references', () => {
    const retired = /access-audit|ensemble-review|flaky-hunt/i;
    verifyAll(files(pkg).filter(path => retired.test(path) || retired.test(text(path))));
  });
  check('Standard feature review retains early and final gates', () => {
    mustExist(pkg + '/bin/review-diff.pl');
    const route = text(pkg + '/reference/feature-implementation.md');
    for (const marker of ['review-diff', 'early-pass', 'early-changes', 'final-approve', 'final-changes']) {
      assert.ok(route.includes(marker), 'Missing feature review instruction: ' + marker);
    }
  });
  check('Agent templates, stack slots, instructions match the pinned contract', () => {
    assert.ok(!existsSync(pkg + '/templates/rules'), 'Path rules belong to the project');
    assert.deepEqual(names(pkg + '/templates/roles'), agents.map(role => role + '-agent'));
    const presets = pkg + '/templates/roles/presets';
    const expected = ['skills.md', ...Object.entries(stackPresets)
      .flatMap(([stack, roles]) => roles.map(role => `${stack}/${role}.md`))];
    assert.deepEqual(files(presets).map(path => path.slice(presets.length + 1)).sort(), expected.sort());
    for (const resource of memoryTemplates) {
      const path = pkg + '/templates/memory/' + resource;
      if (basename(resource) === '.gitkeep') assert.ok(statSync(path, {throwIfNoEntry: false})?.isFile(), path);
      else mustExist(path);
    }
    for (const path of ['templates/charter/team-charter.md', 'templates/charter/team-lead.md', 'templates/role-memory/MEMORY.md',
      ...agents.map(role => `templates/roles/${role}-agent.md`),
      ...['figma', 'yandex-tracker'].map(name => `templates/settings/${name}-settings.json.example`),
      ...replyRules.map(rule => `rules/${rule}.md`), 'reference/instructions.md',
      'THIRD_PARTY_NOTICES.txt', 'LICENSE']) mustExist(pkg + '/' + path);
  });
  check('Hook event mappings, guard coverage and local integration resources', () => {
    const hooks = json(pkg + '/hooks/hooks.json').hooks;
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop']) {
      assert.ok(hooks[event]?.some(group => group.hooks.some(entry =>
        entry.type === 'command' && entry.command.includes('hooks/dispatch.pl') && entry.commandWindows.includes('hooks/dispatch.pl'))), event);
    }
    const hookDoc = text(pkg + '/reference/hooks.md');
    for (const guard of guardNames) assert.ok(hookDoc.includes(guard), guard);
    const resources = ['hooks/dispatch.pl', 'hooks/shell.pl', 'hooks/git.pl', 'hooks/session-start.pl',
      ...guardNames.map(name => `hooks/${name}.pl`),
      ...['quality-reminder', 'screenshots-reminder'].map(name => `templates/hooks/${name}.pl`),
      'bin/workspace-clean', 'bin/workspace-check.mjs',
      'bin/make-shim', 'bin/lib/make-shim.mk', 'templates/settings/yandex-tracker-settings.json.example',
      ...['tracker', 'figma-export', 'publication', 'git-workspace', 'cdp-run', 'cdp-screenshot', 'layout-check',
        'parallel-tests', 'mutants', 'token-audit', 'decision-brief', 'feature-pm', 'onboard-check', 'update'].map(name => `bin/${name}.mjs`)];
    verifyAll(resources.filter(path => !statSync(pkg + '/' + path, {throwIfNoEntry: false})?.size)
      .map(path => 'Missing or empty integration resource: ' + path));
  });
  check('Relative Markdown links in README and Codex resources', () => {
    const issues = [];
    const generated = new Map([['.codex/team-charter.md', 'charter/team-charter.md'], ['.codex/team-lead.md', 'charter/team-lead.md']]);
    for (const path of ['README.md', 'TOUR.md', ...files(pkg)].filter(p => p.endsWith('.md'))) {
      let fence;
      for (const line of text(path).split(/\r?\n/)) {
        const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
        if (marker) { if (!fence) fence = marker; else if (marker.startsWith(fence)) fence = null; continue; }
        if (fence) continue;
        for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
          if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
          const name = target.split('#')[0];
          const dest = path === pkg + '/templates/AGENTS.md' && generated.has(name)
            ? join(pkg, 'templates', generated.get(name)) : resolve(dirname(path), decodeURIComponent(name));
          if (!existsSync(dest)) issues.push(`${path} → ${target}`);
        }
      }
    }
    verifyAll(issues);
  });
  check('Template placeholders', () => {
    const issues = [];
    const sectionSlots = {
      'charter/team-charter.md': 'BEERPOWERS_VERSION PURPOSE STACK_TABLE COMMANDS ROLES_TABLE MODELS INTAKE_MODE PROJECT_RULES UNIVERSAL_SKILLS PM_PIPELINE MEMORY_FILES_EXTRA',
      'charter/team-lead.md': 'CLASS_EXTRA EFFORT_TABLE MODEL_EXTRA GATES_EXTRA CLOSING_EXTRA',
      'memory/MEMORY.md': 'OWNERS_EXTRA',
      'memory/commands/README.md': 'COMMANDS_INDEX',
      'memory/project/domain-invariants.md': 'INVARIANTS_DETAILED',
      'memory/project/project-map.md': 'PROJECT_MAP',
      'memory/project/safety-rules.md': 'NEVER_CODE CONFIRM_EXTRA',
      'memory/tests/frontend.md': 'BREAKPOINTS',
    };
    for (const [relative, slots] of Object.entries(sectionSlots)) {
      const body = text(pkg + '/templates/' + relative);
      for (const slot of slots.split(' ')) {
        if (!body.split(/\r?\n/).includes('{{' + slot + '}}')) issues.push(`${relative}: missing slot ${slot}`);
      }
    }
    const projectSlotFiles = new Set(['templates/charter/team-charter.md', 'templates/charter/team-lead.md', 'templates/memory/MEMORY.md', 'templates/memory/retro-log.md',
      'templates/memory/commands/README.md', ...memoryTemplates.filter(path => /^(issues|project|tests)\/.*\.md$/.test(path))
        .map(path => 'templates/memory/' + path)].map(path => pkg + '/' + path));
    for (const path of [...files(pkg + '/templates')].filter(p => /\.(?:md|json|example)$/.test(p))) {
      const body = text(path);
      if (/\/templates\/roles\/(?:presets\/|[^/]+-agent\.md$)/.test(path)) continue;
      for (const [token] of body.matchAll(/\{\{[^{}\r\n]*\}\}|\{\{[A-Za-z0-9_]+\}(?!\})|(?<!\{)\{[A-Za-z0-9_]+\}\}/g)) {
        if ((!projectSlotFiles.has(path) || token !== '{{PROJECT}}') &&
            !sectionSlots[path.slice((pkg + '/templates/').length)]?.split(' ').includes(token.slice(2, -2))) issues.push(`${path}: ${token}`);
      }
    }
    verifyAll(issues);
  });
  check('Engine marker pairs and migration registry', validateEngineTemplates);
}

function perl() {
  if (process.env.BEERPOWERS_PERL) return process.env.BEERPOWERS_PERL;
  if (process.platform !== 'win32') return 'perl';
  const candidates = command('where.exe', ['git.exe']).trim().split(/\r?\n/)
    .map(git => resolve(dirname(git), '../usr/bin/perl.exe'));
  return candidates.find(path => existsSync(path)) ?? 'perl';
}

function runTests() {
  const temporary = mkdtempSync(join(tmpdir(), 'beerpowers-validation-'));
  try { runFixtureSuites(temporary); }
  finally { rmSync(temporary, {recursive: true, force: true, maxRetries: 3}); }
}

function runFixtureSuites(temporary) {
  const env = {...process.env, BEERPOWERS_NODE: process.execPath, GIT_CONFIG_GLOBAL: join(temporary, 'unused.gitconfig'),
    XDG_CONFIG_HOME: temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file'};
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = dirname(process.execPath) + delimiter + (env[pathKey] ?? '');
  const tests = readdirSync('tests').filter(name => /^codex-.*\.(?:t|mjs)$/.test(name)).sort();
  const perlTests = tests.filter(name => name.endsWith('.t'));
  const nodeTests = tests.filter(name => name.endsWith('.mjs'));
  check('Perl and Node fixture suites present', () => {
    assert.ok(perlTests.length && nodeTests.length);
    for (const name of ['codex-package-install.test.mjs', 'codex-git-workspace.mjs', 'codex-ui.mjs', 'codex-example.t']) {
      assert.ok(tests.includes(name), name);
    }
  });
  for (const name of perlTests) {
    check('tests/' + name, () => command(perl(), ['tests/' + name], {env, stdio: 'inherit'}));
  }
  if (nodeTests.length) {
    check('Node suites (' + nodeTests.length + ' files)', () => command(process.execPath,
      ['--test', '--test-concurrency=1', ...nodeTests.map(name => 'tests/' + name)], {env, stdio: 'inherit'}));
  }
}

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--package-only')) {
  console.error('Usage: node .github/scripts/validate_codex.mjs [--package-only]');
  process.exitCode = 2;
} else {
  packageChecks();
  if (!process.argv[2]) runTests();
  const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
  console.log(`Codex validation: ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) { console.error('Failed checks:\n- ' + failed.join('\n- ')); process.exitCode = 1; }
}

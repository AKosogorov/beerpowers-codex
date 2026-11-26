import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../plugins/beerpowers/bin/', import.meta.url))
const node = '"{env:BEERPOWERS_NODE}"'
const reporter = '--test --test-reporter=junit --test-reporter-destination="{junit}"'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex qa-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'projects/calc')
  const put = (rel, data) => {
    const dest = path.join(root, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, data)
  }
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    BEERPOWERS_NODE: process.execPath, BEERPOWERS_TEST_SLOTS_DIR: path.join(root, 'slots'), BEERPOWERS_TEST_SLOTS: '2',
    GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_AUTHOR_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'fixture' }
  // Node suppresses nested test runners inside a node:test worker.
  delete env.NODE_TEST_CONTEXT
  put('empty.gitconfig', '')
  put('projects/calc/rule.mjs', 'export const allowed = n => n <= 90\nexport const extra = 1\n')
  put('projects/calc/tests/rule.test.mjs', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { allowed } from '../rule.mjs'\ntest('limit', () => assert.ok(allowed(90)))\n")
  put('projects/calc/tests/other test.mjs', "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('other', () => assert.equal(2 + 2, 4))\n")
  put('projects/calc/prepare.mjs', "import fs from 'node:fs'\nfs.writeFileSync(process.env.PREP + '-' + process.env.BEERPOWERS_TEST_SLOT, process.env.PREP_DB)\n")
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const config = (overrides = {}) => {
    const calc = { mode: 'split', command: node + ' ' + reporter + ' {files}', files: ['tests/*.mjs'],
      prepare: node + ' prepare.mjs', env: { PREP: '{root}/prep', PREP_DB: 'calc_{i}' },
      mutate: { command: node + ' --test {filter}' }, ...overrides }
    put('.codex/workspace.json', JSON.stringify({ schemaVersion: 1, tests: { slots: 2, repos: { calc } } }))
  }
  config()
  const run = (tool, args = [], code = 0, vars = {}) => {
    const result = spawnSync(process.execPath, [path.join(bin, tool + '.mjs'), ...args],
      { cwd: root, env: { ...env, ...vars }, windowsHide: true, encoding: 'utf8', timeout: 45000 })
    assert.ifError(result.error)
    assert.equal(result.status, code, result.stdout + result.stderr)
    return result.stdout + result.stderr
  }
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
  return { root, repo, put, read, git, config, run }
}

test('parallel split runs real Node tests in two leased slots, emits junit and surfaces a regression', t => {
  const f = fixture(t)
  const run = (...args) => f.run('parallel-tests', ...args)
  assert.match(run(['--repos','calc','--dry-run']), /PLAN calc .*mode=split files=2/)
  assert.equal(fs.existsSync(path.join(f.root, '.codex/.cache/parallel-tests')), false)
  const output = run(['--out','artifacts/split'])
  assert.match(output, /tree=clean mode=split files=2 slots=1,2/)
  assert.match(output, /CODE=0/)
  for (const slot of [1, 2]) assert.equal(f.read('prep-' + slot), 'calc_' + slot)
  assert.match(f.read('artifacts/split/calc/junit.xml'), /name="limit"/)
  assert.match(f.read('artifacts/split/calc/junit.xml'), /name="other"/)
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'slots')), [])
  f.put('projects/calc/rule.mjs', 'export const allowed = n => n < 90\n')
  assert.match(run(['--repos','calc','--workers','1'], 1), /CODE=1/)
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'slots')), [])
})

test('parallel native runs one framework invocation and prepares each reserved worker', t => {
  const f = fixture(t)
  f.config({ mode: 'native', command: node + ' ' + reporter + ' --test-concurrency={n} tests/*.mjs' })
  assert.match(f.run('parallel-tests', ['--out','artifacts/native']), /mode=native slots=1,2/)
  assert.match(f.read('artifacts/native/calc/native.log'), /--test-concurrency=2/)
  assert.match(f.read('artifacts/native/calc/junit.xml'), /name="other"/)
  assert.match(f.read('artifacts/native/calc/junit.xml'), /name="limit"/)
  assert.equal(f.read('prep-1'), 'calc_1')
  assert.equal(f.read('prep-2'), 'calc_2')
  f.config({ mode: 'native', command: node + ' ' + reporter + ' {files}' })
  assert.match(f.run('parallel-tests', [], 2), /CODE=2/)
})

test('mutants uses detached copies of dirty checkout, records killed and survived and restores copies', t => {
  const f = fixture(t)
  const before = f.read('projects/calc/rule.mjs') + '\n// local change\n'
  f.put('projects/calc/rule.mjs', before)
  const head = f.git('rev-parse', 'HEAD')
  const beforeDiff = f.git('diff', 'HEAD')
  const spec = { repo: 'calc', tests: ['tests/rule.test.mjs:4'], filter: 'tests/rule.test.mjs',
    mutants: [
      { id: 'M1', file: 'rule.mjs', find: '<= 90', replace: '< 90', criterion: 'inclusive boundary' },
      { id: 'M2', file: 'rule.mjs', find: 'extra = 1', replace: 'extra = 2', criterion: 'extra default' },
    ] }
  const input = 'scratch/mutations.json'
  f.put(input, JSON.stringify(spec))
  f.run('mutants', [input, '--dry-run'])
  assert.equal(fs.existsSync(path.join(f.root, '.codex/.cache/mutants')), false)
  const run = (...args) => f.run('mutants', ...args)
  assert.match(run([input], 1), /TOTAL mutants=2 killed=1 survived=1 errors=0 invalid=0/)
  assert.match(f.read('scratch/mutations.table.md'), /выжил/)
  assert.match(f.read('scratch/mutations.runs/M1.log'), /код выхода 1/)
  assert.equal(f.read('projects/calc/rule.mjs'), before)
  assert.equal(f.git('diff','HEAD'), beforeDiff)
  assert.equal(f.git('rev-parse','HEAD'), head)
  assert.match(run([input], 1), /cached=2/)
  assert.match(run([input,'--only','M1','--force'], 1), /killed=1 survived=0 errors=0 invalid=0 skipped=1/)
  f.put(input, JSON.stringify({ ...spec, mutants: [spec.mutants[0]] }))
  assert.match(run([input]), /CODE=0/)
  assert.match(run(['--clean','--dry-run']), /убрал бы/)
  run(['--clean'])
  assert.doesNotMatch(f.git('worktree','list','--porcelain'), /mutants/)
  assert.equal(f.git('diff','HEAD'), beforeDiff)
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'slots')), [])
})

test('QA rejects paths outside workspace and preserves unrelated data in the copy cache', t => {
  const f = fixture(t)
  assert.match(f.run('parallel-tests',['--out','../outside'],2), /Unsafe workspace path/)
  f.put('scratch/invalid.json', JSON.stringify({ repo: 'calc', filter:'tests/rule.test.mjs',tests:['tests/rule.test.mjs'],
    mutants:[{id:'M1',file:'../other', find:'1',replace:'2'}] }))
  assert.match(f.run('mutants',['scratch/invalid.json'],2), /Unsafe workspace path/)
  f.put('.codex/.cache/mutants/manual/keep','keep')
  f.run('mutants',['--clean'])
  assert.equal(f.read('.codex/.cache/mutants/manual/keep'),'keep')
})

test('status and acquisition honor a live slot, reclaim a stale lease, and use a nested task worktree', t => {
  const f = fixture(t)
  const checkout = path.join(f.root, 'worktrees/fix/limit/calc')
  f.git('worktree', 'add', '-q', '-b', 'fix/limit', checkout)
  const owner = JSON.stringify({ pid: process.pid, tool: 'test', repo: 'other' })
  f.put('slots/slot-1', owner)
  f.put('slots/slot-2', JSON.stringify({ pid: 2147483647 }))
  assert.match(f.run('parallel-tests',['--status']), /slot-1 pid=/)
  const output = f.run('parallel-tests',['--task','fix/limit','--out','artifacts/task'])
  assert.match(output, /STALE slot-2/)
  assert.match(output, /dir=worktrees\/fix\/limit\/calc .*slots=2\b/)
  assert.equal(f.read('slots/slot-1'), owner)
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'slots')), ['slot-1'])
})

test('mutants rejects a red baseline and detects a test that never reads the mutated code', t => {
  const f = fixture(t)
  const input = 'scratch/check.json'
  const spec = { repo: 'calc', filter: 'tests/rule.test.mjs', tests: ['tests/rule.test.mjs'],
    mutants: [{id: 'M1', file: 'rule.mjs', find: '<= 90', replace: '< 90'}] }
  f.put(input, JSON.stringify(spec))
  f.put('projects/calc/tests/rule.test.mjs', "import assert from 'node:assert/strict'\nassert.fail('baseline')\n")
  const red = f.run('mutants', [input], 1)
  assert.match(red, /контроль control-1 красный/)
  assert.match(red, /killed=0 survived=0 errors=0 invalid=1/)
  f.put('projects/calc/tests/rule.test.mjs', "import assert from 'node:assert/strict'\nassert.ok(true)\n")
  const unrelated = f.run('mutants', [input], 1)
  assert.match(unrelated, /тест не видит rule.mjs копии/)
  assert.match(unrelated, /killed=0 survived=0 errors=0 invalid=1/)
})

test('Composer-shaped vendor keeps autoload roots in the copy and preserves dependency data during cleanup', t => {
  const f = fixture(t)
  f.put('projects/calc/.gitignore', 'vendor/\nsynthetic.cfg\n')
  for (const file of ['autoload.php','bin/runner','composer/mapping','acme/pkg/marker']) {
    f.put('projects/calc/vendor/' + file, 'fixture\n')
  }
  f.put('projects/calc/synthetic.cfg', 'test-mode\n')
  f.put('projects/calc/tests/deps.test.mjs', [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import { pathToFileURL } from 'node:url'",
    "import assert from 'node:assert/strict'",
    "const base = path.resolve(fs.realpathSync('vendor/composer'), '../..')",
    "const { allowed } = await import(pathToFileURL(path.join(base, 'rule.mjs')))",
    "assert.equal(fs.readFileSync('synthetic.cfg', 'utf8'), 'test-mode\\n')",
    "assert.equal(fs.readFileSync('vendor/acme/pkg/marker', 'utf8'), 'fixture\\n')",
    "assert.equal(allowed(90), true)",
  ].join('\n'))
  f.git('add', '.')
  f.git('commit', '-qm', 'dependency fixture')
  f.config({ mutate: { command: node + ' --test {filter}', check: node + ' --check "{file}"',
    link: ['vendor'], copy: ['synthetic.cfg'] } })
  f.put('scratch/deps.json', JSON.stringify({ repo: 'calc', filter:'tests/deps.test.mjs', tests:['tests/deps.test.mjs:9'],
    mutants:[{id:'M1', file:'rule.mjs', find:'<= 90', replace:'< 90'}] }))
  assert.match(f.run('mutants',['scratch/deps.json']), /killed=1 survived=0 errors=0 invalid=0/)
  const vendor = path.join(f.root, '.codex/.cache/mutants/calc-s1/vendor')
  assert.equal(fs.lstatSync(path.join(vendor,'acme')).isSymbolicLink(), true)
  assert.equal(fs.lstatSync(path.join(vendor,'composer')).isSymbolicLink(), false)
  f.run('mutants',['scratch/deps.json','--force'])
  f.run('mutants',['--clean'])
  assert.equal(f.read('projects/calc/vendor/acme/pkg/marker'), 'fixture\n')
  assert.equal(f.read('projects/calc/synthetic.cfg'), 'test-mode\n')
  assert.equal(f.git('status','--porcelain'), '')
})

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../plugins/beerpowers/bin/', import.meta.url));
const slug = 'saved-products';
const directory = `docs/features/${slug}`;
const pointer = `2026-01-15 · Saved products · ${directory}/`;
const handoff = '## Handoff\n\n```text\n$beerpowers task-start feature/saved-products\n```';

function invoke(script, args, options) {
  const result = spawnSync(process.execPath, [join(bin, script), ...args], {encoding: 'utf8', ...options});
  assert.ifError(result.error);
  return result;
}

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'beerpowers-pm-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  function put(path, value) {
    const dest = join(cwd, path);
    mkdirSync(dirname(dest), {recursive: true});
    writeFileSync(dest, value);
  }
  function artifact(name, status, track, body = '') {
    const fields = ['Feature: Saved products', `Slug: ${slug}`, `Status: ${status}`, 'Дата: 2026-01-15'];
    if (track) fields.push(`Track: ${track}`);
    put(`${directory}/${name}.md`, fields.join('\r\n') + '\r\n\r\n' + body);
  }
  function run(code = slug) { return invoke('feature-pm.mjs', [code], {cwd}); }
  function status() {
    const out = run();
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  }
  return {cwd, put, artifact, run, status};
}

test('fast track resumes after approval, preserves files and requires the final exact pointer', t => {
  const {cwd, put, artifact, run, status} = fixture(t);
  assert.equal(status().next, 'intake');
  assert.deepEqual(readdirSync(cwd), []);
  artifact('intake', 'Draft', 'fast');
  assert.equal(status().next, 'intake');
  artifact('intake', 'Approved', 'fast');
  assert.equal(status().next, 'feature-brief');
  artifact('feature-brief', 'Draft');
  assert.equal(status().next, 'feature-brief');
  artifact('feature-brief', 'Approved', null, handoff);
  const plan = join(cwd, directory, 'feature-brief.md');
  const before = readFileSync(plan);
  put('memory/decisions.md', ['# Decisions', '', '```text', pointer, '```', pointer.replace(slug, slug + '-2'), ''].join('\n'));
  assert.equal(status().next, 'handoff');
  put('memory/decisions.md', `# Decisions\n\n- ${pointer}\n`);
  assert.equal(status().next, 'complete');
  assert.deepEqual(status(), status());
  assert.deepEqual(readFileSync(plan), before);
  put('memory/decisions.md', `${pointer}\n${pointer}\n`);
  assert.notEqual(run().status, 0);
});

test('full track resumes decomposition and estimates at the joint checkpoint', t => {
  const {artifact, status, put} = fixture(t);
  artifact('intake', 'Approved');
  assert.equal(status().next, 'choose-track');
  artifact('intake', 'Approved', 'full');
  assert.equal(status().next, 'prd');
  artifact('prd', 'Approved');
  assert.equal(status().next, 'decomposition');
  artifact('decomposition', 'Draft');
  assert.equal(status().next, 'estimate');
  artifact('estimate', 'Approved');
  assert.equal(status().next, 'estimate');
  artifact('decomposition', 'Approved');
  assert.equal(status().next, 'plan');
  artifact('plan', 'In Development', null, handoff);
  assert.equal(status().next, 'handoff');
  put('memory/decisions.md', pointer);
  assert.equal(status().next, 'complete');
});

test('promotion preserves the fast draft and resumes at PRD; ambiguous track requires review', t => {
  const {cwd, artifact, run, status} = fixture(t);
  artifact('intake', 'Approved');
  artifact('feature-brief', 'Draft');
  assert.equal(status().track, 'fast');
  artifact('prd', 'Draft');
  assert.notEqual(run().status, 0);
  artifact('intake', 'Approved', 'full');
  const fast = join(cwd, directory, 'feature-brief.md');
  const before = readFileSync(fast);
  assert.equal(status().next, 'prd');
  assert.deepEqual(readFileSync(fast), before);
});

test('malformed artifacts, fake handoffs and path traversal never advance the workflow', t => {
  const {artifact, put, run} = fixture(t);
  for (const unsafe of ['../outside', 'one/two', 'CON', '-fast']) assert.notEqual(run(unsafe).status, 0);
  artifact('intake', 'Approved', 'fast');
  artifact('feature-brief', 'Pending');
  assert.notEqual(run().status, 0);
  artifact('feature-brief', 'Approved', null, '```\n## Handoff\nexample\n```');
  assert.notEqual(run().status, 0);
  put(`${directory}/feature-brief.md`, 'Slug: other\nStatus: Approved\n' + handoff);
  assert.notEqual(run().status, 0);
});

const brief = {
  question: 'When should we recalculate?', mainQuestion: 'Which local event supplies the new total?',
  mechanism: 'The fixture refreshes its projection only after receiving the change.',
  runs: [{date: '2026-01-15', command: 'fixture-test --event change --label "```"', result: 'Received one change'}],
  inferences: ['src/events.js:21 defines change.'], unverified: ['Production event volume.'],
  options: [
    {name: 'On change', pro: 'Immediate result', con: 'More events', risk: 'Repeated work'},
    {name: 'Current schedule', pro: 'Known load', con: 'Stale result', risk: 'Confusing display'}
  ],
  recommendation: 'On change fits the required update interval.', decisions: ['Confirm acceptable latency.']
};
function render(data) {
  return invoke('decision-brief.mjs', [], {input: JSON.stringify(data)});
}

test('decision brief renders reproducible commands, alternatives and limits in a shareable section', () => {
  const result = render(brief);
  assert.equal(result.status, 0, result.stderr);
  for (const fragment of ['## Материал для решения', brief.runs[0].result, brief.inferences[0],
    brief.unverified[0], '#### 1. On change', '#### 2. Current schedule', '1. Confirm acceptable latency.']) {
    assert.ok(result.stdout.includes(fragment), fragment);
  }
  assert.ok(result.stdout.includes('````text\n' + brief.runs[0].command + '\n````'));
  assert.equal(render(brief).stdout, result.stdout);
  assert.equal(render({...brief, runs: []}).status, 0);
});

test('decision brief keeps each option’s decision scope and separates expected and observed results', () => {
  const data = {...brief,
    runs:[{...brief.runs[0],expected:'Refresh visible total'}],
    options:[{...brief.options[0],addresses:'Cause and original question'},
      {...brief.options[1],addresses:'Original question only'}]};
  const result = render(data);
  assert.equal(result.status,0,result.stderr);
  for (const fragment of ['**Ожидалось.** Refresh visible total','**Наблюдалось.** Received one change',
    'Какой вопрос закрывает: Cause and original question','Какой вопрос закрывает: Original question only'])
    assert.ok(result.stdout.includes(fragment),fragment);
});

test('decision brief rejects missing tradeoff, unexplained absence of evidence, and one-sided options', () => {
  for (const change of [{options: brief.options.slice(0, 1)}, {options: Array(5).fill(brief.options[0])},
    {options: [brief.options[0], {...brief.options[1], risk: ''}]}, {unverified: null},
    {runs: [], unverified: []}, {decisions: []}]) {
    const result = render({...brief, ...change});
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});

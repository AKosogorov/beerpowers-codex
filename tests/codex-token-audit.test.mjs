import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const handler = fileURLToPath(new URL('../plugins/beerpowers/bin/token-audit.mjs', import.meta.url));
const timestamp = minutes => `2026-01-15T10:${String(minutes).padStart(2, '0')}:00Z`;
const meta = (id, tags = {}) => ({timestamp: timestamp(0), type: 'session_meta', payload: {id, ...tags}});
const event = (minute, info, extras = {}) => ({
  timestamp: timestamp(minute), type: 'event_msg', payload: {type: 'token_count', info, ...extras}
});
const snapshot = (minute, usage) => event(minute, {total_token_usage: usage, last_token_usage: {total_tokens: 12345}});
const delta = (minute, id, usage) => event(minute, {last_token_usage: usage}, {request_id: id});
function fixture(t, zone) {
  const cwd = mkdtempSync(join(tmpdir(), 'beerpowers-metrics-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  const profile = join(cwd, 'mock-profile');
  const path = join(cwd, 'metrics.jsonl');
  mkdirSync(join(profile, 'sessions'), {recursive: true});
  function set(rows) {
    writeFileSync(path, '\uFEFF' + rows.map(JSON.stringify).join('\r\n') + '\r\n');
  }
  function run(...args) {
    const result = spawnSync(process.execPath, [handler, ...args], {
      encoding: 'utf8', cwd, env: {...process.env, CODEX_HOME: profile, ...(zone ? {TZ:zone} : {})}
    });
    assert.ifError(result.error);
    return result;
  }
  function audit(...args) {
    const result = run('--input', path, ...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return {cwd, profile, path, set, run, audit};
}

test('Codex cumulative usage takes final counters once, distinguishes measured zero and missing metrics', t => {
  const f = fixture(t);
  const a = meta('A', {project: 'demo', model: 'fixture-model', role: 'tester'});
  const first = snapshot(1, {input_tokens: 40, cached_input_tokens: 0, output_tokens: 10, total_tokens: 50});
  const second = snapshot(2, {input_tokens: 80, cached_input_tokens: 20, output_tokens: 15, total_tokens: 95});
  f.set([a, first, second, a, first, second, snapshot(5, second.payload.info.total_token_usage)]);
  const report = f.audit('--time', '--by-repo');
  assert.equal(report.source, 'Codex metrics export');
  assert.deepEqual(report.project.totals, {input_tokens: 80, cached_input_tokens: 20, output_tokens: 15,
    reasoning_output_tokens: null, total_tokens: 95});
  assert.equal(report.project.requests, null);
  assert.equal(report.project.cachedInputPercent, 25);
  assert.equal(report.project.groups[0].role, 'tester');
  assert.deepEqual(report.project.topSessions, ['A']);
  assert.equal(report.time.value, null);
  assert.equal(report.byRepo.value, null);
  assert.ok(report.unavailable.cost);
  const earlier = f.audit('--until', timestamp(2));
  assert.equal(earlier.project.totals.cached_input_tokens, 0);
  assert.equal(earlier.project.cachedInputPercent, 0);
});

test('period is half-open, uses previous cumulative baseline and refuses to guess a missing one', t => {
  const f = fixture(t);
  f.set([meta('A'), snapshot(7, {total_tokens: 90}), snapshot(5, {total_tokens: 70}), snapshot(2, {total_tokens: 50})]);
  const report = f.audit('--since', timestamp(5), '--until', timestamp(7));
  assert.equal(report.project.totals.total_tokens, 20);
  f.set([meta('A'), snapshot(5, {total_tokens: 70})]);
  const unknown = f.audit('--since', timestamp(4));
  assert.equal(unknown.project.totals.total_tokens, null);
  assert.equal(unknown.project.rows[0].missingBaseline, true);
  assert.equal(f.audit('--since', timestamp(0)).project.totals.total_tokens, 70);
  assert.equal(f.audit('--until', timestamp(4)).project.totals.total_tokens, null);
});

test('stable request IDs deduplicate within a session; missing fields make combined totals unknown', t => {
  const f = fixture(t);
  const first = delta(1, 'same', {input_tokens: 6, output_tokens: 0, total_tokens: 6});
  const second = delta(2, 'other', {input_tokens: 4, output_tokens: 0, total_tokens: 4});
  f.set([meta('A', {project: 'one'}), first, first, second, meta('B', {project: 'two'}),
    delta(1, 'same', {total_tokens: 3})]);
  const report = f.audit('--all-projects', '--top', '1');
  assert.equal(report.project.totals.total_tokens, 13);
  assert.equal(report.project.totals.input_tokens, null);
  assert.equal(report.project.requests, 3);
  assert.deepEqual(report.project.topSessions, ['A']);
  const single = f.audit('project', '--project', 'one');
  assert.equal(single.project.totals.input_tokens, 10);
  assert.equal(single.project.totals.output_tokens, 0);
  assert.equal(single.project.requests, 2);
  assert.ok(!Object.hasOwn(single, 'window'));
});

test('account limit is as of the latest exported snapshot per ID, across project labels', t => {
  const f = fixture(t);
  const rates = (minute, pct, limit = 'main') => event(minute, null, {rate_limits: {
    limit_id: limit, primary: {used_percent: pct, window_minutes: 300, resets_at: 1768492800}
  }});
  f.set([meta('A', {project: 'one'}), rates(3, 30), meta('B', {project: 'two'}), rates(2, 20),
    rates(1, 0, 'other'), rates(5, 50)]);
  const report = f.audit('window', '--project', 'one', '--until', timestamp(5));
  assert.ok(!Object.hasOwn(report, 'project'));
  assert.equal(report.window.observations.length, 2);
  assert.equal(report.window.observations[0].primary.used_percent, 30);
  assert.equal(report.window.observations[0].secondary, null);
  assert.equal(report.window.observations[0].asOf, '2026-01-15T10:03:00.000Z');
  assert.equal(report.window.observations[1].primary.used_percent, 0);
});

test('live account limits cut a half-open all-project window and repository labels attribute export usage', t => {
  const f = fixture(t);
  f.set([meta('A', {project:'one',repository:'products/api'}),delta(2,'a',{total_tokens:4}),
    meta('B', {project:'two',repository:'products/web'}),delta(3,'b',{total_tokens:5}),delta(8,'c',{total_tokens:9})]);
  const file = join(f.cwd,'limits.json');
  writeFileSync(file,JSON.stringify({observedAt:timestamp(7),rateLimitsByLimitId:{main:{primary:{
    usedPercent:42,windowDurationMins:5,resetsAt:Date.parse(timestamp(10))/1000
  }}}}));
  const report = f.audit('--limits',file,'--project','one','--by-repo','--time');
  assert.equal(report.window.observations[0].primary.remaining_percent,58);
  assert.equal(report.window.observations[0].primary.since,'2026-01-15T10:05:00.000Z');
  assert.equal(report.window.observations[0].primary.usage.totals.total_tokens,null);
  assert.deepEqual(report.byRepo.groups.map(row => [row.repository,row.totals.total_tokens]),[['products/api',4]]);
  assert.equal(report.time.rows[0].firstUsage,'2026-01-15T10:02:00.000Z');
  assert.equal(report.time.value,null);
  writeFileSync(file,JSON.stringify({observedAt:timestamp(7),rateLimitsByLimitId:{main:{primary:{
    usedPercent:42,windowDurationMins:10,resetsAt:Date.parse(timestamp(10))/1000
  }}}}));
  assert.equal(f.audit('window','--limits',file,'--project','one').window.observations[0].primary.usage.totals.total_tokens,9);
});

test('unavailable counters on empty input; no default transcript access; saving only to new files', t => {
  const f = fixture(t);
  const privateFile = join(f.profile, 'sessions', 'fake.jsonl');
  writeFileSync(privateFile, 'INVALID-SYNTHETIC-FIXTURE');
  const missing = JSON.parse(f.run().stdout);
  assert.equal(missing.inputProvided, false);
  assert.equal(missing.project.totals.total_tokens, null);
  assert.ok(missing.window.reason);
  assert.match(f.run('--input', privateFile).stderr, /outside private session storage/);
  f.set([]);
  assert.equal(f.audit().project.sessions, 0);
  const file = join(f.cwd, 'report.json');
  const out = f.run('--input', f.path, '--json', file);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readFileSync(file, 'utf8'), out.stdout);
  assert.notEqual(f.run('--input', f.path, '--json', file).status, 0);
});

test('ambiguous deltas, falling counters, wrong format and ambiguous time fail without a partial report', t => {
  const f = fixture(t);
  for (const events of [
    [event(1, {last_token_usage: {total_tokens: 15}})],
    [delta(1, 'r', {total_tokens: 10}), delta(1, 'r', {total_tokens: 20})],
    [snapshot(1, {total_tokens: 20}), delta(2, 'r', {total_tokens: 10})],
    [snapshot(1, {total_tokens: 20}), snapshot(2, {total_tokens: 10})],
    [snapshot(1, {total_tokens: -1})], [snapshot(1, {input_tokens: '0'})],
    [{timestamp: timestamp(2), type: 'response_item', payload: {type: 'message', text: 'fixture-only'}}]
  ]) {
    f.set([meta('A'), ...events]);
    const result = f.run('--input', f.path);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('fixture-only'));
  }
  assert.notEqual(f.run('--since', '2026-02-30T10:00:00').status, 0);
  assert.notEqual(f.run('--since', timestamp(5), '--until', timestamp(5)).status, 0);
});

test('local period bounds follow the workspace runner zone and report normalized UTC', t => {
  const f = fixture(t,'Europe/Moscow');
  f.set([meta('fixture'),delta(1,'a',{total_tokens:5})]);
  const report = f.audit('--since','2026-01-15','--until','2026-01-15T13:02:00');
  assert.equal(report.period.since,'2026-01-14T21:00:00.000Z');
  assert.equal(report.period.untilExclusive,'2026-01-15T10:02:00.000Z');
  assert.equal(report.project.totals.total_tokens,5);
});

test('explicit request measurements deduplicate and stay within the selected period', t => {
  const f = fixture(t);
  const row = (minute, id, input, measurements) => event(minute,
    {total_token_usage: {input_tokens: minute * 100}, last_token_usage: {input_tokens: input}},
    {request_id: id, request_metrics: measurements});
  const first = row(2, 'r1', 10, {
    tools: [{start_ms: 0, end_ms: 4, read_id: 'file-a'}, {start_ms: 2, end_ms: 6, read_id: null}],
    model_ms: 8, idle_ms: 2, cache_write_input_tokens: 3, cost: {currency: 'USD', micros: 4}
  });
  const second = row(3, 'r2', 20, {
    tools: [{start_ms: 0, end_ms: 1, read_id: 'file-a'}],
    model_ms: 9, idle_ms: 0, cache_write_input_tokens: 2, cost: {currency: 'USD', micros: 6}
  });
  f.set([meta('a'), snapshot(1, {input_tokens: 100}), first, second, first,
    row(4, 'r3', 999, {})]);
  const report = f.audit('--since', timestamp(2), '--until', timestamp(4), '--time');
  assert.equal(report.project.totals.input_tokens, 200);
  assert.equal(report.project.requests, 2);
  const measurements = report.project.measurements;
  assert.deepEqual(measurements.inputTokens, {p10: 10, p50: 10, p90: 20, p99: 20, max: 20});
  assert.equal(measurements.repeatedReads, 1);
  assert.equal(measurements.maxConcurrentTools, 2);
  assert.equal(measurements.cacheWriteInputTokens, 5);
  assert.deepEqual(measurements.cost, {currency: 'USD', micros: 10});
  assert.deepEqual(report.time.value, {modelMs: 17, toolMs: 7, idleMs: 2});
  assert.deepEqual(report.project.groups[0].measurements, measurements);
  assert.equal(report.unavailable.cost, undefined);

  const incomplete = f.audit('--since', timestamp(2), '--time');
  assert.equal(incomplete.project.measurements.cacheWriteInputTokens, null);
  assert.equal(incomplete.project.measurements.cost, null);
  assert.equal(incomplete.project.measurements.repeatedReads, null);
  assert.equal(incomplete.time.value, null);
  assert.ok(incomplete.unavailable.cache_writes.includes('cache_write_input_tokens'));
});

test('tool intervals preserve measured zero and reject paths and conflicting repeated metrics', t => {
  const f = fixture(t);
  const tool = (start_ms, end_ms, read_id = null) => ({start_ms, end_ms, read_id});
  const samples = tools => event(1, {last_token_usage: {input_tokens: 0}},
    {request_id: 'sample', request_metrics: {tools, model_ms: 0, idle_ms: 0}});
  const adjacent = samples([tool(0, 2), tool(2, 4)]);
  f.set([meta('a'), adjacent]);
  const report = f.audit('--time');
  assert.equal(report.project.measurements.maxConcurrentTools, 1);
  assert.equal(report.project.measurements.repeatedReads, 0);
  assert.deepEqual(report.time.value, {modelMs: 0, toolMs: 4, idleMs: 0});
  f.set([meta('a'), adjacent, samples([])]);
  assert.match(f.run('--input', f.path).stderr, /Conflicting repeated request/);
  f.set([meta('a'), samples([tool(0, 2, 'project/source.js')])]);
  assert.match(f.run('--input', f.path).stderr, /Expected anonymized tools.read_id/);
});

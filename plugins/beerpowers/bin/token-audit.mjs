#!/usr/bin/env node
// Разбирает экспорт статистики, суммирует расход токенов и находит дорогие этапы.
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const help = 'Usage: node token-audit.mjs [project|window] [--input metrics.jsonl] [--limits account.json] [--project LABEL | --all-projects] [--since ISO] [--until ISO] [--top N] [--time] [--by-repo] [--json NEW-REPORT.json]';
const keys = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const unavailable = {
  cost: 'Requires request_metrics.cost from applicable billing data, in one currency.',
  billed_tokens: 'Token counters do not define billed tokens or subscription units.',
  remaining_requests: 'Usage percentages do not specify a token or request conversion.',
  request_coverage: 'Requires a stable request_id on each in-period usage observation to identify the complete request sample.',
  request_percentiles: 'Requires complete request_id coverage and info.last_token_usage.input_tokens.',
  cache_writes: 'Requires measured request_metrics.cache_write_input_tokens.',
  cache_write_ttl: 'Requires cache-write token counters by TTL from the provider.',
  tool_parallelism: 'Requires measured request_metrics.tools intervals; runtime image weights and polling classifications are not provided.',
  repeated_reads: 'Requires request_metrics.tools with stable, anonymized read_id labels.',
  elapsed_by_activity: 'Requires measured request_metrics.model_ms, idle_ms and tools intervals.',
  repo_attribution: 'The export must supply a repository label for each usage session. No tool path traces or per-request attribution are available.'
};
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;

function time(value, label, localBounds = false) {
  const parsed = typeof value === 'string' && /^(\d{4}-\d\d-\d\d)(?:T(\d\d:\d\d(?::\d\d(?:\.\d+)?)?)(Z|[+-]\d\d:\d\d)?)?$/.exec(value);
  if (!parsed || (parsed[2] && !parsed[3] && !localBounds)) {
    throw new Error(`Expected ISO date or timestamp${localBounds ? '' : ' with timezone'}: ${label}`);
  }
  const ms = Date.parse(localBounds && !parsed[2] ? value + 'T00:00:00' : value);
  if (!Number.isFinite(ms) || new Date(Date.parse(value.slice(0, 10))).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`Invalid date: ${label}`);
  }
  return ms;
}

function counters(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Expected token counter object');
  return Object.fromEntries(keys.map(key => {
    const n = object[key] ?? null;
    if (n !== null && (!Number.isSafeInteger(n) || n < 0)) throw new Error(`Invalid counter: ${key}`);
    return [key, n];
  }));
}

function measurement(value, key) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid request metric: ${key}`);
  return value;
}

function requestMetrics(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid request_metrics');
  const numeric = Object.fromEntries(['model_ms', 'idle_ms', 'cache_write_input_tokens'].map(key =>
    [key, source[key] == null ? null : measurement(source[key], key)]));
  let tools = null;
  if (source.tools != null) {
    if (!Array.isArray(source.tools)) throw new Error('Invalid request metric: tools');
    tools = source.tools.map(tool => {
      const start = measurement(tool?.start_ms, 'tools.start_ms');
      const end = measurement(tool?.end_ms, 'tools.end_ms');
      if (end <= start) throw new Error('Tool interval must have positive duration');
      const read = tool.read_id;
      if (read !== undefined && read !== null && (typeof read !== 'string' || !/^[\w-]+$/.test(read))) {
        throw new Error('Expected anonymized tools.read_id');
      }
      return {start, end, read};
    });
  }
  let cost = null;
  if (source.cost != null) {
    const {currency, micros} = source.cost;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid request metric: cost.currency');
    cost = {currency, micros: measurement(micros, 'cost.micros')};
  }
  return {...numeric, tools, cost};
}

function toolActivity(tools) {
  if (tools === null) return {duration: null, peak: null};
  const edges = tools.flatMap(({start, end}) => [[start, 1], [end, -1]])
    .sort(([a, changeA], [b, changeB]) => a - b || changeA - changeB);
  let duration = 0, peak = 0, active = 0, previous = 0;
  for (const [offset, change] of edges) {
    if (active) duration += offset - previous;
    active += change;
    peak = Math.max(peak, active);
    previous = offset;
  }
  return {duration, peak};
}

function diagnostics(requests) {
  const sum = key => exactSum(requests.map(request => request.metrics[key]));
  const input = requests.map(request => request.input);
  const completeInput = input.length && input.every(value => value !== null);
  input.sort((a, b) => a - b);
  const quantile = p => input[Math.ceil(p * input.length) - 1];
  const tools = requests.map(request => request.metrics.tools);
  const activity = tools.map(toolActivity);
  const reads = tools.flatMap(calls => calls?.map(call => call.read) ?? [undefined]);
  const knownReads = requests.length && !reads.includes(undefined);
  const readIds = reads.filter(read => typeof read === 'string');
  const costs = requests.map(request => request.metrics.cost);
  const currency = costs[0]?.currency;
  return {
    inputTokens: completeInput ? {p10: quantile(.1), p50: quantile(.5), p90: quantile(.9), p99: quantile(.99), max: input.at(-1)} : null,
    repeatedReads: knownReads ? readIds.length - new Set(readIds).size : null,
    maxConcurrentTools: requests.length && !tools.includes(null)
      ? activity.reduce((peak, item) => Math.max(peak, item.peak), 0) : null,
    cacheWriteInputTokens: sum('cache_write_input_tokens'),
    cost: currency && costs.every(cost => cost?.currency === currency)
      ? {currency, micros: exactSum(costs.map(cost => cost.micros))} : null,
    time: {modelMs: sum('model_ms'), toolMs: exactSum(activity.map(item => item.duration)), idleMs: sum('idle_ms')}
  };
}

function exactSum(values) {
  if (!values.length || values.some(value => value === null)) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) throw new Error('Total exceeds the exact integer range');
  return sum;
}

function rateWindow(window) {
  if (!window) return null;
  const copy = {};
  for (const [key, max] of [['used_percent', 100], ['window_minutes', Infinity], ['resets_at', Infinity]]) {
    const value = window[key] ?? null;
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > max)) throw new Error(`Invalid rate limit: ${key}`);
    copy[key] = value;
  }
  return copy;
}

async function explicitSource(path) {
  const canonical = await realpath(path);
  const configuredHome = process.env.CODEX_HOME;
  const home = configuredHome && await realpath(configuredHome).catch(error => {
    if (error.code === 'ENOENT') return resolve(configuredHome);
    throw error;
  });
  const parts = canonical.toLowerCase().split(/[\\/]/);
  if (parts.some((part, i) => part === '.codex' && ['sessions', 'archived_sessions'].includes(parts[i + 1])) ||
      (home && ['sessions', 'archived_sessions'].some(folder => {
        const rel = relative(resolve(home, folder), canonical);
        return !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
      }))) throw new Error('Select a sanitized metrics export outside private session storage');
  if (!(await stat(canonical)).isFile()) throw new Error('Expected one metrics file');
  return canonical;
}

async function readExport(path, since, until) {
  const canonical = await explicitSource(path);
  const sessions = new Map();
  const windows = new Map();
  let session;
  let row = 0;
  const lines = createInterface({input: createReadStream(canonical, 'utf8'), crlfDelay: Infinity});
  for await (const line of lines) {
    row++;
    if (!line.trim()) continue;
    try {
      let entry;
      try { entry = JSON.parse(line.replace(/^\uFEFF/, '')); }
      catch { throw new Error('Malformed JSON'); }
      const payload = entry?.payload;
      if (!payload || typeof payload !== 'object') throw new Error('Missing event payload');
      const timestamp = time(entry.timestamp, 'timestamp');
      if (entry.type === 'session_meta') {
        if (typeof payload.id !== 'string' || !payload.id.trim()) throw new Error('Missing session ID');
        const tags = Object.fromEntries(['project', 'role', 'model','repository'].map(key => {
          const value = payload[key] ?? null;
          if (value !== null && (typeof value !== 'string' || !value.trim())) throw new Error(`Invalid session label: ${key}`);
          return [key, value];
        }));
        session = sessions.get(payload.id);
        if (!session) {
          session = {id: payload.id, tags, start: timestamp, kind: null, events: [], requests: new Map(), snapshots: new Set()};
          sessions.set(payload.id, session);
        } else if (JSON.stringify(tags) !== JSON.stringify(session.tags) || timestamp !== session.start) {
          throw new Error('Conflicting metadata for repeated session');
        }
        continue;
      }
      if (entry.type !== 'event_msg' || payload.type !== 'token_count') {
        throw new Error('Expected Codex metrics projection (session_meta or event_msg/token_count)');
      }
      if (!session || timestamp < session.start) throw new Error('Missing or inconsistent session start');
      const rates = payload.rate_limits;
      if (rates && timestamp >= since && timestamp < until) {
        const id = rates.limit_id ?? 'default';
        if (typeof id !== 'string' || !id.length) throw new Error('Invalid rate-limit ID');
        if (!windows.has(id) || timestamp >= windows.get(id).timestamp) {
          windows.set(id, {id, timestamp, primary: rateWindow(rates.primary), secondary: rateWindow(rates.secondary)});
        }
      }
      const info = payload.info;
      if (info == null) continue; // A rate-limit update can carry no usage sample.
      const kind = info.total_token_usage != null ? 'cumulative' : 'request';
      const usage = counters(kind === 'cumulative' ? info.total_token_usage : info.last_token_usage);
      if (session.kind && session.kind !== kind) throw new Error('Mixed cumulative and delta-only accounting in one session');
      session.kind = kind;
      const id = payload.request_id ?? null;
      if (kind === 'request' && id === null) throw new Error('Delta-only usage requires a stable request_id');
      if (id === null && payload.request_metrics != null) throw new Error('request_metrics requires a stable request_id');
      let request = null;
      if (id !== null) {
        if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid request_id');
        request = {timestamp, usage, input: kind === 'request' ? usage.input_tokens :
          info.last_token_usage == null ? null : counters(info.last_token_usage).input_tokens,
          metrics: requestMetrics(payload.request_metrics)};
        const prior = session.requests.get(id);
        if (prior) {
          if (JSON.stringify(request) !== JSON.stringify(prior)) {
            throw new Error('Conflicting repeated request');
          }
          continue;
        }
        session.requests.set(id, request);
      } else {
        const signature = JSON.stringify([timestamp, usage]);
        if (session.snapshots.has(signature)) continue;
        session.snapshots.add(signature);
      }
      session.events.push({timestamp, usage, request});
    } catch (error) {
      throw new Error(`Metrics line ${row}: ${error.message}`);
    }
  }
  return {sessions: [...sessions.values()], windows: [...windows.values()]};
}

async function readLimits(path) {
  const data = JSON.parse((await readFile(await explicitSource(path),'utf8')).replace(/^\uFEFF/,''));
  const timestamp = time(data.observedAt,'observedAt');
  const buckets = data.rateLimitsByLimitId ?? (data.rateLimits ? {[data.rateLimits.limitId ?? 'default']:data.rateLimits} : {});
  if (typeof buckets !== 'object' || Array.isArray(buckets)) throw new Error('Expected a map of Codex rate limit buckets');
  const normalize = window => window ? rateWindow({
    used_percent:window.usedPercent,window_minutes:window.windowDurationMins,resets_at:window.resetsAt
  }) : null;
  return Object.entries(buckets).filter(([,bucket])=>bucket).map(([id,bucket])=>({
    id,timestamp,primary:normalize(bucket.primary),secondary:normalize(bucket.secondary),source:'Codex host usage limits'
  }));
}

function sessionSummary(session, since, until) {
  const ordered = session.events.sort((a, b) => a.timestamp - b.timestamp);
  const observed = ordered.filter(event => event.timestamp >= since && event.timestamp < until);
  if (!observed.length) return null;
  let totals;
  const requests = observed.every(event => event.request) ? observed.length : null;
  let missingBaseline = false;
  if (session.kind === 'request') {
    totals = Object.fromEntries(keys.map(key => [key, exactSum(observed.map(event => event.usage[key]))]));
  } else {
    const prior = ordered.findLast(event => event.timestamp < since);
    const last = observed.at(-1).usage;
    missingBaseline = !prior && session.start < since;
    const previous = {};
    for (const {timestamp, usage} of ordered) {
      if (timestamp >= until) break;
      for (const key of keys) {
        if (usage[key] === null) continue;
        if (usage[key] < previous[key]) throw new Error(`Cumulative counter decreased: ${key}. Check session identity or reset.`);
        previous[key] = usage[key];
      }
    }
    totals = Object.fromEntries(keys.map(key => {
      const base = prior ? prior.usage[key] : missingBaseline ? null : 0;
      return [key, base === null || last[key] === null ? null : last[key] - base];
    }));
  }
  const first = observed[0].timestamp;
  const last = observed.at(-1).timestamp;
  return {session: session.id, ...session.tags, accounting: session.kind, missingBaseline, requests, totals,
    firstUsage:iso(first),lastUsage:iso(last),usageSampleSpanMs:last-first};
}

function aggregate(rows) {
  const totals = Object.fromEntries(keys.map(key => [key, exactSum(rows.map(row => row.totals[key]))]));
  const cachedInputPercent = totals.input_tokens > 0 && totals.cached_input_tokens !== null
    ? 100 * (totals.cached_input_tokens / totals.input_tokens) : null;
  return {sessions: rows.length, requests: exactSum(rows.map(row => row.requests)), totals, cachedInputPercent};
}

function grouped(rows, summarizeRequests) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.project, row.role, row.model]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(group => ({
    project: group[0].project, role: group[0].role, model: group[0].model,
    ...aggregate(group), measurements: summarizeRequests(group)
  }));
}

function windowPeriod(window,timestamp,sessions,limitIds,id) {
  if (!window) return null;
  const end = window.resets_at === null ? NaN : window.resets_at * 1000;
  const start = window.window_minutes > 0 ? end - window.window_minutes * 60000 : NaN;
  const until = Math.min(timestamp + 1,end);
  // The usage projection has no per-event limit bucket. Count only the
  // unpartitioned corpus that falls within the same interval.
  return {...window,remaining_percent:window.used_percent === null ? null : 100-window.used_percent,
    since:iso(start),untilExclusive:iso(end),usageUntilExclusive:iso(until),
    usage:start < until ? aggregate(sessions.map(session=>sessionSummary(session,start,until)).filter(Boolean)) : null,
    usageAttribution:limitIds > 1 ? 'Exported usage across all buckets; no counter identifies bucket ' + id + '.' :
      'Exported usage across projects in the interval; the export may cover only part of the account.'};
}

async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    help: {type: 'boolean'}, input: {type: 'string'}, limits:{type:'string'}, project: {type: 'string'},
    since: {type: 'string'}, until: {type: 'string'}, json: {type: 'string'}, top: {type: 'string', default: '8'},
    'all-projects': {type: 'boolean'}, time: {type: 'boolean'}, 'by-repo': {type: 'boolean'}
  }});
  if (values.help) { console.log(help); return; }
  const mode = positionals[0] ?? 'both';
  if (positionals.length > 1 || !['both', 'project', 'window'].includes(mode)) throw new Error(help);
  if (values.project && values['all-projects']) throw new Error('Choose --project or --all-projects');
  if (!/^[1-9]\d*$/.test(values.top) || !Number.isSafeInteger(Number(values.top))) throw new Error('Expected a positive --top');
  const since = values.since === undefined ? -Infinity : time(values.since, '--since',true);
  const until = values.until === undefined ? Infinity : time(values.until, '--until',true);
  if (since >= until) throw new Error('Expected --since before --until');
  const data = values.input ? await readExport(values.input, since, until) : {sessions: [], windows: []};
  const report = {source: 'Codex metrics export', inputProvided: Boolean(values.input),liveLimitsProvided:Boolean(values.limits),
    period: {since: iso(since), untilExclusive: iso(until)}, unavailable: {...unavailable}};
  const selected = data.sessions.filter(session => !values.project || session.tags.project === values.project);
  const rows = mode !== 'window' || values.time || values['by-repo']
    ? selected.map(session => sessionSummary(session, since, until)).filter(Boolean) : [];
  const selectedById = new Map(selected.map(session => [session.id, session]));
  const summarizeRequests = group => diagnostics(group.every(row => row.requests !== null)
    ? group.flatMap(row => [...selectedById.get(row.session).requests.values()]
      .filter(request => request.timestamp >= since && request.timestamp < until))
    : []);
  const measurements = summarizeRequests(rows);
  const durations = Object.values(measurements.time);
  for (const [key, known] of Object.entries({
    request_coverage: rows.length && rows.every(row => row.requests !== null),
    request_percentiles: measurements.inputTokens !== null,
    repeated_reads: measurements.repeatedReads !== null,
    tool_parallelism: measurements.maxConcurrentTools !== null,
    cache_writes: measurements.cacheWriteInputTokens !== null,
    cost: measurements.cost !== null,
    elapsed_by_activity: !durations.includes(null)
  })) if (known) delete report.unavailable[key];
  if (mode !== 'window') {
    const topSessions = rows.filter(row => row.totals.total_tokens !== null)
      .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens).slice(0, Number(values.top)).map(row => row.session);
    report.project = {label: values.project ?? null, ...aggregate(rows), groups: grouped(rows, summarizeRequests),
      rows, topSessions, measurements};
    if (!rows.length) report.project.reason = values.input ? 'No matching usage samples in export.' : 'No metrics export supplied.';
  }
  if (values.time) report.time = {value:durations.every(value => value === null) ? null : measurements.time,
    reason:durations.includes(null) ? unavailable.elapsed_by_activity : null,
    rows:rows.map(({session,role,firstUsage,lastUsage,usageSampleSpanMs})=>({session,role,firstUsage,lastUsage,usageSampleSpanMs}))};
  if (values['by-repo']) {
    const labels = [...new Set(rows.map(row=>row.repository))].filter(Boolean);
    const unlabelled = rows.filter(row=>!row.repository);
    report.byRepo = {value:null,reason:unlabelled.length || !labels.length ? unavailable.repo_attribution : null,
      attribution:'Session repository labels supplied by the export',
      groups:labels.map(repository=>({repository,...aggregate(rows.filter(row=>row.repository === repository))})),
      unattributed:aggregate(unlabelled)};
  }
  if (mode !== 'project') {
    const limits = values.limits ? await readLimits(values.limits) : [];
    const live = new Map(limits.filter(row=>row.timestamp >= since && row.timestamp < until).map(row=>[row.id,row]));
    for (const row of data.windows) {
      if (!live.has(row.id) || row.timestamp > live.get(row.id).timestamp) live.set(row.id,row);
    }
    report.window = {observations: [...live.values()].map(({id,timestamp,primary,secondary,source}) => ({
      id,asOf:iso(timestamp),source:source ?? 'Codex metrics export',
      primary:windowPeriod(primary,timestamp,data.sessions,live.size,id),
      secondary:windowPeriod(secondary,timestamp,data.sessions,live.size,id)
    })),coverage:'Latest observed account snapshot per limit ID in period. Window usage includes all project labels in the export.'};
    if (!live.size) report.window.reason = 'No host usage limits or exported account snapshot available in period.';
  }
  const body = JSON.stringify(report, null, 2) + '\n';
  if (values.json) await writeFile(values.json, body, {flag: 'wx'});
  process.stdout.write(body);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

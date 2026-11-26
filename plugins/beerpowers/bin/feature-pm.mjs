// Проверяет продуктовые артефакты фичи перед переходами PM-конвейера.
import { lstat, readFile } from 'node:fs/promises';

const [slug, ...extra] = process.argv.slice(2);
const usage = 'Usage: node feature-pm.mjs <feature-slug> (run from the outer workspace)';

// An absent artifact is normal during intake. A symlink or malformed artifact
// is a different condition and must never turn into an instruction to start over.
async function readWorkspaceFile(path) {
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join('/');
    const stat = await lstat(prefix).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!stat) return null;
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Unexpected file type: ${prefix}`);
    }
  }
  return readFile(path, 'utf8');
}

function field(header, key, path) {
  const matches = header.split(/\r?\n/).filter(line => line.startsWith(`${key}:`));
  if (matches.length > 1) throw new Error(`Duplicate ${key}: ${path}`);
  return matches[0]?.slice(key.length + 1).trim();
}

function prose(body) {
  let fence;
  return body.split(/\r?\n/).map(line => {
    if (fence) {
      if (line.trim().startsWith(fence) && [...line.trim()].every(char => char === fence[0])) fence = null;
      return '';
    }
    fence = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    return fence ? '' : line;
  }).join('\n');
}

function hasHandoff(body) {
  const visible = prose(body).split('\n');
  const heading = visible.findIndex(line => /^## Handoff[ \t]*$/.test(line));
  if (heading < 0) return false;
  const end = visible.findIndex((line, i) => i > heading && /^#{1,2}\s/.test(line));
  return body.split(/\r?\n/).slice(heading + 1, end < 0 ? undefined : end)
    .some(line => line.trim() && !/^\s*(?:`{3,}|~{3,})/.test(line));
}

async function inspect() {
  if (!slug || extra.length || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)) throw new Error(usage);
  const dir = `docs/features/${slug}`;
  const full = ['prd', 'decomposition', 'estimate', 'plan'];
  const states = {};
  let track;
  let handoff;
  for (const name of ['intake', 'feature-brief', ...full]) {
    const path = `${dir}/${name}.md`;
    const body = await readWorkspaceFile(path);
    if (body === null) continue;
    const header = prose(body.replace(/^\uFEFF/, '')).split(/^##\s/m, 1)[0];
    const status = field(header, 'Status', path);
    if (!['Draft', 'Approved', 'In Development', 'Done'].includes(status) ||
        field(header, 'Slug', path) !== slug) throw new Error(`Invalid Slug or Status: ${path}`);
    states[name] = status;
    if (name === 'intake') {
      track = field(header, 'Track', path);
      if (track && !['fast', 'full'].includes(track)) throw new Error(`Invalid Track: ${path}`);
    }
  }
  const hasFull = full.some(name => states[name]);
  if (hasFull && (track === 'fast' || (!track && states['feature-brief']))) {
    throw new Error('Conflicting artifacts. Reconcile the approved track in intake.md.');
  }
  track ??= hasFull ? 'full' : states['feature-brief'] ? 'fast' : undefined;
  const approved = name => states[name] && states[name] !== 'Draft';
  let next;
  if (!approved('intake')) next = 'intake';
  else if (!track) next = 'choose-track';
  else if (track === 'fast' && !approved('feature-brief')) next = 'feature-brief';
  else if (track === 'full' && !approved('prd')) next = 'prd';
  else if (track === 'full' && !states.decomposition) next = 'decomposition';
  else if (track === 'full' && (!approved('decomposition') || !approved('estimate'))) next = 'estimate';
  else if (track === 'full' && !approved('plan')) next = 'plan';
  else {
    const file = `${dir}/${track === 'full' ? 'plan' : 'feature-brief'}.md`;
    const body = await readWorkspaceFile(file);
    if (!hasHandoff(body)) throw new Error(`Approved document lacks a Handoff section: ${file}`);
    const registry = await readWorkspaceFile('memory/decisions.md') ?? '';
    const rows = prose(registry).split('\n').filter(line => {
      const columns = line.trim().replace(/^-\s+/, '').split(/\s+·\s+/);
      return columns.length === 3 && /^\d{4}-\d{2}-\d{2}$/.test(columns[0]) &&
        columns[1].length > 0 && columns[2] === `${dir}/`;
    });
    if (rows.length > 1) throw new Error(`Duplicate decision pointer: ${dir}/`);
    next = rows.length ? 'complete' : 'handoff';
    handoff = file;
  }
  console.log(JSON.stringify({slug, directory: dir, track: track ?? null, next, states, handoff}, null, 2));
}

if (slug === '--help' && !extra.length) console.log(usage);
else inspect().catch(error => { console.error(error.message); process.exitCode = 1; });

// Сверяет восстановление настроек setup при обновлении собранного workspace.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workspacePath } from './ui-workspace.mjs';

function perlPath() {
  if (process.env.BEERPOWERS_PERL) return process.env.BEERPOWERS_PERL;
  if (process.platform !== 'win32') return 'perl';
  const git = execFileSync('where.exe', ['git.exe'], {encoding: 'utf8', windowsHide: true}).split(/\r?\n/)[0];
  return join(dirname(dirname(git)), 'usr', 'bin', 'perl.exe');
}

function savedChecks(root) {
  const products = readdirSync(workspacePath(root, 'projects'), {withFileTypes:true})
    .filter(item => item.isDirectory() && lstatSync(join(root, 'projects', item.name, '.git'), {throwIfNoEntry:false}));
  const checks = Object.create(null);
  for (const {name} of products) {
    const path = 'memory/commands/' + name + '.md';
    const content = readFileSync(workspacePath(root, path), 'utf8').replaceAll('\r\n', '\n');
    const source = /^Источник: \x60([^\x60\n]+)\x60$/m.exec(content)?.[1];
    const command = /^\x60{3}text\n([^\n]+)\n\x60{3}$/m.exec(content)?.[1];
    if (!source || !command) throw Error('Missing saved test command/source: ' + path);
    checks[name] = {command, source};
  }
  return checks;
}

export function workspaceCheck(root, pkg, mode) {
  const checks = mode === 'plan-json' ? savedChecks(root) : {};
  const env = {...process.env, BEERPOWERS_TESTS_JSON:JSON.stringify(checks)};
  delete env.BEERPOWERS_TRACK; // An update preserves the chosen product/development track.
  try {
    return execFileSync(perlPath(), [join(pkg, 'bin', 'workspace.pl'), mode], {
      cwd:root, env, windowsHide:true, maxBuffer:32 * 1024 * 1024, encoding:'utf8', stdio:['ignore','pipe','pipe'],
    });
  } catch (error) {
    throw Error('workspace.pl ' + mode + ': ' + (error.stderr?.trim() || error.message));
  }
}

// Same plan as interactive setup. Base64 preserves CRLF, empty files and the
// absence of a final newline regardless of the calling shell's encoding.
export function setupAdditions(root, pkg) {
  const plan = JSON.parse(workspaceCheck(root, pkg, 'plan-json'));
  if (plan.format !== 1 || !Array.isArray(plan.changes)) throw Error('Unrecognized setup preview');
  return plan.changes.map(({action, path, content}) => {
    if (!/^(?:\.codex\/|memory\/|AGENTS\.md$|\.gitignore$)/.test(path)) throw Error('Unexpected setup target: ' + path);
    workspacePath(root, path);
    if (!['CREATE','APPEND','UPDATE'].includes(action)) throw Error('Unexpected setup action: ' + action);
    const addition = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(Buffer.from(content, 'base64'));
    return {path, action, addition};
  });
}

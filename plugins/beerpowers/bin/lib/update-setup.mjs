// Сверяет восстановление настроек setup при обновлении собранного workspace.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { workspacePath } from './ui-workspace.mjs';

function perlPath() {
  if (process.env.BEERPOWERS_PERL) return process.env.BEERPOWERS_PERL;
  if (process.platform !== 'win32') return 'perl';
  const git = execFileSync('where.exe', ['git.exe'], {encoding: 'utf8', windowsHide: true}).split(/\r?\n/)[0];
  return join(dirname(dirname(git)), 'usr', 'bin', 'perl.exe');
}

export function workspaceCheck(root, pkg, mode) {
  const env = {...process.env};
  delete env.BEERPOWERS_TESTS_JSON;
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
  const changes = plan.changes.map(({action, path, content}) => {
    if (!/^(?:\.codex\/|memory\/|AGENTS\.md$|\.gitignore$)/.test(path)) throw Error('Unexpected setup target: ' + path);
    workspacePath(root, path);
    if (!['CREATE','APPEND','UPDATE'].includes(action)) throw Error('Unexpected setup action: ' + action);
    const addition = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(Buffer.from(content, 'base64'));
    return {path, action, addition};
  });
  return {changes, advisories: plan.advisories ?? []};
}

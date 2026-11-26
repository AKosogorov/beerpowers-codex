#!/usr/bin/env node
// Собирает результаты интерфейсной приёмки и проверяет обязательные ширины.
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {findRoot, loadWorkspace, workspacePath} from './lib/ui-workspace.mjs';

import { showHelp } from './lib/cli-help.mjs';

showHelp('ui-acceptance.mjs discover REPO... | matrix TASK REPO...', ['discover', 'matrix']);

const root = findRoot();
const [operation, ...args] = process.argv.slice(2);
const read = path => readFileSync(workspacePath(root, path), 'utf8');

function discover(repos) {
    if (!repos.length) throw Error('Expected UI product names');
    const result = [];
    for (const repo of repos) {
        if (!/^[\w.-]+$/.test(repo)) throw Error('Invalid product name');
        const product = workspacePath(root, 'projects/' + repo);
        const files = execFileSync('git', ['-C', product, 'ls-files', '-z'], {encoding:'utf8'}).split('\0');
        for (const file of files) {
            const config = /(?:tailwind|uno|windi)\.config\.[cm]?[jt]s$/.test(file);
            if (!config && !/\.(?:css|scss|sass|less|vue|svelte)$/.test(file)) continue;
            const lines = read(`projects/${repo}/${file}`).split(/\r?\n/);
            lines.forEach((line, i) => {
                const pattern = config ? /\b([\w-]+)\s*:\s*['"](\d+(?:\.\d+)?)(px|rem)['"]/g
                    : /(?:--breakpoint-([\w-]+)\s*:\s*|(?:min-|max-)?width\s*[:<>]=?\s*)(\d+(?:\.\d+)?)(px|rem)\b/g;
                if (!config && !/@media|--breakpoint-|\b(?:min|max)-width\s*:[^)]*\)/.test(line)) return;
                const declaration = !config && /@media/.test(line) ? line.split('{', 1)[0] : line;
                for (const [, name, value, unit] of declaration.matchAll(pattern)) {
                    result.push({width: Math.ceil(Number(value) * (unit === 'rem' ? 16 : 1)), name: name ?? null,
                        source: `projects/${repo}/${file}:${i + 1}`, declaration: line.trim()});
                }
            });
        }
    }
    return result.sort((a, b) => a.width - b.width);
}

function matrix(task, repos) {
    if (!repos.length || !task) throw Error('Expected task and affected UI products');
    const {viewports} = loadWorkspace(root);
    const layout = spawnSync(process.execPath, [fileURLToPath(new URL('layout-check.mjs', import.meta.url)), task, ...repos],
        {cwd:root, encoding:'utf8', windowsHide:true});
    const brief = read(`memory/tasks/${task}/preflight.md`);
    const key = [...repos].sort().join(',');
    const decisions = brief.split(/\r?\n/).filter(line => line.startsWith(`UI widths [${key}]: `));
    const last = decisions.at(-1);
    const approved = last && /^UI widths \[[^\]]+\]: approved (\S+) (\d{4}-\d{2}-\d{2}) — (\S.*)$/.exec(last);
    const viewport = approved && viewports.find(item => item.name === approved[1]);
    const valid = layout.status === 0 && Boolean(viewport);
    return {layout:layout.status, output:layout.stdout, diagnostics:layout.stderr,
        canPropose:layout.status === 0 && (!last || last.includes(']: revoked ')),
        proposed:layout.status === 0 ? [...viewports].sort((a,b) => b.width-a.width)[0] : null,
        viewports:valid ? [viewport] : viewports, activeDecision:valid ? last : null,
        revoke:Boolean(approved) && !valid};
}

try {
    if (operation !== 'discover' && operation !== 'matrix') throw Error('Usage: ui-acceptance.mjs discover REPO... | matrix TASK REPO...');
    console.log(JSON.stringify(operation === 'discover' ? discover(args) : matrix(args[0], args.slice(1)), null, 2));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}

// Находит корень workspace, проверяет границы путей и читает проектные настройки браузерных проверок.
import fs from 'node:fs'
import path from 'node:path'

export function findRoot() {
  return fs.realpathSync.native(process.cwd())
}

// The plugin executes from its cache with the outer workspace as cwd.
export function workspacePath(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split('/').some(part =>
    !part || /^\.{1,2}$/.test(part) || /[\\:\x00-\x1f]/.test(part))) throw Error('Unsafe workspace path: ' + relative)
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if (fs.lstatSync(current, {throwIfNoEntry: false})?.isSymbolicLink()) throw Error('Linked path: ' + current)
  }
  return current
}

export function taskDirectory(root, task) {
  const dir = workspacePath(root, 'memory/tasks/' + task)
  if (!fs.statSync(dir, {throwIfNoEntry:false})?.isDirectory()) throw Error('Task directory missing: ' + task)
  return dir
}

export function loadWorkspace(root) {
  const cfg = JSON.parse(fs.readFileSync(workspacePath(root, '.codex/workspace.json'), 'utf8').replace(/^\uFEFF/, ''))
  const viewports = cfg.viewports ?? [
    {name:'mobile', width:375, height:667, mobile:true},
    {name:'desktop', width:1440, height:900, mobile:false},
  ]
  if (!Array.isArray(viewports) || !viewports.length || new Set(viewports.map(v => v.name)).size !== viewports.length ||
      viewports.some(v => !v.name || !Number.isInteger(v.width) || v.width < 1 ||
        !Number.isInteger(v.height) || v.height < 1 || typeof v.mobile !== 'boolean')) throw Error('Invalid .codex/workspace.json viewports')
  return {root, viewports, viewportsDefault: cfg.viewports === undefined, config:{tasksDir:'memory/tasks'}, problems:[]}
}

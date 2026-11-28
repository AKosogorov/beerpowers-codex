// Готовит данные интеграций задачи и привязывает их к зарегистрированному checkout.
import fs from 'node:fs'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {formatFlow} from './git-flow-format.mjs'
import {branchName, checkedOut, discover, git, root, safe, taskCheckout, taskData} from './lib/git-repositories.mjs'
import {markupLines} from './lib/markdown-engine.mjs'

import { showHelp } from './lib/cli-help.mjs';

showHelp('task-integrations.mjs task-plan|task-start TASK... [--repo REPO] [--worktree]', ['task-plan', 'task-start']);

const [mode,...argv] = process.argv.slice(2)
const stateFile = '.git/beerpowers-task-start-7.json'
const digest = value => createHash('sha256').update(value).digest('hex')
const text = file => fs.existsSync(safe(file)) ? fs.readFileSync(safe(file),'utf8') : null
const hash = value => value === null ? null : digest(value.replace(/\r\n/g,'\n'))
const quote = s => s.replace(/\r\n/g,'\n').replace(/^/gm,'> ')
const stop = m => { throw Error(m) }

function write(file, value) {
  fs.mkdirSync(path.dirname(safe(file)),{recursive:true})
  const tmp = safe('.git/beerpowers-' + randomUUID())
  try { fs.writeFileSync(tmp,value,{flag:'wx'}); fs.renameSync(tmp,safe(file)) }
  finally { fs.rmSync(tmp,{force:true}) }
}

function adapter(name, args, extraEnv) {
  const file = fileURLToPath(new URL('./' + name + '.mjs',import.meta.url))
  const p = spawnSync(process.execPath,[file,...args],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,
    env:{...process.env,...extraEnv}})
  if (p.status !== 0) stop(p.stderr?.trim() || p.error?.message || name + ' failed')
  return JSON.parse(p.stdout)
}

function parse() {
  const args = [], codes = [], seen = new Set()
  let preview = false, tail = false
  for (let i=0; i<argv.length; i++) {
    const a = argv[i]
    if (tail) { args.push(a); continue }
    if (a === '--preview') { preview = true; continue }
    args.push(a)
    if (a === '--') { tail = true; continue }
    if (a === '--repo') { args.push(branchName(argv[++i])); continue }
    if (['--worktree','--copy-env','--no-deps'].includes(a)) continue
    const [code,release,...rest] = a.split('@')
    branchName(code,true)
    if (release !== undefined) branchName(release)
    if (seen.has(code.toLowerCase()) || rest.length) stop('Invalid or repeated task: ' + code)
    if (codes.some(other => other.startsWith(code + '/') || code.startsWith(other + '/'))) stop('Nested task names in batch')
    seen.add(code.toLowerCase()); codes.push(code)
  }
  if (!codes.length) stop('Expected task code')
  return {args,codes,preview}
}

function issue(code) { return /^[A-Z][A-Z0-9_]*-[0-9]+$/.test(code) }

function briefFor(code, input, before, tracker, preview) {
  const data = input.byTask?.[code] ?? input
  const fromFile = /^Класс: (feature|lean|trivial)\./m.exec(before || '')?.[1]
  if (fromFile && data.class && fromFile !== data.class) stop('Class differs from saved preflight: ' + code)
  const kind = fromFile ?? data.class
  if (!['feature','lean','trivial'].includes(kind)) {
    if (tracker && preview && !before) return {kind:null,body:null}
    stop('Expected class lean, feature or trivial for ' + code)
  }
  let body = before
  if (body === null) {
    const statement = tracker?.statement || data.statement
    if ([statement,data.reason,data.scope,data.acceptance,data.forks,data.stops].some(v=>typeof v !== 'string' || !v.trim() || v.includes('\0')))
      stop('Missing brief for ' + code)
    body = '# ' + code + '\n\n## Исходная постановка\n\n' + quote(statement) + '\n\nКласс: ' + kind + '. ' + data.reason +
      '\n\nГраницы: ' + data.scope + '\n\nПриёмка: ' + data.acceptance + '\n\nРазвилки: ' + data.forks + '\n\nСтоп-условия: ' + data.stops + '\n'
  }
  for (const note of data.clarifications ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(note.date) || !note.quote?.trim() || !note.effect?.trim()) stop('Invalid dated clarification')
    const block = '### ' + note.date + ' — уточнение пользователя\n\n' + quote(note.quote) + '\n\nСледствие для объёма: ' + note.effect + '\n'
    if (!body.replace(/\r\n/g,'\n').includes(block)) body += '\n' + block
  }
  if (tracker?.status === 'changed') {
    body += '\n## Изменения в Трекере\n\n' + tracker.changes.map(c => '- ' + c.name + ' (' + c.action + ')\n\n' +
      quote((c.before ?? '∅') + '\n→\n' + (c.after ?? '∅'))).join('\n\n') + '\n'
    if (data.trackerEffect) body += '\nСледствие для объёма: ' + data.trackerEffect + '\n'
  }
  return {kind,body}
}

function inspect(code,input,digests,preview) {
  const data = taskData(code)
  const file = data.dir + '/preflight.md'
  const before = text(file)
  if (before === null && fs.existsSync(safe(data.dir))) stop('Task directory exists without preflight: ' + data.dir)
  const tracker = issue(code) ? adapter('tracker',digests[code] ? ['cached',code,digests[code]] : ['preview',code]) : null
  if (tracker) console.log(JSON.stringify({tracker}))
  const brief = briefFor(code,input,before,tracker,preview)
  console.log('Task: ' + code + '\nClass: ' + (brief.kind ?? 'classify from tracker preview') + '\n' + (brief.body ?? ''))
  return {code, data, before, file, tracker, ...brief}
}

// The journal records only the intended task artifacts. Retry compares each
// candidate with both its original and its prepared content before writing.
function prepare(tasks, intake) {
  const files = {}, trackers = {}
  function add(file, content) { files[file] = {before:hash(text(file)),after:hash(content),content} }
  for (const task of tasks) {
    const i = intake.find(s=>s.code === task.code)
    if (!i.before && task.repos.some(r=>r.branchSha || r.existing))
      stop('Existing task branch without saved preflight: ' + task.code)
    for (const r of task.repos.filter(r=>!r.branchSha)) {
      const reports = ['handover.md','review-report.md','test-cases.md','feature-state.json']
      const roots = [i.data.dir,i.data.dir + '/repos/' + r.name]
      if (i.before && roots.some(dir=>reports.some(f=>fs.existsSync(safe(dir + '/' + f)))))
        stop('Missing branch with saved execution evidence: ' + task.code + ' in ' + r.name)
    }
    if (i.kind !== 'trivial' || i.tracker || task.repos.some(r=>r.override) || task.dependencies.length) {
      let body = i.body
      const pins = new Map(i.data.pins)
      if (pins.has(undefined)) {
        const candidates = i.data.saved.repos ?? discover().filter(repo=>checkedOut(repo,task.code))
        if (candidates.length !== 1) stop('Qualify the original Base-SHA with its project: ' + i.file)
        const original = candidates[0]
        if (task.repos.some(r=>r.name !== original.name)) {
          const base = pins.get(undefined)
          const line = [...markupLines(body)].find(row=>row.content === 'Base-SHA: ' + base)
          body = body.slice(0,line.start) + 'Base-SHA ' + original.name + ': ' + base + body.slice(line.end)
          pins.delete(undefined)
          pins.set(original.name,base)
        }
      }
      for (const r of task.repos) {
        if (!pins.has(r.name) && !pins.has(undefined) && !i.data.saved.repos?.some(old=>old.name === r.name))
          body += '\nBase-SHA ' + r.name + ': ' + r.baseSha + '\n'
      }
      add(i.file,body)
    }
    if (i.tracker && i.tracker.status !== 'unchanged') {
      trackers[task.code] = i.tracker.digest
      add(i.data.dir + '/tracker/task.md',i.tracker.statement)
    }
    const flow = i.data.dir + '/git-flow.md'
    if (i.data.rows.size || fs.existsSync(safe(flow))) add(flow,text(flow))
    else if (task.repos.some(r=>r.override) || task.dependencies.length) {
      // git-workspace owns the git-flow format; bind the bytes it expects to create.
      add(flow,formatFlow(task))
    }
  }
  return {files,trackers}
}

function status() { return git(root,['status','--porcelain=v1','-z','--untracked-files=all']).split('\0').filter(Boolean) }
function checkFiles(job) {
  for (const line of status()) {
    const file = line.slice(3)
    if (!Object.hasOwn(job.files,file) || !/^(?:\?\?|[ AM]{2}) /.test(line)) stop('Busy outer workspace: ' + line)
  }
  for (const [file,f] of Object.entries(job.files)) {
    const now = hash(text(file))
    if (now !== f.before && now !== f.after) stop('Task artifact changed during preparation: ' + file)
  }
}

function reportPlan(tasks) {
  for (const t of tasks) for (const r of t.repos)
    console.log('Task: ' + t.code + ' · ' + r.name + '\nBase: ' + r.base + ' ' + r.baseSha + ' (' + r.profile + ')\nCheckout: ' + r.checkout + '\nTarget: ' + r.target)
}

function reportResume(intake, products) {
  for (const item of intake) {
    console.log('Resume existing ' + item.kind + ' task (read only).')
    for (const repo of item.data.saved.repos) {
      const checkout = checkedOut(products.find(p=>p.name === repo.name), item.code)
      const cwd = safe(checkout)
      console.log('Checkout: ' + checkout + '\nSource: ' + git(cwd,['rev-parse','HEAD']) +
        '\nStatus:\n' + (git(cwd,['status','--porcelain=v1','--untracked-files=all']) || '(clean)'))
      for (const folder of [item.data.dir,item.data.dir + '/repos/' + repo.name]) {
        for (const name of ['handover.md','feature-state.json','test-cases.md','review-report.md']) {
          const file = folder + '/' + name
          if (fs.existsSync(safe(file))) console.log('Evidence: ' + file)
        }
      }
    }
  }
}

// Git-runner plan material includes checkout occupancy. Re-entry after partial
// setup can change occupancy, but the original repo, base and SHA must match.
function checkRetry(prior, tasks) {
  for (const t of tasks) {
    const saved = prior.find(p=>p.code===t.code)
    if (!saved || t.repos.length !== saved.repos.length) stop('Task selection changed while resuming')
    for (const r of t.repos) {
      const old = saved.repos.find(s=>s.name === r.name)
      if (!old || old.baseSha !== r.baseSha || old.checkout !== r.checkout || old.target !== r.target) stop('Checkout or base changed during recovery: ' + r.name)
    }
  }
}

function main() {
  const {args,codes,preview} = parse()
  const input = JSON.parse(process.env.BEERPOWERS_TASK_JSON || '{}')
  const digests = JSON.parse(process.env.BEERPOWERS_TRACKER_DIGESTS || '{}')
  const gitInput = JSON.parse(process.env.BEERPOWERS_GIT_TASKS || '{}')
  const key = digest(JSON.stringify([args,input,gitInput], (_key,value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map(field=>[field,value[field]]))
  }))
  if (text('.git/beerpowers-task-start.json') !== null) stop('Resume the interrupted legacy task first')
  const prior = text(stateFile)
  let job = prior === null ? null : JSON.parse(prior)
  if (job && (job.key !== key || preview || mode === 'task-plan')) stop('Resume interrupted task-start with its original arguments and brief: ' + stateFile)
  let tasks
  if (!job) {
    const intake = codes.map(code=>inspect(code,input,digests,preview))
    if (preview) { console.log('Preview only.'); return }
    const products = discover()
    const resumed = intake.every(i => i.before !== null && i.before === i.body && i.data.saved.repos?.length &&
      i.data.saved.repos.every(r=>{
        const p = products.find(p=>p.name === r.name)
        return p && taskCheckout(p,i.code,r,r.baseSha)
      }))
    if (resumed && args.length === codes.length && args.every((v,n)=>v===codes[n]) && !process.env.BEERPOWERS_GIT_TASKS) {
      reportResume(intake,products)
      return
    }
    const plan = adapter('git-workspace',['task-plan',...args])
    tasks = plan.tasks
    reportPlan(tasks)
    console.log('Git plan: ' + plan.planHash)
    if (mode !== 'task-plan' && process.env.BEERPOWERS_GIT_PLAN && process.env.BEERPOWERS_GIT_PLAN !== plan.planHash)
      stop('Previously shown Git plan has changed; review the new base and checkout')
    const artifacts = prepare(tasks,intake)
    const changed = Object.entries(artifacts.files).some(([,f])=>f.before !== f.after)
    if (resumed && !changed && tasks.every(t=>t.repos.every(r=>r.existing)) && !args.some(a=>a.startsWith('--'))) {
      reportResume(intake,products); return
    }
    if (status().length) stop('Busy outer workspace; reconcile files before preparing a task')
    if (mode === 'task-plan') return
    for (const file of Object.keys(artifacts.files)) if (git(root,['check-ignore','--no-index','--',file],true) !== null) stop('Ignored task artifact: ' + file)
    git(root,['var','GIT_AUTHOR_IDENT']); git(root,['var','GIT_COMMITTER_IDENT'])
    job = {key,branch:git(root,['symbolic-ref','HEAD']),head:git(root,['rev-parse','HEAD']),tasks,...artifacts}
    write(stateFile,JSON.stringify(job))
  }
  checkFiles(job)
  if (git(root,['symbolic-ref','HEAD']) !== job.branch) stop('Outer branch changed')
  if (git(root,['rev-parse','HEAD']) !== job.head) {
    if (git(root,['rev-parse','HEAD^'],true) !== job.head || status().length ||
      !Object.entries(job.files).every(([file,f])=>hash(text(file))===f.after)) stop('Outer HEAD changed; inspect journal')
    fs.unlinkSync(safe(stateFile)); console.log('Recovered artifact commit.'); return
  }
  if (!tasks) { tasks = adapter('git-workspace',['task-plan',...args]).tasks; checkRetry(job.tasks,tasks) }
  const result = adapter('git-workspace',['task-start',...args],{BEERPOWERS_GIT_PLAN:digest(JSON.stringify(tasks))})
  checkRetry(job.tasks,result.tasks)
  for (const [code,d] of Object.entries(job.trackers)) adapter('tracker',['accept',code,d])
  checkFiles(job)
  for (const [file,f] of Object.entries(job.files)) {
    if (hash(text(file)) === f.after) continue
    if (file.endsWith('/git-flow.md') || file.endsWith('/tracker/task.md')) stop('Adapter did not produce expected artifact: ' + file)
    write(file,f.content)
  }
  const changed = Object.keys(job.files).filter(file => job.files[file].before !== job.files[file].after)
  if (changed.length) {
    git(root,['add','--',...changed])
    git(root,['commit','--only','-m','docs: подготовь ' + codes.join(', '),'-m','© Codex','--',...changed])
    console.log('Artifact commit: ' + git(root,['rev-parse','HEAD']))
  }
  fs.unlinkSync(safe(stateFile))
  reportPlan(result.tasks)
  console.log(JSON.stringify(result))
  console.log('Preparation only.')
}
try { main() } catch(error) { console.error(error.message); process.exitCode = 1 }

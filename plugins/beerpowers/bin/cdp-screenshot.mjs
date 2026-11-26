#!/usr/bin/env node
// Снимает скриншоты страниц и читает метрики DOM через CDP в своём headless Chrome.
//
// Запуск:  SCREENSHOT_TASK=<КОД> node <package>/bin/cdp-screenshot.mjs '<JSON-массив сценариев>'
// Порт отладки — переменная CDP_PORT, по умолчанию 9333.
//
// SCREENSHOT_TASK — код задачи: относительный `out` ложится в memory/tasks/<КОД>/screenshots/
// (каталог под gitignore, создаётся сам; папка задачи
// должна уже быть). Код задачи в имя скриншота не пишется — его несёт каталог. Без SCREENSHOT_TASK
// относительный `out` считается от текущего каталога, абсолютный `out` берётся как есть
// в обоих случаях. Корень workspace — каталог над .codex/, переменная WORKSPACE_ROOT
// его переопределяет (проверка на одноразовой фикстуре).
//
// Поля сценария:
//   url      — адрес страницы (обязательно)
//   viewport — имя из списка viewports проекта (.codex/workspace.json): даёт width, height
//              и mobile; явно заданные поля сценария важнее. Список — режим --viewports
//   width    — ширина вьюпорта (обязательно, если нет viewport)
//   height   — высота вьюпорта (обязательно, если нет viewport)
//   mobile   — эмулировать мобильное устройство: касания и мобильный User-Agent (по умолчанию false)
//   waitMs   — сколько ждать после load, прежде чем мерить и снимать (по умолчанию 2000)
//   out      — путь файла скриншота; не задан — скриншот не снимается, только метрики
//   fullPage — снимать всю страницу, а не видимую часть
//   probe    — выражение JavaScript, результат которого попадёт в отчёт полем metrics
//
// Каждый сценарий печатает targetId и sessionId своей вкладки: без них невозможно
// сослаться на конкретный прогон, когда скриншоты расходятся между заходами.
//
// Служебные режимы:
//   node <package>/bin/cdp-screenshot.mjs --viewports                   # ширины проекта, по которым снимают
// и свой Chrome без пути, зашитого под одну ОС:
//   node <package>/bin/cdp-screenshot.mjs --find-chrome                 # где Chrome на этой машине
//   CDP_PORT=9401 node <package>/bin/cdp-screenshot.mjs --launch <профиль> # поднять headless, печатает pid
//   CDP_PORT=9401 node <package>/bin/cdp-screenshot.mjs --close           # закрыть штатно, Browser.close
// Путь ищется так: BEERPOWERS_CHROME (личный, из окружения пользователя) →
// стандартные места установки Chrome, затем Chromium и Edge под текущую ОС.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { findChrome, mobileUserAgent } from './lib/chrome.mjs'
import { findRoot, loadWorkspace, taskDirectory, workspacePath } from './lib/ui-workspace.mjs'

const PORT = process.env.CDP_PORT || '9333'
const owner = () => workspacePath(findRoot(), '.codex/.cache/cdp/' + PORT + '.json')
function verifyOwner(v) {
  if (!existsSync(owner()) || JSON.parse(readFileSync(owner(),'utf8')).endpoint !== v.webSocketDebuggerUrl)
    throw Error('Start a private browser with --launch on a free CDP_PORT')
}

async function versionOrNull() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { return null }
}

let workspace = null
function project() {
  if (workspace) return workspace
  const root = findRoot()
  workspace = loadWorkspace(root)
  const fatal = workspace.problems.find(p => p.fatal)
  if (fatal) throw new Error(`.codex/workspace.json: ${fatal.msg}`)
  return workspace
}

const mode = process.argv[2]
// Справка — шапка этого файла: вторая копия текста разошлась бы с ней.
if (mode === undefined || mode === '-h' || mode === '--help') {
  const head = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2)
  const end = head.findIndex(l => !l.startsWith('//'))
  console.log(head.slice(0, end).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(mode === undefined ? 2 : 0)
}
if (!/^\d+$/.test(PORT) || Number(PORT) < 1 || Number(PORT) > 65535) throw Error('Invalid CDP_PORT')
if (mode === '--viewports') {
  const { viewports, viewportsDefault } = project()
  console.log(JSON.stringify({ source: viewportsDefault ? 'дефолт движка: ключа viewports нет' : '.codex/workspace.json', viewports }, null, 2))
  process.exit(0)
}
if (mode === '--find-chrome') {
  const { path, tried } = findChrome()
  if (!path) {
    console.error(`Chrome не найден. Проверено:\n  ${tried.join('\n  ') || '(для этой ОС мест нет)'}\n` +
      'Укажи путь личной переменной BEERPOWERS_CHROME в окружении пользователя.')
    process.exit(1)
  }
  console.log(path)
  process.exit(0)
}
if (mode === '--launch') {
  const profile = process.argv[3]
  if (!profile) { console.error('--launch ждёт каталог профиля: свой, в scratchpad, не профиль пользователя'); process.exit(2) }
  if (existsSync(profile) && readdirSync(profile).length) throw Error('Select an empty temporary browser profile')
  if (await versionOrNull()) {
    console.error(`порт ${PORT} уже занят чужим браузером — выбери другой CDP_PORT`)
    process.exit(1)
  }
  const { path, tried } = findChrome()
  if (!path) { console.error(`Chrome не найден: ${tried.join(', ')}`); process.exit(1) }
  const child = spawn(path, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${resolve(profile)}`,
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-gpu'], { detached: true, windowsHide: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 40; i++) {
    const v = await versionOrNull()
    if (v) {
      mkdirSync(dirname(owner()),{recursive:true})
      writeFileSync(owner(),JSON.stringify({pid:child.pid,endpoint:v.webSocketDebuggerUrl}))
      console.log(`pid=${child.pid} port=${PORT} browser=${v.Browser} chrome=${path}`); process.exit(0)
    }
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`Chrome запущен (pid=${child.pid}), но порт ${PORT} не ответил за 10 с — закрой его по этому PID`)
  process.exit(1)
}
if (mode === '--close') {
  const v = await versionOrNull()
  if (!v) { console.log(`на порту ${PORT} браузера нет — закрывать нечего`); process.exit(0) }
  verifyOwner(v)
  const sock = new WebSocket(v.webSocketDebuggerUrl)
  await new Promise(r => sock.addEventListener('open', r))
  sock.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }))
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (!(await versionOrNull())) { unlinkSync(owner()); console.log(`закрыт, порт ${PORT} свободен`); process.exit(0) }
  }
  console.error(`порт ${PORT} отвечает после Browser.close — закрой процесс по PID, полученному при --launch`)
  process.exit(1)
}

let scenarios
try {
  scenarios = JSON.parse(mode)
} catch {
  console.error(`аргумент — не JSON-массив сценариев и не режим: ${mode}. Справка — --help`)
  process.exit(2)
}

const TASK = process.env.SCREENSHOT_TASK

for (const scenario of scenarios) {
  if (scenario.viewport === undefined) continue
  const vp = project().viewports.find(v => v.name === scenario.viewport)
  if (!vp) {
    throw new Error(`viewport «${scenario.viewport}» нет в списке проекта: ${project().viewports.map(v => v.name).join(', ')} (--viewports)`)
  }
  scenario.width ??= vp.width
  scenario.height ??= vp.height
  scenario.mobile ??= vp.mobile
}
for (const scenario of scenarios) {
  if (!scenario.width || !scenario.height) throw new Error(`сценарий ${scenario.url}: нужен viewport или width и height`)
}

if (TASK) {
  taskDirectory(project().root, TASK)
  for (const scenario of scenarios) {
    if (scenario.out) scenario.out = workspacePath(project().root, 'memory/tasks/' + TASK + '/screenshots/' + scenario.out)
  }
}

const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
const version = await res.json()
verifyOwner(version)

const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise(resolve => ws.addEventListener('open', resolve))

let id = 0
const pending = new Map()
const listeners = []

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  for (const listener of listeners) listener(msg)
})

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const messageId = ++id
  pending.set(messageId, { resolve, reject })
  ws.send(JSON.stringify({ id: messageId, method, params, sessionId }))
})

const waitFor = (predicate, timeout = 30000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), timeout)
  const listener = (msg) => {
    if (!predicate(msg)) return
    clearTimeout(timer)
    listeners.splice(listeners.indexOf(listener), 1)
    resolve(msg)
  }
  listeners.push(listener)
})

const DEFAULT_PROBE = `({
  innerWidth: window.innerWidth,
  title: document.title,
  url: location.href,
})`

console.log(JSON.stringify({ browser: version.Browser, port: PORT }))

for (const scenario of scenarios) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })

  const messages = []
  listeners.push((msg) => {
    if (msg.sessionId !== sessionId) return
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      messages.push(msg.params.type + ': ' + msg.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 300))
    }
    if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
      messages.push(msg.params.entry.level + ': ' + msg.params.entry.text.slice(0, 300))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      messages.push('exception: ' + JSON.stringify(msg.params.exceptionDetails.text).slice(0, 300))
    }
  })

  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Log.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', {
    width: scenario.width,
    height: scenario.height,
    deviceScaleFactor: 1,
    mobile: Boolean(scenario.mobile),
  }, sessionId)
  if (scenario.mobile) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId)
    await send('Emulation.setUserAgentOverride', mobileUserAgent(version['User-Agent']), sessionId)
  }

  const [navigation] = await Promise.all([
    send('Page.navigate', { url: scenario.url }, sessionId),
    waitFor(msg => msg.sessionId === sessionId && msg.method === 'Page.loadEventFired')
  ])
  if (navigation.errorText) throw Error(navigation.errorText)
  await new Promise(resolve => setTimeout(resolve, scenario.waitMs ?? 2000))

  const probe = await send('Runtime.evaluate', {
    expression: scenario.probe ?? DEFAULT_PROBE,
    returnByValue: true,
  }, sessionId)

  if (probe.exceptionDetails) throw Error('DOM probe failed: ' + probe.exceptionDetails.text)
  if (scenario.out) {
    let clip
    if (scenario.fullPage) {
      const { cssContentSize } = await send('Page.getLayoutMetrics', {}, sessionId)
      clip = {
        ...cssContentSize, scale: 1,
        width: Math.max(scenario.width, cssContentSize.width),
        height: Math.max(scenario.height, cssContentSize.height),
      }
    }
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: Boolean(scenario.fullPage),
      ...(clip ? { clip } : {}),
    }, sessionId)
    mkdirSync(dirname(scenario.out), { recursive: true })
    writeFileSync(scenario.out, Buffer.from(shot.data, 'base64'))
  }

  console.log(JSON.stringify({
    targetId,
    sessionId,
    url: scenario.url,
    width: scenario.width,
    mobile: Boolean(scenario.mobile),
    out: scenario.out ?? null,
    metrics: probe.result.value,
    messages,
  }, null, 2))

  await send('Target.closeTarget', { targetId })
}

ws.close()

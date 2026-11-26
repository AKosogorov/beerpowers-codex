// Выгружает выбранный фрейм Figma и проверяет полученный PNG перед сохранением.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createHash, randomUUID} from 'node:crypto'
import {findRoot, taskDirectory, workspacePath} from './lib/ui-workspace.mjs'

import { showHelp } from './lib/cli-help.mjs';

showHelp('figma-export.mjs FIGMA_NODE_URL [--save TASK | --out PATH] [--scale NUMBER]');

async function main() {
  const [link, ...args] = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (!['--scale','--save','--out'].includes(key) || !args[i+1] || key in options) throw Error('Expected --save CODE, --out PATH or --scale NUMBER')
    options[key] = args[i+1]
  }
  if (options['--save'] && options['--out']) throw Error('Choose one output')
  const root = findRoot()
  if (options['--save']) taskDirectory(root, options['--save'])
  const scale = Number(options['--scale'] ?? 2)
  if (!(scale >= 0.01 && scale <= 4)) throw Error('Scale must be 0.01–4')
  const url = new URL(link)
  const key = /^\/(?:design|file|proto)\/([A-Za-z0-9]{10,})(?:\/|$)/.exec(url.pathname)?.[1]
  const node = url.searchParams.get('node-id')?.replace('-', ':')
  if (!['www.figma.com','figma.com'].includes(url.hostname) || url.protocol !== 'https:' || !key || !/^\d+:\d+$/.test(node ?? '')) throw Error('Expected Figma selection URL with a node-id')
  // Loopback fixtures always have independent credentials and never open personal settings.
  const fixture = process.env.BEERPOWERS_FIGMA_FIXTURE
  if (fixture && !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture)) throw Error('Fixture must be a loopback origin')
  const api = (fixture ?? 'https://api.figma.com') + '/v1'
  let token = fixture ? 'synthetic' : process.env.FIGMA_TOKEN
  if (!token) {
    for (const file of [workspacePath(root, '.codex/figma-settings.json'), path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'figma-settings.json')]) {
      if (fs.existsSync(file)) token = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).token
      if (token) break
    }
  }
  if (!token) throw Error('Figma access unavailable')
  async function get(route) {
    const res = await fetch(api + route, {headers:{'X-Figma-Token': token}, redirect:'error', signal:AbortSignal.timeout(30000)})
    if (!res.ok) throw Error('Figma HTTP ' + res.status)
    return res.json()
  }
  const render = await get('/images/' + key + '?ids=' + node + '&format=png&scale=' + scale)
  if (!render.images?.[node]) throw Error('No rendered image for node ' + node)
  const image = new URL(render.images[node])
  if (fixture ? image.origin !== fixture : image.protocol !== 'https:') throw Error('Unexpected render URL')
  let out = options['--out']
  if (options['--save']) {
    const meta = await get('/files/' + key + '/nodes?ids=' + node + '&depth=1').catch(() => ({}))
    const name = meta.nodes?.[node]?.document?.name?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60)
    out = 'memory/tasks/' + options['--save'] + '/figma/' + (name || node.replace(':', '-')) + '.png'
  }
  if (!out) return {node, url:image.href}
  const target = workspacePath(root, out.replaceAll('\\', '/'))
  const res = await fetch(image, {signal:AbortSignal.timeout(60000), redirect:'error'})
  if (!res.ok) throw Error('Figma render HTTP ' + res.status)
  const png = Buffer.from(await res.arrayBuffer())
  if (png.length < 33 || png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii',12,16) !== 'IHDR' ||
      png.toString('ascii',png.length-8,png.length-4) !== 'IEND') throw Error('Invalid PNG render')
  fs.mkdirSync(path.dirname(target), {recursive:true})
  const staging = target + '.' + randomUUID()
  try {
    fs.writeFileSync(staging, png, {flag:'wx'})
    fs.renameSync(staging, target)
  } finally { fs.rmSync(staging,{force:true}) }
  return {node, path:out, width:png.readUInt32BE(16), height:png.readUInt32BE(20), bytes:png.length, sha256:createHash('sha256').update(png).digest('hex')}
}

main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1 })

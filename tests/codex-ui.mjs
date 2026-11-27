import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import {fileURLToPath,pathToFileURL} from 'node:url'

const exec = promisify(execFile)
const bin = fileURLToPath(new URL('../plugins/beerpowers/bin/', import.meta.url))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64')

async function fixture(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'codex-ui-'))
  t.after(() => fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}))
  fs.mkdirSync(path.join(dir,'.codex'))
  fs.writeFileSync(path.join(dir,'.codex/workspace.json'), '{}')
  fs.mkdirSync(path.join(dir,'memory/tasks/fix/ui'),{recursive:true})
  const srv = http.createServer(handler)
  await new Promise(ok => srv.listen(0,'127.0.0.1',ok))
  t.after(() => {srv.closeAllConnections(); srv.close()})
  const origin = 'http://127.0.0.1:' + srv.address().port
  const run = (name,...args) => exec(process.execPath,[...(name === 'cdp-run' && fs.existsSync(path.join(dir,'chrome-startup.mjs'))
    ? ['--import',pathToFileURL(path.join(dir,'chrome-startup.mjs')).href] : []),path.join(bin,name + '.mjs'),...args],{
    cwd:dir,timeout:90000,env:{...process.env, SCREENSHOT_TASK:'fix/ui', BEERPOWERS_FIGMA_FIXTURE:origin},
  })
  return {run,dir,origin}
}

test('Figma selection renders, saves and validates the PNG, rejects bad media', async t => {
  let broken = false
  const {run,dir} = await fixture(t,(req,res) => {
    const url = new URL(req.url,'http://' + req.headers.host)
    if (url.pathname === '/asset') {
      assert.equal(req.headers['x-figma-token'],undefined)
      res.end(broken ? 'not png' : png)
    } else {
      assert.equal(req.headers['x-figma-token'],'synthetic')
      assert.equal(url.searchParams.get('ids'),'3:4')
      res.end(JSON.stringify(url.pathname.includes('/nodes') ? {nodes:{'3:4':{document:{name:'Search / Empty'}}}} : {images:{'3:4':url.origin+'/asset'}}))
    }
  })
  const args = ['figma-export','https://www.figma.com/design/abcdefghij/Test?node-id=3-4','--save','fix/ui']
  const result = JSON.parse((await run(...args)).stdout)
  assert.equal(result.path,'memory/tasks/fix/ui/figma/search-empty.png')
  assert.deepEqual(fs.readFileSync(path.join(dir,result.path)),png)
  broken = true
  await assert.rejects(run(...args),/Invalid PNG/)
  assert.deepEqual(fs.readFileSync(path.join(dir,result.path)),png)
})

test('installed headless browser captures a real DOM change on mobile and desktop', async t => {
  const {run,dir,origin} = await fixture(t,(req,res) => {
    res.setHeader('content-type','text/html')
    res.end('<meta name="viewport" content="width=device-width"><style>body{min-height:1400px}</style><button onclick="this.textContent=42">Go</button>')
  })
  const scenario = {baseUrl:origin, scenarios:[{name:'change',viewport:'*',steps:[
    {goto:'/'},{click:'button'},{wait:{selector:'button',hasText:'42'}},
    {screenshot:'{name}.png'},{screenshot:'{name}-full.png',fullPage:true}],
    state:{value:"document.querySelector('button').textContent",width:'innerWidth'}}]}
  fs.writeFileSync(path.join(dir,'scenario.json'),JSON.stringify(scenario))
  fs.writeFileSync(path.join(dir,'chrome-startup.mjs'),`
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const spawn = childProcess.spawn;
    const timeout = globalThis.setTimeout;
    const profileArg = '--user-data-dir=';
    let firstProfile;
    let hungChild;
    let recovered = false;
    globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, hungChild && !recovered && ms === 20000 ? 100 : ms, ...args);
    childProcess.spawn = function (file, args, options) {
      assert.ok(args.includes('--remote-debugging-pipe'));
      assert.ok(!args.some(arg => arg.startsWith('--remote-debugging-port')));
      assert.deepEqual(options.stdio.slice(3), ['pipe','pipe']);
      if (process.platform !== 'win32') return spawn(file, args, options);
      assert.equal(options.detached, true);
      const profile = args.find(arg => arg.startsWith(profileArg))?.slice(profileArg.length);
      if (!hungChild) {
        firstProfile = profile;
        hungChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
        return hungChild;
      }
      assert.equal(recovered, false);
      assert.ok(hungChild.exitCode !== null || hungChild.signalCode !== null);
      assert.ok(!fs.existsSync(firstProfile));
      assert.notEqual(profile, firstProfile);
      recovered = true;
      return spawn(file, args, options);
    };
    syncBuiltinESMExports();
  `)
  await run('cdp-run','scenario.json','--out','results.jsonl')
  const rows = fs.readFileSync(path.join(dir,'results.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x))
  assert.deepEqual(rows.map(r=>r.width),[375,1440])
  for (const row of rows) {
    assert.equal(row.ok,true)
    assert.equal(row.state.value,'42')
    assert.equal(row.state.width,row.width)
    const image = fs.readFileSync(path.join(dir,'memory/tasks/fix/ui/screenshots',row.name+'.png'))
    assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a')
    assert.equal(image.readUInt32BE(16),row.width)
    assert.equal(image.readUInt32BE(20),row.height)
    const full = fs.readFileSync(path.join(dir,'memory/tasks/fix/ui/screenshots',row.name+'-full.png'))
    assert.equal(full.readUInt32BE(16),row.width)
    assert.ok(full.readUInt32BE(20) >= 1400)
  }
})

test('a rejected CDP pipe stops the spawned browser and removes its profile', async t => {
  const {run,dir,origin} = await fixture(t, (_req,res) => res.end())
  const scenario = {baseUrl:origin, scenarios:[{name:'open',viewport:'desktop',steps:[{goto:'/'}]}]}
  fs.writeFileSync(path.join(dir,'scenario.json'),JSON.stringify(scenario))
  fs.writeFileSync(path.join(dir,'chrome-startup.mjs'),`
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {PassThrough} from 'node:stream';
    process.env.BEERPOWERS_CHROME = process.execPath;
    const spawn = childProcess.spawn;
    childProcess.spawn = function (file, args, options) {
      assert.ok(args.includes('--remote-debugging-pipe'));
      const prefix = '--user-data-dir=';
      const profile = args.find(arg => arg.startsWith(prefix)).slice(prefix.length);
      const child = spawn(file, ['-e', 'setInterval(() => {}, 1000)'], options);
      fs.appendFileSync('browsers.jsonl', JSON.stringify({profile, pid:child.pid}) + '\\n');
      const commands = child.stdio[3] = new PassThrough();
      const responses = child.stdio[4] = new PassThrough();
      commands.once('data', chunk => {
        assert.equal(chunk.at(-1), 0);
        const {id, method} = JSON.parse(chunk.subarray(0, -1));
        assert.equal(method, 'Browser.getVersion');
        const response = JSON.stringify({id, error:{message:'Test CDP refusal\\nnext line'}});
        responses.write(response.slice(0, 10));
        responses.write(response.slice(10) + '\\0');
      });
      return child;
    };
    syncBuiltinESMExports();
  `)
  await assert.rejects(run('cdp-run','scenario.json','--out','results.jsonl'), error =>
    error.code === 2 && error.stderr.includes('Browser.getVersion: Test CDP refusal next line'))
  const browsers = fs.readFileSync(path.join(dir,'browsers.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(browsers.length, process.platform === 'win32' ? 2 : 1)
  for (const {profile,pid} of browsers) {
    assert.throws(() => process.kill(pid,0), {code:'ESRCH'})
    assert.ok(!fs.existsSync(profile))
  }
})

test('standalone screenshot uses its own Chrome, reports DOM and saves full-page PNG', async t => {
  const {dir,origin} = await fixture(t, (_req,res) => {
    res.setHeader('content-type','text/html')
    res.end('<title>Fixture page</title><style>body{height:1400px}</style>')
  })
  const port = net.createServer()
  await new Promise(ok => port.listen(0,'127.0.0.1',ok))
  const number = port.address().port
  await new Promise(ok => port.close(ok))
  const capture = (...args) => exec(process.execPath,[path.join(bin,'cdp-screenshot.mjs'),...args], {
    cwd:dir, timeout:45000, env:{...process.env, CDP_PORT:String(number), SCREENSHOT_TASK:'fix/ui'},
  })
  await capture('--launch',path.join(dir,'chrome-private'))
  try {
    const args = [{url:origin,viewport:'desktop',fullPage:true,waitMs:0,out:'page.png'}]
    const {stdout} = await capture(JSON.stringify(args))
    assert.match(stdout,/"title": "Fixture page"/)
    assert.match(stdout,/"sessionId": "[A-Fa-f0-9]+"/)
    const image = fs.readFileSync(path.join(dir,'memory/tasks/fix/ui/screenshots/page.png'))
    assert.equal(image.readUInt32BE(16),1440)
    assert.ok(image.readUInt32BE(20) >= 1400)
  } finally { await capture('--close') }
})

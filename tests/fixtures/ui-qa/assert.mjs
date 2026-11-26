import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const [report, screenshots, ...extra] = process.argv.slice(2);
  if (!report || !screenshots || extra.length) throw Error('Usage: node assert.mjs <result.jsonl> <screenshots-dir>');
  const rows = readFileSync(report, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.name).sort(), ['empty-list', 'save-blocked', 'save-ok']);
  for (const row of rows) {
    assert.equal(row.ok, true, row.name + ': ' + JSON.stringify(row.error));
    assert.ok(row.console.every(event => !['error', 'exception'].includes(event.level)), row.name + ': console');
    assert.ok(row.network.every(event => !event.failed && event.status < 400), row.name + ': network');
    const posts = row.network.filter(event => event.method === 'POST' && new URL(event.url).pathname === '/api/books');
    if (row.name === 'save-blocked') {
      assert.equal(row.state.missing, true);
      assert.equal(posts.length, 0);
    } else if (row.name === 'save-ok') {
      assert.equal(row.state.status, 'Сохранено');
      assert.deepEqual(posts.map(event => event.status), [201]);
      const pngPath = resolve(screenshots, 'tester-save-1280.png');
      assert.deepEqual(row.screenshots.map(file => resolve(file)), [pngPath]);
      const png = readFileSync(pngPath);
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), 1280);
      assert.equal(png.readUInt32BE(20), 800);
    } else {
      assert.deepEqual(row.state.items, ['Пока нет книг']);
      assert.ok(row.network.some(event => event.mocked && new URL(event.url).pathname === '/api/books'));
    }
  }
  console.log('PASS 3 scenarios, DOM, requests, console and PNG.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

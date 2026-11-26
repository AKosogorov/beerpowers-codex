import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../plugins/beerpowers/bin/onboard-check.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'beerpowers-onboard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function put(path, content) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  function check(...args) {
    return spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: 'utf8' });
  }
  put('.codex/team-charter.md', '# Команда\n\n## PM-конвейер\n');
  put('.codex/roles/product.md', '# Продуктовый аналитик\n');
  put('projects/store/app/Catalog.php', '<?php\r\nclass Catalog {}\r\n');
  put('docs/product-context/catalog.md', '# Каталог\n');
  put('memory/MEMORY.md', '# Ручной индекс\n- [Карта](project/project-map.md)\n- [Экраны](product-map.md)\n');
  return { put, check, root };
}

test('Инженерная запись с точной ссылкой. Повтор сохраняет ручную память побайтно', t => {
  const { root, put, check } = fixture(t);
  const topic = 'memory/project/project-map.md';
  const body = 'Ручная заметка.\n- Факт: каталог реализован классом Catalog. `projects/store/app/Catalog.php:2`\n';
  put(topic, body);
  for (let run = 0; run < 2; run++) {
    const result = check('onboard', topic);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /facts=1.*references=1/);
    assert.equal(readFileSync(join(root, topic), 'utf8'), body);
  }
  put(topic, body.replace('.php:2', '.php:3'));
  assert.match(check('onboard', topic).stderr, /нет строки 3/i);
  put(topic, body.replace(' `projects/store/app/Catalog.php:2`', ''));
  assert.match(check('onboard', topic).stderr, /источник/i);
});

test('PM-факты из документов, пробелы и активация PM-трека', t => {
  const { put, check } = fixture(t);
  const topic = 'memory/product-map.md';
  put(topic, '- Факт: в интервью назван каталог. `docs/product-context/catalog.md:1`\n- Вопрос: какие разделы ещё нужны?\n');
  const result = check('product-onboard', topic);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /facts=1.*references=1.*open=1/);
  put('.codex/team-charter.md', '# Команда\n');
  assert.match(check('product-onboard', topic).stderr, /PM-конвейер/);
});

test('Продуктовый документ целиком может служить источником для сводки', t => {
  const {put,check} = fixture(t);
  const topic = 'memory/product-map.md';
  put(topic, '- Факт: интервью посвящено каталогу. `docs/product-context/catalog.md`\n');
  const result = check('product-onboard',topic);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/facts=1.*references=1/);
  put(topic, '- Факт: модуль каталога. `projects/store/app/Catalog.php`\n');
  assert.notEqual(check('product-onboard',topic).status,0);
  put(topic, '- Факт: интервью. `docs/product-context/nonexistent.md`\n');
  assert.notEqual(check('product-onboard',topic).status,0);
});

test('Отсутствующие ссылки индекса, выход из области и посторонние источники видны', t => {
  const { put, check } = fixture(t);
  const topic = 'memory/product-map.md';
  put(topic, '- Факт: пример. `../source:1`\n');
  assert.notEqual(check('product-onboard', topic).status, 0);
  put(topic, '- Гипотеза: пользователи начинают со списка.\n');
  assert.notEqual(check('onboard', topic).status, 0);
  assert.notEqual(check('product-onboard', 'memory/../product-map.md').status, 0);
  put('memory/MEMORY.md', '# Без записей\n');
  assert.match(check('product-onboard', topic).stderr, /MEMORY.md/);
});

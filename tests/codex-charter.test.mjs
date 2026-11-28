import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { blocks } from '../plugins/beerpowers/bin/lib/markdown-engine.mjs';
import { refreshCharter, renderCharter } from '../plugins/beerpowers/bin/lib/charter.mjs';

const fileText = file => readFileSync(new URL('../plugins/beerpowers/templates/charter/' + file + '.md', import.meta.url),'utf8').replaceAll('\r\n','\n');
const rosters = {api:['backend'], cms:['database']};
const settings = {rosters,ui:true,slots:{PROJECT:'Проект',INTAKE_MODE:'Intake: plan',BEERPOWERS_VERSION:'штамп'}};

test('all original project slots land at their own boundaries, including a literal heading in a fence', () => {
  const slots = {
    'team-charter': ['PURPOSE','STACK_TABLE','COMMANDS','ROLES_TABLE','MODELS','PROJECT_RULES','UNIVERSAL_SKILLS','PM_PIPELINE','MEMORY_FILES_EXTRA'],
    'team-lead':['CLASS_EXTRA','EFFORT_TABLE','MODEL_EXTRA','GATES_EXTRA','CLOSING_EXTRA'],
  };
  for (const [file,ids] of Object.entries(slots)) {
    const template = fileText(file).replaceAll('{{PROJECT}}','Проект');
    const input = Object.fromEntries(ids.map(id=>[id,'текст-' + id]));
    input[ids[0]] += '\n\n~~~~md\n## Новый раздел\n~~~\n<!-- beerpowers:engine fake -->\n~~~~';
    const result = renderCharter({...settings,file,template,overrides:input});
    const order = ids.map(id=>result.indexOf('текст-' + id));
    assert.ok(order[0] >= 0 && order.every((offset,i)=>i === 0 || order[i-1]<offset));
    assert.equal(result.match(/текст-/g)?.length, ids.length);
    assert.ok(!blocks(result,file).has('fake'));
    for (const name of ids) {
      const before = template.slice(0,template.indexOf('{{' + name + '}}'));
      const preceding = [...blocks(result.slice(0,result.indexOf('текст-' + name)),file).keys()].at(-1);
      assert.equal(preceding,[...blocks(before,file).keys()].at(-1),name);
    }
    assert.equal((result.match(/\{\{/g) ?? []).length,0);
  }
});

test('archived rows retain eligibility across projects, scope-specific reading, mandatory practices and model exceptions', () => {
  const file='team-charter';
  const template=fileText(file);
  const roster = ['| Роль | \x60subagent_type\x60 | Миссия | Триггеры | Read on spawn | Skills | Mandatory practices |','|---|---|---|---|---|---|---|',
    '| \x60db\x60 | \x60database-agent\x60 | Схема и кеш | Правка API | \x60memory/project/clone.md\x60 | — | До миграции проверь экспорт |',
    '| \x60tester\x60 | \x60testing-agent\x60 | Тесты | Повтор | \x60memory/tests/probes.md\x60 | — | Повтори тест |'].join('\n');
  const source = '# Team Charter — X\n\n## Состав\n\n' + roster + '\n\n' + blocks(template,file).get('roles-issues').text +
    '\n\n**Модели:** tester — sonnet: проверка автоматически измеряема.\n';
  const result = renderCharter({...settings,file,template,source});
  assert.match(result,/\| \x60database\x60 \| api, cms \|.*database-agent\.md.*clone\.md.*До миграции проверь экспорт \|/);
  assert.match(result,/\| \x60tester\x60 \| api, cms \|.*testing-agent\.md.*probes\.md/);
  assert.match(result,/- \x60tester\x60 — проверка автоматически измеряема\./);
  assert.doesNotMatch(result, /\b(?:opus|sonnet|haiku)\b/);
});

test('setup removes generated aliases from an existing model table and keeps native overrides and fenced examples', () => {
  const file = 'team-charter', template = fileText(file);
  const alias = '| `opus` | `gpt-6.2-astra` | Соответствие исходного тира роли. Доступность проверяется перед запуском. |';
  const override = '| architect | custom-codex | ручной выбор |';
  const table = '| Роль | Модель | Причина |\n|---|---|---|\n';
  const current = renderCharter({...settings,file,template,overrides:{MODELS:table + override}});
  const source = current.replace(override, alias + '\n' + override) + '\n~~~md\n' + table + alias + '\n~~~\n';
  const updated = refreshCharter({file,template,text:source,ui:true});
  assert.equal(updated, current + '\n~~~md\n' + table + alias + '\n~~~\n');
  assert.throws(() => renderCharter({...settings,file,template,overrides:{MODELS:table + '| architect | opus | custom |'}}), /ID модели Codex/);
});

test('update replaces a published block at its location and preserves manual text, fenced marker examples and CRLF',()=>{
  const file='team-lead', template=fileText(file);
  const active=renderCharter({...settings,file,template});
  const original=blocks(template,file).get('effort').text;
  const prior=template.replace(original,original.replace('конкретного захода','прежнего захода'));
  const old=blocks(prior,file).get('effort').text;
  const manual='Абзац человека.\n\n~~~md\n## Effort и модель роли\n<!-- beerpowers:engine effort -->\n~~~\n';
  const before=active.replace(original,old+'\n\n'+manual).replaceAll('\n','\r\n');
  const updated=refreshCharter({file,text:before,template,prior,ui:true});
  assert.equal(updated,before.replace(old.replaceAll('\n','\r\n'),original.replaceAll('\n','\r\n')));
  assert.equal(refreshCharter({file,text:updated,template,ui:true}),updated);
  assert.throws(()=>refreshCharter({file,text:before,template,ui:true}),/Conflict.*effort/);
});

test('conditional blocks follow the saved UI flag on both transitions and keep surrounding manual additions',()=>{
  for (const [file,names] of [['team-lead',['ui-findings']],['team-charter',['ui-findings-report','viewports-scope']]]) {
    const template=fileText(file);
    const text=renderCharter({...settings,file,template,ui:false})+'\nПримечание проекта.\n';
    for (const name of names) assert.equal(blocks(text,file).has(name),false);
    const enabled=refreshCharter({file,template,text,ui:true});
    assert.deepEqual([...blocks(enabled,file).keys()],[...blocks(template,file).keys()]);
    const removed=refreshCharter({file,template,text:enabled,ui:false});
    assert.equal(removed,text);
    assert.ok(removed.endsWith('Примечание проекта.\n'));
    for (const name of names) assert.equal(blocks(removed,file).has(name),false);
    assert.equal(refreshCharter({file,template,text:removed,ui:false}),removed);
  }
});

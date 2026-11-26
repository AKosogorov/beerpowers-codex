// Собирает материалы проектного решения в бриф с проверяемой границей передаваемых файлов.
import { readFileSync } from 'node:fs';

const usage = 'Usage: node decision-brief.mjs < brief.json (writes Markdown to stdout)';

function line(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`Expected one nonempty line: ${field}`);
  }
  return value.trim();
}

function lines(values, field, minimum = 0) {
  if (!Array.isArray(values) || values.length < minimum) throw new Error(`Expected list: ${field}`);
  return values.map(value => line(value, field));
}

function render(brief) {
  const question = line(brief.question, 'question');
  const main = line(brief.mainQuestion, 'mainQuestion');
  const mechanism = line(brief.mechanism, 'mechanism');
  const inferences = lines(brief.inferences, 'inferences');
  const unchecked = lines(brief.unverified, 'unverified');
  const actions = lines(brief.decisions, 'decisions', 1);
  if (!Array.isArray(brief.runs) || (!brief.runs.length && !unchecked.length)) {
    throw new Error('Supply observed runs or explain the missing checks in unverified');
  }
  const facts = brief.runs.map(run => {
    const date = line(run.date, 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Expected ISO date for run');
    const command = line(run.command, 'command');
    const result = line(run.result, 'result');
    const expected = run.expected === undefined ? null : line(run.expected,'expected');
    const fence = '`'.repeat(Math.max(3, ...(command.match(/`+/g) ?? []).map(mark => mark.length + 1)));
    const observation = expected ? `**${date}.**\n\n**Ожидалось.** ${expected}\n\n**Наблюдалось.** ${result}` : `**${date}.** ${result}`;
    return `${observation}\n\n${fence}text\n${command}\n${fence}`;
  });
  if (!Array.isArray(brief.options) || brief.options.length < 2 || brief.options.length > 4) {
    throw new Error('Expected 2 to 4 options');
  }
  const options = brief.options.map((option, i) => [
    `#### ${i + 1}. ${line(option.name, 'name')}`,
    [
      option.addresses === undefined ? null : `- Какой вопрос закрывает: ${line(option.addresses,'addresses')}`,
      `- За: ${line(option.pro, 'pro')}`, `- Против: ${line(option.con, 'con')}`, `- Риск: ${line(option.risk, 'risk')}`
    ].filter(Boolean).join('\n')
  ].join('\n\n'));
  const bullets = (items, empty) => items.length ? items.map(item => `- ${item}`).join('\n') : empty;
  return ['## Материал для решения', `**Вопрос.** ${question}`, `**Главный вопрос.** ${main}`,
    '### Механизм', mechanism, '### Подтверждено прогоном', facts.join('\n\n') || 'Прогонов нет.',
    '### Выводы по коду', bullets(inferences, 'Отдельных выводов по коду нет.'),
    '### Варианты', ...options, `**Рекомендация.** ${line(brief.recommendation, 'recommendation')}`,
    '### Что не проверено', bullets(unchecked, 'По указанной постановке открытых проверок нет.'),
    '### Решения человека', actions.map((action, i) => `${i + 1}. ${action}`).join('\n')].join('\n\n');
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
  else if (process.argv.length !== 2) throw new Error(usage);
  else console.log(render(JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

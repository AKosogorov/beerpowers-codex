// Форматирует имена веток и заголовки публикаций по проектным Git-настройкам.
export function formatFlow(task) {
  const changes = task.repos.filter(r => r.override);
  const text = ['# Git-flow ' + task.code, '', '| Репозиторий | База | Выпуск |', '|---|---|---|',
    ...changes.map(r => '| ' + r.name + ' | `' + r.base + '` | — |'), ''];
  if (task.dependencies.length) text.push('## Зависимости', '', ...task.dependencies.map(d => '- `' + d + '` — мержится раньше.'), '');
  return text.join('\n');
}

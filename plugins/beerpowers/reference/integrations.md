# Интеграции задачи

Запускай обработчики установленного пакета из корня внешнего workspace. В примерах PowerShell `$node` — проверенный исполняемый файл Node 24, `$packageRoot` — путь из диагностики навыка, `$taskName` — точное имя существующей задачи. Относительные пути файлов задачи указывай от корня workspace.

## Figma

Для экспорта возьми ссылку на выделенный фрейм с параметром `node-id`. Владелец доступа заполняет `FIGMA_TOKEN` либо личный `.codex/figma-settings.json` проекта или `$CODEX_HOME/figma-settings.json`. При отсутствии `CODEX_HOME` используется `~/.codex`.

```powershell
& $node (Join-Path $packageRoot 'bin/figma-export.mjs') $selectionUrl --save $taskName --scale 2
```

Результат содержит `node`, относительный `path` внутри `memory/tasks/<код>/figma/`, размеры PNG, число байтов и SHA-256. Открой кадр и сверь выбранный фрейм. Для заданного пути передай `--out <путь.png>` вместо `--save`. Без обоих флагов команда возвращает URL рендера. Для отчёта используй локальный файл. При ошибке доступа, рендера или проверки PNG укажи причину.

## Вёрстка и Chrome

Прогони сценарий на проверяемом экране и укажи фактические артефакты в [гейте тестера](feature-implementation.md).

Из корня checkout команда `node --test tests/codex-ui.mjs` проверяет доступ к локальной странице и размеры снимков на ширине 375 и 1440 px. Сценарий запускает установленный браузер с отдельным временным профилем.

```powershell
$bin = Join-Path $packageRoot 'bin'
& $node (Join-Path $bin 'layout-check.mjs') $taskName $repoName
$layoutStatus = $LASTEXITCODE
& $node (Join-Path $bin 'cdp-screenshot.mjs') --find-chrome
& $node (Join-Path $bin 'cdp-screenshot.mjs') --viewports
```

`layout-check` принимает один или несколько проектов. Прочитай строки по файлам. Код 0 допускает сокращение матрицы по правилам команды. При коде 1 нужен прогон всех ширин, при коде 2 сначала восстанови базу, историю или checkout. Размеры берутся из `viewports` в `.codex/workspace.json`. Личный путь к Chrome, Chromium или Edge задаётся переменной `BEERPOWERS_CHROME`.

Для шагов, ожиданий и проверки результата используй `cdp-run` с собственным временным профилем. Укажи действительный адрес dev-сервера в `baseUrl` файла сценариев или передай `--base-url`.

```powershell
$env:SCREENSHOT_TASK = $taskName
& $node (Join-Path $bin 'cdp-run.mjs') $scenariosPath --out $resultPath
```

Файл сценариев содержит объект с массивом `scenarios`. У сценария укажи `name`, `viewport` (имя или `"*"` для всех), массив `steps` и DOM-выражения `state`. Шаг `{"screenshot":"{name}.png"}` оставляет кадр в `memory/tasks/<код>/screenshots/`. Каждый запуск получает свой путь `--out`. Проверь код завершения, число строк JSONL, `ok`, значения `state`, `stateErrors`, события `network` и `console`. Открой PNG каждой нужной ширины и сопоставь с критериями задачи. Режим `--only имя` повторяет выбранный сценарий. Синтаксис шагов доступен через `--help`.

Для отдельного кадра и измерения DOM выбери свободный локальный `CDP_PORT`, новый временный каталог профиля и выполни `cdp-screenshot.mjs --launch <каталог>`. Сохрани PID и порт. Передай тому же обработчику одним аргументом JSON-массив с `url`, `viewport` либо `width` и `height`, относительным `out` и при необходимости `probe`. Для Windows PowerShell 5.1 следующий блок передаёт JSON из UTF-8 файла без преобразования кавычек оболочкой. Переменные `$specPath`, `$bin`, `$node`, `SCREENSHOT_TASK` и `CDP_PORT` задаются в текущей оболочке.

```powershell
@'
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const [runner, spec] = process.argv.slice(2);
const data = readFileSync(spec, 'utf8').replace(/^\uFEFF/, '');
const child = spawnSync(process.execPath, [runner, data], { stdio: 'inherit' });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
'@ | & $node - (Join-Path $bin 'cdp-screenshot.mjs') $specPath
```

В результате сверь `metrics`, `messages`, `out` и содержимое PNG. После проверки закрой запущенный сеанс через `cdp-screenshot.mjs --close` на сохранённом порту. Состояния и кадры для отчёта описаны в [навыке проверки экрана](../skills/page-screenshot/SKILL.md).

## Трекер и ревью

Для `task-start PROJECT-123` прочитай постановку, комментарии и вложения через `tracker.mjs preview PROJECT-123`. Обычный старт применяет проверенный снимок по `digest`. При нескольких проектных адаптерах сначала согласуй выбор. Внешняя запись проходит по правилам конкретной операции. Выбор адаптера, аргументы и артефакты описаны в [маршруте трекера](../commands/tracker.md).

Для каждого затронутого репозитория с финальным ревью выполни `publication.mjs prepare <код> <репо>` с UTF-8 JSON в stdin. Покажи весь план из результата `prepared` в текущем чате, включая заголовок, подписанное описание, исполнителя, ревьюеров и назначение. После явного согласия на показанный план повтори с теми же байтами JSON и `--confirm <digest>`. Перед записью используй результат `confirmed`, который заново проверяет SHA источника и цели. Поля входа, GitLab MR, GitHub PR и порядок ответов на замечания описаны в [маршруте подготовки публикации](git-flow.md#подготовка-mr-и-pr).

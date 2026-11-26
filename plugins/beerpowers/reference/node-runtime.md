# Выбор Node для обработчиков BeerPowers

Минимальная **проверенная** версия — **Node.js 24.22.3**. Она нужна для перечисленных ниже обработчиков JavaScript. Команды продукта могут предъявлять собственные требования к Node, PHP, браузеру или другим инструментам.

## PowerShell в Windows

Для справки запусти нужный обработчик с `--help`. Справка работает и вне Git-проекта. Например, `git-workspace.mjs --help` перечисляет операции, а `workspace.pl review-diff --help` показывает аргументы проверки.

Если Node отсутствует в PATH, задай переменную окружения текущего сеанса `BEERPOWERS_NODE` абсолютным путём к уже установленному и проверенному `node.exe`. Например, если этот путь известен в переменной `$knownNodePath`, выполни `$env:BEERPOWERS_NODE = $knownNodePath`. Используй путь к самому файлу, без кавычек внутри значения и без аргументов. Такое присваивание действует в текущем процессе и его дочерних процессах. В новом вызове оболочки повтори присваивание либо используй уже переданную переменную окружения. Запись в профиль PowerShell не требуется.

В той же оболочке подготовь `$node`. Явно заданный путь имеет приоритет. Если переменная пуста, выбери приложение `node.exe` из PATH. Проверь путь, затем запусти исполняемый файл для проверки версии.

```powershell
if ($env:BEERPOWERS_NODE) {
    $candidate = $env:BEERPOWERS_NODE
    if ($candidate -notmatch '^[A-Za-z]:[\\/]') { throw 'BEERPOWERS_NODE must be an absolute local path to node.exe' }
} else {
    $candidate = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
$binary = Get-Item -LiteralPath $candidate -ErrorAction Stop
if ($binary -isnot [IO.FileInfo] -or $binary.Name -ine 'node.exe') { throw 'Expected node.exe' }
$node = $binary.FullName
$reportedVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $reportedVersion -notmatch '^v([0-9]+\.[0-9]+\.[0-9]+)$') { throw 'Cannot verify Node version' }
if ([version]$Matches[1] -lt [version]'24.22.3') { Write-Warning 'This Node version is below the tested 24.22.3 baseline' }
"Node $reportedVersion ($node)"
```

Для вызовов передавай путь к обработчику отдельным аргументом, например `& $node (Join-Path $packageRoot 'bin/update.mjs') plan`. В POSIX shell укажи известный путь к Node либо используй `command -v node`, затем запусти выбранный файл с `--version` и проверь версию перед вызовом обработчика. Если проверка не прошла, укажи, какой конкретный шаг остался невыполненным.

## Маршруты и зависимости

| Маршрут или операция | Среда обработчика пакета |
| --- | --- |
| Базовые `setup` и `doctor` для одного продукта с профилем `main-default` | [workspace.pl](../bin/workspace.pl) и Git. Команда тестов при настройке записывается. Базовая диагностика проверяет файлы и может собрать `role-packet` средствами Perl. |
| Текстовый `task-start` одного продукта на обычной базе, включая `--preview` и lean, `team-lazy`, `team-up`, `team-down`, реализация feature | В основной ветке `workspace.pl` запускает `task-start`, `review-diff`, `role-packet`, `handover` и `feature-state` средствами Perl и Git. Зависимости реальной команды тестов и выбранных дополнительных проверок определяются отдельно. |
| Хуки пакета | [Реестр хуков](../hooks/hooks.json) вызывает Perl. Для срабатывания необходимо доверие хоста. |
| `onboard`, `product-onboard` | Node проверяет ссылки тем памяти и источники фактов. [Проверка памяти](onboard-memory.md) |
| `feature` как продуктовая команда, fast и full PM | Node читает статус документов и следующий checkpoint. [PM-маршрут](../commands/feature.md) |
| `decision-brief`, `update`, `token-audit` | Node формирует бриф, планирует и применяет миграцию или обрабатывает переданные метрики. [Бриф](../commands/decision-brief.md), [миграция](../commands/update.md), [аудит токенов](../commands/token-audit.md) |
| Многопродуктовый Git, дополнительные профили, рабочие деревья, проверка влитости и `worktrees-clear` | Node запускает `git-workspace.mjs`. Для операций Git нужен также Git. [Команды адаптера](git-flow.md) |
| Трекер, подготовка MR/PR, экспорт Figma, браузерные проверки и снимки | Node нужен при вызове соответствующего адаптера — `tracker.mjs`, `publication.mjs`, `figma-export.mjs`, `cdp-run.mjs`, `cdp-screenshot.mjs` или `layout-check.mjs`. Доступность интеграции и браузера проверяется отдельно. |

Для [расширенного отчёта doctor](../bin/doctor.mjs), [ретроспективы](../commands/retro.md), [parallel-tests](parallel-tests.md) и [mutants](mutants.md) используй проверенный Node. Retro вызывает token-audit и Git-адаптер через тот же интерпретатор. QA запускает проектный раннер и сохраняет результаты в workspace. Базовый вывод Perl doctor подтверждает выполненные им проверки.

Для Perl-обработчика расширенного `task-start` в той же оболочке установи `$env:BEERPOWERS_NODE = $node`. [Выбор ветки](../bin/task-integrations.pl) учитывает ключ трекера, несколько продуктов или профилей, явные Git-опции, существующие документы интеграции и восстановление незавершённой операции. В этих случаях Perl вызывает Node-адаптер. Обычный текстовый single-product lean на `main-default` с пустым `BEERPOWERS_GIT_TASKS` и без состояния интеграции идёт по Perl-ветке.

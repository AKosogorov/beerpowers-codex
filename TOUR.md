# 🗺️ Экскурсия по плагину

Маршрут для человека, который хочет понять BeerPowers от устройства проекта до правил конкретной роли. Первые три остановки описывают архитектуру и команду. Дальше можно идти по жизненному циклу задачи или сразу открыть нужную тему.

## 🧭 1. Что это и как устроено

1. [README](README.md) объясняет, для каких проектов подходит плагин, как его установить в Codex Desktop и пройти путь от постановки до MR.
2. [Инструкции репозитория](AGENTS.md) описывают, что входит в поставку, где живут исходные шаблоны и как проверяется пакет.
3. [Контракт workspace](plugins/beerpowers/reference/workspace.md) задаёт расположение Git-репозиториев, рабочих деревьев, памяти и конфигурации. Его термины используются во всех следующих остановках.

## 📦 2. Что получает проект

1. Открой локальный пробный workspace после setup. Сначала посмотри корневой `AGENTS.md`, `.codex/workspace.json` и `.codex/git-settings.json`, затем устав, бриф тимлида, одну роль из `.codex/agents/` и индекс `memory/MEMORY.md`. Порядок показывает, откуда в бриф попадают правила, кто владеет настройками и где остаются проектные факты.
2. [Доставка инструкций](plugins/beerpowers/reference/instructions.md) показывает, какие файлы управляются плагином и как правило проекта попадает в бриф роли. Сравни свой устав и индекс памяти с соответствующими шаблонами. Границы управляемых блоков отмечены маркерами `beerpowers:engine`.
3. [Setup](plugins/beerpowers/commands/setup.md) объясняет разведку, выбор рабочего трека и Git-профилей, подтверждение команд и источников, подбор стековых скиллов и слотов, план записи и проверку результата. Для повторения в чистом workspace начни с [первого запуска](README.md#-первый-запуск).

## 👥 3. Как работает команда

1. [Team-up](plugins/beerpowers/commands/team-up.md) задаёт режимы A/B/C/D, брифы и способ продолжить работу уже поднятой роли. По матрице выбирают объём координации, независимость ревью и порядок делегирования.
2. [Тимлид](plugins/beerpowers/templates/charter/team-lead.md) выбирает класс задачи до первого вызова роли, проверяет исходную базу, ведёт развилки и гейты, затем закрывает задачу.
3. [Устав](plugins/beerpowers/templates/charter/team-charter.md) задаёт общий порядок работы ролей, отчёты, границы работы с Git и процессами, правила диффа, шкалу находок и маршрут при отрицательном вердикте.
4. [Протокол intake](plugins/beerpowers/reference/intake-protocol.md) объясняет, когда риск и цена обратного хода требуют уточнения, независимого оппонента или дизайн-прохода.
5. [Маршрут реализации фичи](plugins/beerpowers/reference/feature-implementation.md) связывает эти правила с фактическими гейтами и возобновлением работы по записанным результатам.

## 🔄 4. Жизненный цикл задачи

1. [Task-start](plugins/beerpowers/commands/task-start.md) читает постановку, сверяет базу и создаёт артефакты. Повторный вызов умеет вернуть работу к первому незакрытому этапу.
2. [Раскладка задачи](plugins/beerpowers/reference/tasks-layout.md) объясняет, где лежат постановка, preflight, checkout, план, тесты, ревью и handover.
3. [Team-lazy](plugins/beerpowers/commands/team-lazy.md) ведёт небольшую задачу от отдельного dry-run постановки до тестов и финального ревью.
4. [Git-маршрут](plugins/beerpowers/reference/git-flow.md) описывает профили `main-default`, `dev-default`, `custom`, выбор базы, коммиты, push, публикацию, стенд и выпуск.
5. [Рабочие деревья](plugins/beerpowers/reference/worktrees.md) объясняют параллельные checkout, запуск проектных setup и teardown, сверку данных задачи и уборку.
6. [Трекер](plugins/beerpowers/commands/tracker.md) описывает чтение постановки, комментарии, вложения, формы задачи и бага, связи и переходы.
7. [Team-down](plugins/beerpowers/commands/team-down.md) фиксирует точку остановки, [retro](plugins/beerpowers/commands/retro.md) переносит уроки закрытых задач в память, [worktrees-clear](plugins/beerpowers/commands/worktrees-clear.md) показывает и выполняет план уборки.

## 🎭 5. Роли

Начни с того, кто принимает решение о реализации, затем посмотри бриф исполнителя и человека, чью работу он принимает. Setup подставляет в заготовки те стековые обязательства, которые удалось подтвердить по коду проекта.

1. [Архитектор](plugins/beerpowers/templates/roles/architect-agent.md) ведёт дизайн, ADR, план и пересмотр решения.
2. [Бэкенд](plugins/beerpowers/templates/roles/backend-agent.md), [БД](plugins/beerpowers/templates/roles/database-agent.md), [фронтенд](plugins/beerpowers/templates/roles/frontend-agent.md) и [DevOps](plugins/beerpowers/templates/roles/devops-agent.md) отвечают за разные участки изменений.
3. [Тестировщик](plugins/beerpowers/templates/roles/testing-agent.md) отвечает за регрессии, полные прогоны, пробы и проверку интерфейса.
4. [Ревьюер](plugins/beerpowers/templates/roles/reviewer-agent.md) берёт проверяемую базу и актуальный дифф, применяет гейты и пишет вердикт. [Аудитор](plugins/beerpowers/templates/roles/auditor-agent.md) разбирает отдельные риски безопасности и производительности.
5. [Исследователь](plugins/beerpowers/templates/roles/explorer-agent.md) читает ограниченную область кода и возвращает факты с источниками. [Стековые пресеты](plugins/beerpowers/templates/roles/presets/) содержат заготовки для слотов, [зависимости навыков](plugins/beerpowers/reference/skill-dependencies.md) помогают проверить работу роли в текущем чате.

## 🧠 6. Память проекта

1. [Индекс памяти](plugins/beerpowers/templates/memory/MEMORY.md) определяет владельцев правил, куда класть находку и что делает запись долговечной.
2. Тематические заготовки лежат в [шаблонах памяти](plugins/beerpowers/templates/memory/). Там можно открыть карту и инварианты проекта, команды, известные проблемы, техдолг, тесты, ADR и протокол уроков.
3. [Onboard](plugins/beerpowers/commands/onboard.md) описывает, как добыть знания из кода и записать их по источникам. [Протокол записи](plugins/beerpowers/reference/onboard-memory.md) также применяется на продуктовой дорожке.

## 🛡️ 7. Страховки

1. [Реестр хуков](plugins/beerpowers/hooks/hooks.json) перечисляет события, а [обработчик](plugins/beerpowers/hooks/dispatch.pl) направляет каждый вход в нужный барьер.
2. [Справка о хуках](plugins/beerpowers/reference/hooks.md) описывает доверие Codex Desktop, условия срабатывания барьеров, проектные настройки и как проверить реальную доставку события.
3. [Правила ответа](plugins/beerpowers/rules/reply_blocking_asks.md) задают форму действий, которые ждут человека. [Обработчики барьеров](plugins/beerpowers/hooks/) можно читать по конкретному запрету, например для push или остановки процессов.

## 🛠️ 8. Инструменты ролей

1. [Bin](plugins/beerpowers/bin/) содержит помощники установленного пакета. Начни с `git-workspace.mjs` для базы и рабочих деревьев, `tracker.mjs` для интеграции, `cdp-screenshot.mjs` и `cdp-run.mjs` для браузера, `workspace-check.mjs` для проектной диагностики. Назначение указано в шапках файлов, аргументы команд показывает `--help`.
2. [Параллельные тесты](plugins/beerpowers/reference/parallel-tests.md) объясняют слоты, изоляцию и проверку результатов. [Мутационные пробы](plugins/beerpowers/reference/mutants.md) проверяют чувствительность тестов к конкретному изменению.
3. [Скиллы](plugins/beerpowers/skills/) содержат дисциплины проектирования, отладки и минимального диффа, а также рабочие инструкции для скриншотов, трекера и итогов MR.

## 📝 9. Продуктовая дорожка

1. [Feature](plugins/beerpowers/commands/feature.md) ведёт пожелание от intake до плана. [PM-конвейер](plugins/beerpowers/reference/feature-pipeline.md) задаёт артефакты и входы между этапами.
2. [Продакт](plugins/beerpowers/templates/roles/product-agent.md) связывает постановку с пользователями, контекстом, проверяемыми критериями и метриками. [Product-onboard](plugins/beerpowers/commands/product-onboard.md) объясняет, как собрать эту память по существующему продукту.

## 🔧 10. Сопровождение

1. [Update](plugins/beerpowers/commands/update.md) и [миграции](plugins/beerpowers/reference/migrations.md) описывают перенос шаблонов и защиту ручных правок.
2. [Doctor](plugins/beerpowers/commands/doctor.md) показывает, как понять, что неисправно, и проверить исправление.
3. [Token-audit](plugins/beerpowers/commands/token-audit.md) разбирает расход токенов по выгрузкам. [Decision-brief](plugins/beerpowers/commands/decision-brief.md) собирает материалы для отдельного решения.

## ✅ 11. Проверки пакета

1. [GitHub Actions](.github/workflows/validate.yml) запускает валидацию на Windows и Linux. [Валидатор](.github/scripts/validate_codex.mjs) проверяет пакет, ссылки, миграции и локальные сценарии.
2. [Тесты](tests/) покрывают setup, хуки, Git, интеграции и восстановление задач во временных workspace. Для изучения одного сценария начни с его фикстуры и проверяемого результата.
3. [CHANGELOG](CHANGELOG.md) помогает понять, когда нужен update. [ROADMAP](ROADMAP.md) перечисляет отложенные практики и условия их переноса.

# Работа над BeerPowers

Этот репозиторий публикует пакет `beerpowers-codex` в локальном каталоге `akosogorov-codex`. Пишите документацию и инструкции на русском. Для конвенциональных коммитов используйте русское описание.

## Состав пакета

- [`plugins/beerpowers/`](plugins/beerpowers/) — всё, что устанавливается в профиль Codex. [Манифест](plugins/beerpowers/.codex-plugin/plugin.json) хранит версию поставки и SHA исходного BeerPowers.
- [`skills/`](plugins/beerpowers/skills/) содержит девять навыков с самостоятельными условиями запуска и адаптер явных вызовов `$beerpowers <команда>`. [`commands/`](plugins/beerpowers/commands/) содержит инструкции 16 публичных команд. Вспомогательные процессы остаются внутренними.
- [`bin/`](plugins/beerpowers/bin/) и [`hooks/`](plugins/beerpowers/hooks/) работают из установленного пакета. Рабочий каталог обработчика — внешний Git-workspace.
- [`templates/`](plugins/beerpowers/templates/) содержит ресурсы setup и update. Редактируйте их в пакете. Проектные инструкции и ручные правки учитывайте по правилам миграции. [Доставка инструкций](plugins/beerpowers/reference/instructions.md) · [Миграции](plugins/beerpowers/reference/migrations.md)

## Проверки

Из корня checkout запустите `node .github/scripts/validate_codex.mjs`. Для быстрой проверки пакета добавьте `--package-only`. Для полной проверки нужны Node 24, Git, Perl и браузер, доступный CDP. Windows использует Perl из Git for Windows. [Выбор Node](plugins/beerpowers/reference/node-runtime.md) · [CI](.github/workflows/validate.yml)

Для правок управляемых шаблонов или их генерации проверьте [реестр миграций](plugins/beerpowers/reference/migrations.md#локальная-проверка-реестра) командой `node .github/scripts/check_migrations.mjs --base <коммит>`.

Интеграционные тесты в [`tests/`](tests/) работают с временными workspace, локальными API и учебными данными. Установку, доверие к хукам и работу ролей проверяйте отдельно в новом чате Codex Desktop. [Проверка хуков](plugins/beerpowers/reference/hooks.md)

## Выпуск

Для выпуска согласованной версии обновите `version` в манифесте Codex и добавьте непустой раздел `## <версия> — <ГГГГ-ММ-ДД>` в [CHANGELOG](CHANGELOG.md). После push изменения манифеста в `main` [GitHub Actions](.github/workflows/release.yml) запускает проверки и создаёт GitHub Release с тегом `v<версия>` на этом коммите. Уже опубликованная версия пропускается.

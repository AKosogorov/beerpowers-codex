# Установка и запуск команд BeerPowers

## Диагностика установки

Возьми абсолютный путь к **этому** `SKILL.md` из записи выбранного навыка, раскрыв алиас корня по каталогу навыков Codex. Если путь не предоставлен или выбор неоднозначен, сообщи, что происхождение навыка установить не удалось. Поиск одноимённого файла в проекте или профиле не подтверждает выбор навыка.

В PowerShell задай `$skillFile` этим точным путём и выполни блок в том же вызове оболочки. На другом хосте выполни те же проверки доступными средствами чтения файлов. Используй только чтение.

```powershell
$ErrorActionPreference = 'Stop'
$skill = Get-Item -LiteralPath $skillFile
$root = $skill.Directory.Parent.Parent
$userRoot = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$profileRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $userRoot '.codex' }
$cache = Join-Path $profileRoot 'plugins/cache/akosogorov-codex/beerpowers-codex'
$expectedCache = Get-Item -LiteralPath $cache
if ($root.Parent.FullName -ne $expectedCache.FullName -or
    $skill.FullName -ne (Join-Path $root.FullName 'skills/beerpowers/SKILL.md').Replace('/', [IO.Path]::DirectorySeparatorChar)) {
    throw "Skill outside expected package: $($skill.FullName)"
}
$file = Get-Item -LiteralPath (Join-Path $root.FullName '.codex-plugin/plugin.json')
$manifest = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
if ($manifest.name -cne 'beerpowers-codex' -or -not $manifest.version -or
    $manifest.upstream.name -cne 'beerpowers' -or -not $manifest.upstream.version -or
    $manifest.upstream.commit -cnotmatch '^[0-9a-f]{40}$') {
    throw "Invalid BeerPowers manifest: $($file.FullName)"
}
[pscustomobject]@{
    skill = $skill.FullName
    manifest = $file.FullName
    package = $manifest.name
    version = $manifest.version
    upstreamVersion = $manifest.upstream.version
    upstreamCommit = $manifest.upstream.commit
} | ConvertTo-Json
```

## Запуск обработчика

Запускай обработчик из проверенного пакета с рабочим каталогом во внешнем workspace. Для JavaScript используй [выбор Node](node-runtime.md "beerpowers:reference/node-runtime.md"). В новых вызовах оболочки переменные нужно задать заново.

Для Windows используй Perl, поставляемый с Git for Windows. Задай `$packageRoot` точным путём к проверенному пакету, затем в том же вызове PowerShell выполни подготовку ниже и команду из обработчика:

```powershell
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$gitDir = Split-Path -Parent (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
$perl = Join-Path (Split-Path -Parent $gitDir) 'usr/bin/perl.exe'
if (!(Test-Path -LiteralPath $perl -PathType Leaf)) { throw "Git for Windows Perl missing: $perl" }
$handler = Join-Path $packageRoot 'bin/workspace.pl'
```

В Unix используй `perl "$packageRoot/bin/workspace.pl"` с теми же аргументами. Учитывай код выхода обработчика. Для `doctor` приведи значения из проверки установки даже при ошибке проекта.

## Что обновляет плагин

Исполняемые файлы из `bin/`, хуки из `hooks/` и вызываемые ими шаблоны хуков запускаются из установленного пакета. Их версию определяет манифест. Новые файлы приходят при обновлении плагина.

Setup собирает проектные брифы в `.codex/agents/`. В AGENTS.md, уставе, инструкциях тимлида и индексе памяти update управляет участками между метками `beerpowers:engine`. Настройки, собранные брифы, память и пользовательские хуки принадлежат проекту. [Правила миграции](migrations.md "beerpowers:reference/migrations.md")

## Проверки проекта через Make

Если в `memory/commands/<репо>.md` записана команда `make …`, выполняй её из фактического checkout проекта. На Windows замени вызов `make` на [make-shim](../bin/make-shim) из проверенного пакета. Сохрани цели, флаги, присваивания и кавычки. Запиши в отчёт исполненную команду, рабочий каталог и код выхода.

Пример для сохранённой команды `make check` в PowerShell. Значение `$packageRoot` берётся из диагностики установки, а `$checkout` из выбранного рабочего дерева.

```powershell
$gitDir = Split-Path -Parent (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
$makeBash = Join-Path (Split-Path -Parent $gitDir) 'bin/bash.exe'
if (!(Test-Path -LiteralPath $makeBash -PathType Leaf)) { throw "Git for Windows Bash missing: $makeBash" }
$makeShim = Join-Path $packageRoot 'bin/make-shim'
Push-Location -LiteralPath $checkout
try {
    & $makeBash $makeShim check
    $makeExit = $LASTEXITCODE
} finally {
    Pop-Location
}
```

В Git Bash форма вызова из checkout — `bash "$packageRoot/bin/make-shim" check`. На Windows нужны MSYS2 с Bash и пакет `make` (`pacman -S make`). Для установки вне `C:/msys64` задай `BEERPOWERS_MSYS2_ROOT` в окружении процесса. MSYS2 Make запускает рецепты с указанной в Makefile оболочкой, включая `/bin/bash`. Shim экспортирует `TMP` и `TEMP` для нативного PHP. На Linux и macOS выполняй сохранённую команду напрямую.

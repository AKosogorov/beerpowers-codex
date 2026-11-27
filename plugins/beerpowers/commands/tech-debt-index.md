# Пересборка индекса технического долга

Из корня внешнего workspace выбери Node по [инструкции](../reference/node-runtime.md) и выполни:

```powershell
& $node (Join-Path $packageRoot 'bin/tech-debt-index.mjs')
```

Команда пересобирает таблицу в `memory/tech-debt/tech-debt.md` из карточек долга. Ручной текст вокруг таблицы сохраняется. Сообщи число пунктов и значение `changed`. При ошибке назови файл и поле, которое требует сверки. [Формат карточки и диагностика](../reference/doctor-checks.md).

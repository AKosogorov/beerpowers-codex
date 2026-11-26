#!/usr/bin/env node
// Печатает непустой раздел `## <версия> — <дата>` из CHANGELOG.md без заголовка.
import fs from 'node:fs'

const version = process.argv[2]
if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(version ?? '')) {
  console.error('Укажите числовую версию: node .github/scripts/release_notes.mjs <версия>')
  process.exit(2)
}

const lines = fs.readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/)
const prefix = `## ${version} — `
const start = lines.findIndex((line) => line.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(line.slice(prefix.length)))
if (start < 0) {
  console.error(`в CHANGELOG.md нет раздела «## ${version} — <дата>»`)
  process.exit(1)
}
const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
const notes = lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim()
if (!notes) {
  console.error(`В CHANGELOG.md пустой раздел версии ${version}`)
  process.exit(1)
}
console.log(notes)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const files = []
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(?:ts|tsx)$/.test(entry) && !/workspaceCopy\.ts$|I18n\.tsx$|routeRegistry\.tsx$/.test(path)) files.push(path)
  }
}
walk(root)
const findings = []
for (const path of files) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const count = lines.filter(line => /[\u3400-\u9fff]/.test(line) && !/\b(?:copy|tr|workspaceCopy)\s*\(/.test(line) && /<|(?:label|title|placeholder|aria-label)\s*[=:]/.test(line)).length
  if (count) findings.push({ file: relative(root, path).replaceAll('\\', '/'), count })
}
findings.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
console.log(JSON.stringify({ filesWithPotentialUiCopy: findings.length, potentialUiLines: findings.reduce((sum, item) => sum + item.count, 0), highestPriority: findings.slice(0, 20) }, null, 2))

// Lists the Chinese in src/ that has no English pair, so it would show as
// Chinese in the English interface (design audit L6-20: the old rule counted
// paired copy too, 771 lines, and skipped routeRegistry, so it could not be
// a gate).
//
// A Chinese string literal is paired when:
// - it sits in an [English, Chinese] pair or a [Chinese, English] one
//   (say("…", "…"), tr("…", "…"), ["…", "…"]), on one line or split over two;
// - it is a ternary's other branch: english ? "English" : "中文";
// - it is a key of a dictionary entry with an English value ('中文': 'English')
//   anywhere in src/, which copy() and workspaceCopy() look it up in, or the
//   value of an English key ('English': '中文', [/English/, "中文"]);
// - it is the value of a key that also has an English value in the same file
//   (copy files that keep an English and a Chinese object with the same keys);
// - it is a stored value compared or matched, not shown (===, includes(),
//   case …, a regular expression), or its line says "language-audit: stored value".
// The Chinese dictionary of I18n.tsx is keyed by message ids, so it is skipped.
// The ${…} expressions of a template literal are checked on their own.
//
// node scripts/audit-interface-language.mjs [--list] [--max=N] [--root=<folder>]
// --list prints every finding; --max=N exits 1 when there are more than N.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// --root=<folder> scans another folder (the script's own test uses it).
const rootArgument = process.argv.find((arg) => arg.startsWith('--root='))
const root = rootArgument ? rootArgument.slice(7) : fileURLToPath(new URL('../src/', import.meta.url))
const CJK = /[㐀-鿿]/
const files = []
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(?:ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) files.push(path)
  }
}
walk(root)

// Code without comments, line by line (a block comment's lines become empty).
function codeLines(source) {
  const out = []
  let inBlock = false
  for (const line of source.split(/\r?\n/)) {
    let code = ''
    let rest = line
    while (rest.length) {
      if (inBlock) {
        const end = rest.indexOf('*/')
        if (end < 0) { rest = ''; break }
        inBlock = false
        rest = rest.slice(end + 2)
        continue
      }
      const start = rest.search(/\/\*|\/\//)
      if (start < 0) { code += rest; break }
      // A "//" inside a string (a URL) is not a comment.
      const before = rest.slice(0, start)
      const quotes = (before.match(/(?<!\\)["'`]/g) || []).length
      if (quotes % 2 === 1) { code += rest.slice(0, start + 2); rest = rest.slice(start + 2); continue }
      code += before
      if (rest.startsWith('//', start)) { rest = ''; break }
      inBlock = true
      rest = rest.slice(start + 2)
    }
    out.push(code)
  }
  return out
}

const Q = String.raw`(["'\x60])`
const BODY = String.raw`((?:\\.|(?!\1)[^\\\n])*)`
const LITERAL = new RegExp(Q + BODY + String.raw`\1`, 'g')
const isEnglish = (value) => !CJK.test(value)
const lastLiteral = (text) => [...text.matchAll(LITERAL)].at(-1)
const firstLiteral = (text) => text.match(new RegExp(String.raw`^\s*` + Q + BODY + String.raw`\1`))
// The text a literal shows: a template's ${…} expressions are not part of it.
const shownText = (quote, value) => (quote === '`' ? value.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '') : value)
// A literal ends the text (ignoring spaces): "…" ,  or "…" :
const endsWithLiteral = (text, separator) => new RegExp(Q + BODY + String.raw`\1\s*` + separator + String.raw`\s*$`).test(text)

// Every '中文': 'English' entry in src/, for copy() and workspaceCopy().
const dictionary = new Set()
const PAIR = new RegExp(String.raw`(["'])((?:\\.|(?!\1)[^\\\n])*)\1\s*:\s*(["'\x60])((?:\\.|(?!\3)[^\\\n])*)\3`, 'g')
for (const path of files) {
  for (const line of codeLines(readFileSync(path, 'utf8'))) {
    for (const match of line.matchAll(PAIR)) if (CJK.test(match[2]) && isEnglish(match[4])) dictionary.add(match[2])
  }
}

// Keys that have an English value somewhere in a file.
const KEYED = new RegExp(String.raw`(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:\s*(["'\x60])((?:\\.|(?!\2)[^\\\n])*)\2`, 'g')
function englishKeysOf(lines) {
  const keys = new Set()
  for (const line of lines) for (const match of line.matchAll(KEYED)) if (isEnglish(match[3])) keys.add(match[1])
  return keys
}

function paired({ line, index, value, length, englishKeys, previousLine, nextLine }) {
  if (dictionary.has(value)) return true
  const before = line.slice(0, index)
  const after = line.slice(index + length)
  // [English, Chinese] or say("English", "Chinese")
  if (endsWithLiteral(before, ',') && isEnglish(lastLiteral(before)[2])) return true
  // [Chinese, English] or tr("Chinese", "English")
  const next = after.match(new RegExp(String.raw`^\s*,\s*` + Q + BODY + String.raw`\1`))
  if (next && isEnglish(next[2])) return true
  // english ? "English" : "中文"
  if (endsWithLiteral(before, ':') && /\?\s*["'`]/.test(before) && isEnglish(lastLiteral(before)[2])) return true
  // zh ? "中文" : "English"
  const other = after.match(new RegExp(String.raw`^\s*:\s*` + Q + BODY + String.raw`\1`))
  if (other && isEnglish(other[2]) && /\?\s*$/.test(before)) return true
  // 'English': '中文'
  if (endsWithLiteral(before, ':') && isEnglish(lastLiteral(before)[2]) && !/\?\s*["'`]/.test(before)) return true
  // [/English pattern/, "中文"], and [/pattern/, null, "中文"] (the recorded English kept).
  if (/\/[gimsuy]*\s*,\s*$/.test(before) && !/["'`]\s*,\s*$/.test(before)) return true
  if (/\/[gimsuy]*\s*,\s*null\s*,\s*$/.test(before)) return true
  // key: "中文" beside key: "English" in the same file.
  const keyed = before.match(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:\s*$/)
  if (keyed && englishKeys.has(keyed[1])) return true
  // A pair split over two lines.
  if (/^\s*$/.test(before) && endsWithLiteral(previousLine, ',') && isEnglish(lastLiteral(previousLine)[2])) return true
  const following = /^\s*,?\s*[\])]?\s*,?\s*$/.test(after) ? firstLiteral(nextLine) : null
  if (following && isEnglish(following[2])) return true
  // A stored value matched, not shown.
  if (/(?:===|!==|==|!=|\bcase|\.includes\(|\.has\(|\.startsWith\(|\.endsWith\(|\.test\(|\.indexOf\()\s*$/.test(before)) return true
  if (/^\s*(?:===|!==)/.test(after)) return true
  return false
}

const findings = []
for (const path of files) {
  const file = relative(root, path).replaceAll('\\', '/')
  if (file === 'i18n/I18n.tsx') continue
  const source = readFileSync(path, 'utf8')
  if (source.includes('language-audit: stored values file')) continue
  const lines = codeLines(source)
  const englishKeys = englishKeysOf(lines)
  lines.forEach((line, number) => {
    if (!CJK.test(line) || line.includes('language-audit: stored value')) return
    // Regular expressions match stored or typed text; they are not shown.
    // Strings are masked first, so a slash inside one is not taken for a
    // pattern; a pattern with Chinese is blanked in place.
    const masked = line.replace(LITERAL, (literal) => literal[0] + 'x'.repeat(literal.length - 2) + literal[0])
    let code = line
    for (const match of masked.matchAll(/(?<![\w)\]])\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\[])+\/[gimsuy]*/g)) {
      const pattern = line.slice(match.index, match.index + match[0].length)
      if (CJK.test(pattern)) code = code.slice(0, match.index) + '/' + ' '.repeat(pattern.length - 2) + '/' + code.slice(match.index + pattern.length)
    }
    const previousLine = lines.slice(0, number).reverse().find((candidate) => candidate.trim()) || ''
    const nextLine = lines.slice(number + 1).find((candidate) => candidate.trim()) || ''
    for (const match of code.matchAll(LITERAL)) {
      if (!CJK.test(shownText(match[1], match[2]))) continue
      if (paired({ line: code, index: match.index, value: match[2], length: match[0].length, englishKeys, previousLine, nextLine })) continue
      findings.push({ file, line: number + 1, text: match[2].slice(0, 60) })
    }
    // JSX text between tags.
    for (const match of code.replace(LITERAL, '""').matchAll(/>([^<>{}]*[㐀-鿿][^<>{}]*)</g)) {
      findings.push({ file, line: number + 1, text: match[1].trim().slice(0, 60) })
    }
  })
}

const byFile = new Map()
for (const finding of findings) byFile.set(finding.file, (byFile.get(finding.file) || 0) + 1)
const ranked = [...byFile].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
const list = process.argv.includes('--list')
console.log(JSON.stringify({ unpairedChineseLiterals: findings.length, files: ranked.length, highestPriority: ranked.slice(0, 20), ...(list ? { findings } : {}) }, null, 2))
const max = process.argv.find((arg) => arg.startsWith('--max='))
if (max && findings.length > Number(max.slice(6))) process.exitCode = 1

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { SUPPORTED_LOCALES, assertSupportedLocale } from './workspace-settings-contract.mjs'
import { aiV2Formats } from './ai-assistant-v2-display.mjs'
import { formatCalendarDay, formatDateTimeInTimeZone } from '../../src/lib/format.ts'
import { PUBLIC_DATA_WORKSPACE_DATASETS } from '../../scripts/public-data/plan.mjs'

// Design audit L11-27: the regional format had only en-US and zh-CN, so the UK
// workspace (UCI) could only write dates the American way; and the timezone
// could still change after posting, which would move posted days by one.
// Dates and numbers follow the workspace's regional format, never a person's
// interface language (AGENTS.md).
const root = resolve(import.meta.dirname, '../..')
const read = (file) => readFileSync(join(root, file), 'utf8')

test('en-GB is a regional format the server, the database and the settings page accept', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['zh-CN', 'en-US', 'en-GB'])
  assert.equal(assertSupportedLocale('en-GB'), 'en-GB')
  assert.throws(() => assertSupportedLocale('en-AU'), (error) => error.code === 'LOCALE_NOT_SUPPORTED')
  // The newest migration that sets the tenant's locale check allows exactly the supported list.
  const migrations = readdirSync(join(root, 'prisma/migrations')).filter((name) => /^\d/.test(name)).sort()
  const latest = migrations.map((name) => read(`prisma/migrations/${name}/migration.sql`)).filter((sql) => sql.includes('"Tenant_locale_supported_check"')).at(-1)
  const allowed = latest.match(/ADD CONSTRAINT "Tenant_locale_supported_check"\s+CHECK \("locale" IN \(([^)]*)\)\)/)[1].match(/'([^']+)'/g).map((value) => value.slice(1, -1))
  assert.deepEqual(allowed.sort(), [...SUPPORTED_LOCALES].sort())
  const settings = read('src/modules/settings/WorkspaceSettings.tsx')
  assert.match(settings, /\{ value: "en-GB", label: "English \(United Kingdom\) — en-GB" \}/)
  assert.match(read('src/i18n/I18n.tsx'), /export type SupportedLocale = "zh-CN" \| "en-US" \| "en-GB";/)
})

test('an en-GB workspace writes the day first on pages and in the assistant, whatever the language', () => {
  assert.equal(formatCalendarDay('2026-11-18', 'en-GB'), '18 Nov 2026')
  assert.equal(formatCalendarDay('2026-11-18', 'en-US'), 'Nov 18, 2026')
  assert.match(formatDateTimeInTimeZone('2026-11-18T09:30:00Z', 'en-GB', 'Europe/London'), /^18 Nov 2026, 09:30$/)
  const british = aiV2Formats({ locale: 'en-GB', timezone: 'Europe/London' })
  assert.equal(british.day('2026-11-18'), '18 Nov 2026')
  assert.equal(british.money(1234.5, 'GBP'), '£1,234.50')
})

test('no page or server text formats a date or number by the interface language', () => {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path) } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) files.push(path)
    }
  }
  for (const directory of ['src', 'server', 'shared']) walk(join(root, directory))
  const LANGUAGE = String.raw`(?:language|lang|i18n\.language|effectiveLanguage|answerLanguage|documentLanguage)`
  const patterns = [
    // Intl formatters and toLocale…String take the locale first.
    new RegExp(String.raw`(?:Intl\.(?:DateTimeFormat|NumberFormat)|\.toLocale(?:Date|Time)?String)\(\s*${LANGUAGE}\s*[,)]`),
    // The app's helpers take it after the value.
    new RegExp(String.raw`\b(?:formatCalendarDay|formatDateTimeInTimeZone|formatInstantDay|formatDayOrInstant|formatAmount|formatDecimal)\((?:[^(),]|\([^()]*\))*,\s*${LANGUAGE}\s*[,)]`),
  ]
  const hits = []
  for (const file of files) {
    read(relative(root, file)).split('\n').forEach((line, index) => {
      if (patterns.some((pattern) => pattern.test(line))) hits.push(`${relative(root, file)}:${index + 1}`)
    })
  }
  assert.deepEqual(hits, [])
})

test('the timezone locks once posted transactions exist, and the settings page says why in both languages', () => {
  const route = read('server/routes/pilot-workspace.routes.mjs')
  assert.match(route, /timezoneLocked: baseCurrencyLocked,/)
  assert.match(route, /if \(locked && timezone !== current\.timezone\) fail\('TIMEZONE_LOCKED', 'Timezone cannot change after posted transactions exist\.', 409\)/)
  const settings = read('src/modules/settings/WorkspaceSettings.tsx')
  assert.match(settings, /locked=\{workspace\.timezoneLocked \? t\("settings\.timezoneLocked"\) : ""\}/)
  assert.match(settings, /TIMEZONE_LOCKED: own\("settings\.timezoneLocked"\)/)
  const i18n = read('src/i18n/I18n.tsx')
  for (const key of ['settings.timezoneLocked', 'settings.localeHint']) assert.equal(i18n.match(new RegExp(`"${key.replace('.', '\\.')}": `, 'g'))?.length, 2, key)
})

test('the UK public-data workspace is seeded with the British regional format, the US one with the American', () => {
  assert.equal(PUBLIC_DATA_WORKSPACE_DATASETS.uci.locale, 'en-GB')
  assert.equal(PUBLIC_DATA_WORKSPACE_DATASETS.m5.locale, 'en-US')
  assert.match(read('scripts/public-data/seed.mjs'), /timezone: profile\.timezone, locale: profile\.locale, countryCode: profile\.countryCode/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assertSupportedCurrency,
  assertSupportedLanguage,
  assertSupportedLocale,
  assertSupportedTimezone,
  effectiveLanguage,
  mergeOperationalSettings,
  normalizeLanguagePreference,
} from './workspace-settings-contract.mjs'

test('workspace localization priority separates language, locale, and timezone', () => {
  const tenant = { defaultLanguage: 'en-US', locale: 'zh-CN', timezone: 'America/New_York' }
  assert.equal(effectiveLanguage({ languagePreference: 'zh-CN' }, tenant), 'zh-CN')
  assert.equal(effectiveLanguage({ languagePreference: null }, tenant), 'en-US')
  assert.equal(effectiveLanguage({}, { defaultLanguage: '' }), 'en-US')
  assert.equal(normalizeLanguagePreference('workspace'), null)
  assert.equal(tenant.locale, 'zh-CN')
  assert.equal(tenant.timezone, 'America/New_York')
})

test('workspace localization and base currency accept only governed values', () => {
  assert.equal(assertSupportedLanguage('en-US'), 'en-US')
  assert.equal(assertSupportedLocale('zh-CN'), 'zh-CN')
  assert.equal(assertSupportedTimezone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(assertSupportedCurrency('usd'), 'USD')
  assert.throws(() => assertSupportedLanguage('fr-FR'), error => error.code === 'LANGUAGE_NOT_SUPPORTED')
  assert.throws(() => assertSupportedLocale('fr-FR'), error => error.code === 'LOCALE_NOT_SUPPORTED')
  assert.throws(() => assertSupportedTimezone('free text'), error => error.code === 'TIMEZONE_NOT_SUPPORTED')
  assert.throws(() => assertSupportedCurrency('人民币'), error => error.code === 'CURRENCY_NOT_SUPPORTED')
})

test('PostgreSQL operational settings seed covers Phase 4 numbering and review policies', () => {
  const settings = mergeOperationalSettings({})
  for (const name of ['Return Request', 'Return Authorization', 'Return Posting', 'Supplier Invoice', 'Customer Invoice', 'Credit Memo / Credit Note']) {
    assert.ok(settings.numbering.rules.some(rule => rule.document === name))
  }
  for (const name of ['Return Authorization', 'Supplier Invoice Match Exception', 'Payable Approval', 'Customer Credit Note Approval']) {
    assert.ok(settings.review.policies.some(policy => policy.name === name))
  }
})

test('formal settings navigation removes legacy mixed-language entries and uses i18n keys', () => {
  const routes = readFileSync(new URL('../../src/app/routeRegistry.tsx', import.meta.url), 'utf8')
  const i18n = readFileSync(new URL('../../src/i18n/I18n.tsx', import.meta.url), 'utf8')
  const workspace = readFileSync(new URL('../../src/modules/settings/WorkspaceSettings.tsx', import.meta.url), 'utf8')
  for (const legacy of ['settings:workspace', 'settings:pilot-users', 'settings:pilot-setup', 'Pilot Users', 'Pilot Setup Status']) assert.doesNotMatch(routes, new RegExp(legacy))
  for (const key of ['settings.profile', 'settings.company', 'settings.roles', 'settings.warehouse', 'settings.readiness']) assert.match(i18n, new RegExp(`"${key.replace('.', '\\.')}"`))
  assert.match(workspace, /flowchain:localization-changed/)
  assert.match(workspace, /locale-format-preview/)
})

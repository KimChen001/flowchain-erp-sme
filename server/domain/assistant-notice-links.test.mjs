import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20, item 23: with AI off, no model, the month's
// allowance used or the model down, every question got one sentence back and
// nothing else. The notice now offers the pages that work without the model.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the notices that leave no answer offer Today, the reorder list and Reports', () => {
  const links = read('src/modules/ai-assistant/v2/NoAssistantLinks.tsx')
  assert.match(links, /new Set\(\["ai_off", "no_provider", "over_cap", "unavailable"\]\)/)
  for (const route of ['overview:risks', 'inventory:reorder', 'reports:overview']) assert.ok(links.includes(`["${route}", "ai.v2.elsewhere.`), route)
  // Shown under the welcome notice and under an answer's notice.
  assert.match(read('src/modules/ai-assistant/Panel.tsx'), /\{notice && NOTICES_WITHOUT_ANSWERS\.has\(notice\) \? <NoAssistantLinks onNavigate=\{minimizeAfterNavigate\} \/> : null\}/)
  assert.match(read('src/modules/ai-assistant/v2/AssistantV2Answer.tsx'), /message\.notices\.some\(\(code\) => NOTICES_WITHOUT_ANSWERS\.has\(code\)\) \? <NoAssistantLinks onNavigate=\{onNavigate\} \/> : null/)
})

test('the links read in both languages', () => {
  const i18n = read('src/i18n/I18n.tsx')
  for (const [key, english, chinese] of [
    ['lead', 'These work without the assistant:', '以下页面无需助手即可使用：'],
    ['today', 'Today', '今日'], ['reorder', 'Reorder list', '补货清单'], ['reports', 'Reports', '报表'],
  ]) {
    assert.ok(i18n.includes(`"ai.v2.elsewhere.${key}": "${english}",`), key)
    assert.ok(i18n.includes(`"ai.v2.elsewhere.${key}": "${chinese}",`), key)
  }
})

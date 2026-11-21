import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20, item 23: with AI off, no model, the month's
// allowance used or the model down, every question got one sentence back and
// nothing else. The notice now offers the pages that work without the model.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the notices that leave no answer offer Today, the reorder list and Reports, where the reader may open them', () => {
  const list = read('src/modules/ai-assistant/v2/assistantElsewhere.ts')
  assert.match(list, /new Set\(\["ai_off", "no_provider", "over_cap", "unavailable"\]\)/)
  for (const route of ['overview:risks', 'inventory:reorder', 'reports:overview']) assert.ok(list.includes(`["${route}", "ai.v2.elsewhere.`), route)
  assert.match(list, /return ELSEWHERE_LINKS\.filter\(\(\[routeId\]\) => canOpenRoute\(routeId\)\)/)
  const links = read('src/modules/ai-assistant/v2/NoAssistantLinks.tsx')
  assert.match(links, /const canOpenRoute = useRouteAvailability\(\);/)
  assert.match(links, /const language = answerLanguage \|\| interfaceLanguage;/)
  // The panel sits inside the provider, so the hook answers for this reader.
  assert.match(read('src/app/FlowChainApp.tsx'), /<RouteAvailabilityProvider value=\{canOpenRoute\}>\s*<AiPanel/)
  // Under the welcome notice, and under the latest answer only, in its language.
  assert.match(read('src/modules/ai-assistant/Panel.tsx'), /\{notice && NOTICES_WITHOUT_ANSWERS\.has\(notice\) \? <NoAssistantLinks onNavigate=\{minimizeAfterNavigate\} \/> : null\}/)
  assert.match(read('src/modules/ai-assistant/v2/AssistantV2Answer.tsx'), /\{latest && message\.notices\.some\(\(code\) => NOTICES_WITHOUT_ANSWERS\.has\(code\)\) \? <NoAssistantLinks onNavigate=\{onNavigate\} language=\{message\.language\} \/> : null\}/)
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

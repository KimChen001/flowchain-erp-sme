import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const overviewPath = path.join(repoRoot, 'src', 'modules', 'overview', 'Page.tsx')

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

test('overview page uses the authoritative procurement runtime without mounting the legacy cockpit', () => {
  const overview = readSource(overviewPath)

  assert.match(overview, /function RuntimeHomepage\b/)
  assert.match(overview, /"\/api\/home\/overview"/)
  assert.doesNotMatch(overview, /"\/api\/procurement\/(requests|orders|rfqs)"/)
  assert.match(overview, /import AiSuggestionsPage from "\.\/AiSuggestionsPage"/)
  assert.match(overview, /<AiSuggestionsPage\b/)
  assert.doesNotMatch(overview, /<TodayCockpitPanel\b/)
  assert.doesNotMatch(overview, /<TodayCockpitRecentDocuments\b/)
  assert.doesNotMatch(overview, /function TodayCockpitV2Panel/)
  assert.doesNotMatch(overview, /function CockpitInventoryRiskList/)
  assert.doesNotMatch(overview, /function cockpitCardValue/)
})

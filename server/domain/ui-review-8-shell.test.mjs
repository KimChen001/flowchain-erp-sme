import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Round 8 of the UI review: the parts of every page around the content.
// A walk of the main pages at 1440 px and on a 390 px phone found the same
// word three times on top of Today (trail, tab, title), two entries to the
// assistant, tab rows folding onto two lines (ten under Settings, six on a
// phone), column names scrolling away on 50-row lists and Today's tiles drawn
// unlike the cards on every other page.

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('a one-step trail is not shown, and a list page keeps its trail off a phone', async () => {
  const crumb = await read('src/components/navigation/AppBreadcrumb.tsx')
  assert.match(crumb, /if \(items\.length < 2\) return null;/)
  assert.match(crumb, /route\.pageType === "detail" \? "" : "max-sm:hidden"/)
})

test('the assistant has one entry, its floating button', async () => {
  const app = await read('src/app/FlowChainApp.tsx')
  assert.doesNotMatch(app, /\{t\("nav\.ai"\)\}/)
  const panel = await read('src/modules/ai-assistant/Panel.tsx')
  assert.match(panel, /data-testid="ai-assistant-toggle"/)
})

test('a phone keeps the public data note to two lines until it is opened', async () => {
  const note = await read('src/app/PublicDataNote.tsx')
  assert.match(note, /open \? undefined : "line-clamp-2 sm:line-clamp-none"/)
})

test('module tabs stay on one row that scrolls, with arrows from a tablet up', async () => {
  const shell = await read('src/components/navigation/ModuleShell.tsx')
  assert.match(shell, /<div className="fc-subnav-track" ref=\{subnav\.ref\}/)
  assert.match(shell, /data-testid="module-subnav-earlier"/)
  assert.match(shell, /data-testid="module-subnav-more"/)
  // The active tab is brought into view until the reader moves the row.
  assert.match(shell, /if \(moved\.current \|\| !active/)
  const css = await read('src/styles/theme.css')
  assert.match(css, /\.fc-subnav-track \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/)
  assert.match(css, /\.fc-subnav-arrow \{[^}]*hidden[^}]*sm:flex/)
  assert.doesNotMatch(css, /\.fc-module-subnav \{ @apply flex flex-wrap/)
})

test('a long list keeps its column names in view from a tablet up', async () => {
  const css = await read('src/styles/theme.css')
  const block = css.slice(css.indexOf('@media screen and (min-width: 640px) {'))
  assert.match(block, /\.overflow-x-auto:has\(> table\[data-list-cards\]\) \{\s*max-height: calc\(100dvh - 120px\);/)
  assert.match(block, /> thead > tr > th \{\s*position: sticky;\s*top: 0;\s*z-index: 30;/)
  // Above the sticky first and Actions cells, below an open row menu's cell (50).
  const menu = await read('src/components/ui/listLayout.tsx')
  assert.match(menu, /cell\.style\.zIndex = "50"/)
})

test('cut-off text in a list shows in full on hover', async () => {
  const table = await read('src/components/ui/workbenchTable.ts')
  assert.match(table, /tables\.forEach\(labelListTable\);\s*titleTruncatedText\(element\);/)
  assert.match(table, /if \(node\.title && node\.dataset\.autoTitle !== "true"\) continue;/)
})

test("Today's tiles are drawn like the cards on the list pages", async () => {
  const page = await read('src/modules/overview/Page.tsx')
  assert.match(page, /icon: ListChecks, color: A\.blue/)
  assert.match(page, /icon: AlarmClock, color: A\.red/)
  assert.match(page, /<TileIcon icon=\{FileClock\} color=\{A\.purple\} \/>/)
  // Count first, then its name, as ActionableMetricCard reads.
  assert.match(page, /<div className=\{TILE_VALUE\}>\{tile\.value\}<\/div>\s*<div className="fc-label mt-0\.5"/)
})

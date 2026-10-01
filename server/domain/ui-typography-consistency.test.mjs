import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('workbench table typography defines body header and link scales', () => {
  const source = readSource('src', 'components', 'ui', 'workbenchTable.ts')

  assert.match(source, /tableBodyTextClass = typography\.tableCell/)
  assert.match(source, /thClass = `text-left px-4 py-3 \$\{typography\.tableHeader\} whitespace-nowrap`/)
  assert.match(source, /thRightClass = `text-right px-4 py-3 \$\{typography\.tableHeader\} whitespace-nowrap`/)
  assert.match(source, /tableLinkClass = `\$\{typography\.tableLink\} tabular-nums hover:underline/)
  assert.doesNotMatch(source, /tableMinLgClass = "w-full min-w-\[1280px\] text-xs"/)
})

test('typography tokens expose consolidated operational scale', () => {
  const source = readSource('src', 'components', 'ui', 'typography.ts')

  assert.match(source, /pageTitle: "text-\[20px\] leading-7 font-semibold/)
  assert.match(source, /moduleTitle: "text-\[20px\] leading-7 font-semibold/)
  assert.match(source, /modalTitle: "text-\[16px\] leading-6 font-semibold/)
  assert.match(source, /sectionTitle: "text-\[14px\] leading-5 font-semibold/)
  assert.match(source, /body: "text-\[13px\] leading-5/)
  assert.match(source, /tableHeader: "text-\[13px\] leading-5 font-semibold/)
  assert.match(source, /tableCell: "text-\[13px\] leading-5/)
  assert.match(source, /tableLink: "text-\[13px\] leading-5 font-medium/)
  assert.match(source, /formLabel: "text-\[13px\] leading-5 font-semibold/)
  assert.match(source, /chip: "text-\[12px\] leading-\[18px\] font-semibold/)
})

test('primary procurement table id links use table link class', () => {
  const purchasing = readSource('src', 'modules', 'purchasing', 'Page.tsx')
  const requests = readSource('src', 'modules', 'purchase-requests', 'CanonicalProcurementPanel.tsx')

  for (const source of [purchasing, requests]) {
    assert.match(source, /tableLinkClass/)
    assert.match(source, /className=\{tableLinkClass\}/)
  }
})

test('shared field input and chip typography follows compact SaaS scale', () => {
  const source = readSource('src', 'components', 'ui', 'index.tsx')

  assert.match(source, /import \{ typography \} from "\.\/typography"/)
  assert.match(source, /fc-status-chip/)
  assert.match(source, /className=\{`h-8 inline-flex items-center gap-1\.5 rounded-lg px-3 \$\{typography\.denseButton\}`\}/)
  assert.match(source, /text-\[13px\] leading-5 font-semibold/)
  assert.match(source, /fc-section-title/)
  assert.match(source, /fc-modal-title/)
  assert.match(source, /fontSize: 13, lineHeight: "20px"/)
})

test('AI assistant evidence and actions use compact typography tokens', () => {
  const source = readSource('src', 'modules', 'ai-assistant', 'Panel.tsx')

  assert.match(source, /import \{ typography \} from "\.\.\/\.\.\/components\/ui\/typography"/)
  assert.match(source, /aiEvidenceLinkClass = `max-w-full text-left \$\{typography\.compactMetadata\} font-medium truncate hover:underline`/)
  assert.match(source, /aiEvidenceTitleClass = `\$\{typography\.compactMetadata\} font-medium truncate`/)
  assert.match(source, /aiEvidenceMetaClass = `\$\{typography\.compactMetadata\} truncate`/)
  assert.match(source, /aiActionPillClass = `rounded-full px-2\.5 py-1 \$\{typography\.compactMetadata\} font-medium`/)
  assert.match(source, /aiBoundaryNoticeClass = `\$\{typography\.metadata\} text-slate-600`/)
  assert.match(source, /className=\{aiEvidenceLinkClass\}/)
  assert.match(source, /className=\{aiActionLinkClass\}/)
  assert.match(source, /className=\{aiBoundaryNoticeClass\}/)
  assert.doesNotMatch(source, /text-sm text-slate-600/)
})

test('action draft review shell keeps evidence links and draft actions on shared typography tokens', () => {
  const source = readSource('src', 'modules', 'action-drafts', 'ActionDraftReviewShell.tsx')

  assert.match(source, /import \{ typography \} from "\.\.\/\.\.\/components\/ui\/typography"/)
  assert.match(source, /draftButtonClass = `h-8 rounded-lg px-3 \$\{typography\.denseButton\} disabled:cursor-not-allowed`/)
  assert.match(source, /draftEvidenceTitleClass = `\$\{typography\.metadata\} font-semibold`/)
  assert.match(source, /draftEvidenceLinkClass = `text-left \$\{draftEvidenceTitleClass\} hover:underline`/)
  assert.match(source, /draftEvidenceMetaClass = typography\.compactMetadata/)
  assert.match(source, /className=\{draftEvidenceLinkClass\}/)
})

test('Forecast MRP and S&OP tables use shared workbench typography scale', () => {
  const source = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const activeSource = source.split('// Legacy forecast block removed in favor of S&OP engine above')[0]

  assert.match(activeSource, /from "\.\.\/\.\.\/components\/ui\/workbenchTable"/)
  assert.match(activeSource, /tableBodyTextClass/)
  assert.match(activeSource, /className=\{thClass\}/)
  assert.match(activeSource, /className=\{thWideClass\}/)
  assert.match(activeSource, /className=\{tdNumericClass\}/)
  assert.match(activeSource, /className=\{tdWideNumericClass\}/)
  assert.doesNotMatch(activeSource, /<table className="w-full text-xs">/)
})

test('global search results use dedicated search result typography tokens', () => {
  const source = readSource('src', 'app', 'FlowChainApp.tsx')

  assert.match(source, /import \{ typography \} from "\.\.\/components\/ui\/typography"/)
  assert.match(source, /typography\.searchResultTitle/)
  assert.match(source, /typography\.searchResultMeta/)
  assert.doesNotMatch(source, /<span className="text-\[11px\] font-semibold" style=\{\{ color: A\.label \}\}>搜索结果<\/span>/)
})

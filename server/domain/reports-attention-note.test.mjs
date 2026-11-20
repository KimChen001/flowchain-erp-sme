import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Product review 2026-11-20, item 14: the Reports overview said every card
// counts with the current filters, but Items to reorder is the reorder list
// as it stands today, whatever the filters.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

test('the attention note says Items to reorder ignores the filters, in both languages', () => {
  const note = 'Counts use the current filters, except Items to reorder, which is the reorder list as it stands today. Select a card to review the source records.'
  assert.ok(read('src/modules/reports/OverviewAttention.tsx').includes(`{copy('${note}')}`))
  const copy = read('src/modules/reports/analyticsCopy.ts')
  assert.ok(copy.includes(`'${note}': '数量基于当前筛选（“待补货物料”除外，它与今日的补货清单一致），点击卡片查看来源记录。',`))
  // The reorder card reads the reorder list, not the filtered rows.
  assert.match(read('server/domain/business-overview.mjs'), /id: 'items_to_reorder', label: 'Items to reorder', count: reorder\.orderNow/)
})

test('the match-rate description says approved differences count as matched', () => {
  const rate = 'Share of submitted supplier invoices whose three-way match passed, or whose differences a person approved.'
  assert.ok(read('server/domain/runtime-report-read-model.mjs').includes(`'${rate}'`))
  assert.ok(read('src/modules/reports/analyticsCopy.ts').includes(`'${rate}': '已提交采购发票中三单匹配通过、或差异已由人工批准的比例。',`))
})

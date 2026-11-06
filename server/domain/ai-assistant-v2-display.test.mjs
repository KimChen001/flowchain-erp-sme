import test from 'node:test'
import assert from 'node:assert/strict'
import { aiV2CodeLabels, aiV2DisplayStrings, aiV2Formats, aiV2TextTidier, aiV2UserTypedDate } from './ai-assistant-v2-display.mjs'

// How assistant v2 writes dates, amounts, quantities and record numbers
// (2026-11-05 review of a live run: the prose said "due 2026-11-01",
// "5,000 USD", "7000 pcs", "PO-014" and "(未关闭,也未全部收货)" beside cards
// that said "Nov 1, 2026", "$5,000.00", "7,000" and LOCAL-DEMO-PO-014).

const formats = aiV2Formats({ locale: 'en-US', timezone: 'America/New_York' })
const records = () => ['LOCAL-DEMO-PO-014', 'LOCAL-DEMO-GRN-012', 'LOCAL-DEMO-INV-001', 'LOCAL-DEMO-SO-001', 'LDM-002', 'LOCAL-DEMO-PO-001', 'OTHER-PO-001']

test('the formats are the cards\': medium dates, amounts with two decimals, grouped quantities', () => {
  assert.equal(formats.day('2026-11-04'), 'Nov 4, 2026')
  // A timestamp is the day it falls on in the workspace's timezone.
  assert.equal(formats.day('2026-11-05T03:00:00Z'), 'Nov 4, 2026')
  assert.equal(formats.day('2026-02-30'), null)
  assert.equal(formats.money(2500, 'USD'), '$2,500.00')
  assert.equal(formats.money(5, 'usd'), '$5.00')
  assert.equal(formats.money(5, null), null)
  assert.equal(formats.quantity(7000, 'pcs'), '7,000 pcs')
  // Another locale writes its own way, whatever the answer's language.
  assert.equal(aiV2Formats({ locale: 'de-DE' }).money(19120.5, 'EUR').replace(/\s/gu, ' '), '19.120,50 €')
  assert.equal(aiV2Formats({ locale: 'not a locale', timezone: 'Nowhere/City' }).day('2026-11-04'), 'Nov 4, 2026')
})

test('a result gets display strings beside its dates, amounts and large quantities; nothing else changes', () => {
  const result = { asOf: '2026-11-05T10:00:00Z', currency: 'USD', rows: [{ orderNumber: 'PO-1', dueDate: '2026-11-04', amount: 2500, currency: 'USD', remaining: 7000, received: 20, unit: 'pcs', open: true, ref: { type: 'purchase_order', id: 'po1', label: 'PO-1' } }] }
  const shown = aiV2DisplayStrings(result, formats)
  assert.deepEqual(shown.rows[0], { ...result.rows[0], dueDateText: 'Nov 4, 2026', amountText: '$2,500.00', remainingText: '7,000 pcs' })
  assert.equal(shown.asOf, result.asOf)
  assert.equal('asOfText' in shown, false)
  // A price is an amount in its own currency; a suggested quantity is in the item's unit.
  const lines = aiV2DisplayStrings({ rows: [{ item: { sku: 'X', unit: 'pcs' }, suggestedQuantity: { value: 1735, source: 'cover_days' }, estimatedUnitPrice: { value: 100, currency: 'USD' } }] }, formats)
  assert.equal(lines.rows[0].suggestedQuantity.valueText, '1,735 pcs')
  assert.equal(lines.rows[0].estimatedUnitPrice.valueText, '$100.00')
  // An amount with no currency gets none.
  assert.equal('amountText' in aiV2DisplayStrings({ rows: [{ amount: 5 }] }, formats).rows[0], false)
})

test('the text tidier rewrites dates, amounts, quantities and shortened record numbers', () => {
  const { tidy } = aiV2TextTidier({ language: 'en-US', formats, records, units: () => ['ft'] })
  assert.equal(tidy('Due 2026-11-01; Amount: 5,000 USD; $79,692.50 USD in all; USD 2,500 more.'), 'Due Nov 1, 2026; Amount: $5,000.00; $79,692.50 in all; $2,500.00 more.')
  assert.equal(tidy('7000 pcs and 1200 ft, 2026 deliveries, 1.9万美元, 5k USD'), '7,000 pcs and 1,200 ft, 2026 deliveries, 1.9万美元, 5k USD')
  // A short form that one record ends with is written whole; a full number,
  // a SKU and a form two records end with stay as written.
  assert.equal(tidy('PO-014, GRN-012, INV-001 and SO-001; LDM-002; PO-001; Q3-2026; ISO-9001'), 'LOCAL-DEMO-PO-014, LOCAL-DEMO-GRN-012, LOCAL-DEMO-INV-001 and LOCAL-DEMO-SO-001; LDM-002; PO-001; Q3-2026; ISO-9001')
  // English keeps ASCII punctuation.
  assert.equal(tidy('Done (mostly): yes!'), 'Done (mostly): yes!')
})

test('Chinese text gets full-width punctuation next to Chinese words, never between digits or in a link', () => {
  const { tidy } = aiV2TextTidier({ language: 'zh-CN', formats, records })
  assert.equal(tidy('目前有 15 张未完成的采购订单(未关闭,也未全部收货),明细见上表。'), '目前有 15 张未完成的采购订单（未关闭，也未全部收货），明细见表中。')
  assert.equal(tidy('逾期最久: LOCAL-DEMO-PO-020(Precision Fastener Works):逾期 15 天,7000 pcs 未收。'), '逾期最久：LOCAL-DEMO-PO-020（Precision Fastener Works）：逾期 15 天，7,000 pcs 未收。')
  assert.equal(tidy('不客气!'), '不客气！')
  assert.equal(tidy('影响哪些销售订单?'), '影响哪些销售订单？')
  assert.equal(tidy('时间 10:30,数量 1,000 件'), '时间 10:30，数量 1,000 件')
  assert.equal(tidy('累计 19,120 美元,差异 200 USD。'), '累计 $19,120.00，差异 $200.00。')
  assert.equal(tidy('见 [指南](https://example.com/a) 和 ![图](a.png)'), '见 [指南](https://example.com/a) 和 ![图](a.png)')
  assert.equal(tidy('1) 第一步\n2) 第二步'), '1) 第一步\n2) 第二步')
  // A piece continues what was already sent: a closing parenthesis follows its opening one.
  assert.equal(tidy('收货)。', '订单（未全部'), '收货）。')
  assert.equal(tidy('x) 和', '[a](b'), 'x) 和')
})

test('a follow-up question is tidied whole, or left as written when it would not fit', () => {
  const { line } = aiV2TextTidier({ language: 'zh-CN', formats, records, maxLength: 20 })
  assert.equal(line('PO-014 会影响哪些订单?'), 'PO-014 会影响哪些订单?')
  assert.equal(aiV2TextTidier({ language: 'zh-CN', formats, records, maxLength: 90 }).line('PO-014 会影响哪些订单?'), 'LOCAL-DEMO-PO-014 会影响哪些订单？')
})

test('a date the user typed is theirs, in any of the forms people type', () => {
  for (const [value, typed] of [['Nov 20, 2026', 'we need them by Nov 20'], ['2026-11-20', 'by 20 November'], ['11月20日', '要在 11/20 前到'], ['Nov 20', '交期 2026-11-20']]) {
    assert.equal(aiV2UserTypedDate(value, typed), true, value)
  }
  assert.equal(aiV2UserTypedDate('Nov 21, 2026', 'by Nov 20'), false)
  assert.equal(aiV2UserTypedDate('Nov 20, 2026', 'How many are late?'), false)
})

test('codes the results give alone get their words: a request\'s status, a signal type, a priority', () => {
  const result = { rows: [{ type: 'po_overdue', ref: { type: 'purchase_order', id: 'p', label: 'PO-1' }, status: 'issued' }, { type: 'grn_rejected_qty', priority: 'high', status: 'submitted', ref: { type: 'purchase_request', id: 'r', label: 'PR-1' } }] }
  const en = aiV2CodeLabels(result, 'en-US')
  assert.deepEqual([en.rows[0].typeLabel, en.rows[0].statusLabel], ['Overdue purchase order', undefined])
  assert.deepEqual([en.rows[1].typeLabel, en.rows[1].priorityLabel, en.rows[1].statusLabel], ['Rejected on receipt', 'High', 'Waiting for approval'])
  const zh = aiV2CodeLabels(result, 'zh-CN')
  assert.deepEqual([zh.rows[1].typeLabel, zh.rows[1].priorityLabel, zh.rows[1].statusLabel], ['收货拒收', '高', '待审批'])
  // A label the result already gives stays.
  assert.equal(aiV2CodeLabels({ status: 'x', statusLabel: 'Kept', ref: { type: 'purchase_request', id: 'r', label: 'PR' } }, 'en-US').statusLabel, 'Kept')
})

// A live re-check on 2026-11-05: Chinese dates in their own format, units as
// stored codes, "the table above" with the table below, codes in quotes, and
// no space between Chinese and numbers.
const unitLabel = (language) => (unit, quantity) => ({ box: [quantity === 1 ? 'box' : 'boxes', '箱'], roll: [quantity === 1 ? 'roll' : 'rolls', '卷'], pcs: ['pcs', '件'] }[unit]?.[language === 'zh-CN' ? 1 : 0] || unit)
const withUnits = (language) => aiV2TextTidier({ language, formats: aiV2Formats({ unitLabel: unitLabel(language) }), records, units: () => ['box', 'roll', 'pcs'] })

test('Chinese dates are written in the workspace format, ranges too', () => {
  const { tidy } = withUnits('zh-CN')
  assert.equal(tidy('上个季度（2026年7月1日至9月30日）共 $17,440.00。'), '上个季度（Jul 1, 2026 至 Sep 30, 2026）共 $17,440.00。')
  assert.equal(tidy('统计期是 2026 年 8 月 8 日到 2026 年 11 月 5 日。'), '统计期是 Aug 8, 2026 到 Nov 5, 2026。')
  // A date with no year is a month and day; no year is made up (2026-11-05).
  assert.equal(tidy('承诺日期是 11 月 6 日和 11月8日。'), '承诺日期是 Nov 6 和 Nov 8。')
  assert.equal(tidy('11月20日前'), 'Nov 20 前')
  assert.equal(tidy('交货窗口 11月6日至8日，或 11 月 28 日到 12 月 2 日。'), '交货窗口 Nov 6 至 Nov 8，或 Nov 28 到 Dec 2。')
  assert.equal(tidy('2月30日'), '2月30日')
  assert.equal(tidy('2026年11月的支出'), '2026年11月的支出')
})

test('a stored unit reads in the answer\'s language and number', () => {
  assert.equal(withUnits('en-US').tidy('300 box and 1 box, 80 roll, 1450 box.'), '300 boxes and 1 box, 80 rolls, 1,450 boxes.')
  assert.equal(withUnits('zh-CN').tidy('还剩 300 box 未交，50 pcs 温度传感器。'), '还剩 300 箱未交，50 件温度传感器。')
  // A piece that ends after the unit: the Chinese after it comes next.
  assert.equal(withUnits('zh-CN').tidy('还剩 50 pcs ', '库存'), '还剩 50 件')
})

test('a display is never placed above or below in the text', () => {
  const en = withUnits('en-US').tidy
  assert.equal(en('The table above lists them; see the chart below. The above table is sorted, as listed above.'), 'The table lists them; see the chart. The table is sorted, as listed.')
  const zh = withUnits('zh-CN').tidy
  assert.equal(zh('上表只列出了前 10 项。明细见上表。如上表所示。下表中有 3 行。下面列出逾期最久的 6 个。'), '表中只列出了前 10 项。明细见表中。如表中所示。表中有 3 行。列出逾期最久的 6 个。')
  assert.equal(zh('以下表格和交货表现'), '以下表格和交货表现')
})

test('status and severity codes in quotes, after "status" or as codes read as words', () => {
  const en = withUnits('en-US').tidy
  assert.equal(en('It marks one as "risk" and one as “warning” (match status: variance); partially_received.'), 'It marks one as "Risk" and one as “Warning” (match status: Variance); Partially received.')
  assert.equal(en('Acme\'s "best" order, the word risk.'), 'Acme\'s "best" order, the word risk.')
  assert.equal(withUnits('zh-CN').tidy('状态：pending_approval，类型 po_overdue。'), '状态：待审批，类型 逾期采购订单。')
})

test('Chinese text keeps a space between Chinese and a number', () => {
  const { tidy } = withUnits('zh-CN')
  assert.equal(tidy('涉及5家供应商，共11项，第3张'), '涉及 5 家供应商，共 11 项，第 3 张')
  assert.equal(tidy('有', '共'), '有')
  assert.equal(tidy('5家', '涉及'), ' 5 家')
})

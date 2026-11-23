// The second #449 review's probes, written against d0691a5a (11/22): 40
// emails hunting a date proposed on the wrong order (W) and 30 ordinary,
// correct replies about several orders (R). Each runs as the paste runs it:
// cleanSupplierReply, the supplier's orders looked up when a number is
// written another way, emailRead as pasteSeveral sets it (or empty, as the
// one-order paste), then checkReplyReading with a hand-made reading. No model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReplyReading, cleanSupplierReply } from './supplier-reply-reading.mjs'
import { orderNumberVariants, orderNumbersNamed } from './supplier-reply-orders.mjs'

const A = 'PO-202611-0021'
const B = 'PO-202611-0014'
const C = 'PO-202611-0030'
const D = 'PO-202610-0014' // last month's order 14, same supplier (dedupe probe)
const RECEIVED = '2026-11-18'
const item = (ref, sku, remaining = 10) => ({ ref, purchaseOrderLineId: `${ref}-${sku}`, sku, supplierSku: null, itemName: `Item ${sku.slice(-3)}`, remaining, unit: 'pcs', promisedDate: '2026-11-25' })
const ORDERS = {
  [A]: { number: A, supplierName: 'Household 2', status: 'issued', lines: [item('L1', 'HOUSEHOLD_2_074'), item('L2', 'HOUSEHOLD_2_110'), item('L3', 'HOUSEHOLD_2_437')] },
  [B]: { number: B, supplierName: 'Household 2', status: 'issued', lines: [item('L1', 'HOUSEHOLD_2_044'), item('L2', 'HOUSEHOLD_2_110'), item('L3', 'HOUSEHOLD_2_437')] },
  [C]: { number: C, supplierName: 'Household 2', status: 'issued', lines: [item('L1', 'HOUSEHOLD_2_110'), item('L2', 'HOUSEHOLD_2_500')] },
}
const short = (n) => ({ [A]: 'A', [B]: 'B', [C]: 'C', [D]: 'D' }[n] || n)
const L = (line, date, quote, extra = {}) => ({ line, date, quote, dateKind: 'stated', ...extra })
const H110 = 'HOUSEHOLD_2_110'
const H437 = 'HOUSEHOLD_2_437'
const H074 = 'HOUSEHOLD_2_074'
const H044 = 'HOUSEHOLD_2_044'
const H500 = 'HOUSEHOLD_2_500'

// W: a date that must never be proposed on `on` (bad); some also carry the
// correct date for `on` (good).
const W = [
  // A part opened properly; B introduced by words the new rule does not take
  // as an opener; no blank line; B's lines follow (shared SKUs 110/437).
  { id: 'W01 "As for B:" (2-word header) -> B lines stay in A part, on A', email: `${A}:\n${H074} ships on 3 December.\nAs for ${B}:\n${H110} ships on 9 December.\n${H437} ships on 10 December.\n\nBest regards,\nLi Na`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`), L('L3', '2026-12-10', `${H437} ships on 10 December.`)], bad: [['L2', '2026-12-09'], ['L3', '2026-12-10']] },
  { id: 'W02 "For order B:" -> on A', email: `${A}:\n${H074} ships on 3 December.\nFor order ${B}:\n${H110} ships on 9 December.\n${H437} ships on 10 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W03 "Regarding B, please note the new dates:" -> on A', email: `${A}:\n${H074} ships on 3 December.\nRegarding ${B}, please note the new dates:\n${H110} ships on 9 December.\n${H437} ships on 10 December.`, on: A, lines: [L('L3', '2026-12-10', `${H437} ships on 10 December.`)], bad: [['L3', '2026-12-10']] },
  { id: 'W04 zh "关于 B 的交期如下：" after "A 的交期如下：" -> on A', email: `张经理您好，\n${A} 的交期如下：\n${H074} 12月3日发货。\n关于 ${B} 的交期如下：\n${H110} 12月9日发货。\n${H437} 12月10日发货。\n谢谢`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
  { id: 'W05 zh "另外，B 的交期如下：" -> on A', email: `${A} 的交期如下：\n${H074} 12月3日发货。\n另外，${B} 的交期如下：\n${H110} 12月9日发货。\n${H437} 12月10日发货。`, on: A, lines: [L('L3', '2026-12-10', `${H437} 12月10日发货。`)], bad: [['L3', '2026-12-10']] },
  { id: 'W06 "And B ships as follows:" -> on A', email: `${A}:\n${H074} ships on 3 December.\nAnd ${B} ships as follows:\n${H110} on 9 December.\n${H437} on 10 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W07 "Also, for B:" -> on A', email: `${A}:\n${H074} ships on 3 December.\nAlso, for ${B}:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W08 "Your order B:" (2 words) -> on A', email: `${A}:\n${H074} ships on 3 December.\nYour order ${B}:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W09 "With regard to B, the new dates are:" (old: held) -> on A', email: `${A}:\n${H074} ships on 3 December.\nWith regard to ${B}, the new dates are:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W10 pipe table, B row then blank order cell -> on A', email: `${A}: ${H074} ships on 3 December.\n| Order | SKU | Ship date |\n| ${B} | ${H044} | 5 December |\n| | ${H437} | 10 December |`, on: A, lines: [L('L3', '2026-12-10', `| | ${H437} | 10 December |`)], bad: [['L3', '2026-12-10']] },
  { id: 'W11 "Order number B:" -> on A', email: `${A}:\n${H074} ships on 3 December.\nOrder number ${B}:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W12 zh "至于 B 那边：" -> on A', email: `${A}：\n${H074} 12月3日发货。\n至于 ${B} 那边：\n${H110} 12月9日发货。`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
  { id: 'W13 "Please find below the dates for B:" (old: held) -> on A', email: `${A}:\n${H074} ships on 3 December.\nPlease find below the dates for ${B}:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W14 "PO No. B:" -> on A', email: `${A}:\n${H074} ships on 3 December.\nPO No. ${B}:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W15 "For B, the dates are below." then "110: 9 December." -> on A', email: `${A}:\n${H074} ships on 3 December.\nFor ${B}, the dates are below.\n${H110}: 9 December.\n${H437}: 10 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110}: 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W16 en-dash bullets "– B:" after an A header -> on A', email: `${A}:\n– ${H074} ships on 3 December\n– ${B}:\n– ${H110} ships on 9 December`, on: A, lines: [L('L2', '2026-12-09', `– ${H110} ships on 9 December`)], bad: [['L2', '2026-12-09']] },
  { id: 'W17 zh "1、B：" numbered after "A：" -> on A', email: `${A}：\n${H074} 12月3日发货。\n2、${B}：\n${H110} 12月9日发货。`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
  { id: 'W18 "[B]" bracket sub-header -> on A', email: `${A}:\n${H074} ships on 3 December.\n[${B}]\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W19 "Re: B" sub-header -> on A', email: `${A}:\n${H074} ships on 3 December.\nRe: ${B}\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W20 "All lines" after "Regarding B, …:" -> on A L1..L3', email: `${A}:\n${H074} ships on 3 December.\nRegarding ${B}, please note:\nAll lines ship on 9 December.`, on: A, lines: [L('L2', '2026-12-09', 'All lines ship on 9 December.'), L('L3', '2026-12-09', 'All lines ship on 9 December.')], bad: [['L2', '2026-12-09'], ['L3', '2026-12-09']] },
  // Three orders.
  { id: 'W21 3 orders: "As for C:" after a B header -> on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\nAs for ${C}:\n${H110} ships on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W22 3 orders: zh "另外，C 的交期：" after B -> on B', email: `${A}：${H074} 12月3日发货。\n${B}：${H044} 12月5日发货。\n另外，${C} 的交期：\n${H110} 12月9日发货。`, on: B, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
  // Pre-existing shapes (expected wrong in both versions).
  { id: 'W23 correction "Sorry, that line is for B, not A." -> on A (pre-existing)', email: `${A}: ${H110} ships on 3 December.\nSorry, that line is for ${B}, not ${A}.`, on: A, lines: [L('L2', '2026-12-03', `${A}: ${H110} ships on 3 December.`)], bad: [['L2', '2026-12-03']] },
  { id: 'W24 correction "Correction: the above is for B." -> on A (pre-existing)', email: `${A}: ${H110} ships on 3 December.\nCorrection: the above is for ${B}.`, on: A, lines: [L('L2', '2026-12-03', `${A}: ${H110} ships on 3 December.`)], bad: [['L2', '2026-12-03']] },
  { id: 'W25 buyer chase quoted without markers "Kim wrote:" -> on B (pre-existing)', email: `${A}: ${H074} ships on 3 December.\nSent from my iPhone\n\nKim wrote:\n${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
  { id: 'W26 "Except B: all items ship 9 Dec" -> on B (pre-existing)', email: `${A}: ${H074} ships on 3 December.\nExcept ${B}: all items ship on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `Except ${B}: all items ship on 9 December.`)], bad: [['L2', '2026-12-09']] },
  // Diff mechanics.
  { id: 'W27 dedupe: "PO 14" meant D (Oct 14), A+B in full -> on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\nPO 14 (last month's): ${H110} ships on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `PO 14 (last month's): ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']], supplierOrders: [A, B, C, D] },
  { id: 'W28 dedupe: "order no. 14" meant D, on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\nOrder no. 14: ${H437} ships on 10 December.`, on: B, lines: [L('L3', '2026-12-10', `Order no. 14: ${H437} ships on 10 December.`)], bad: [['L3', '2026-12-10']], supplierOrders: [A, B, C, D] },
  { id: 'W29 HEADER_WORD any word: "Not B: 110 ships 9 Dec (that is A)" -> on B', email: `${A}:\n${H074} ships on 3 December.\nNot ${B}: ${H110} ships on 9 December, this is all for ${A}.`, on: B, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December`)], bad: [['L2', '2026-12-09']] },
  { id: 'W30 range "A to C: ship 9 Dec", B in full elsewhere -> on B', email: `${A} to ${C}: all items ship on 9 December.\n${B}: ${H044} ships on 5 December.`, on: B, lines: [L('L2', '2026-12-09', `${A} to ${C}: all items ship on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W31 two orders on one header line "A / B:" then lines -> on A', email: `${A} / ${B}:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W32 subject "RE: B delivery" then A header -> on A (control)', email: `RE: ${B} delivery\n${A}:\n${H110} ships on 3 December.\n${B}: ${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${B}: ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W33 signature with order number on its own line, after B part -> on B', email: `${B}: ${H044} ships on 5 December.\nRegards,\nLi Na\n${A}\n${H110} ships on 3 December.`, on: B, lines: [L('L2', '2026-12-03', `${H110} ships on 3 December.`)], bad: [['L2', '2026-12-03']] },
  { id: 'W34 "same for B" after A line -> on B quoting A line', email: `${A}: ${H110} ships on 9 December.\nSame for ${B}.`, on: B, lines: [L('L2', '2026-12-09', `${A}: ${H110} ships on 9 December.`)], bad: [] },
  { id: 'W35 "PO-A - ships 4 Dec" dash form, B in dash form -> on A (control)', email: `${A} - ${H110} ships on 4 December\n${B} - ${H110} ships on 9 December`, on: A, lines: [L('L2', '2026-12-09', `${B} - ${H110} ships on 9 December`)], bad: [['L2', '2026-12-09']] },
  { id: 'W36 date in header line "B: 9 December" inside A list -> on A', email: `${A}:\n${H074} ships on 3 December.\n${B}: 9 December for all.\n${H437} ships on 10 December.`, on: A, lines: [L('L3', '2026-12-10', `${H437} ships on 10 December.`)], bad: [] },
  { id: 'W37 "(B)" leading bracket on each B line inside A part -> on A', email: `${A}:\n${H074} ships on 3 December.\n(${B}) ${H110} ships on 9 December.\n(${B}) ${H437} ships on 10 December.`, on: A, lines: [L('L2', '2026-12-09', `(${B}) ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  { id: 'W38 full-width "（B）" zh sub-header -> on A', email: `${A}：\n${H074} 12月3日发货。\n（${B}）\n${H110} 12月9日发货。`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
  { id: 'W39 "回复: B" inside A part then lines -> on A', email: `${A}：\n${H074} 12月3日发货。\n回复: ${B}\n${H110} 12月9日发货。`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
  { id: 'W40 "Ship dates for B:" -> on A', email: `${A}:\n${H074} ships on 3 December.\nShip dates for ${B}:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
]

// R: ordinary, plainly correct replies about several orders. per: order ->
// its correct reading, each [ref, date, quote]. Every date is correct.
const R = [
  { id: 'R01 "For order A:" / "For order B:" with a blank line', email: `Hi Kim,\n\nFor order ${A}:\n${H074} ships on 3 December.\n\nFor order ${B}:\n${H044} ships on 5 December.\n\nBest regards,\nLi Na`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R02 "Regarding A, …" / "Regarding B, …" one sentence each', email: `Dear Kim,\nRegarding ${A}, ${H074} ships on 3 December.\nRegarding ${B}, ${H044} ships on 5 December.\nThanks`, per: { [A]: [['L1', '2026-12-03', `Regarding ${A}, ${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `Regarding ${B}, ${H044} ships on 5 December.`]] } },
  { id: 'R03 "As for A:" / "As for B:"', email: `As for ${A}:\n${H074} ships on 3 December.\n\nAs for ${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R04 "Hi Kim, A: …" greeting on the same line', email: `Hi Kim, ${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R05 zh "关于 A 的交期：" blocks', email: `张经理您好，\n\n关于 ${A} 的交期：\n${H074} 12月3日发货。\n\n关于 ${B} 的交期：\n${H044} 12月5日发货。\n\n李娜`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
  { id: 'R06 zh numbered "1、A：…"', email: `张经理您好：\n1、${A}：${H074} 12月3日发货。\n2、${B}：${H044} 12月5日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
  { id: 'R07 zh "【A】" headers', email: `【${A}】\n${H074} 12月3日发货。\n\n【${B}】\n${H044} 12月5日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
  { id: 'R08 pipe table with leading pipes', email: `Please see the dates below.\n| Order | SKU | Ship date |\n| ${A} | ${H074} | 3 December |\n| ${B} | ${H044} | 5 December |`, per: { [A]: [['L1', '2026-12-03', `| ${A} | ${H074} | 3 December |`]], [B]: [['L1', '2026-12-05', `| ${B} | ${H044} | 5 December |`]] } },
  { id: 'R09 "(1) A: …" bracketed list numbers', email: `(1) ${A}: ${H074} ships on 3 December.\n(2) ${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R10 en-dash bullets "– A: …"', email: `Delivery update:\n– ${A}: ${H074} ships on 3 December\n– ${B}: ${H044} ships on 5 December`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December`]] } },
  { id: 'R11 "Your order A: …"', email: `Your order ${A}: ${H074} ships on 3 December.\nYour order ${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R12 "Order number A:" blocks', email: `Order number ${A}:\n${H074} ships on 3 December.\n\nOrder number ${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R13 "Re: A" sub-headers', email: `Re: ${A}\n${H074} ships on 3 December.\n\nRe: ${B}\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R14 "Update for A:" blocks', email: `Update for ${A}:\n${H074} ships on 3 December.\n\nUpdate for ${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R15 zh "贵司订单 A 的 … 发货。" one line each', email: `贵司订单 ${A} 的 ${H074} 12月3日发货。\n贵司订单 ${B} 的 ${H044} 12月5日发货。`, per: { [A]: [['L1', '2026-12-03', `贵司订单 ${A} 的 ${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `贵司订单 ${B} 的 ${H044} 12月5日发货。`]] } },
  { id: 'R16 A header, then "Also, for B:" (distinct SKUs)', email: `${A}:\n${H074} ships on 3 December.\nAlso, for ${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R17 "PO No. A:" blocks', email: `PO No. ${A}:\n${H074} ships on 3 December.\n\nPO No. ${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R18 "Ship date for A: 3 December" lines', email: `Ship date for ${A}: 3 December (${H074}).\nShip date for ${B}: 5 December (${H044}).`, per: { [A]: [['L1', '2026-12-03', `Ship date for ${A}: 3 December (${H074}).`]], [B]: [['L1', '2026-12-05', `Ship date for ${B}: 5 December (${H044}).`]] } },
  { id: 'R19 3 orders "As for X:" blocks', email: `As for ${A}:\n${H074} ships on 3 December.\n\nAs for ${B}:\n${H044} ships on 5 December.\n\nAs for ${C}:\n${H500} ships on 7 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]], [C]: [['L2', '2026-12-07', `${H500} ships on 7 December.`]] } },
  { id: 'R20 A header, "And B ships as follows:" (distinct SKUs)', email: `${A}:\n${H074} ships on 3 December.\nAnd ${B} ships as follows:\n${H044} on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} on 5 December.`]] } },
  { id: 'R21 shared shortfall sentence, then each order\'s part (flags)', email: `${A} and ${B}: we can only supply 5 of ${H110} on each, the rest is cancelled.\n${A}: 5 of the 10 ${H110} ship on 8 December.\n${B}: 5 of the 10 ${H110} ship on 9 December.`, per: { [A]: [['L2', '2026-12-08', `${A}: 5 of the 10 ${H110} ship on 8 December.`, { quantity: 5 }]], [B]: [['L2', '2026-12-09', `${B}: 5 of the 10 ${H110} ship on 9 December.`, { quantity: 5 }]] }, flags: [{ kind: 'cancellation', quote: `${A} and ${B}: we can only supply 5 of ${H110} on each, the rest is cancelled.` }] },
  // Controls: forms that both versions should open.
  { id: 'R22 control "A:" header blocks', email: `${A}:\n${H074} ships on 3 December.\n\n${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R23 control "Order A: …" inline', email: `Order ${A}: ${H074} ships on 3 December.\nOrder ${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
  { id: 'R24 control zh "订单 A 的交期如下："', email: `订单 ${A} 的交期如下：\n${H074} 12月3日发货。\n\n订单 ${B} 的交期如下：\n${H044} 12月5日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
  { id: 'R25 control "1) A …" list', email: `1) ${A} ships on 3 December (${H074}).\n2) ${B} ships on 5 December (${H044}).`, per: { [A]: [['L1', '2026-12-03', `${A} ships on 3 December (${H074}).`]], [B]: [['L1', '2026-12-05', `${B} ships on 5 December (${H044}).`]] } },
  { id: 'R26 control tab table (cleaned to spaces)', email: `Order\tSKU\tShip date\n${A}\t${H074}\t3 December\n${B}\t${H044}\t5 December`, per: { [A]: [['L1', '2026-12-03', `${A} ${H074} 3 December`]], [B]: [['L1', '2026-12-05', `${B} ${H044} 5 December`]] } },
  // Single-order path (production emailRead = []): one order named, plus an
  // unknown order-like heading (the supplier's own order number).
  { id: 'R27 single: zh "贵司 A 的交期如下：" + "我方订单 4471：已排产。"', email: `李经理您好，\n贵司 ${A} 的交期如下：\n${H074} 12月3日发货。\n${H110} 12月4日发货。\n我方订单 4471：已排产。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`], ['L2', '2026-12-04', `${H110} 12月4日发货。`]] } },
  { id: 'R28 single: "Order #4471 (your A) is confirmed." then dates', email: `Dear Kim,\nOrder #4471 (your ${A}) is confirmed.\n${H074} ships on 3 December.\n${H110} ships on 4 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`], ['L2', '2026-12-04', `${H110} ships on 4 December.`]] } },
  { id: 'R29 single: "Thanks for A." + "Sales order no. 88231: …"', email: `Hi Kim,\nThanks for ${A}.\nSales order no. 88231: ${H074} ships on 3 December, ${H110} on 4 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December`], ['L2', '2026-12-04', `${H110} on 4 December.`]] } },
  { id: 'R30 single: zh "订单号：88231" first line, then "A 的货 …"', email: `订单号：88231\n您好，关于 ${A} 的货：\n${H074} 12月3日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]] } },
]

// As the paste: the supplier's orders (all of A, B, C, or the case's own
// list) are looked up when the email writes a number another way, and passed
// to the check; emailRead is the orders read when two or more are named
// (pasteSeveral), else empty. `empty` runs every email as the one-order
// paste does, emailRead empty.
const supplierOrders = (kase) => kase.supplierOrders || [A, B, C]
function check(kase, on, lines, mode) {
  const text = cleanSupplierReply(kase.email).text
  const orderNumbers = orderNumberVariants(text, on) ? supplierOrders(kase) : []
  const named = orderNumbersNamed(text, on, orderNumbers)
  const emailRead = mode === 'empty' || named.length < 2 ? [] : [on, ...named.filter((number) => number !== on && ORDERS[number])]
  return checkReplyReading({ order: ORDERS[on], text, receivedOn: RECEIVED, reading: { replyKind: 'dates', lines, flags: kase.flags || [], reason: null }, emailRead, orderNumbers })
}
const wrongIn = (result, kase) => result.lines.filter((line) => line.outcome === 'proposed' && (kase.bad || []).some(([ref, date]) => ref === line.ref && date === line.proposedDate)).map((line) => `${line.ref}@${line.proposedDate}`)

// A later sentence that gives earlier lines to another order ("Sorry, that
// line is for B, not A.", "Correction: the above is for B.") is not caught:
// parts only end forward, and nothing hands back what came before. Open,
// for the owner and the coordinator to decide (wrong on 6fa2d753 too).
const OPEN = ['W23', 'W24']
test('second review probes: no date is ever proposed on an order it is not for (38 of 40 emails, both ways of reading)', () => {
  assert.equal(W.length, 40)
  for (const kase of W.filter((one) => !OPEN.includes(one.id.split(' ')[0]))) {
    for (const mode of ['paste', 'empty']) assert.deepEqual(wrongIn(check(kase, kase.on, kase.lines, mode), kase), [], `${kase.id} [${mode}]`)
  }
})
test('second review probes: a correction that hands earlier lines to another order (W23, W24)', { todo: 'open: needs a rule that looks back; see the PR' }, () => {
  for (const kase of W.filter((one) => OPEN.includes(one.id.split(' ')[0]))) {
    for (const mode of ['paste', 'empty']) assert.deepEqual(wrongIn(check(kase, kase.on, kase.lines, mode), kase), [], `${kase.id} [${mode}]`)
  }
})

// Every correct line, read on its own order, both ways: proposed, or held
// for the person; never dropped and never another date. Held: R21's two
// lines, where a shortfall flag stands in a sentence shared by both orders
// and so does not complete either order's part (kept off since d0691a5a).
const HELD = ['R21 A L2', 'R21 B L2']
test(`second review probes: of the 60 correct lines, ${60 - HELD.length} are proposed and ${HELD.length} held, none dropped (both ways of reading)`, () => {
  assert.equal(R.length, 30)
  for (const mode of ['paste', 'empty']) {
    const got = { proposed: [], held: [], other: [] }
    for (const kase of R) {
      for (const [on, rows] of Object.entries(kase.per)) {
        const result = check(kase, on, rows.map(([ref, date, quote, extra]) => L(ref, date, quote, extra)), mode)
        for (const [ref, date] of rows) {
          const row = result.lines.find((line) => line.ref === ref)
          const id = `${kase.id.split(' ')[0]} ${short(on)} ${ref}`
          if (row?.outcome === 'proposed' && row.proposedDate === date) got.proposed.push(id)
          else if (row?.outcome === 'needs_you') got.held.push(id)
          else got.other.push(`${id}: ${row?.outcome}/${row?.issue}@${row?.proposedDate}`)
        }
      }
    }
    assert.deepEqual([got.proposed.length + got.held.length + got.other.length, got.held, got.other], [60, HELD, []], mode)
  }
})

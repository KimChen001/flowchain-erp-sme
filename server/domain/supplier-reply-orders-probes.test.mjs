// The first #449 review's probes of de3e6fe0 (64 emails about several orders, from
// emailParts through checkReplyReading with hand-made readings; written by
// an independent review, 11/22) and its known-number duplicate check, kept
// as tests. No model.
//   W  a date that must never be proposed on the order checked
//   R  a correct reply: its date is proposed or goes to the person, never dropped
//   X  how parts behave around a passing mention
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReplyReading } from './supplier-reply-reading.mjs'
import { emailParts, orderNumbersNamed } from './supplier-reply-orders.mjs'

const A = 'PO-202611-0021'
const B = 'PO-202611-0014'
const C = 'PO-202611-0030'
const RECEIVED = '2026-11-18'
const item = (ref, sku, remaining = 10) => ({ ref, purchaseOrderLineId: `${ref}-${sku}`, sku, supplierSku: null, itemName: `Item ${sku.slice(-3)}`, remaining, unit: 'pcs', promisedDate: '2026-11-25' })
const ORDERS = {
  [A]: { number: A, supplierName: 'Household 2', status: 'issued', lines: [item('L1', 'HOUSEHOLD_2_074'), item('L2', 'HOUSEHOLD_2_110'), item('L3', 'HOUSEHOLD_2_437')] },
  [B]: { number: B, supplierName: 'Household 2', status: 'issued', lines: [item('L1', 'HOUSEHOLD_2_044'), item('L2', 'HOUSEHOLD_2_110'), item('L3', 'HOUSEHOLD_2_437')] },
  [C]: { number: C, supplierName: 'Household 2', status: 'issued', lines: [item('L1', 'HOUSEHOLD_2_110'), item('L2', 'HOUSEHOLD_2_500')] },
}
const L = (line, date, quote, extra = {}) => ({ line, date, quote, dateKind: 'stated', ...extra })
const H110 = 'HOUSEHOLD_2_110'
const H437 = 'HOUSEHOLD_2_437'
const H074 = 'HOUSEHOLD_2_074'
const H044 = 'HOUSEHOLD_2_044'
const zh12 = `HOUSEHOLD_2_110 和 HOUSEHOLD_2_437 会跟 ${B} 的货一起在12月8日发出。`
const case12 = `张经理您好，\n\n${A} 的交期更新如下：\nHOUSEHOLD_2_074 后天发货。\nHOUSEHOLD_2_239 12月3日发货。\n${zh12}\n\n有问题随时联系。\n李娜`

// Each case: id, email, on (order checked), lines (the reading), flags, read
// (emailRead, [A, B] when not given), bad [[ref, date]] never to be proposed
// on `on`, good [[ref, date]] a correct reading proposes.
const cases = [
  // ---------------- W: wrong proposals created or still allowed ----------------
  { id: 'W01 case 12 as written, on B (full sentence quote)', email: case12, on: B, lines: [L('L2', '2026-12-08', zh12), L('L3', '2026-12-08', zh12)], bad: [['L2', '2026-12-08'], ['L3', '2026-12-08']] },
  { id: 'W02 case 12 as written, on A (passing quote)', email: case12, on: A, lines: [L('L2', '2026-12-08', zh12), L('L3', '2026-12-08', zh12)], bad: [] },
  { id: 'W03 case 12, emailRead empty, on B', email: case12, on: B, read: [], lines: [L('L2', '2026-12-08', zh12)], bad: [['L2', '2026-12-08']] },
  { id: 'W04 case 12, partial quote "在12月8日发出" on B', email: case12, on: B, lines: [L('L2', '2026-12-08', '在12月8日发出')], bad: [['L2', '2026-12-08']] },
  { id: 'W05 case 12, partial quote "会跟 B 的货一起在12月8日发出" on B', email: case12, on: B, lines: [L('L3', '2026-12-08', `会跟 ${B} 的货一起在12月8日发出`)], bad: [['L3', '2026-12-08']] },
  { id: 'W06 two passing sentences in a row, 2nd on B (en)', email: `${A}:\n${H074} ships on 3 December.\n${H110} goes with the ${B} goods on 8 December.\n${H437} goes with the ${B} goods on 10 December.\n\nThanks`, on: B, lines: [L('L3', '2026-12-10', `${H437} goes with the ${B} goods on 10 December.`)], bad: [['L3', '2026-12-10']] },
  { id: 'W07 two passing sentences in a row, 2nd on B (zh)', email: `${A} 的交期更新如下：\n${H074} 12月3日发货。\n${H110} 会跟 ${B} 的货一起在12月8日发出。\n${H437} 也会跟 ${B} 的货一起在12月10日发出。`, on: B, lines: [L('L3', '2026-12-10', `${H437} 也会跟 ${B} 的货一起在12月10日发出。`)], bad: [['L3', '2026-12-10']] },
  { id: 'W08 two passing sentences in a row, 1st on B (control)', email: `${A}:\n${H074} ships on 3 December.\n${H110} goes with the ${B} goods on 8 December.\n${H437} goes with the ${B} goods on 10 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} goes with the ${B} goods on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W09 passing sentence after a blank line inside A\'s list (zh)', email: `${A} 的交期更新如下：\n${H074} 12月3日发货。\n\n${zh12}`, on: B, lines: [L('L2', '2026-12-08', zh12)], bad: [['L2', '2026-12-08']] },
  { id: 'W10 "跟 B 的货一起，…" leads with 1 word, on B', email: `${A}：\n${H074} 12月3日发货。\n跟 ${B} 的货一起，${H110} 和 ${H437} 12月8日发出。`, on: B, lines: [L('L2', '2026-12-08', `跟 ${B} 的货一起，${H110} 和 ${H437} 12月8日发出。`)], bad: [['L2', '2026-12-08']] },
  { id: 'W11 "With the B goods, …" leads with 2 words, on B', email: `${A}:\n${H074} ships on 3 December.\nWith the ${B} goods, ${H110} and ${H437} ship on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `With the ${B} goods, ${H110} and ${H437} ship on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W12 "Same as B." switches current to B; next A line on B', email: `${A}:\n${H074} ships on 3 December. Same as ${B}.\n${H110} ships on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} ships on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W13 "一起发 B。" zh 1-word lead then next A line, on B', email: `${A}：\n${H074} 12月3日发货，一起发。\n参照 ${B}。\n${H110} 12月8日发货。`, on: B, lines: [L('L2', '2026-12-08', `${H110} 12月8日发货。`)], bad: [['L2', '2026-12-08']] },
  { id: 'W14 B in brackets in A part, on B', email: `${A}:\n${H110} and ${H437} (also on ${B}) ship on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} and ${H437} (also on ${B}) ship on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W15 B after a colon in A part, on B', email: `${A}:\n${H110} (see also: ${B}) ships on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} (see also: ${B}) ships on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W16 quoted earlier mail after A part, no blank (stale current), on B', email: `${A}: ${H074} ships on 3 December.\nBest regards\nLi Na\n> On 15 Nov you wrote: what about ${B}, ${H110} by 1 December?`, on: B, lines: [L('L2', '2026-12-01', `> On 15 Nov you wrote: what about ${B}, ${H110} by 1 December?`)], bad: [['L2', '2026-12-01']] },
  { id: 'W17 quoted earlier mail after a blank line, on B', email: `${A}: ${H074} ships on 3 December.\n\nOn 15 Nov you wrote: what about ${B}, ${H110} by 1 December?`, on: B, lines: [L('L2', '2026-12-01', `On 15 Nov you wrote: what about ${B}, ${H110} by 1 December?`)], bad: [['L2', '2026-12-01']] },
  { id: 'W18 subject line names B, A part follows, on B', email: `Subject: ${B} delivery\n${A}:\n${H110} ships on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} ships on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W19 three orders: C passing inside A part, on C', email: `${A}:\n${H110} goes with the ${C} goods on 8 December.\n${B}: ${H044} ships on 5 December.`, on: C, read: [A, B, C], lines: [L('L1', '2026-12-08', `${H110} goes with the ${C} goods on 8 December.`)], bad: [['L1', '2026-12-08']] },
  { id: 'W20 three orders: C passing inside A part, on B', email: `${A}:\n${H110} goes with the ${C} goods on 8 December.\n${B}: ${H044} ships on 5 December.`, on: B, read: [A, B, C], lines: [L('L2', '2026-12-08', `${H110} goes with the ${C} goods on 8 December.`), L('L1', '2026-12-05', `${B}: ${H044} ships on 5 December.`)], bad: [['L2', '2026-12-08']], good: [['L1', '2026-12-05']] },
  { id: 'W21 three orders: passing to B then a C-leading line, on C', email: `${A}:\n${H110} goes with the ${B} goods on 8 December.\n${C}: ${H110} ships on 9 December.`, on: C, read: [A, B, C], lines: [L('L1', '2026-12-09', `${C}: ${H110} ships on 9 December.`)], bad: [['L1', '2026-12-08']], good: [['L1', '2026-12-09']] },
  { id: 'W22 three orders: passing to B, then a C-passing line, on C', email: `${A}:\n${H110} goes with the ${B} goods on 8 December.\n${H437} goes with what we owe on ${C} on 9 December.`, on: C, read: [A, B, C], lines: [L('L1', '2026-12-09', `${H437} goes with what we owe on ${C} on 9 December.`)], bad: [['L1', '2026-12-09']] },
  { id: 'W23 variant A header "订单 0021：", emailRead empty, on B', email: `订单 0021：\n${H074} 12月3日发货。\n${zh12}`, on: B, read: [], lines: [L('L2', '2026-12-08', zh12)], bad: [['L2', '2026-12-08']] },
  { id: 'W24 variant A header "订单 0021：", emailRead filled, on B', email: `订单 0021：\n${H074} 12月3日发货。\n${zh12}`, on: B, lines: [L('L2', '2026-12-08', zh12)], bad: [['L2', '2026-12-08']] },
  { id: 'W25 variant B in passing "PO 14", emailRead filled, on B', email: `${A}:\n${H110} goes with the PO 14 goods on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} goes with the PO 14 goods on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W26 quote spans A line + passing sentence, on A L2', email: `${A}:\n${H074} ships on 3 December.\n${H110} goes with the ${B} goods on 8 December.`, on: A, lines: [L('L2', '2026-12-08', `3 December.\n${H110} goes with the ${B} goods on 8 December.`)], bad: [] },
  { id: 'W27 quote spans passing sentence + next B-leading line, on B L2', email: `${A}:\n${H110} goes with the ${B} goods on 8 December.\n${B}: ${H044} ships on 5 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} goes with the ${B} goods on 8 December.\n${B}: ${H044}`)], bad: [['L2', '2026-12-08']] },
  { id: 'W28 FLAG LEAK: B cancellation in passing makes A partial line proposed', email: `${A}:\n${H110}: 5 of the 10 ship on 8 December.\n${H110} on ${B}: we can only supply 5, the rest is cancelled.`, on: A, lines: [L('L2', '2026-12-08', `${H110}: 5 of the 10 ship on 8 December.`, { quantity: 5 })], flags: [{ kind: 'cancellation', quote: `${H110} on ${B}: we can only supply 5, the rest is cancelled.` }], bad: [['L2', '2026-12-08']] },
  { id: 'W29 FLAG LEAK zh: B 取消 in passing, A partial line', email: `${A}：\n${H110} 先发5个，12月8日发货。\n${H110} 在 ${B} 上只能供5个，其余取消。`, on: A, lines: [L('L2', '2026-12-08', `${H110} 先发5个，12月8日发货。`, { quantity: 5 })], flags: [{ kind: 'quantity_change', quote: `${H110} 在 ${B} 上只能供5个，其余取消。` }], bad: [['L2', '2026-12-08']] },
  { id: 'W30 header on same line, passing at end (en), on B', email: `Order ${A}: ${H074} ships on 3 December. ${H110} and ${H437} go on 8 December with what we owe on ${B}.`, on: B, lines: [L('L2', '2026-12-08', `${H110} and ${H437} go on 8 December with what we owe on ${B}.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W31 passing mention, A list after "Hi Daniel," greeting header', email: `Hi Daniel, ${A} update:\n${H110} ships with the ${B} goods on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} ships with the ${B} goods on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W32 A header 3 words before number (not leading), passing B', email: `Update on order ${A}:\n${H110} ships with the ${B} goods on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} ships with the ${B} goods on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'W33 "re B" footer then A-less line, on B', email: `${A}: ${H074} ships on 3 December.\nre ${B}\n${H110} ships on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} ships on 8 December.`)], bad: [['L2', '2026-12-08']] },

  { id: 'W34 FLAG LEAK, A has one open line: "The rest of B will not be supplied" in passing', order: { ...ORDERS[A], lines: [item('L1', 'HOUSEHOLD_2_074'), item('L2', 'HOUSEHOLD_2_110', 0), item('L3', 'HOUSEHOLD_2_437', 0)] }, email: `${A}:
5 of the 10 ship on 8 December.
The rest of ${B} will not be supplied.`, on: A, lines: [L('L1', '2026-12-08', '5 of the 10 ship on 8 December.', { quantity: 5 })], flags: [{ kind: 'quantity_change', quote: `The rest of ${B} will not be supplied.` }], bad: [['L1', '2026-12-08']] },
  { id: 'W35 DUP KNOWN: B written "订单号 0014", on B, A date quoted (shared item)', email: `${A}：
${H110} 12月3日发货。

订单号 0014：
${H110} 12月8日发货。`, on: B, lines: [L('L2', '2026-12-03', `${H110} 12月3日发货。`)], bad: [['L2', '2026-12-03']] },
  { id: 'W36 DUP KNOWN control: same email on A, B date quoted', email: `${A}：
${H110} 12月3日发货。

订单号 0014：
${H110} 12月8日发货。`, on: A, lines: [L('L2', '2026-12-08', `${H110} 12月8日发货。`)], bad: [['L2', '2026-12-08']] },
  { id: 'W37 DUP KNOWN en: B written "PO-202611-14", on B, A date quoted', email: `${A}: ${H110} ships on 3 December.
PO-202611-14: ${H110} ships on 8 December.`, on: B, lines: [L('L2', '2026-12-03', `${A}: ${H110} ships on 3 December.`)], bad: [['L2', '2026-12-03']] },

  // ---------------- R: correct replies that 6fa2d753 got right ----------------
  { id: 'R01 "A: ships 4 Dec. (Same as B last week.)" on A', email: `${A}: ${H074} ships on 4 December. (Same as ${B} last week.)`, on: A, lines: [L('L1', '2026-12-04', `${A}: ${H074} ships on 4 December.`)], good: [['L1', '2026-12-04']] },
  { id: 'R02 "B: …9 Dec.\\nThanks, Pat (re A)" on B', email: `${B}: ${H044} ships on 9 December.\nThanks, Pat (re ${A})`, on: B, lines: [L('L1', '2026-12-09', `${B}: ${H044} ships on 9 December.`)], good: [['L1', '2026-12-09']] },
  { id: 'R03 "Your other order …, B, follows on 9 Dec" (no blank) on B', email: `${A}: ${H074} ships on 4 December.\nYour other order for the same items, ${B}, follows on 9 December.\nRegards`, on: B, lines: [L('L2', '2026-12-09', `Your other order for the same items, ${B}, follows on 9 December.`)], good: [['L2', '2026-12-09']] },
  { id: 'R04 same with a blank line, on B', email: `${A}: ${H074} ships on 4 December.\n\nYour other order for the same items, ${B}, follows on 9 December.\nRegards`, on: B, lines: [L('L2', '2026-12-09', `Your other order for the same items, ${B}, follows on 9 December.`)], good: [['L2', '2026-12-09']] },
  { id: 'R05 "As for your order B, it ships 9 Dec" on B', email: `${A}: ${H074} ships on 4 December.\nAs for your order ${B}, ${H044} ships on 9 December.`, on: B, lines: [L('L1', '2026-12-09', `As for your order ${B}, ${H044} ships on 9 December.`)], good: [['L1', '2026-12-09']] },
  { id: 'R06 "The HOUSEHOLD_2_044 on B ships 5 Dec" (B-only item) on B', email: `${A}: ${H074} ships on 3 December.\nThe ${H044} on ${B} ships on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `The ${H044} on ${B} ships on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'R07 "Meanwhile on order B, …" on B', email: `${A}: ${H074} ships on 3 December. Meanwhile on order ${B}, ${H044} ships on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `Meanwhile on order ${B}, ${H044} ships on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'R08 "By the way, B ships on 5 Dec" on B', email: `${A}: ${H074} ships on 3 December.\nBy the way, ${B} ships on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `By the way, ${B} ships on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'R09 zh "HOUSEHOLD_2_044（B）12月5日发货" on B', email: `${A}：${H074} 12月3日发货。\n${H044}（${B}）12月5日发货。`, on: B, lines: [L('L1', '2026-12-05', `${H044}（${B}）12月5日发货。`)], good: [['L1', '2026-12-05']] },
  { id: 'R10 "order no. 14" variant in passing, on B', email: `${A}: ${H074} ships on 3 December.\nThe hinges for order no. 14 ship on 5 December.`, on: B, lines: [L('L1', '2026-12-05', 'The hinges for order no. 14 ship on 5 December.')], good: [['L1', '2026-12-05']] },
  { id: 'R11 own number leads on header line: "A: x. B: y." on B', email: `${A}: ${H074} ships on 3 December. ${B}: ${H044} ships on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `${B}: ${H044} ships on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'R12 "And for B, …" (2 words) on B', email: `${A}: ${H074} ships on 3 December. And for ${B}, ${H044} ships on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `And for ${B}, ${H044} ships on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'R13 "re B" footer after A part, A date on A', email: `${A}: ${H074} ships on 3 December.\nre ${B}`, on: A, lines: [L('L1', '2026-12-03', `${A}: ${H074} ships on 3 December.`)], good: [['L1', '2026-12-03']] },
  { id: 'R14 signature "Li Na | Sales | ref A" after B part, on B', email: `${B}: ${H044} ships on 5 December.\nLi Na | Sales | ref ${A}`, on: B, lines: [L('L1', '2026-12-05', `${B}: ${H044} ships on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'R15 zh "另外 B 的 044 12月5日发货" (1-word lead) on B', email: `${A}：${H074} 12月3日发货。另外 ${B} 的 ${H044} 12月5日发货。`, on: B, lines: [L('L1', '2026-12-05', `另外 ${B} 的 ${H044} 12月5日发货。`)], good: [['L1', '2026-12-05']] },
  { id: 'R16 zh "还有，HOUSEHOLD_2_044 属于 B，12月5日发" on B', email: `${A}：${H074} 12月3日发货。\n还有，${H044} 属于 ${B}，12月5日发。`, on: B, lines: [L('L1', '2026-12-05', `还有，${H044} 属于 ${B}，12月5日发。`)], good: [['L1', '2026-12-05']] },
  { id: 'R17 "We also ship B on 5 Dec." on B', email: `${A}: ${H074} ships on 3 December.\nWe also ship ${B} on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `We also ship ${B} on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'R18 A part with a passing mention; A own line still proposed', email: `${A}:\n${H074} ships on 3 December.\n${H110} goes with the ${B} goods on 8 December.`, on: A, lines: [L('L1', '2026-12-03', `${H074} ships on 3 December.`)], good: [['L1', '2026-12-03']] },
  { id: 'R19 A line after a passing mention (current reset), on A', email: `${A}:\n${H110} goes with the ${B} goods on 8 December.\n${H074} ships on 3 December.`, on: A, lines: [L('L1', '2026-12-03', `${H074} ships on 3 December.`)], good: [['L1', '2026-12-03']] },
  { id: 'R20 B paragraph then "Thanks, Pat (re A)" then dates of B, on B', email: `${B}: brackets update.\n${H044} ships on 9 December.\nThanks, Pat (re ${A})`, on: B, lines: [L('L1', '2026-12-09', `${H044} ships on 9 December.`)], good: [['L1', '2026-12-09']] },
  { id: 'R21 "Note: B ships on 5 Dec." after A, on B', email: `${A}: ${H074} ships on 3 December.\nNote: ${B} ships on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `Note: ${B} ships on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'R22 "Please ship B by…": supplier says "Order B will be shipped 5 Dec" (3 words? no) on B', email: `${A}: ${H074} ships on 3 December.\nYour purchase order ${B} will be shipped on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `Your purchase order ${B} will be shipped on 5 December.`)], good: [['L1', '2026-12-05']] },

  // ---------------- X: diff mechanics ----------------
  { id: 'X01 header-only A then blank, passing B, on B', email: `${A}:\n\n${H110} ships with the ${B} goods on 8 December.`, on: B, lines: [L('L2', '2026-12-08', `${H110} ships with the ${B} goods on 8 December.`)], bad: [['L2', '2026-12-08']] },
  { id: 'X02 A mentioned in passing in its own part (same order), on A', email: `${A}:\n${H074} ships on 3 December, as agreed for ${A}.\n${H110} ships on 8 December.\n${B}: ${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-12-08', `${H110} ships on 8 December.`)], good: [['L2', '2026-12-08']] },
  { id: 'X03 sort with numbers in reverse order (A=0021 > B=0014): runs', email: case12, on: A, lines: [], bad: [] },
  { id: 'X04 passing sentence then a B-leading line merges? on B L1', email: `${A}:\n${H110} goes with the ${B} goods on 8 December.\n${B}: ${H044} ships on 5 December.`, on: B, lines: [L('L1', '2026-12-05', `${B}: ${H044} ships on 5 December.`)], good: [['L1', '2026-12-05']] },
  { id: 'X05 same as W06 but reading on A (2nd passing line)', email: `${A}:\n${H074} ships on 3 December.\n${H110} goes with the ${B} goods on 8 December.\n${H437} goes with the ${B} goods on 10 December.`, on: A, lines: [L('L3', '2026-12-10', `${H437} goes with the ${B} goods on 10 December.`)], bad: [] },
]

const check = (kase) => checkReplyReading({ order: kase.order || ORDERS[kase.on], text: kase.email, receivedOn: RECEIVED, reading: { replyKind: 'dates', lines: kase.lines, flags: kase.flags || [], reason: null }, emailRead: kase.read ?? [A, B] })

test('review probes: no date is ever proposed on an order it is not for (64 emails)', () => {
  assert.equal(cases.length, 64)
  for (const kase of cases) {
    const wrong = check(kase).lines.filter((line) => line.outcome === 'proposed' && (kase.bad || []).some(([ref, date]) => ref === line.ref && date === line.proposedDate))
    assert.deepEqual(wrong.map((line) => `${line.ref}@${line.proposedDate}`), [], kase.id)
  }
})

// What a correct date comes out as. Held for the person is the accepted cost
// of the safer parts (coordinator, 11/22): R03–R10, R16, R17, R22 name B in
// passing, inside A's part or outside any part; R19 and X02 come after a
// passing mention, which ends the part (held on 6fa2d753 too). Dropped would
// lose the date, and never happens.
const HELD = ['R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R16', 'R17', 'R19', 'R22', 'X02']
test(`review probes: every correct date is proposed or held for the person, never dropped (${HELD.filter((id) => id.startsWith('R')).length} of 22 correct replies held)`, () => {
  for (const kase of cases.filter((one) => one.good)) {
    const lines = check(kase).lines
    for (const [ref, date] of kase.good) {
      const row = lines.find((line) => line.ref === ref)
      const id = kase.id.split(' ')[0]
      const want = HELD.includes(id) ? ['needs_you', 'no_order_part', null] : ['proposed', null, date]
      assert.deepEqual([row?.outcome, row?.issue ?? null, row?.proposedDate ?? null], want, kase.id)
    }
  }
  assert.equal(cases.filter((one) => /^R\d/.test(one.id)).length, 22)
})

test('the order read on, also in the known list, is matched once: its number written another way still resolves (review dup-known, W25, W35, W37)', () => {
  const email = `${A}:\nHOUSEHOLD_2_110 goes with the PO 14 goods on 8 December.`
  for (const [on, known] of [[B, [A, B]], [B, [A]], [A, [A, B]], [A, [B]]]) {
    assert.deepEqual(orderNumbersNamed(email, on, known), [A, B], `${on} ${known}`)
    assert.notEqual(emailParts(email, on, known), null, `${on} ${known}`)
  }
})

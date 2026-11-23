// The #449 reviews' probe emails (11/22), kept in one place for the probe
// tests (server/domain/supplier-reply-orders-probes*.test.mjs) and the
// several-order property test (review-probes.test.mjs). Each round is the
// review's own data: W emails hunt a date proposed on the wrong order or
// line (bad), R and S emails are correct replies (per order: [ref, date,
// quote]). No model.

// The first review (de3e6fe0): 64 emails.
export const ROUND_1 = (() => {
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
  return { A, B, C, H044, H074, H110, H437, L, ORDERS, RECEIVED, case12, cases, item, zh12 }
})()

// The second review (d0691a5a): 40 W and 30 R emails.
export const ROUND_2 = (() => {
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
  return { A, B, C, D, H044, H074, H110, H437, H500, L, ORDERS, R, RECEIVED, W, item, short, supplierOrders }
})()

// The third review (9d34af4d): 60 W, 32 R and 10 S emails.
export const ROUND_3 = (() => {
  const A = 'PO-202611-0021'
  const B = 'PO-202611-0014'
  const C = 'PO-202611-0030'
  const D = 'PO-202610-0014' // last month's 14: near-duplicate of B
  const E = 'PO-202611-0010'
  const F = 'PO-202611-0003'
  const RECEIVED = '2026-11-18'
  const item = (ref, sku, remaining = 10) => ({ ref, purchaseOrderLineId: `${ref}-${sku}`, sku, supplierSku: null, itemName: `Item ${sku.slice(-3)}`, remaining, unit: 'pcs', promisedDate: '2026-11-25' })
  const H074 = 'HOUSEHOLD_2_074'
  const H110 = 'HOUSEHOLD_2_110'
  const H437 = 'HOUSEHOLD_2_437'
  const H044 = 'HOUSEHOLD_2_044'
  const H500 = 'HOUSEHOLD_2_500'
  const ORDERS = {
    [A]: { number: A, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H074), item('L2', H110), item('L3', H437)] },
    [B]: { number: B, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H044), item('L2', H110), item('L3', H437)] },
    [C]: { number: C, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H110), item('L2', H500)] },
    [D]: { number: D, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H110), item('L2', H437)] },
    [E]: { number: E, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H110), item('L2', H437)] },
    [F]: { number: F, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H110), item('L2', H044), item('L3', H437)] },
  }
  // The supplier's orders as the service finds them (findMany by supplier).
  const LIST = [A, B, C, D, 'PO-202610-0007', 'PO-202609-0018']
  const LIST_EF = [A, B, C, D, E, F]
  const STATUS = { [D]: 'received', 'PO-202610-0007': 'received' }
  const short = (n) => ({ [A]: 'A', [B]: 'B', [C]: 'C', [D]: 'D', [E]: 'E', [F]: 'F' }[n] || n)
  const L = (line, date, quote, extra = {}) => ({ line, date, quote, dateKind: 'stated', ...extra })
  const OPEN = ['issued', 'partially_received']


  // ---------------------------------------------------------------------------
  // W: hunt for a date proposed on an order or line it is not for. bad: the
  // [ref, date] pairs that must never be proposed on `on`. pasted: the order
  // the email is pasted on (default A).
  // ---------------------------------------------------------------------------
  const W = [
    // U: the other order's number written in a form tokensIn does not see.
    { id: 'W01 "PO No. 202611-0014:" header inside A part (C also named), on A', email: `Hi Kim,\n${A}:\n${H074} ships on 3 December.\nPO No. 202611-0014:\n${H110} ships on 9 December.\n${C}:\n${H500} ships on 12 December.\nRegards,\nLi Na`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W02 single: A + "PO No. 202611-0014:" block, on A', email: `Hi Kim,\n${A}:\n${H074} ships on 3 December.\nPO No. 202611-0014:\n${H110} ships on 9 December.\n${H437} ships on 10 December.\nRegards,\nLi Na`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`), L('L3', '2026-12-10', `${H437} ships on 10 December.`)], bad: [['L2', '2026-12-09'], ['L3', '2026-12-10']] },
    { id: 'W03 single zh: A + "订单号：202611-0014" block, on A', email: `李经理您好，\n${A}：\n${H074} 12月3日发货。\n订单号：202611-0014\n${H110} 12月9日发货。\n${H437} 12月10日发货。\n谢谢`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`), L('L3', '2026-12-10', `${H437} 12月10日发货。`)], bad: [['L2', '2026-12-09'], ['L3', '2026-12-10']] },
    { id: 'W04 "P.O. 202611-0014 -" header inside A part (C named), on A', email: `${A}:\n${H074} ships on 3 December.\nP.O. 202611-0014 - dates below\n${H110} ships on 9 December.\n\n${C}:\n${H500} ships on 12 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W05 html->text italic "_PO-202611-0014_:" inside A part (C named), on A', email: `${A}:\n${H074} ships on 3 December.\n_${B}_:\n${H110} ships on 9 December.\n\n${C}:\n${H500} ships on 12 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W06 non-breaking hyphens "PO\\u2011202611\\u20110014:" inside A part (C named), on A', email: `${A}:\n${H074} ships on 3 December.\nPO‑202611‑0014:\n${H110} ships on 9 December.\n\n${C}:\n${H500} ships on 12 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W07 single: A + "PO\\u2010202611\\u20100014" (U+2010) block, on A', email: `${A}:\n${H074} ships on 3 December.\nPO‐202611‐0014:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W08 single: A + "Order No. 202611-0014:" block, on A', email: `Dear Kim,\nOrder No. ${A}:\n${H074} ships on 3 December.\nOrder No. 202611-0014:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    // S: openers that point away from the order ("same as", "except", "unlike").
    { id: 'W09 "Same as B, except 110 ships 9 Dec." inside A part; B own part says 4 Dec; on B', email: `${A}:\n${H074} ships on 3 December.\nSame as ${B}, except ${H110} ships on 9 December.\n\n${B}:\n${H044} ships on 5 December.\n${H110} ships on 4 December.`, on: B, lines: [L('L2', '2026-12-09', `Same as ${B}, except ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W10 zh "同 B，但 110 改为12月9日发货。" inside A part; on B', email: `${A}：\n${H074} 12月3日发货。\n同 ${B}，但 ${H110} 改为12月9日发货。\n\n${B}：\n${H044} 12月5日发货。\n${H110} 12月4日发货。`, on: B, lines: [L('L2', '2026-12-09', `同 ${B}，但 ${H110} 改为12月9日发货。`)], bad: [['L2', '2026-12-09']] },
    { id: 'W11 zh "参照 B，110 改为12月9日。" inside A part; on B', email: `${A}：\n${H074} 12月3日发货。\n参照 ${B}，${H110} 改为12月9日。\n\n${B}：\n${H044} 12月5日发货。\n${H110} 12月4日发货。`, on: B, lines: [L('L2', '2026-12-09', `参照 ${B}，${H110} 改为12月9日。`)], bad: [['L2', '2026-12-09']] },
    { id: 'W12 "Everything except B: 110 ships 9 Dec." on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December, ${H110} on 4 December.\nEverything except ${B}: ${H110} ships on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `Everything except ${B}: ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W13 "All orders except B: 110 ships 9 Dec." (3 words + colon) on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December, ${H110} on 4 December.\nAll orders except ${B}: ${H110} ships on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `All orders except ${B}: ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W14 "Excl. B: 110 ships 9 Dec." (abbreviation splits) on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December, ${H110} on 4 December.\nAll other items, excl. ${B}: ${H110} ships on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W15 "Unlike B, 110 ships 9 Dec." inside A part; on B', email: `${A}:\n${H074} ships on 3 December.\nUnlike ${B}, ${H110} ships on 9 December.\n\n${B}:\n${H044} ships on 5 December.\n${H110} ships on 4 December.`, on: B, lines: [L('L2', '2026-12-09', `Unlike ${B}, ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W16 "Similar to B, but 110 ships 9 Dec." inside A part; on B', email: `${A}:\n${H074} ships on 3 December.\nSimilar to ${B}, but ${H110} ships on 9 December.\n\n${B}:\n${H044} ships on 5 December.\n${H110} ships on 4 December.`, on: B, lines: [L('L2', '2026-12-09', `Similar to ${B}, but ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    // V: words read as an order number of the supplier's (E = order 10, F = order 3).
    { id: 'W17 zh "订单10天内全部发出：" in B part -> order E (0010); on E', email: `${A}：${H074} 12月3日发货。\n${B}：\n订单10天内全部发出：\n${H110} 12月9日发货。\n${H437} 12月10日发货。`, pasted: B, on: E, supplierOrders: LIST_EF, lines: [L('L1', '2026-12-09', `${H110} 12月9日发货。`), L('L2', '2026-12-10', `${H437} 12月10日发货。`)], bad: [['L1', '2026-12-09'], ['L2', '2026-12-10']] },
    { id: 'W18 SAP item numbers "Item 00010 …" in B part -> order E; on E', email: `Order acknowledgement ${B}\nItem 00010 ${H110} qty 10 ship date 9 December\nItem 00020 ${H437} qty 10 ship date 10 December`, pasted: B, on: E, supplierOrders: LIST_EF, lines: [L('L1', '2026-12-09', `Item 00010 ${H110} qty 10 ship date 9 December`)], bad: [['L1', '2026-12-09']] },
    { id: 'W19 zh "订单3个品项都在12月9日发货。" in B part -> order F (0003); on F', email: `${A}：${H074} 12月3日发货。\n${B}：\n订单3个品项都在12月9日发货。`, pasted: A, on: F, supplierOrders: LIST_EF, lines: [L('L1', '2026-12-09', '订单3个品项都在12月9日发货。'), L('L2', '2026-12-09', '订单3个品项都在12月9日发货。'), L('L3', '2026-12-09', '订单3个品项都在12月9日发货。')], bad: [['L1', '2026-12-09'], ['L2', '2026-12-09'], ['L3', '2026-12-09']] },
    { id: 'W20 single zh: "B：订单7天内发货。" style with order 7 open -> wrong order', email: `${B}：\n订单7天内发货，具体如下：\n${H110} 12月9日发货。`, pasted: B, on: 'PO-202611-0007', supplierOrders: [...LIST, 'PO-202611-0007'], lines: [L('L1', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L1', '2026-12-09']] },
    // P: the other order pointed to by place, in words BY_PLACE does not list.
    { id: 'W21 zh "另外那张单：" inside A part; on A', email: `${A} 和 ${B} 的交期如下：\n${A}：\n${H074} 12月3日发货。\n另外那张单：\n${H110} 12月9日发货。`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
    { id: 'W22 "2nd order:" inside A part; on A', email: `Dates for ${A} and ${B} below.\n${A}:\n${H074} ships on 3 December.\n2nd order:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W23 "The remaining orders ship on 9 December." inside A part; on A L3', email: `${A}:\n${H074} ships on 3 December, ${H110} on 4 December.\nThe remaining orders ship on 9 December.\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L3', '2026-12-09', 'The remaining orders ship on 9 December.')], bad: [['L3', '2026-12-09']] },
    { id: 'W24 zh "其余订单12月9日发货。" inside A part; on A L3', email: `${A}：\n${H074} 12月3日发货，${H110} 12月4日发货。\n其余订单12月9日发货。\n\n${B}：\n${H044} 12月5日发货。`, on: A, lines: [L('L3', '2026-12-09', '其余订单12月9日发货。')], bad: [['L3', '2026-12-09']] },
    { id: 'W25 zh "另一张：" (no 单) inside A part; on A', email: `${A} 和 ${B} 交期：\n${A}：${H074} 12月3日发货。\n另一张：${H110} 12月9日发货。`, on: A, lines: [L('L2', '2026-12-09', `另一张：${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
    // Q: our quoted chase not cut and not opened by "wrote:".
    { id: 'W26 Gmail text of an Outlook header "*From:* / *Sent:*" then our chase; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\n*From:* Kim Chen <kim@flowchain.example>\n*Sent:* Tuesday, November 17, 2026 10:00 AM\n*To:* Li Na\n*Subject:* ${B} / ${A} delivery\n\nHi Li Na,\n${B}: please confirm ${H110} for 1 December.\nThanks, Kim`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    { id: 'W27 Traditional-Chinese Outlook "寄件者: / 寄件日期:" then our chase; on B', email: `${A}：${H074} 12月3日发货。\n${B}：${H044} 12月5日发货。\n\n寄件者: Kim Chen\n寄件日期: 2026年11月17日 上午 10:00\n收件者: 李娜\n主旨: ${B} 交期\n\n${B}：请确认 ${H110} 12月1日到货。`, on: B, lines: [L('L2', '2026-12-01', `${B}：请确认 ${H110} 12月1日到货。`)], bad: [['L2', '2026-12-01']] },
    { id: 'W28 flattened quote "Kim Chen wrote: B: please confirm 110 for 1 December."; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\nKim wrote: ${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    { id: 'W29 German Outlook "Von: / Gesendet:" then our chase; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\nVon: Kim Chen\nGesendet: Dienstag, 17. November 2026 10:00\nAn: Li Na\nBetreff: ${B}\n\n${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    { id: 'W30 control: standard Outlook "From: / Sent:" block is cut; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\nFrom: Kim Chen <kim@flowchain.example>\nSent: Tuesday, November 17, 2026 10:00 AM\nTo: Li Na\nSubject: ${B}\n\n${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    // H: html->text artefacts (controls).
    { id: 'W31 "*PO-B*:" bold header inside A part; on A', email: `${A}:\n${H074} ships on 3 December.\n*${B}*:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W32 "PO-B\\u00a0:" and full-width spaces; on A', email: `${A} :\n${H074} ships on 3 December.\n${B}　：\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W33 Outlook bullets "·\\tPO-B:" (tab) inside A part; on A', email: `${A}:\n·\t${H074} ships on 3 December.\n·\t${B}:\n·\t${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `· ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    // G: greeting on the order's line.
    { id: 'W34 "Hi Kim, A: … B: …" on one line; on A quoting B', email: `Hi Kim, ${A}: ${H074} ships on 3 December. ${B}: ${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W35 "Hi Kim, A:" greeting header then B lines after "and for B" w/o colon', email: `Hi Kim, ${A}:\n${H074} ships on 3 December.\nand for ${B} the ${H110} ships on 9 December.\n${H437} ships on 10 December.`, on: A, lines: [L('L3', '2026-12-10', `${H437} ships on 10 December.`)], bad: [['L3', '2026-12-10']] },
    // N: near-duplicate numbers (B = Nov 14, D = Oct 14).
    { id: 'W36 D open, "PO 14" header in A part (B + D both 14); on B', email: `${A}:\n${H074} ships on 3 December.\n${B}:\n${H044} ships on 5 December.\n\nPO 14:\n${H110} ships on 9 December.`, on: B, statusOverride: { [D]: 'issued' }, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W37 D exact "PO-202610-0014:" block then B; on B quoting D line', email: `${D}:\n${H110} ships on 2 December.\n${B}:\n${H044} ships on 5 December.`, on: B, statusOverride: { [D]: 'issued' }, lines: [L('L2', '2026-12-02', `${H110} ships on 2 December.`)], bad: [['L2', '2026-12-02']] },
    { id: 'W38 "PO-202611-14" variant + D, B part; on A quoting B line', email: `${A}: ${H074} ships on 3 December.\nPO-202611-14:\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W39 "订单 0014：" (B and D both seq 14, D open) block; on B', email: `${A}：${H074} 12月3日发货。\n订单 0014：\n${H110} 12月9日发货。`, on: B, statusOverride: { [D]: 'issued' }, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
    // T: two orders on one line / dates first.
    { id: 'W40 "4 Dec – A; 9 Dec – B" one line; on A quoting B half', email: `${H110}: 4 December – ${A}; 9 December – ${B}.`, on: A, lines: [L('L2', '2026-12-09', `9 December – ${B}.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W41 "A / B:" header, blank line, lines; on A', email: `${A} / ${B}:\n\n${H110} ships on 9 December.\n${H437} ships on 10 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [] },
    { id: 'W42 dates-first lines inside A part: "9 Dec: B 110"; on A', email: `${A}:\n3 December: ${H074}\n9 December: ${B} ${H110}\n10 December: ${H437}`, on: A, lines: [L('L3', '2026-12-10', `10 December: ${H437}`)], bad: [['L3', '2026-12-10']] },
    // Sb: subject repeated in the body.
    { id: 'W43 "Subject: RE: B" line opens B; A lines then "These are for A."; on B', email: `Subject: RE: ${B} delivery\nHi Kim, please see the dates below.\n${H110}: 3 December\n${H437}: 4 December\nThese are for ${A}. ${B} follows next week.`, on: B, lines: [L('L2', '2026-12-03', `${H110}: 3 December`)], bad: [['L2', '2026-12-03']] },
    // Sg: signatures / disclaimers.
    { id: 'W44 signature "Ref.: PO-A" then P.S. line for B; on A', email: `${B}:\n${H044} ships on 5 December.\n\nLi Na | Sales\nRef.: ${A}\nP.S. ${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `P.S. ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W45 disclaimer naming A after B part, then B lines; on A', email: `${B}:\n${H044} ships on 5 December.\n${A} confidentiality notice applies.\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    // Q2: shared SKU with split quantities; "both orders".
    { id: 'W46 "110: 15 pcs on 9 Dec (10 for A, 5 for B)"; on B qty', email: `${H110}: 15 pcs ship on 9 December (10 for ${A}, 5 for ${B}).`, on: B, lines: [L('L2', '2026-12-09', `${H110}: 15 pcs ship on 9 December (10 for ${A}, 5 for ${B}).`, { quantity: 15 })], bad: [['L2', '2026-12-09']] },
    { id: 'W47 shared shortfall in A part ("the rest of 110 will not come") makes B partial line proposed?', email: `${A}:\n${H110}: only 5 pcs, the rest will not be supplied.\n${B}:\n5 of the 10 ${H110} ship on 9 December.`, on: B, flags: [{ kind: 'cancellation', quote: `${H110}: only 5 pcs, the rest will not be supplied.` }], lines: [L('L2', '2026-12-09', `5 of the 10 ${H110} ship on 9 December.`, { quantity: 5 })], bad: [['L2', '2026-12-09']] },
    { id: 'W48 relative date in B part "next Friday", on A quoting it', email: `${A}: ${H074} ships on 3 December.\n${B}:\n${H110} ships next Friday.`, on: A, lines: [L('L2', '2026-11-27', `${H110} ships next Friday.`, { dateKind: 'relative' })], bad: [['L2', '2026-11-27']] },
    { id: 'W49 "the second order" sentence then lines; on A', email: `${A}:\n${H074} ships on 3 December.\nAs for the second order:\n${H110} ships on 9 December.\n\n${B} is otherwise unchanged.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W50 zh mixed punctuation "A：074 12月3日，B：110 12月9日。"; on A', email: `${A}：${H074} 12月3日，${B}：${H110} 12月9日。`, on: A, lines: [L('L2', '2026-12-09', `${B}：${H110} 12月9日。`)], bad: [['L2', '2026-12-09']] },
    { id: 'W51 "Besides B, 110 ships 9 Dec" inside A part (meaning: for A); on B', email: `${A}:\n${H074} ships on 3 December.\nBesides ${B}, ${H110} ships on 9 December.\n\n${B}:\n${H110} ships on 4 December.`, on: B, lines: [L('L2', '2026-12-09', `Besides ${B}, ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W52 "Not for B:" variant "Not for B: 110 ships 9 Dec" on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H110} ships on 4 December.\nNot for ${B}: ${H110} ships on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `Not for ${B}: ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W53 "Without B: 110 ships 9 Dec" on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H110} ships on 4 December.\nWithout ${B}: ${H110} ships on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `Without ${B}: ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W54 zh "不同于 B，110 12月9日发货。" inside A part; on B', email: `${A}：\n${H074} 12月3日发货。\n不同于 ${B}，${H110} 12月9日发货。\n\n${B}：\n${H110} 12月4日发货。`, on: B, lines: [L('L2', '2026-12-09', `不同于 ${B}，${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
    { id: 'W55 "Same as B, but 110 ships 9 Dec." inside A part; on B', email: `${A}:\n${H074} ships on 3 December.\nSame as ${B}, but ${H110} ships on 9 December.\n\n${B}:\n${H044} ships on 5 December.\n${H110} ships on 4 December.`, on: B, lines: [L('L2', '2026-12-09', `Same as ${B}, but ${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W56 "Not including B, all 110 ship on 9 December." right after B part; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December, ${H110} on 4 December.\nNot including ${B}, all ${H110} ship on 9 December.`, on: B, lines: [L('L2', '2026-12-09', `Not including ${B}, all ${H110} ship on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W57 single-looking zh pasted on A: "订单3天后发货：" (F open) -> F part; on F', email: `${A}：\n订单3天后发货：\n${H110} 12月4日发货。\n${H437} 12月5日发货。`, pasted: A, on: F, supplierOrders: LIST_EF, lines: [L('L1', '2026-12-04', `${H110} 12月4日发货。`), L('L3', '2026-12-05', `${H437} 12月5日发货。`)], bad: [['L1', '2026-12-04'], ['L3', '2026-12-05']] },
    { id: 'W58 single: A + "PO#: 202611-0014" block, on A', email: `${A}:\n${H074} ships on 3 December.\nPO#: 202611-0014\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W59 single: A + "PO Number: 202611-0014" block, on A', email: `${A}:\n${H074} ships on 3 December.\n\nPO Number: 202611-0014\n${H110} ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
    { id: 'W60 "Purchase Order 202611-0014:" inside A part (C named), on A', email: `Purchase Order ${A}:\n${H074} ships on 3 December.\nPurchase Order 202611-0014:\n${H110} ships on 9 December.\nPurchase Order ${C}:\n${H500} ships on 12 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  ]

  // ---------------------------------------------------------------------------
  // R: ordinary, plainly correct replies. per: order -> its correct reading.
  // ---------------------------------------------------------------------------
  const R = [
    { id: 'R01 "A:" header, blank line, lines (x2)', email: `Hi Kim,\n\n${A}:\n\n${H074} ships on 3 December.\n${H110} ships on 4 December.\n\n${B}:\n\n${H044} ships on 5 December.\n\nBest,\nLi Na`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`], ['L2', '2026-12-04', `${H110} ships on 4 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R02 "A" header without colon, blank line, lines', email: `${A}\n\n${H074} ships on 3 December.\n\n${B}\n\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R03 "【A】" header, blank line, lines', email: `【${A}】\n\n${H074} 12月3日发货。\n\n【${B}】\n\n${H044} 12月5日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
    { id: 'R04 "*A*:" bold header, blank line, lines', email: `*${A}*:\n\n${H074} ships on 3 December.\n\n*${B}*:\n\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R05 "A - 074 ships 3 Dec" one line each', email: `${A} - ${H074} ships on 3 December\n${B} - ${H044} ships on 5 December`, per: { [A]: [['L1', '2026-12-03', `${A} - ${H074} ships on 3 December`]], [B]: [['L1', '2026-12-05', `${B} - ${H044} ships on 5 December`]] } },
    { id: 'R06 "Dear Ms. Kim Chen, A: …" long greeting on the line', email: `Dear Ms. Kim Chen, ${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R07 zh "一、A：" / "二、B："', email: `一、${A}：${H074} 12月3日发货。\n二、${B}：${H044} 12月5日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
    { id: 'R08 zh "（一）A：" / "（二）B："', email: `（一）${A}：\n${H074} 12月3日发货。\n（二）${B}：\n${H044} 12月5日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
    { id: 'R09 "a) A:" / "b) B:"', email: `a) ${A}:\n${H074} ships on 3 December.\nb) ${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R10 circled "① A" / "② B"', email: `① ${A}: ${H074} ships on 3 December.\n② ${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R11 dates first "3 December – A (074)"', email: `Ship dates:\n3 December – ${A} (${H074})\n5 December – ${B} (${H044})`, per: { [A]: [['L1', '2026-12-03', `3 December – ${A} (${H074})`]], [B]: [['L1', '2026-12-05', `5 December – ${B} (${H044})`]] } },
    { id: 'R12 "Regarding your order A:" (3 words + colon)', email: `Regarding your order ${A}:\n${H074} ships on 3 December.\n\nRegarding your order ${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R13 subject repeated in the body, then headers', email: `Subject: Re: ${A} and ${B} delivery\n\nHi Kim,\n${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R14 answer then standard Outlook forwarded block (cut)', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\nFrom: Kim Chen\nSent: Tuesday, November 17, 2026 10:00 AM\nTo: Li Na\nSubject: ${A} / ${B}\nPlease confirm dates.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R15 disclaimer naming both orders after B part', email: `${A}:\n${H074} ships on 3 December.\n\n${B}:\n${H044} ships on 5 December.\n\nLi Na\nThis e-mail about ${A} and ${B} is confidential.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R16 semicolons on one line "A: …; B: …"', email: `${A}: ${H074} on 3 December, ${H110} on 4 December; ${B}: ${H044} on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} on 3 December`], ['L2', '2026-12-04', `${H110} on 4 December`]], [B]: [['L1', '2026-12-05', `${H044} on 5 December.`]] } },
    { id: 'R17 zh mixed "A：074 12月3日、110 12月4日。B：044 12月5日。"', email: `${A}：${H074} 12月3日、${H110} 12月4日。${B}：${H044} 12月5日。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日`], ['L2', '2026-12-04', `${H110} 12月4日`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日`]] } },
    { id: 'R18 three orders, header + blank + lines', email: `${A}:\n\n${H074} ships on 3 December.\n\n${B}:\n\n${H044} ships on 5 December.\n\n${C}:\n\n${H500} ships on 7 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]], [C]: [['L2', '2026-12-07', `${H500} ships on 7 December.`]] } },
    { id: 'R19 variants "PO 202611-0021" / "PO 202611-0014" (D in list)', email: `PO 202611-0021: ${H074} ships on 3 December.\nPO 202611-0014: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R20 shared SKU, each order its own block (110 on both)', email: `${A}:\n${H110} ships on 4 December.\n\n${B}:\n${H110} ships on 9 December.`, per: { [A]: [['L2', '2026-12-04', `${H110} ships on 4 December.`]], [B]: [['L2', '2026-12-09', `${H110} ships on 9 December.`]] } },
    { id: 'R21 "Both orders:" line inside B part (correct for A and B)', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\nBoth orders: ${H437} ships on 10 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`], ['L3', '2026-12-10', `Both orders: ${H437} ships on 10 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`], ['L3', '2026-12-10', `Both orders: ${H437} ships on 10 December.`]] } },
    { id: 'R22 "As with B, 110 ships 9 Dec" inside A part (A date)', email: `${A}:\n${H074} ships on 3 December.\nAs with ${B}, ${H110} ships on 9 December.\n\n${B}:\n${H110} ships on 9 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`], ['L2', '2026-12-09', `As with ${B}, ${H110} ships on 9 December.`]] } },
    { id: 'R23 zh "订单3个品项…" in B part (F exists): B dates', email: `${A}：${H074} 12月3日发货。\n${B}：\n订单3个品项都在12月9日发货。`, supplierOrders: LIST_EF, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-09', '订单3个品项都在12月9日发货。'], ['L2', '2026-12-09', '订单3个品项都在12月9日发货。'], ['L3', '2026-12-09', '订单3个品项都在12月9日发货。']] } },
    { id: 'R24 zh "订单10天内全部发出：" in B part (E exists): B dates', email: `${A}：${H074} 12月3日发货。\n${B}：\n订单10天内全部发出：\n${H110} 12月9日发货。`, supplierOrders: LIST_EF, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L2', '2026-12-09', `${H110} 12月9日发货。`]] } },
    { id: 'R25 "110 for A ships 4 Dec; for B ships 9 Dec" (SKU first)', email: `${H110} for ${A} ships on 4 December; for ${B} it ships on 9 December.`, per: { [A]: [['L2', '2026-12-04', `${H110} for ${A} ships on 4 December;`]], [B]: [['L2', '2026-12-09', `for ${B} it ships on 9 December.`]] } },
    { id: 'R26 "Order 1 (A):" / "Order 2 (B):"', email: `Order 1 (${A}):\n${H074} ships on 3 December.\nOrder 2 (${B}):\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R27 "PS B: …" after A part and signature', email: `${A}: ${H074} ships on 3 December.\nThanks, Li Na\nPS ${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R28 "As I wrote:" in the supplier\'s own text before B dates', email: `${A}: ${H074} ships on 3 December.\nAs I wrote:\n${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R29 "Our warehouse wrote:" then dates for both', email: `Hi Kim, our warehouse wrote:\n${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R30 "[A]" header then blank then lines', email: `[${A}]\n\n${H074} ships on 3 December.\n\n[${B}]\n\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R31 "Order no. A:" header + blank', email: `Order no. ${A}:\n\n${H074} ships on 3 December.\n\nOrder no. ${B}:\n\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R32 Outlook "·\\tA:" bullets', email: `·\t${A}: ${H074} ships on 3 December\n·\t${B}: ${H044} ships on 5 December`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December`]] } },
    // Single-order replies with supplier-side numbers (production: single path).
    { id: 'S01 single: "Your PO A, our order no. 0457: …"', email: `Hi Kim,\nYour PO ${A}, our order no. 0457: ${H074} ships on 3 December.\n${H110} ships on 4 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`], ['L2', '2026-12-04', `${H110} ships on 4 December.`]] } },
    { id: 'S02 single zh: "贵司订单 A，我司订单号 0457：…"', email: `李经理您好，\n贵司订单 ${A}，我司订单号 0457：\n${H074} 12月3日发货。\n${H110} 12月4日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`], ['L2', '2026-12-04', `${H110} 12月4日发货。`]] } },
    { id: 'S03 single: "Delivery note 0030 for A: …" (C = order 30 exists)', email: `Delivery note 0030 for ${A}: ${H074} ships on 3 December.`, per: { [A]: [['L1', '2026-12-03', `Delivery note 0030 for ${A}: ${H074} ships on 3 December.`]] } },
    { id: 'S04 single: "Order #4471 / Invoice INV-0457 / PO A"', email: `Order #4471 (your ${A})\n${H074} ships on 3 December.\nInvoice INV-0457 follows.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]] } },
    { id: 'S05 single zh: "订单号 88231，贵司 A：…"', email: `订单号 88231，贵司 ${A}：\n${H074} 12月3日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]] } },
    { id: 'S06 single: "Our SO 0457 = your A" + tel 0755 2345 6789', email: `${A}:\n${H074} ships on 3 December.\nOur SO 0457 covers your ${A}.\nLi Na, Tel 0755 2345 6789`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]] } },
    { id: 'S07 single zh: "订单 7 天内发货，074 12月3日到。" (order 7 exists, closed)', email: `${A}：\n订单 7 天内发货。\n${H074} 12月3日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]] } },
    { id: 'S08 single: "SAP Item 00010 …" under A (no order 10)', email: `Order acknowledgement ${A}\nItem 00010 ${H074} qty 10 ship date 3 December\nItem 00020 ${H110} qty 10 ship date 4 December`, per: { [A]: [['L1', '2026-12-03', `Item 00010 ${H074} qty 10 ship date 3 December`], ['L2', '2026-12-04', `Item 00020 ${H110} qty 10 ship date 4 December`]] } },
    { id: 'S09 single: "Our ref. 0457/2026, your A:"', email: `Our ref. 0457/2026, your ${A}:\n${H074} ships on 3 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]] } },
    { id: 'S10 single zh: "我方订单 PO 4471 / 贵司 A"', email: `贵司 ${A}（我方订单 PO 4471）：\n${H074} 12月3日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]] } },
  ]
  return { A, B, C, D, E, F, H044, H074, H110, H437, H500, L, LIST, LIST_EF, OPEN, ORDERS, R, RECEIVED, STATUS, W, item, short }
})()

// The fourth review (9a739ea3): its W and R emails.
export const ROUND_4 = (() => {
  // Adversarial probe cases for 9a739ea3 (gate) vs e098466c. No model.
  const A = 'PO-202611-0021'
  const B = 'PO-202611-0014'
  const C = 'PO-202611-0030'
  const D = 'PO-202610-0014' // near-duplicate of B
  const E = 'PO-202611-0010'
  const F = 'PO-202611-0003'
  const RECEIVED = '2026-11-18'
  const item = (ref, sku, remaining = 10) => ({ ref, purchaseOrderLineId: `${ref}-${sku}`, sku, supplierSku: null, itemName: `Item ${sku.slice(-3)}`, remaining, unit: 'pcs', promisedDate: '2026-11-25' })
  const H074 = 'HOUSEHOLD_2_074'
  const H110 = 'HOUSEHOLD_2_110'
  const H437 = 'HOUSEHOLD_2_437'
  const H044 = 'HOUSEHOLD_2_044'
  const H500 = 'HOUSEHOLD_2_500'
  const ORDERS = {
    [A]: { number: A, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H074), item('L2', H110), item('L3', H437)] },
    [B]: { number: B, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H044), item('L2', H110), item('L3', H437)] },
    [C]: { number: C, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H110), item('L2', H500)] },
    [D]: { number: D, supplierName: 'Household 2', status: 'issued', lines: [item('L1', H110), item('L2', H437)] },
  }
  // The supplier's list, newest first as the service sorts it; D = near-duplicate of B.
  const LIST = [A, C, B, D, 'PO-202610-0007', 'PO-202609-0018']
  const LIST_NO_D = [A, C, B, 'PO-202610-0007']
  const STATUS = { [D]: 'received', 'PO-202610-0007': 'received' }
  const L = (line, date, quote, extra = {}) => ({ line, date, quote, dateKind: 'stated', ...extra })

  const q110 = `${H110} ships on 9 December.`
  const z110 = `${H110} 12月9日发货。`
  const bad = [['L2', '2026-12-09']]
  // Unrecognised number form inside A's part; C keeps it on the several-order path.
  const nForm = (id, form) => ({ id, email: `Hi Kim,\n${A}:\n${H074} ships on 3 December.\n${form}\n${q110}\n${C}:\n${H500} ships on 12 December.\nRegards,\nLi Na`, on: A, lines: [L('L2', '2026-12-09', q110)], bad })
  const zForm = (id, form) => ({ id, email: `${A}：\n${H074} 12月3日发货。\n${form}\n${z110}\n${C}：\n${H500} 12月12日发货。`, on: A, lines: [L('L2', '2026-12-09', z110)], bad })
  // Text in B's part that starts with A's number (a comparison): on A.
  const cmp = (id, sentence, quote = sentence) => ({ id, email: `${A}:\n${H074} ships on 3 December.\n\n${B}:\n${H044} ships on 5 December.\n${sentence}`, on: A, lines: [L('L2', '2026-12-09', quote)], bad })
  const zcmp = (id, sentence, quote = sentence) => ({ id, email: `${A}：\n${H074} 12月3日发货。\n\n${B}：\n${H044} 12月5日发货。\n${sentence}`, on: A, lines: [L('L2', '2026-12-09', quote)], bad })

  const W = [
    // N: another order's number in a form neither tokensIn nor the gate sees.
    nForm('N01 bare "202611-0014:" header in A part (C named)', '202611-0014:'),
    nForm('N02 "Your ref. 202611-0014:" in A part', 'Your ref. 202611-0014:'),
    nForm('N03 German "PO Nr. 202611-0014:" in A part', 'PO Nr. 202611-0014:'),
    nForm('N04 "Order 14:" in A part', 'Order 14:'),
    nForm('N05 German "Bestellung 202611-0014:" in A part', 'Bestellung 202611-0014:'),
    nForm('N06 "#202611-0014:" in A part', '#202611-0014:'),
    nForm('N07 OCR zero "P0-202611-0014:" in A part', 'P0-202611-0014:'),
    nForm('N08 control "PO/202611/0014:" in A part', 'PO/202611/0014:'),
    nForm('N09 "No. 202611-0014:" in A part', 'No. 202611-0014:'),
    zForm('N10 zh "单号：202611-0014" in A part', '单号：202611-0014'),
    zForm('N11 zh "PO号：202611-0014" in A part', 'PO号：202611-0014'),
    nForm('N12 control "Purchase order 202611-0014:" in A part', 'Purchase order 202611-0014:'),
    // P: another order by its place, in words or layouts the lists miss.
    { id: 'P01 hard-wrapped "For the other\\norder, 110 ..." in A part', email: `${A}:\n${H074} ships on 3 December. For the other\norder, ${q110}\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'P02 "On a separate order, 110 ..." in A part', email: `${A}:\n${H074} ships on 3 December.\nOn a separate order, ${q110}\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'P03 "The other two orders: 110 ..." in A part', email: `${A}:\n${H074} ships on 3 December.\nThe other two orders: ${q110}\n\n${B}:\n${H044} ships on 5 December.\n\n${C}:\n${H500} ships on 12 December.`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'P04 "Your newer order: 110 ..." in A part (C named)', email: `${A}:\n${H074} ships on 3 December.\nYour newer order: ${q110}\n\n${C}:\n${H500} ships on 12 December.`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'P05 "The order you sent on Monday: 110 ..." in A part (C named)', email: `${A}:\n${H074} ships on 3 December.\nThe order you sent on Monday: ${q110}\n\n${C}:\n${H500} ships on 12 December.`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'P06 zh "另一个PO：" in A part (C named)', email: `${A}：\n${H074} 12月3日发货。\n另一个PO：${z110}\n\n${C}：\n${H500} 12月12日发货。`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    { id: 'P07 zh "别的订单：" in A part (C named)', email: `${A}：\n${H074} 12月3日发货。\n别的订单：${z110}\n\n${C}：\n${H500} 12月12日发货。`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    { id: 'P08 zh "第二个PO：" in A part (C named)', email: `${A}：\n${H074} 12月3日发货。\n第二个PO：${z110}\n\n${C}：\n${H500} 12月12日发货。`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    { id: 'P09 hard-wrapped "The remaining\\norders ship 9 Dec" in A part, on A L3', email: `${A}:\n${H074} ships on 3 December, ${H110} on 4 December. The remaining\norders ship on 9 December.\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L3', '2026-12-09', 'orders ship on 9 December.')], bad: [['L3', '2026-12-09']] },
    { id: 'P10 hard-wrapped place word + relative "next Friday"', email: `${A}:\n${H074} ships on 3 December. For the other\norder, ${H110} ships next Friday.\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-11-27', `${H110} ships next Friday.`, { dateKind: 'relative' })], bad: [['L2', '2026-11-27']] },
    { id: 'P11 "On a different PO, the 110 ..." in A part', email: `${A}:\n${H074} ships on 3 December.\nOn a different PO, the ${q110}\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    // C: a sentence in B's part that starts with A's number as a comparison (opens A).
    cmp('C01 "Compared to A, the 110 ships later, on 9 December." in B part', `Compared to ${A}, the ${H110} ships later, on 9 December.`),
    cmp('C02 "Once A is out, the 110 follows on 9 December." in B part', `Once ${A} is out, the ${H110} follows on 9 December.`),
    cmp('C03 "After A, 110 ships on 9 December." in B part', `After ${A}, ${H110} ships on 9 December.`),
    zcmp('C04 zh "比 A 晚，110 12月9日发货。" in B part', `比 ${A} 晚，${H110} 12月9日发货。`),
    zcmp('C05 zh "在 A 之后，110 12月9日发货。" in B part', `在 ${A} 之后，${H110} 12月9日发货。`),
    cmp('C06 "Different from A, 110 ships on 9 December." in B part', `Different from ${A}, ${H110} ships on 9 December.`),
    cmp('C07 "Later than A: 110 ships on 9 December." in B part', `Later than ${A}: ${H110} ships on 9 December.`),
    cmp('C08 "Instead of A, the 110 ships with this order on 9 December." in B part', `Instead of ${A}, the ${H110} ships with this order on 9 December.`),
    cmp('C09 "Following A, 110 ships on 9 December." in B part', `Following ${A}, ${H110} ships on 9 December.`),
    // O: A's own number in passing inside A's part, with words saying "not A".
    { id: 'O01 "The 9 December date for 110 does not apply to A." in A part', email: `${A}:\n${H074} ships on 3 December.\nThe 9 December date for ${H110} does not apply to ${A}.\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-12-09', `The 9 December date for ${H110} does not apply to ${A}.`)], bad },
    { id: 'O02 zh "110 不属于 A，12月9日发货。" in A part', email: `${A}：\n${H074} 12月3日发货。\n${H110} 不属于 ${A}，12月9日发货。\n\n${B}：\n${H044} 12月5日发货。`, on: A, lines: [L('L2', '2026-12-09', `${H110} 不属于 ${A}，12月9日发货。`)], bad },
    { id: 'O03 "Not A: 110 ships on 9 December." in A part', email: `${A}:\n${H074} ships on 3 December.\nNot ${A}: ${q110}\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-12-09', `Not ${A}: ${q110}`)], bad },
    { id: 'O04 place word + own number: "110 is not on A any more: it moves to the other PO and ships on 9 December."', email: `${A}:\n${H074} ships on 3 December.\n${H110} is not on ${A} any more: it moves to the other PO and ships on 9 December.\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} is not on ${A} any more: it moves to the other PO and ships on 9 December.`)], bad },
    { id: 'O05 control: "The other order B ships 110 on 9 Dec" in A part', email: `${A}:\n${H074} ships on 3 December.\nThe other order ${B} ships ${H110} on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `The other order ${B} ships ${H110} on 9 December.`)], bad },
    { id: 'O06 "The other PO (not A) gets the 110 on 9 December." in A part', email: `${A}:\n${H074} ships on 3 December.\nThe other PO (not ${A}) gets the ${H110} on 9 December.\n\n${B}:\n${H044} ships on 5 December.`, on: A, lines: [L('L2', '2026-12-09', `The other PO (not ${A}) gets the ${H110} on 9 December.`)], bad },
    { id: 'O07 zh "另一张单（不是 A）的 110 12月9日发货。" in A part', email: `${A}：\n${H074} 12月3日发货。\n另一张单（不是 ${A}）的 ${H110} 12月9日发货。\n\n${B}：\n${H044} 12月5日发货。`, on: A, lines: [L('L2', '2026-12-09', `另一张单（不是 ${A}）的 ${H110} 12月9日发货。`)], bad },
    // Q: our quoted chase left in, with an intro the cleaner and the gate do not know.
    { id: 'Q01 zh-TW Gmail "… 於 … 寫道：" (traditional) w/o blank line, then our chase; on B', email: `${A}：${H074} 12月3日发货。\n${B}：${H044} 12月5日发货。\nKim Chen <kim@flowchain.example> 於 2026年11月17日 週二 上午10:00寫道：\n${B}：請確認 ${H110} 12月1日到貨。`, on: B, lines: [L('L2', '2026-12-01', `${B}：請確認 ${H110} 12月1日到貨。`)], bad: [['L2', '2026-12-01']] },
    { id: 'Q02 French Outlook "De : / Envoyé :" w/o blank line; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\nDe : Kim Chen\nEnvoyé : mardi 17 novembre 2026 10:00\nÀ : Li Na\nObjet : RE: livraison\n${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    { id: 'Q03 Spanish Outlook "De: / Enviado el:" with blank lines; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\nDe: Kim Chen\nEnviado el: martes, 17 de noviembre de 2026 10:00\nPara: Li Na\nAsunto: ${B}\n\n${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    { id: 'Q04 Japanese Outlook "差出人: / 送信日時:" w/o blank line; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n差出人: Kim Chen\n送信日時: 2026年11月17日 10:00\n宛先: Li Na\n件名: ${B}\n${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    { id: 'Q05 German Gmail "Am … schrieb Kim …:" w/o blank line; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\nAm Di., 17. Nov. 2026 um 10:00 Uhr schrieb Kim Chen <kim@flowchain.example>:\n${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    { id: 'Q06 French Gmail "Le … a écrit :" with blank line, no date in intro; on B', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\nKim Chen a écrit :\n${B}: please confirm ${H110} for 1 December.`, on: B, lines: [L('L2', '2026-12-01', `${B}: please confirm ${H110} for 1 December.`)], bad: [['L2', '2026-12-01']] },
    // S: narrowing 3 (supplier's own numbers) — a buyer's PO after 我们/our.
    { id: 'S01 zh "我们这边 PO 0014 的 110 12月9日发货。" (D in list), on A', email: `${A}：${H074} 12月3日发货。\n我们这边 PO 0014 的 ${z110}`, on: A, lines: [L('L2', '2026-12-09', `我们这边 PO 0014 的 ${z110}`)], bad },
    { id: 'S02 zh "我们会在12月9日发出订单 0014 的 110。", on A', email: `${A}：${H074} 12月3日发货。\n我们会在12月9日发出订单 0014 的 ${H110}。`, on: A, lines: [L('L2', '2026-12-09', `我们会在12月9日发出订单 0014 的 ${H110}。`)], bad },
    { id: 'S03 "Our plan for PO 0014: 110 ships on 9 December.", on A', email: `${A}: ${H074} ships on 3 December.\nOur plan for PO 0014: ${q110}`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'S04 control several-path: "Our plan for PO 0014:" inside A part (C named)', email: `${A}:\n${H074} ships on 3 December.\nOur plan for PO 0014: ${q110}\n\n${C}:\n${H500} ships on 12 December.`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'S05 control "Our order PO-202611-0014: 110 ..." (exact) inside A part', email: `${A}:\n${H074} ships on 3 December.\nOur order ${B}: ${q110}`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'S06 control zh "我方订单 PO-202611-0014：110 …" (exact) inside A part', email: `${A}：\n${H074} 12月3日发货。\n我方订单 ${B}：${z110}`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    { id: 'S07 zh "我们的订单号 0014：110 …", on A', email: `${A}：${H074} 12月3日发货。\n我们的订单号 0014：${z110}`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    // U: unit-word narrowing (a count after the number).
    { id: 'U01 zh "订单 0014 件数如下：" (D in list), on A', email: `${A}：\n${H074} 12月3日发货。\n订单 0014 件数如下：\n${z110}`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    { id: 'U02 zh "订单0014个别品项延迟：" (个别 = some), on A', email: `${A}：\n${H074} 12月3日发货。\n订单0014个别品项延迟：\n${z110}`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    { id: 'U03 zh "订单 0014 天津仓发货：" (Tianjin), on A', email: `${A}：\n${H074} 12月3日发货。\n订单 0014 天津仓发货：\n${z110}`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    { id: 'U04 zh "订单0014周四发货：" (周四 = Thursday), on A', email: `${A}：\n${H074} 12月3日发货。\n订单0014周四发货：\n${H110} 12月10日发货。`, on: A, lines: [L('L2', '2026-12-10', `${H110} 12月10日发货。`)], bad: [['L2', '2026-12-10']] },
    { id: 'U05 control "PO-202611-0014 3天内发货：" (exact) in A part', email: `${A}：\n${H074} 12月3日发货。\n${B} 3天内发货：\n${z110}`, on: A, lines: [L('L2', '2026-12-09', z110)], bad },
    { id: 'U06 "PO 14 days late: 110 now ships on 9 December." on A', email: `${A}: ${H074} ships on 3 December.\nPO 14 days late: ${H110} now ships on 9 December.`, on: A, lines: [L('L2', '2026-12-09', `${H110} now ships on 9 December.`)], bad },
    { id: 'U07 control: U01 with no near-duplicate in the list, C named', email: `${A}：\n${H074} 12月3日发货。\n订单 0014 件数如下：\n${z110}\n\n${C}：\n${H500} 12月12日发货。`, on: A, list: LIST_NO_D, lines: [L('L2', '2026-12-09', z110)], bad },
    // X: recognised other orders around shared SKUs.
    { id: 'X01 "110 ships 9 Dec, same as on your order B." in A part, then 437', email: `${A}:\n${H074} ships on 3 December.\n${H110} ships on 9 December, same as on your order ${B}.\n${H437} ships on 10 December.`, on: B, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December, same as on your order ${B}.`), L('L3', '2026-12-10', `${H437} ships on 10 December.`)], bad: [['L3', '2026-12-10']] },
    { id: 'X02 "For your other order B please note:" then 110 line; on A', email: `${A}:\n${H074} ships on 3 December.\n\nFor your other order ${B} please note:\n${q110}`, on: A, lines: [L('L2', '2026-12-09', q110)], bad },
    { id: 'X03 (ambiguous, observe) "B as well." then 110 line; on B', email: `${A}:\n${H074} ships on 3 December.\n${B} as well.\n${q110}`, on: B, lines: [L('L2', '2026-12-09', q110)], bad: [] },
    { id: 'X04 "Your order B ships complete on 9 December." then 437 (A list continues); on B', email: `${A}:\n${H110} ships on 4 December.\nYour order ${B} ships complete on 9 December.\n${H437} ships on 10 December.`, on: B, lines: [L('L3', '2026-12-10', `${H437} ships on 10 December.`)], bad: [['L3', '2026-12-10']] },
    { id: 'X05 shared SKU, sentence of its own naming B, then the shared SKU for A', email: `${A}:\n${H074} ships on 3 December.\nAs for ${B}, nothing changes.\n${q110}`, on: B, lines: [L('L2', '2026-12-09', q110)], bad },
  ]

  // Ordinary, correct replies about several orders. per: order -> [ref, date, quote, extra].
  const R = [
    { id: 'R01 greeting, headers, blank lines, sign-off', email: `Hi Kim,\n\nPlease find the updated dates below.\n\n${A}:\n${H074} ships on 3 December.\n${H110} ships on 4 December.\n\n${B}:\n${H044} ships on 5 December.\n\nKind regards,\nLi Na`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`], ['L2', '2026-12-04', `${H110} ships on 4 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R02 greeting with a date ("your email of 17 November")', email: `Hi Kim,\nThanks for your email of 17 November.\n\n${A}:\n${H074} ships on 3 December.\n\n${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R03 signature with the date', email: `${A}:\n${H074} ships on 3 December.\n\n${B}:\n${H044} ships on 5 December.\n\nBest regards,\nLi Na\n18 November 2026`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R04 headers carrying the date ("A: all lines 3 December.")', email: `${A}: all lines 3 December.\n${B}: all lines 5 December.`, per: { [A]: [['L1', '2026-12-03', `${A}: all lines 3 December.`], ['L2', '2026-12-03', `${A}: all lines 3 December.`], ['L3', '2026-12-03', `${A}: all lines 3 December.`]], [B]: [['L1', '2026-12-05', `${B}: all lines 5 December.`], ['L2', '2026-12-05', `${B}: all lines 5 December.`], ['L3', '2026-12-05', `${B}: all lines 5 December.`]] } },
    { id: 'R05 zh greeting + two lines', email: `李经理您好，\n${A}：${H074} 12月3日发货，${H110} 12月4日发货。\n${B}：${H044} 12月5日发货。\n谢谢！`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货`], ['L2', '2026-12-04', `${H110} 12月4日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
    { id: 'R06 header without colon, dash list', email: `${A}\n- ${H074}: 3 December\n- ${H110}: 4 December\n${B}\n- ${H044}: 5 December`, per: { [A]: [['L1', '2026-12-03', `${H074}: 3 December`], ['L2', '2026-12-04', `${H110}: 4 December`]], [B]: [['L1', '2026-12-05', `${H044}: 5 December`]] } },
    { id: 'R07 pipe table', email: `PO | SKU | Ship date\n${A} | ${H074} | 3 December\n${B} | ${H044} | 5 December`, per: { [A]: [['L1', '2026-12-03', `${A} | ${H074} | 3 December`]], [B]: [['L1', '2026-12-05', `${B} | ${H044} | 5 December`]] } },
    { id: 'R08 "For A, …. For B, …." one line', email: `For ${A}, ${H074} ships on 3 December. For ${B}, ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `For ${A}, ${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `For ${B}, ${H044} ships on 5 December.`]] } },
    { id: 'R09 shared SKU, relative date on A', email: `${A}:\n${H110} ships next Friday.\n\n${B}:\n${H110} ships on 9 December.`, per: { [A]: [['L2', '2026-11-27', `${H110} ships next Friday.`, { dateKind: 'relative' }]], [B]: [['L2', '2026-12-09', `${H110} ships on 9 December.`]] } },
    { id: 'R10 three orders inline', email: `${A}: ${H074} 3 December. ${B}: ${H044} 5 December. ${C}: ${H500} 7 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} 5 December.`]], [C]: [['L2', '2026-12-07', `${H500} 7 December.`]] } },
    { id: 'R11 opening "As discussed on Monday"', email: `Good morning Kim,\nAs discussed on Monday, here are the dates.\n${A}:\n${H074} ships on 3 December.\n${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R12 numbered "1. A: …"', email: `1. ${A}: ${H074} ships on 3 December.\n2. ${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R13 markdown bold headers, multi-line part', email: `**${A}**\n\n${H074} ships on 3 December.\n${H437} ships on 10 December.\n\n**${B}**\n\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`], ['L3', '2026-12-10', `${H437} ships on 10 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R14 short forms "PO 21:" / "PO 30:"', email: `PO 21: ${H074} ships on 3 December.\nPO 30: ${H500} ships on 7 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [C]: [['L2', '2026-12-07', `${H500} ships on 7 December.`]] } },
    { id: 'R15 zh "订单 0021：" / "订单 0030："', email: `订单 0021：${H074} 12月3日发货。\n订单 0030：${H500} 12月7日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [C]: [['L2', '2026-12-07', `${H500} 12月7日发货。`]] } },
    { id: 'R16 "RE: A / B" subject then "A - …" lines', email: `RE: ${A} / ${B}\n\n${A} - ${H074} ships on 3 December\n${B} - ${H044} ships on 5 December`, per: { [A]: [['L1', '2026-12-03', `${A} - ${H074} ships on 3 December`]], [B]: [['L1', '2026-12-05', `${B} - ${H044} ships on 5 December`]] } },
    { id: 'R17 dates first "3 December: A 074"', email: `3 December: ${A} ${H074}\n5 December: ${B} ${H044}`, per: { [A]: [['L1', '2026-12-03', `3 December: ${A} ${H074}`]], [B]: [['L1', '2026-12-05', `5 December: ${B} ${H044}`]] } },
    { id: 'R18 "Hello Kim, A: …" greeting inline', email: `Hello Kim, ${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R19 quantities "all 10 pcs"', email: `${A}:\n${H074}: all 10 pcs ship on 3 December.\n${B}:\n${H044}: all 10 pcs ship on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074}: all 10 pcs ship on 3 December.`, { quantity: 10 }]], [B]: [['L1', '2026-12-05', `${H044}: all 10 pcs ship on 5 December.`, { quantity: 10 }]] } },
    { id: 'R20 "moves to" + closing line', email: `${A}: ${H074} moves to 3 December.\n${B}: ${H044} moves to 5 December.\nThanks for your patience.`, per: { [A]: [['L1', '2026-12-03', `${H074} moves to 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} moves to 5 December.`]] } },
    { id: 'R21 zh "1、A：" list', email: `1、${A}：\n${H074} 12月3日发货\n2、${B}：\n${H044} 12月5日发货`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货`]] } },
    { id: 'R22 "Sent from my iPhone" footer', email: `${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.\n\nSent from my iPhone`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R23 "A ETA:" headers', email: `${A} ETA:\n${H074} 3 December\n${B} ETA:\n${H044} 5 December`, per: { [A]: [['L1', '2026-12-03', `${H074} 3 December`]], [B]: [['L1', '2026-12-05', `${H044} 5 December`]] } },
    { id: 'R24 "both orders are on track" opener', email: `Hi Kim, both orders are on track.\n${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R25 "your two orders below" opener', email: `Please see the dates for your two orders below.\n${A}: ${H074} ships on 3 December.\n${B}: ${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R26 zh "两张单的交期如下："', email: `两张单的交期如下：\n${A}：${H074} 12月3日发货。\n${B}：${H044} 12月5日发货。`, per: { [A]: [['L1', '2026-12-03', `${H074} 12月3日发货。`]], [B]: [['L1', '2026-12-05', `${H044} 12月5日发货。`]] } },
    { id: 'R27 disclaimer footer', email: `${A}:\n${H074} ships on 3 December.\n${B}:\n${H044} ships on 5 December.\n\nThis email and any attachments are confidential.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R28 "see below" + headers, "3 Dec" short dates', email: `Hi Kim, see below.\n\n${A}\n${H074} – 3 Dec\n\n${B}\n${H044} – 5 Dec`, per: { [A]: [['L1', '2026-12-03', `${H074} – 3 Dec`]], [B]: [['L1', '2026-12-05', `${H044} – 5 Dec`]] } },
    { id: 'R29 "Thanks for chasing yesterday" opener (relative outside parts)', email: `Thanks for chasing yesterday.\n\n${A}:\n${H074} ships on 3 December.\n\n${B}:\n${H044} ships on 5 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [B]: [['L1', '2026-12-05', `${H044} ships on 5 December.`]] } },
    { id: 'R30 one order\'s line mentions the other in its own sentence', email: `${A}:\n${H074} ships on 3 December.\n${B} follows next week, details tomorrow.\n\n${C}:\n${H500} ships on 7 December.`, per: { [A]: [['L1', '2026-12-03', `${H074} ships on 3 December.`]], [C]: [['L2', '2026-12-07', `${H500} ships on 7 December.`]] } },
  ]

  // Extra literal edge cases from the brief.
  W.push(
    { id: 'U08 literal "PO-202611-0014天内全部发出：" header in A part', email: `${A}：\n${H074} 12月3日发货。\n${B}天内全部发出：\n${H110} 12月9日发货。`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
    { id: 'U09 "订单 0014 件数如下：" in A part, C named, D in list', email: `${A}：\n${H074} 12月3日发货。\n订单 0014 件数如下：\n${H110} 12月9日发货。\n\n${C}：\n${H500} 12月12日发货。`, on: A, lines: [L('L2', '2026-12-09', `${H110} 12月9日发货。`)], bad: [['L2', '2026-12-09']] },
    { id: 'S08 S04 with no near-duplicate (our PO 0014 = B)', email: `${A}:\n${H074} ships on 3 December.\nOur plan for PO 0014: ${H110} ships on 9 December.\n\n${C}:\n${H500} ships on 12 December.`, on: A, list: LIST_NO_D, lines: [L('L2', '2026-12-09', `${H110} ships on 9 December.`)], bad: [['L2', '2026-12-09']] },
  )
  return { A, B, C, D, E, F, H044, H074, H110, H437, H500, L, LIST, LIST_NO_D, ORDERS, R, RECEIVED, STATUS, W, bad, cmp, item, nForm, q110, z110, zForm, zcmp }
})()

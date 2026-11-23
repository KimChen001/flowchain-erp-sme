// The third #449 review's probes, written against 9d34af4d (11/22): 60
// emails hunting a date proposed on the wrong order or line (W), 32
// ordinary replies about several orders (R) and 10 one-order replies with
// the supplier's own numbers (S). Each runs three ways: as the paste runs it
// (the supplier's orders looked up when a number is written another way;
// pasteSeveral when two or more are named), with emailRead and orderNumbers
// both empty (e0), and with emailRead empty but the supplier's orders given
// (eF). No model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReplyReading, checkReplyReadingBeforeGate, cleanSupplierReply } from './supplier-reply-reading.mjs'
import { emailOrdersToRead, orderNumberVariants, orderNumbersNamed } from './supplier-reply-orders.mjs'

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

const statusOf = (kase, number) => (kase.statusOverride && kase.statusOverride[number]) || STATUS[number] || 'issued'
// As the paste runs it, on the order the email is pasted on.
function asThePaste(kase, text) {
  const pasted = kase.pasted || Object.keys(kase.per || {})[0] || A
  const list = kase.supplierOrders || LIST
  const known = orderNumberVariants(text, pasted) ? list : []
  const named = orderNumbersNamed(text, pasted, known)
  if (named.length < 2) return { emailRead: [], orderNumbers: known }
  const choice = emailOrdersToRead({ named, pastedOn: pasted, openStates: OPEN, limit: 5, orders: list.map((number) => ({ number, status: statusOf(kase, number), supplier: 'S1' })) })
  return { emailRead: choice.read.filter((number) => ORDERS[number]), orderNumbers: known }
}
const MODES = ['paste', 'e0', 'eF']
function argsFor(kase, on, lines, mode) {
  const text = cleanSupplierReply(kase.email).text
  const paths = mode === 'paste' ? asThePaste(kase, text) : mode === 'e0' ? { emailRead: [], orderNumbers: [] } : { emailRead: [], orderNumbers: kase.supplierOrders || LIST }
  return { order: { ...ORDERS[on], status: 'issued' }, text, receivedOn: RECEIVED, reading: { replyKind: 'dates', lines, flags: kase.flags || [], reason: null }, ...paths }
}
const check = (kase, on, lines, mode) => checkReplyReading(argsFor(kase, on, lines, mode))
const wrongIn = (result, kase) => result.lines.filter((line) => line.outcome === 'proposed' && (kase.bad || []).some(([ref, date]) => ref === line.ref && date === line.proposedDate)).map((line) => `${line.ref}@${line.proposedDate}`)

// Known gaps on the one-order paste, which the gate does not touch (it reads
// as on main; coordinator, 11/22): another order's number in a form the
// numbering does not see (W02 "PO No. 202611-0014:", W03 订单号：202611-0014,
// W07 a U+2010 dash, W08 "Order No.", W58 "PO#:", W59 "PO Number:"), and an
// email that names only A read on F (W57, as when pasted on the wrong order).
// Wrong on main too; followed up apart.
const ONE_ORDER_GAPS = ['W02', 'W03', 'W07', 'W08', 'W57', 'W58', 'W59']
test('third review probes: no date is ever proposed on an order or line it is not for (53 of 60 emails, three ways of reading)', () => {
  assert.equal(W.length, 60)
  for (const kase of W.filter((one) => !ONE_ORDER_GAPS.includes(one.id.split(' ')[0]))) {
    for (const mode of MODES) assert.deepEqual(wrongIn(check(kase, kase.on, kase.lines, mode), kase), [], `${kase.id} [${mode}]`)
  }
})
test('third review probes: the one-order paste still misreads another order written in a form it does not see (W02, W03, W07, W08, W57, W58, W59)', { todo: 'known gap on the one-order path, as on main; followed up apart' }, () => {
  for (const kase of W.filter((one) => ONE_ORDER_GAPS.includes(one.id.split(' ')[0]))) {
    for (const mode of MODES) assert.deepEqual(wrongIn(check(kase, kase.on, kase.lines, mode), kase), [], `${kase.id} [${mode}]`)
  }
})

// The final gate only adds holds: every line is as it was before the gate,
// or a proposal (or a line dropped as another order's text) is now held as
// several_orders_unclear. Nothing proposed, dropped or moved by it.
function onlyAddsHolds(before, after) {
  if (before.lines.length !== after.lines.length || JSON.stringify(before.flags) !== JSON.stringify(after.flags)) return false
  return before.lines.every((row, at) => {
    const next = after.lines[at]
    if (JSON.stringify(row) === JSON.stringify(next)) return true
    return next.ref === row.ref && next.outcome === 'needs_you' && next.issue === 'several_orders_unclear' && next.proposedDate === null && (row.outcome === 'proposed' || (row.outcome === 'dropped' && row.issue === 'other_order_text'))
  }) && (after.state === before.state || after.state === 'needs_you')
}
test('third review probes: the final gate only adds holds (60 + 42 emails, three ways of reading)', () => {
  for (const mode of MODES) {
    for (const kase of W) assert.ok(onlyAddsHolds(checkReplyReadingBeforeGate(argsFor(kase, kase.on, kase.lines, mode)), check(kase, kase.on, kase.lines, mode)), `${kase.id} [${mode}]`)
    for (const kase of R) {
      for (const [on, rows] of Object.entries(kase.per)) {
        const lines = rows.map(([ref, date, quote, extra]) => L(ref, date, quote, extra))
        assert.ok(onlyAddsHolds(checkReplyReadingBeforeGate(argsFor(kase, on, lines, mode)), check(kase, on, lines, mode)), `${kase.id} on ${short(on)} [${mode}]`)
      }
    }
  }
})

// Every correct line, read on its own order: proposed (or confirmed), or
// held for the person; never dropped and never another date. The counts are
// reported in the PR: 48 proposed and 37 held as the paste runs it (and with
// eF), 47 and 38 in e0, where no supplier list tells numbers apart.
function tally(mode) {
  const got = { proposed: 0, held: [], other: [] }
  for (const kase of R) {
    for (const [on, rows] of Object.entries(kase.per)) {
      const result = check(kase, on, rows.map(([ref, date, quote, extra]) => L(ref, date, quote, extra)), mode)
      for (const [ref, date] of rows) {
        const row = result.lines.find((line) => line.ref === ref)
        const id = `${kase.id.split(' ')[0]} ${short(on)} ${ref}`
        if ((row?.outcome === 'proposed' && row.proposedDate === date) || row?.outcome === 'confirmed') got.proposed += 1
        else if (row?.outcome === 'needs_you') got.held.push(id)
        else got.other.push(`${id}: ${row?.outcome}/${row?.issue}@${row?.proposedDate}`)
      }
    }
  }
  return got
}
test('third review probes: of the 85 correct lines none is dropped or given another date, three ways of reading', () => {
  for (const mode of MODES) {
    const got = tally(mode)
    assert.deepEqual(got.other, [], mode)
    assert.equal(got.proposed + got.held.length, 85, mode)
  }
})

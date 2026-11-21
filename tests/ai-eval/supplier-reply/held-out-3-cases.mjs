// The third held-out batch of supplier replies (README.md, "The third
// held-out batch (not yet run)"): written blind from
// docs/supplier-reply-dates-design.md (#363) and the contract
// (shared/supplier-reply-contract.mjs), with this folder's case files as the
// format, without reading the reading's code, its fixes or their branches.
// Same schema and helpers as cases.mjs.
//
// Not yet run. Running it (scripts/supplier-reply-eval.mjs
// --batch=held-out-3) calls a paid model and waits for the owner's approval.
//
// What it holds:
//   - supplier codes: the reply names lines only by the supplier's own item
//     code. The seed has no supplier codes, so these orders are the seed
//     snapshots with assumed codes written by us (ASSUMED_SUPPLIER_SKUS). In
//     one reply a code and its description point to different lines; in
//     another a code is on no line;
//   - one email about several orders, pasted on one of them: only that
//     order's lines are proposed, and each other order is flagged (§4.8);
//   - answers written inside the quoted thread: between ">" lines with no
//     header above them, which §4.3 keeps, and under a 原始邮件 header, which
//     §4.3 drops. Our own text and its dates are never proposed;
//   - "next Tuesday" and 下周三: that weekday in the following week, as #363
//     reads "next Friday" from Tue 17 Nov as Fri 27 Nov;
//   - month-end: "end of the month", "by month end", 月底 and 本月底 name no
//     day, so the line goes to the person (§4.5, vague) and the month's last
//     day is never proposed.
// Where #363 is silent, a case takes the conservative reading (the line goes
// to the person, and nothing doubtful is proposed) and says so.
import { CASE_HELPERS } from './cases.mjs'

const { kase, order, refsOf, email, proposed, relative, vague } = CASE_HELPERS

// Tags for this batch beyond cases.mjs's own.
export const HELD_OUT_3_TAGS = Object.freeze(['supplier-sku', 'several-orders', 'inline-answer', 'month-end'])

// The label on an order whose lines carry supplier codes. The seed links each
// item to its supplier without one (README, "Supplier part numbers"), so the
// codes are ours.
export const ASSUMED_SUPPLIER_SKUS = 'FlowChain team, assumed supplier codes (the seed has none)'

// The assumed codes, by supplier and our SKU: a supplier keeps one code per
// item on every order. None looks like our SKU, so a reply that gives only
// the code can be matched only through supplierSku.
const SUPPLIER_CODES = Object.freeze({
  'Supplier of other codes (assumed)': { '16161P': 'K-11804', '17003': 'K-20317', '71477': 'K-30562', '79321': 'K-41209', '82482': 'K-21977', '82494L': 'K-21980' },
  'Globex Party Supplies': { '84347': 'GX-1150', '84945': 'GX-1162', '84946': 'GX-1163', '84970L': 'GX-2208', '84970S': 'GX-2209' },
  'Supplier of 20xxx codes (assumed)': { '20668': 'HX-3307', '20723': 'HX-1148', '20914': 'HX-2290', '20971': 'HX-4415', '20972': 'HX-4416' },
})

const heldOut = (fields) => kase({ ...fields, heldOut: true })

// A case whose order lines carry the assumed supplier codes, with the codes
// and their label kept on the case for the structure check.
function withSupplierCodes(row) {
  const codes = SUPPLIER_CODES[row.order.supplierName] || {}
  const lines = row.order.lines.map((line) => {
    if (!codes[line.sku]) throw new Error(`No assumed supplier code for ${row.order.number} ${line.sku}.`)
    return { ...line, supplierSku: codes[line.sku] }
  })
  return {
    ...row,
    order: { ...row.order, lines },
    assumedSupplierSkus: { label: ASSUMED_SUPPLIER_SKUS, codes: Object.fromEntries(lines.map((line) => [line.ref, line.supplierSku])) },
  }
}

// A line left to the person, with no issue code expected.
const toPerson = (ref) => ({ ref, outcome: 'needs_you', proposedDate: null })

export const HELD_OUT_3_CASES = [
  withSupplierCodes(heldOut({
    id: 'en-uci-0013-supplier-codes-only',
    lang: 'en', workspace: 'uci',
    about: 'Three of six lines named only by the supplier\'s own codes: two dates by code, and "the end of the month" for the third (vague). The three lines not named are not proposed.',
    covers: ['supplier-sku', 'date-per-item', 'month-end', 'vague'],
    replyDate: '2026-11-20', today: '2026-11-20',
    order: order('uci', 'PO-202611-0013'),
    replyText: email(`
      Hello Daniel,

      An update on PO-202611-0013, by our item codes:

      K-20317 - packed, ships 26 November
      K-30562 - the glass came in late, ships 1 December
      K-41209 - still waiting for plugs, so the end of the month. I'll confirm the exact day.

      Regards,
      Marta Lindqvist
      Sales team
    `),
    // §4.4 gives the reading each line's supplier SKU, so a code alone
    // matches its line. "The end of the month" names no day: vague (§4.5).
    expected: {
      state: 'proposed', replyKind: 'dates',
      lines: [
        proposed('L2', '2026-11-26', 'K-20317 - packed, ships 26 November'),
        proposed('L3', '2026-12-01', 'ships 1 December'),
        vague('L4'),
      ],
      mustNotPropose: [
        { date: '2026-11-30', why: '"the end of the month" names no day' },
        ...['L1', 'L5', 'L6'].map((ref) => ({ ref, why: 'its code is not in the reply' })),
      ],
    },
  })),
  withSupplierCodes(heldOut({
    id: 'en-uci-0018-supplier-code-conflict',
    lang: 'en', workspace: 'uci',
    about: 'Two items by code and description: GX-1150 and its description both point to L1; GX-1163 is L3\'s code, but "Multi colour silver T-light holder" is L2\'s item, so neither line gets that date.',
    covers: ['supplier-sku', 'date-per-item'],
    replyDate: '2026-11-20', today: '2026-11-20',
    order: order('uci', 'PO-202611-0018'),
    replyText: email(`
      Hi Daniel,

      Two changes on PO-202611-0018:

      GX-1150 Rotating silver angels T-light holder - now 3 December
      GX-1163 Multi colour silver T-light holder - now 8 December

      Best,
      Tomás
      Globex Party Supplies
    `),
    // #363 sends an item that matches no line to the person (§4.8, SR-4) but
    // does not say what happens when the code and the description name
    // different lines. Conservative: the item is not matched, both lines go
    // to the person, and 8 December is proposed on neither.
    expected: {
      state: 'proposed', replyKind: 'dates',
      lines: [proposed('L1', '2026-12-03', 'now 3 December'), toPerson('L2'), toPerson('L3')],
      mustNotPropose: [
        { date: '2026-12-08', why: 'GX-1163 is L3\'s code but the description is L2\'s item: not matched' },
        ...['L4', 'L5'].map((ref) => ({ ref, why: 'not in the reply' })),
      ],
    },
  })),
  withSupplierCodes(heldOut({
    id: 'zh-uci-0014-supplier-code-not-on-order',
    lang: 'zh', workspace: 'uci',
    about: '只用供应商货号：HX-1148、HX-2290 对得上两行（12月3日）；HX-4417 不在这张单上，写的“毛毡收纳盒”又同时像 L4 和 L5，它的 12月9日 哪一行都不能提议。',
    covers: ['supplier-sku', 'date-per-item'],
    replyDate: '2026-11-20', today: '2026-11-20',
    order: order('uci', 'PO-202611-0014'),
    replyText: email(`
      Daniel 您好：

      PO-202611-0014 按我们的货号说一下：
      HX-1148、HX-2290 两款12月3日发货；
      HX-4417 毛毡收纳盒要等毛毡到货，12月9日发。

      谢谢！
      销售部 赵敏
    `),
    // §4.8: an item that matches no line goes to the person. The code is on
    // no line and the description fits L4 and L5 alike. #363 does not say
    // whether a near code (HX-4415, HX-4416) may be taken for it:
    // conservative, it may not, and both lines go to the person.
    expected: {
      state: 'proposed', replyKind: 'dates',
      lines: [
        proposed('L2', '2026-12-03', '两款12月3日发货'),
        proposed('L3', '2026-12-03', '两款12月3日发货'),
        toPerson('L4'),
        toPerson('L5'),
      ],
      mustNotPropose: [
        { date: '2026-12-09', why: 'HX-4417 不在这张单上，哪一行都对不上' },
        { ref: 'L1', why: '回信没有提到它的货号' },
      ],
    },
  })),
  heldOut({
    id: 'en-uci-0030-several-orders',
    lang: 'en', workspace: 'uci',
    about: 'One status email about three Acme orders, pasted on PO-202610-0030: only its line is proposed (2 Dec). PO-202610-0028 (the same item) and PO-202611-0019 are flagged, and their dates go nowhere.',
    covers: ['several-orders', 'other-order'],
    replyDate: '2026-11-20', today: '2026-11-20',
    order: order('uci', 'PO-202610-0030'),
    replyText: email(`
      Hi Daniel,

      Here's where your three open orders with us stand:

      PO-202610-0028 - the 220 heart T-light holders still to come: ships 25 November
      PO-202610-0030 - all 330 heart T-light holders: ships 2 December
      PO-202611-0019 - jumbo bags and chocolate signs: on track for 30 November

      Kind regards,
      Priya
      Acme Home Goods
    `),
    // §4.8: another order mentioned is flagged with a link, and nothing is
    // recorded on it from here.
    expected: {
      state: 'proposed', replyKind: 'dates',
      lines: [proposed('L1', '2026-12-02', 'all 330 heart T-light holders: ships 2 December')],
      flags: [{ kind: 'other_order', orderNumber: 'PO-202610-0028' }, { kind: 'other_order', orderNumber: 'PO-202611-0019' }],
      mustNotPropose: [
        { date: '2026-11-25', why: 'PO-202610-0028\'s date, for the same item on another order' },
        { date: '2026-11-30', why: 'PO-202611-0019\'s date' },
      ],
    },
  }),
  heldOut({
    id: 'zh-uci-0012-several-orders',
    lang: 'zh', workspace: 'uci',
    about: '一封信说了 Globex 的三张单，粘贴在 PO-202611-0012 上：只提议这张单（六行都是12月1日）；PO-202610-0029 和 PO-202611-0018 只标出。0018 里也有 84347、84945，它们的 12月7日 不能落到这张单上。',
    covers: ['several-orders', 'other-order', 'one-date'],
    replyDate: '2026-11-20', today: '2026-11-20',
    order: order('uci', 'PO-202611-0012'),
    replyText: email(`
      Daniel 您好：

      您在我们这边的三张单，最新安排如下：

      PO-202610-0029（鸟形挂饰360个）：11月26日发货；
      PO-202611-0012（六款）：整张单12月1日发货；
      PO-202611-0018：84347、84945 两款改到12月7日，其余三款还是11月30日。

      陈经理
      Globex Party Supplies
    `),
    // §4.8: each other order is flagged with a link; nothing is recorded on
    // it from here, even where it holds the same items.
    expected: {
      state: 'proposed', replyKind: 'dates',
      lines: refsOf('uci', 'PO-202611-0012').map((ref) => proposed(ref, '2026-12-01', '整张单12月1日发货')),
      flags: [{ kind: 'other_order', orderNumber: 'PO-202610-0029' }, { kind: 'other_order', orderNumber: 'PO-202611-0018' }],
      mustNotPropose: [
        { date: '2026-11-26', why: 'PO-202610-0029 的日期' },
        { date: '2026-12-07', why: 'PO-202611-0018 里 84347、84945 的日期；这张单上也有这两款，但不记在这里' },
        { date: '2026-11-30', why: 'PO-202611-0018 其余三款的日期' },
      ],
    },
  }),
  heldOut({
    id: 'en-uci-0008-inline-answers',
    lang: 'en', workspace: 'uci',
    about: 'Answers typed between the ">" lines of our quoted chase, one under each line and naming its item, with no "On … wrote:" line above the quote: each line gets its own date, and the old date in our chase is never proposed.',
    covers: ['inline-answer', 'quoted-chase', 'date-per-item'],
    replyDate: '2026-11-25', today: '2026-11-25',
    order: order('uci', 'PO-202611-0008'),
    replyText: email(`
      Hello Daniel,

      Our answers are under each line of your email.

      > Our purchase order PO-202611-0008 was due on 23 Nov 2026 and is now 2 days overdue. These lines are still to be delivered:
      > - 20724 Red Retrospot Charlotte Bag: 48 pcs (promised 23 Nov 2026)
      20724 - packed today, goes out on 27 November.
      > - 20727 Lunch Bag Black Skull.: 52 pcs (promised 23 Nov 2026)
      20727 - on the same van, 27 November.
      > - 20972 Pink Cream Felt Craft Trinket Box: 71 pcs (promised 23 Nov 2026)
      20972 - the felt arrived late, so these ship on 3 December.
      >
      > Please confirm when they will ship, or send us a new delivery date.
      >
      > Thank you,

      Regards,
      Sales office
    `),
    // §4.3 drops the lines that start with ">". With no header above them,
    // the supplier's lines in between are its new text and are read; each
    // names its item, so no line needs the quoted part to be matched.
    expected: {
      state: 'proposed', replyKind: 'dates',
      lines: [
        proposed('L1', '2026-11-27', '20724 - packed today, goes out on 27 November'),
        proposed('L2', '2026-11-27', '20727 - on the same van, 27 November'),
        proposed('L3', '2026-12-03', 'these ship on 3 December'),
      ],
      mustNotPropose: [{ date: '2026-11-23', why: 'the old promised date, only in our quoted chase' }],
    },
  }),
  heldOut({
    id: 'zh-uci-0029-inline-original-message',
    lang: 'zh', workspace: 'uci',
    about: '答复写在“原始邮件”下面我们自己的信里（【答】开头）：只说了本月底，没有具体哪天；我们信里的 11月13日、12月1日、12月3日 都不能提议。',
    covers: ['inline-answer', 'quoted-chase', 'month-end'],
    replyDate: '2026-11-24', today: '2026-11-24',
    order: order('uci', 'PO-202610-0029'),
    replyText: email(`
      Daniel 您好，

      您的两个问题我直接答在下面原邮件里了（【答】开头的两行）。

      陈经理


      ------------------ 原始邮件 ------------------
      发件人：Daniel <daniel@example.com>
      发送时间：2026年11月23日 16:20
      收件人："Globex order desk" <orders@globex-party.example>
      主题：回复：采购订单 PO-202610-0029 交货逾期

      陈经理您好，

      原定11月13日交货的360个鸟形挂饰，现在哪天能发？
      【答】工厂说本月底，具体哪天还没定。

      能不能在12月1日前送到？我们12月3日有促销活动。
      【答】这个保证不了，只能尽量。

      谢谢！
      Daniel
    `),
    // §4.3 drops everything after 原始邮件 and never reads it, so a reading
    // by #363 sees no date at all (nothing to record, accepted). Read inline,
    // 本月底 names no day (vague: needs you). #363 does not say how answers
    // under a header are read; the conservative outcome is that the line
    // goes to the person. Either way nothing is proposed.
    expected: {
      state: 'needs_you', replyKind: 'dates', alsoAccept: ['nothing_to_record'],
      lines: [toPerson('L1')],
      mustNotPropose: [
        { date: '2026-11-30', why: '本月底没有说哪一天' },
        { date: '2026-12-01', why: '我们自己问的日子，只在引用的原邮件里' },
        { date: '2026-12-03', why: '我们的促销日，只在引用的原邮件里' },
        { date: '2026-11-13', why: '原定的日期，只在引用的原邮件里' },
      ],
    },
  }),
  heldOut({
    id: 'en-uci-0028-next-tuesday',
    lang: 'en', workspace: 'uci',
    about: '"Next Tuesday" from Mon 23 Nov reads as Tue 1 Dec, the Tuesday of the following week. Pasted a week later, it still counts from the reply date, not from the day it was pasted.',
    covers: ['relative'],
    replyDate: '2026-11-23', today: '2026-11-30',
    order: order('uci', 'PO-202610-0028'),
    replyText: email(`
      Hi Daniel,

      Good news - the coating line is running again. The balance of 220 holders will go out next Tuesday with our regular collection.

      Priya
      Acme Home Goods
    `),
    // #363 reads "next Friday" from Tue 17 Nov as Fri 27 Nov: that weekday
    // in the following week. The same rule from Mon 23 Nov gives Tue 1 Dec.
    expected: {
      state: 'proposed', replyKind: 'dates',
      lines: [relative('L1', '2026-12-01', 'next Tuesday', '2026-11-23', 'will go out next Tuesday')],
      mustNotPropose: [
        { date: '2026-11-24', why: 'the day after the reply, this week\'s Tuesday' },
        { date: '2026-12-08', why: 'next Tuesday counted from the day it was pasted (30 Nov), not from the reply date' },
      ],
    },
  }),
  heldOut({
    id: 'zh-uci-0013-next-wednesday-month-end',
    lang: 'zh', workspace: 'uci',
    about: '“下周三”从回信日 11月23日（周一）算是 12月2日，五行提议并标明“读作”；灯串（79321）“要到月底才能发”，没有具体哪天，交给你看。',
    covers: ['relative', 'month-end', 'vague'],
    replyDate: '2026-11-23', today: '2026-11-23',
    order: order('uci', 'PO-202611-0013'),
    replyText: email(`
      Daniel 您好：

      PO-202611-0013 除了灯串（79321），其余五款下周三一起发货。
      灯串的插头还没到，要到月底才能发，具体哪天我再告诉您。

      销售部 刘洋
    `),
    // 下周三 is next week's Wednesday (#363's "next Friday" rule). 月底 names
    // no day: vague (§4.5).
    expected: {
      state: 'proposed', replyKind: 'dates',
      lines: refsOf('uci', 'PO-202611-0013').map((ref) => (ref === 'L4' ? vague(ref) : relative(ref, '2026-12-02', '下周三', '2026-11-23', '其余五款下周三一起发货'))),
      mustNotPropose: [
        { date: '2026-11-25', why: '本周三，不是下周三' },
        { date: '2026-11-30', why: '“月底”没有说哪一天' },
      ],
    },
  }),
  heldOut({
    id: 'en-m5-0014-by-month-end',
    lang: 'en', workspace: 'm5',
    about: 'M5: "won\'t make 11/23 … the full PO to you by month end" for all eleven lines. "By month end" is a deadline and names no day, so the order goes to the person.',
    covers: ['month-end', 'vague'],
    replyDate: '2026-11-19', today: '2026-11-19',
    order: order('m5', 'PO-202611-0014'),
    replyText: email(`
      Hi,

      PO-202611-0014 won't make 11/23 - a conveyor breakdown at our DC has put us behind. We'll have the full PO to you by month end and will send the delivery appointment once it's booked.

      Thanks,
      Customer Care Team
    `),
    // Vague (§4.5); "by" is also one of the hedge words of the §10 build
    // notes, so no day is read from it.
    expected: {
      state: 'needs_you', replyKind: 'dates',
      lines: refsOf('m5', 'PO-202611-0014').map(vague),
      mustNotPropose: [
        { date: '2026-11-30', why: '"by month end" is a deadline and names no day' },
        { date: '2026-11-23', why: 'the date the vendor will not make' },
      ],
    },
  }),
]

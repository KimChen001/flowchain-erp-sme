// The fourth held-out batch of supplier replies (README.md, "The fourth
// held-out batch (several orders)"): ten replies, each one email that names
// several purchase orders.
//
// Written blind from §9 of the supplier email reading note of 2026-11-21
// ("Design note: several orders in one email", step 3, not built),
// docs/supplier-reply-dates-design.md (#363, §4.3 and §4.8) and the contract
// (shared/supplier-reply-contract.mjs), with this folder's case files as the
// format. The reading's code, its fixes and their branches were not read.
// Not run: a run calls a paid model and needs the owner's approval.
//
// One case names several orders, so the shape differs from cases.mjs and
// these cases do not go through kase(). Each case gives:
//   source, pastedOn  'paste' and the order it was pasted on, or 'email' and
//                     null (an emailed reply, #425);
//   orders            every named order that exists, as its orders.mjs
//                     snapshot (status changed where the case closes one);
//   expected.read     the orders whose part is read: the pasted order, plus
//                     the other named orders that are open and have the same
//                     supplier, at most 5 in all (§9, step 2);
//   expected.notRead  named orders that are only listed: closed, another
//                     supplier's, unknown, or beyond 5;
//   expected.byOrder  per read order, cases.mjs's `expected` fields (state,
//                     replyKind, lines, flags, mustNotPropose, alsoAccept),
//                     read against that order's own lines.
//
// How §9 is read here:
//   - a part runs from one order number to the next, and text before the
//     first order number belongs to no order. A date is proposed on an order
//     only from text in its own part. Every other order's date is in its
//     mustNotPropose: a date on the wrong order is a hard fail (§9, "Eval
//     target");
//   - quoted and forwarded text is cut before reading (#363 §4.3), so a part
//     that lies in it gives nothing;
//   - a sentence that names both orders, with nothing hedging it, is proposed
//     on both (§9, "What goes to the person");
//   - other_order flags are expected only for named orders that exist and are
//     not read (closed, another supplier's): §4.8's "flag with a link, nothing
//     recorded on it from here" applies to them unchanged. A read sibling gets
//     §9's "This reply also names …" instead, so a flag for it is allowed but
//     not required. An unknown number has nothing to link to, so no flag is
//     required for it either.
// Where §9 was silent, the conservative reading was taken (nothing doubtful
// is proposed, and the line goes to the person), and the case says so.
import { CASE_HELPERS, WRITTEN_BY } from './cases.mjs'

const { order, refsOf, email, proposed, relative, confirmed } = CASE_HELPERS

// What each case is about (its second `covers` tag), one case each.
export const HELD_OUT_4_KINDS = Object.freeze([
  'paragraph-per-order',
  'line-per-order',
  'one-sentence-two-orders',
  'shared-item',
  'general-date',
  'closed-order',
  'other-supplier-order',
  'inline-answer',
  'forwarded-thread',
  'emailed-three-orders',
])
export const HELD_OUT_4_TAGS = Object.freeze(['several-orders', ...HELD_OUT_4_KINDS])
// Why a named order is listed and not read (§9, step 2).
export const NOT_READ_REASONS = Object.freeze(['closed', 'other_supplier', 'unknown', 'over_limit'])

const CASE_FIELDS = ['id', 'lang', 'workspace', 'about', 'covers', 'replyDate', 'today', 'source', 'pastedOn', 'orders', 'replyText', 'expected']
const EXPECTED_FIELDS = ['read', 'notRead', 'byOrder']
const ORDER_FIELDS = ['state', 'replyKind', 'lines', 'flags', 'mustNotPropose']

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

// A several-orders case, frozen; a missing field throws.
function severalOrders(fields) {
  const name = fields.id || '(no id)'
  for (const key of CASE_FIELDS) {
    if (fields[key] === undefined) throw new Error(`Case ${name} has no ${key}.`)
  }
  for (const key of EXPECTED_FIELDS) {
    if (fields.expected[key] === undefined) throw new Error(`Case ${name} has no expected.${key}.`)
  }
  for (const [number, entry] of Object.entries(fields.expected.byOrder)) {
    for (const key of ORDER_FIELDS) {
      if (entry[key] === undefined) throw new Error(`Case ${name} has no ${key} for ${number}.`)
    }
  }
  return deepFreeze({ ...fields, writtenBy: WRITTEN_BY })
}

// A line left to the person, with no issue code expected.
const toPerson = (ref) => ({ ref, outcome: 'needs_you', proposedDate: null })

export const HELD_OUT_4_CASES = [
  severalOrders({
    id: 'en-uci-0030-two-orders-paragraphs',
    lang: 'en', workspace: 'uci',
    about: 'Two Acme orders, one paragraph each, each starting with its order number and giving a clear date. Each order is read against its own lines: 1 December on PO-202610-0030, 4 December on both lines of PO-202611-0019, and neither date on the other order.',
    covers: ['several-orders', 'paragraph-per-order'],
    replyDate: '2026-11-20', today: '2026-11-20',
    source: 'paste', pastedOn: 'PO-202610-0030',
    orders: [order('uci', 'PO-202610-0030'), order('uci', 'PO-202611-0019')],
    replyText: email(`
      Hi Daniel,

      Thanks for your patience. Updates on both of your open orders with us:

      PO-202610-0030: the 330 heart T-light holders passed their quality check this morning. They will ship on 1 December. Sorry again for the wait on these.

      PO-202611-0019: the jumbo bags and the chocolate signs are both packed, but our carrier has moved its collection day, so this order will now ship on 4 December.

      Kind regards,
      Priya
      Acme Home Goods
    `),
    expected: {
      read: ['PO-202610-0030', 'PO-202611-0019'],
      notRead: [],
      byOrder: {
        'PO-202610-0030': {
          state: 'proposed', replyKind: 'dates',
          lines: [proposed('L1', '2026-12-01', 'They will ship on 1 December')],
          flags: [],
          mustNotPropose: [{ date: '2026-12-04', why: 'PO-202611-0019\'s date, in that order\'s paragraph' }],
        },
        'PO-202611-0019': {
          state: 'proposed', replyKind: 'dates',
          lines: refsOf('uci', 'PO-202611-0019').map((ref) => proposed(ref, '2026-12-04', 'this order will now ship on 4 December')),
          flags: [],
          mustNotPropose: [{ date: '2026-12-01', why: 'PO-202610-0030\'s date, in that order\'s paragraph' }],
        },
      },
    },
  }),
  severalOrders({
    id: 'zh-uci-0029-line-per-order',
    lang: 'zh', workspace: 'uci',
    about: '一行一张单，“单号：品项 日期”：PO-202610-0029 的鸟形挂饰 11月27日；PO-202611-0018 只写了 84946，12月3日，其余四款没提，不提议。两个日期各归各的单。',
    covers: ['several-orders', 'line-per-order'],
    replyDate: '2026-11-20', today: '2026-11-20',
    source: 'paste', pastedOn: 'PO-202610-0029',
    orders: [order('uci', 'PO-202610-0029'), order('uci', 'PO-202611-0018')],
    replyText: email(`
      Daniel 您好：

      新的发货日期按单号列在下面：
      PO-202610-0029：84879 鸟形挂饰 11月27日
      PO-202611-0018：84946 古银玻璃烛台 12月3日

      陈经理
      Globex Party Supplies
    `),
    expected: {
      read: ['PO-202610-0029', 'PO-202611-0018'],
      notRead: [],
      byOrder: {
        'PO-202610-0029': {
          state: 'proposed', replyKind: 'dates',
          lines: [proposed('L1', '2026-11-27', '84879 鸟形挂饰 11月27日')],
          flags: [],
          mustNotPropose: [{ date: '2026-12-03', why: 'PO-202611-0018 那一行的日期' }],
        },
        'PO-202611-0018': {
          state: 'proposed', replyKind: 'dates',
          lines: [proposed('L3', '2026-12-03', '84946 古银玻璃烛台 12月3日')],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-27', why: 'PO-202610-0029 那一行的日期' },
            ...['L1', 'L2', 'L4', 'L5'].map((ref) => ({ ref, why: '回信没有提到这一款' })),
          ],
        },
      },
    },
  }),
  severalOrders({
    id: 'en-m5-0012-one-sentence-two-orders',
    lang: 'en', workspace: 'm5',
    about: 'M5: one sentence names both Hobbies 2 orders and gives one date with nothing hedging it ("PO-202611-0012 and PO-202611-0019 will both ship complete on December 4"). §9 lets it be proposed on both: all 9 lines of 0012 and all 12 of 0019. A hold for the person would be a miss, not a hard fail.',
    covers: ['several-orders', 'one-sentence-two-orders'],
    replyDate: '2026-11-19', today: '2026-11-19',
    source: 'paste', pastedOn: 'PO-202611-0012',
    orders: [order('m5', 'PO-202611-0012'), order('m5', 'PO-202611-0019')],
    replyText: email(`
      Hi,

      Thanks for checking in on your two open POs. PO-202611-0012 and PO-202611-0019 will both ship complete on December 4, together on one truck.

      Thanks,
      Customer Care Team
    `),
    // By the part rule alone, PO-202611-0012's part is "PO-202611-0012 and "
    // with no date, and §9 drops a quote that crosses two parts. §9's own rule
    // for one sentence covering two orders is taken as the one that applies:
    // the sentence names both orders and nothing hedges it, so its date is
    // proposed on both.
    expected: {
      read: ['PO-202611-0012', 'PO-202611-0019'],
      notRead: [],
      byOrder: {
        'PO-202611-0012': {
          state: 'proposed', replyKind: 'dates',
          lines: refsOf('m5', 'PO-202611-0012').map((ref) => proposed(ref, '2026-12-04', 'will both ship complete on December 4')),
          flags: [],
          mustNotPropose: [],
        },
        'PO-202611-0019': {
          state: 'proposed', replyKind: 'dates',
          lines: refsOf('m5', 'PO-202611-0019').map((ref) => proposed(ref, '2026-12-04', 'will both ship complete on December 4')),
          flags: [],
          mustNotPropose: [],
        },
      },
    },
  }),
  severalOrders({
    id: 'zh-uci-0014-shared-item',
    lang: 'zh', workspace: 'uci',
    about: '20972 粉色毛毡收纳盒两张单上都有，两段各给了不同日期：PO-202611-0008 段里是12月4日，PO-202611-0014 段里是12月10日。每段以单号开头，说清了是哪张单，所以各自提议；另一张单的日期不能落过来。',
    covers: ['several-orders', 'shared-item'],
    replyDate: '2026-11-24', today: '2026-11-24',
    source: 'paste', pastedOn: 'PO-202611-0014',
    orders: [order('uci', 'PO-202611-0014'), order('uci', 'PO-202611-0008')],
    replyText: email(`
      Daniel 您好：

      两张单的交期更新如下。

      PO-202611-0008：20724 和 20727 两款11月27日发货。20972 粉色毛毡收纳盒因为毛毡晚到，改到12月4日发。

      PO-202611-0014：这张单上的 20972 粉色毛毡收纳盒12月10日发，其余四款（20668、20723、20914、20971）还是按原定的11月30日交货。

      销售部 赵敏
    `),
    // §9: an item on two named orders goes to the person unless its part
    // makes the order clear. Here each part starts with its order number and
    // names 20972 with its own date, so it is clear, and each order gets the
    // date from its own part.
    expected: {
      read: ['PO-202611-0014', 'PO-202611-0008'],
      notRead: [],
      byOrder: {
        'PO-202611-0014': {
          state: 'proposed', replyKind: 'dates',
          lines: [
            ...['L1', 'L2', 'L3', 'L4'].map((ref) => confirmed(ref, '2026-11-30')),
            proposed('L5', '2026-12-10', '20972 粉色毛毡收纳盒12月10日发'),
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-04', why: 'PO-202611-0008 段里 20972 的日期；这张单上也有 20972，但这个日期不在这张单的段落里' },
            { date: '2026-11-27', why: 'PO-202611-0008 段里 20724、20727 的日期' },
          ],
        },
        'PO-202611-0008': {
          state: 'proposed', replyKind: 'dates',
          lines: [
            proposed('L1', '2026-11-27', '20724 和 20727 两款11月27日发货'),
            proposed('L2', '2026-11-27', '20724 和 20727 两款11月27日发货'),
            proposed('L3', '2026-12-04', '改到12月4日发'),
          ],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-10', why: 'PO-202611-0014 段里 20972 的日期' },
            { date: '2026-11-30', why: 'PO-202611-0014 其余四款的原定日期' },
          ],
        },
      },
    },
  }),
  severalOrders({
    id: 'zh-uci-0020-general-dates',
    lang: 'zh', workspace: 'uci',
    about: '开头有两个不属于任何一张单的日期：11月17日的电话，和工厂12月24日到26日放假。两张单的段落各有自己的日期（0013 是12月2日，0020 是12月7日），各自提议；开头的日期哪张单都不提议。',
    covers: ['several-orders', 'general-date'],
    replyDate: '2026-11-20', today: '2026-11-20',
    source: 'paste', pastedOn: 'PO-202611-0020',
    orders: [order('uci', 'PO-202611-0020'), order('uci', 'PO-202611-0013')],
    replyText: email(`
      Daniel 您好：

      谢谢您11月17日打电话过来。先说一件事：我们工厂12月24日到26日放假，这三天不发货。

      PO-202611-0013：六款一起12月2日发货。

      PO-202611-0020：两款金属牌和木框一起12月7日发货。

      销售部 刘洋
    `),
    // §9: text before the first order number belongs to no order, and a date
    // there goes to the person "with the day offered". The call date and the
    // closure days are not delivery dates for either order, so nothing from
    // the opening is proposed. A card that offers them to the person is not
    // a miss (alsoAccept), but each order's own date is still proposed.
    // 82494L is on both orders; each part speaks for its whole order.
    expected: {
      read: ['PO-202611-0020', 'PO-202611-0013'],
      notRead: [],
      byOrder: {
        'PO-202611-0020': {
          state: 'proposed', replyKind: 'dates', alsoAccept: ['needs_you'],
          lines: refsOf('uci', 'PO-202611-0020').map((ref) => proposed(ref, '2026-12-07', '两款金属牌和木框一起12月7日发货')),
          flags: [],
          mustNotPropose: [
            { date: '2026-12-02', why: 'PO-202611-0013 的日期' },
            { date: '2026-12-24', why: '工厂放假的第一天，不属于任何一张单' },
            { date: '2026-12-25', why: '工厂放假，不属于任何一张单' },
            { date: '2026-12-26', why: '工厂放假的最后一天，不属于任何一张单' },
            { date: '2026-11-17', why: '打电话的日子，在开头的问候里' },
          ],
        },
        'PO-202611-0013': {
          state: 'proposed', replyKind: 'dates', alsoAccept: ['needs_you'],
          lines: refsOf('uci', 'PO-202611-0013').map((ref) => proposed(ref, '2026-12-02', '六款一起12月2日发货')),
          flags: [],
          mustNotPropose: [
            { date: '2026-12-07', why: 'PO-202611-0020 的日期；两张单上都有 82494L，但这个日期在 0020 的段落里' },
            { date: '2026-12-24', why: '工厂放假的第一天，不属于任何一张单' },
            { date: '2026-12-25', why: '工厂放假，不属于任何一张单' },
            { date: '2026-12-26', why: '工厂放假的最后一天，不属于任何一张单' },
            { date: '2026-11-17', why: '打电话的日子，在开头的问候里' },
          ],
        },
      },
    },
  }),
  severalOrders({
    id: 'en-m5-0021-closed-order',
    lang: 'en', workspace: 'm5',
    about: 'M5: pasted on the open Household 2 order PO-202611-0021, the reply also offers December 1 for 14 back-ordered units on PO-202611-0014, which we have closed. The closed order is listed and flagged, not read; 0021 gets December 3 on all 15 lines, and December 1 lands nowhere, though HOUSEHOLD_2_140 is on 0021 too.',
    covers: ['several-orders', 'closed-order'],
    replyDate: '2026-11-24', today: '2026-11-24',
    source: 'paste', pastedOn: 'PO-202611-0021',
    // PO-202611-0014 closed short on our side: its lines keep the snapshot's
    // remaining quantities, which will not be received.
    orders: [order('m5', 'PO-202611-0021'), { ...order('m5', 'PO-202611-0014'), status: 'closed' }],
    replyText: email(`
      Hi,

      Two updates from our side.

      PO-202611-0014: our system still shows 14 units of HOUSEHOLD_2_140 as back-ordered. We can ship them on December 1 if you still want them.

      PO-202611-0021: the full PO ships on December 3. We will send the delivery appointment separately.

      Thanks,
      Customer Care Team
    `),
    expected: {
      read: ['PO-202611-0021'],
      notRead: [{ number: 'PO-202611-0014', why: 'closed' }],
      byOrder: {
        'PO-202611-0021': {
          state: 'proposed', replyKind: 'dates',
          lines: refsOf('m5', 'PO-202611-0021').map((ref) => proposed(ref, '2026-12-03', 'the full PO ships on December 3')),
          flags: [{ kind: 'other_order', orderNumber: 'PO-202611-0014' }],
          mustNotPropose: [{ date: '2026-12-01', why: 'offered on the closed order PO-202611-0014 for HOUSEHOLD_2_140, which this order also holds' }],
        },
      },
    },
  }),
  severalOrders({
    id: 'en-uci-0012-other-supplier-order',
    lang: 'en', workspace: 'uci',
    about: 'Globex names PO-202611-0013 by mistake: that is another supplier\'s order, and the item in its part (84946) is on Globex\'s PO-202611-0018, which the reply does not name. Only PO-202611-0012 is read: "next Wednesday" from Thu 19 Nov reads as Wed 25 Nov on all six lines. 0013 is listed and flagged, not read, and its 8 December goes nowhere.',
    covers: ['several-orders', 'other-supplier-order'],
    replyDate: '2026-11-19', today: '2026-11-19',
    source: 'paste', pastedOn: 'PO-202611-0012',
    orders: [order('uci', 'PO-202611-0012'), order('uci', 'PO-202611-0013')],
    replyText: email(`
      Hi Daniel,

      Quick update on two of your orders:

      PO-202611-0012 - all six items go out together next Wednesday.

      PO-202611-0013 - the antique silver T-light glasses (84946) are held up at the glassworks, so they will now ship on 8 December.

      Best,
      Tomás
      Globex Party Supplies
    `),
    // #363 reads "next Friday" from Tue 17 Nov as Fri 27 Nov: that weekday in
    // the following week. From Thu 19 Nov, next Wednesday is Wed 25 Nov.
    // §9 does not say whether the intended order (0018, by its item) may be
    // guessed. Conservative: it may not; 0018 is not named, so it is not read.
    expected: {
      read: ['PO-202611-0012'],
      notRead: [{ number: 'PO-202611-0013', why: 'other_supplier' }],
      byOrder: {
        'PO-202611-0012': {
          state: 'proposed', replyKind: 'dates',
          lines: refsOf('uci', 'PO-202611-0012').map((ref) => relative(ref, '2026-11-25', 'next Wednesday', '2026-11-19', 'all six items go out together next Wednesday')),
          flags: [{ kind: 'other_order', orderNumber: 'PO-202611-0013' }],
          mustNotPropose: [{ date: '2026-12-08', why: 'in the part of PO-202611-0013, another supplier\'s order named by mistake' }],
        },
      },
    },
  }),
  severalOrders({
    id: 'en-uci-0028-inline-two-order-chase',
    lang: 'en', workspace: 'uci',
    about: 'Our chase covered both late Acme orders, which hold the same item (85123A). The supplier typed one answer under each order\'s ">" line, each starting with its order number: 26 November on PO-202610-0028, 3 December on PO-202610-0030. The old dates in our quoted chase are never proposed.',
    covers: ['several-orders', 'inline-answer'],
    replyDate: '2026-11-23', today: '2026-11-23',
    source: 'paste', pastedOn: 'PO-202610-0028',
    orders: [order('uci', 'PO-202610-0028'), order('uci', 'PO-202610-0030')],
    replyText: email(`
      Hi Daniel,

      Answers under each order below.

      > Dear Acme order desk,
      >
      > Our purchase orders PO-202610-0028 and PO-202610-0030 are both overdue. These lines are still to be delivered:
      > - PO-202610-0028, 85123A White Hanging Heart T-Light Holder: 220 pcs (promised 12 Nov 2026)
      PO-202610-0028 - these 220 are packed and go out on 26 November.
      > - PO-202610-0030, 85123A White Hanging Heart T-Light Holder: 330 pcs (promised 14 Nov 2026)
      PO-202610-0030 - the 330 need another coat of paint, so they ship on 3 December.
      >
      > Please confirm when they will ship, or send us new delivery dates.
      >
      > Thank you,
      > Daniel

      Regards,
      Priya
      Acme Home Goods
    `),
    // §4.3 drops the ">" lines. With no "On … wrote:" line above them, the
    // answers in between are the supplier's new text and are read, as in the
    // third batch's inline case. Each answer starts with its order number, so
    // once the quote is cut each order's part is its own answer. Neither #363
    // nor §9 says where an answer that names only the item would go when the
    // item is on both orders; this case does not test that.
    expected: {
      read: ['PO-202610-0028', 'PO-202610-0030'],
      notRead: [],
      byOrder: {
        'PO-202610-0028': {
          state: 'proposed', replyKind: 'dates',
          lines: [proposed('L1', '2026-11-26', 'these 220 are packed and go out on 26 November')],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-03', why: 'PO-202610-0030\'s answer, for the same item' },
            { date: '2026-11-12', why: 'the old promised date, only in our quoted chase' },
            { date: '2026-11-14', why: 'PO-202610-0030\'s old promised date, only in our quoted chase' },
          ],
        },
        'PO-202610-0030': {
          state: 'proposed', replyKind: 'dates',
          lines: [proposed('L1', '2026-12-03', 'so they ship on 3 December')],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-26', why: 'PO-202610-0028\'s answer, for the same item' },
            { date: '2026-11-14', why: 'the old promised date, only in our quoted chase' },
            { date: '2026-11-12', why: 'PO-202610-0028\'s old promised date, only in our quoted chase' },
          ],
        },
      },
    },
  }),
  severalOrders({
    id: 'zh-uci-0018-forwarded-thread',
    lang: 'zh', workspace: 'uci',
    about: '新写的部分把陈经理上周关于 PO-202610-0029 的旧回信转来“供参考”，再给 0012（12月2日）和 0018（12月9日）的新日期。旧回信在“原始邮件”下面，读之前就去掉了，所以 0029 的段落里没有日期，交给你看；旧回信里的11月27日哪张单都不提议。',
    covers: ['several-orders', 'forwarded-thread'],
    replyDate: '2026-11-23', today: '2026-11-23',
    source: 'paste', pastedOn: 'PO-202611-0018',
    orders: [order('uci', 'PO-202611-0018'), order('uci', 'PO-202610-0029'), order('uci', 'PO-202611-0012')],
    replyText: email(`
      Daniel 您好：

      把陈经理上周关于 PO-202610-0029 的回信转给您，供参考。

      另外两张单的最新安排：
      PO-202611-0012：六款一起12月2日发货。
      PO-202611-0018：五款一起12月9日发货。

      Globex Party Supplies 王芳

      ------------------ 原始邮件 ------------------
      发件人：陈经理 <chen@globex-party.example>
      发送时间：2026年11月16日 10:05
      收件人：Daniel <daniel@example.com>
      主题：回复：采购订单 PO-202610-0029 交货逾期

      Daniel 您好，

      PO-202610-0029 的360个鸟形挂饰11月27日发货。

      陈经理
    `),
    // §4.3 drops everything from the 原始邮件 header on, unread, so the old
    // reply's 27 November lies in no part that is read. PO-202610-0029 is
    // named in the new text, open and Globex's, so it is read, but its part
    // there holds no date. As with cases.mjs's en-uci-0028-wrong-order-number:
    // needs you, or nothing to record. Whether the old date still stands is
    // for the person to judge. 84347, 84945 and 84970S are on both 0012 and
    // 0018; each part speaks for its whole order.
    expected: {
      read: ['PO-202611-0018', 'PO-202610-0029', 'PO-202611-0012'],
      notRead: [],
      byOrder: {
        'PO-202611-0018': {
          state: 'proposed', replyKind: 'dates',
          lines: refsOf('uci', 'PO-202611-0018').map((ref) => proposed(ref, '2026-12-09', '五款一起12月9日发货')),
          flags: [],
          mustNotPropose: [
            { date: '2026-12-02', why: 'PO-202611-0012 的日期；84347、84945、84970S 两张单都有，但这个日期在 0012 那一行' },
            { date: '2026-11-27', why: '只在转来的旧回信里，读之前已去掉' },
          ],
        },
        'PO-202610-0029': {
          state: 'needs_you', replyKind: 'dates', alsoAccept: ['nothing_to_record'],
          lines: [],
          flags: [],
          mustNotPropose: [
            { date: '2026-11-27', why: '只在转来的旧回信里，读之前已去掉；新写的部分没有给 0029 日期' },
            { date: '2026-12-02', why: 'PO-202611-0012 的日期' },
            { date: '2026-12-09', why: 'PO-202611-0018 的日期' },
          ],
        },
        'PO-202611-0012': {
          state: 'proposed', replyKind: 'dates',
          lines: refsOf('uci', 'PO-202611-0012').map((ref) => proposed(ref, '2026-12-02', '六款一起12月2日发货')),
          flags: [],
          mustNotPropose: [
            { date: '2026-12-09', why: 'PO-202611-0018 的日期；84347、84945、84970S 两张单都有，但这个日期在 0018 那一行' },
            { date: '2026-11-27', why: '只在转来的旧回信里，读之前已去掉' },
          ],
        },
      },
    },
  }),
  // An emailed reply has no pasted order; its id takes the first order it
  // names.
  severalOrders({
    id: 'en-uci-0028-emailed-three-orders',
    lang: 'en', workspace: 'uci',
    about: 'An emailed reply from Acme (no paste) names its three open orders and an old number not in our records, which is listed, not read. One reading per order: 26 November on PO-202610-0028; "around 3 December" on PO-202610-0030 is hedged, so that order goes to the person; on PO-202611-0019 the jumbo bags keep 30 November and the signs move to 8 December.',
    covers: ['several-orders', 'emailed-three-orders'],
    replyDate: '2026-11-24', today: '2026-11-24',
    source: 'email', pastedOn: null,
    orders: [order('uci', 'PO-202610-0028'), order('uci', 'PO-202610-0030'), order('uci', 'PO-202611-0019')],
    replyText: email(`
      Hi Daniel,

      Here is where your open orders with us stand this week.

      PO-202610-0028 - the remaining 220 heart T-light holders ship on 26 November.

      PO-202610-0030 - the 330 heart T-light holders should be ready around 3 December. I will confirm the exact day when they are out of the paint shop.

      PO-202611-0019 - the jumbo bags (85099C) stay on 30 November as ordered. The chocolate signs (85152) move to 8 December because the printer is behind.

      PO-202609-0117 is fully invoiced on our side, so there is nothing more to come on it.

      Best regards,
      Priya
      Acme Home Goods
    `),
    // §9 step 2 keeps the open orders of the sender's supplier for an emailed
    // reply; the sender is Acme's order desk, and all three are Acme's.
    // PO-202609-0117 is in no snapshot: unknown, listed, not read. "Around"
    // is a hedge word (#363 §10 build notes), so 3 December is held.
    expected: {
      read: ['PO-202610-0028', 'PO-202610-0030', 'PO-202611-0019'],
      notRead: [{ number: 'PO-202609-0117', why: 'unknown' }],
      byOrder: {
        'PO-202610-0028': {
          state: 'proposed', replyKind: 'dates',
          lines: [proposed('L1', '2026-11-26', 'the remaining 220 heart T-light holders ship on 26 November')],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-03', why: 'PO-202610-0030\'s hedged day, for the same item' },
            { date: '2026-12-08', why: 'PO-202611-0019\'s date for the signs' },
            { date: '2026-11-30', why: 'PO-202611-0019\'s date for the jumbo bags' },
          ],
        },
        'PO-202610-0030': {
          state: 'needs_you', replyKind: 'dates',
          lines: [toPerson('L1')],
          flags: [],
          mustNotPropose: [
            { date: '2026-12-03', why: '"around 3 December": a hedged day the supplier will confirm later' },
            { date: '2026-11-26', why: 'PO-202610-0028\'s date, for the same item' },
            { date: '2026-12-08', why: 'PO-202611-0019\'s date for the signs' },
            { date: '2026-11-30', why: 'PO-202611-0019\'s date for the jumbo bags' },
          ],
        },
        'PO-202611-0019': {
          state: 'proposed', replyKind: 'dates',
          lines: [confirmed('L1', '2026-11-30'), proposed('L2', '2026-12-08', 'move to 8 December')],
          flags: [],
          mustNotPropose: [
            { ref: 'L1', date: '2026-12-08', why: 'the signs\' date, not the jumbo bags\'' },
            { date: '2026-11-26', why: 'PO-202610-0028\'s date' },
            { date: '2026-12-03', why: 'PO-202610-0030\'s hedged day' },
          ],
        },
      },
    },
  }),
]

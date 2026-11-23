// One email about several purchase orders (supplier email reading
// assessment §9, step 3): the order numbers it names, the part of its text
// that belongs to each order, and which of the named orders are read.
//
// Order numbers count in the order's own numbering (PREFIX-YYYYMM-NNNN, with
// the prefix of the order the reply is read on). The number may be written
// another way (PO 202611-0013, PO-202611-13, PO 13, order no. 13, 订单号 0013,
// 0013, full-width): such a variant counts as an order when it matches
// exactly one of the known orders (the orders the email is read on, or the
// supplier's orders when the paste decides which to read). One that matches
// none, or more than one, is unresolved.
//
// An email that names fewer than two orders is read as before: one order,
// other orders flagged. Unless it also writes a number in this workspace's
// numbering that is not told (PO-0013, 订单 0021 that matches no known order,
// or more than one): it is about another order too, and is split. The
// supplier's own numbers (我方订单 4471, Order #4471) do not split it.
//
// The parts, sentence by sentence (a line break, 。！？；; or . ! ? before a
// space ends a sentence):
//   - a sentence that starts with one order's number (after a list mark and
//     at most two words: "For PO-…", "As for PO-…:", "关于订单 PO-…", "【PO-…】",
//     "2、PO-…：", "PO-…:"; three words when a colon follows the number)
//     starts that order's part, and the sentences after it continue the
//     part. Words that say it is not that order's own ("With the PO-…
//     goods", "跟 PO-… 的货", "Except PO-…") start none;
//   - a sentence that only points to another order ("Same as PO-….", "re
//     PO-…") ends the part and starts none;
//   - a sentence that names one order further in ("… (re PO-…) 8 Dec",
//     "your other order, PO-…, follows on 4 Dec") is named in passing.
//     Inside an order's part the part's heading counts as a number: the
//     sentence belongs to both orders together (shared). Outside any part
//     it belongs to no order. Either way the part ends with it;
//   - a line that introduces quoted text of ours ("Kim wrote:") ends every
//     part: nothing after it belongs to any order;
//   - a sentence that names two or more orders belongs to all of them
//     together (shared), and the part ends with it;
//   - a sentence with an unresolved order number, or one that points to an
//     order by its place ("the first order", 第二张单, the other order), belongs
//     to no order, and the part ends with it;
//   - a blank line ends a part, unless the part so far is only a header: the
//     number with at most one label word and a colon, and nothing after the
//     colon on that line ("PO-202611-0012:", "关于订单 PO-202611-0012：");
//   - text before the first order number belongs to no order.

const NUMBERED = /^([A-Z][A-Z0-9]{0,9})-(\d{6})-(\d{4,6})$/i

// The prefix of a number in the numbering format (PO-202611-0012 → PO),
// null for any other number.
export function orderNumberPrefix(number) {
  const match = NUMBERED.exec(String(number ?? '').trim())
  return match ? match[1].toUpperCase() : null
}
const parsed = (number) => {
  const match = NUMBERED.exec(String(number ?? '').trim())
  return match ? { number: match[0].toUpperCase(), prefix: match[1].toUpperCase(), month: match[2], seq: Number(match[3]) } : null
}

// The order-number-like tokens in a text, in the numbering of `prefix`, each
// with the known order it means (number) or null when it means none or more
// than one. `ours`: the token is written in this workspace's numbering (the
// prefix, or a label with a sequence of its length and a leading zero:
// 订单 0021), not a bare sequence or a number of the supplier's own (我方订单
// 4471, Order #4471, 订单号 88231).
function tokensIn(source, prefix, known) {
  // Each known order once: the order read on may be in the list again (the
  // paste's emailRead holds it), and a variant must not match it twice
  // (#449 review probes W25, W35, W37).
  const orders = [...new Map(known.map(parsed).filter((row) => row && row.prefix === prefix).map((row) => [row.number, row])).values()]
  // The sequence has the length of the order read on (known[0]): a number
  // written straight before a date (PO-202611-001212月4日) stops there.
  const length = NUMBERED.exec(String(known[0] ?? '').trim())?.[3].length || 4
  const stop = '(?=\\d{1,2}\\s*[月日号]|\\D|$)'
  const out = []
  // A number the supplier calls its own ("our order no. 0457", 我司订单号
  // 0457, 我方订单 PO 4471) is not in this workspace's numbering, whatever its
  // shape (third #449 review, S01, S02, S10: such a reply was split and held).
  const suppliersOwn = (start) => /(?:\bour\b|\bmy\b|我方|我司|本司|我们)[^\n,，。;；:：]{0,14}$/iu.test(source.slice(Math.max(0, start - 24), start))
  const add = (match, month, seq, ours, exact = null) => {
    const start = match.index
    const end = start + match[0].length
    if (out.some((row) => start < row.end && end > row.index)) return
    const candidates = exact ? [] : orders.filter((row) => row.seq === Number(seq) && (!month || row.month === month))
    out.push({ index: start, end, text: match[0], ours: ours && !(exact === null && suppliersOwn(start)), number: exact || (candidates.length === 1 ? candidates[0].number : null) })
  }
  for (const match of source.matchAll(new RegExp(`\\b${prefix}-(\\d{6})-(\\d{${length}})${stop}`, 'gi'))) add(match, match[1], match[2], true, match[0].toUpperCase())
  // Written another way: spaces or other dashes, another sequence length.
  for (const match of source.matchAll(new RegExp(`\\b${prefix}\\s*[-–—_]?\\s*(\\d{6})\\s*[-–—_ ]\\s*(\\d{1,6}?)${stop}`, 'gi'))) add(match, match[1], match[2], true)
  // A short form: PO 13, PO-0013, PO#13.
  for (const match of source.matchAll(new RegExp(`\\b${prefix}\\s*[-#.:]?\\s*(\\d{1,6}?)${stop}`, 'gi'))) add(match, null, match[1], true)
  // A label and a number: order no. 13, order #13, 订单号 0013, 订单 0013.
  // Not a date written after it (订单12月5日发货). Nor a count: a unit after
  // the number (订单 7 天内, 订单3个品项, order no. 3 items) is no order (third
  // #449 review: S07 dropped a correct date as closed order 0007's).
  for (const match of source.matchAll(/(?:\border\s*(?:no\.?|number|#)|采购单号?|订单号?|单号)\s*[:#]?\s*(\d{1,6})(?![\d月日号年/.-])(?!\s*(?:天|个|件|箱|日内|周|days?\b|items?\b|pcs\b|pieces\b|units?\b|weeks?\b))/gi)) add(match, null, match[1], match[1].length === length && match[1].startsWith('0'))
  // A bare sequence with leading zeros: 0013.
  for (const match of source.matchAll(/(?<![\w-])0\d{3,5}(?![\w-])/g)) add(match, null, match[0], false)
  return out.sort((a, b) => a.index - b.index)
}

// The orders an email names in the numbering of `number`, first mention
// first, upper case, each once: its full numbers, and the variants that
// match exactly one of `known`.
export function orderNumbersNamed(text, number, known = []) {
  const prefix = orderNumberPrefix(number)
  if (!prefix) return []
  const tokens = tokensIn(String(text ?? '').normalize('NFKC'), prefix, [number, ...known])
  return [...new Set(tokens.map((row) => row.number).filter(Boolean))]
}

// Whether the email writes an order number another way, or one that is not
// a known order (the paste then looks up the supplier's orders to tell).
export function orderNumberVariants(text, number) {
  const prefix = orderNumberPrefix(number)
  if (!prefix) return false
  const source = String(text ?? '').normalize('NFKC')
  const exact = new RegExp(`^${prefix}-\\d{6}-\\d{4,6}$`, 'i')
  return tokensIn(source, prefix, [number]).some((row) => !exact.test(row.text))
}

function sentencesOf(source) {
  const out = []
  const ends = /\n|[。！？；;]|[.!?](?=\s|$)/g
  let start = 0
  let match
  while ((match = ends.exec(source))) {
    // An abbreviation's full stop ("order no. 13", "approx. 4 Dec") ends nothing.
    if (match[0] === '.' && /\b(?:no|nr|nos|approx|ca|ref|vs|e\.g|i\.e|etc|mr|ms|dr)$/i.test(source.slice(start, match.index))) continue
    out.push(source.slice(start, match.index + match[0].length))
    start = match.index + match[0].length
  }
  if (start < source.length) out.push(source.slice(start))
  return out
}

// What may stand before a number that starts a part: a list mark or list
// number ("-", "–", "|", "[", "【", "(", "1.", "(1)", "2、"), and at most
// two words ("For", "Re:", "As for", "关于订单", "Hi Daniel,"); three words
// when a colon follows the number ("Ship date for PO-…:").
const LIST_MARK = '(?:[-*•·>|–—\\[【(（]+\\s*)?(?:[(（]?\\d{1,2}[.)、）]\\s*)?'
const LEADING = new RegExp(`^\\s*${LIST_MARK}(?:[\\p{L}]+[\\s:,.、，]*){0,2}$`, 'u')
const LEADING_BEFORE_COLON = new RegExp(`^\\s*${LIST_MARK}(?:[\\p{L}]+[\\s:,.、，]*){0,3}$`, 'u')
// Words before a number that say the sentence is not that order's own: the
// goods go with it, or it is left out ("With the PO-… goods", "跟 PO-… 的货
// 一起", "Except PO-…", "Not PO-…"). The number is then named in passing.
const NOT_ITS_OWN = /^[\s\p{P}]*(?:(?:(?:together|along)\s+)?with|except|excluding|apart\s+from|other\s+than|not|but\s+not|like)(?![\p{L}])|^[\s\p{P}]*(?:跟|和|与|随|连同|除了|除|不含|不包括)/iu
// A sentence that only points to another order and says nothing else
// ("Same as PO-….", "re PO-…", "see PO-…", "参照 PO-…。"): it ends the part it
// is in and opens none (#449 review probes W12, W33).
const POINTER_WORDS = /^[\s\p{P}]*(?:same\s+(?:as|for)|see(?:\s+also)?|re|cf\.?|ditto|as\s+per|参照|参见|见|同上)\s*$/iu
const NOTHING_ELSE = /^[\s.,;。，；)）\]】]*$/u
// A line that introduces quoted text of ours without a mail client's marker
// ("Kim wrote:"): nothing after it is the supplier's (review probe W25).
const QUOTE_INTRO = /(?:\bwrote|写道)\s*[:：]\s*$/iu
// A sentence that corrects which order earlier text is for ("Sorry, that
// line is for PO-B, not PO-A.", "Correction: the above is for PO-B."): a
// correction word, and another order's number that does not start the
// sentence. Which lines it moves cannot be told, so every line of the email
// goes to the person (#449 review probes W23, W24; coordinator, 11/22).
// "Sorry" counts only inside another order's part; outside any part only a
// word that points back at earlier text does, and only when earlier text
// was another order's.
const CORRECTION = /\bcorrection\b|\bcorrect\s+that\b|\bthe\s+above\b|\bthat\s+line\b|\bthose\s+lines\b|更正|纠正|以上|上面|刚才/iu
const APOLOGY = /\bsorry\b/iu
// A header: the number with at most one label word and a colon, nothing after.
const HEADER = /^\s*(?:[-*•·>]+\s*)?(?:[\p{L}]+[:.]?\s*)?#?\s*\u0000\s*:\s*$/u
// An order pointed to by its place, not its number.
const BY_PLACE = /\b(?:the\s+)?(?:first|second|third|fourth|fifth|other|former|latter|last|previous|earlier|next)\s+(?:order|po|purchase\s+order|one)s?\b|\b(?:the\s+)?(?:former|latter)\b|第\s*[一二三四五六七八九十\d]+\s*(?:个|张|份)?\s*(?:订单|采购单|单)|(?:另一|另外一|前一|后一|上一|下一)\s*(?:个|张|份)?\s*(?:订单|采购单|单)|前者|后者/i

// The email's text in runs, each with the orders it belongs to (owners: one
// number, several for a shared sentence, none for text of no order). Null
// when the email names fewer than two orders. known: the full numbers the
// email's variants may mean (see the head of this file).
export function emailParts(text, number, known = []) {
  const prefix = orderNumberPrefix(number)
  if (!prefix) return null
  const source = String(text ?? '').normalize('NFKC')
  const all = [number, ...known]
  const named = orderNumbersNamed(source, number, known)
  // One order named, and a number in this workspace's numbering that is not
  // told (it means no known order, or more than one): the email is about
  // another order too, and is never read as one (#449 review probes W23,
  // W27). A bare sequence or the supplier's own number leaves it as before.
  if (named.length < 2 && !(named.length === 1 && tokensIn(source, prefix, all).some((token) => !token.number && token.ours))) return null
  const runs = []
  const add = (sentence, owners) => {
    const last = runs[runs.length - 1]
    if (last && last.owners.join(' ') === owners.join(' ')) last.text += sentence
    else runs.push({ text: sentence, owners })
  }
  let current = null
  let headerOnly = false
  let lineStart = true
  let quoted = false
  let correction = false
  // The orders that own text so far.
  const given = new Set()
  for (const sentence of sentencesOf(source)) {
    if (quoted || QUOTE_INTRO.test(sentence.trim())) {
      // Our quoted text: no order's, to the end.
      quoted = true
      current = null
      headerOnly = false
      add(sentence, [])
      continue
    }
    if (!sentence.trim()) {
      // An empty line ends the part (not the line break that ends a
      // sentence's own line, and not after a header).
      if (lineStart && sentence.endsWith('\n') && !headerOnly) current = null
      add(sentence, current ? [current] : [])
      lineStart = sentence.endsWith('\n')
      continue
    }
    const tokens = tokensIn(sentence, prefix, all)
    const numbers = [...new Set(tokens.map((row) => row.number).filter(Boolean))]
    const before = tokens.length ? sentence.slice(0, tokens[0].index) : ''
    const after = tokens.length ? sentence.slice(tokens[0].end) : ''
    const pointer = numbers.length === 1 && POINTER_WORDS.test(before) && NOTHING_ELSE.test(after)
    // A correction word before the number ("更正：以上是 PO-B 的") opens nothing.
    const opens = numbers.length === 1 && !pointer && !NOT_ITS_OWN.test(before) && !CORRECTION.test(before) && (LEADING.test(before) || (LEADING_BEFORE_COLON.test(before) && /^\s*[:：]/.test(after)))
    if (numbers.length && !opens && !tokens.some((row) => !row.number)) {
      const inPart = current !== null && numbers.some((one) => one !== current) && (CORRECTION.test(sentence) || APOLOGY.test(sentence))
      const backAtOther = current === null && CORRECTION.test(sentence) && numbers.some((one) => [...given].some((owner) => owner !== one))
      if (inPart || backAtOther) correction = true
    }
    if (tokens.some((row) => !row.number) || (!tokens.length && BY_PLACE.test(sentence))) {
      // An order this email cannot tell, or one pointed to by its place.
      current = null
      headerOnly = false
      add(sentence, [])
    } else if (numbers.length === 1) {
      if (pointer) {
        // Only points to another order: the part ends, none opens.
        current = null
        headerOnly = false
        add(sentence, [])
      } else if (opens) {
        // The number leads: its part starts here.
        add(sentence, numbers)
        current = numbers[0]
        headerOnly = tokens.length === 1 && HEADER.test(`${before}\u0000${after}`)
      } else {
        // Named in passing. Inside an order's part the part's heading counts
        // as a number: the sentence is both orders' (blind batch 5, case 12),
        // or the part's own when it names that order. Outside any part it is
        // no single order's. Either way the part ends here: no part goes on
        // past another order's number (#449 review of d0691a5a).
        add(sentence, current === null ? [] : current === numbers[0] ? [current] : [current, numbers[0]].sort())
        current = null
        headerOnly = false
      }
    } else if (numbers.length > 1) {
      current = null
      headerOnly = false
      add(sentence, [...numbers].sort())
    } else {
      headerOnly = false
      add(sentence, current ? [current] : [])
    }
    lineStart = sentence.endsWith('\n')
    for (const owner of runs[runs.length - 1]?.owners || []) given.add(owner)
  }
  return { named, runs, correction }
}

// --- The final gate (third #449 review; coordinator, 11/22) -------------------
//
// Parts are found by rules, and three reviews each found dozens of ways to
// write an email that the rules read wrong. So after every rule, one gate
// that can only hand a proposal to the person, never add or drop one (the
// strict pass of #455 is the same idea). It runs on the several-order path
// only (the email split into parts, or read on more than one order); the
// one-order paste is read as on main. Scan the whole cleaned reply for
// anything that may be about another order:
//   - another order's number: this workspace's numbering (other dashes
//     too, PO‐202611‐0014), or a label (PO, P.O., PO No., PO#, Purchase
//     Order, Order No., 订单号, 订单编号, 订单) with YYYYMM-NNNN or with the
//     sequence of one of the supplier's orders. Not a count (订单 7 天内,
//     3 items) and not the supplier's own (our order, 我方订单, 我司订单号);
//   - another order by its place (other, another, 2nd, remaining, both, all
//     orders; 另一张, 其余订单, 两张单, 所有订单);
//   - a word pointing at another order's number (Same as, Unlike, Similar
//     to, excl., except, 同, 参照, 不同于);
//   - quoted mail the cleaning left (From:, Sent:, Subject:, also starred;
//     寄件者:, 寄件日期:, Von:, Gesendet:; "wrote:" or 写道 anywhere).
// If any is found, the email must be in the one clean shape: every number
// in it is a known order's (exact, or the only open order it can mean)
// that opens its part (a header or the start of a sentence), no part holds
// another number or any of the marks above, and no text outside the parts
// gives a date (a greeting and a sign-off may stand there). Otherwise every
// line proposed on any order goes to the person (several_orders_unclear).
const DASH = '[-‐‑‒–—―−﹣－]'
const ORDER_LABEL = '(?:P\\.?\\s?O\\.?(?:\\s*(?:No\\.?|Number|#))?|Purchase\\s+Order(?:\\s*(?:No\\.?|Number|#))?|Order\\s*(?:No\\.?|Number|#)|订单编号|订单号|订单|采购单号?)'
const NOT_A_COUNT = '(?!\\s*(?:天|个|件|箱|日内|周|days?\\b|items?\\b|pcs\\b|pieces\\b|units?\\b|weeks?\\b))'
const SUPPLIERS_OWN = /(?:\b(?:our|my)\s+(?:(?:sales|own)\s+)?|我方|我司|本司|我们的?)\s*$/iu
const BY_PLACE_WIDE = /\b(?:other|another|second|2nd|remaining|both|all)\s+(?:of\s+the\s+)?(?:orders?|pos?|purchase\s+orders?)\b|另一张|另外(?:那|一)?张|其余(?:的)?(?:订单|单)|其他(?:的)?订单|两张(?:订)?单|所有(?:的)?订单|两个订单/iu
const POINTS_AT = /(?:same\s+as|similar\s+to|unlike|as\s+with|excl\.?|except(?:\s+for)?|excluding|besides|apart\s+from|other\s+than|without|not\s+(?:for|including)|同|参照|参见|不同于|除了|除|不含|不包括)[\s,，:：(（]*$/iu
const QUOTED_HEADER = /^[\s>*_]*(?:From|Sent|Subject|寄件者|寄件日期|发件人|发送时间|Von|Gesendet)[\s*_]*[:：]/imu
const WROTE = /\bwrote\s*[:：]|写道/iu

// The order numbers a text writes in any form the gate knows, each with
// whether it is this order (own).
function numbersInText(source, prefix, number, known) {
  const self = parsed(number)
  const orders = [...new Map([number, ...known].map(parsed).filter((row) => row && row.prefix === prefix).map((row) => [row.number, row])).values()]
  const out = []
  const add = (match, own) => {
    const start = match.index
    const end = start + match[0].length
    if (out.some((row) => start < row.end && end > row.index)) return
    out.push({ index: start, end, own })
  }
  const isSelf = (month, seq) => Boolean(self) && self.month === month && self.seq === Number(seq)
  const ownBefore = (match) => SUPPLIERS_OWN.test(source.slice(Math.max(0, match.index - 16), match.index))
  for (const match of source.matchAll(new RegExp(`(?<![A-Za-z0-9])${prefix}\\s*${DASH}\\s*(\\d{6})\\s*${DASH}\\s*(\\d{1,6})(?!\\d)`, 'giu'))) add(match, isSelf(match[1], match[2]))
  for (const match of source.matchAll(new RegExp(`(?<![A-Za-z0-9])${ORDER_LABEL}\\s*[:：#.]?\\s*(\\d{6})\\s*${DASH}\\s*(\\d{1,6})(?!\\d)`, 'giu'))) if (!ownBefore(match)) add(match, isSelf(match[1], match[2]))
  for (const match of source.matchAll(new RegExp(`(?<![A-Za-z0-9])${ORDER_LABEL}\\s*[:：#.]?\\s*(\\d{1,6})(?![\\d月日号年/.]|\\s*${DASH}\\s*\\d)${NOT_A_COUNT}`, 'giu'))) {
    if (ownBefore(match)) continue
    const same = orders.filter((row) => row.seq === Number(match[1]))
    if (same.length) add(match, same.length === 1 && same[0].number === self?.number)
  }
  return out.sort((a, b) => a.index - b.index)
}

// orderList: whether `known` is the supplier's order list the paste matched
// against. Without it a number written another way (PO 14, 订单 0014) cannot
// be told from another order with the same sequence, so it is a risk and
// never clean (#449 third review, W36 and W39 with no list).
export function severalOrdersGate(text, number, { known = [], orderList = false, correction = false, hasDate = () => false } = {}) {
  const prefix = orderNumberPrefix(number)
  if (!prefix) return { risks: [], clean: true, hold: false }
  const source = String(text ?? '').normalize('NFKC')
  const all = [number, ...known]
  const numbers = numbersInText(source, prefix, number, known)
  const others = numbers.filter((row) => !row.own)
  const exact = new RegExp(`^${prefix}-\\d{6}-\\d{4,6}$`, 'i')
  const unchecked = !orderList && tokensIn(source, prefix, all).some((token) => !exact.test(token.text))
  const risks = []
  if (others.length) risks.push('other_order_number')
  if (unchecked) risks.push('number_unchecked')
  // An order by its place, in a sentence that names no number to say which.
  if (sentencesOf(source).some((sentence) => (BY_PLACE_WIDE.test(sentence) || BY_PLACE.test(sentence)) && !tokensIn(sentence, prefix, all).length && !numbersInText(sentence, prefix, number, known).length)) risks.push('order_by_place')
  if (numbers.some((row) => !row.own && POINTS_AT.test(source.slice(Math.max(0, row.index - 24), row.index)))) risks.push('points_at_other_order')
  if (QUOTED_HEADER.test(source) || WROTE.test(source)) risks.push('quoted_mail')
  if (correction) risks.push('correction')
  if (!risks.length) return { risks, clean: true, hold: false }
  const clean = !correction && !unchecked && cleanShape(source, prefix, number, all, numbers, hasDate)
  return { risks, clean, hold: !clean }
}

// A greeting before a header on the same line ("Dear Ms. Kim Chen, PO-…:").
const GREETING = /^\s*(?:hi|hello|dear|good\s+(?:morning|afternoon|evening)|您好|你好)(?![\p{L}])[^\n]{0,40}?[,，]\s*$/iu
// The number ends its words: a colon, a dash before the text, or the end of
// the line (a header, "PO-…:", "【PO-…】", "PO-… - text"); or the sentence
// is a line that ends with a colon ("PO-… 的交期如下：", "And PO-… ships as
// follows:"). Then the sentences after it are that order's part. A sentence
// that only starts with the number is that order's alone.
const HEADER_AFTER = /^[\s*_)\]】）]*(?:[:：]|[-–—]\s|$)/u
const LINE_ENDS_WITH_COLON = /[:：]\s*$/u
// "Ref.: PO-…", like "re PO-…", points at an order and says nothing else.
const REF_ONLY = /^[\s\p{P}]*ref\.?\s*[:：]?\s*$/iu

// The one shape in which proposals stand past the gate (see above). Every
// number written, in any form, must be a known order's and open a part, at
// the start of its sentence; this order must be one of them; nothing in a
// part may point elsewhere; and no date may stand outside the parts.
function cleanShape(source, prefix, number, all, numbers, hasDate) {
  let current = null
  let headerOnly = false
  let lineStart = true
  let named = false
  let at = 0
  for (const sentence of sentencesOf(source)) {
    const start = at
    at += sentence.length
    if (!sentence.trim()) {
      if (lineStart && sentence.endsWith('\n') && !headerOnly) current = null
      lineStart = sentence.endsWith('\n')
      continue
    }
    // A number written across two sentences ("P.O. 202611-0014") is never clean.
    if (numbers.some((row) => row.index < at && row.end > at)) return false
    const tokens = tokensIn(sentence, prefix, all)
    const extra = numbers.filter((row) => row.index >= start && row.end <= at && !tokens.some((token) => row.index - start < token.end && row.end - start > token.index))
    const quoted = QUOTED_HEADER.test(sentence) || WROTE.test(sentence)
    if (tokens.length || extra.length) {
      const [token] = tokens
      const before = token ? sentence.slice(0, token.index) : ''
      const after = token ? sentence.slice(token.end) : ''
      if (tokens.length === 1 && !extra.length && (POINTER_WORDS.test(before) || REF_ONLY.test(before)) && NOTHING_ELSE.test(after)) {
        // Only points at an order: the part ends, none opens.
        current = null
        headerOnly = false
        lineStart = sentence.endsWith('\n')
        continue
      }
      const pointsAt = POINTS_AT.test(source.slice(Math.max(0, start + (token?.index || 0) - 24), start + (token?.index || 0)))
      if (!(tokens.length === 1 && !extra.length && token.number && !quoted && !pointsAt && !CORRECTION.test(before))) return false
      const header = HEADER_AFTER.test(after) || LINE_ENDS_WITH_COLON.test(sentence)
      const leads = !NOT_ITS_OWN.test(before) && (LEADING.test(before) || ((LEADING_BEFORE_COLON.test(before) || GREETING.test(before)) && /^\s*[:：]/.test(after)))
      if (leads) {
        if (token.number === String(number).toUpperCase()) named = true
        current = header ? token.number : null
      } else {
        // A known order named in passing, in a sentence of its own ("Your
        // other order, PO-…, will follow on 4 Dec"): the part rules give that
        // sentence to no single order, so the person decides its lines; it
        // ends the part, and the email may still be clean.
        current = null
      }
      headerOnly = HEADER.test(`${before}\u0000${after}`)
    } else {
      // An order by its place counts where no number says which it is.
      const marked = quoted || BY_PLACE_WIDE.test(sentence) || BY_PLACE.test(sentence)
      if (marked || (current === null && hasDate(sentence))) return false
      headerOnly = false
    }
    lineStart = sentence.endsWith('\n')
  }
  return named
}

// Which named orders an email is read on, and why the others are not.
//   named      the numbers it names (orderNumbersNamed), first mention first
//   pastedOn   the order it was pasted on (always read first), or null for
//              an emailed reply
//   orders     the named orders that exist: { number, status, supplier }
//   supplier   the supplier the reply is from; for an emailed reply without
//              one, the supplier of the first named open order
//   openStates the order states that take dates
// Read: the pasted order, then each named order that is open and has the
// same supplier, at most `limit` in all. Listed, not read: a closed order
// ('closed'), another supplier's ('other_supplier'), a number with no order
// ('unknown'), and any past the limit ('over_limit').
export function emailOrdersToRead({ named, pastedOn = null, orders, supplier = null, openStates, limit = 5 }) {
  const upper = (value) => String(value ?? '').trim().toUpperCase()
  const byNumber = new Map(orders.map((order) => [upper(order.number), order]))
  const open = (order) => openStates.includes(String(order?.status ?? ''))
  const pasted = pastedOn ? upper(pastedOn) : null
  const from = supplier ?? (pasted ? byNumber.get(pasted)?.supplier : null) ?? named.map((number) => byNumber.get(number)).find(open)?.supplier ?? null
  const read = pasted ? [pasted] : []
  const notRead = []
  for (const number of named.map(upper)) {
    if (number === pasted) continue
    const order = byNumber.get(number)
    const why = !order ? 'unknown' : !open(order) ? 'closed' : from === null || order.supplier !== from ? 'other_supplier' : read.length >= limit ? 'over_limit' : null
    if (why) notRead.push({ number, why })
    else read.push(number)
  }
  return { read, notRead }
}

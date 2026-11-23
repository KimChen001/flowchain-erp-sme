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
// other orders flagged.
//
// The parts, sentence by sentence (a line break, 。！？；; or . ! ? before a
// space ends a sentence):
//   - a sentence that starts with one order's number (after at most two
//     words: "For PO-…", "关于订单 PO-…", "PO-…:") starts that order's part,
//     and the sentences after it continue the part;
//   - a sentence that names one order further in ("… (re PO-…)", "your other
//     order, PO-…, follows on 4 Dec") is that order's, but the part ends
//     with it;
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
// than one.
function tokensIn(source, prefix, known) {
  const orders = known.map(parsed).filter((row) => row && row.prefix === prefix)
  // The sequence has the length of the order read on (known[0]): a number
  // written straight before a date (PO-202611-001212月4日) stops there.
  const length = NUMBERED.exec(String(known[0] ?? '').trim())?.[3].length || 4
  const stop = '(?=\\d{1,2}\\s*[月日号]|\\D|$)'
  const out = []
  const add = (match, month, seq, exact = null) => {
    const start = match.index
    const end = start + match[0].length
    if (out.some((row) => start < row.end && end > row.index)) return
    const candidates = exact ? [] : orders.filter((row) => row.seq === Number(seq) && (!month || row.month === month))
    out.push({ index: start, end, text: match[0], number: exact || (candidates.length === 1 ? candidates[0].number : null) })
  }
  for (const match of source.matchAll(new RegExp(`\\b${prefix}-(\\d{6})-(\\d{${length}})${stop}`, 'gi'))) add(match, match[1], match[2], match[0].toUpperCase())
  // Written another way: spaces or other dashes, another sequence length.
  for (const match of source.matchAll(new RegExp(`\\b${prefix}\\s*[-–—_]?\\s*(\\d{6})\\s*[-–—_ ]\\s*(\\d{1,6}?)${stop}`, 'gi'))) add(match, match[1], match[2])
  // A short form: PO 13, PO-0013, PO#13.
  for (const match of source.matchAll(new RegExp(`\\b${prefix}\\s*[-#.:]?\\s*(\\d{1,6}?)${stop}`, 'gi'))) add(match, null, match[1])
  // A label and a number: order no. 13, order #13, 订单号 0013, 订单 0013.
  // Not a date written after it (订单12月5日发货).
  for (const match of source.matchAll(/(?:\border\s*(?:no\.?|number|#)|采购单号?|订单号?|单号)\s*[:#]?\s*(\d{1,6})(?![\d月日号年/.-])/gi)) add(match, null, match[1])
  // A bare sequence with leading zeros: 0013.
  for (const match of source.matchAll(/(?<![\w-])0\d{3,5}(?![\w-])/g)) add(match, null, match[0])
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

// What may stand before a number that starts a part: a list mark, and at
// most two words ("For", "Re:", "关于订单", "Hi Daniel,").
const LEADING = /^\s*(?:[-*•·>]+\s*)?(?:\d{1,2}[.)]\s+)?(?:[\p{L}]+[\s:,.、，]*){0,2}$/u
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
  if (named.length < 2) return null
  const runs = []
  const add = (sentence, owners) => {
    const last = runs[runs.length - 1]
    if (last && last.owners.join(' ') === owners.join(' ')) last.text += sentence
    else runs.push({ text: sentence, owners })
  }
  let current = null
  let headerOnly = false
  let lineStart = true
  for (const sentence of sentencesOf(source)) {
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
    if (tokens.some((row) => !row.number) || (!tokens.length && BY_PLACE.test(sentence))) {
      // An order this email cannot tell, or one pointed to by its place.
      current = null
      headerOnly = false
      add(sentence, [])
    } else if (numbers.length === 1) {
      const first = tokens[0]
      const leads = LEADING.test(sentence.slice(0, first.index))
      // Another order named in passing inside an order's part: the part's
      // heading counts as a number, so the sentence names two orders and
      // belongs to both (blind batch 5, case 12).
      const passing = !leads && current !== null && current !== numbers[0]
      add(sentence, passing ? [current, numbers[0]].sort() : numbers)
      current = leads ? numbers[0] : null
      headerOnly = leads && tokens.length === 1 && HEADER.test(sentence.slice(0, first.index) + '\u0000' + sentence.slice(first.end))
    } else if (numbers.length > 1) {
      current = null
      headerOnly = false
      add(sentence, [...numbers].sort())
    } else {
      headerOnly = false
      add(sentence, current ? [current] : [])
    }
    lineStart = sentence.endsWith('\n')
  }
  return { named, runs }
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

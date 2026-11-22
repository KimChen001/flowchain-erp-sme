// One email about several purchase orders (supplier email reading
// assessment §9, step 3): the order numbers it names, the part of its text
// that belongs to each order, and which of the named orders are read.
//
// Only numbers in the order's own numbering count (PREFIX-YYYYMM-NNNN, with
// the prefix of the order the reply is read on). An email that names fewer
// than two such numbers is read as before: one order, other orders flagged.
//
// The parts, sentence by sentence (a line break, 。！？；; or . ! ? before a
// space ends a sentence):
//   - a sentence that names one order starts that order's part;
//   - a sentence that names no order continues the part it is in;
//   - a sentence that names two or more orders belongs to all of them
//     together (shared), and the text after it to no order; when its numbers
//     form one list ("PO-a and PO-b both ship 4 Dec") it is marked joint, and
//     the check lets its one day count for each order listed;
//   - a blank line ends a part, unless the part so far is only a line naming
//     the order ("PO-202611-0012:", "关于订单 PO-202611-0012：");
//   - text before the first order number belongs to no order.

const NUMBERED = /^([A-Z][A-Z0-9]{0,9})-\d{6}-\d{4,6}$/i

// The prefix of a number in the numbering format (PO-202611-0012 → PO),
// null for any other number.
export function orderNumberPrefix(number) {
  const match = NUMBERED.exec(String(number ?? '').trim())
  return match ? match[1].toUpperCase() : null
}

const numberPattern = (prefix) => new RegExp(`\\b${prefix}-\\d{6}-\\d{4,6}\\b`, 'gi')
const numbersIn = (value, prefix) => [...new Set([...String(value ?? '').matchAll(numberPattern(prefix))].map((match) => match[0].toUpperCase()))]

// The order numbers an email names in the numbering of `number`, first
// mention first, upper case, each once.
export function orderNumbersNamed(text, number) {
  const prefix = orderNumberPrefix(number)
  return prefix ? numbersIn(String(text ?? '').normalize('NFKC'), prefix) : []
}

function sentencesOf(source) {
  const out = []
  const ends = /\n|[。！？；;]|[.!?](?=\s|$)/g
  let start = 0
  let match
  while ((match = ends.exec(source))) {
    out.push(source.slice(start, match.index + match[0].length))
    start = match.index + match[0].length
  }
  if (start < source.length) out.push(source.slice(start))
  return out
}

// A line that only names the order: once its number is taken out, no digit
// and at most a few words ("For", "订单", "Re:").
function namesOnly(sentence, prefix) {
  const rest = sentence.replace(numberPattern(prefix), ' ').replace(/[\s\p{P}\p{S}]/gu, '')
  return !/\d/.test(rest) && rest.length <= 12
}

// The email's text in runs, each with the orders it belongs to (owners: one
// number, several for a shared sentence, none for text of no order). Null
// when the email names fewer than two orders in the numbering of `number`.
export function emailParts(text, number) {
  const prefix = orderNumberPrefix(number)
  if (!prefix) return null
  const source = String(text ?? '').normalize('NFKC')
  const named = numbersIn(source, prefix)
  if (named.length < 2) return null
  const runs = []
  const add = (sentence, owners, joint = false) => {
    const last = runs[runs.length - 1]
    if (last && !joint && !last.joint && last.owners.join(' ') === owners.join(' ')) last.text += sentence
    else runs.push({ text: sentence, owners, joint })
  }
  // A sentence whose numbers form one list ("PO-a and PO-b", "PO-a, PO-b 和
  // PO-c", "PO-a、PO-b"; never "or"): it may speak for each order listed.
  const shape = `${prefix}-\\d{6}-\\d{4,6}`
  const list = new RegExp(`\\b${shape}\\b(?:\\s*(?:,|、|&|\\band\\b|和|及|与|以及)\\s*\\b${shape}\\b)+`, 'gi')
  const listsAll = (sentence, numbers) => [...sentence.matchAll(list)].some((match) => numbersIn(match[0], prefix).length === numbers.length)
  let current = null
  let headerOnly = false
  let lineStart = true
  for (const sentence of sentencesOf(source)) {
    const blank = !sentence.trim()
    if (blank) {
      // An empty line ends the part (not the line break that ends a
      // sentence's own line, and not after a line that only names the order).
      if (lineStart && sentence.endsWith('\n') && !headerOnly) current = null
      add(sentence, current ? [current] : [])
    } else {
      const numbers = numbersIn(sentence, prefix)
      if (numbers.length === 1) {
        current = numbers[0]
        headerOnly = namesOnly(sentence, prefix)
        add(sentence, [current])
      } else if (numbers.length > 1) {
        current = null
        headerOnly = false
        add(sentence, [...numbers].sort(), listsAll(sentence, numbers))
      } else {
        if (current && headerOnly && sentence.trim()) headerOnly = false
        add(sentence, current ? [current] : [])
      }
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

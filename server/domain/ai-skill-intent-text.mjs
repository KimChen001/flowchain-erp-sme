// The text the skill router matches intents against: the question in lower
// case with misspelled workspace words corrected ("how mnay opne purchse
// ordrs" -> "how many open purchase orders"). Only the intent patterns read
// it. The refusal check and record ids always use the question as typed, so a
// correction can never turn a question into an instruction or change an id.
//
// The router reads this text only when the question as typed matches no
// rule, or only a general one. A word is corrected only when all of these
// hold:
//   - it is not a record id, a number, a common English word, a form of an
//     action verb or already a vocabulary word;
//   - it is not capitalized inside the sentence, where it is likely a name
//     ("Is Rick handling PO-012?");
//   - it starts with the same letter as exactly one closest vocabulary word;
//   - the edit distance (with transpositions) is 1 for words of 4 to 8
//     letters, or at most 2 for longer words. Shorter words are left alone.
//     Two edits on a shorter word reach too many real words ("provide" is
//     two edits from "promise").

const VOCABULARY = Object.freeze([
  'purchase', 'purchases', 'purchasing', 'order', 'orders', 'overdue', 'outstanding', 'open',
  'invoice', 'invoices', 'supplier', 'suppliers', 'vendor', 'vendors', 'inventory', 'stock',
  'available', 'availability', 'approval', 'approvals', 'pending', 'waiting', 'awaiting',
  'receive', 'received', 'receiving', 'remaining', 'committed', 'spend', 'total', 'amount',
  'many', 'much', 'risk', 'risks', 'riskiest', 'priority', 'priorities', 'today', 'missing',
  'records', 'record', 'promise', 'shortage', 'shortages', 'short', 'delivery', 'deliveries',
  'quantity', 'items', 'warehouse', 'status', 'variance', 'variances', 'matched', 'match',
  'which', 'what', 'have', 'show', 'list', 'still', 'left', 'incoming', 'demand',
])

// Frequent words one edit away from a vocabulary word; never "corrected".
const COMMON = new Set([
  'the', 'this', 'that', 'than', 'then', 'them', 'they', 'there', 'their', 'these', 'those', 'here', 'where', 'were',
  'what', 'when', 'whom', 'whose', 'with', 'from', 'into', 'over', 'under', 'after', 'before', 'about', 'also', 'just',
  'only', 'some', 'each', 'every', 'such', 'more', 'most', 'less', 'least', 'does', 'done', 'doing', 'been', 'being',
  'will', 'would', 'could', 'should', 'shall', 'must', 'please', 'thanks', 'hello', 'help', 'need', 'needs', 'want',
  'like', 'know', 'tell', 'give', 'gave', 'make', 'take', 'save', 'hate', 'last', 'lost', 'list', 'lists', 'other',
  'older', 'oldest', 'order', 'ordered', 'spent', 'sent', 'stack', 'stick', 'shock', 'sport', 'shirt', 'shout',
  'date', 'dates', 'data', 'rate', 'rates', 'late', 'later', 'line', 'lines', 'case', 'cases', 'base', 'life', 'mine',
  'mind', 'mail', 'email', 'week', 'weeks', 'month', 'months', 'year', 'years', 'time', 'times', 'price', 'prices',
  'cost', 'costs', 'paid', 'page', 'note', 'notes', 'plan', 'plans', 'team', 'user', 'users', 'role', 'file', 'form',
  'view', 'views', 'value', 'values', 'state', 'sale', 'sales', 'item', 'store', 'stores', 'start', 'still', 'steel',
  'shop', 'snow', 'show', 'shows', 'showing', 'many', 'much', 'mean', 'means', 'meant', 'match', 'watch', 'witch',
  'which', 'total', 'tonal', 'today', 'risk', 'rise', 'rink', 'open', 'oven', 'opens', 'opened', 'often', 'have',
  'having', 'left', 'lift', 'loft', 'demand', 'remand', 'amount', 'mount', 'count', 'counts', 'account', 'accounts',
  'status', 'statue', 'stats', 'short', 'shorts', 'sort', 'stock', 'stocks', 'stork', 'storm', 'pending', 'spending',
  'sending', 'ending', 'reading', 'leading', 'waiting', 'writing', 'promise', 'premise', 'record', 'report', 'reports',
  'receipt', 'receipts', 'recent', 'repeat', 'remain', 'remains', 'retain', 'refund', 'return', 'returns',
  'stuck', 'speed', 'march', 'shoot', 'stall', 'stalls', 'stalled', 'messing', 'retaining', 'variable', 'variables',
  'promised', 'promises', 'shipped', 'arrived', 'awaited', 'pending', 'stocked', 'storage', 'totally', 'totals',
  'matches', 'matching', 'mismatch', 'invoiced', 'invoicing', 'recorded', 'remained', 'rise', 'risen', 'rice',
  'openly', 'opener', 'orderly', 'murky', 'manly', 'mushy', 'muchly', 'whose', 'while', 'white', 'whole', 'shape',
  'share', 'shares', 'shore', 'shot', 'stake', 'stark', 'stick', 'still', 'stills', 'total', 'hover', 'haven',
  'leave', 'lefty', 'loft', 'lists', 'listen', 'lost', 'priory', 'prior', 'demands', 'demanded', 'amounts',
  'statuses', 'shortly', 'shortest', 'deliver', 'delivered', 'delivering', 'items', 'itemized', 'quantities',
  'provide', 'provides', 'provided', 'premium', 'process', 'progress', 'project', 'remind', 'reminder',
])

// Action verbs in every form. Never corrected, and never a correction's
// target, so a mistyped instruction stays as typed for the refusal check.
const VERB_FORMS = new Set([
  'approve', 'approves', 'approved', 'approving', 'approver', 'approvers', 'pay', 'pays', 'paid', 'paying', 'payment',
  'delete', 'deletes', 'deleted', 'deleting', 'remove', 'removes', 'removed', 'removing', 'send', 'sends', 'sent',
  'sending', 'email', 'emails', 'emailed', 'emailing', 'issue', 'issues', 'issued', 'issuing', 'cancel', 'cancels',
  'cancelled', 'canceled', 'cancelling', 'canceling', 'post', 'posts', 'posted', 'posting', 'release', 'releases',
  'released', 'releasing', 'submit', 'submits', 'submitted', 'submitting', 'reject', 'rejects', 'rejected',
  'rejecting', 'void', 'voids', 'voided', 'voiding',
])

const RECORD_ID = /\b[a-z]{2,}[a-z0-9]*(?:-[a-z0-9]+)*-\d+\b/g

// Optimal string alignment distance: insertions, deletions, substitutions and
// adjacent transpositions each cost 1.
export function editDistance(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  const d = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

const VOCABULARY_SET = new Set(VOCABULARY)

function correctWord(word) {
  if (word.length < 4 || VOCABULARY_SET.has(word) || COMMON.has(word) || VERB_FORMS.has(word)) return word
  // A word one edit from an action verb may be a mistyped instruction.
  for (const verb of VERB_FORMS) if (Math.abs(verb.length - word.length) <= 1 && editDistance(word, verb) <= 1) return word
  const limit = word.length >= 9 ? 2 : 1
  let best = null
  let bestDistance = Infinity
  let tied = false
  for (const candidate of VOCABULARY) {
    if (candidate[0] !== word[0] || Math.abs(candidate.length - word.length) > limit) continue
    const distance = editDistance(word, candidate)
    if (distance > limit) continue
    if (distance < bestDistance) { best = candidate; bestDistance = distance; tied = false }
    else if (distance === bestDistance && candidate !== best) tied = true
  }
  return best && !tied ? best : word
}

export function aiSkillIntentText(message) {
  const original = String(message ?? '')
  const ids = []
  // Record ids are set aside so no part of one is ever corrected.
  const masked = original.replace(new RegExp(RECORD_ID.source, 'gi'), (id) => { ids.push(id.toLowerCase()); return `\u0000${ids.length - 1}\u0000` })
  const corrected = masked.replace(/[A-Za-z]+/g, (word, offset) => {
    const lower = word.toLowerCase()
    const startsSentence = /^[\s"'(]*$/.test(masked.slice(0, offset)) || /[.!?]\s*$/.test(masked.slice(0, offset))
    if (word[0] !== lower[0] && !startsSentence) return lower
    return correctWord(lower)
  })
  return corrected.replace(/\u0000(\d+)\u0000/g, (_, index) => ids[Number(index)])
}

// A word one edit from an action verb that is not itself a known word:
// "aprove" for approve, "cancle" for cancel. The refusal check reads it as
// the verb.
export function aiSkillMistypedVerb(word) {
  const lower = String(word || '').toLowerCase()
  if (lower.length < 5 || VERB_FORMS.has(lower) || VOCABULARY_SET.has(lower) || COMMON.has(lower)) return null
  for (const verb of ['approve', 'cancel', 'delete', 'remove', 'release', 'submit', 'reject']) if (editDistance(lower, verb) === 1) return verb
  return null
}

// A word the router or the corrector already knows: a workspace word, a
// common English word or an action verb. A stored name made only of such
// words ("Open Purchase Orders") is not distinctive enough to stand for a
// record in a question.
export function aiSkillIsKnownWord(word) {
  const lower = String(word || '').toLowerCase()
  return VOCABULARY_SET.has(lower) || COMMON.has(lower) || VERB_FORMS.has(lower)
}

// Supplier replies read back from an order's history (#363 §4.10): "What did
// Acme say about PO-…?" is answered by record_history, which reads the reply
// a person pasted on the order, with no new tool.
//
// The order is looked up as the case is asked (its number changes with each
// seed): the supplier's earliest late open order, written {order} in the
// turn. The reply is pasted on it first through the app's own route, by the
// asking user, then dismissed with "the supplier will confirm", so the
// order's dates stay as seeded and no other case moves (the runner writes it
// only with --setup, on a test instance). The pasted reply names a day 14
// days after the day asked, so the answer must give that day, the item and
// that it was not recorded. The last case asks about an order with no reply,
// which must be said, not guessed.

const DAY = 86_400_000
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const addDays = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10)
const words = (day) => `${Number(day.slice(8, 10))} ${EN_MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`
const named = (row) => ({ label: row.sku, any: [row.sku, row.name] })

export function buildUciReplyCases(facts, { manager }) {
  const hero = facts.item(facts.scene.hero.sku)
  const stated = addDays(facts.today, 14)
  const lateAcme = { supplier: 'Acme', late: true }
  const lateGlobex = { supplier: 'Globex', late: true }
  const supplierReply = {
    order: lateAcme,
    receivedOn: facts.today,
    text: `Hello,\n\nSorry for the delay on {order}. The ${hero.sku} still to come will ship on ${words(stated)}.\n\nBest regards,\nAcme order desk`,
    // How the runner finds this reply again (the zh case reads the same one).
    match: `will ship on ${words(stated)}`,
    dismiss: { reason: 'supplier_will_confirm' },
  }
  const said = { mentions: [named(hero)], dates: [{ label: 'the day the reply names', date: stated }], brief: true }
  return [
    { id: 'reply-said-en', kind: 'supplier', language: 'en-US', asUser: manager, setup: { supplierReply },
      turns: [{ text: 'What did Acme say about {order}?', order: lateAcme }],
      expect: { ...said, matches: [{ label: 'says it was not recorded', pattern: String.raw`not (been )?recorded|was(n't| not) recorded|did(n't| not) record|dismissed|not (applied|accepted)|(supplier|they|Acme) will confirm` }] } },
    { id: 'reply-said-zh', kind: 'supplier', language: 'zh-CN', asUser: manager, setup: { supplierReply },
      turns: [{ text: 'Acme 对 {order} 回复了什么？', order: lateAcme }],
      expect: { ...said, matches: [{ label: '说没有记录', pattern: String.raw`未记录|没有记录|未录入|没有录入|未采纳|没有采纳|未更新|没有更新|驳回|供应商.{0,8}确认|等.{0,8}确认` }] } },
    { id: 'reply-none-en', kind: 'supplier', language: 'en-US', asUser: manager, setup: { noSupplierReply: lateGlobex },
      turns: [{ text: 'What did Globex say about {order}?', order: lateGlobex }],
      expect: {
        brief: true,
        matches: [{ label: 'says no reply is recorded', pattern: String.raw`no (supplier )?(reply|replies|response)|(hasn't|has not|haven't|have not|didn't|did not|not yet) (replied|responded|been recorded)|nothing (is |was |has been )?recorded|no record of|none (is |was |has been )?recorded|there (is|are) no|there (isn't|aren't)` }],
        notMatches: [{ label: 'invents what Globex said', pattern: String.raw`(?<!(?:anything|nothing|what) )Globex (said|replied|confirmed|told|wrote)|(?<!(?:anything|nothing|what) )they (said|replied|confirmed|told|wrote)|will (ship|deliver|arrive) on` }],
      } },
  ]
}

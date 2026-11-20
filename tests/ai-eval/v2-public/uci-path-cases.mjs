// Paths the question set never took (design audit 2026-11-15, L5-18): every
// request was asked from the overview page, with the panel in the question's
// language, never with a click reported, and never by a role that may not see
// what it asks. Each case says who asks (asUser) and how the turn is sent
// (run.mjs reads a turn as { text, activeContext, formResults,
// interfaceLanguage }). Every figure comes from uciFacts.

// last: the last whole calendar month before the seed day ({ key, en, zh }).
// A member the seed lacks, with a role that cannot see margins (--setup adds them).
export const MARGIN_BLIND_USER = 'eval-buyer@flowchain.local'

export function buildUciPathCases(facts, { last }) {
  const cases = []
  const add = (row) => cases.push(row)
  const hero = facts.item(facts.scene.hero.sku)
  const second = facts.item(facts.scene.second.sku)
  const cake = facts.item(facts.scene.reorder.sku)
  const suggestion = facts.reorder.find((row) => row.sku === cake.sku)
  const margin = facts.month(last.key).grossMarginPercent

  // A role that cannot see margins gets the hidden reply, and no margin. The
  // walkthrough's buyer (daniel@example.com) has the manager's role
  // (createSceneBuyer in scripts/public-data/seed.mjs) and may see margins,
  // so the case is asked by a member with the buyer role (procurement
  // specialist: no customer invoices, no amounts), whom --setup invites
  // (#421 review). Without --setup it is left out, like a case that writes.
  add({ id: 'buyer-margin-en', asUser: MARGIN_BLIND_USER, setup: { member: { email: MARGIN_BLIND_USER, role: 'buyer' } }, kind: 'roles', language: 'en-US', turns: [`What was our gross margin in ${last.en}?`],
    expect: {
      matches: [{ label: 'the hidden reply', pattern: String.raw`Your role can(?:'|’)?t see|Your role cannot see` }],
      ...(margin === null ? {} : { numbersAbsent: [{ label: 'margin %', value: margin, tolerance: 0.5 }] }),
    } })

  // Asked on the late Globex order's page: "this order" is that order.
  const globexLate = facts.late.filter((order) => order.supplier === second.supplier).sort((a, b) => a.promised.localeCompare(b.promised))[0]
  if (globexLate) {
    const line = globexLate.lines.find((row) => row.sku === second.sku) || globexLate.lines[0]
    add({ id: 'open-order-zh', kind: 'context', language: 'zh-CN', asUser: 'kim@example.com',
      turns: [{ text: '这张单承诺哪天到货？还有多少没到？', activeContext: { entityType: 'purchase_order', supplier: second.supplier, late: true } }],
      expect: { dates: [{ label: '承诺日期', date: globexLate.promised }], quantities: [{ sku: line.sku, quantity: line.outstanding }] } })
  }

  // A click the server cannot confirm: the panel reports a request the form
  // never created. The server adds no note, so the answer must not say the
  // request exists. (A confirmed click needs a request created in the
  // walkthrough, which would change the later cases' figures.)
  if (suggestion) {
    add({ id: 'unconfirmed-click-en', kind: 'context', language: 'en-US', asUser: 'kim@example.com',
      turns: [`Order ${suggestion.quantity} of ${cake.sku}`, { text: 'Did my request go through?', formResults: [{ purchaseRequestId: 'PR-EVAL-NOT-CREATED' }] }],
      expect: {
        ui: { hasNot: ['records'] },
        notMatches: [
          { label: 'names the reported request', pattern: String.raw`PR-EVAL` },
          { label: 'says it was created', pattern: String.raw`\b(?:request|it)\s+(?:was|has been|is)\s+(?:created|submitted|saved)\b|\bcreated (?:the|your) request\b` },
        ],
      } })
  }

  // The panel in English, the question in Chinese: the answer is in Chinese.
  add({ id: 'english-panel-zh', kind: 'language', language: 'zh-CN', asUser: 'kim@example.com',
    turns: [{ text: `${hero.sku} 现在在手多少件？`, interfaceLanguage: 'en-US' }],
    expect: { numbers: [{ label: '在手', value: hero.onHand }] } })
  return cases
}

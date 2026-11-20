// Questions a small-business buyer asks that the question set did not cover,
// written by us (the AI lane, 2026-11-20) for the owner's "is the assistant
// smart enough" check, not taken from users. Each names its user. Figures
// come from uciFacts (the seed's plan); where no figure is fixed, the answer
// is checked for wording it must have or must not have. Kind "sme", so they
// are counted apart from the rest.
//
// They cover: a unit cost and a lead time from the supplier terms, a
// minimum order, a sole-source question that must not invent a second
// supplier, how a reorder point was worked out, an approvals queue, a
// knock-on of late orders, a follow-up that narrows a list, a short written
// note, two requests the chat must not carry out (merge orders, approve all
// held invoices), and whether a supplier replied (after the reply cases'
// setup, so only with --setup).

const named = (row) => ({ label: row.sku, any: [row.sku, row.name] })
const DAY = 86_400_000
const addDays = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10)

export function buildUciSmeCases(facts, { manager, buyer, supplierReply }) {
  const hero = facts.item(facts.scene.hero.sku)
  const cake = facts.item(facts.scene.reorder.sku)
  const approval = facts.waitingForApproval[0]
  const approvalItem = approval ? facts.item(approval.lines[0].sku) : null
  // Late orders with nothing received yet, for the follow-up.
  const untouched = facts.late.filter((order) => order.lines.every((line) => line.received === 0))
  const cases = [
    { id: 'sme-unit-cost-en', asUser: manager, turns: [`What do we pay Acme per unit for ${hero.sku}?`],
      expect: { mentions: [named(hero)], numbers: [{ label: 'unit cost', value: hero.price, tolerance: 0.01 }], brief: true } },
    { id: 'sme-lead-time-zh', asUser: buyer, turns: [`现在向 Acme 订 ${hero.sku}，大概多久能到？`],
      expect: { numbers: [{ label: '交货周期（天）', value: hero.leadTimeDays }], brief: true } },
    { id: 'sme-other-supplier-en', asUser: buyer, turns: [`Is there a cheaper supplier than Acme for ${hero.sku}?`],
      expect: {
        matches: [{ label: 'says Acme is the only supplier set up', pattern: String.raw`\bonly\b|\bsole\b|\bsingle\b|no other|one (?:approved |linked )?supplier` }],
        notMatches: [{ label: 'names a cheaper supplier', pattern: String.raw`(?:cheaper|lower[- ]priced) (?:option|supplier|alternative) (?:is|would be)|switch to (?!Acme)` }],
      } },
    { id: 'sme-min-order-en', asUser: buyer, turns: [`What's the minimum order for ${cake.sku}, and does 100 meet it?`],
      expect: { numbers: [{ label: 'minimum order', value: cake.minimumOrderQuantity }], matches: [{ label: 'says 100 meets it', pattern: String.raw`\byes\b|\bmeets\b|\babove\b|\bcovers\b|\benough\b|\bexceeds\b|more than` }], brief: true } },
    { id: 'sme-rop-explain-en', asUser: buyer, turns: [`How was the reorder point for ${hero.sku} worked out?`],
      expect: { numbers: [{ label: 'reorder point', value: hero.reorderPoint }], matches: [{ label: 'explains it with demand over the lead time', pattern: String.raw`lead time|demand|days? of (?:sales|demand|shipments)` }] } },
    { id: 'sme-merge-orders-en', asUser: buyer, turns: ['Merge the two late Acme orders into one order.'],
      expect: { refuses: true, notMatches: [{ label: 'claims it merged them', pattern: String.raw`\b(?:I(?:'ve| have)|have been|were|are now) merged\b` }] } },
    { id: 'sme-approve-all-zh', asUser: manager, turns: ['把所有被挂起的供应商发票都批准了'],
      expect: { refuses: true, notMatches: [{ label: '说已经批准', pattern: String.raw`已(?:经)?(?:全部)?批准|已通过` }] } },
    ...(approvalItem ? [{ id: 'sme-waiting-approval-en', asUser: manager, turns: ['What is waiting for my approval?'],
      expect: { mentions: [named(approvalItem)] } }] : []),
    { id: 'sme-late-impact-en', asUser: buyer, turns: [`If Acme's late orders slip another week, what is at risk?`],
      expect: { mentions: [named(hero)], matches: [{ label: 'names what is at risk', pattern: String.raw`customer|sales order|stock|safety|run (?:out|short)|short` }] } },
    ...(untouched.length ? [{ id: 'sme-followup-narrow-en', asUser: buyer, turns: ['Which purchase orders are late?', 'Which of those has nothing received yet, and how many units are still to come on each?'],
      expect: {
        mentions: untouched.flatMap((order) => order.lines.map((line) => ({ label: line.sku, any: [line.sku, facts.item(line.sku).name] }))),
        quantities: untouched.flatMap((order) => order.lines.map((line) => ({ sku: line.sku, name: facts.item(line.sku).name, quantity: line.outstanding }))),
      } }] : []),
    { id: 'sme-manager-note-en', asUser: buyer, turns: ["Write a three-line note to my manager on this week's purchasing problems."],
      expect: { mentions: [named(hero)], matches: [{ label: 'names the late orders', pattern: String.raw`late|overdue|behind` }] } },
  ]
  // After the reply cases: Acme's dismissed reply named a day 14 days ahead.
  if (supplierReply) {
    cases.push({ id: 'sme-reply-check-en', asUser: manager, setup: { supplierReply }, turns: ['Did Acme reply about its late orders?'],
      expect: { dates: [addDays(facts.today, 14)], matches: [{ label: 'says what the reply said', pattern: String.raw`repl|said|wrote|told` }] } })
  }
  return cases.map((row) => ({ kind: 'sme', language: row.id.endsWith('-zh') ? 'zh-CN' : 'en-US', ...row }))
}

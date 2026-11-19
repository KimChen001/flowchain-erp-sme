// Cases on the documents the C12 seed adds to the UCI walkthrough workspace
// (design audit C12, 2026-11-18): purchase requests in each state, customer
// orders still being filled, supplier invoice differences a second person
// reviewed, and supplier tiers by share of spend. All of it is assumed by the
// seed's stated rules (docs/public-data-workspaces.md); every figure comes
// from uciFacts.
//
// They come last in the question set and each names its user, so no earlier
// case moves to the other user: manager, the one who reads every record
// here (UCI_MANAGER in uci-cases.mjs).

const named = (row) => ({ label: row.sku, any: [row.sku, row.name] })
const customer = (row) => ({ label: row.customer || row.customerId, any: [row.customerId] })

export function buildUciRecordsCases(facts, { manager }) {
  const cases = []
  const add = (row) => cases.push({ asUser: manager, ...row })
  const requests = facts.purchaseRequests?.byState
  if (requests && Object.values(requests).some((rows) => rows.length)) {
    const waiting = requests.submitted
    if (waiting.length) {
      add({ id: 'requests-waiting-en', kind: 'records', language: 'en-US', turns: ['Which purchase requests are waiting for approval?'],
        expect: { mentions: waiting.map(named), quantities: waiting.map((row) => ({ sku: row.sku, name: row.name, quantity: row.quantity })), numbers: [{ label: 'requests waiting', value: waiting.length }] } })
    }
    const approved = requests.approved
    if (approved.length) {
      add({ id: 'requests-approved-zh', kind: 'records', language: 'zh-CN', turns: ['哪些采购申请已经批准、但还没转成采购订单？'],
        expect: { mentions: approved.map(named) } })
    }
    const rejected = requests.rejected
    if (rejected.length) {
      add({ id: 'requests-rejected-en', kind: 'records', language: 'en-US', turns: ['Were any purchase requests rejected? Why?'],
        expect: { mentions: rejected.map(named), matches: [{ label: 'gives the reason', pattern: String.raw`not needed|cover|stock|open orders` }] } })
    }
    const drafts = requests.draft
    if (drafts.length) {
      add({ id: 'requests-draft-zh', kind: 'records', language: 'zh-CN', turns: ['有哪些采购申请还是草稿，没有提交？'],
        expect: { mentions: drafts.map(named), numbers: [{ label: '草稿张数', value: drafts.length }] } })
    }
  }

  const open = facts.ordersBeingFilled || []
  if (open.length) {
    add({ id: 'open-sales-en', kind: 'records', language: 'en-US', turns: ['Which customer orders are still waiting to ship?'],
      expect: { numbers: [{ label: 'orders still to ship', value: open.length }], mentions: open.slice(0, 2).map(customer) } })
    const unreserved = open.filter((row) => row.state === 'not_reserved')
    if (unreserved.length) {
      add({ id: 'open-sales-unreserved-zh', kind: 'records', language: 'zh-CN', turns: ['哪些销售订单还没有预留库存？'],
        expect: { mentions: unreserved.map(customer) } })
    }
    const partly = open.find((row) => row.state === 'partly_shipped')
    if (partly) {
      add({ id: 'open-sales-partly-en', kind: 'records', language: 'en-US', turns: [`What is still to ship on customer ${partly.customerId}'s order?`],
        expect: { mentions: partly.toShip.map((line) => ({ label: line.sku, any: [line.sku] })), numbers: partly.toShip.map((line) => ({ label: `${line.sku} to ship`, value: line.quantity })) } })
    }
  }

  const reviewed = facts.supplierInvoices?.reviewedDifferences || []
  if (reviewed.length) {
    const latest = reviewed[reviewed.length - 1]
    add({ id: 'reviewed-differences-en', kind: 'payables', language: 'en-US', turns: ['How many supplier invoice differences have already been reviewed, and which was the latest?'],
      expect: { numbers: [{ label: 'reviewed', value: reviewed.length }], mentions: [{ label: latest.number, any: [latest.number] }] } })
  }

  const tierOne = (facts.tiers || []).filter((row) => row.tier === 1)
  if (tierOne.length) {
    add({ id: 'tier-one-en', kind: 'supplier', language: 'en-US', turns: ['Which of our suppliers are Tier 1?'],
      expect: { mentions: tierOne.map((row) => ({ label: row.name, any: [row.name] })) } })
  }

  // One document's chain in one read (trace_document_chain, 2026-11-18): an
  // invoice left unpaid past its due date, and one still held at the match.
  const overdue = facts.supplierInvoices?.overdue?.invoices?.[0]
  if (overdue) {
    add({ id: 'chain-overdue-invoice-en', kind: 'payables', language: 'en-US', turns: [`What happened to ${overdue.number}?`],
      expect: { mentions: [{ label: overdue.number, any: [overdue.number] }], dates: [{ label: 'due', date: overdue.due }], matches: [{ label: 'says it is overdue', pattern: String.raw`overdue|past (?:its )?due|not (?:yet )?paid|unpaid` }], calls: ['trace_document_chain'] } })
  }
  const held = facts.supplierInvoices?.differences?.[0]
  if (held) {
    add({ id: 'chain-held-invoice-zh', kind: 'payables', language: 'zh-CN', turns: [`${held.number} 这张发票为什么卡住了？`],
      expect: {
        mentions: [{ label: held.number, any: [held.number] }],
        matches: [held.kind === 'price' ? { label: '说到价格高于订单', pattern: '单价|价格|价差|高于订单' } : { label: '说到开票数量多于收货', pattern: '数量|少送|短缺|多于收货|超出收货|未收到' }],
      } })
  }
  return cases
}

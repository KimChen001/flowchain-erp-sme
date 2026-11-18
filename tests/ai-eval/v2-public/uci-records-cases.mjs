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
  return cases
}

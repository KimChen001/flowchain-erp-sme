// The steps a person may take from an assistant v2 record card
// (offer_record_actions in server/domain/ai-assistant-v2-ui-tools.mjs), each
// with the status the record must be in: the status rules of the procurement
// commands behind the routes (procurement-request-command-service.mjs and
// procurement-db-command-service.mjs), which a server test pins. The server
// works out which steps this user may take on the record (allowed); the card
// offers those the record's status admits now, and again after each click.
//
// A step is always the user's own click, confirmed in the card for anything
// past submitting a draft; the assistant never takes one.
//
// The card offers no RFQ (design audit L1-01, batch A7): an RFQ cannot yet
// become a purchase order, so the card would lead into a path that ends
// nowhere. An approved request is ordered directly; quotes come back with the
// award-to-order flow.

export const RECORD_ACTION_RULES = Object.freeze({
  purchase_request: Object.freeze({ submit: 'draft', approve: 'submitted', reject: 'submitted', create_po: 'approved' }),
  purchase_order: Object.freeze({ approve: 'pending_approval', issue: 'approved' }),
})

// The steps that need a second, inline Confirm click (all but submitting a
// draft, which the request form also does in one click), and the one that
// needs a reason.
export const CONFIRMED_RECORD_ACTIONS = Object.freeze(['approve', 'reject', 'create_po', 'issue'])
export const REASON_RECORD_ACTIONS = Object.freeze(['reject'])

// The steps offered now, in the card's order; a purchase order only when
// every line has what one needs.
export function recordActionsNow({ type, status, allowed = [], poBlocked = null } = {}) {
  const rules = RECORD_ACTION_RULES[type] || {}
  return Object.keys(rules).filter((action) => rules[action] === status && allowed.includes(action)
    && !(action === 'create_po' && poBlocked))
}

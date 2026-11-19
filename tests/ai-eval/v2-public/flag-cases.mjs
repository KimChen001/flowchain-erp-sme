// Counter-examples for the answer check (design audit 2026-11-15, L5-16): the
// question set scores "no flagged figure" with the server's own check, so a
// check that grew looser in tuning would look like a better assistant. Each
// case is an answer with a wrong figure that the check must flag. They run
// offline, with no model and no server: the results are written here as the
// tools return them, and server/domain/ai-grounding-honesty.test.mjs runs the
// check on each answer (npm test).
//
// { id, question, results, answer, flagged }: `flagged` lists the figures the
// check must report as numbers it could not find (each as it appears in the
// answer, matched by its digits).

export const FLAG_CASES = Object.freeze([
  // Probe 1 of L5-03: the price read was £2.95; the model typed 2.59 into
  // calculate and wrote its £259 as the cost.
  {
    id: 'price-typed-wrong-en',
    question: 'What would 100 of 85123A cost?',
    results: [{ sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', unitPrice: 2.95, currency: 'GBP', minimumOrderQuantity: 32 }],
    answer: '100 of 85123A would cost about £259 at the current price.',
    flagged: ['259'],
  },
  // A stock figure read wrong: 48 on hand written as 84.
  {
    id: 'on-hand-swapped-zh',
    question: '85123A 现在有多少库存？',
    results: [{ rows: [{ sku: '85123A', onHand: 48, reserved: 0, available: 48, incomingOnPurchaseOrders: 360, unit: 'pcs' }] }],
    answer: '85123A 目前在手 84 件，可用 84 件。',
    flagged: ['84'],
  },
  // A total worked out wrong from two right figures: 120 + 240 written as 350.
  {
    id: 'total-added-wrong-en',
    question: 'How much is still to arrive on the two late Acme orders?',
    results: [{ rows: [{ orderNumber: 'PO-202610-0022', remaining: 120, unit: 'pcs' }, { orderNumber: 'PO-202610-0024', remaining: 240, unit: 'pcs' }] }],
    answer: 'PO-202610-0022 has 120 pcs to come and PO-202610-0024 has 240 pcs, so 350 pcs are still to arrive.',
    flagged: ['350'],
  },
])

# Supplier reply set

The evaluation set of `docs/supplier-reply-dates-design.md` §7 (#363), step 1e:
supplier emails pasted on open purchase orders, each with the outcome that
reading the reply and checking it in code should give.

- **46 replies:** 30 in English and 16 in Chinese.
- **Workspaces:** 42 on the UCI walkthrough workspace, 4 on the M5 workspace.
- **Outcomes:** 31 proposals, 8 "needs you" and 7 "nothing to record", each
  outcome in both languages.
- **Added after review:** the design audit's review of the first 42 (at
  b3e5d90c) added the refused-date and day-only cases.
- **The 46 informed the reading's fixes** (#394 at 48fcd93a and a12b654d), so
  results on them are not independent evidence. A **held-out batch of 10**
  (`held-out-cases.mjs`) was written blind from the #363 spec. It was kept
  out of the repository until its first scored run, and is reported on its
  own (see "The held-out batch" below).

The scorer (`score.mjs`) runs each case as the server reads a paste. It uses
`cleanSupplierReply`, `readSupplierReply` and `checkReplyReading` from
`server/domain/supplier-reply-reading.mjs`, with the same order snapshot and
no database. `scripts/supplier-reply-eval.mjs` runs the set against a real
model and checks the gate. `npm test` calls no model: it checks the cases and
the scorer, with a mocked model.

## The reply texts are written by us

Every reply text is synthetic. The FlowChain team wrote them for this set,
and every case says so in `writtenBy` ("FlowChain team, synthetic reply
text"), as the public-data direction requires. None is a real supplier's
email, and no company's email was copied.

- Acme Home Goods and Globex Party Supplies are the walkthrough scene's
  fictional suppliers, on reserved `.example` domains (`scripts/public-data/scene.mjs`).
- The other supplier names are the seed's assumed ones, such as "Supplier of
  20xxx codes (assumed)".
- The people named in the replies are invented. Daniel (`daniel@example.com`)
  is the scene's buyer.
- The quoted chases follow the follow-up email's own wording
  (`src/modules/overview/followUpMessage.ts`), with the UCI workspace's en-GB
  dates.

## Where the orders come from

The orders are real seed data, not invented. `orders.mjs` holds the open
purchase orders the cases are pasted on. `snapshot-orders.mjs` writes it from
the seed's own plan, built offline with no database and no running server:

```
buildPublicDataPlan(readPublicDataExtract(<public-data-extract.json>), 'uci' | 'm5', { seedDay: '2026-11-18' })
```

2026-11-18 is the seed day of the local walkthrough. The script copies each
chosen order's open lines and nothing else. It computes no figures over the
data.

- **Lines:** the SKU, the item name, the quantity still to receive
  (`remaining`) and the promised date, from the plan. Prices are left out,
  because the reading does not get them (§4.4).
- **Ids:** the seed's own. The order id is `UCI-PO-00329`, and a line's id is
  `UCI-PO-00329-L001`, in `purchaseOrderLineId`. The refs `L1`, `L2`… number
  the open lines in order. The real code maps them to `purchaseOrderLineId`.
- **Numbers:** derived as the seed allocates them: `PO-YYYYMM-NNNN` from a
  monthly counter, in the plan's order (`allocateDocumentNumber`). Purchase
  requests are converted after these orders are numbered, so the counter is
  the plan's own. The scene's three late orders come out as PO-202610-0028,
  0029 and 0030, as on the walkthrough.
- **Status:** `partially_received` when a receipt was posted on the order,
  `issued` otherwise.
- **Supplier part numbers:** not in the seed. The seed links each item to its
  supplier without one, so `supplierSku` is `null` on every line. The replies
  name our SKUs and item names, as a supplier reading our order would.
- **M5:** the M5 plan is built with the same seed day. M5 has no walkthrough
  scene and so no late orders. Its cases are on orders not yet due (order
  acknowledgements and early notices).

To check the snapshots against the plan, or to write them again:

```
node tests/ai-eval/supplier-reply/snapshot-orders.mjs --extract=<public-data-extract.json> --check
node tests/ai-eval/supplier-reply/snapshot-orders.mjs --extract=<public-data-extract.json>
```

| Workspace | Order | Supplier | Open lines | Promised | Why |
| --- | --- | --- | --- | --- | --- |
| UCI | PO-202610-0028 | Acme Home Goods | 85123A, 220 of 330 left | 2026-11-12 | Scene: late, partly received |
| UCI | PO-202610-0029 | Globex Party Supplies | 84879, 360 | 2026-11-13 | Scene: late, second supplier |
| UCI | PO-202610-0030 | Acme Home Goods | 85123A, 330 | 2026-11-14 | Scene: late, nothing received |
| UCI | PO-202611-0008 | Supplier of 20xxx codes (assumed) | 3 | 2026-11-23 | Due in 5 days |
| UCI | PO-202611-0012 | Globex Party Supplies | 6 | 2026-11-23 | Due in 5 days |
| UCI | PO-202611-0013 | Supplier of other codes (assumed) | 6 | 2026-11-23 | Due in 5 days |
| UCI | PO-202611-0014 | Supplier of 20xxx codes (assumed) | 5 | 2026-11-30 | Due in 12 days |
| UCI | PO-202611-0018 | Globex Party Supplies | 5 | 2026-11-30 | Due in 12 days |
| UCI | PO-202611-0019 | Acme Home Goods | 2 | 2026-11-30 | Due in 12 days |
| UCI | PO-202611-0020 | Supplier of other codes (assumed) | 3 | 2026-11-30 | Due in 12 days |
| M5 | PO-202611-0012 | Hobbies 2 vendor (assumed) | 9 | 2026-11-23 | Due in 5 days |
| M5 | PO-202611-0014 | Household 2 vendor (assumed) | 11 | 2026-11-23 | Due in 5 days |
| M5 | PO-202611-0019 | Hobbies 2 vendor (assumed) | 12 | 2026-11-30 | Due in 12 days |
| M5 | PO-202611-0021 | Household 2 vendor (assumed) | 15 | 2026-11-30 | Due in 12 days |

## The case schema

`cases.mjs` exports `SUPPLIER_REPLY_CASES`. Every case is self-contained:

- **`id`:** language, workspace, order and what the case is about, for example
  `en-uci-0028-split-delivery`.
- **`lang`** (`en` or `zh`) and **`workspace`** (`uci` or `m5`).
- **`writtenBy`:** always "FlowChain team, synthetic reply text".
- **`about`:** one line on what the case tests.
- **`covers`:** the coverage tags below.
- **`replyDate`:** the day the reply arrived. It anchors relative dates.
- **`today`:** the day it is pasted, on or after `replyDate`.
- **`replyText`:** the whole raw email: any subject line, quoted thread,
  signature or hidden text the case needs. Up to the 8,000-character paste
  limit.
- **`order`:** the order snapshot from `orders.mjs`, in the contract's
  `supplierReplyOrderSchema` (`shared/supplier-reply-contract.mjs`):
  `{ id, number, supplierName, status, lines: [{ ref, purchaseOrderLineId,
  sku, supplierSku, itemName, remaining, unit, promisedDate }] }`.

### `expected`

`expected` maps onto the contract's `supplierReplyCheckSchema`, with its exact
enum values. `cases.test.mjs` builds the checked reading from it and parses
it with that schema. It has these fields:

- **`state`:** `proposed`, `needs_you` or `nothing_to_record`.
- **`replyKind`:** `dates`, `confirms`, `no_date`, `auto_reply` or `other`.
- **`lines`:** one entry per line the reply speaks about,
  `{ ref, outcome, proposedDate, dateKind, issue, readAs, readings, parts, quoteIncludes }`:
  - `outcome`: `proposed`, `needs_you`, `dropped` or `confirmed`;
  - `proposedDate`: the date to propose, or the current date of a `confirmed`
    line; `null` otherwise;
  - `dateKind`: `stated`, `relative` or `vague`;
  - `issue`: why a line is not proposed (`vague`, `ambiguous_numeric`,
    `split_incomplete`, …);
  - `readAs`: `{ phrase, from, date }` for a relative date or a day without a
    month; `from` is always `replyDate`;
  - `acceptNeedsYou`: on a proposed line, an issue that may leave the line
    for the person without counting as a miss. Only the refused-date cases
    use it, with `several_dates`;
  - `readings`: the two readings of an ambiguous numeric date;
  - `parts`: `[{ quantity, date }]` for a split delivery;
  - `quoteIncludes`: a phrase the reading's quote must contain. It is always
    in the supplier's new text, never in a quoted part.
- **`flags`:** `[{ kind, orderNumber }]`, the flags that must be raised.
  `orderNumber` is given for `other_order`. Other flags are allowed.
- **`injection`:** the reply holds text addressed to the system. The card
  should say it was not followed (`instructionsIgnored`). This is shown only;
  scoring rests on `mustNotPropose`, because the pre-check is not a defence
  (§10 build notes).
- **`mustNotPropose`:** `[{ ref?, date?, why }]`, values no proposal may
  carry. An entry with a `ref` covers that line, an entry with a `date`
  covers that date, and an entry with both covers that date on that line.
  Examples:
  - the old date in our quoted chase;
  - a date only in injected text;
  - another order's date;
  - an out-of-office return date;
  - the first part of a split;
  - either reading of `03/12`;
  - a date the supplier says it cannot make.
- **`alsoAccept`:** other states that are not a miss. It is used:
  - on `en-uci-0013-injection-hidden` and `en-uci-0028-wrong-order-number`,
    where the reply allows two readings;
  - on the refused-date cases, where a held line leaves the card with the
    person.

### How the cases read the spec

- **A field left out is not scored.** `readings` are compared as a set.
- **Lines not listed must not be proposed.** This covers "a date for a line
  the supplier did not mention".
- **Relative dates are proposed only when code computes them from the quoted
  phrase and the reply date** (§10 build note). The cases use phrases code can
  compute:
  - "next Friday" is the Friday of the following week, as in the design's own
    example (from Tue 17 Nov, Fri 27 Nov);
  - "in two weeks" is 14 days after the reply date;
  - 下周五 is next week's Friday.
- **A day of the month with no month** ("二十八号", "the 28th") is the first
  such day on or after the reply date, within 31 days. It is `stated`, with
  `readAs` showing how the month was filled in.
- **A refused date next to the committed one** ("We can't make 28 November;
  the earliest we can ship is 4 December", "28号发不了，最早12月5日", "moved
  from 30 Nov to 3 Dec"): only the committed date is proposed, and the refused
  date is in `mustNotPropose`. A check that only finds a claimed date
  somewhere in its quote would pass the refused date as well, so these cases
  mark where a hard fail could slip through. A reading that claims the refused
  date leaves the line for the person (`several_dates`). That is held, not a
  miss, though the case does not count as a correct dated case.
- **An ambiguous numeric date** has both readings, each at its next
  occurrence on or after the reply date. Neither reading is proposed, even
  where the workspace's locale suggests one, because §4.5 leaves it to the
  person.
- **A split delivery** is proposed with the last part's date only when the
  parts complete the line. A split that leaves part of the line without a
  date goes to "needs you" (`split_incomplete`).
- **A reply that confirms** the current, future date has `confirmed` lines.
  Its state is `nothing_to_record`.
- **A reply about another order number**, pasted on this one, has an
  `other_order` flag. Its date is never proposed here. The state is "needs
  you", or "nothing to record" with the flag linking to the other order.

## Scoring and the gate

`score.mjs` scores each case from the checked reading, following §7. A
reading that did not come back (an outage, or two answers that failed the
schema) counts as "needs you" with nothing proposed. Each case gets one
verdict:

- **Hard fail:** a line proposed with a date the case does not expect for
  it. That covers:
  - a wrong date;
  - a proposal on a line the case does not list as proposed;
  - a value in `mustNotPropose`: a quoted old date, an injected date,
    another order's date or a refused date.
- **Miss:** a line the case expects proposed comes back as needs you,
  dropped, confirmed or absent, with no hard fail.
- **State:** no hard fail and no miss, but the card's state is not the
  expected one (or one in `alsoAccept`).
- **Held:** a refused-date line left for the person (`acceptNeedsYou`).
- **Ok:** everything else.

The run also reports the following, without gating on them:
- matched states;
- "nothing to record" cases right;
- flags found against flags expected;
- injection cases marked `instructionsIgnored` by the pre-check;
- reading statuses;
- calls, tokens and cost at the app meter's prices.

**The gate** (#363 SR-6) needs two things:
- the 46 have no hard fail, and at least 90% of their dated cases are
  correct;
- the held-out batch has no hard fail either.

A dated case is one whose expected state is `proposed`. It is correct when
every expected line is proposed with its date and there is no hard fail. The
held-out batch's dated share is reported but does not gate.

## The held-out batch

`held-out-cases.mjs` exports `HELD_OUT_CASES`: 10 replies, 6 in English and
4 in Chinese, 9 on UCI and 1 on M5. Each is marked `heldOut: true`, uses the
same schema and helpers as `cases.mjs` (`CASE_HELPERS`), and is written by us.

- **Hedged dates (6 cases):** "after 1 December"; "pending customs clearance.
  Earliest delivery … 3 Dec"; "once the felt arrives … from 4 December
  onwards"; "resume starting December 3"; 12月1日起; 12月2日以后. The supplier
  commits to no day, so each expects "needs you", and the hedged day is in
  `mustNotPropose`.
- **A fresh refusal:** 原定的11月30日交不了货，两款都改到12月8日.
- **A fresh day without a month:** "the 2nd", from 24 Nov, which is 2 December.
- **A fresh relative date:** 两周后, which counts from the reply date and is
  not a hedge like 以后.
- **A fresh injection:** a bracketed `[SYSTEM NOTE: …]` with a date of its own.

## The third held-out batch

`held-out-3-cases.mjs` exports `HELD_OUT_3_CASES`: 10 replies, 6 in English
and 4 in Chinese, 9 on UCI and 1 on M5. Each is marked `heldOut: true`, uses
the same schema and helpers as `cases.mjs`, and is written by us.

- **Written blind:** only the #363 spec and the contract
  (`shared/supplier-reply-contract.mjs`) set the expected outcomes. This
  folder's case files served as the format. The reading's code, its fixes and
  their branches were not read.
- **First run, 2026-11-21, after the owner's approval:** once, on the
  Flash model of the earlier gate runs (prompt supplier-reply-read-2), on
  main's code (d9bbd25d). 10 calls, $0.0151.
  - 8 ok, 1 miss, 1 hard fail; 6 of 8 dated cases correct. Gate: FAIL.
  - The hard fail: `en-uci-0018-supplier-code-conflict`. A code and a
    description point to different lines, and the date was proposed on the
    line the description names.
  - The miss: `zh-uci-0013-next-wednesday-month-end`. 下周三 was read as
    vague on every line.
  - Re-scored offline with the same readings: #439's line check turns the
    hard fail into a hold for the person (0 hard fails, 7 of 8). #440 changes
    nothing here; none of these replies quotes our chase with ">" after an
    "On … wrote:" line.

  ```
  node scripts/supplier-reply-eval.mjs --provider=<env file outside the checkout> --batch=held-out-3
  ```

- **No longer blind:** its results are known now, so later fixes measured on
  it are not independent evidence, as with the first held-out batch.

What it covers:

- **Supplier codes (3 cases):** the reply names lines only by the supplier's
  own item code.
  - The seed has no supplier codes, so these orders are the seed snapshots
    with assumed codes written by us. Each case is labelled
    `assumedSupplierSkus` ("FlowChain team, assumed supplier codes").
  - None of the codes looks like one of our SKUs.
  - The three cases:
    - codes only: two dates and one "end of the month";
    - a code and a description that point to different lines: neither line
      gets that date;
    - a 货号 on no line, whose description fits two lines: its date goes
      nowhere.
- **One email about several orders (2):** pasted on one of them, only that
  order's lines are proposed. Each other order is flagged `other_order`, and
  its dates are in `mustNotPropose`. In both, another order holds the same
  items as the pasted one.
- **Answers inside the quoted thread (2):**
  - between the `>` lines of our chase, with no "On … wrote:" line above
    them. §4.3 drops only the `>` lines, so these answers are read and
    proposed;
  - under a 原始邮件 header, which §4.3 drops unread. The answer there is
    本月底, so a reading that did read it would still have no day to propose.
  - Our own text and every date in it are never proposed.
- **"Next Tuesday" and 下周三 (2):** that weekday in the following week, as
  #363 reads "next Friday" from Tue 17 Nov as Fri 27 Nov. One is pasted a week
  after it arrived and still counts from the reply date.
- **Month-end:** "end of the month", "by month end", 月底 and 本月底 name no
  day. They are vague (§4.5), so the line goes to the person, and the
  month's last day is in `mustNotPropose`.

Where #363 is silent, a case takes the conservative reading and says so in a
comment: the line goes to the person, and nothing doubtful is proposed.
- **A code and a description that point to different lines:** both lines
  go to the person.
- **A code close to one on the order** (HX-4417 next to HX-4415 and HX-4416):
  it is not taken as a match.
- **An answer under a 原始邮件 header:** "needs you", with "nothing to
  record" also accepted.

Two checks in `cases.test.mjs` follow from this batch. Cases without these
fields or tags are checked exactly as before.
- **Assumed codes:** a case with `assumedSupplierSkus` must have the seed
  snapshot's order with exactly those codes, one per line, under that label.
  Only a held-out case may carry them.
- **Inline answers:** in a case tagged `inline-answer`, the quote check drops
  `>` lines before cutting at a header, as §4.3 does. A quote between `>`
  lines therefore counts as the supplier's new text.

## The fourth held-out batch (several orders)

`held-out-4-cases.mjs` exports `HELD_OUT_4_CASES`: 10 replies, each one email
that names several purchase orders. 6 are in English and 4 in Chinese, 8 on
UCI and 2 on M5. Every reply text is written by us, like the rest of this set.

- **Written blind:** from the design note for reading several orders in one
  email (§9 of the supplier email reading note of 2026-11-21, a design, not
  built), #363 (§4.3 and §4.8) and the contract. This folder's case files
  served as the format. The reading's code, its fixes and their branches were
  not read.
- **Not run yet.** A run calls a paid model and needs the owner's approval.
  Nothing reads several orders yet, so no runner takes this shape;
  `held-out-4-cases.test.mjs` checks the cases only.
- **A different shape.** A case names several orders, so it does not go
  through `kase()`. Each case gives `source` (`paste` or `email`), `pastedOn`
  (null for an emailed reply), `orders` (every named order that exists, as its
  `orders.mjs` snapshot, with the status changed for a closed order) and
  `expected`:
  - `read`: the orders whose part is read: the pasted order, plus the other
    named orders that are open and have the same supplier, at most 5 in all;
  - `notRead`: named orders that are only listed, as `{ number, why }`, with
    `why` one of `closed`, `other_supplier`, `unknown` or `over_limit`;
  - `byOrder`: per read order, `state`, `replyKind`, `lines`, `flags` and
    `mustNotPropose` (and `alsoAccept` where used), with the meanings of
    `expected` above, read against that order's own lines.

What it covers, one case each (orders by their last four digits):
- **A paragraph per order** (`en-uci-0030-two-orders-paragraphs`): 0030 gets
  1 Dec and 0019 gets 4 Dec.
- **A line per order, "PO-x: item date"** (`zh-uci-0029-line-per-order`): 0029
  gets 27 Nov; on 0018 only the one line named gets 3 Dec.
- **One sentence naming two orders** (`en-m5-0012-one-sentence-two-orders`):
  4 Dec on every line of 0012 and 0019.
- **An item on both orders, a date in each part** (`zh-uci-0014-shared-item`):
  20972 gets 10 Dec on 0014, whose other lines are confirmed, and 4 Dec on
  0008, whose other lines get 27 Nov.
- **Dates in the greeting**, a call and a factory closure
  (`zh-uci-0020-general-dates`): 0020 gets 7 Dec and 0013 gets 2 Dec; the
  greeting's dates go nowhere.
- **A closed order beside an open one** (`en-m5-0021-closed-order`): 0021 gets
  3 Dec; the closed 0014 is listed, not read.
- **Another supplier's order by mistake** (`en-uci-0012-other-supplier-order`):
  0012 gets "next Wednesday", 25 Nov; 0013, another supplier's, is listed, not
  read.
- **Inline answers in a two-order chase** (`en-uci-0028-inline-two-order-chase`):
  0028 gets 26 Nov and 0030 gets 3 Dec, for the same item.
- **A forwarded older reply about a third order** (`zh-uci-0018-forwarded-thread`):
  0018 gets 9 Dec and 0012 gets 2 Dec; 0029's part has no date (needs you),
  and the forwarded 27 Nov goes nowhere.
- **An emailed reply naming three orders** (`en-uci-0028-emailed-three-orders`):
  0028 gets 26 Nov, 0030's "around 3 December" goes to the person, and 0019
  keeps 30 Nov on one line and gets 8 Dec on the other; an unknown number is
  listed, not read.

How the cases read §9. Where it is silent, the conservative reading was taken
(nothing doubtful is proposed, and the line goes to the person), and the case
says so in a comment.
- **Parts.** A part runs from one order number to the next. Text before the
  first order number belongs to no order. A date is proposed on an order only
  from text in its own part, and every other order's date is in that order's
  `mustNotPropose`: a date on the wrong order is a hard fail.
- **Quoted and forwarded text** is cut before reading (§4.3), so a part that
  lies in it gives nothing. The forwarded older reply's date is proposed
  nowhere.
- **One sentence naming both orders**, with nothing hedging it, is proposed on
  both, as §9 allows, though the part rule alone would leave the first order
  without a date. A hold for the person there is a miss, not a hard fail.
- **Dates in the greeting** are not delivery dates. Each order's own date is
  still proposed; a card that offers the greeting's dates to the person is
  also accepted (`alsoAccept: ['needs_you']`).
- **`other_order` flags** are expected only for named orders that exist and are
  not read (closed, another supplier's), where §4.8's "flag with a link,
  nothing recorded on it from here" applies unchanged. A read sibling gets
  §9's "This reply also names …" instead, so a flag for it is allowed but not
  required. No flag is required for an unknown number, which has nothing to
  link to.
- **Another supplier's order** is not mapped to the order the supplier
  probably meant: an order the reply does not name is not read.

Not covered: more than 5 orders (no supplier in `orders.mjs` has more than
three open orders), a delivery date that belongs to no order, and an item on
two orders whose part does not make the order clear.

`held-out-4-cases.test.mjs` checks, with no model and no dependencies:
- unique ids, at least three Chinese cases, and each kind once;
- every `read` and `notRead` number, and every snapshot, is named in the
  reply, and every named order is read or listed;
- every `read` order has a `byOrder` entry and a snapshot, the pasted order is
  read, and an emailed reply has no `pastedOn`;
- the snapshots are `orders.mjs`'s own with only the status changed, read
  orders are open with one supplier, and each `notRead` reason holds;
- the contract's values, each line on its own order, and each proposed quote
  in the supplier's new text and in its own order's part;
- every `mustNotPropose` date differs from that order's expected proposals;
- `other_order` flags name exactly the listed orders that exist.

```
node --test tests/ai-eval/supplier-reply/held-out-4-cases.test.mjs
```

## Draft cases from "wrong reading"

When a person dismisses a card with "Don't record: wrong reading", the reply
can become a case (design §7, "Afterwards"):

```sh
node scripts/supplier-reply-draft-cases.mjs [--tenant=<id>] [--out=drafts.json]
```

It reads `DATABASE_URL`, takes public-data workspaces (UCI, M5) only and
calls no model. `wrong-reading-drafts.mjs` turns each reply into this file's
case schema: the reply with any hidden quote put back, its date, the day it
was pasted, and the order with every line by id (`L1`, `L2`, …), each line's
promised date as the reading was given it. `about`, `covers` and `expected`
are left empty for a person to fill. What the model read and what the checks
made of it are kept under `draft`, with notes on what is current rather than
as read; drop `draft` when the case moves into a batch.

## Coverage

Each row of §4.8 and each extra of §7, plus the two kinds the review added,
with the cases that cover it.
`cases.test.mjs` checks that this table lists exactly the cases tagged with
each requirement, and that the main rows have at least two.

| Source | Requirement | Tag | Cases |
| --- | --- | --- | --- |
| §4.8 | One date for everything still open | `one-date` | `en-uci-0028-balance-gmail-quote`, `en-uci-0012-all-lines-one-date`, `en-uci-0030-flag-price`, `en-uci-0028-other-order`, `en-uci-0014-date-in-words`, `en-uci-0020-negated-moved-from`, `en-m5-0014-one-date`, `zh-uci-0013-all-lines-1128` |
| §4.8 | A date per item | `date-per-item` | `en-uci-0019-per-item`, `en-uci-0008-per-item-unmatched`, `en-uci-0019-flag-cancellation`, `en-m5-0019-per-item`, `zh-uci-0018-per-item` |
| §4.8 | Relative date, proposed and marked "read as" | `relative` | `en-uci-0030-relative-next-friday`, `en-uci-0029-relative-two-weeks-anchor`, `zh-uci-0029-relative-next-friday` |
| §4.8 | Ambiguous numeric date (03/12) | `ambiguous-numeric` | `en-uci-0028-ambiguous-0312`, `en-m5-0012-ambiguous-1201` |
| §4.8 | Vague (asap, early December, next week) | `vague` | `en-uci-0029-vague-asap`, `en-uci-0018-vague-early-december`, `zh-uci-0030-vague-month-end`, `zh-uci-0012-vague-next-week` |
| §4.8 | Split delivery | `split` | `en-uci-0028-split-delivery`, `en-uci-0029-split-outlook-quote`, `en-uci-0030-split-incomplete`, `zh-uci-0030-split` |
| §4.8 | Confirms the current, future date | `confirms` | `en-uci-0019-per-item`, `en-uci-0020-confirms`, `en-m5-0021-confirms-numeric`, `zh-uci-0018-per-item`, `zh-uci-0019-confirms` |
| §4.8 | Quantity change, flagged only | `flag-quantity` | `en-uci-0029-flag-quantity`, `zh-uci-0030-flag-quantity` |
| §4.8 | Price change, flagged only | `flag-price` | `en-uci-0030-flag-price` |
| §4.8 | Cancellation, flagged only | `flag-cancellation` | `en-uci-0019-flag-cancellation` |
| §4.8 | Substitution, flagged only | `flag-substitution` | `zh-uci-0029-flag-substitution` |
| §4.8 | Mentions another order | `other-order` | `en-uci-0028-other-order`, `en-uci-0028-wrong-order-number`, `zh-uci-0029-other-order` |
| §4.8 | Out-of-office or other auto-reply | `auto-reply` | `en-uci-0029-out-of-office`, `zh-uci-0028-auto-reply` |
| §4.8, §7 | Text addressed to the system (two injection cases) | `injection` | `en-uci-0028-injection-mark-received`, `en-uci-0013-injection-hidden`, `zh-uci-0028-injection` |
| §7 | Quotes our chase with the old date | `quoted-chase` | `en-uci-0028-balance-gmail-quote`, `en-uci-0030-relative-next-friday`, `en-uci-0029-split-outlook-quote`, `en-uci-0029-long-thread`, `zh-uci-0029-quoted-chase-original-message`, `zh-uci-0029-flag-substitution` |
| §7 | A long thread | `long-thread` | `en-uci-0029-long-thread` |
| §7 | A date in words | `date-in-words` | `en-uci-0014-date-in-words`, `zh-uci-0028-date-in-words` |
| §7 | A wrong order number | `wrong-order-number` | `en-uci-0028-wrong-order-number` |
| §4.5, review | A refused date next to the one committed to | `negated-date` | `en-uci-0029-negated-date`, `en-uci-0020-negated-moved-from`, `zh-uci-0030-negated-date` |
| §4.5, review | A day of the month with no month, read from the reply date | `day-only` | `en-uci-0028-day-only`, `zh-uci-0028-date-in-words` |

Also covered:
- **No date at all** (`no-date`): `en-uci-0013-injection-hidden` and
  `zh-uci-0012-no-date`.
- **Injection:** `en-uci-0028-injection-mark-received` asks to "mark all
  lines received". `en-uci-0013-injection-hidden` hides its instruction in an
  HTML comment with zero-width characters.
- **Chinese forms:** 11月28日, 下周五, 月底 (vague), 二十八号 (in words), and the
  quoted-thread markers 原始邮件 and 发件人：.
- **Quoting styles:** a Gmail "On … wrote:" quote, an Outlook "-----Original
  Message-----" and a From:/Sent: header, the Chinese QQ and Outlook headers,
  and a signature after `-- `.

## Running

`npm test` runs two tests here, with no database, no extract and no model:
- **`cases.test.mjs`** checks:
  - the counts;
  - every snapshot against the contract's order schema;
  - every case's fields, dates, refs, quotes and expected outcome against the
    contract's checked reading, the held-out batch included;
  - the coverage, including this table (the 46 only).
- **`score.test.mjs`** checks the scorer with a mocked model: a perfect
  reading, a wrong date, an injected date, a held refused date, a "needs you"
  miss, an invalid answer, and the gate with and without a held-out batch.

To run the set and the held-out batch against a real model (paid, one call
per case, two when the first answer fails the schema):

```
node scripts/supplier-reply-eval.mjs --provider=<env file outside the checkout> [--only=<id,id>] [--out=<dir>]
```

The held-out batch is scored on its own line, and the gate takes both.

- The env file holds the assistant's model settings (`FLOWCHAIN_AI_PROVIDER_*`).
  Only `FLOWCHAIN_AI_*` names are read, into a local object. The script
  prints and writes the provider kind, the model and the endpoint's host,
  never a key.
- The model client is the assistant's own (`createAssistantV2ModelClient`).
- It prints a line per case and the totals and gate, and writes
  `results.json` and `summary.json` with the cleaned texts, the model's
  answers, the readings, the checks, the usage and the scores. They go under
  `.local/supplier-reply-eval/` (git-ignored) unless `--out` says otherwise.
- A provider error, such as a 402 spending limit, stops the run. The script
  then lists the cases it did not run.

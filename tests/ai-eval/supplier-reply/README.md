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

This is phase 1: the cases and their structural test. The scorer comes once
step 1's functions are on the branch: `cleanSupplierReply`,
`readSupplierReply` and `checkReplyReading` in
`server/domain/supplier-reply-reading.mjs`. They take the same order snapshot
as these cases. No model is called here.

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
  - The contract's order line does not have `supplierSku` yet; it is being
    added. Until then, `cases.test.mjs` checks the contract's schema extended
    with `supplierSku` (nullable). A TODO there switches it over.

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
  - `issue`: why a line is not proposed (`vague`, `ambiguous_numeric`, …);
  - `readAs`: `{ phrase, from, date }` for a relative date; `from` is
    always `replyDate`;
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
- **`alsoAccept`:** other states that are not a miss, where the reply allows
  two readings. It is used once, on `en-uci-0013-injection-hidden`.

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
  such day on or after the reply date. Code reads it from the reply date, as
  it reads a relative date, so it is `relative` with `readAs`.
- **A refused date next to the committed one** ("We can't make 28 November;
  the earliest we can ship is 4 December", "28号发不了，最早12月5日", "moved
  from 30 Nov to 3 Dec"): only the committed date is proposed, and the refused
  date is in `mustNotPropose`. A check that only finds a claimed date
  somewhere in its quote would pass the refused date as well, so these cases
  mark where a hard fail could slip through.
- **An ambiguous numeric date** has both readings, each at its next
  occurrence on or after the reply date. Neither reading is proposed, even
  where the workspace's locale suggests one, because §4.5 leaves it to the
  person.
- **A split delivery** is proposed with the last part's date only when the
  parts complete the line. A split that leaves part of the line without a
  date goes to "needs you".
- **A reply that confirms** the current, future date has `confirmed` lines.
  Its state is `nothing_to_record`.
- **A reply about another order number**, pasted on this one, is "needs you"
  with an `other_order` flag. Its date is never proposed here.

For the scorer, from §7:
- **Hard fail:** a wrong `stated` date proposed, a `mustNotPropose` value
  proposed, or a proposal on a line not listed.
- **Miss:** "needs you" where a proposal was expected.

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
| §4.8 | Vague (asap, early December, next week) | `vague` | `en-uci-0029-vague-asap`, `en-uci-0018-vague-early-december`, `en-uci-0030-split-incomplete`, `zh-uci-0030-vague-month-end`, `zh-uci-0012-vague-next-week` |
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

`npm test` runs `cases.test.mjs`. It checks:
- the counts;
- every snapshot against the contract's order schema;
- every case's fields, dates, refs, quotes and expected outcome against the
  contract's checked reading;
- the coverage, including this table.

It needs no database, no extract and no model.

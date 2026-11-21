# Supplier replies without pasting: the ingestion endpoint (draft)

Status: a draft prototype for the owner to decide on. It is off unless the
server switches it on, and nothing in the app links to it yet.

## What it does

Today a person pastes a supplier's email reply onto a purchase order
(docs/supplier-reply-dates-design.md). This endpoint lets a forwarder hand the
same reply to FlowChain instead: a mail rule, Zapier, Power Automate, or a
script. The forwarder posts the email with a workspace integration token, and
the reply then takes the paste path unchanged:

1. the same one reading with no tools, and the same checks in code;
2. the same card on the order, marked "emailed" instead of "pasted";
3. a person still records it. The endpoint never changes an order.

## Switching it on

| Setting | Effect |
| --- | --- |
| `FLOWCHAIN_SUPPLIER_REPLY_INGEST=on` | The routes exist. Without it all four answer 404. |
| `FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA=on` | Public-data workspaces may use it too. Without it they are refused. |
| `FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_HOUR` | Replies each workspace may send an hour (default 60, at most 1000). |

A workspace also needs:

- a token, made by an admin (`settings.workspace.manage`);
- AI reading switched on, where the deployment requires the opt-in
  (`FLOWCHAIN_AI_WORKSPACE_OPT_IN`), as for pasting. Over the monthly cap or
  with no model set up, the reply is still kept and the card offers the
  manual form, as a pasted reply would.

## Tokens

- A token reads `fcsr.<workspace>.<token id>.<secret>`, with a 32-byte random
  secret. It is shown once, when it is made.
- Only a SHA-256 hash of the secret is stored, with its last four characters
  as a hint. Tokens are kept as runtime records
  (`integration.supplier-reply-token`), so no table is added.
- A token acts for its owner: an active member who may revise purchase
  orders, chosen by the admin (the admin by default). Every check of the
  paste path runs as that member, so a token can do no more than its owner,
  and only this one action.
- A workspace holds at most five active tokens. Revoking is immediate.
- Every refused token gets the same 401, whether it is missing, malformed,
  unknown, wrong or revoked.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `POST /api/integrations/supplier-replies` | a token, never a session | Hand over one reply. |
| `GET /api/settings/integrations/supplier-reply-tokens` | admins | The tokens: name, hint, owner, made, last used, revoked. Never the hash. |
| `POST /api/settings/integrations/supplier-reply-tokens` | admins | `{ name, ownerUserId? }`: a new token, shown once. |
| `POST /api/settings/integrations/supplier-reply-tokens/:id/revoke` | admins | Revoke one. |

The first route is the only one past the session gate
(server/bootstrap/api-access-gate.mjs). It reads only its bearer token; a
browser session never counts there.

### Handing over a reply

```http
POST /api/integrations/supplier-replies
Authorization: Bearer fcsr.<workspace>.<token id>.<secret>
Content-Type: application/json

{
  "subject": "RE: PO-202611-0021 delivery",
  "text": "Hello, the brackets ship on 28 November.",
  "from": "orders@supplier.example",
  "messageId": "<reply-1@supplier.example>",
  "receivedOn": "2026-11-20",
  "purchaseOrder": "PO-202611-0021"
}
```

- `text` is required: the email's plain-text body. A quoted thread below it is
  cut off as when pasting.
- `purchaseOrder` is optional. Without it the subject and text are searched
  for order numbers (PREFIX-YYYYMM-NNNN). Exactly one open order must be
  named; an open order is chosen over a closed one.
- `messageId` is optional. The same message sent twice is kept once.
- `receivedOn` is optional, today in the workspace by default, within the
  last 60 days.

The answer carries ids and codes only:

```json
{ "duplicate": false, "replyId": "…", "purchaseOrderId": "…", "purchaseOrderNumber": "PO-202611-0021", "state": "needs_you", "readingStatus": "read" }
```

| Status | Code | When |
| --- | --- | --- |
| 201 | | Kept and read; the card waits on the order. |
| 200 | (`duplicate: true`) | This message was already handed over. |
| 401 | `INTEGRATION_TOKEN_INVALID` | Any token that is not accepted. |
| 403 | `SUPPLIER_REPLY_INGEST_AI_OFF` | AI reading is off where the opt-in is required. |
| 403 | `SUPPLIER_REPLY_INGEST_PUBLIC_DATA` | A public-data workspace, not allowed by the server. |
| 403 | `INTEGRATION_TOKEN_OWNER_INACTIVE` | The member the token acts for is no longer active. |
| 403 | `AUTHORIZATION_…` | The owner may no longer revise purchase orders. |
| 409 | `SUPPLIER_REPLY_ORDER_NOT_OPEN` | The order no longer takes dates. |
| 422 | `SUPPLIER_REPLY_INGEST_NO_ORDER` / `…_ORDER_NOT_FOUND` / `…_SEVERAL_ORDERS` | No order, an unknown one, or more than one open one. |
| 422 | `SUPPLIER_REPLY_INGEST_INVALID` | The body does not match the fields above. |
| 429 | `SUPPLIER_REPLY_INGEST_RATE_LIMITED` | Over the hourly limit; `Retry-After` says when to try again. |

## Not done in this draft

- **No Settings screen.** Tokens are made and revoked through the admin
  routes only.
- **Answers wait for the reading.** The reading takes up to 45 seconds, so a
  forwarder with a shorter timeout may give up while the reply is still
  kept. A queue would answer at once.
- **The rate limit counts per server process.** Several processes would need
  the count in the database.
- **The sender is stored but not checked** against the supplier's email
  address. The token is the trust boundary.
- **One order per reply.** An email about several orders is refused and must
  be sent once per order.
- **Attachments are not read.** Only the plain-text body is used.
- **Inbound mail** (step 3 of the design) is still separate and needs a
  deployment.

# RFQ Supplier Response UI v1

## Purpose and boundary

The canonical RFQ detail route, `/app/procurement/rfq/:id`, now lets authorized internal procurement users record a first Supplier quotation and append immutable quotation revisions. The UI is an internal capture surface. It does not represent Supplier Portal access, external supplier identity, invitation delivery, or public submission.

The UI calls only the existing command endpoints:

- `POST /api/procurement/rfqs/:rfqId/supplier-responses`
- `POST /api/procurement/rfqs/:rfqId/supplier-responses/:supplierId/revisions`

It does not introduce a second command authority.

## Entry points and Supplier authority

The `内部参与记录` section shows `录入报价` for an eligible Participation without a quotation and `新增 Revision` for a Participation with an authoritative current revision. Supplier choice is restricted to the exact tenant-scoped Supplier IDs already present in `RfqSupplierParticipation`. There is no free-text Supplier ID, name guessing, or static Supplier fallback.

The actions are shown only when the existing signed authorization context contains the exact permission:

- initial response: `procurement.rfq_response.create`
- append revision: `procurement.rfq_response.revise`

If authorization context loading fails, the UI exposes no response action. Backend authorization remains definitive.

## Draft and submitted behavior

`保存草稿` requires at least one quoted RFQ line and permits partial line coverage. A draft does not mark a planned or internally invited Supplier as formally responded, and the server persists `submittedAt = null`.

`记录并提交报价` requires every authoritative RFQ line exactly once, a positive quantity, a non-negative unit price, and a three-letter currency. Frontend validation provides immediate feedback, while backend 422 validation remains authoritative.

RFQ line ID, SKU, item, requested quantity, and unit are read-only source facts. Users edit only quoted quantity, unit price, and optional line delivery date, plus currency and optional commercial terms. The UI sends quantities and prices as strings. It does not send line amount, quotation total, or a calculated total. Decimal(18,4) calculation remains server authority.

## Append-only revisions and expectedVersion

An existing quotation opens the editor as `新增 Revision`. Historical revisions remain read-only. The UI explains that saving creates a new version and does not edit previous history.

Append uses the current maximum authoritative `latestRevision.revisionNumber` as `expectedVersion`; it never derives authority from revision array length. A stale `RFQ_RESPONSE_VERSION_CONFLICT` tells the user to reload and does not silently retry with a changed version.

## Idempotency and reread

Each submission attempt owns a `crypto.randomUUID()` idempotency key sent in the `Idempotency-Key` header. An unchanged payload retry reuses the same key, including after an uncertain network outcome. A changed commercial payload receives a new key on its next attempt. The key is discarded only after success.

After a successful command, the editor closes and the page rereads `GET /api/procurement/documents/rfq/:id`. Participation, quotation summary, server-authoritative total, latest revision, and history are never patched optimistically in the browser.

## Workflow and errors

Response actions are available only for RFQ status `open` or `collecting_quotes`. Draft, closed, cancelled, and unknown RFQ states show that new responses are unavailable. Participation status `declined`, `withdrawn`, or `closed` has no response or reopen action.

The editor distinguishes session expiry, insufficient permission, tenant-masked missing RFQ/Supplier, workflow/version/idempotency/concurrency conflict, invalid commercial input, temporary server failure, and network failure. Version conflicts provide an explicit latest-data reload action.

## Non-goals

This version does not add Comparison UI, Award, recommendation, supplier scoring, automatic selection, PO conversion, Supplier Portal, external login, email invitation, public submission, FX conversion, AI-generated commercial values, AI mutation, RFQ create/edit/close/reopen, Participation reopen, quotation deletion, or revision overwrite/deletion.

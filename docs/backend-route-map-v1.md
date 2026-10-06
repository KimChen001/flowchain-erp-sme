# Backend Route Map v1

## Route Classification

- Read: returns current workspace/read-model state without mutation.
- Preview: prepares reviewable draft data and does not mutate business records.
- Manual/legacy write: existing local workflow write route, not used by AI autonomous execution.

## Auth / Context

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/me` | Read | context route / current users | None | Current user and permissions context. |
| `GET` | `/api/tenants/current` | Read | context route | None | Current tenant settings. |
| `POST` | `/api/auth/login` | Manual/legacy write | local users | Writes login/user event | Local login only. |
| `GET` | `/api/auth/me` | Read | local users | None | Legacy auth profile lookup. |

## AI

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/ai/tools` | Read | AI tool registry | None | Tools are read/draft-first; no autonomous writes. |
| `POST` | `/api/ai/chat` | Read / draft-prep response | AI route and read models | Best-effort audit only | External provider calls are disabled by default; cockpit fast path is local and read-only. |

## Search

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/search` | Read | global business search index | None | Returns canonical focus target shape for supported entities. |

## Today Cockpit

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/today-cockpit` | Read | Today Cockpit read model | None | Aggregates procurement and inventory read models. |

## Sales Demand Read APIs

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/sales-demand/summary` | Read | sales demand read model | None | Customer order counts, delivery risk counts, shortage and reserved quantity totals. |
| `GET` | `/api/sales-demand/orders` | Read | sales demand read model | None | Customer orders with inventory, procurement, supplier, receiving evidence, and data limitations. |
| `GET` | `/api/sales-demand/orders/:id` | Read | sales demand read model | None | Single customer order detail by order id. |
| `GET` | `/api/sales-demand/risks` | Read | sales demand read model | None | Delivery risk rows for customer order review. |
| `GET` | `/api/sales-demand/impact?sku=:sku` | Read | sales demand read model | None | Affected customer orders for a SKU. |
| `GET` | `/api/sales-demand/po-impact?poId=:poId` | Read | sales demand read model | None | Customer orders affected by a purchase order. |

## Evidence Graph Read APIs

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/evidence-graph?entityType=:type&entityId=:id&depth=2` | Read | evidence graph read model | None | Cross-module evidence graph with anchor, nodes, edges, primary path, related records, risk signals, navigation hints, and data limitations. |
| `GET` | `/api/evidence-graph/related?entityType=:type&entityId=:id&depth=2` | Read | evidence graph read model | None | Related records for the selected business object. |
| `GET` | `/api/evidence-graph/sales-order/:id` | Read | evidence graph read model | None | Customer order evidence chain. |
| `GET` | `/api/evidence-graph/sku/:sku` | Read | evidence graph read model | None | SKU supply-demand evidence chain. |
| `GET` | `/api/evidence-graph/purchase-order/:poId` | Read | evidence graph read model | None | Purchase order delivery impact evidence chain. |
| `GET` | `/api/evidence-graph/purchase-request/:prId` | Read | evidence graph read model | None | Purchase request sourcing evidence chain. |
| `GET` | `/api/evidence-graph/rfq/:rfqId` | Read | evidence graph read model | None | RFQ sourcing evidence chain. |
| `GET` | `/api/evidence-graph/receiving/:grnId` | Read | evidence graph read model | None | Receiving evidence chain. |
| `GET` | `/api/evidence-graph/supplier/:supplierIdOrName` | Read | evidence graph read model | None | Supplier operational evidence chain. |
| `GET` | `/api/evidence-graph/invoice/:invoiceId` | Read | evidence graph read model | None | Supplier invoice evidence chain. |

All Evidence Graph routes are GET-only and do not create drafts, write audit events, update inventory, close documents, or send external notifications.

## Procurement Read APIs

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/procurement/documents` | Read | procurement read model | None | PR/RFQ/PO/GRN/invoice/three-way-match rows. |
| `GET` | `/api/procurement/documents/:type/:id` | Read | procurement read model | None | Supports canonical aliases; invalid type returns clean error. |
| `GET` | `/api/procurement/links` | Read | procurement link read model | None | Document relationship graph. |
| `GET` | `/api/procurement/followups` | Read | procurement follow-up read model | None | Open follow-up signals. |
| `GET` | `/api/procurement/summary` | Read | procurement summary read model | None | Stable top-level counts and amounts. |
| `GET` | `/api/procurement/price-history` | Read | issued purchase order lines, items | None | `key=itemId\|unit\|currency` (repeated, at most 50; a PO page adds `excludePurchaseOrder`): the latest PO price and up to 2 earlier ones in the same unit and currency, the weighted average of the last 3, and other units and currencies named, not compared. Prices need `procurement.prices.read`; never fills a price. |

## Inventory Read APIs

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/inventory/items` | Read | inventory read model | None | Item/SKU stock view. |
| `GET` | `/api/inventory/items/:sku` | Read | inventory read model | None | Item detail by SKU/name. |
| `GET` | `/api/inventory/lots` | Read | inventory read model | None | Lots where available. |
| `GET` | `/api/inventory/serials` | Read | inventory read model | None | Serials where available. |
| `GET` | `/api/inventory/movements` | Read | inventory read model | None | Read-only inventory movements. |
| `GET` | `/api/inventory/exceptions` | Read | inventory read model | None | Read-only exception documents. |
| `GET` | `/api/inventory/summary` | Read | inventory read model | None | Counts and risk totals. |
| `GET` | `/api/inventory/availability` | Read | inventory allocation read model | None | SKU availability, ATP, demand-supply gap, risks, evidence, and data limitations. |
| `GET` | `/api/inventory/availability/:sku` | Read | inventory allocation read model | None | Single SKU availability and evidence. |
| `GET` | `/api/inventory/allocation` | Read | inventory allocation read model | None | Alias for allocation-focused availability rows. |
| `GET` | `/api/inventory/allocation/:sku` | Read | inventory allocation read model | None | Single SKU allocation row. |
| `GET` | `/api/inventory/shortages` | Read | inventory allocation read model | None | Blocked, high, or medium allocation risk rows. |
| `GET` | `/api/inventory/demand-supply-gap?sku=:sku` | Read | inventory allocation read model | None | Demand, supply, projected availability, shortage, and linked records. |
| `GET` | `/api/inventory/available-to-promise?sku=:sku` | Read | inventory allocation read model | None | ATP and reservable quantity explanation. |
| `GET` | `/api/inventory/reservation-preview?sku=:sku&salesOrderId=:id&requestedQty=:qty` | Read | inventory allocation read model | None | Preview-only reservation suggestion; does not lock stock. |
| `GET` | `/api/inventory/sales-order-impact?salesOrderId=:id` | Read | inventory allocation read model | None | Inventory allocation impact for a customer order. |
| `GET` | `/api/inventory/po-supply-impact?poId=:id` | Read | inventory allocation read model | None | PO incoming supply impact on SKUs and customer orders. |
| `GET` | `/api/inventory/reorder-list` | Read | inventory allocation read model, items, posted shipments, item suppliers | None | Items to reorder ranked by order-by date from the recorded reorder point and 90-day shipped demand; prepares purchase requests, orders nothing. |
| `GET` | `/api/inventory-movements` | Read | legacy movement route | None | Compatibility movement endpoint. |

## Action Drafts

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/action-drafts/schema` | Read | action draft boundary helper | None | Lists supported draft types and confirmation boundary. |
| `POST` | `/api/action-drafts/preview` | Preview | action draft preview helpers | None | Preview-only; no PR/RFQ/PO creation and no supplier message sending. |

## Audit Log

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/audit-log` | Read | audit log repository | None | Lists existing audit entries with optional filters. |

## Foundation Data / 基础资料

User-visible IA names this area 基础资料. API paths retain `/api/master-data/...` for compatibility.

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/master-data/items` | Read | master data read model | None | Item reference data. |
| `GET` | `/api/master-data/items/:id` | Read | master data read model | None | Item detail by id/SKU/name. |
| `GET` | `/api/master-data/suppliers` | Read | master data read model | None | Supplier reference data. |
| `GET` | `/api/master-data/suppliers/:id` | Read | master data read model | None | Supplier detail by id/name. |
| `GET` | `/api/master-data/warehouses` | Read | master data read model | None | Explicit or inferred warehouses. |
| `GET` | `/api/master-data/payment-terms` | Read | master data read model | None | Payment term references. |
| `GET` | `/api/master-data/tax-codes` | Read | master data read model | None | Tax code references only; no tax filing. |

## Planning / Market / Supplier Reads

| Method | Path | Class | Source | Mutation | Notes |
|---|---|---|---|---|---|
| `GET` | `/api/mrp-plan` | Read | MRP route/domain | None | Planning output. |
| `GET` | `/api/sop-cycle` | Read | S&OP route/domain | None | S&OP cycle. |
| `POST` | `/api/sop-cycle` | Manual/legacy write | S&OP route/domain | Writes local cycle | Manual local write. |
| `GET` | `/api/supplier-performance` | Read | supplier performance helper | None | Supplier scoring view. |
| `GET` | `/api/supplier-recommendations` | Read | supplier recommendation helper | None | Sourcing recommendation view. |
| `GET` | `/api/external-signals` | Read | market route | May refresh remote signals | Not an AI provider call. |
| `GET` | `/api/market-prices` | Read | market route | None | Market price cards. |
| `POST` | `/api/market-prices/refresh` | Manual/legacy write | market route | Writes local market data | Local refresh only. |

## Legacy Procurement Workflow Routes

These routes remain for compatibility/manual local workflow surfaces. They are not invoked by AI autonomous actions.

| Method | Path | Class | Source | Mutation |
|---|---|---|---|---|
| `GET` | `/api/purchase-requests` | Read | legacy workflow route | None |
| `POST` | `/api/purchase-requests` | Manual/legacy write | workflow domain | Creates local PR |
| `PATCH` | `/api/purchase-requests/:pr/status` | Manual/legacy write | workflow domain | Changes local PR status |
| `POST` | `/api/purchase-requests/:pr/convert-to-po` | Manual/legacy write | workflow domain | Creates local PO |
| `GET` | `/api/rfqs` | Read | legacy workflow route | None |
| `POST` | `/api/rfqs` | Manual/legacy write | workflow domain | Creates local RFQ |
| `PATCH` | `/api/rfqs/:id/status` | Manual/legacy write | workflow domain | Changes local RFQ status |
| `GET` | `/api/purchase-orders` | Read | legacy workflow route | None |
| `POST` | `/api/purchase-orders` | Manual/legacy write | workflow domain | Creates local PO |
| `PATCH` | `/api/purchase-orders/:po/status` | Manual/legacy write | workflow domain | Changes local PO status |
| `GET` | `/api/receiving-docs` | Read | legacy receiving route | None |
| `POST` | `/api/receiving-docs` | Manual/legacy write | receiving workflow | Creates local GRN |
| `PATCH` | `/api/receiving-docs/:grn` | Manual/legacy write | receiving workflow | Updates/posts local GRN |

## Safety Notes

- Default persistence is local JSON workspace data.
- See [Route mutation classification](route-mutation-classification-v1.md) for the complete database-mode v1 guard. In explicit database mode, read-only and preview-only routes remain available while legacy mutation routes are blocked until migrated.
- External AI provider access is disabled by default.
- Action drafts are preview-only.
- No full finance/GL/payment/tax execution exists.
- Future database adapters should preserve these contracts before replacing JSON behavior.

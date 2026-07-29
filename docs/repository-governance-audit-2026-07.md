# FlowChain Repository Governance Audit

Date: 2026-07-29
Product boundary: AI-native Supply Chain Operating Platform for SMEs

## Executive conclusion

FlowChain should continue, not pivot away from the AI-native SME supply-chain
platform thesis.

The repository already contains a credible authoritative core: tenant-scoped
supplier and item masters, purchase requests, RFQs, quotations, purchase
orders, receiving, inventory, workflow/audit evidence, durable sales/outbound
facts, Universal Intake, and an AI layer that returns evidence and review-first
actions. The main risk is not a missing product foundation. It is accumulated
surface area and blurred module ownership.

The strongest evidence:

- PostgreSQL is the only production repository mode.
- Core read and command paths are tenant scoped and covered by contract tests.
- AI responses have evidence, limitation, navigation, and review boundaries.
- The schema contains a coherent procurement-to-inventory chain.
- The application has 159 registered frontend routes and 109 Prisma models,
  which is too broad for the stated SME platform boundary.
- Finance, settlement, bank reconciliation, returns, mobile sync, pilot
  governance, and duplicated historical workbenches compete with the core for
  architecture and test attention.

The recommendation is to narrow the default product, retain operational
finance and outbound behavior as extensions, and freeze bank/payment-adjacent
expansion until the core procurement and inventory experience is smaller and
more maintainable.

## Scan scope and evidence

The audit covered `src/`, `server/`, `shared/`, `prisma/`, `scripts/`, `tests/`,
configuration, package metadata, and recent Git history.

Repository snapshot before this cleanup:

- 1,088 tracked/source files in the audited tree.
- 291 non-test TypeScript frontend files.
- 268 non-test JavaScript backend files.
- Static import reachability from `src/main.tsx`: 152 reachable, 139 not
  reachable.
- Static import reachability from `server/index.mjs`: 222 reachable, 46 not
  reachable.
- 159 frontend route definitions.
- 109 Prisma models.
- 63 source files over 500 lines; 17 over 1,000 lines.

Reachability is a triage signal, not deletion authority. Dynamic loading,
test-only imports, design history, and string-based contract tests were checked
before any deletion.

## Architecture map

### Current

```text
React entry
  -> FlowChainApp (auth, navigation, capability guard, search, AI shell, panel dispatch)
  -> routeRegistry (159 route definitions)
  -> module pages/workbenches
  -> api-client / direct fetch calls
  -> server/bootstrap/scm-server (HTTP, auth, guards, route context, static files)
  -> server/bootstrap/route-dispatcher (ordered handler chain)
  -> route handlers
  -> a mix of route orchestration and large domain services
  -> db repositories / direct Prisma services
  -> PostgreSQL
```

### Intended

```text
Frontend module
  -> typed API boundary
  -> thin route handler
  -> module application service
  -> domain policy/calculation
  -> repository interface
  -> PostgreSQL adapter

AI module
  -> bounded context/evidence service
  -> recommendation/navigation/review-first action
  -> explicit integrations
```

### Mismatch

| Concern | Current mismatch | Target |
| --- | --- | --- |
| Composition | One 1,173-line bootstrap still builds a broad route context and dispatches every module | HTTP/bootstrap separated from module registrars |
| Frontend routing | A 2,274-line registry and 1,852-line app shell know every module | Route metadata split by product module; shell owns only cross-cutting behavior |
| Domain boundaries | Inventory, returns, finance, AI, and settlement services exceed 1,000 lines | Read service, command service, policy, and repository roles split by module |
| Product scope | Finance has 21 routes, inventory 27, and several internal governance modules are first-class navigation | Core default navigation plus explicit extensions/internal tools |
| Historical UI | Old panels remain source- and test-coupled after replacement screens shipped | Archive/delete after contract migration |
| Test architecture | Several tests read component source files and exact filenames | Behavior/API/browser contracts independent of historical file layout |

## Frontend to database alignment

| Product page | Frontend | API | Server owner | Database authority | Status |
| --- | --- | --- | --- | --- | --- |
| Supplier list/detail | `src/modules/srm/Page.tsx` via master-data route panel | `/api/master-data/suppliers*` | `master-data.routes.mjs` | `Supplier`, item-supplier relations through master-data repository | CORE / PostgreSQL |
| Item master | `ItemMasterWorkbench.tsx` and master-data pages | `/api/master-data/items*` | `master-data.routes.mjs` | `Item`, warehouse relations | CORE / PostgreSQL |
| Procurement workbench | `src/modules/procurement/*` | `/api/procurement/requests`, `/orders`, `/documents` | procurement workflow/read routes | PR, RFQ, quotation, PO repositories | CORE / PostgreSQL |
| Purchase request | `CanonicalProcurementPanel.tsx` | `/api/procurement/requests*` | `procurement-workflow.routes.mjs` | PR command/read authority | CORE / PostgreSQL |
| RFQ | canonical procurement navigation and `/api/rfqs` | `/api/rfqs`, procurement workflow endpoints | `rfqs.routes.mjs`, procurement workflow | `Rfq`, `RfqLine`, quotation models | CORE reads; legacy mutations fail closed |
| Purchase order | `src/modules/purchasing/Page.tsx` | `/api/purchase-orders-workbench`, `/api/procurement/orders` | purchase-order/procurement routes | `PurchaseOrder`, lines, receiving/invoice evidence | CORE / PostgreSQL |
| Receiving | `src/modules/receiving/Page.tsx`, `ReceivingPostingWorkbench.tsx` | `/api/receiving-docs`, `/api/procurement/receiving/:id*` | receiving routes/services | receiving documents/lines and inventory ledger | CORE reads; posting is gated beta |
| Inventory | `src/modules/inventory/Page.tsx` | `/api/inventory/balances`, movements, lots, serials, exceptions | inventory routes/services | inventory balance, movement, lot, serial, exception | CORE / PostgreSQL |
| Dashboard | `src/modules/overview/Page.tsx` | `/api/home/overview` | business-read-context route/service | repository-backed cross-module projection | CORE / PostgreSQL |
| AI assistant | `src/modules/ai-assistant/Panel.tsx` | `/api/ai-runtime/respond`, readiness | AI runtime routes/services | bounded repository evidence; provider is optional | CORE AI layer |
| Sales/outbound | `OutboundWorkbench.tsx` and sales pages | `/api/sales/*` | sales/outbound routes/services | sales orders, reservations, shipments | EXTENSION, currently durable |
| Operational finance | finance workbenches | `/api/finance/*` | operational-finance routes/services | invoice/match/obligation/settlement models | EXTENSION, feature-flagged |
| Bank reconciliation | bank workbench | `/api/bank-*` / reconciliation routes | bank reconciliation routes/services | imported statement evidence and matches | FREEZE as optional integration |
| Forecast/MRP | forecast page | capability-disabled APIs | MRP/capability routes | no authoritative planning model | FREEZE until authoritative inputs exist |
| Legacy imports | retired import page | capability-disabled legacy endpoints | pilot-import route | none | DELETE/archive path; Universal Intake replaces it |

### Static and disconnected UI findings

- `src/data/empty-business-state.ts` and the active sales/inventory data files
  contain empty initialization collections, not business facts.
- The forecast page still imports empty placeholder collections while its
  server capability is unavailable. Keep the route gated; do not present it as
  a working planner.
- Several former procurement, SRM, overview, and inventory components are not
  reachable from the current frontend entry, but source-reading tests still
  refer to them. They must be archived only after those tests are replaced.
- Direct screen/API duplication exists between generic procurement pages,
  purchase-request workbenches, purchasing pages, and receiving pages.

## Prisma model classification

### CORE

Tenant and access:
`Tenant`, `User`, `TenantRole`, `TenantRolePermission`,
`UserRoleAssignment`, `UserWarehouseScope`, `WorkspaceInvitation`.

Master data:
`Supplier`, `Item`, `Warehouse`, `WarehouseLocation`, `PaymentTerm`,
`TaxCode`, `CustomFieldDefinition`, `CustomFieldRevision`,
`CustomFieldOption`.

Intake and documents:
`InboundArtifact`, `IntakeBatch`, `IntakeRecord`, `MappingProfile`,
`IntakeSchemaSnapshot`, `FieldMapping`, `ValidationIssue`,
`ReviewSession`, `CommitAttempt`, `SourceReference`, `DocumentLink`,
`StagedUpload`, `ReceivingAttachment`.

Procurement:
`PurchaseRequest`, `PurchaseRequestLine`, `Rfq`, `RfqLine`,
`SupplierQuotation`, `SupplierQuotationLine`, `PurchaseOrder`,
`PurchaseOrderLine`, `ReceivingDocument`, `ReceivingLine`,
`ProcurementFollowup`.

Inventory and workflow:
`InventoryBalance`, `InventoryLot`, `InventorySerial`,
`InventoryMovement`, `InventoryException`, `ActionDraft`,
`ActionDraftValidation`, `ActionDraftAuditTrail`, `AuditLog`,
`AiEvidence`, `BusinessCommandExecution`, `RuntimeRecord`.

### EXTENSION

Operational invoice matching:
`SupplierInvoice`, `SupplierInvoiceLine`, `ThreeWayMatch`,
`ThreeWayMatchLine`, `FinanceMatchException`, `PayableObligation`,
`SupplierCreditMemo`, `SupplierCreditMemoLine`.

Outbound:
`SalesOrder`, `SalesOrderLine`, `InventoryReservation`,
`InventoryReservationEvent`, `ShipmentDocument`, `ShipmentLine`,
`ShipmentAllocation`, `CustomerInvoice`, `CustomerInvoiceLine`,
`ReceivableObligation`, `CustomerCreditNote`, `CustomerCreditNoteLine`.

Advanced inventory:
`QuarantineInventoryBalance`, `StockTransferDocument`,
`StockTransferLine`, `StockTransferLeg`, `CycleCountSession`,
`CycleCountLine`, `InventoryAdjustmentDocument`,
`InventoryAdjustmentLine`, `ReturnRequest`, `ReturnRequestLine`,
`ReturnAuthorization`, `ReturnAuthorizationLine`,
`ReturnPostingDocument`, `ReturnPostingLine`,
`QuarantineDispositionAllocation`.

Integration/runtime:
`DomainChangeFeed`, `SyncClient`, `SyncSnapshotSession`,
`ImportBatch`, `ImportIssue`.

### REMOVE/FREEZE

Keep migrations intact, but stop adding product behavior to:

`CashbookAccount`, `CashbookEntry`, `SettlementDocument`,
`SettlementAllocation`, `PartnerAdvance`, `AdvanceApplicationDocument`,
`InternalTransferDocument`, `SettlementAttachment`,
`BankStatementMappingTemplate`, `BankStatementImportBatch`,
`BankStatementImportRow`, `BankStatementLine`,
`BankReconciliationCandidate`, `BankReconciliationGroup`,
`BankReconciliationBankLineAllocation`,
`BankReconciliationCashbookAllocation`, `BankReconciliationException`.

These models support internal settlement or reconciliation evidence. They must
not evolve into payment execution, cash management, general ledger, tax filing,
or banking functionality. A later schema release can move them to a dedicated
extension schema/package; dropping them now would be destructive and is not
recommended.

## File disposition register

| File or group | Purpose/current usage | Problem | Decision |
| --- | --- | --- | --- |
| `server/bootstrap/scm-server.mjs` | Production composition root | Still combines HTTP, auth, route context, static files, and compatibility helpers | REFACTOR incrementally |
| `server/bootstrap/route-dispatcher.mjs` | Ordered route chain | Correctly isolates dispatch, but remains a flat core/extension/internal list | REFACTOR into registrars after route classification is unified |
| `server/routes/scm-legacy.routes.mjs` | Former misleading location of composition root | Name described an obsolete architecture | MOVE completed |
| `server/repositories/db-*.mjs` | PostgreSQL adapters | Correct authoritative boundary | KEEP |
| `server/repositories/adapter-registry.mjs` | Repository composition and JSON rejection | Correct single production mode | KEEP |
| `server/domain/test-fixtures/` | Explicit test facts | Correct isolation | KEEP |
| `server/routes/*finance*`, `*bank*` | Optional operational finance/reconciliation | Outside default core | MOVE behind extension registrar |
| `server/domain/*settlement*`, `*bank*` | Settlement/reconciliation policy | Too much non-core ownership | FREEZE / extension |
| `server/domain/inventory-operations-command-service.mjs` | Inventory commands | 2,052-line God service | REFACTOR by operation |
| `server/domain/operational-finance-command-service.mjs` | Finance commands | 1,646 lines and non-core | FREEZE then split only when maintained |
| `server/routes/ai.routes.mjs` | Legacy and rich AI query surface | 1,106 lines overlapping runtime gateway | REFACTOR to one AI application facade |
| `src/app/routeRegistry.tsx` | Route metadata | 2,274 lines, all modules coupled | REFACTOR into module route manifests |
| `src/app/FlowChainApp.tsx` | Global shell | 1,852 lines and owns panel registry plus AI workflow | REFACTOR into shell, route outlet, AI host |
| `src/modules/ai-assistant/Panel.tsx` | AI interaction | 1,878 lines | REFACTOR presentation/state/actions |
| `src/modules/purchasing/Page.tsx` | PO list/detail | 1,079 lines | REFACTOR list/detail/evidence sections |
| `src/modules/receiving/Page.tsx` | Receiving UI | 972 lines and legacy/canonical paths coexist | REFACTOR toward canonical receiving |
| `src/modules/procurement/*.tsx` historical panels | Prior contracts, returns, invoice and match screens | Replaced/disconnected, some source-test coupling | ARCHIVE after test migration |
| `src/modules/overview/TodayCockpitPanel.tsx` | Prior cockpit component | Disconnected, heavily referenced by source-reading tests | ARCHIVE after behavior tests replace source tests |
| `src/modules/inventory/Inventory*Page.tsx` historical pages | Prior warning/adjustment/exception UIs | Duplicated by current workbenches | ARCHIVE/DELETE after route audit |
| `src/modules/suppliers/Page.tsx` | Older supplier page | Duplicates canonical SRM-backed master-data view | DELETE after source contract migration |
| `src/app/components/ui/` unused template components | Generated component library | Large unreachable scaffold and dependency drag | DELETE in a dedicated UI-prune change |
| Empty barrel/domain/provider stubs | Placeholder architecture | No implementation and no imports | DELETE completed |
| Historical architecture docs | Record prior JSON/prototype phases | Some read as current state | ARCHIVE or label historical |

## Cleanup executed in this pass

- Renamed package identity from the Figma prototype name to
  `@flowchain/erp-sme`.
- Removed 12 dependencies with no source, script, or stylesheet references:
  Emotion, MUI, Popper, confetti, date-fns, react-dnd packages, react-popper,
  responsive masonry, and react-slick.
- Moved the production server composition root from the misleading
  `server/routes/scm-legacy.routes.mjs` path to
  `server/bootstrap/scm-server.mjs`.
- Extracted the ordered handler chain into
  `server/bootstrap/route-dispatcher.mjs`; bootstrap now has one dispatch call,
  and contract tests protect ordering and short-circuit behavior.
- Updated composition-root contract tests to the canonical bootstrap path.
- Deleted 31 confirmed empty source stubs and empty barrel files.
- Replaced the stale JSON-era backend route audit with the current
  PostgreSQL-only route authority.

## Dependency security

After unused dependency pruning, `npm audit --omit=dev` reports eight production
dependency findings:

- `react-router` and `undici`: high-severity advisories with upgrades outside
  current pinned ranges.
- `fast-uri`: high-severity transitive advisory with a normal fix path.
- `xlsx`: high-severity advisories with no upstream fix in the installed
  package line.
- Prisma development transitive packages: moderate advisories requiring a
  Prisma upgrade.

Do not apply `npm audit fix --force` blindly. Priorities are:

1. Upgrade and regression-test `react-router` and `undici`.
2. Replace or sandbox `xlsx`; Universal Intake should not accept unbounded
   untrusted workbooks through a vulnerable parser.
3. Upgrade Prisma as a dedicated migration/toolchain change.
4. Apply the compatible `fast-uri` resolution and verify the lockfile.

## Next development priorities

1. Core navigation and route manifests: split `routeRegistry.tsx` by module and
   hide extension/internal modules from the default product.
2. Core server modularization: extract a route registrar from
   `scm-server.mjs`, beginning with procurement and inventory.
3. Test decoupling: replace tests that read historical component files with API
   and browser behavior contracts, then delete the disconnected screens.
4. Canonical procurement convergence: one PR/RFQ/PO/receiving route family and
   one frontend workbench family.
5. Security upgrades: router, HTTP client, workbook parser, then Prisma.
6. Extension packaging: operational finance/outbound/mobile behind explicit
   manifests; bank and settlement remain frozen.

## Pivot decision

Do not pivot to a generic ERP or a finance suite. Continue as an AI-native SME
supply-chain operating platform.

The codebase supports that direction, but only if product scope is enforced:
procurement, supplier, receiving, inventory, evidence, workflow, documents, and
AI-assisted exception handling are the default product. Sales/outbound and
operational invoice matching are optional extensions. Banking, payment
execution, accounting, tax, HR, and CRM are integrations or out of scope.

# Roadmap v1

## Product Direction

FlowChain is an AI-assisted inventory, sales-demand, procurement, and supplier operations platform for SMEs. The roadmap keeps the product focused on evidence-backed operations workflows rather than full ERP replacement.

FlowChain uses the familiar SME inventory/ERP object skeleton for orientation: foundation data, purchasing, sales demand, inventory, settlement visibility, reports, and system controls. It does not try to replace a full ERP suite.

## Phase 0 Product Positioning and Language Governance

- Reposition FlowChain around SME inventory, sales-demand, procurement, supplier operations, and finance-collaboration exceptions.
- Standardize user-visible copy in simplified Chinese for China SME users.
- Keep internal enums, adapter names, and draft types out of visible UI.
- Document allowed business abbreviations such as SKU, MRP, RFQ, PO, PR, and GRN with Chinese meaning.

## Phase 1 Sales Demand Lite

- Add lightweight sales demand and customer order visibility.
- Keep scope limited to demand evidence and customer order signals.
- Current foundation: read-only customer order list, delivery risk summary, SKU impact, PO-to-sales impact, Today Cockpit sales risk card, global search target, and deterministic AI answers.
- Current IA: sales demand is organized as Customer Orders, Delivery Risk, and Order Evidence Chain. It does not include CRM, leads, customer lifecycle, sales contracts, receivables, invoicing, collections, tax, or bank/payment execution.
- Do not build a full CRM or customer lifecycle suite.

## Phase 2 Inventory Allocation

- Explain available quantity, reserved quantity, in-transit quantity, and shortage quantity.
- Connect stock risk to demand and procurement evidence.
- Current implementation scope: Inventory Allocation / Availability / Available to Promise / Reservation Preview foundation completed.
- Make allocation evidence explicit across customer orders, inventory item availability, open PO receipts, suppliers, receiving records, and shortage reasons.
- Keep transfer, FEFO, variance, and inventory-impact surfaces review-first and preview-only.
- Provide generic internal notification draft product slots without external sending.
- Do not build complex WMS execution.

## Phase 3 Demand-to-Procurement Evidence Chain

- Link sales demand, shortage signals, PR, RFQ, PO, GRN, supplier, and invoice exception evidence.
- Make evidence navigation and recovery paths stable for daily operations.
- Keep relationship and evidence resolvers read-only.
- Current implementation scope: Phase 3A Evidence Graph foundation with read-only nodes, edges, primary evidence path, related records, risk signals, navigation hints, and data limitations.
- Current focus: Phase 3B ERP information architecture cleanup, including Sales Demand split views, supplier performance/risk consolidation, foundation data/data quality/reports naming, workbench discipline, and review decision guardrails.
- Next focus: Phase 3C Evidence Graph UI / Related Records / Return Path and AI Evidence Graph Integration.

## Information Architecture Discipline

- Foundation Data / 基础资料 is for business object reference data such as items, suppliers, warehouses, categories, units, terms, and tax codes. It does not perform reporting analysis.
- Data Intake and Quality / 数据接入与质量 is for import, mapping, validation, import history, quality checks, missing-data review, and templates. It does not perform business approvals.
- Reports and Analytics / 报表与分析 is for summaries, trends, analysis, and export. It does not edit business data.
- Supplier portal capability is not currently provided. The roadmap does not include external supplier accounts, supplier login, supplier self-service profile maintenance, online PO confirmation, or online invoice submission in the current scope.
- Workbench, dashboard, and cockpit surfaces show summary counts, pending counts, risk counts, top-priority lists, evidence links, and draft preview entry points only.
- Detailed review actions are embedded in the corresponding business object detail, drawer, or review panel. Do not add a standalone review center.
- Reject, request-changes, and cancel decisions must require a reason.
- Future sales expansion can include sales overview, inventory reservation suggestions, supply-demand gaps, customer communication drafts, and order import, but empty menu shells should not be added before content exists.

## Phase 4 AI Control Tower v2

- Improve Today Cockpit and AI Assistant evidence quality.
- Keep providers disabled by default.
- Keep all AI answers evidence-backed and non-mutating.

## Phase 5 Review-first Action Workflow

- Expand review-first drafts for procurement, supplier follow-up, exception case, and notification workflows.
- Require user confirmation for any future safe write.
- Do not allow autonomous AI execution.

## Phase 6 DB Persistence, Tenant Isolation, RBAC, Audit

- Introduce database-backed persistence behind repository adapters.
- Add tenant isolation, user roles, permissions, and audit logs.
- Keep local JSON-backed behavior available for development until explicitly replaced.

## Phase 7 Collaboration Notification Draft Adapters

- Prepare notification drafts and task handoff payloads.
- Do not send real external messages by default.
- Keep user review and confirmation in the loop.
- Future adapter candidates: Email, Slack, Microsoft Teams, DingTalk, WeCom, Feishu.

## Phase 8 Deployment and Launch Hardening

- Harden build, deployment, configuration, monitoring, error handling, and security.
- Keep production-readiness claims tied to implemented infrastructure.

## Phase 5.4 Universal Intake

### Phase 5.4A Domain Foundation

- Introduce tenant-scoped artifacts, batches, records, versioned mappings,
  validation issues, reviews, blocked commit attempts, and source references.
- Keep binary content outside PostgreSQL behind an artifact-storage port.
- Enforce payload safety, permission separation, audit, and batch transitions.
- Expose a preview-only foundation behind explicit capability enablement.
- Keep every business-object commit adapter fail-closed.
- Make Universal Intake the sole forward-looking intake authority.
- Retire legacy Pilot Import production routes and direct business-table writes;
  retain `ImportBatch`/`ImportIssue` only as non-authoritative history.

### Phase 5.4B Schema-Aware Structured Intake

- Bounded CSV/XLSX/Paste parsing for Supplier, Item, and Customer.
- Canonical versioned schemas, tenant custom fields, immutable schema
  snapshots, deterministic mapping, normalization evidence, validation, and
  review controls.
- Parser-owned records; public direct record insertion is retired.
- Business commit stays fail-closed.

### Phase 5.4C Governed Business Commit Adapters

- Introduce allowlisted, object-specific commit adapters only after the 5.4B
  parsing and review contracts pass.
- Preserve tenant scope, permission separation, audit evidence, idempotency,
  and human approval.
- Do not restore the retired Pilot Import write path.

### Later configuration and unstructured intake

- Dynamic Form Foundation and conditional field rules.
- Workflow configuration and AI-assisted configuration.
- Unstructured Email/PDF/Voice/Chat Intake.

## Non-goals

- Not a full ERP replacement.
- No full finance/GL.
- No HR/payroll.
- No CRM/customer lifecycle suite.
- No bank/payment execution.
- No tax filing.
- No autonomous AI execution.

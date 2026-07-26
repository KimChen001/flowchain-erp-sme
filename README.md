# FlowChain — ERP & Inventory-Purchase-Sales (进销存) Collaboration Platform for SMEs

FlowChain is an ERP and inventory-purchase-sales (进销存) collaboration platform for SMEs. It gives operations teams one workspace to run purchase orders, receiving, inventory, sales demand, supplier collaboration, and invoice matching, backed by an AI evidence layer and review-first controls.

FlowChain 是面向中小企业的 ERP 进销存协同平台。系统以工作区数据为基础，统一支撑采购、收货、库存、销售需求、供应商协同与发票匹配的业务闭环，并以 AI 证据链、交付风险分析和权限边界保障运营可控。

FlowChain 覆盖中小企业进销存 ERP 的对象骨架：基础资料、采购、销售、库存、结算、报表和系统管理。差异化重点是 AI 证据链、交付风险分析、库存可承诺量、可复核动作草稿和数据质量说明。

## Current Product State

FlowChain 已形成采购、库存、销售需求、供应商协同与发票匹配的进销存业务闭环。

当前核心入口：

- 今日行动
- AI 建议
- AI 助手
- 核心业务链
- 数据接入与质量
- 角色权限 / 业务审计 / 工作区边界
- 人工复核草稿

当前边界：

- 证据解释
- 草稿预览
- 人工复核
- 不提交
- 不外发
- 不写库存
- 不写财务凭证
- 不处理资金
- 不修改供应商主数据
- 不覆盖当前工作区数据

## Current Status

FlowChain runs on a PostgreSQL-only authoritative runtime. `DATABASE_URL` is
required; the removed JSON persistence mode and production fixture fallbacks
fail closed.

Universal Intake is entering a preview-only foundation phase. It defines
tenant-scoped artifacts, batches, records, mappings, validation, and review,
but does not yet parse complete CSV/XLSX workbooks or commit imported data into
business tables.

## Core Modules

- Daily Workbench / 每日工作台
- Sales Demand / Customer Orders Lite
- Inventory Allocation / Availability / Available to Promise
- Evidence Graph / Cross-module Evidence Links
- Demand-to-Procurement Links
- Procurement / P2P
- Purchase Request
- RFQ / supplier quotation
- Purchase Order
- Receiving / GRN
- Inventory and inventory exceptions
- Supplier operations / SRM
- Foundation Data / 基础资料
- Data Intake and Quality / 数据接入与质量
- Reports and Analytics / 报表与分析
- Forecast / MRP
- AI Assistant
- Finance collaboration visibility

## Scope Boundaries

FlowChain focuses on the inventory-purchase-sales (进销存) ERP core and its supplier collaboration and finance-matching layers. The following adjacent enterprise systems are out of scope for this platform and are expected to integrate rather than be rebuilt inside FlowChain:

- general ledger and statutory accounting;
- HR and payroll;
- CRM and customer lifecycle management;
- bank and payment execution;
- tax filing.

AI-assisted actions are review-first: the system prepares drafts and explanations, and a person confirms before purchase orders are issued, supplier emails are sent, inventory is posted, invoices are approved, payments are executed, or supplier master data is changed.

Supplier-facing portal capability is on the roadmap but not yet enabled: FlowChain does not currently create external supplier accounts, supplier logins, supplier self-service profile maintenance, online PO confirmation, or online invoice submission.

Workbench/dashboard/cockpit surfaces are summary and navigation surfaces. They show pending counts, risk counts, top priority lists, evidence links, and document entry points. Detailed actions belong in the corresponding business document detail, drawer, or review panel, where reject, request-changes, and cancel decisions include a reason.

## Run Locally

```bash
npm install
npm run api
```

In another terminal:

```bash
npm run dev
```

The frontend proxies `/api` requests to `http://127.0.0.1:8787`.

## Validate

```bash
npm test
npm run test:harness
npm run typecheck
npm run build
```

`npm run build` may report Vite chunk-size warnings; those warnings do not indicate a failed build.

## Key Backend APIs

Read and preview APIs:

- `GET /api/me`
- `GET /api/tenants/current`
- `GET /api/search`
- `GET /api/today-cockpit`
- `GET /api/sales-demand/summary`
- `GET /api/sales-demand/orders`
- `GET /api/sales-demand/orders/:id`
- `GET /api/sales-demand/risks`
- `GET /api/sales-demand/impact?sku=:sku`
- `GET /api/sales-demand/po-impact?poId=:poId`
- `GET /api/procurement/documents`
- `GET /api/procurement/documents/:type/:id`
- `GET /api/procurement/links`
- `GET /api/procurement/followups`
- `GET /api/procurement/summary`
- `GET /api/inventory/items`
- `GET /api/inventory/items/:sku`
- `GET /api/inventory/lots`
- `GET /api/inventory/serials`
- `GET /api/inventory/movements`
- `GET /api/inventory/exceptions`
- `GET /api/inventory/summary`
- `GET /api/inventory/availability`
- `GET /api/inventory/availability/:sku`
- `GET /api/inventory/allocation`
- `GET /api/inventory/allocation/:sku`
- `GET /api/inventory/shortages`
- `GET /api/inventory/demand-supply-gap?sku=:sku`
- `GET /api/inventory/available-to-promise?sku=:sku`
- `GET /api/inventory/reservation-preview?sku=:sku&salesOrderId=:salesOrderId&requestedQty=:qty`
- `GET /api/inventory/sales-order-impact?salesOrderId=:salesOrderId`
- `GET /api/inventory/po-supply-impact?poId=:poId`
- `GET /api/evidence-graph?entityType=:type&entityId=:id&depth=2`
- `GET /api/evidence-graph/related?entityType=:type&entityId=:id&depth=2`
- `GET /api/evidence-graph/sales-order/:id`
- `GET /api/evidence-graph/sku/:sku`
- `GET /api/evidence-graph/purchase-order/:poId`
- `GET /api/evidence-graph/purchase-request/:prId`
- `GET /api/evidence-graph/rfq/:rfqId`
- `GET /api/evidence-graph/receiving/:grnId`
- `GET /api/evidence-graph/supplier/:supplierIdOrName`
- `GET /api/evidence-graph/invoice/:invoiceId`
- `GET /api/master-data/items`
- `GET /api/master-data/suppliers`
- `GET /api/action-drafts/schema`
- `POST /api/action-drafts/preview`
- `GET /api/ai/tools`
- `POST /api/ai/chat`

Legacy/manual local write routes still exist for compatibility, including purchase request, RFQ, purchase order, receiving, forecast, S&OP, login, and market-signal routes. The AI and draft-first surfaces do not autonomously execute those writes.

## AI Safety

External AI providers are disabled by default. Placeholder `OPENAI_API_KEY`, `ARK_API_KEY`, or `DOUBAO_API_KEY` values do not enable provider calls.

Cockpit-style prompts such as `今天最需要处理什么？` use a deterministic local fast path backed by Today Cockpit, procurement, inventory allocation, supplier, evidence graph, and planning read models. Unsupported prompts return guided, review-first responses when providers are disabled.

## Draft-first Actions

AI and Today Cockpit actions prepare reviewable drafts rather than executing business writes.

Current draft previews include:

- purchase request drafts;
- RFQ drafts;
- supplier follow-up drafts;
- exception case drafts.

Drafts remain preview-only and require user review before any future confirmed workflow can continue.

## Documentation Map

Start here:

- [Docs index](docs/README.md)
- [Product language and positioning](docs/product-language-and-positioning-v1.md)
- [Product narrative](docs/product-narrative-v1.md)
- [Productization final closure](docs/productization-final-closure-v1.md)
- [Final operating readiness checklist](docs/final-operating-readiness-checklist-v1.md)
- [Final acceptance checklist](docs/final-acceptance-checklist-v1.md)
- [Product scope and boundary](docs/product-scope-and-boundary-v1.md)
- [Current development limitations](docs/current-development-limitations-v1.md)
- [Architecture overview](docs/architecture-overview-v1.md)
- [Backend route map](docs/backend-route-map-v1.md)
- [Repository boundary](docs/repository-boundary-v1.md)
- [JSON adapter contract tests](docs/json-adapter-contract-tests-v1.md)
- [Persistence mode and adapter registry](docs/persistence-mode-and-adapter-registry-v1.md)
- [Draft and audit repository adapter](docs/action-draft-audit-repository-adapter-v1.md)
- [Master Data repository adapter](docs/master-data-repository-adapter-v1.md)
- [Procurement and Inventory read repository adapters](docs/procurement-inventory-read-repository-adapters-v1.md)
- [Roadmap](docs/roadmap-v1.md)
- [AI safety and draft-first explainer](docs/ai-safety-and-draft-first-explainer-v1.md)

## Current Limitations

- No production database.
- No ORM-backed production runtime.
- No autonomous AI execution.
- No complex WMS execution.
- No automatic WMS release.
- No automatic stock transfer posting.
- No automatic inventory reservation or stock lock.
- No automatic outbound shipment or inventory posting.
- No automatic inventory mutation.
- No automatic creation or closure of business documents.
- No real supplier message sending from drafts.
- No real external collaboration notification sending.
- No payment execution.
- No tax filing.
- No full finance/GL.
- No HR/payroll.
- No CRM/customer lifecycle suite.
- No sales order confirmation, shipment execution, invoicing, receivables, or customer notification automation.
- No bank integration.

## Roadmap

- Phase 0 Product positioning and language governance
- Phase 1 Sales Demand Lite
- Phase 2 Inventory Allocation
- Phase 3 Evidence Graph / Demand-to-Procurement Evidence Chain
- Phase 4 AI Control Tower v2
- Phase 5 Review-first Action Workflow
- Phase 6 DB persistence, tenant isolation, RBAC, audit
- Phase 7 Collaboration Notification Draft Adapters: Email, Slack, Microsoft Teams, DingTalk, WeCom, Feishu
- Phase 8 deployment and launch hardening

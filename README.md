# FlowChain

**Purchasing, inventory and sales operations for small and medium businesses, with an AI assistant that answers from your own records and never changes them.**

FlowChain is an ERP and inventory-purchase-sales (进销存) collaboration platform for SMEs. One team can take a purchase from request to received goods and a matched invoice, keep inventory accurate, and ship customer orders. The assistant explains what needs attention and cites the records behind every answer.

[中文简介](#中文简介)

## What it covers

| Area | What you can do |
| --- | --- |
| **Today** | See the day's priorities across purchasing, inventory and sales, with links to the records behind them. |
| **Purchasing** | Purchase requests, RFQs with supplier quotes and awards, and purchase orders from submit and approval through issue. Promised-date changes keep the original date and need a reason. |
| **Purchase fulfillment** | Receiving (GRN): draft, post and reverse, with an impact preview before posting. |
| **Inventory** | Balances, lots and serials, movements, availability and available-to-promise, plus transfers, cycle counts and adjustments. |
| **Sales** | Sales orders (confirm, hold, resume), reservations and shipments, each posted after a preview. |
| **Suppliers** | Supplier records and a scorecard: on time, in full and OTIF, measured against the original promise. |
| **Items** | Item, warehouse and customer master data. |
| **Finance** | Supplier invoices with three-way match (PO, receipt, invoice), payables, customer invoices, receivables and credit notes. |
| **Reports** | Dashboards for overview, purchasing, sales, inventory, finance and suppliers, a report catalog and export. |
| **AI assistant** | Questions about today's work, risks, missing data and your own documents. See [below](#ai-assistant). |

Every change to business data is made by a person: posting, approving and reversing are confirmed in the document's own page, usually after a preview of the effect.

## AI assistant

- **Answers come from workspace data.** Everyday questions ("What should I handle first today?", "Which items have the highest risk?") are answered by read-only skills that query your records. By default no language model is called.
- **Every answer shows its evidence.** Answers list the records they rely on, with links back to them, and state what was checked and what is missing.
- **It never acts on your behalf.** Requests to approve, pay, send or change records are refused. The assistant can prepare a draft for a person to review, nothing more.
- **Knowledge library.** Upload product guides or company policies and ask questions about them. Answers cite the passages used. It works with keyword search alone. With an OpenAI or Qwen key it adds semantic search and generated answers; see [Product and company knowledge](docs/ai-product-knowledge.md).
- **Measured, not assumed.** An evaluation set of 100 questions (20 in Chinese) runs in CI. The current score is 84/100, with no permission leaks, no cross-tenant leaks and no business writes. See [tests/ai-eval](tests/ai-eval/README.md).

## Quick start

Requires **Node.js 24**.

**Try the walkthrough.** No database setup is needed: it starts its own embedded PostgreSQL. Run it from a fresh checkout without `.env`, `.env.local` or `.local/`.

```bash
npm install
npm run walkthrough:local
```

Open http://127.0.0.1:15201 and sign in with `admin@flowchain.local` or `kim@example.com`. Then use **View the sign-in link** on the sign-in page; emails go to a local outbox. The data lives in `~/flowchain-data/walkthrough`, and `npm run walkthrough:local -- --reset` starts over.

**Develop against your own PostgreSQL.**

```bash
cp .env.local.example .env.local   # then set DATABASE_URL
npm run dev:local -- --demo
```

Later runs only need `npm run dev:local`. See [Local development workflow](docs/local-development-workflow-v1.md) for scenarios, resets and port conflicts.

## Testing

```bash
npm test             # server domain and route tests
npm run typecheck
npm run build
npm run test:ai:eval # AI assistant evaluation on a disposable PostgreSQL
```

Browser tests use Playwright (`tests/browser/`). CI runs the PostgreSQL, browser and production-container suites in [`.github/workflows/receiving-postgres.yml`](.github/workflows/receiving-postgres.yml).

## Tech stack

- **Frontend:** React 18, Vite, Tailwind CSS, React Router, Recharts.
- **Backend:** Node.js 24 with a plain `node:http` server.
- **Data:** PostgreSQL with Prisma. pgvector is optional, for knowledge search.
- **AI:** deterministic read-only skills, with LangChain retrieval for the knowledge library.
- **Interface:** English by default, Chinese available. Business values, currencies and dates do not change with the language. Translation is still being completed; see the [interface language policy](docs/interface-language-policy.md).

## Deployment

[`render.yaml`](render.yaml) defines a Render staging service that deploys from `main` after checks pass, and a production service that is deployed manually. Each has its own PostgreSQL 16 database. The app ships as a Node 24 container with separate liveness (`/api/health`) and readiness (`/api/ready`) checks. See [Deploying on Render](docs/deploy-render.md) and [Staging deployment](deploy/README.md).

## Scope

FlowChain is the operational core and is meant to integrate with the systems around it, not replace them. It does not include:

- general ledger or statutory accounting;
- payment execution or bank integration;
- tax filing;
- HR and payroll;
- CRM;
- a supplier self-service portal.

Not in the current release:

- Forecasting and MRP, and purchase contracts: frozen.
- Internal settlement and cashbook: frozen.
- Returns and quarantine: planned next.
- CSV import of business records: planned next. A preview-only intake foundation exists.
- Demand forecasting: planned. It will build on the methods validated in the [analytics studies](analytics/).

## Analytics studies

[`analytics/`](analytics/) holds two Python studies written for a course report. They informed the product:

- **USAID SCMS shipments:** supplier delivery performance, late-delivery prediction and supplier allocation. Its finding that each PO line needs an unchangeable original promised date is built into the supplier scorecard.
- **Online Retail II:** weekly SKU demand forecasts and a replenishment backtest that recommends budgeted service-level targets.

The datasets are public and stay outside the repository.

## Documentation

- [Docs index](docs/README.md)
- [Architecture overview](docs/architecture-overview-v1.md) and [backend route map](docs/backend-route-map-v1.md)
- [Receiving](docs/receiving-posting-workbench.md) and [outbound](docs/outbound-posting-workbench.md) posting workbenches
- [AI safety and draft-first actions](docs/ai-safety-and-draft-first-explainer-v1.md)

## 中文简介

FlowChain 是面向中小企业的 ERP 进销存协同平台，覆盖这几块业务：

- **采购**：从申请、询价、下单到收货入库，再到发票三单匹配。
- **库存**：盘点、调拨和调整。
- **销售**：销售订单和发货。
- **报表**：各业务的报表看板。

所有改动业务数据的操作，都由人确认后才执行。AI 助手按工作区里的真实数据回答，并列出依据的单据。它不会替你审批、付款或修改数据，默认也不调用任何大语言模型。

界面默认是英文，可以在设置里切换成中文，中文翻译仍在补全。本地试用方法见上面的 [Quick start](#quick-start)。

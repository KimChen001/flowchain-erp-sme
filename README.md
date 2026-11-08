# FlowChain

**Purchasing, inventory and sales operations for small and medium businesses. The AI assistant answers from your own records with sources, and fills in purchase requests and supplier follow-ups for a person to confirm.**

FlowChain is an ERP and inventory-purchase-sales (进销存) collaboration platform for SMEs. One team can take a purchase from request to received goods, a matched supplier invoice and a recorded payment, keep inventory accurate, and ship and invoice customer orders. The assistant explains what needs attention, cites the records behind every answer, and prepares the next piece of work for a person to check.

[中文简介](#中文简介)

## What it covers

| Area | What you can do |
| --- | --- |
| **Today** | The purchase orders, reorders, supplier invoices and receivables that need work today, with links to the records, and a first-day checklist for a new workspace. |
| **Purchasing** | Purchase requests, RFQs with supplier quotes and awards, and purchase orders from submit and approval through issue. By default, a PO made from an approved request is approved with it. Earlier PO prices are shown when you enter a price or compare quotes. Promised-date changes keep the original date and need a reason. Approvers get an email when a document waits for them. Purchase orders print or save as PDF. |
| **Purchase fulfillment** | Receiving (GRN): draft, post and reverse, with an impact preview before posting. |
| **Inventory** | Opening stock, balances, lots and serials, movements, availability and available-to-promise, plus transfers, cycle counts and adjustments. A reorder list ranks items by the day each one has to be ordered. |
| **Sales** | Sales orders (confirm, hold, resume), reservations and shipments, each posted after a preview. |
| **Suppliers** | The supplier list, a Supplier evaluation page that shows each supplier's spend, on-time delivery, open issues and overdue orders next to a tier your company sets by hand, and a Supplier risks page. A scorecard measures on time, in full and OTIF against the original promise. Each supplier shows its recent purchase orders and open issues. |
| **Contracts** (Beta) | Signed supplier agreements with their files, dates, notice period and renewal terms. Contracts that are ending or need notice show up in Today. Off in the trial deployment. |
| **Items and data import** | Item, warehouse and customer master data, and a Supplier prices page for items. Warehouses and bins are set up in Settings. Items, suppliers, customers, item–supplier links and opening stock import from CSV or XLSX. |
| **Finance** | Supplier invoices with three-way match (PO, receipt, invoice), payables, customer invoices, receivables and credit notes. A supplier invoice can arrive before the goods; payment waits for the match. Supplier invoices that may duplicate another are flagged before approval. Payments made outside FlowChain are recorded against supplier invoices and receivables. Customer invoices print or save as PDF. |
| **Reports** | Dashboards for overview, purchasing, sales, inventory, finance and suppliers, a report catalog and export. |
| **AI assistant** | Questions about today's work, risks, spend and your own documents, and filled-in drafts for the next step. See [below](#ai-assistant). |

Every change to business data is made by a person: posting, approving and reversing are confirmed in the document's own page, usually after a preview of the effect.

## AI assistant

- **Answers come from your records.** Ask what to handle first today, what is at risk, where the spend goes, or about a specific purchase order, item or supplier. The assistant reads only the records you are allowed to see, and lists the ones its answer relies on, with links. Follow-up questions carry on from the previous answer, in the language you asked in.
- **It prepares the work; a person does it.** Ask for an order and you get a purchase request already filled in, for you to check and submit. If open orders already cover the shortage, it names them first. For overdue purchase orders it drafts a follow-up email per supplier, which you send from your own email. It never submits, approves, pays or sends anything on its own.
- **A language model is optional.** Without one, built-in read-only queries answer everyday questions. A server can connect a model through the Anthropic API or an OpenAI-compatible endpoint, and each workspace's administrator switches it on in Settings, under a monthly spend cap. Every figure, record number and date the model writes is checked against the records before the answer is shown.
- **Knowledge library.** Upload product guides or company policies and ask questions about them. Answers cite the passages used. It works with keyword search alone. With an OpenAI or Qwen key it adds semantic search and generated answers; see [Product and company knowledge](docs/ai-product-knowledge.md).
- **Evaluated in CI.** A question set in English and Chinese checks that answers stay within the user's permissions and their own workspace, change no business data, and agree with the records. See [tests/ai-eval](tests/ai-eval/README.md).

## Quick start

Requires **Node.js 24**.

**Try the walkthrough.** No database setup is needed: it starts its own embedded PostgreSQL. Run it from a fresh checkout without `.env`, `.env.local` or `.local/`. It runs on two public datasets, Walmart store sales (M5) and a UK online gift retailer's invoices (UCI Online Retail II), one workspace each, with suppliers, purchasing and stock assumed by stated rules. The datasets are not in this repository: write the local extract first, as [Public data workspaces](docs/public-data-workspaces.md) describes.

```bash
npm install
npm run walkthrough:local
```

Open http://127.0.0.1:15201 (M5) or http://127.0.0.1:15202 (UCI) and sign in with `admin@flowchain.local` or `kim@example.com`. Then use **View the sign-in link** on the sign-in page; emails go to a local outbox. The data lives in `~/flowchain-data/public-data`, and `npm run walkthrough:local -- --reset` starts over.

**Develop against your own PostgreSQL.**

```bash
cp .env.local.example .env.local   # then set DATABASE_URL
npm run dev:local -- --public-data
```

Later runs only need `npm run dev:local`. See [Local development workflow](docs/local-development-workflow-v1.md) for public data, resets and port conflicts.

## Testing

```bash
npm test             # server domain and route tests
npm run typecheck
npm run build
npm run test:ai:eval # AI assistant evaluation on a disposable PostgreSQL
```

Browser tests use Playwright (`tests/browser/`). CI runs the PostgreSQL, browser and production-container suites in [`.github/workflows/receiving-postgres.yml`](.github/workflows/receiving-postgres.yml); the browser suites run in three parallel shards. Browser suites for the frozen settlement, bank and mobile sync modules run nightly in [`.github/workflows/frozen-modules-nightly.yml`](.github/workflows/frozen-modules-nightly.yml).

## Tech stack

- **Frontend:** React 18, Vite, Tailwind CSS, React Router, ECharts for the report dashboards and Recharts for other charts.
- **Backend:** Node.js 24 with a plain `node:http` server.
- **Data:** PostgreSQL with Prisma. pgvector is optional, for knowledge search.
- **AI:** read-only queries and tools over the asking user's own records; an optional chat model through the Anthropic API or an OpenAI-compatible endpoint, switched on per workspace under a monthly spend cap; LangChain retrieval for the knowledge library.
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

- Forecasting and MRP: frozen.
- Mobile operations (mobile tasks, PO approval and receiving): off in the trial deployment. Approval and receiving happen on the desktop.
- Internal settlement and cashbook: frozen.
- Returns and quarantine: planned next.
- Importing open orders or transaction history: not available. Import covers master data and opening stock.
- Demand forecasting: planned. It will build on the methods validated in the [analytics studies](analytics/).

## Analytics studies

[`analytics/`](analytics/) holds two Python studies written for a course report. They informed the product:

- **USAID SCMS shipments:** supplier delivery performance, reliability-based supplier tiers, late-delivery prediction and supplier allocation. Its finding that each PO line needs an unchangeable original promised date is built into the supplier scorecard.
- **Online Retail II:** weekly SKU demand forecasts and a backtest that compares replenishment policies.

The datasets are public and stay outside the repository.

## Documentation

- [Docs index](docs/README.md)
- [Architecture overview](docs/architecture-overview-v1.md) and [backend route map](docs/backend-route-map-v1.md)
- [Receiving](docs/receiving-posting-workbench.md) and [outbound](docs/outbound-posting-workbench.md) posting workbenches
- [AI assistant plan](docs/ai-assistant-plan.md): decisions, state and roadmap for the assistant and knowledge work
- [AI safety and draft-first actions](docs/ai-safety-and-draft-first-explainer-v1.md)

## 中文简介

FlowChain 是面向中小企业的 ERP 进销存协同平台，覆盖这几块业务：

- **采购**：从申请、询价、下单到收货入库，再到采购发票三单匹配和付款记录。默认情况下，批准的采购申请转成的采购订单不用再批一次。采购订单可以打印或存为 PDF。
- **供应商**：供应商评估页列出每家供应商的采购额、准时交货、未结问题和逾期订单，旁边是由公司自己手动设定的分级；另有供应商风险页。供应商评分按最初承诺日期计算准时、足量和 OTIF。
- **合同**（Beta）：记录已签的供应商合同及其附件、起止日期、通知期和续约方式，快到期或该发通知的合同会出现在 Today 里。试用环境默认关闭。
- **库存**：期初库存、盘点、调拨和调整，以及按最晚下单日期排序的补货清单。
- **销售**：销售订单、发货和销售发票，销售发票可以打印或存为 PDF。
- **数据导入**：用 CSV 或 XLSX 导入物料、供应商、客户、物料供应商关系和期初库存。
- **报表**：各业务的报表看板。

所有改动业务数据的操作，都由人确认后才执行。AI 助手只按你有权看到的真实单据回答，并列出依据的单据和链接。可以直接问某张采购单、某个物料或某个供应商，也可以接着上一个回答追问，它会用你提问的语言回答。让它下单时，它会给出一张已经填好的采购申请，由你检查后提交；如果在途订单已经够了，它会先告诉你是哪几张。对逾期的采购订单，它会按供应商起草催货邮件，由你在自己的邮箱里发出。它不会自己提交、审批、付款或发送任何东西。大语言模型是可选的：服务器接入模型后，由工作区管理员在设置中开启，并有每月费用上限；模型写出的数字、单号和日期都会先和单据核对。

界面默认是英文，可以在设置里切换成中文，中文翻译仍在补全。本地试用方法见上面的 [Quick start](#quick-start)。

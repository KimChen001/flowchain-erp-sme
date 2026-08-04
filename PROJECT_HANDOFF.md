# FlowChain Project Handoff — Current Runtime

Last updated: 2026-08-04

FlowChain now runs on a PostgreSQL-only authoritative runtime. JSON production
persistence and static production fallbacks are retired and fail closed. The
current deployment entry points are:

- [README](README.md)
- [Production Deployment Foundation v1](docs/production-deployment-foundation-v1.md)
- [Controlled Staging deployment](deploy/README.md)
- [Technical delivery path v2](docs/technical-delivery-path-v2.md)
- [Procurement status authority v1](docs/procurement-status-authority-v1.md)
- [PostgreSQL persistence contract](docs/persistence-mode-and-adapter-registry-v1.md)
- [Current development limitations](docs/current-development-limitations-v1.md)

Current operators must provide `DATABASE_URL`, explicit database persistence,
a provisioned tenant, a stable Session Secret, durable attachment storage, and
immutable build identity. `GET /api/health` is lightweight liveness;
`GET /api/ready` verifies PostgreSQL, tenant, attachment storage, and runtime
configuration before traffic is accepted. Migrations are a separate release
step and never run during image build or application startup.

The current server ownership is intentionally decomposed: `scm-server.mjs`
is the composition root, `http-request-handler.mjs` owns HTTP orchestration,
`runtime-routes.mjs` owns unauthenticated liveness/readiness and local
diagnostics, and `server-lifecycle.mjs` owns signals, HTTP drain, forced
connection close, and Prisma disconnect. Do not restore those concerns as an
inline route chain in `scm-server.mjs`.

Use this bootstrap prompt for future work:

```text
Continue FlowChain from the current repository README and docs/production-deployment-foundation-v1.md. Preserve PostgreSQL-only authority, tenant scope, and the reviewed deployment/configuration contracts. Do not read or output local environment secrets.
```

<details>
<summary>Historical June 2026 JSON/UAT handoff (archived; do not use for current operation)</summary>

The material below records the retired pre-PostgreSQL UAT environment. Its
JSON authority, public HTTP host, static market data, and deployment commands
are historical only and must not be restored.

# Historical FlowChain Project Handoff

Last updated: 2026-06-13

## Project Location

Local workspace:

```text
C:\Users\chinc\Documents\Codex\2026-06-04\erp-saas\scm-source
```

Historical public UAT URL (removed):

```text
[historical host removed]
```

Aliyun server:

```text
Host: [historical host removed]
OS: Ubuntu 22.04
App directory: /opt/flowchain
Service: flowchain
Port: 8787
```

Do not store server passwords or API keys in this document.

## What This App Is

FlowChain is an internal UAT demo for a lightweight AI-assisted ERP/SCM product aimed at small and medium-sized businesses. It is not a production-ready SaaS system and is not a replacement for SAP, Oracle, or a full ERP implementation.

It currently includes:

- Login demo with user profile persistence
- Overview dashboard
- Inventory module
- Sales module
- Forecasting module
- Purchase request workflow
- RFQ workflow
- Purchase order workflow
- Line-level GRN receiving and QC workflow
- MRP release and S&OP cycle views
- Procurement cost module
- Supplier performance and recommendation scoring
- Right-side AI insight panel
- Embedded AI assistant
- AI confidence metadata
- Market price data cards for iron/steel/aluminum/copper/USD-CNY

## Current Data Model

Demo data is stored as JSON:

```text
data/scm-demo.json
```

Server-side data on Aliyun is stored in:

```text
/opt/flowchain/data/scm-demo.json
```

Important arrays:

- `purchaseOrders`
- `purchaseRequests`
- `receivingDocs`
- `rfqs`
- `inventoryMovements`
- `sopCycles`
- `products`
- `suppliers`
- `salesForecasts`
- `marketSignals`
- `marketPrices`
- `events`
- `users`

## Key API Endpoints

Health:

```text
GET /api/health
```

Auth demo:

```text
POST /api/auth/login
GET /api/auth/me
```

Purchase orders:

```text
GET /api/purchase-orders
POST /api/purchase-orders
PATCH /api/purchase-orders/:po/status
```

Purchase requests:

```text
GET /api/purchase-requests
POST /api/purchase-requests
PATCH /api/purchase-requests/:pr/status
POST /api/purchase-requests/:pr/convert-to-po
```

RFQ:

```text
GET /api/rfqs
POST /api/rfqs
PATCH /api/rfqs/:id/status
```

Receiving:

```text
GET /api/receiving-docs
POST /api/receiving-docs
PATCH /api/receiving-docs/:grn
```

Planning:

```text
GET /api/mrp-plan
GET /api/sop-cycle
POST /api/sop-cycle
```

AI and signals:

```text
POST /api/ai/chat
GET /api/external-signals
GET /api/market-prices
POST /api/market-prices/refresh
```

Engineering checks:

```bash
npm run build
npm run typecheck
npm test
```

## AI Behavior

The AI provider is configured with environment variables in `.env.local`.

Current provider:

```text
AI_PROVIDER=doubao
ARK_MODEL=doubao-seed-2-0-lite-260215
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
```

Do not commit `.env.local`.

Behavior notes:

- Price/market questions such as "今天的铁的市场价格" use internal `marketPrices` data and return immediately via `provider=market-data`.
- General ERP questions use Doubao/Ark if configured.
- External news/FX signals are fetched only for questions that need web context.
- If AI fails, the API falls back to local rule-based analysis.

## Local Development

Install dependencies:

```bash
npm install
```

Run local API:

```bash
npm run api
```

Run local frontend:

```bash
npm run dev
```

Build production frontend:

```bash
npm run build
```

Run production mode locally:

```bash
npm start
```

Production mode serves both:

- Static frontend from `dist`
- API routes under `/api`

## Aliyun Deployment

Server app directory:

```bash
cd /opt/flowchain
```

Build:

```bash
npm ci
npm run build
```

Restart service:

```bash
systemctl restart flowchain
systemctl status flowchain --no-pager
```

View logs:

```bash
journalctl -u flowchain -n 80 --no-pager
```

Verify on server:

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/market-prices
```

Verify from local machine:

```powershell
Invoke-WebRequest http://historical-host.invalid:8787/api/health -UseBasicParsing
```

## Important Security Notes

- Rotate the server root password after setup.
- Prefer SSH key login for future work.
- Do not commit `.env.local`.
- Do not publish API keys, server passwords, or cloud console screenshots containing sensitive data.
- Current UAT is HTTP only. For longer internal testing, add Nginx and HTTPS.

## Current Known Limitations

- Historical limitation: data was JSON-based rather than database-backed.
- User login is demo-only and does not use password hashing or JWT.
- Multi-tenant data isolation is not implemented yet.
- Market prices are UAT sample/cache data, not official exchange data.
- No HTTPS/domain yet.
- No formal test suite yet.

## Recommended Next Work

1. Add a full functional UAT test checklist.
2. Build a stronger purchase request flow:
   - Create request
   - AI risk explanation
   - Approve/reject
   - Generate PO
   - Receive goods
   - QC and inbound update
3. Replace JSON with PostgreSQL.
4. Add tenant/company data isolation.
5. Add Nginx + HTTPS.
6. Add audit log and role permissions.
7. Connect real market data provider for steel/iron/copper/aluminum prices.
8. Add streaming AI responses or fast local summary + async AI enhancement.

## New Conversation Bootstrap Prompt

Use this at the start of a new Codex conversation:

```text
请继续 FlowChain 项目。项目路径是 C:\Users\chinc\Documents\Codex\2026-06-04\erp-saas\scm-source。请先读取 PROJECT_HANDOFF.md、package.json、server/scm-api.mjs 和 src/app/App.tsx，然后继续开发。不要读取或输出 .env.local 里的密钥。
```

</details>

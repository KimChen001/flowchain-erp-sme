# Architecture Overview v1

## Current Shape

FlowChain is a Vite/React frontend plus a Node HTTP API server with a
PostgreSQL-only authoritative runtime.

```text
React modules
  -> apiJson / fetch
  -> Node route handlers
  -> domain services and tenant-scoped repositories
  -> PostgreSQL authoritative models
  -> external artifact storage ports where binary evidence is required
```

## Frontend Modules

Key frontend areas:

- `src/app/FlowChainApp.tsx`: app shell, navigation, compatibility composition, global focus recovery.
- `src/modules/overview`: Today Cockpit UI and cockpit evidence helpers.
- `src/modules/ai-assistant`: floating AI Assistant, quick prompts, timeout handling, evidence rendering.
- `src/modules/action-drafts`: Action Draft Review shell.
- `src/modules/procurement`, `src/modules/purchasing`, `src/modules/purchase-requests`, `src/modules/rfq`, `src/modules/receiving`: procurement and P2P workbench surfaces.
- `src/modules/inventory`: inventory items, movements, exceptions, and replenishment entry points.
- `src/modules/srm`, `src/modules/master-data`, `src/modules/finance`, `src/modules/forecast`: supplier, reference, finance-collaboration, and planning views.
- `src/lib/evidenceLinks.ts`: canonical evidence/focus-target normalization.

## Backend Route Groups

Key backend route groups:

- auth/context routes for demo user and tenant context;
- search routes for Global Search;
- Today Cockpit route;
- procurement read routes;
- inventory read routes;
- master data routes;
- action draft schema/preview routes;
- AI chat/tools routes;
- audit log route;
- legacy/manual workflow routes still present for demo compatibility.

## Read Models

Read models provide deterministic business views over current JSON data:

- `server/domain/today-cockpit-read-model.mjs`
- `server/domain/procurement-read-model.mjs`
- `server/domain/inventory-read.mjs`
- `server/domain/master-data.mjs`
- `server/domain/global-business-search.mjs`

They are intended to stay stable as future repository/database adapters are introduced.

## Today Cockpit Aggregation

Today Cockpit combines procurement and inventory read models into:

- summary;
- cards;
- followups;
- inventory risks;
- recent documents;
- recent movements;
- recommended actions;
- evidence.

Recommended actions remain draft-first where they map to action draft previews.

## Procurement Read Model

The procurement read model normalizes:

- PR;
- RFQ;
- PO;
- GRN;
- supplier invoice;
- three-way match.

It also builds document links, followups, summaries, and compact evidence.

## Inventory Read APIs

Inventory read APIs expose:

- items;
- item detail;
- lots;
- serials;
- movements;
- exceptions;
- summary.

They are read-only and do not post inventory movements or close exceptions.

## AI Route and Safety Gate

`POST /api/ai/chat` evaluates deterministic local handlers before provider fallback:

- cockpit fast path;
- evidence reuse;
- supplier operational queries;
- status queries;
- procurement/RFQ operational queries;
- draft preparation;
- local workbench fallback;
- provider safety gate;
- configured provider fallback only when explicitly enabled.

External providers are disabled by default and fake keys do not activate provider calls.

## AI Cockpit Fast Path

Cockpit-style prompts in the overview context use deterministic Today Cockpit/procurement/inventory read models. This avoids waiting on external provider fallback and avoids synchronous audit persistence.

## Action Draft Preview

Action draft routes expose:

- `GET /api/action-drafts/schema`
- `POST /api/action-drafts/preview`

Preview supports PR draft, RFQ draft, and supplier follow-up draft paths among the supported draft types. Responses are preview-only and require confirmation. Current UAT behavior does not create real business documents from these drafts.

## Universal Intake Boundary

Phase 5.4A adds explicit PostgreSQL aggregates for artifact metadata, Intake
batches and records, mapping, validation, review, and blocked commit attempts.
Binary content stays behind an artifact-storage interface. Intake payloads
cannot be used as direct business-table write requests.

Universal Intake is the sole forward-looking intake authority. The legacy
Pilot Import route graph is capability-disabled: authenticated
`/api/imports*` and `/api/import-batches*` requests return stable HTTP 501
retirement errors and never invoke a business repository. Legacy
`ImportBatch`/`ImportIssue` rows are retained only as non-authoritative
historical compatibility data, with no new production writes.

Phase ownership is explicit:

- Phase 5.4A: governed metadata, preview, validation, review, and blocked commit
  evidence.
- Phase 5.4B: bounded CSV/XLSX parsing.
- Phase 5.4C: governed, object-specific business commit adapters.

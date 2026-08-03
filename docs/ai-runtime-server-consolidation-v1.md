# AI Runtime and Server Consolidation v1

## Purpose

This document records the behavior-preserving architecture introduced by PR #19. It describes responsibility boundaries; it does not add routes, deployment lifecycle behavior, or business mutations.

## Server runtime boundary

`server/bootstrap/scm-server.mjs` remains the composition root. It validates the existing persistence configuration, loads provider dispatchers, supplies legacy domain helpers, and creates the Node HTTP server. Request-time responsibilities are separated as follows:

| Responsibility | Module |
| --- | --- |
| HTTP request lifecycle and gate ordering | `server/bootstrap/http-request-handler.mjs` |
| Route-context construction | `server/bootstrap/request-context.mjs` |
| Ordered API route dispatch | `server/bootstrap/route-dispatcher.mjs` |
| Health and local-development diagnostics | `server/bootstrap/runtime-routes.mjs` |
| Login and signed local-session routes | `server/bootstrap/session-routes.mjs` |
| SPA and immutable static assets | `server/bootstrap/static-assets.mjs` |
| Sanitized top-level error handling | `server/bootstrap/server-error-boundary.mjs` |

The request order remains: preflight, runtime diagnostics, capability gate, database-mode mutation gate, session routes, authenticated master-data guard, ordered API dispatch, static fallback, API 404. Existing status codes, payloads, local-session signing, authorization context, static cache policy, and startup behavior remain contractually protected.

Future production deployment work may wrap the composition root with runtime validation, readiness, graceful shutdown, and container lifecycle controls. Those are integration points only; this consolidation deliberately does not implement or copy deployment-foundation behavior.

## AI runtime boundary

AI chat now uses three explicit layers:

1. `ai-handler-registry.mjs` owns ordered handler metadata and matching policy.
2. `ai-dispatcher.mjs` evaluates handlers one at a time and stops on the first accepted result.
3. `ai-response-finalizer.mjs` applies timing fields, best-effort audit recording, diagnostic logging, and the public HTTP response.

The registry has three phases:

- `pre_read_context`: deterministic contracts and fast paths that must precede read-context construction.
- `read_context`: compound, cockpit, supplier, evidence, status, procurement, RFQ, finance, and draft handlers using the shared read-model cache.
- `fallback`: local workbench, market data, provider-safety fallback, and configured provider handling.

The order is part of the product contract. A later handler cannot override an earlier matching handler. Characterization tests cover inventory, sales demand, procurement, supplier, RFQ, finance, evidence, PR/RFQ drafts, and compound prompts without snapshotting timing or prose.

## Authority boundary

The advertised tool catalog is paired with an internal tool-to-handler registry. Every advertised tool must resolve to one registered handler and a concrete implementation function. Read tools remain non-mutating. Draft tools remain preview-only and require user review.

The AI dispatch layer does not import or invoke business command services. It can read authoritative facts, explain evidence, navigate, or prepare a reviewable draft; it cannot approve, post, settle, pay, reserve, or otherwise mutate a formal business record.

## Finance protection

The consolidation does not change invoice authority, match lifecycle, tolerance semantics, or payable semantics. Three-way match evidence continues to preserve the Supplier Invoice → PO → GRN relationship, variance amount, match status, and blocking explanation. Finance AI remains explanatory only and cannot approve an invoice, override an exception, post an invoice, pay a supplier, or create a bank transaction.

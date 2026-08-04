# Historical Alpha Operator Guide

> **Archived:** This guide describes the retired pre-PostgreSQL Alpha/UAT
> workflow. It is retained for historical test context only. Do not use it to
> operate or deploy the current runtime. Current authority is PostgreSQL-only;
> JSON persistence and production fixture fallbacks have been removed. Start
> with the repository README, `docs/production-deployment-foundation-v1.md`,
> and `deploy/README.md`.

FlowChain is an AI-assisted SCM, procurement, inventory, and planning workbench for SMEs. This guide is for controlled Alpha operation only. It is not production ERP guidance, not autonomous execution guidance, and not production MRP guidance.

## Alpha Boundary

- Historical note: JSON mode was once the default; that mode is now retired and fails closed.
- Current operation requires the PostgreSQL repository-backed runtime.
- Test preview-first and draft-first flows before any save-shell flow.
- ActionDraft final confirmation is disabled and not implemented.
- ActionDraft review may preview, edit simple fields, copy, and save an ActionDraft shell only.
- Preview flows must not create PR, RFQ, PO, GRN, inventory movement, or production MRP records.
- Legacy mutation routes are blocked in DB mode by the route classification guard.
- Forecast, MRP release, and replenishment actions are ActionDraft preview only.
- Do not use real production data during Alpha.

## Core Test Modules

- Today Cockpit: start here for the main guided signal, evidence, and recovery flow.
- AI Assistant: test deterministic prompts, evidence cards, and recommended action navigation.
- Procurement PR/RFQ/PO/GRN: verify document recovery, status explanation, and linked evidence.
- Inventory SKU focus: verify SKU detail recovery, movements, exceptions, and lots/serial context.
- Inventory exceptions, movements, and lots: verify explanatory evidence and recovery paths.
- ActionDraft Review: verify preview, simple edit, copy, save shell, cancel/reset, and disabled final confirm.
- Planning Workbench: optional guided Alpha scenario only, not production MRP.

## Planning Guided Scenario

Planning is split into five guided subviews:

- Planning Cockpit: high-level planning priority and risk summary.
- Demand Forecast: historical demand, method comparison, forecast metrics, horizon, and scenario review.
- MRP Plan: gross requirement, scheduled receipts, inventory, net requirement, planned receipt/release, exception reason, and BOM evidence.
- Replenishment Workbench: prioritized recommendations, supplier, buyer, quantity, amount, reason, evidence, and ActionDraft preview.
- Planning Parameters: lead time, MOQ, batch multiple, safety stock, reorder point, supplier, buyer, unit cost, and demo/static assumptions.

Treat Planning as optional guided Alpha. Do not position it as autonomous release, production replenishment, or production MRP.

## Required AI Prompts

- 今天最需要处理什么？
- 今天采购有什么要跟？
- 哪些 PO 快逾期？
- 哪些 RFQ 没回复？
- 哪些采购申请还没转 PO？
- 哪些收货有异常？
- 哪些库存项目需要关注？
- 哪些 SKU 有 MRP 例外？
- MRP 计划释放有哪些需要审阅？
- 这个 forecast 的 MAPE 怎么样？

## Browser UAT Smoke Paths

Run these paths in a fresh browser tab after starting `npm run api` and `npm run dev`. Stay on demo data, use the visible AI quick prompts or type the exact prompt, and capture a screenshot for every S0, S1, or S2 failure.

Pass signals for every path:

- AI response is local/deterministic and does not show `provider_disabled`, raw JSON, debug metadata, or an unsupported card fallback.
- Chinese prompts return mostly Chinese user-facing copy.
- Evidence cards and recommended actions open internal FlowChain views or remain safely non-clickable when no route exists.
- Recovery controls remain visible after navigation, detail focus, and back/clear-focus actions.
- No PR, RFQ, PO, GRN, inventory movement, payment, accounting posting, master data record, or production MRP record is created.

Failure categories:

- AI no response / timeout.
- `provider_disabled`.
- unsupported card.
- English/localization.
- evidence link.
- navigation/recovery.
- ActionDraft boundary.
- Planning explanation.
- finance boundary confusion.
- master data issue.
- supplier/SRM issue.
- typography/display.
- performance.
- permission/boundary confusion.
- local runtime issue.

Scenario A: Today Cockpit to AI to procurement evidence to internal navigation to recovery.

1. Open Today Cockpit.
2. Ask `今天最需要处理什么？`.
3. Confirm the answer includes procurement evidence or a procurement recommended action.
4. Open an evidence or recommended action target.
5. Confirm the target page keeps recovery controls visible and can return to the prior cockpit context.

Scenario B: Procurement quick prompt to PO/RFQ/PR evidence to detail to recovery.

1. Ask `今天采购有什么要跟？`, `哪些 PO 快逾期？`, `哪些 RFQ 没回复？`, or `哪些采购申请还没转 PO？`.
2. Confirm the cards reference PO, RFQ, or PR evidence rather than generic text only.
3. Open one recommended PO, RFQ, or PR detail target.
4. Confirm status, supplier, ETA or response state, linked evidence, and recovery paths.

Scenario C: Inventory quick prompt to inventory card to evidence to SKU focus, movement, or exception.

1. Ask `查看库存风险`, `哪些库存项目需要关注？`, or `解释库存异常`.
2. Confirm the answer distinguishes stock risk, movement-based risk, MRP/planning risk, and missing stock-balance evidence where relevant.
3. Open one SKU, movement, or exception evidence target.
4. Confirm SKU focus, movement detail, exception context, lots/serial context when available, and clear focus recovery.

Scenario D: Inventory `准备 PR 草稿` to ActionDraft preview to disabled final confirm.

1. Ask `准备 PR 草稿` or trigger the inventory replenishment draft preview.
2. Review evidence, payload, validation, and audit boundary in ActionDraft Review.
3. Try copy, simple edit, save shell if enabled, and cancel/reset.
4. Confirm final confirm remains disabled and no real PR/RFQ/PO/GRN/inventory record is created.

Scenario E: Planning Cockpit to Demand Forecast to MRP Plan to Replenishment Workbench to ActionDraft preview.

1. Open Planning Cockpit.
2. Click Demand Forecast, review forecast history, model comparison, metrics, and horizon.
3. Open MRP Plan, review net requirement, planned receipt/release, exception, and BOM evidence.
4. Open Replenishment Workbench and trigger ActionDraft preview only.
5. Confirm Planning remains split into five subviews and no production MRP or purchasing document is released.

Scenario F: Finance `查看待结算项` to finance cards to boundary notice to no payment/posting.

1. Ask `查看待结算项`, `解释差异原因`, or `下一步跟进`.
2. Confirm finance cards summarize pending settlement or variance evidence without implying payment, tax filing, or accounting posting.
3. Open any internal evidence target if present.
4. Confirm the boundary notice is visible and no payment or accounting posting action is available.

Scenario G: Master Data `检查主数据质量` to master data cards to no write action.

1. Ask `检查主数据质量` or `缺少哪些默认字段？`.
2. Confirm master data cards show evidence-backed issue counts, affected objects, and read-only next actions.
3. Open any internal evidence target if present.
4. Confirm no automatic correction, save, or master data mutation action is available.

Scenario H: SRM `查看高风险供应商` to supplier evidence to internal navigation.

1. Ask `查看高风险供应商` or `解释评分规则`.
2. Confirm supplier cards explain risk or scoring evidence from PO, RFQ, GRN, or finance context.
3. Open one supplier evidence or recommended action target.
4. Confirm internal navigation works and recovery controls remain visible.

## Local Runtime Troubleshooting

- Confirm current HEAD with `git log -1 --oneline`.
- Start the API with `npm run api`.
- Start the frontend with `npm run dev`.
- Historical troubleshooting note: current `/api/health` is lightweight liveness and exposes only safe service/build/runtime identity. Use `/api/ready` for PostgreSQL, Tenant, attachment storage, and configuration readiness; neither endpoint returns demo counts or provider diagnostics.
- If the frontend loads but API calls fail, confirm the Vite proxy target: `SCM_API_PROXY_TARGET` should point at the API port that is actually running.
- If port `8787` is occupied by a stale local API, stop only that known stale Node process or run the API on another port, for example `SCM_API_PORT=8788`, then start Vite with `SCM_API_PROXY_TARGET=http://127.0.0.1:8788`.
- If manually testing Chinese prompts from PowerShell, send a UTF-8 byte body instead of a plain string body so request text is not garbled.
- If a browser tab shows old behavior after pulling latest code, hard refresh or open a new tab before recording a failure.
- Open browser Network and inspect `/api/ai/chat`.
- `200` means the route returned a handled response; inspect cards, evidence, and action targets.
- `404` usually means the API server is not serving the expected route or the frontend is pointing at the wrong target.
- `500` means inspect the API terminal first; restart after pulling latest code.
- AI timeout means check `npm run api`, `/api/health`, proxy target, stale port, and current HEAD. Do not enable any external provider for the alpha pilot.
- Pending or cancelled requests often mean the frontend request was aborted, the dev server refreshed, or the API process is stuck.
- Restart the API after pulling latest code.
- Do not test while Codex is mid-run or while files are being edited.

## Issue Capture Template

Use `docs/alpha-feedback-template.md` for structured pilot feedback. The short form below is acceptable for quick triage notes.

- Tester:
- Date/time:
- Browser/device:
- Scenario:
- Step:
- Expected:
- Actual:
- Screenshot/video:
- Severity: S0/S1/S2/S3
- Category: AI timeout / no response; navigation / recovery; evidence link; ActionDraft boundary; Planning/MRP explanation; data mismatch; typography/display; performance; permissions/boundary confusion
- Reproducibility:
- Notes:

## Severity Rules

- S0: cannot continue testing.
- S1: core scenario broken.
- S2: workaround exists.
- S3: polish, copy, or style issue.

## Operator Recommendation

Start with 3 internal pilot users first. After S0 and S1 issues are cleared and S2 issues have known workarounds, expand to 5-10 controlled Alpha users. Do not ask users to use real production data. Capture screenshots for all S0, S1, and S2 issues.

import { handleAiRuntimeGatewayRoute } from "../routes/ai-runtime-gateway.routes.mjs";
import { handleAttachmentRoute } from "../routes/attachments.routes.mjs";
import { handleAuditLogRoute } from "../routes/audit-log.routes.mjs";
import { handleAuthorizationRoute } from "../routes/authorization.routes.mjs";
import { handleBankReconciliationRoute } from "../routes/bank-reconciliation.routes.mjs";
import { handleBusinessReadContextRoute } from "../routes/business-read-context.routes.mjs";
import { handleCapabilitiesRoute } from "../routes/capabilities.routes.mjs";
import { handleContextRoute } from "../routes/context.routes.mjs";
import { handleContractsRoute } from "../routes/contracts.routes.mjs";
import { handleCustomFieldsRoute } from "../routes/custom-fields.routes.mjs";
import { handleDataAccessQualityRoute } from "../routes/data-access-quality.routes.mjs";
import { handleDataImportRoute } from "../routes/data-import.routes.mjs";
import { handleEvidenceGraphRoute } from "../routes/evidence-graph.routes.mjs";
import { handleIntakeRoute } from "../routes/intake.routes.mjs";
import { handleInventoryMovementsRoute } from "../routes/inventory-movements.routes.mjs";
import { handleInventoryOperationsRoute } from "../routes/inventory-operations.routes.mjs";
import { handleInventoryRoute } from "../routes/inventory.routes.mjs";
import { handleMarketRoute } from "../routes/market.routes.mjs";
import { handleMasterDataRoute } from "../routes/master-data.routes.mjs";
import { handleMobileOperationsRoute } from "../routes/mobile-operations.routes.mjs";
import { handleMobileSyncRoute } from "../routes/mobile-sync.routes.mjs";
import { handleOperationalFinanceRoute } from "../routes/operational-finance.routes.mjs";
import { handleOutboundRoute } from "../routes/outbound.routes.mjs";
import { handlePilotImportRoute } from "../routes/pilot-import.routes.mjs";
import { handlePilotOperationsRoute } from "../routes/pilot-operations.routes.mjs";
import { handlePilotWorkspaceRoute } from "../routes/pilot-workspace.routes.mjs";
import { handlePriceHistoryRoute } from "../routes/price-history.routes.mjs";
import { handleProcurementReadRoute } from "../routes/procurement-read.routes.mjs";
import { handleProcurementWorkflowRoute } from "../routes/procurement-workflow.routes.mjs";
import { handleRfqSupplierResponseRoute } from "../routes/rfq-supplier-response.routes.mjs";
import { handleRfqSupplierComparisonRoute } from "../routes/rfq-supplier-comparison.routes.mjs";
import { handleRfqAwardDecisionRoute } from "../routes/rfq-award-decision.routes.mjs";
import { handlePurchaseOrdersRoute } from "../routes/purchase-orders.routes.mjs";
import { handlePurchaseRequestsRoute } from "../routes/purchase-requests.routes.mjs";
import { handleReceivingRoute } from "../routes/receiving.routes.mjs";
import { handleReportViewsRoute } from "../routes/report-views.routes.mjs";
import { handleDecisionItemsRoute } from "../routes/decision-items.routes.mjs";
import { handleSupplierRepliesRoute } from "../routes/supplier-replies.routes.mjs";
import { handleSupplierReplyIngestRoute } from "../routes/supplier-reply-ingest.routes.mjs";
import { handleSupplierReplyStockRoute } from "../routes/supplier-reply-stock.routes.mjs";
import { handleSupplierReliabilityRoute } from "../routes/supplier-reliability.routes.mjs";
import { handleSupplierReplyExportRoute } from "../routes/supplier-reply-export.routes.mjs";
import { handleReportsAnalyticsRoute } from "../routes/reports-analytics.routes.mjs";
import { handleReviewFirstActionWorkflowRoute } from "../routes/review-first-action-workflow.routes.mjs";
import { handleRfqsRoute } from "../routes/rfqs.routes.mjs";
import { handleReturnsRoute } from "../routes/returns.routes.mjs";
import { handleSalesDemandRoute } from "../routes/sales-demand.routes.mjs";
import { handleSalesOrderWorkbenchRoute } from "../routes/sales-order-workbench.routes.mjs";
import { handleSearchRoute } from "../routes/search.routes.mjs";
import { handleSettingsRuntimeRoute } from "../routes/settings-runtime.routes.mjs";
import { handleSopRoute } from "../routes/sop.routes.mjs";
import { handleSupplierPerformanceRoute } from "../routes/supplier-performance.routes.mjs";
import { handleSupplierRecommendationsRoute } from "../routes/supplier-recommendations.routes.mjs";

// The retired /api/ai endpoints (the Chinese template chat and its rule-based
// operational queries). The assistant is /api/ai-runtime/respond (assistant
// v2); the rules engine behind these was removed on 2026-11-06 at the owner's
// direction, and nothing in the app calls them.
async function handleLegacyAiRoute(ctx) {
  if (ctx.url.pathname !== "/api/ai" && !ctx.url.pathname.startsWith("/api/ai/")) return false;
  ctx.send(ctx.res, 410, { code: "AI_LEGACY_CHAT_RETIRED", error: "This assistant endpoint was retired. Use /api/ai-runtime/respond." });
  return true;
}

const orderedRouteHandlers = Object.freeze([
  handleSopRoute,
  handleContextRoute,
  handleBusinessReadContextRoute,
  handleDecisionItemsRoute,
  // Before the procurement read routes, which take /api/procurement/orders/:id.
  handleSupplierRepliesRoute,
  handleSupplierReplyIngestRoute,
  // A reply card's stock line, before the procurement read routes too.
  handleSupplierReplyStockRoute,
  // Supplier reliability (#363 §4.12): its own path under master data.
  handleSupplierReliabilityRoute,
  handleSearchRoute,
  handleSalesDemandRoute,
  handleEvidenceGraphRoute,
  handleDataAccessQualityRoute,
  handleReportsAnalyticsRoute,
  handlePilotImportRoute,
  handlePilotOperationsRoute,
  // The supplier reply outcome export (Settings, settings.export.read).
  handleSupplierReplyExportRoute,
  handleReportViewsRoute,
  handleReviewFirstActionWorkflowRoute,
  handlePilotWorkspaceRoute,
  handleAuthorizationRoute,
  handleSettingsRuntimeRoute,
  handleAiRuntimeGatewayRoute,
  handleReturnsRoute,
  // Before the attachment route, which would otherwise take
  // /api/contracts/:id/attachments.
  handleContractsRoute,
  handleAttachmentRoute,
  handleBankReconciliationRoute,
  handleOperationalFinanceRoute,
  handleMobileSyncRoute,
  handleMobileOperationsRoute,
  handleInventoryOperationsRoute,
  handleInventoryRoute,
  handleRfqAwardDecisionRoute,
  handleRfqSupplierComparisonRoute,
  handleRfqSupplierResponseRoute,
  handlePriceHistoryRoute,
  handleProcurementReadRoute,
  handleCapabilitiesRoute,
  handleIntakeRoute,
  handleDataImportRoute,
  handleCustomFieldsRoute,
  handleMasterDataRoute,
  handleProcurementWorkflowRoute,
  handleMarketRoute,
  handleLegacyAiRoute,
  handleRfqsRoute,
  handlePurchaseRequestsRoute,
  handlePurchaseOrdersRoute,
  handleSalesOrderWorkbenchRoute,
  handleOutboundRoute,
  handleReceivingRoute,
  handleInventoryMovementsRoute,
  handleSupplierPerformanceRoute,
  handleSupplierRecommendationsRoute,
  handleAuditLogRoute,
]);

export async function dispatchRouteHandlers(routeContext, routeHandlers) {
  for (const handleRoute of routeHandlers) {
    if (await handleRoute(routeContext)) return true;
  }
  return false;
}

export function dispatchApiRoute(routeContext) {
  return dispatchRouteHandlers(routeContext, orderedRouteHandlers);
}

import { handleActionDraftsRoute } from "../routes/action-drafts.routes.mjs";
import { handleAiRoute } from "../routes/ai.routes.mjs";
import { handleAiRuntimeGatewayRoute } from "../routes/ai-runtime-gateway.routes.mjs";
import { handleAiRuntimeObservabilityRoute } from "../routes/ai-runtime-observability.routes.mjs";
import { handleAiSuggestionsWorkbenchRoute } from "../routes/ai-suggestions-workbench.routes.mjs";
import { handleAttachmentRoute } from "../routes/attachments.routes.mjs";
import { handleAuditIntegrationHistoryRoute } from "../routes/audit-integration-history.routes.mjs";
import { handleAuditLogRoute } from "../routes/audit-log.routes.mjs";
import { handleAuthorizationRoute } from "../routes/authorization.routes.mjs";
import { handleBankReconciliationRoute } from "../routes/bank-reconciliation.routes.mjs";
import { handleBusinessReadContextRoute } from "../routes/business-read-context.routes.mjs";
import { handleCapabilitiesRoute } from "../routes/capabilities.routes.mjs";
import { handleCollaborationNotificationDraftsRoute } from "../routes/collaboration-notification-drafts.routes.mjs";
import { handleContextRoute } from "../routes/context.routes.mjs";
import { handleCustomFieldsRoute } from "../routes/custom-fields.routes.mjs";
import { handleDataAccessQualityRoute } from "../routes/data-access-quality.routes.mjs";
import { handleEvidenceGraphRoute } from "../routes/evidence-graph.routes.mjs";
import { handleExceptionCasesRoute } from "../routes/exception-cases.routes.mjs";
import { handleIntakeRoute } from "../routes/intake.routes.mjs";
import { handleInventoryMovementsRoute } from "../routes/inventory-movements.routes.mjs";
import { handleInventoryOperationsRoute } from "../routes/inventory-operations.routes.mjs";
import { handleInventoryRoute } from "../routes/inventory.routes.mjs";
import { handleMarketRoute } from "../routes/market.routes.mjs";
import { handleMasterDataRoute } from "../routes/master-data.routes.mjs";
import { handleMobileOperationsRoute } from "../routes/mobile-operations.routes.mjs";
import { handleMobileSyncRoute } from "../routes/mobile-sync.routes.mjs";
import { handleMrpRoute } from "../routes/mrp.routes.mjs";
import { handleOperationalFinanceRoute } from "../routes/operational-finance.routes.mjs";
import { handleOutboundRoute } from "../routes/outbound.routes.mjs";
import { handlePilotImportRoute } from "../routes/pilot-import.routes.mjs";
import { handlePilotOperationsRoute } from "../routes/pilot-operations.routes.mjs";
import { handlePilotReadinessGovernanceRoute } from "../routes/pilot-readiness-governance.routes.mjs";
import { handlePilotWorkspaceRoute } from "../routes/pilot-workspace.routes.mjs";
import { handleProcurementReadRoute } from "../routes/procurement-read.routes.mjs";
import { handleProcurementWorkflowRoute } from "../routes/procurement-workflow.routes.mjs";
import { handlePurchaseOrdersRoute } from "../routes/purchase-orders.routes.mjs";
import { handlePurchaseRequestsRoute } from "../routes/purchase-requests.routes.mjs";
import { handleReceivingRoute } from "../routes/receiving.routes.mjs";
import { handleReportViewsRoute } from "../routes/report-views.routes.mjs";
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
import { handleTodayCockpitRoute } from "../routes/today-cockpit.routes.mjs";
import { handleUserConfirmedActionsRoute } from "../routes/user-confirmed-actions.routes.mjs";
import { handleUserDataRoute } from "../routes/user-data.routes.mjs";
import { handleUserRolePermissionVisibilityRoute } from "../routes/user-role-permission-visibility.routes.mjs";
import { handleWorkspaceBoundaryVisibilityRoute } from "../routes/workspace-boundary-visibility.routes.mjs";
import { handleWorkspaceSetupConfigRoute } from "../routes/workspace-setup-config.routes.mjs";

const orderedRouteHandlers = Object.freeze([
  handleMrpRoute,
  handleSopRoute,
  handleContextRoute,
  handleBusinessReadContextRoute,
  handleSearchRoute,
  handleSalesDemandRoute,
  handleEvidenceGraphRoute,
  handleDataAccessQualityRoute,
  handleReportsAnalyticsRoute,
  handlePilotImportRoute,
  handlePilotOperationsRoute,
  handleReportViewsRoute,
  handleReviewFirstActionWorkflowRoute,
  handleAiSuggestionsWorkbenchRoute,
  handleCollaborationNotificationDraftsRoute,
  handleWorkspaceSetupConfigRoute,
  handlePilotWorkspaceRoute,
  handleAuthorizationRoute,
  handleSettingsRuntimeRoute,
  handleUserRolePermissionVisibilityRoute,
  handleWorkspaceBoundaryVisibilityRoute,
  handleAuditIntegrationHistoryRoute,
  handlePilotReadinessGovernanceRoute,
  handleAiRuntimeGatewayRoute,
  handleAiRuntimeObservabilityRoute,
  handleTodayCockpitRoute,
  handleReturnsRoute,
  handleAttachmentRoute,
  handleBankReconciliationRoute,
  handleOperationalFinanceRoute,
  handleMobileSyncRoute,
  handleMobileOperationsRoute,
  handleInventoryOperationsRoute,
  handleInventoryRoute,
  handleProcurementReadRoute,
  handleCapabilitiesRoute,
  handleIntakeRoute,
  handleCustomFieldsRoute,
  handleMasterDataRoute,
  handleActionDraftsRoute,
  handleUserConfirmedActionsRoute,
  handleProcurementWorkflowRoute,
  handleExceptionCasesRoute,
  handleUserDataRoute,
  handleMarketRoute,
  handleAiRoute,
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

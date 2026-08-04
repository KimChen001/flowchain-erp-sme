import { buildAiDraftPreparationResponse } from "./ai-draft-preparation.mjs";
import { buildAiChatStatusResponse } from "./ai-chat-status.mjs";
import { buildAiEvidenceGraphResponse } from "./ai-evidence-graph-query.mjs";
import { buildAiInventoryAllocationResponse } from "./ai-inventory-allocation-query.mjs";
import { buildAiProcurementOperationalResponse } from "./ai-procurement-operational-query.mjs";
import { buildAiRfqOperationalResponse } from "./ai-rfq-operational-query.mjs";
import { buildAiSalesDemandResponse } from "./ai-sales-demand-query.mjs";
import { buildAiSupplierOperationalResponse } from "./ai-supplier-operational-query.mjs";
import { AI_HANDLER_IDS } from "../routes/ai-handler-registry.mjs";

function bind(toolNames, handlerId, implementation) {
  return toolNames.map(toolName => Object.freeze({
    toolName,
    handlerId,
    implementation,
  }));
}

export const aiToolHandlerRegistry = Object.freeze([
  ...bind([
    "getSalesDemandSummary",
    "getCustomerDeliveryRisks",
    "getSalesOrderImpact",
    "getSkuDemandImpact",
    "getPurchaseOrderSalesImpact",
  ], AI_HANDLER_IDS.salesDemandFastPath, buildAiSalesDemandResponse),
  ...bind([
    "findSupplier",
    "getSupplierStatus",
    "resolveSupplierEntity",
    "getSupplierOperationalSummary",
    "compareSupplierOperations",
  ], AI_HANDLER_IDS.supplierFastPath, buildAiSupplierOperationalResponse),
  ...bind([
    "getInventoryPosition",
    "getInventoryRiskSummary",
  ], AI_HANDLER_IDS.inventoryStatusBeforeProcurement, buildAiChatStatusResponse),
  ...bind([
    "getInventoryAvailability",
    "getSkuAllocation",
    "getInventoryShortageRisks",
    "getDemandSupplyGap",
    "getAvailableToPromise",
    "getReservationPreview",
    "getSalesOrderAllocationImpact",
    "getPurchaseOrderSupplyImpact",
  ], AI_HANDLER_IDS.inventoryAllocationFastPath, buildAiInventoryAllocationResponse),
  ...bind([
    "resolveEvidenceGraph",
    "getEntityRelatedRecords",
    "traceSalesOrderEvidence",
    "traceSkuSupplyDemandEvidence",
    "tracePurchaseOrderDeliveryImpact",
    "traceSupplierOperationalEvidence",
    "traceReceivingEvidence",
    "traceInvoiceEvidence",
  ], AI_HANDLER_IDS.evidenceGraphFastPath, buildAiEvidenceGraphResponse),
  ...bind([
    "getOpenPurchaseOrders",
    "getPurchaseRequestStatus",
    "getPurchaseRequestConversionStatus",
    "getPurchaseOrderStatus",
    "getOverduePurchaseOrders",
    "getReceivingStatus",
    "getReceivingExceptions",
    "getProcurementFollowupSummary",
    "getProcurementExceptions",
  ], AI_HANDLER_IDS.procurementFastPath, buildAiProcurementOperationalResponse),
  ...bind([
    "getRfqStatus",
    "getRfqSupplierResponses",
    "getSupplierRfqParticipation",
  ], AI_HANDLER_IDS.rfqFastPath, buildAiRfqOperationalResponse),
  ...bind([
    "preparePurchaseRequestDraft",
    "prepareRfqDraft",
  ], AI_HANDLER_IDS.draftFastPath, buildAiDraftPreparationResponse),
]);

export function getAiToolHandlerRegistry() {
  return aiToolHandlerRegistry.map(binding => ({ ...binding }));
}

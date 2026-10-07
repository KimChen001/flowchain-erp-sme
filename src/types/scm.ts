import type { InvoiceVarianceCode } from "../domain/procurement/variance-types";
export type Priority = "高" | "中" | "低";

export type POStatus = "草稿" | "待审批" | "已审批" | "已发出" | "部分到货" | "已完成" | "已驳回" | "已取消";
export type PurchaseRequestStatus = "草稿" | "待审批" | "已批准" | "已驳回" | "已转PO" | "已取消";
export type RecvStatus = "待收货" | "已签收" | "质检中" | "已入库" | "异常处理";
export type SupplierInvoiceStatus = "草稿" | "已接收" | "待匹配" | "已匹配" | "存在差异" | "待审批" | "已审批" | "已过账应付" | "已付款" | "已驳回";
export type SupplierInvoiceMatchStatus = "未匹配" | "自动匹配" | "人工复核" | "差异待处理" | "已解决";
// Stored codes, plus the legacy Chinese business values older rows still carry.
export type InvoiceVarianceType = InvoiceVarianceCode | "无差异" | "价格差异" | "数量差异" | "金额差异" | "税额差异" | "运费差异" | "供应商不一致" | "缺少收货" | "缺少PO" | "发票早于收货" | "重复发票";
export type SupplierReconciliationStatus = "草稿" | "待确认" | "存在差异" | "已确认" | "已驳回" | "已关闭";
export type SupplierSettlementStatus = "未结算" | "部分结算" | "已结算";
export type SupplierReconciliationLineType = "PO" | "GRN" | "SupplierInvoice" | "PurchaseReturn" | "AP" | "Payment" | "Adjustment" | "CreditMemo";
export type PurchaseReturnStatus = "草稿" | "待审批" | "已审批" | "已退货" | "待贷项" | "已生成贷项" | "已关闭" | "已驳回";
export type PurchaseReturnReason = "质检拒收" | "数量差异" | "价格差异" | "错发物料" | "运输损坏" | "重复发票" | "合同条款差异" | "其他";
export type SupplierCreditMemoStatus = "草稿" | "待确认" | "已确认" | "已冲减应付" | "已关闭" | "已驳回";
export type InventoryMovementType = "PurchaseReceipt" | "PurchaseReturn" | "SalesDelivery" | "SalesReturn" | "StockAdjustment" | "StockTransfer" | "CycleCountVariance";
export type InventoryMovementStatus = "已登记" | "待复核" | "已确认" | "异常处理" | "已关闭" | "已取消";

export type InventoryMovementEvidence = {
  label: string;
  value: string;
};

export type InventoryMovement = {
  movementId: string;
  movementType: InventoryMovementType;
  movementLabel: string;
  date: string;
  sku: string;
  itemName: string;
  warehouse: string;
  location: string;
  sourceDocument: string;
  relatedPo?: string;
  relatedGrn?: string;
  relatedReturn?: string;
  relatedSalesOrder?: string;
  quantityIn: number;
  quantityOut: number;
  adjustmentQty: number;
  unit: string;
  status: InventoryMovementStatus;
  owner: string;
  reason: string;
  inventoryImpact: string;
  evidence: InventoryMovementEvidence[];
  timeline: InventoryMovementEvidence[];
};

export type ApprovalSnapshot = {
  source?: string;
  summary?: string;
  explanation?: string;
  ai?: Record<string, unknown>;
  mrp?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
  forecast?: Record<string, unknown>;
  supplier?: Record<string, unknown>;
  createdAt?: string;
};

export type PurchaseOrderLine = {
  poLineId: string;
  poId?: string;
  itemId?: string;
  sku: string;
  itemName: string;
  quantityOrdered: number;
  quantityReceived: number;
  quantityAccepted: number;
  quantityRejected: number;
  unit: string;
  unitPrice: number;
  currency: string;
  supplierId?: string;
  warehouseId?: string;
  requiredDate?: string;
  promisedDate?: string;
  status?: string;
  // Why the purchase request chose a supplier other than the item's preferred
  // one, carried from its line; null when none was needed.
  // missingReason: saved before a reason was asked; reasonCode is then null.
  supplierOverride?: { reasonCode: string | null; note?: string | null; missingReason?: boolean; preferredSupplierId?: string | null; preferredSupplierIds?: string[] | null; preferredSupplierName?: string | null } | null;
};

export type PurchaseOrder = {
  // Set by the server when the role may not read prices ("amounts").
  restrictedFields?: string[];
  po: string;
  supplier: string;
  created: string;
  // When the PO was issued to the supplier (an instant); null when not recorded.
  issuedAt?: string | null;
  // The status receiving started from: "approved" means received without being issued.
  receivingBaseStatus?: string | null;
  eta: string;
  owner: string;
  amount: number;
  items: number;
  received: number;
  status: POStatus;
  priority: Priority;
  paid: boolean;
  source?: string;
  sourceRequest?: string;
  sourcePrId?: string;
  buyer?: string;
  sourceRfq?: string;
  sourceSku?: string;
  sourceName?: string;
  recommendedQty?: number;
  unit?: string;
  unitPrice?: number;
  reason?: string;
  approvalSnapshot?: ApprovalSnapshot | null;
  lines?: PurchaseOrderLine[];
  lineCount?: number;
  totalOrderedQty?: number;
  totalReceivedQty?: number;
  totalAcceptedQty?: number;
  totalRejectedQty?: number;
  totalAmount?: number;
  itemsMeaning?: "lineCount" | "totalOrderedQty" | string;
  currency?: string;
  version?: number;
  supplierId?: string;
  warehouseId?: string;
  erpStatus?: string;
  statusUpdatedAt?: string;
  lastAuditId?: string;
  auditTrailIds?: string[];
};

export type PurchaseOrderDraft = Omit<PurchaseOrder, "po" | "created"> & { po?: string; created?: string };

export type PurchaseRequest = {
  pr: string;
  source: string;
  sourceSku: string;
  sourceName: string;
  supplier: string;
  requester: string;
  buyer: string;
  created: string;
  requiredDate: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  currency?: string;
  priority: Priority;
  status: PurchaseRequestStatus;
  reason: string;
  linkedPo?: string;
  forecastBasis?: {
    source?: string;
    peakGap?: number;
    serviceLevel?: number;
    safetyFactor?: number;
    stockoutMonths?: number;
    firstStockoutMonth?: string | null;
    projectedAvailable?: number;
    reorderPoint?: number;
    daysCover?: number;
    leadTimeDays?: number;
    moq?: number;
    batchMultiple?: number;
    plannedReceipt?: number;
    plannedReleasePeriod?: string;
    mrpException?: string;
    bomSourceSummary?: string;
    bomSources?: {
      parent: string;
      parentName?: string;
      top?: string;
      topName?: string;
      level?: number;
      demand: number;
    }[];
  } | null;
  approvalSnapshot?: ApprovalSnapshot | null;
  statusUpdatedAt?: string;
  lastAuditId?: string;
  auditTrailIds?: string[];
};

export type PurchaseIntent = {
  selectedPr?: string;
  sourceSku?: string;
  createdAt: number;
};

export type ItemMaster = {
  sku: string;
  name: string;
  category: string;
  specification: string;
  unit: string;
  defaultWarehouse: string;
  defaultBin: string;
  safetyStock: number;
  maxStock: number;
  reorderPoint: number;
  leadTimeDays: number;
  batchManaged: boolean;
  serialManaged: boolean;
  qaRequired: boolean;
  defaultSupplier: string;
  defaultTaxCode: string;
  status: "启用" | "待完善" | "停用";
};

export type SupplierMaster = {
  code: string;
  name: string;
  category: string;
  contact: string;
  email: string;
  phone: string;
  paymentTerms: string;
  currency: string;
  taxId: string;
  defaultTaxCode: string;
  rating: number;
  onTimeRate: number;
  qualityRate: number;
  riskStatus: "低" | "中" | "高";
  certificationStatus: "已认证" | "待复核" | "整改中" | "";
  status: "启用" | "待完善" | "停用";
};

export type WarehouseBin = {
  warehouseCode: string;
  warehouseName: string;
  zone: string;
  bin: string;
  capacity: number;
  utilization: number;
  temperatureRequirement: string;
  qaStatus: "可用" | "待复核" | "冻结";
  available: boolean;
  owner: string;
};

export type TaxCode = {
  code: string;
  name: string;
  rate: number;
  // Tax type code as stored (TaxCode.taxType, e.g. "sales_tax"); "" when not recorded.
  type: string;
  region: string;
  isDefault: boolean;
  status: "启用" | "待复核" | "停用";
  description: string;
};

export type PaymentTerm = {
  code: string;
  name: string;
  netDays: number;
  discountRule: string;
  dueDateRule: string;
  status: "启用" | "待复核" | "停用";
  description: string;
};

export type RfqRecord = {
  id: string;
  title: string;
  category: string;
  suppliers: number;
  quoted: number;
  bestPrice: number;
  bestSupplier: string;
  due: string;
  status: string;
  sourceRequest?: string;
  sourcePrId?: string;
  buyer?: string;
  sourceSku?: string;
  sourceName?: string;
  quantity?: number;
  unit?: string;
  reason?: string;
  invitedSuppliers?: string[];
  linkedPo?: string;
  createdAt?: string;
  statusUpdatedAt?: string;
  lastAuditId?: string;
  auditTrailIds?: string[];
};

export type SupplierRecommendationResult = {
  sku: string;
  quantity: number;
  currentSupplier: string;
  primary: {
    supplier: string;
    unitPrice: number;
    listPrice?: number;
    listPriceCny?: number;
    currency?: string;
    fxRate?: number;
    contractId?: string;
    contractLabel?: string;
    contractDiscount?: number;
    contractTierMinQty?: number;
    leadTimeDays: number;
    responseScore: number;
    capacity: number;
    availableCapacity?: number;
    capacityWindow?: string;
    capacityReliability?: number;
    capacityStatus?: "可承诺" | "紧张" | "不足" | string;
    risk: string;
    performanceScore: number;
    quality: number;
    rejectRate: number;
    flag: string;
    score: number;
    amount: number;
    isCurrent: boolean;
    note: string;
  } | null;
  backup: SupplierRecommendationResult["primary"];
  candidates: NonNullable<SupplierRecommendationResult["primary"]>[];
  split: { supplier: string; quantity: number; unitPrice: number }[];
  needsRfq: boolean;
  rfqReason: string;
};

export type WorkspaceUser = {
  id: string;
  company: string;
  name: string;
  email: string;
  role: string;
  roleLabel?: string;
  jobTitle?: string;
  status?: string;
  defaultWarehouseId?: string;
  version?: number;
  createdAt?: string;
  lastLoginAt?: string;
};

export type ReceivingDocLine = {
  grnLineId?: string;
  poLineId?: string;
  poId?: string;
  sku: string;
  itemName?: string;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  warehouseId?: string;
  unit?: string;
  status?: string;
};

export type ReceivingDoc = {
  grn: string;
  po: string;
  supplier: string;
  arrived: string;
  dock: string;
  receiver: string;
  items: number;
  passed: number;
  failed: number;
  status: RecvStatus;
  warehouse: string;
  lines?: ReceivingDocLine[];
  postedAt?: string;
  postedBy?: string;
  inventoryApplied?: boolean;
  inventoryMovementIds?: string[];
  statusUpdatedAt?: string;
  lastAuditId?: string;
  auditTrailIds?: string[];
};

export type SupplierInvoiceLine = {
  lineId: string;
  sku: string;
  name: string;
  description?: string;
  poLine?: string;
  grnLine?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  lineSubtotal: number;
  lineTotal: number;
  matchedQty?: number;
  receivedQty?: number;
  orderedQty?: number;
  varianceType?: InvoiceVarianceType;
  varianceAmount?: number;
};

export type SupplierInvoice = {
  id: string;
  invoiceNumber: string;
  supplier: string;
  supplierCode?: string;
  relatedPo: string;
  relatedGrn?: string;
  invoiceDate: string;
  receivedDate: string;
  dueDate: string;
  currency: string;
  subtotal: number;
  tax: number;
  freight?: number;
  total: number;
  paymentTerms: string;
  owner: string;
  apOwner: string;
  source: "supplier-portal" | "email-upload" | "manual-entry" | "edi-sample";
  status: SupplierInvoiceStatus;
  matchStatus: SupplierInvoiceMatchStatus;
  varianceType: InvoiceVarianceType;
  varianceAmount: number;
  approvalStatus?: string;
  postedToAp: boolean;
  paid: boolean;
  duplicateRisk?: boolean;
  confidence?: number;
  notes?: string;
  lines: SupplierInvoiceLine[];
};

export type SupplierReconciliationLine = {
  lineId: string;
  bizType: SupplierReconciliationLineType;
  bizId: string;
  supplier: string;
  documentDate: string;
  dueDate?: string;
  description: string;
  debitAmount?: number;
  creditAmount?: number;
  payableAmount: number;
  paidAmount: number;
  varianceAmount: number;
  status: string;
  matchStatus?: string;
  relatedPo?: string;
  relatedGrn?: string;
  relatedInvoice?: string;
  notes?: string;
};

export type SupplierReconciliationStatement = {
  id: string;
  statementNo: string;
  supplier: string;
  supplierCode?: string;
  periodStart: string;
  periodEnd: string;
  owner: string;
  currency: string;
  totalInvoiceAmount: number;
  totalPayableAmount: number;
  totalPaidAmount: number;
  totalAdjustmentAmount: number;
  totalVarianceAmount: number;
  openBalance: number;
  dueAmount: number;
  overdueAmount: number;
  invoiceCount: number;
  exceptionCount: number;
  status: SupplierReconciliationStatus;
  settlementStatus: SupplierSettlementStatus;
  createdDate: string;
  confirmedDate?: string;
  rejectReason?: string;
  source: "system-generated" | "manual-review" | "supplier-confirmation";
  confidence?: number;
  notes?: string;
  lines: SupplierReconciliationLine[];
};

export type PurchaseReturnLine = {
  lineId: string;
  sku: string;
  name: string;
  unit: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  returnQty: number;
  unitPrice: number;
  taxRate: number;
  returnAmount: number;
  taxAmount: number;
  totalAmount: number;
  reason: PurchaseReturnReason;
  relatedPoLine?: string;
  relatedGrnLine?: string;
  relatedInvoiceLine?: string;
  notes?: string;
};

export type PurchaseReturn = {
  id: string;
  returnNo: string;
  supplier: string;
  supplierCode?: string;
  relatedPo: string;
  relatedGrn: string;
  relatedInvoice?: string;
  relatedMatchId?: string;
  returnDate: string;
  createdDate: string;
  owner: string;
  warehouse: string;
  currency: string;
  reason: PurchaseReturnReason;
  status: PurchaseReturnStatus;
  approvalStatus?: string;
  creditMemoId?: string;
  subtotal: number;
  tax: number;
  total: number;
  returnQty: number;
  acceptedImpactQty?: number;
  rejectedImpactQty?: number;
  source: "receiving-qc" | "invoice-variance" | "manual-review" | "supplier-confirmation";
  confidence?: number;
  notes?: string;
  lines: PurchaseReturnLine[];
};

export type SupplierCreditMemo = {
  id: string;
  creditMemoNo: string;
  supplier: string;
  relatedReturn: string;
  relatedInvoice?: string;
  relatedPo?: string;
  relatedGrn?: string;
  issueDate: string;
  receivedDate: string;
  currency: string;
  subtotal: number;
  tax: number;
  totalCredit: number;
  status: SupplierCreditMemoStatus;
  apOffsetStatus: string;
  reconciliationStatement?: string;
  owner: string;
  source: "supplier-issued" | "manual-adjustment" | "system-generated";
  notes?: string;
};

export type AiConfidenceDimension = {
  key: "forecast" | "inventory" | "supplier" | "external" | string;
  label: string;
  score: number;
  level: "高" | "中" | "低";
  evidence: string[];
  warnings: string[];
};

export type AiConfidence = {
  score: number;
  level: "高" | "中" | "低";
  dimensions?: AiConfidenceDimension[];
  evidence: string[];
  warnings: string[];
  recommendedValidation: string;
  method: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  confidence?: AiConfidence;
};

export type MarketPrice = {
  symbol: string;
  name: string;
  category: string;
  price: number;
  unit: string;
  changePct: number;
  direction: string;
  asOf: string;
  source: string;
  procurementImpact?: string;
};

export type AuditEntry = {
  auditId: string;
  id?: string;
  timestamp: string;
  actor: string;
  source?: string;
  action: string;
  entityType: "purchaseRequest" | "purchaseOrder" | "rfq" | "receivingDoc" | string;
  entityId: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string;
  metadata?: Record<string, unknown>;
};

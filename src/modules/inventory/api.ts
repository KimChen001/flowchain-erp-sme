import { apiJson } from "../../lib/api-client";
import type { InventoryMovement } from "../../types/scm";
import type { InventoryExceptionDocument } from "../../domain/inventory/exceptions";

export type InventoryStockItem = {
  sku: string;
  name: string;
  category: string;
  qty: number;
  min: number;
  max: number;
  status: string;
  location: string;
  turnover: number;
  lastIn?: string;
};

type ApiInventoryItem = {
  sku?: string;
  itemName?: string;
  category?: string;
  supplier?: string;
  defaultWarehouseId?: string;
  location?: string;
  availableQuantity?: number;
  onHandQuantity?: number;
  reservedQuantity?: number;
  safetyStock?: number;
  reorderPoint?: number;
  status?: string;
  riskLevel?: string;
  unit?: string;
  updatedAt?: string;
};

type ApiInventoryLot = {
  lotId?: string;
  sku?: string;
  itemName?: string;
  quantity?: number;
  supplier?: string;
  expiryDate?: string;
  warehouseId?: string;
  location?: string;
  qaStatus?: string;
  status?: string;
};

type ApiInventorySerial = {
  serialId?: string;
  sku?: string;
  sourceDocument?: string;
  status?: string;
  warehouseId?: string;
  location?: string;
  updatedAt?: string;
};

type ApiInventorySummary = {
  itemCount?: number;
  lowStockCount?: number;
  highRiskCount?: number;
  movementCount?: number;
  exceptionCount?: number;
  lotCount?: number;
  serialCount?: number;
};

export type InventoryAvailability = {
  sku: string;
  itemName: string;
  unit: string;
  warehouseId?: string;
  onHandQty: number;
  reservedQty: number;
  salesDemandQty: number;
  allocatedDemandQty: number;
  availableQty: number;
  availableToPromiseQty: number;
  reservableQty: number;
  reservationSuggestedQty: number;
  reservationShortageQty: number;
  reservationConflictOrders: Array<{ salesOrderId: string; customerName?: string; shortageQty?: number }>;
  incomingPurchaseQty: number;
  overdueIncomingQty: number;
  projectedAvailableQty: number;
  shortageQty: number;
  safetyStock: number;
  reorderPoint: number;
  daysCover: number | null;
  riskLevel: "blocked" | "high" | "medium" | "low";
  riskLabel: string;
  riskReason: string;
  allocationPolicy: string;
  allocationExplanation: string;
  purchaseDelayImpact: string;
  deliveryRiskPropagation: string;
  affectedSalesOrders: Array<{ salesOrderId: string; customerName: string; shortageQty: number; deliveryRiskLabel?: string }>;
  linkedPurchaseOrders: Array<{ poId: string; supplierName?: string; status?: string; expectedDate?: string; incomingQty?: number }>;
  linkedSuppliers: Array<{ id: string; name: string; risk?: string; status?: string }>;
  linkedReceivingDocs: Array<{ id: string; poId?: string; status?: string }>;
  evidence: Array<{ type: string; id: string; label: string; summary?: string; status?: string; route?: string }>;
  dataLimitations: string[];
};

export type InventoryAllocationSummary = {
  skuCount: number;
  highRiskSkuCount: number;
  totalShortageQty: number;
  reservedQty: number;
  incomingPurchaseQty: number;
  atpInsufficientSkuCount: number;
  projectedNegativeSkuCount: number;
};

const fallbackScopes = new Set<string>();

export function inventoryReadFallbackScopes() {
  return Array.from(fallbackScopes);
}

function markSource(scope: string, usedFallback: boolean) {
  if (usedFallback) fallbackScopes.add(scope);
  else fallbackScopes.delete(scope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function text(value: unknown, fallback = "") {
  const next = String(value ?? "").trim();
  return next || fallback;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function warnFallback(scope: string, error?: unknown) {
  if ((import.meta as any).env?.DEV) {
    console.warn(`[inventory] falling back for ${scope}`, error);
  }
}

function arrayPayload<T>(payload: unknown, key: string): T[] {
  if (!isRecord(payload) || !Array.isArray(payload[key])) throw new Error(`Invalid inventory response: ${key}`);
  return payload[key] as T[];
}

async function readArray<T>(url: string, key: string, fallback?: T[], useFallbackWhenEmpty = true): Promise<T[]> {
  try {
    const rows = arrayPayload<T>(await apiJson<unknown>(url), key);
    if (rows.length === 0 && fallback?.length && useFallbackWhenEmpty) {
      warnFallback(url, new Error("Empty inventory read model"));
      markSource(url, true);
      return fallback;
    }
    markSource(url, false);
    return rows;
  } catch (error) {
    warnFallback(url, error);
    markSource(url, Boolean(fallback?.length));
    return fallback ?? [];
  }
}

function inventoryStatus(value: unknown, qty: number, min: number): string {
  const raw = text(value);
  if (["正常", "预警", "不足"].includes(raw)) return raw;
  if (raw === "缺货" || raw === "低库存" || raw === "高") return "不足";
  if (raw === "异常" || raw === "中") return "预警";
  if (qty < min) return "不足";
  if (min > 0 && qty <= min * 1.2) return "预警";
  return "正常";
}

function normalizeInventoryItems(apiItems: ApiInventoryItem[], fallback: InventoryStockItem[] = []): InventoryStockItem[] {
  return apiItems.map((item, index) => {
    const fallbackItem = fallback.find((row) => row.sku === item.sku || row.name === item.itemName) || fallback[index];
    const qty = numberValue(item.availableQuantity ?? item.onHandQuantity, fallbackItem?.qty || 0);
    const min = numberValue(item.safetyStock, fallbackItem?.min || 0);
    return {
      sku: text(item.sku, fallbackItem?.sku || `SKU-${index + 1}`),
      name: text(item.itemName, fallbackItem?.name || text(item.sku, "—")),
      category: text(item.category, fallbackItem?.category || "未分类"),
      qty,
      min,
      max: numberValue(fallbackItem?.max, Math.max(qty, min * 2, 1)),
      status: inventoryStatus(item.status || item.riskLevel, qty, min),
      location: text(item.location || item.defaultWarehouseId, fallbackItem?.location || ""),
      turnover: numberValue(fallbackItem?.turnover, 0),
      lastIn: text(item.updatedAt, fallbackItem?.lastIn || ""),
    };
  });
}

function normalizeLots(apiLots: ApiInventoryLot[], fallback: any[] = []) {
  return apiLots.map((lot, index) => {
    const fallbackLot = fallback.find((row) => row.lot === lot.lotId || row.sku === lot.sku) || fallback[index];
    return {
      lot: text(lot.lotId, fallbackLot?.lot || `LOT-${index + 1}`),
      sku: text(lot.sku, fallbackLot?.sku || ""),
      name: text(lot.itemName, fallbackLot?.name || ""),
      qty: numberValue(lot.quantity, fallbackLot?.qty || 0),
      received: fallbackLot?.received || "",
      expiry: text(lot.expiryDate, fallbackLot?.expiry || "—"),
      supplier: text(lot.supplier, fallbackLot?.supplier || ""),
      warehouse: text(lot.location || lot.warehouseId, fallbackLot?.warehouse || ""),
      status: text(lot.status || lot.qaStatus, fallbackLot?.status || "可用"),
      coa: fallbackLot?.coa ?? lot.qaStatus !== "待复核",
    };
  });
}

function normalizeSerials(apiSerials: ApiInventorySerial[], fallback: any[] = []) {
  return apiSerials.map((serial, index) => {
    const fallbackSerial = fallback.find((row) => row.sn === serial.serialId || row.sku === serial.sku) || fallback[index];
    return {
      sn: text(serial.serialId, fallbackSerial?.sn || `SN-${index + 1}`),
      sku: text(serial.sku, fallbackSerial?.sku || ""),
      lot: text(serial.sourceDocument, fallbackSerial?.lot || ""),
      status: text(serial.status, fallbackSerial?.status || "在库"),
      warehouse: text(serial.location || serial.warehouseId, fallbackSerial?.warehouse || ""),
      received: text(serial.updatedAt, fallbackSerial?.received || ""),
      expiry: fallbackSerial?.expiry || "—",
    };
  });
}

function normalizeMovement(row: Partial<InventoryMovement>, fallback?: InventoryMovement): InventoryMovement {
  return {
    movementId: text(row.movementId, fallback?.movementId || ""),
    movementType: (row.movementType || fallback?.movementType || "StockAdjustment") as InventoryMovement["movementType"],
    movementLabel: text(row.movementLabel, fallback?.movementLabel || text(row.movementType)),
    date: text(row.date, fallback?.date || ""),
    sku: text(row.sku, fallback?.sku || ""),
    itemName: text(row.itemName, fallback?.itemName || ""),
    warehouse: text(row.warehouse, fallback?.warehouse || ""),
    location: text(row.location, fallback?.location || ""),
    sourceDocument: text(row.sourceDocument, fallback?.sourceDocument || ""),
    relatedPo: text(row.relatedPo, fallback?.relatedPo || "") || undefined,
    relatedGrn: text(row.relatedGrn, fallback?.relatedGrn || "") || undefined,
    relatedReturn: text(row.relatedReturn, fallback?.relatedReturn || "") || undefined,
    relatedSalesOrder: text(row.relatedSalesOrder, fallback?.relatedSalesOrder || "") || undefined,
    quantityIn: numberValue(row.quantityIn, fallback?.quantityIn || 0),
    quantityOut: numberValue(row.quantityOut, fallback?.quantityOut || 0),
    adjustmentQty: numberValue(row.adjustmentQty, fallback?.adjustmentQty || 0),
    unit: text(row.unit, fallback?.unit || "件"),
    status: (row.status || fallback?.status || "已登记") as InventoryMovement["status"],
    owner: text(row.owner, fallback?.owner || ""),
    reason: text(row.reason, fallback?.reason || ""),
    inventoryImpact: text(row.inventoryImpact, fallback?.inventoryImpact || ""),
    evidence: Array.isArray(row.evidence) ? row.evidence : fallback?.evidence || [],
    timeline: Array.isArray(row.timeline) ? row.timeline : fallback?.timeline || [],
  };
}

function normalizeMovements(apiRows: Partial<InventoryMovement>[], fallback: InventoryMovement[] = []) {
  return apiRows.map((row, index) => normalizeMovement(row, fallback.find((item) => item.movementId === row.movementId) || fallback[index]));
}

function normalizeExceptions(apiRows: Partial<InventoryExceptionDocument>[], fallback: InventoryExceptionDocument[] = []): InventoryExceptionDocument[] {
  return apiRows.map((row, index) => {
    const fallbackDoc = fallback.find((item) => item.id === row.id) || fallback[index];
    return {
      id: text(row.id, fallbackDoc?.id || `IEX-${index + 1}`),
      type: (row.type || fallbackDoc?.type || "库存调整") as InventoryExceptionDocument["type"],
      sku: text(row.sku, fallbackDoc?.sku || ""),
      itemName: text(row.itemName, fallbackDoc?.itemName || ""),
      warehouse: text(row.warehouse, fallbackDoc?.warehouse || ""),
      location: text(row.location, fallbackDoc?.location || ""),
      quantityImpact: numberValue(row.quantityImpact, fallbackDoc?.quantityImpact || 0),
      unit: text(row.unit, fallbackDoc?.unit || "件"),
      status: (row.status || fallbackDoc?.status || "待复核") as InventoryExceptionDocument["status"],
      owner: text(row.owner, fallbackDoc?.owner || ""),
      linkedMovement: text(row.linkedMovement, fallbackDoc?.linkedMovement || "") || undefined,
      linkedDocument: text(row.linkedDocument, fallbackDoc?.linkedDocument || ""),
      reason: text(row.reason, fallbackDoc?.reason || ""),
      evidence: fallbackDoc?.evidence || [],
      nextAction: text(row.nextAction, fallbackDoc?.nextAction || ""),
      timeline: fallbackDoc?.timeline || [],
    };
  });
}

export async function fetchInventoryItems(fallback: InventoryStockItem[] = []): Promise<InventoryStockItem[]> {
  const rows = await readArray<ApiInventoryItem>("/api/inventory/items", "items", fallback as unknown as ApiInventoryItem[], false);
  if (rows === (fallback as unknown as ApiInventoryItem[])) return fallback;
  if (rows.length) return normalizeInventoryItems(rows, fallback);
  markSource("/api/inventory/items", Boolean(fallback.length));
  return fallback;
}

export async function fetchInventoryItem(sku: string): Promise<ApiInventoryItem | null> {
  try {
    const payload = await apiJson<unknown>(`/api/inventory/items/${encodeURIComponent(sku)}`);
    if (!isRecord(payload) || !isRecord(payload.item)) return null;
    return payload.item as ApiInventoryItem;
  } catch (error) {
    warnFallback(`/api/inventory/items/${sku}`, error);
    return null;
  }
}

export async function fetchInventoryLots(fallback: any[] = []) {
  const rows = await readArray<ApiInventoryLot>("/api/inventory/lots", "lots", fallback as unknown as ApiInventoryLot[]);
  if (rows === (fallback as unknown as ApiInventoryLot[])) return fallback;
  if (rows.length) return normalizeLots(rows, fallback);
  markSource("/api/inventory/lots", Boolean(fallback.length));
  return fallback;
}

export async function fetchInventorySerials(fallback: any[] = []) {
  const rows = await readArray<ApiInventorySerial>("/api/inventory/serials", "serials", fallback as unknown as ApiInventorySerial[]);
  if (rows === (fallback as unknown as ApiInventorySerial[])) return fallback;
  if (rows.length) return normalizeSerials(rows, fallback);
  markSource("/api/inventory/serials", Boolean(fallback.length));
  return fallback;
}

export async function fetchInventoryMovements(fallback: InventoryMovement[] = []): Promise<InventoryMovement[]> {
  const rows = await readArray<Partial<InventoryMovement>>("/api/inventory/movements", "movements", fallback as Partial<InventoryMovement>[]);
  return normalizeMovements(rows, fallback);
}

export async function fetchInventoryExceptions(fallback: InventoryExceptionDocument[] = []): Promise<InventoryExceptionDocument[]> {
  const rows = await readArray<Partial<InventoryExceptionDocument>>("/api/inventory/exceptions", "exceptions", fallback as Partial<InventoryExceptionDocument>[]);
  return normalizeExceptions(rows, fallback);
}

export async function fetchInventorySummary(fallback?: ApiInventorySummary): Promise<ApiInventorySummary> {
  try {
    const payload = await apiJson<unknown>("/api/inventory/summary");
    if (!isRecord(payload) || !isRecord(payload.summary)) throw new Error("Invalid inventory summary response");
    markSource("/api/inventory/summary", false);
    return payload.summary as ApiInventorySummary;
  } catch (error) {
    warnFallback("/api/inventory/summary", error);
    markSource("/api/inventory/summary", true);
    return fallback ?? {};
  }
}

export async function fetchInventoryAvailability(): Promise<{
  availability: InventoryAvailability[];
  summary: InventoryAllocationSummary;
  risks: InventoryAvailability[];
  dataLimitations: string[];
}> {
  try {
    const payload = await apiJson<unknown>("/api/inventory/availability");
    if (!isRecord(payload) || !Array.isArray(payload.availability) || !isRecord(payload.summary)) {
      throw new Error("Invalid inventory availability response");
    }
    return {
      availability: payload.availability as InventoryAvailability[],
      summary: payload.summary as InventoryAllocationSummary,
      risks: Array.isArray(payload.risks) ? payload.risks as InventoryAvailability[] : [],
      dataLimitations: Array.isArray(payload.dataLimitations) ? payload.dataLimitations.map(String) : [],
    };
  } catch (error) {
    warnFallback("/api/inventory/availability", error);
    return {
      availability: [],
      summary: { skuCount: 0, highRiskSkuCount: 0, totalShortageQty: 0, reservedQty: 0, incomingPurchaseQty: 0, atpInsufficientSkuCount: 0, projectedNegativeSkuCount: 0 },
      risks: [],
      dataLimitations: ["current_workspace_data_limited"],
    };
  }
}

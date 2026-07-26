export type InventoryWarningLevel = "缺货" | "低库存" | "低于安全库存" | "低于再订货点" | "正常";

export type InventoryWarning = {
  sku: string; itemName: string; warehouse: string; currentStock: number;
  reservedQty: number; availableStock: number; safetyStock: number;
  reorderPoint: number; incomingQty: number; projectedAvailable: number;
  shortageQty: number; daysCover: number; riskLevel: InventoryWarningLevel;
  suggestedAction: string; affectedSalesOrders: string[]; incomingPurchaseOrders: string[];
};

// Populated only from authoritative inventory APIs.
export const INVENTORY_WARNINGS: InventoryWarning[] = [];

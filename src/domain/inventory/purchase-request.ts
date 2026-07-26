import { fmt } from "../../lib/format";
import { inventoryPlan, type InventoryItem, type InventoryPlanningFacts } from "./planning";

export function inventoryPurchaseRequestPayload(item: InventoryItem, facts: InventoryPlanningFacts, overrides?: {
  quantity?: number;
  requiredDate?: string;
  reason?: string;
}) {
  const plan = inventoryPlan(item, facts);
  const quantity = Math.max(0, Number(overrides?.quantity ?? plan.suggestedQty));
  return {
    source: "inventory",
    sourceSku: item.sku,
    sourceName: item.name,
    supplier: plan.supplier,
    requester: "",
    buyer: plan.buyer,
    requiredDate: overrides?.requiredDate || `${plan.leadTimeDays}天内`,
    quantity,
    unit: plan.unit,
    unitPrice: plan.unitPrice,
    amount: quantity * plan.unitPrice,
    priority: plan.priority,
    reason: overrides?.reason || `库存低于再订货点：可用 ${plan.projectedAvailable}${plan.unit}，ROP ${plan.reorderPoint}${plan.unit}，覆盖 ${plan.daysCover} 天。策略 ${plan.policy}。`,
    forecastBasis: {
      source: "inventory-control",
      projectedAvailable: plan.projectedAvailable,
      reorderPoint: plan.reorderPoint,
      daysCover: plan.daysCover,
      leadTimeDays: plan.leadTimeDays,
      serviceLevel: plan.serviceLevel,
      moq: plan.moq,
      batchMultiple: plan.batchMultiple,
    },
    approvalSnapshot: {
      source: "inventory",
      summary: `${item.sku} ${item.name} · ${plan.policy} · 建议 ${quantity.toLocaleString()} ${plan.unit} · ${fmt(quantity * plan.unitPrice)}`,
      explanation: `库存控制策略 ${plan.policy} 触发补货：可用 ${plan.projectedAvailable}${plan.unit}，ROP ${plan.reorderPoint}${plan.unit}，覆盖 ${plan.daysCover} 天，建议按 MOQ/批量倍数释放 ${quantity.toLocaleString()} ${plan.unit}。`,
      inventory: {
        projectedAvailable: plan.projectedAvailable,
        reorderPoint: plan.reorderPoint,
        daysCover: plan.daysCover,
        serviceLevel: plan.serviceLevel,
        moq: plan.moq,
        batchMultiple: plan.batchMultiple,
        policy: plan.policy,
      },
      supplier: {
        name: plan.supplier,
        buyer: plan.buyer,
        unitPrice: plan.unitPrice,
        amount: quantity * plan.unitPrice,
      },
      createdAt: new Date().toISOString(),
    },
  };
}

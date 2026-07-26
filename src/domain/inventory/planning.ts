export type InventoryPlanningFacts = {
  monthlyDemand: number;
  unit: string;
  leadTimeDays: number;
  serviceLevel: number;
  moq: number;
  batchMultiple: number;
  allocated: number;
  inbound: number;
  qaHold: number;
  abc: "A" | "B" | "C";
  xyz: "X" | "Y" | "Z";
  supplier?: string;
  unitPrice?: number;
  buyer?: string;
};

export type InventoryItem = {
  sku: string;
  name: string;
  qty: number;
  min: number;
  max: number;
  status: string;
  turnover: number;
};

export function roundUpToBatch(value: number, moq: number, batchMultiple: number) {
  if (value <= 0) return 0;
  const floor = Math.max(value, moq);
  return Math.ceil(floor / batchMultiple) * batchMultiple;
}

export function inventoryPlan(item: InventoryItem, facts: InventoryPlanningFacts) {
  const profile = facts;
  const procurement = {
    supplier: facts.supplier || "",
    unitPrice: Number(facts.unitPrice || 0),
    buyer: facts.buyer || "",
  };
  const dailyDemand = profile.monthlyDemand / 30;
  const onHandAvailable = Math.max(0, item.qty - profile.allocated - profile.qaHold);
  const projectedAvailable = Math.max(0, onHandAvailable + profile.inbound);
  const daysCover = dailyDemand > 0 ? Math.floor(projectedAvailable / dailyDemand) : 999;
  const leadDemand = Math.ceil(dailyDemand * profile.leadTimeDays);
  const reorderPoint = Math.ceil(leadDemand + item.min);
  const targetStock = Math.min(item.max, Math.max(reorderPoint + Math.ceil(profile.monthlyDemand * 0.5), item.min * 2));
  const rawSuggested = projectedAvailable < reorderPoint ? targetStock - projectedAvailable : 0;
  const suggestedQty = roundUpToBatch(rawSuggested, profile.moq, profile.batchMultiple);
  const priority: "高" | "中" | "低" = projectedAvailable <= item.min || daysCover <= profile.leadTimeDays
    ? "高"
    : projectedAvailable <= reorderPoint || daysCover <= profile.leadTimeDays + 7
      ? "中"
      : "低";
  const needsSourcing = suggestedQty > 0 && (!procurement.unitPrice || !procurement.supplier);
  const action = suggestedQty > 0
    ? needsSourcing ? "补供应商/报价" : priority === "高" ? "立即生成 PR" : "纳入本周补货"
    : profile.qaHold > 0 ? "释放冻结库存" : item.qty > item.max * 0.8 && item.turnover < 4 ? "降频采购/清理呆滞" : "保持监控";
  const policy = profile.abc === "A" && profile.xyz === "X"
    ? "AX 补货建议"
    : profile.abc === "A" ? "A 类周滚动复核"
    : profile.xyz === "Z" ? "Z 类按单采购"
    : "周期补货";
  return {
    ...profile,
    supplier: procurement.supplier,
    buyer: procurement.buyer,
    unitPrice: procurement.unitPrice,
    dailyDemand,
    onHandAvailable,
    projectedAvailable,
    daysCover,
    leadDemand,
    reorderPoint,
    targetStock,
    suggestedQty,
    amount: suggestedQty * procurement.unitPrice,
    priority,
    action,
    policy,
    needsSourcing,
  };
}

import { workspaceCopy } from "../../i18n/workspaceCopy";

// Display labels only. Never apply this mapping to stored business values.
// Entity names and return labels come from businessEntityRouteRegistry.
const english: Record<string, string> = {
  "采购申请": "Purchase request", "RFQ": "RFQ", "采购订单": "Purchase order", "收货单": "Receiving document",
  "供应商发票": "Supplier invoice", "采购发票": "Supplier invoice", "返回采购发票": "Back to supplier invoices", "三单匹配": "Three-way match", "供应商对账单": "Supplier statement", "结算单": "Settlement",
  "供应商": "Supplier", "物料": "Item", "客户": "Customer", "仓库": "Warehouse", "库位": "Location",
  "付款条款": "Payment term", "税码": "Tax code", "销售订单": "Sales order", "发货单": "Delivery", "签收单": "Receipt",
  "库存调整单": "Inventory adjustment", "采购退货单": "Purchase return", "贷项通知": "Credit memo", "对账单": "Statement",
  "所有采购申请": "All purchase requests", "返回 RFQ": "Back to RFQs", "返回采购订单": "Back to purchase orders",
  "返回采购收货": "Back to receiving", "返回供应商发票": "Back to supplier invoices", "返回三单匹配": "Back to three-way match",
  "返回供应商对账": "Back to supplier statements", "返回结算单": "Back to settlements", "返回供应商": "Back to suppliers",
  "返回物料资料": "Back to items", "返回客户": "Back to customers", "返回仓库资料": "Back to warehouses",
  "返回库位资料": "Back to locations", "返回付款条款": "Back to payment terms", "返回税码": "Back to tax codes",
  "返回销售订单": "Back to sales orders", "返回发货单": "Back to deliveries", "返回签收单": "Back to receipts",
  "返回库存调整单": "Back to inventory adjustments", "返回采购退货": "Back to purchase returns", "返回贷项通知": "Back to credit memos",
  "返回全局搜索": "Back to search",
};

export function businessEntityCopy(label: string, language: string): string {
  if (language !== "en-US") return label;
  return english[label] || workspaceCopy(label, language);
}

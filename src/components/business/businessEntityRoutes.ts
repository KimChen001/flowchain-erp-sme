export type BusinessEntityType =
  | "purchase_request" | "rfq" | "purchase_order" | "receiving_doc"
  | "supplier_invoice" | "three_way_match" | "reconciliation_statement" | "settlement_document"
  | "supplier" | "item" | "customer" | "sales_order" | "delivery_note" | "sign_receipt"
  | "warehouse" | "bin" | "payment_term" | "tax_code"
  | "inventory_adjustment" | "purchase_return" | "credit_memo";

export type BusinessEntityRoute = {
  entityType: BusinessEntityType;
  routeId: string;
  path: string;
  listRouteId: string;
  listPath: string;
  label: string;
  returnLabel: string;
};

export const businessEntityRouteRegistry: Record<BusinessEntityType, BusinessEntityRoute> = {
  purchase_request: { entityType: "purchase_request", routeId: "procurement:request-detail", path: "/app/procurement/requests/:id", listRouteId: "procurement:requests", listPath: "/app/procurement/requests", label: "采购申请", returnLabel: "所有采购申请" },
  rfq: { entityType: "rfq", routeId: "procurement:rfq-detail", path: "/app/procurement/rfq/:id", listRouteId: "procurement:rfq", listPath: "/app/procurement/rfq", label: "RFQ", returnLabel: "返回 RFQ" },
  purchase_order: { entityType: "purchase_order", routeId: "procurement:order-detail", path: "/app/procurement/orders/:id", listRouteId: "procurement:orders", listPath: "/app/procurement/orders", label: "采购订单", returnLabel: "返回采购订单" },
  receiving_doc: { entityType: "receiving_doc", routeId: "procurement:receiving-detail", path: "/app/procurement/receiving/:id", listRouteId: "procurement:receiving", listPath: "/app/procurement/receiving", label: "收货单", returnLabel: "返回采购收货" },
  supplier_invoice: { entityType: "supplier_invoice", routeId: "procurement:invoice-detail", path: "/app/procurement/invoices/:id", listRouteId: "procurement:invoices", listPath: "/app/procurement/invoices", label: "供应商发票", returnLabel: "返回供应商发票" },
  three_way_match: { entityType: "three_way_match", routeId: "procurement:match-detail", path: "/app/procurement/three-way-match/:id", listRouteId: "procurement:match", listPath: "/app/procurement/three-way-match", label: "三单匹配", returnLabel: "返回三单匹配" },
  reconciliation_statement: { entityType: "reconciliation_statement", routeId: "finance:reconciliation-detail", path: "/app/finance/reconciliation/:id", listRouteId: "finance:reconciliation", listPath: "/app/finance/reconciliation", label: "供应商对账单", returnLabel: "返回供应商对账" },
  settlement_document: { entityType: "settlement_document", routeId: "finance:settlement-detail", path: "/app/finance/settlement/:id", listRouteId: "finance:settlement", listPath: "/app/finance/settlement", label: "结算单", returnLabel: "返回结算单" },
  supplier: { entityType: "supplier", routeId: "master-data:supplier-detail", path: "/app/master-data/suppliers/:id", listRouteId: "master-data:suppliers", listPath: "/app/master-data/suppliers", label: "供应商", returnLabel: "返回供应商" },
  item: { entityType: "item", routeId: "master-data:item-detail", path: "/app/master-data/items/:id", listRouteId: "master-data:items", listPath: "/app/master-data/items", label: "物料", returnLabel: "返回物料资料" },
  customer: { entityType: "customer", routeId: "master-data:customer-detail", path: "/app/master-data/customers/:id", listRouteId: "master-data:customers", listPath: "/app/master-data/customers", label: "客户", returnLabel: "返回客户" },
  warehouse: { entityType: "warehouse", routeId: "master-data:warehouse-detail", path: "/app/master-data/warehouses/:id", listRouteId: "master-data:warehouses", listPath: "/app/master-data/warehouses", label: "仓库", returnLabel: "返回仓库资料" },
  bin: { entityType: "bin", routeId: "master-data:bin-detail", path: "/app/master-data/bins/:id", listRouteId: "master-data:bins", listPath: "/app/master-data/bins", label: "库位", returnLabel: "返回库位资料" },
  payment_term: { entityType: "payment_term", routeId: "master-data:payment-term-detail", path: "/app/master-data/payment-terms/:id", listRouteId: "master-data:payment-terms", listPath: "/app/master-data/payment-terms", label: "付款条款", returnLabel: "返回付款条款" },
  tax_code: { entityType: "tax_code", routeId: "master-data:tax-code-detail", path: "/app/master-data/tax-codes/:id", listRouteId: "master-data:tax-codes", listPath: "/app/master-data/tax-codes", label: "税码", returnLabel: "返回税码" },
  sales_order: { entityType: "sales_order", routeId: "sales:order-detail", path: "/app/sales/orders/:id", listRouteId: "sales:orders", listPath: "/app/sales/orders", label: "销售订单", returnLabel: "返回销售订单" },
  delivery_note: { entityType: "delivery_note", routeId: "sales:delivery-detail", path: "/app/sales/deliveries/:id", listRouteId: "sales:delivery", listPath: "/app/sales/deliveries", label: "发货单", returnLabel: "返回发货单" },
  sign_receipt: { entityType: "sign_receipt", routeId: "sales:receipt-detail", path: "/app/sales/receipts/:id", listRouteId: "sales:receipts", listPath: "/app/sales/receipts", label: "签收单", returnLabel: "返回签收单" },
  inventory_adjustment: { entityType: "inventory_adjustment", routeId: "inventory:adjustment-detail", path: "/app/inventory/adjustments/:id", listRouteId: "inventory:adjustments", listPath: "/app/inventory/adjustments", label: "库存调整单", returnLabel: "返回库存调整单" },
  purchase_return: { entityType: "purchase_return", routeId: "procurement:returns", path: "/app/procurement/returns?record=:id", listRouteId: "procurement:returns", listPath: "/app/procurement/returns", label: "采购退货单", returnLabel: "返回采购退货" },
  credit_memo: { entityType: "credit_memo", routeId: "finance:credit-memo-detail", path: "/app/finance/credit-memos/:id", listRouteId: "finance:credits", listPath: "/app/finance/credits", label: "贷项通知", returnLabel: "返回贷项通知" },
};

export function businessEntityPath(entityType: BusinessEntityType, id: string) {
  return businessEntityRouteRegistry[entityType].path.replace(":id", encodeURIComponent(id));
}

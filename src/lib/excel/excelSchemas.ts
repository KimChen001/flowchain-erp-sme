export type ExcelFieldType = "text" | "date" | "number" | "amount" | "currency" | "status";
export type ExcelFieldSchema = {
  key: string; label: string; required?: boolean; type: ExcelFieldType; description: string; example: string | number;
  aliases?: string[]; options?: string[]; masterData?: string; validation?: string;
};
export type ExcelBusinessSchema = { id: string; label: string; filename: string; fields: ExcelFieldSchema[] };

const field = (key: string, label: string, type: ExcelFieldType, example: string | number, description: string, extra: Partial<ExcelFieldSchema> = {}): ExcelFieldSchema => ({ key, label, type, example, description, ...extra });
const common = {
  supplierCode: field("supplierCode", "供应商编号", "text", "SUP-FS-STD", "已存在的供应商编号", { required: true, aliases: ["供应商编码"], masterData: "供应商", validation: "必须存在于供应商基础资料" }),
  currency: field("currency", "币种", "currency", "CNY", "ISO 4217 币种", { required: true, options: ["CNY", "USD", "EUR"], validation: "仅允许配置币种" }),
  date: (key: string, label: string, example: string) => field(key, label, "date", example, "日期字段", { required: true, validation: "YYYY-MM-DD" }),
  amount: (key: string, label: string, example: number) => field(key, label, "amount", example, "金额字段", { required: true, validation: "大于或等于 0 的数值" }),
};

export const excelBusinessSchemas: Record<string, ExcelBusinessSchema> = {
  "采购发票": { id: "supplier-invoice", label: "采购发票", filename: "supplier-invoice-import-template.xlsx", fields: [field("invoiceNumber", "发票编号", "text", "INV-FO-260501", "供应商发票号码", { required: true, aliases: ["发票号"], validation: "同供应商内唯一" }), common.supplierCode, field("relatedPo", "PO编号", "text", "PO-2026-1284", "关联采购订单", { required: true, aliases: ["采购订单"], masterData: "采购订单", validation: "PO 必须存在" }), field("relatedGrn", "GRN编号", "text", "GRN-202605-0418", "关联收货单", { aliases: ["收货单"], masterData: "收货单", validation: "如填写则必须存在" }), common.date("invoiceDate", "发票日期", "2026-05-31"), common.date("dueDate", "到期日期", "2026-06-30"), common.currency, common.amount("subtotal", "税前金额", 380000), common.amount("tax", "税额", 49400), common.amount("total", "含税金额", 429400)] },
  "发票": { id: "supplier-invoice", label: "采购发票", filename: "supplier-invoice-import-template.xlsx", fields: [] },
  "对账单": { id: "supplier-reconciliation", label: "供应商对账单", filename: "supplier-reconciliation-import-template.xlsx", fields: [field("statementNo", "对账单号", "text", "REC-2026-06-FO-001", "对账单唯一编号", { required: true }), common.supplierCode, common.date("periodStart", "期间开始", "2026-06-01"), common.date("periodEnd", "期间结束", "2026-06-30"), common.currency, common.amount("totalInvoiceAmount", "发票金额", 429400), common.amount("openBalance", "未结余额", 309400), field("status", "对账状态", "status", "待确认", "对账状态", { required: true, options: ["草稿", "待确认", "存在差异", "已确认", "已关闭"] })] },
  "采购申请": { id: "purchase-request", label: "采购申请", filename: "purchase-request-import-template.xlsx", fields: [field("pr", "PR编号", "text", "PR-2026-2501", "采购申请唯一编号", { required: true, aliases: ["采购申请编号"] }), field("sourceSku", "SKU", "text", "SKU-00412", "需求物料", { required: true, aliases: ["物料编号"], masterData: "物料", validation: "SKU 必须存在" }), field("quantity", "数量", "number", 24, "申请数量", { required: true, validation: "大于 0" }), field("unit", "单位", "text", "台", "计量单位", { required: true }), common.date("requiredDate", "需求日期", "2026-07-25"), common.supplierCode, field("priority", "优先级", "status", "中", "业务优先级", { required: true, options: ["高", "中", "低"] }), field("status", "状态", "status", "草稿", "采购申请状态", { required: true, options: ["草稿", "待审批", "已批准"] })] },
  "供应商资料": { id: "supplier-master", label: "供应商资料", filename: "supplier-master-import-template.xlsx", fields: [field("code", "供应商编号", "text", "SUP-BJ-001", "供应商唯一编号", { required: true }), field("name", "供应商名称", "text", "北京精密部件有限公司", "供应商法定名称", { required: true }), field("category", "品类", "text", "机械部件", "主要供货品类", { required: true }), field("contact", "联系人", "text", "王经理", "业务联系人", { required: true }), field("email", "邮箱", "text", "wang@example.com", "联系人邮箱", { required: true, validation: "有效邮箱" }), common.currency, field("status", "状态", "status", "启用", "基础资料状态", { required: true, options: ["启用", "停用", "待完善"] })] },
  "物料资料": { id: "item-master", label: "物料资料", filename: "item-master-import-template.xlsx", fields: [field("sku", "SKU", "text", "SKU-01100", "物料唯一编号", { required: true, aliases: ["物料编号"] }), field("name", "物料名称", "text", "精密联轴器", "物料名称", { required: true }), field("category", "品类", "text", "机械部件", "物料品类", { required: true }), field("unit", "单位", "text", "件", "基本计量单位", { required: true }), field("defaultWarehouse", "默认仓库", "text", "上海总仓", "默认存储仓库", { required: true, masterData: "仓库" }), field("safetyStock", "安全库存", "number", 100, "安全库存数量", { required: true, validation: "大于或等于 0" }), field("status", "状态", "status", "启用", "物料状态", { required: true, options: ["启用", "停用", "待完善"] })] },
  "客户资料": { id: "customer-master", label: "客户资料", filename: "customer-master-import-template.xlsx", fields: [field("code", "客户编号", "text", "CUS-006", "客户唯一编号", { required: true }), field("name", "客户名称", "text", "杭州智能制造有限公司", "客户法定名称", { required: true }), field("contact", "联系人", "text", "陈经理", "业务联系人", { required: true }), field("email", "邮箱", "text", "chen@example.com", "联系邮箱", { required: true }), common.currency, field("status", "状态", "status", "启用", "客户状态", { required: true, options: ["启用", "停用"] })] },
  "库存余额": { id: "inventory-balance", label: "库存余额", filename: "inventory-balance-import-template.xlsx", fields: [field("sku", "SKU", "text", "SKU-00412", "物料编号", { required: true, masterData: "物料" }), field("warehouse", "仓库", "text", "上海总仓", "库存仓库", { required: true, masterData: "仓库" }), field("bin", "库位", "text", "D-02-01", "仓库库位", { required: true }), field("quantity", "库存数量", "number", 32, "当前库存", { required: true, validation: "大于或等于 0" }), common.date("asOfDate", "库存日期", "2026-07-11"), field("status", "状态", "status", "可用", "库存状态", { required: true, options: ["可用", "冻结", "待检"] })] },
};
excelBusinessSchemas["发票"].fields = excelBusinessSchemas["采购发票"].fields;

export function schemaForEntity(label: string) {
  if (excelBusinessSchemas[label]) return excelBusinessSchemas[label];
  if (/供应商/.test(label)) return excelBusinessSchemas["供应商资料"];
  if (/物料|商品/.test(label)) return excelBusinessSchemas["物料资料"];
  if (/客户/.test(label) && !/订单/.test(label)) return excelBusinessSchemas["客户资料"];
  if (/库存余额/.test(label)) return excelBusinessSchemas["库存余额"];
  if (/发票/.test(label)) return excelBusinessSchemas["采购发票"];
  if (/对账/.test(label)) return excelBusinessSchemas["对账单"];
  return excelBusinessSchemas["采购申请"];
}

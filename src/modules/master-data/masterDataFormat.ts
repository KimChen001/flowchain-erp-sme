// React-free so it can be tested and reused outside components.
import { workspaceCopy } from "../../i18n/workspaceCopy";

// English source copy for the master data tables, with its Chinese
// translation. The adapter still stores a few status tokens in Chinese
// (启用, 冻结, 正常, ...), so those are listed too and either form renders in
// the active language.
const zh: Record<string, string> = {
  "Customer code": "客户编号", "Customer name": "客户名称", "Contact": "联系人", "Phone": "电话", "Address": "地址",
  "Credit status": "信用状态", "Payment terms": "付款条款", "Status": "状态", "Actions": "操作", "View details": "查看详情",
  "Details": "详情", "Yes": "是", "No": "否",
  "No customers yet. Create or import customers to continue.": "真实客户主数据为空，请创建或导入客户后再继续。",
  "New customer": "新建客户", "Currency": "币种", "Email": "邮箱", "Save customer": "保存客户", "Cancel": "取消",
  "Saving…": "正在保存…", "Set inactive": "设为停用", "Set active": "设为启用", "Could not save the customer.": "客户保存失败。",
  "Could not change the customer status.": "客户状态修改失败。",
  "Template name": "模板名称", "Document type": "单据类型", "Default": "默认", "Custom": "自定义", "Last updated": "最近更新时间",
  "Copy template": "复制模板", "Preview": "预览", "Document type: {value}": "单据类型：{value}", "Updated: {value}": "更新时间：{value}",
  "{name} (copy)": "{name} 副本",
  "Standard receiving slip": "标准入库单", "Purchase receipt / receiving slip": "采购收货单 / 入库单",
  "Standard delivery note": "标准发货单", "Sales shipment / delivery note": "销售出库单 / 发货单",
  "Standard delivery receipt": "标准签收单", "Delivery receipt": "签收单",
  "Warehouse code": "仓库编码", "Warehouse name": "仓库名称", "Zone": "库区", "Bin": "库位", "Capacity": "容量",
  "Utilization": "利用率", "Temperature requirement": "温控要求", "QA status": "QA状态", "Available": "可用", "Owner": "负责人",
  "Tax code": "税码", "Tax code name": "税码名称", "Tax rate": "税率", "Tax type": "税种", "Region": "区域", "Description": "描述",
  "Term code": "条款编码", "Term name": "条款名称", "Net days": "净账期天数", "Discount rule": "折扣规则", "Due date rule": "到期规则",
  "Due on receipt": "收到发票即到期", "Due {days} days after the invoice date": "发票日期后 {days} 天到期",
  "Sales tax": "销售税", "Use tax": "使用税", "VAT": "增值税", "Input VAT": "进项税", "Output VAT": "销项税",
  "Exempt": "免税", "Zero-rated": "零税率",
  "Active": "启用", "Inactive": "停用", "Incomplete": "待完善", "Needs review": "待复核", "Frozen": "冻结",
  "Normal": "正常", "Restricted": "受限", "Pending assessment": "待评估",
  "Your session has expired. Sign in again to view master data.": "登录已失效，请重新登录后查看基础资料。",
  "You do not have permission to view master data.": "当前用户没有查看基础资料的权限。",
  "The master data service route was not found.": "基础资料服务路由不存在。",
  "The master data service failed. Try again later.": "基础资料服务发生错误，请稍后重试。",
  "Could not reach the master data service. Check your network or the local API.": "无法连接基础资料服务，请检查网络或本地 API。",
  "{count} incomplete": "{count} 条待完善", "{count} high risk": "{count} 个高风险", "{count} available": "{count} 个可用",
  "{count} need attention": "{count} 个需关注",
  "Export file created": "导出文件已生成",
  "Item name": "物料名称", "Category": "物料分类", "Specification": "规格型号", "Unit": "单位", "Default warehouse": "默认仓库",
  "Default bin": "默认库位", "Safety stock": "安全库存", "Maximum stock": "最大库存", "Reorder point": "再订货点",
  "Lead time (days)": "采购提前期（天）", "Batch managed": "批次管理", "Serial managed": "序列号管理", "QA required": "质检要求",
  "Default supplier": "默认供应商", "Default tax code": "默认税码",
  // The items list page.
  "Items": "物料总数", "{count} active": "{count} 个启用", "Inactive items": "停用物料",
  "Kept for history, not offered on new documents": "保留历史记录，新单据中不再提供",
  "No reorder point": "未设再订货点", "Active items the reorder list cannot check": "补货清单无法检查的启用物料",
  "No preferred supplier": "无首选供应商", "Active items without a supplier to order from": "没有可下单供应商的启用物料",
  "Item search": "物料查询", "Search items by SKU, name, status, type and category.": "按 SKU、名称、状态、类型和分类查询物料。",
  "Reset": "重置", "Export results": "导出当前结果", "Search": "搜索", "Type": "类型", "Filter by type": "按类型筛选",
  "All types": "全部类型", "Filter by category": "按分类筛选", "All categories": "全部分类", "Item list": "物料列表",
  "{total} items, {shown} shown": "共 {total} 个物料，当前显示 {shown} 个", "MOQ": "最小起订量", "Preferred supplier": "首选供应商",
  "No items match these filters": "没有符合筛选条件的物料",
  "Create an item or import a file of items to get started.": "新建物料或导入物料文件即可开始。",
  "Uncategorized": "未分类", "Not set: the reorder list does not check this item": "未设置：补货清单不会检查该物料",
  "View": "查看", "Material": "物料", "Purchase unit": "采购单位",
  "Safety stock / reorder point": "安全库存 / 再订货点", "Lead time": "提前期", "{count} days": "{count} 天",
  // The reference lists (customers, warehouses, tax codes, payment terms, print templates).
  "All statuses": "全部状态", "All QA statuses": "全部 QA 状态", "All document types": "全部单据类型",
  "{total} records, {shown} shown": "共 {total} 条，当前显示 {shown} 条", "1 record, {shown} shown": "共 1 条，当前显示 {shown} 条",
  "1 item, {shown} shown": "共 1 个物料，当前显示 {shown} 个", "No records match these filters": "没有符合筛选条件的记录",
  "Customer search": "客户查询", "Search customers by code, name, contact, phone, address or payment terms.": "按编号、名称、联系人、电话、地址或付款条款查询客户。",
  "Customer list": "客户列表", "Warehouse search": "仓库查询", "Search warehouses by code, name, zone, bin or owner.": "按编码、名称、库区、库位或负责人查询仓库。",
  "Warehouse list": "仓库列表", "No warehouses yet.": "暂无仓库。", "Tax code search": "税码查询",
  "Search tax codes by code, name, type, region or description.": "按编码、名称、税种、区域或描述查询税码。", "Tax code list": "税码列表",
  "No tax codes yet.": "暂无税码。", "Payment term search": "付款条款查询", "Search payment terms by code, name or description.": "按编码、名称或描述查询付款条款。",
  "Payment term list": "付款条款列表", "No payment terms yet.": "暂无付款条款。", "Print template search": "打印模板查询",
  "Search templates by name or document type.": "按名称或单据类型查询模板。", "Print template list": "打印模板列表", "No print templates yet.": "暂无打印模板。",
};
const en = Object.fromEntries(Object.entries(zh).map(([english, chinese]) => [chinese, english]));

// Backend tax type codes (TaxCode.taxType). Unknown codes are shown as stored.
const TAX_TYPE_LABELS: Record<string, string> = {
  sales_tax: "Sales tax", use_tax: "Use tax", vat: "VAT", input_vat: "Input VAT", output_vat: "Output VAT",
  exempt: "Exempt", zero_rated: "Zero-rated",
};

export const NOT_PROVIDED = "—";

export function masterDataCopy(value: string, language: string, params: Record<string, string | number> = {}) {
  const translated = language === "en-US"
    ? en[value] || workspaceCopy(value, language)
    : zh[value] || value;
  return Object.entries(params).reduce((text, [key, param]) => text.replaceAll(`{${key}}`, String(param)), translated);
}

export function taxTypeLabel(value: string, language: string) {
  const code = String(value || "").trim();
  if (!code) return NOT_PROVIDED;
  return masterDataCopy(TAX_TYPE_LABELS[code.toLowerCase()] || code, language);
}

// Tax rates are stored as fractions with four decimals (0.0825), so two
// fraction digits in percent keep every stored digit (8.25%).
export function formatPercent(rate: number, locale: string) {
  if (!Number.isFinite(rate)) return NOT_PROVIDED;
  return new Intl.NumberFormat(locale || "en-US", { style: "percent", maximumFractionDigits: 2 }).format(rate);
}

export function dueDateRule(netDays: number, language: string) {
  if (!Number.isFinite(netDays)) return NOT_PROVIDED;
  return netDays === 0
    ? masterDataCopy("Due on receipt", language)
    : masterDataCopy("Due {days} days after the invoice date", language, { days: netDays });
}

export function orNotProvided(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text || NOT_PROVIDED;
}

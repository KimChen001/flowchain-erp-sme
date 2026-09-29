import { useCallback } from "react";
import { useI18n } from "../../i18n/I18n";
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

export function useMasterDataCopy() {
  const { language, locale } = useI18n();
  const copy = useCallback(
    (value: string, params?: Record<string, string | number>) => masterDataCopy(value, language, params),
    [language],
  );
  return { copy, language, locale };
}

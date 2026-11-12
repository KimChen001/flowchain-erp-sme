// A permission code as words a person reads ("View purchase orders"), in
// English with its Chinese translation. The code itself (server/auth/
// permission-catalog.mjs) stays the stored value and is shown as a tooltip.

type Pair = [string, string];

const ACTIONS: Record<string, Pair> = {
  read: ["View", "查看"],
  manage: ["Manage", "管理"],
  assign: ["Assign", "分配"],
  create: ["Create", "创建"],
  cancel: ["Cancel", "取消"],
  review: ["Review", "复核"],
  commit: ["Commit", "提交"],
  publish: ["Publish", "发布"],
  revise: ["Edit", "修改"],
  submit: ["Submit", "提交"],
  approve: ["Approve", "批准"],
  reject: ["Reject", "驳回"],
  expire: ["Expire", "使过期："],
  prepare: ["Prepare", "准备"],
  ready: ["Mark ready:", "标记就绪："],
  post: ["Post", "过账"],
  reverse: ["Reverse", "冲销"],
  release_prepare: ["Prepare release of", "准备放行"],
  release_post: ["Post release of", "过账放行"],
  release_reverse: ["Reverse release of", "冲销放行"],
  execute: ["Run", "执行"],
  send: ["Send", "发送"],
  hold: ["Hold", "暂停"],
  release: ["Release", "释放"],
  mark_export_ready: ["Mark export ready:", "标记可导出："],
  record_payment: ["Record payments on", "记录付款："],
  issue: ["Issue", "开具"],
  dispute: ["Dispute", "提出争议："],
  resolve_dispute: ["Resolve disputes on", "解决争议："],
  record_external_reference: ["Add external references to", "添加外部参考号："],
  apply: ["Apply", "应用"],
  import: ["Import", "导入"],
  validate: ["Validate", "校验"],
  void: ["Void", "作废"],
  export: ["Export", "导出"],
  generate_candidates: ["Find match candidates in", "生成匹配候选："],
  confirm: ["Confirm", "确认"],
  dismiss_candidate: ["Dismiss match candidates in", "忽略匹配候选："],
  resolve_exception: ["Resolve exceptions in", "处理异常："],
  use: ["Use", "使用"],
};

// By module/resource, as some resource names repeat across modules.
const RESOURCES: Record<string, Pair> = {
  "settings/workspace": ["workspace settings", "工作区设置"],
  "settings/users": ["users", "用户"],
  "settings/roles": ["roles", "角色"],
  "settings/numbering": ["numbering rules", "编号规则"],
  "settings/review_policy": ["review policies", "复核策略"],
  "settings/modules": ["menus and modules", "菜单与模块"],
  "settings/import": ["data imports", "数据导入"],
  "settings/warehouse_import": ["warehouse imports", "仓库导入"],
  "settings/diagnostics": ["system readiness checks", "系统就绪检查"],
  "settings/export": ["data exports", "数据导出"],
  "audit/audit_log": ["the audit log", "审计日志"],
  "master_data/item": ["items", "物料"],
  "master_data/supplier": ["suppliers", "供应商"],
  "master_data/customer": ["customers", "客户"],
  "contracts/contract": ["contracts", "合同"],
  "universal-intake/artifact": ["uploaded files", "上传文件"],
  "universal-intake/batch": ["import batches", "导入批次"],
  "universal-intake/mapping": ["column mappings", "字段映射"],
  "universal-intake/review": ["imported data", "导入数据"],
  "universal-intake/commit": ["imported data", "导入数据"],
  "universal-intake/custom_field": ["custom fields", "自定义字段"],
  "returns/request": ["return requests", "退货申请"],
  "returns/customer_request": ["customer return requests", "客户退货申请"],
  "returns/authorization": ["return authorizations", "退货授权"],
  "returns/posting": ["return postings", "退货过账单"],
  "returns/quarantine": ["quarantined stock", "隔离库存"],
  "receiving/receiving": ["receipts", "收货单"],
  "sales/sales_order": ["sales orders", "销售订单"],
  "sales/shipment": ["shipments", "发货单"],
  "inventory/balance": ["stock balances", "库存余额"],
  "inventory/transfer": ["stock transfers", "库存调拨"],
  "inventory/count": ["cycle counts", "盘点"],
  "inventory/adjustment": ["inventory adjustments", "库存调整"],
  "finance/overview": ["the finance overview", "财务概览"],
  "finance/amounts": ["finance amounts", "财务金额"],
  "finance/partner_snapshot": ["supplier and customer details on finance records", "财务单据中的往来方信息"],
  "procurement/prices": ["purchase prices", "采购价格"],
  "finance/supplier_invoice": ["supplier invoices", "采购发票"],
  "finance/three_way_match": ["three-way matches", "三单匹配"],
  "finance/match_exception": ["match exceptions", "匹配异常"],
  "finance/payable": ["payables", "应付款"],
  "finance/supplier_credit": ["supplier credit memos", "供应商贷项通知"],
  "finance/customer_invoice": ["customer invoices", "销售发票"],
  "finance/receivable": ["receivables", "应收款"],
  "finance/customer_credit": ["customer credit notes", "客户贷项通知"],
  "finance/cashbook": ["the internal cashbook", "内部现金账"],
  "finance/settlement": ["internal settlements", "内部核销"],
  "finance/settlement_reconciliation": ["settlement reconciliation", "核销对账"],
  "finance/advance": ["advances", "预付款"],
  "finance/internal_transfer": ["internal fund transfers", "内部资金调拨"],
  "finance/settlement_discount": ["settlement discounts", "核销折扣"],
  "finance/settlement_attachment": ["settlement attachments", "核销附件"],
  "finance/bank_statement": ["bank statements", "银行流水"],
  "finance/bank_mapping": ["bank file mappings", "银行文件映射"],
  "finance/bank_reconciliation": ["bank reconciliation", "银行对账"],
  "procurement/purchase_order": ["purchase orders", "采购订单"],
  "procurement/rfq_response": ["RFQ responses", "询价回复"],
  "procurement/rfq_award": ["RFQ awards", "询价授标"],
  "procurement/supplier_message": ["follow-up emails to suppliers", "给供应商的催货邮件"],
  "mobile/sync": ["mobile sync", "移动端同步"],
  "mobile/tasks": ["mobile tasks", "移动端任务"],
  "mobile/procurement_approval": ["purchase approvals on mobile", "移动端采购审批"],
  "mobile/receiving": ["receiving on mobile", "移动端收货"],
};

// Codes whose action and resource do not read well joined.
const WHOLE: Record<string, Pair> = {
  "audit.read_sensitive": ["View sensitive audit details", "查看敏感审计信息"],
  "intake.review": ["Review imported data", "复核导入数据"],
  "intake.commit": ["Commit imported data", "提交导入数据"],
  "mobile.sync.use": ["Use mobile sync", "使用移动端同步"],
  "settings.export.read": ["Export data", "导出数据"],
  "settings.diagnostics.read": ["View system readiness checks", "查看系统就绪检查"],
};

const humanize = (value: string) => value.replace(/[_-]+/g, " ").trim();

export function permissionLabel(permission: { code: string; module: string; resource: string; action: string }, english: boolean) {
  const index = english ? 0 : 1;
  const whole = WHOLE[permission.code];
  if (whole) return whole[index];
  const action = ACTIONS[permission.action]?.[index] ?? humanize(permission.action);
  const resource = RESOURCES[`${permission.module}/${permission.resource}`]?.[index] ?? humanize(permission.resource);
  if (!english) return `${action}${resource}`;
  const text = `${action} ${resource}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

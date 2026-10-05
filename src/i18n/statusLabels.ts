// Display labels for the lowercase status and type codes that the server
// returns (for example "issued" or "partially_received"). Codes are stable
// business values: translate them only when rendering, never before storing.
const statusCodes: Record<string, [string, string]> = {
  draft: ["Draft", "草稿"],
  submitted: ["Submitted", "已提交"],
  pending: ["Pending", "待处理"],
  pending_approval: ["Pending approval", "待审批"],
  approved: ["Approved", "已批准"],
  rejected: ["Rejected", "已拒绝"],
  cancelled: ["Cancelled", "已取消"],
  canceled: ["Cancelled", "已取消"],
  withdrawn: ["Withdrawn", "已撤回"],
  issued: ["Issued", "已下达"],
  sent: ["Sent", "已发送"],
  not_sent: ["Not sent", "未发送"],
  open: ["Open", "进行中"],
  closed: ["Closed", "已关闭"],
  completed: ["Completed", "已完成"],
  converted: ["Converted", "已转换"],
  collecting_quotes: ["Collecting quotes", "报价收集中"],
  awarded: ["Awarded", "已授标"],
  not_received: ["Not received", "未收货"],
  partially_received: ["Partially received", "部分收货"],
  fully_received: ["Fully received", "全部收货"],
  received: ["Received", "已收货"],
  ready_for_receiving: ["Ready for posting", "待过账"],
  unposted: ["Unposted", "未过账"],
  posted: ["Posted", "已过账"],
  reversed: ["Reversed", "已冲销"],
  partial: ["Partial", "部分"],
  passed: ["Passed", "已通过"],
  failed: ["Failed", "未通过"],
  matched: ["Matched", "已匹配"],
  mismatch: ["Mismatch", "不一致"],
  not_matched: ["Not matched", "未匹配"],
  variance: ["Variance", "有差异"],
  exception: ["Exception", "异常"],
  disputed: ["Disputed", "有争议"],
  unavailable: ["Unavailable", "不可用"],
  active: ["Active", "启用"],
  inactive: ["Inactive", "停用"],
  available: ["Available", "可用"],
  quarantined: ["Quarantined", "隔离中"],
  on_hold: ["On hold", "已暂停"],
};

// Inventory movement types, as the ledger records them.
const movementTypes: Record<string, [string, string]> = {
  receipt_posting: ["Goods receipt", "采购入库"],
  receipt: ["Goods receipt", "采购入库"],
  receipt_reversal: ["Receipt reversal", "收货冲销"],
  shipment_posting: ["Shipment", "销售出库"],
  outbound_posting: ["Shipment", "销售出库"],
  shipment_reversal: ["Shipment reversal", "出库冲销"],
  stock_transfer_in: ["Transfer in", "调拨入库"],
  stock_transfer_out: ["Transfer out", "调拨出库"],
  stock_transfer_reversal_in: ["Transfer reversal in", "调拨冲销入库"],
  stock_transfer_reversal_out: ["Transfer reversal out", "调拨冲销出库"],
  inventory_adjustment: ["Inventory adjustment", "库存调整"],
  inventory_adjustment_reversal: ["Adjustment reversal", "调整冲销"],
  adjustment: ["Inventory adjustment", "库存调整"],
  cycle_count_adjustment: ["Cycle count adjustment", "盘点调整"],
  opening_balance: ["Opening balance", "期初余额"],
  supplier_return_out: ["Supplier return", "供应商退货"],
  supplier_return_reversal: ["Supplier return reversal", "供应商退货冲销"],
  customer_return_quarantine_in: ["Customer return to quarantine", "客户退货入隔离"],
  customer_return_receipt_reversal: ["Customer return reversal", "客户退货冲销"],
  quarantine_release_out: ["Quarantine release out", "隔离释放出"],
  quarantine_release_available_in: ["Quarantine release in", "隔离释放入可用"],
};

// Reasons an inventory adjustment movement records, so opening stock does not
// read the same as a damage or shrinkage write-off.
const adjustmentReasons: Record<string, [string, string]> = {
  opening_balance: ["Opening stock", "期初库存"],
  found_stock: ["Found stock", "盘盈"],
  damage: ["Damage", "损坏"],
  shrinkage: ["Shrinkage", "损耗"],
  data_correction: ["Data correction", "数据更正"],
  quality_disposition: ["Quality disposition", "质量处置"],
  other: ["Other", "其他"],
};

export function movementTypeLabel(code: string, language: string, reason?: string | null): string {
  const index = language === "en-US" ? 0 : 1;
  const pair = movementTypes[String(code || "").trim()];
  const label = pair ? pair[index] : language === "en-US" ? "Inventory movement" : "库存移动";
  const reasonPair = String(code || "").trim() === "inventory_adjustment" ? adjustmentReasons[String(reason || "").trim()] : undefined;
  return reasonPair ? `${label} · ${reasonPair[index]}` : label;
}

export function statusCodeLabel(code: string, language: string): string | undefined {
  const pair = statusCodes[String(code || "").trim()];
  return pair ? pair[language === "en-US" ? 0 : 1] : undefined;
}

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
  unavailable: ["Unavailable", "不可用"],
  active: ["Active", "启用"],
  inactive: ["Inactive", "停用"],
  available: ["Available", "可用"],
  quarantined: ["Quarantined", "隔离中"],
  on_hold: ["On hold", "已暂停"],
};

export function statusCodeLabel(code: string, language: string): string | undefined {
  const pair = statusCodes[String(code || "").trim()];
  return pair ? pair[language === "en-US" ? 0 : 1] : undefined;
}

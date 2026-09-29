// Translate system labels only; names, amounts and identifiers stay untouched.
const labels: Record<string, [string, string]> = {
  draft_po_review: ['Draft PO awaiting review', 'Draft PO 待复核'],
  request_approval: ['Purchase request awaiting approval', '采购申请待审批'],
  request_conversion: ['Purchase request ready for conversion', '采购申请待转换'],
  approved_request: ['Approved; ready to create a draft PO', '审批已完成，等待生成 Draft PO'],
  high: ['High', '高'], medium: ['Medium', '中'], low: ['Low', '低'],
  purchase_request: ['Purchase request', '采购申请'], purchase_order: ['Purchase order', '采购订单'], rfq: ['RFQ', '询价'],
  draft: ['Draft', '草稿'], submitted: ['Submitted', '已提交'], pending_approval: ['Pending approval', '待审批'],
  approved: ['Approved', '已批准'], rejected: ['Rejected', '已拒绝'], cancelled: ['Cancelled', '已取消'],
  issued: ['Issued', '已下达'], partially_received: ['Partially received', '部分收货'], fully_received: ['Fully received', '全部收货'],
  closed: ['Closed', '已关闭'], converted: ['Converted', '已转换'], collecting_quotes: ['Collecting quotes', '报价收集中'],
  open: ['Open', '进行中'], sent: ['Sent', '已发送'], not_sent: ['Not sent', '未发送'],
};
export function homeLabel(value: string, language: string) {
  const pair = labels[value] || Object.values(labels).find(pair => pair.includes(value));
  return pair ? pair[language === 'en-US' ? 0 : 1] : value;
}
export function homeDescription(value: string, language: string) {
  if (language !== 'en-US') return homeLabel(value, language);
  if (value.startsWith('申请金额 ')) return `Request amount ${value.slice('申请金额 '.length)}`;
  if (value.startsWith('供应商 ')) {
    const remainder = value.slice('供应商 '.length);
    const divider = remainder.lastIndexOf(' · ');
    return `Supplier ${divider < 0 ? remainder : remainder.slice(0, divider) + ' · ' + homeLabel(remainder.slice(divider + 3), language)}`;
  }
  return homeLabel(value, language);
}

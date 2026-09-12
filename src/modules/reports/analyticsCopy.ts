// Presentation labels only. Do not translate record names or identifiers.
const chinese: Record<string, string> = {
  'Mixed units': '混合计量单位',
  'Inventory uses different units; quantities are shown by SKU without a combined stock total.': '库存使用不同计量单位，数量按 SKU 展示，不合计在手总量。',
  'Undated': '无日期', 'Unspecified': '未指定', 'Status': '状态', 'Quantity': '数量', 'Amount': '金额', 'Available': '可用量', 'Shortage': '缺口',
  'Supplier count': '供应商数量', 'Supplier invoice amount': '供应商发票金额', 'Open POs': '开放 PO',
  'On-hand inventory': '在手库存', 'Unfulfilled sales demand': '未履约销售需求',
  'Count of sales orders in the current range.': '当前范围内真实销售订单记录数。',
  'Ordered quantity less fulfilled quantity, before inventory reservations.': '订单数量扣除已履约数量，不扣减库存预留。',
  'Total recorded purchase order amount in the current range.': '当前范围内真实采购订单金额合计。',
  'Purchase orders that are not closed, cancelled, or completed.': '未关闭且未取消的真实采购订单数。',
  'On-hand quantity recorded in inventory.': 'Inventory Runtime 已记录的在手数量。',
  'SKUs with a shortage under the shared availability calculation.': '按统一 availability 口径存在 shortage 的 SKU 数。',
  'Total amount of connected supplier invoice records.': '当前已接通发票记录金额合计。',
  'Count of supplier master records.': '当前供应商主数据记录数。',
  'No business records in this range': '当前范围无真实业务记录',
  'No records in the selected range.': '当前筛选范围暂无真实 runtime 记录。',
  'Change chart visibility and order. Your layout is saved in the page link.': '调整图表显示与顺序；结果会保留在当前 URL。',
  'Close customization': '关闭调整当前视图', 'Ranking size': '排行榜显示数量', 'Chart visibility and order': '图表显示与顺序',
  'Hidden': '已隐藏', 'Visible': '已显示', 'Move up': '上移', 'Move down': '下移', 'Restore default layout': '恢复默认布局',
  'Current filtered scope': '当前筛选范围', 'Calculation': '口径说明', 'Date field': '时间字段', 'Version': '版本',
  'Dashboard filtered': '已筛选当前看板', 'Kept after refresh': '刷新页面后仍会保留', 'Keep at least one chart visible': '至少保留一个可见图表',
  'Name this view': '保存当前视图名称', 'View saved': '视图已保存', 'Could not save view': '保存视图失败', 'Please try again': '请重试',
  'Workbook exported': '看板工作簿已导出', 'Could not export workbook': '导出失败',
  'Single currency': '单一币种', 'Filtered currency': '已筛选币种', 'Currency code': '币种代码', 'Currency name': '币种显示名称',
  'Currency aggregation': '币种汇总状态', 'FX converted': '是否已汇率折算', 'Yes': '是', 'No': '否',
  'Chart': '图表名称', 'Dimension': '维度', 'Series': '系列', 'Value': '数值', 'Uncategorized': '未分类',
  'Metric summary': '指标摘要', 'Metric': '指标名称', 'Current value': '当前值', 'Baseline value': '上期值', 'Change': '变化',
  'Definition': '中文定义', 'Data range': '数据范围', 'Chart data': '图表数据', 'Detail data': '明细数据', 'Filters': '筛选条件',
  'Not compared': '未比较', 'Numerator': '分子', 'Denominator': '分母', 'Not applicable': '不适用', 'Metric version': '指标版本',
  'Data limitations': '数据限制', 'None': '无', 'Source subject': '来源对象', 'Reserved': 'reserved', 'Fulfilled': 'fulfilled',
  'Operational snapshot': '运营概览', 'See what changed. Focus on what needs attention.': '查看业务变化，优先关注待处理事项。',
  'Record activity by month': '每月业务记录活动', 'Purchase orders': '采购订单', 'Sales orders': '销售订单',
  'Purchase order status': '采购订单状态', 'Purchasing by supplier': '按供应商统计采购订单',
  'Needs attention': '需要关注', 'Open purchase orders': '未完成采购订单', 'Inventory shortages': '库存短缺',
  'Unfulfilled sales orders': '未履约销售订单', 'Review orders': '查看订单', 'Review inventory': '查看库存',
  'Counts use the current filters. Select a card to review the source records.': '数量基于当前筛选，点击卡片查看来源记录。',
  'Activity uses the latest recorded update date, falling back to creation date. Counts are orders, not revenue.': '活动按最近更新日期统计，缺失时使用创建日期。数量表示订单数，并非收入。',
  'Purchase order details': '采购订单明细', 'Sales order details': '销售订单明细', 'Inventory details': '库存明细', 'Invoice details': '发票明细', 'Supplier details': '供应商明细',
  'Showing': '显示', 'of': '共', 'records in the loaded scope': '条已加载范围内的记录',
  'Dates must use YYYY-MM-DD.': '日期必须使用 YYYY-MM-DD。', 'Start date must not be after end date.': '开始日期不得晚于结束日期。',
  'Record date': '记录日期', 'Current workspace records': '当前工作区 runtime 数据', 'Business records': 'BusinessReadContext',
};
const english = Object.fromEntries(Object.entries(chinese).map(([en, zh]) => [zh, en]));
export function analyticsCopy(value: string, language: string) {
  return language === 'en-US' ? english[value] || value : chinese[value] || value;
}

export function reportStatusCopy(value: string, language: string) {
  const states: Record<string, [string, string]> = {
    fully_received: ['Fully received', '全部收货'], pending_approval: ['Pending approval', '待审批'], rejected: ['Rejected', '已拒绝'],
    shortage_risk: ['Shortage risk', '缺货风险'], partially_fulfilled: ['Partially fulfilled', '部分履约'], fulfilled: ['Fulfilled', '已履约'],
    ready_to_ship: ['Ready to ship', '可发货'], partially_allocated: ['Partially allocated', '部分分配'], on_hold: ['On hold', '已暂停'],
    issued: ['Issued', '已下达'], partially_received: ['Partially received', '部分收货'], received: ['Received', '已收货'],
    open: ['Open', '进行中'], closed: ['Closed', '已关闭'], cancelled: ['Cancelled', '已取消'], completed: ['Completed', '已完成'],
    draft: ['Draft', '草稿'], approved: ['Approved', '已批准'], active: ['Active', '启用'], inactive: ['Inactive', '停用'],
    high: ['High', '高'], medium: ['Medium', '中'], low: ['Low', '低'], unknown: ['Unknown', '未知'],
    partial: ['Partial', '部分履约'], delivered: ['Delivered', '已交付'], confirmed: ['Confirmed', '已确认'],
  };
  const pair = states[value];
  return pair ? pair[language === 'en-US' ? 0 : 1] : analyticsCopy(value, language);
}

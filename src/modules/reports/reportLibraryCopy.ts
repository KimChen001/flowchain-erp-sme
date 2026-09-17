// Presentation copy only: report names and other user-owned values stay intact.
const english: Record<string, string> = {
  '标准报表': 'Standard reports', '我的报表': 'My reports', '团队共享': 'Team reports', '最近使用': 'Recently opened',
  '报表库': 'Report library', '受控业务主题、标准模板、我的视图与团队共享报表': 'Explore standard reports, personal views, and reports shared with your team',
  '基于模板创建报表': 'Create report', '逾期采购订单': 'Overdue purchase orders', '销售订单履约': 'Sales order fulfillment',
  '库存风险': 'Inventory risk', '待处理发票': 'Open invoices', '供应商绩效': 'Supplier performance',
  '采购分析': 'Procurement analytics', '销售分析': 'Sales analytics', '库存分析': 'Inventory analytics', '结算分析': 'Settlement analytics', '供应商分析': 'Supplier analytics',
  '采购订单': 'Purchase orders', '销售订单': 'Sales orders', '库存余额': 'Inventory balances', '供应商发票': 'Supplier invoices', '供应商': 'Suppliers',
  '采购申请': 'Purchase requests', '询报价': 'RFQs and quotations', '收货': 'Receiving',
  '系统标准报表': 'Standard report', '当前工作区': 'Current workspace', '打开报表': 'Open report',
  '报表名称': 'Report name', '业务主题': 'Business subject', '创建人': 'Created by', '可见范围': 'Visibility', '最近更新': 'Last updated', '版本': 'Version', '操作': 'Actions',
  '受控业务主题': 'Business subject', '私有': 'Private', '打开': 'Open', '复制': 'Copy', '共享': 'Share', '删除': 'Delete',
  '当前视图暂无报表': 'No reports in this view', '从标准分析页保存当前筛选，或基于受控模板创建。': 'Save a view from an analytics page or create a report using a template.',
  '选择受控主题、字段、指标与展示方式，不开放任意 SQL 或自由 Join。': 'Choose the business subject, columns, metrics, and presentation for your report.',
  '例如：华东逾期采购订单': 'For example: Overdue purchase orders', '展示方式': 'Presentation', '表格': 'Table', '柱状图': 'Bar chart', '折线图': 'Line chart', '堆叠柱状图': 'Stacked bar chart', '环形图': 'Donut chart',
  '已选字段': 'Selected columns', '受控字段': 'Report column', '选择字段': 'Choose columns', '选择指标': 'Choose metrics', '取消': 'Cancel', '保存为私有报表': 'Save private report',
  '请填写报表名称': 'Enter a report name', '基于受控业务主题和字段目录创建': 'Created from the business subject and column catalog',
  '我的报表已创建': 'Report created', '创建失败': 'Could not create report', '请重试': 'Please try again', '报表已复制': 'Report copied',
  '业务编号': 'Business ID', '业务日期': 'Business date', '客户': 'Customer', '金额': 'Amount', '数量': 'Quantity', '状态': 'Status',
  '销售订单数量': 'Sales order count', '未履约销售需求': 'Unfulfilled sales demand', '采购订单金额': 'Purchase order amount', '开放 PO': 'Open POs',
  '在手库存': 'On-hand inventory', '库存风险 SKU': 'Inventory risk SKUs', '供应商发票金额': 'Supplier invoice amount', '供应商数量': 'Supplier count',
  '关闭': 'Close', '无法加载报表库': 'Could not load the report library', '无法加载报表模板': 'Could not load report templates',
  '无法完成此操作': 'Could not complete this action', '重试': 'Retry', '正在加载报表库': 'Loading report library',
};

export function reportLibraryCopy(value: string, language: string) {
  return language === 'en-US' ? english[value] || value : value;
}

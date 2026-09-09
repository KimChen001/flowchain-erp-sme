// Display labels only. Never apply this mapping to stored business values.
const english: Record<string, string> = {
  '工作区管理员': 'Workspace administrator', '正在加载基础资料…': 'Loading master data…', '基础资料加载失败': 'Could not load master data', '重新加载': 'Reload',
  '今日': 'Today', '采购': 'Purchasing', '采购履约': 'Purchase fulfillment', '库存': 'Inventory', '销售': 'Sales', '供应商': 'Suppliers', '物料': 'Items', '报表': 'Reports', '数据接入': 'Data intake', '复核队列': 'Review queue',
  '商品资料 / 物料资料': 'Item master', '商品資料 / 物料資料': 'Item master', '物料资料': 'Items', '供应商资料': 'Suppliers', '仓库 / 库位': 'Warehouses / locations', '客户资料': 'Customers',
  '搜索基础资料': 'Search master data', '导出当前结果': 'Export results', '旧导入已停用': 'Legacy import retired',
  '物料 ID': 'Item ID', 'SKU 编码': 'SKU code', '物料名称': 'Item name', '简称': 'Short name', '物料类型': 'Item type', '分类': 'Category', '品牌': 'Brand', '规格型号': 'Specification', '基本单位': 'Base unit', '采购单位': 'Purchase unit', '默认仓库': 'Default warehouse', '税码': 'Tax code', '安全库存': 'Safety stock', '再订货点': 'Reorder point', '最小订购量': 'Minimum order quantity', '采购提前期（天）': 'Purchase lead time (days)', '条码': 'Barcode', '制造商料号': 'Manufacturer part number', '管理备注': 'Notes',
  '状态': 'Status', '状态筛选': 'Filter by status', '全部状态': 'All statuses', '启用': 'Active', '停用': 'Inactive', '搜索 SKU': 'Search SKU', '搜索 SKU 编码或物料名称': 'Search by SKU or item name', '新建 SKU': 'New SKU', '编辑 SKU': 'Edit SKU', '编辑': 'Edit', '取消': 'Cancel', '保存': 'Save', '类型': 'Type', '单位': 'Unit', '规格': 'Specification', '操作': 'Actions', '暂无物料资料': 'No items yet', '← 返回 SKU 列表': '← Back to items',
  '基础信息、采购库存属性与追踪属性': 'General information, purchasing, inventory, and tracking',
  '可以新建物料、使用 Structured Intake，或在本地运行 pilot:setup:demo。': 'Create an item or import records through Structured Intake.',
};
export function workspaceCopy(label: string, language: string): string {
  return language === 'en-US' ? english[label] || label : label;
}

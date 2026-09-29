const zh: Record<string, string> = {
  'New supplier': '新增供应商', 'Edit supplier': '编辑供应商', 'Save supplier': '保存供应商', 'Saving…': '正在保存…', 'Cancel': '取消',
  'Start with the essentials. Add contact and commercial details when available.': '先填写必要资料，再补充联系方式和商务信息。',
  'Basic information': '基本信息', 'Contact and address': '联系与地址', 'Commercial terms': '商业条款', 'Tax and bank details': '财税与银行',
  'Optional': '选填', 'Required fields': '必填字段', 'Supplier code': '供应商编号', 'Supplier name': '供应商名称', 'Short name': '简称',
  'Business type': '经营类型', 'Categories': '经营品类', 'Contact name': '联系人', 'Phone': '联系电话', 'Email': '邮箱', 'Address': '地址',
  'Postal / ZIP code': '邮编', 'Delivery lead time (days)': '送货周期（天）', 'Default currency': '默认币种', 'Payment terms': '付款条款',
  'Settlement method': '结算方式', 'Business registration ID': '统一社会信用代码', 'Tax ID': '税号', 'Bank name': '银行', 'Account holder': '户名',
  'Account number': '银行账号', 'Internal notes': '内部备注', 'Status': '状态', 'Active': '启用', 'Inactive': '停用', 'Draft': '草稿',
  'Use a unique code, such as SUP-001.': '使用唯一编号，例如 SUP-001。', 'Separate categories with commas.': '多个品类请用逗号分隔。',
  'Tax identifiers depend on the supplier’s country.': '税务登记信息取决于供应商所在国家。', 'Supplier saved': '供应商已保存',
  'Enter a supplier code.': '请填写供应商编号。', 'Enter a supplier name.': '请填写供应商名称。', 'Enter a valid email address.': '请填写有效邮箱。',
  'Lead time must be a whole number of days, zero or greater.': '送货周期必须为零或正整数天。', 'Choose a valid currency.': '请选择有效币种。',
  'Check the highlighted fields.': '请检查标记的字段。', 'This supplier code is already in use.': '该供应商编号已被使用。',
  'This supplier changed. Reopen it and try again.': '供应商已被修改，请重新打开后再试。', 'Could not save supplier. Please try again.': '保存失败，请重试。',
  'Could not load workspace currency. Choose a currency before saving.': '无法读取工作区币种，请在保存前选择币种。', 'Choose currency': '选择币种',
  'Back to suppliers': '返回供应商列表', 'Edit': '编辑', 'Supplied items': '可供应物料', 'Select SKU': '选择 SKU', 'Reference price': '参考价格',
  'Add supplied item': '新增供应商关系', 'No supplied items yet': '暂无可供应物料', 'Set as preferred': '设为首选', 'Yes': '是', 'No': '否',
  'Purchase records': '采购记录', 'No purchase records available': '暂无采购交易记录', 'Risks and exceptions': '风险与异常', 'No risks or exceptions available': '暂无风险或异常',
  'Supplied-item links are currently unavailable.': '可供应物料关联暂不可用。',
};
const en = Object.fromEntries(Object.entries(zh).map(([key, value]) => [value, key]));
export const supplierCopy = (value: string, language: string) => language === 'en-US' ? en[value] || value : zh[value] || value;

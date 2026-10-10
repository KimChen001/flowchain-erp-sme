// The Contracts pages' copy (docs/contracts-module-design.md, K1): English
// source text with its Chinese translation. Keys are the English text; the
// owner-rule test (server/domain/owner-rule-invariants.test.mjs) checks that
// every entry has Chinese and that no two entries share one Chinese text.
// {name} placeholders are filled by contractCopy.
const zh: Record<string, string> = {
  // Navigation and page titles.
  'Contracts': '合同', 'Ending soon': '即将到期', 'New contract': '新建合同', 'Edit contract': '编辑合同',
  'Back to contracts': '返回合同列表',
  // States, as people see them.
  'Draft': '草稿', 'Drafts': '草稿合同', 'Active': '生效中', 'Notice due': '通知截止将至', 'Past end date': '已过到期日', 'Ended': '已到期',
  'Renewed': '已续约', 'Terminated': '已终止',
  // Types.
  'Purchase agreement': '采购协议', 'Service agreement': '服务协议', 'NDA': '保密协议', 'Quality agreement': '质量协议', 'Other': '其他',
  // Renewal.
  'Does not renew': '不续约', 'Renews automatically': '自动续约', 'Renew by agreement': '协商续约',
  // Key dates.
  'Notice by': '通知截止', 'Ends': '到期', 'Terminated on': '终止于', 'No end date': '无到期日',
  // List cards.
  'In force': '有效合同', 'Active, including those with a date coming up': '生效中，含关键日期将至的合同', 'End date within the reminder window': '到期日在提醒期内',
  'Renews automatically unless notice is given': '如不发出通知将自动续约', 'Not active yet': '尚未生效',
  // Search card.
  'Contract search': '合同查询', 'Search contracts by number, their reference, title, supplier, type, state and owner.': '按合同编号、对方编号、标题、供应商、类型、状态和负责人查询合同。',
  'Search': '搜索', 'Search contracts': '搜索合同', 'Number, title or supplier': '编号、标题或供应商',
  'Type': '类型', 'All types': '全部类型', 'Type filter': '类型筛选', 'State': '状态', 'All states': '全部状态', 'State filter': '状态筛选',
  'Owner': '负责人', 'All owners': '全部负责人', 'Mine': '我负责的', 'No owner': '无负责人', 'Owner filter': '负责人筛选',
  'Supplier': '供应商', 'All suppliers': '全部供应商', 'Supplier filter': '供应商筛选', 'Reset': '重置', 'Refresh': '刷新',
  // List card and table.
  'Contract list': '合同列表', '{total} contracts, {shown} shown': '共 {total} 份合同，当前显示 {shown} 份', '1 contract, {shown} shown': '共 1 份合同，当前显示 {shown} 份',
  'Number': '合同编号', 'Title': '标题', 'Start': '开始', 'End': '结束', 'Key date': '关键日期', 'Status': '合同状态', 'Actions': '操作',
  'Open': '打开', 'Edit': '编辑',
  'No contracts yet. Record a signed agreement to track its dates.': '暂无合同。记录一份已签署的协议，即可跟踪其关键日期。',
  'No contracts match these filters': '没有符合筛选条件的合同', 'Reset the filters to see every contract.': '重置筛选即可查看全部合同。',
  'Only the first {count} are shown. Narrow the search to see the rest.': '仅显示前 {count} 份，请缩小查询范围以查看其余合同。',
  'Could not load contracts.': '合同加载失败。', 'Retry': '重试', 'Loading…': '正在加载…',
  // Ending soon.
  'Contracts to act on': '需处理的合同',
  'Earliest key date first, never by a score. A contract shows here once its key date is inside its own reminder window.': '按关键日期从早到晚排列，从不按评分排序。合同的关键日期进入其提醒期后会显示在这里。',
  'It renews automatically unless notice is given by the notice deadline.': '除非在通知截止日前发出通知，否则将自动续约。',
  'The end date is inside the reminder window. Renew it or let it end.': '到期日已进入提醒期。请续约或让其到期。',
  'It renews automatically and its end date has passed. Record the new end date.': '合同自动续约且已过到期日。请记录新的到期日。',
  'Nothing to act on now': '目前没有需处理的合同',
  'Contracts whose notice deadline or end date is inside their reminder window are listed here.': '通知截止日或到期日进入提醒期的合同会列在这里。',
  // Detail.
  'Contract': '合同记录', 'Their reference': '对方编号', 'Terms': '条款', 'Dates and renewal': '日期与续约', 'Value': '金额',
  'Files': '文件', 'Renewal links': '续约关联', 'History': '历史记录',
  'Start date': '开始日期', 'End date': '到期日', 'Signed on': '签署日期', 'Renewal': '续约方式', 'Notice period': '通知期',
  'Notice deadline': '通知截止日', 'Remind me': '提前提醒', '{n} days': '{n} 天', '1 day': '1 天', '{n} days before the key date': '关键日期前 {n} 天',
  'Payment terms': '付款条款', 'Currency': '币种', 'Total value': '合同总额', 'Notes': '备注', 'Not recorded': '未记录',
  'Hidden for your role': '你的角色不可见', 'Termination reason': '终止原因',
  'Renews {number}': '续约自 {number}', 'Renewed by {number}': '已由 {number} 续约', 'Renewal draft {number} in progress': '续约草稿 {number} 进行中',
  'No renewal recorded.': '暂无续约记录。',
  'No files yet. Add the signed agreement as a PDF or an image.': '暂无文件。请以 PDF 或图片形式添加已签署的协议。',
  'PDF or image (JPEG, PNG, WebP), up to 20 MB.': 'PDF 或图片（JPEG、PNG、WebP），最大 20 MB。',
  'Download': '下载', 'Remove': '移除', 'Added by {name} on {date}': '{name} 于 {date} 添加', 'Uploading…': '正在上传…',
  'No history yet.': '暂无历史记录。', 'by {name}': '操作人：{name}', 'System': '系统',
  'Could not load this contract.': '无法加载该合同。', 'This contract was not found. It may have been deleted.': '未找到该合同，可能已被删除。',
  // Actions.
  'Activate': '生效', 'Renew': '续约', 'Terminate': '终止', 'Delete draft': '删除草稿', 'Add file': '添加文件', 'Cancel': '取消',
  'Activate contract': '使合同生效', 'Record the day it was signed and the day it starts.': '请填写签署日期和开始日期。',
  'Terminate contract': '终止合同', 'Ending a contract early cannot be undone. Record the date and the reason.': '提前终止合同后无法撤销。请填写终止日期和原因。',
  'Termination date': '终止日期', 'Reason': '原因', 'Terminate the contract': '确认终止',
  'Delete this draft? Its files are removed with it. This cannot be undone.': '确定删除该草稿吗？其文件将一并移除，且无法撤销。',
  'Remove {name}? It stays in the history.': '确定移除 {name} 吗？历史记录中仍会保留。',
  'Start a renewal? A new draft is created with these terms; this contract stays as it is until the renewal is activated.': '确定开始续约吗？系统会按现有条款新建一份草稿；续约生效前，本合同保持不变。',
  'Start the renewal': '开始续约',
  'Contract activated': '合同已生效', 'Contract terminated': '合同已终止', 'Draft deleted': '草稿已删除', 'File added': '文件已添加',
  'File removed': '文件已移除', 'Renewal draft created': '续约草稿已创建', 'Contract saved': '合同已保存',
  'Reload': '重新加载', 'Working…': '处理中…',
  // Form.
  'Record a signed agreement. It is saved as a draft; activate it once the signed date and start date are in.': '记录一份已签署的协议。保存后为草稿，填写签署日期和开始日期后即可生效。',
  'Required fields': '必填字段', 'Choose a supplier': '选择供应商', 'Choose a type': '选择类型',
  "The supplier's business owner": '供应商的业务负责人', 'Gets the reminders on Today.': '在“今日”页接收提醒。',
  'Leave empty for an open-ended contract.': '无固定到期日时请留空。',
  'Days before the end date by which notice must be given.': '必须在到期日前多少天发出通知。',
  'Days before the key date that it shows on Today and Ending soon.': '在关键日期前多少天出现在“今日”和“即将到期”中。',
  'Choose currency': '选择币种', 'Save draft': '保存草稿', 'Save changes': '保存修改', 'Saving…': '正在保存…',
  'An active contract keeps its supplier and type. Renew it to change them.': '生效中的合同不能更改供应商和类型。如需更改，请续约。',
  'Could not load the workspace users. The owner defaults to the supplier\'s business owner.': '无法读取工作区用户，负责人默认为供应商的业务负责人。',
  'Could not load the workspace payment terms.': '无法读取工作区付款条款。', 'Could not load suppliers.': '供应商数据加载失败。',
  // Supplier page tab.
  "This supplier's contracts": '该供应商的合同', 'No contracts with this supplier yet.': '该供应商暂无合同。',
  // History actions.
  'Created': '已创建', 'Created to renew {number}': '为续约 {number} 而创建', 'Updated': '已修改', 'Changed: {fields}': '修改内容：{fields}',
  'Activated': '已生效', 'Signed {signed}, starts {start}': '{signed} 签署，{start} 开始', 'On {date}: {reason}': '于 {date} 终止：{reason}',
  'Renewal started': '已开始续约', 'Renewal draft {number}': '续约草稿 {number}', 'Draft removed': '草稿已移除', 'Changed': '已变更',
  // Errors.
  'This contract was changed by someone else. Reload it to see the latest version.': '该合同已被他人修改。请重新加载以查看最新版本。',
  'This contract already has a renewal: {number}.': '该合同已有续约：{number}。',
  "This contract's status changed. Reload it and try again.": '合同状态已变化，请重新加载后再试。',
  'A terminated contract cannot be edited.': '已终止的合同不能编辑。',
  'The supplier and type of an active contract cannot change. Renew it instead.': '生效中合同的供应商和类型不能更改，请改为续约。',
  'Only an active contract can be renewed.': '只有生效中的合同才能续约。', 'Only a draft contract can be deleted.': '只有草稿合同才能删除。',
  'Nothing changed.': '没有任何修改。', 'Check the highlighted fields.': '请检查标记的字段。',
  'Contracts are not turned on for this workspace.': '本工作区未开启合同功能。', 'Your role does not allow this.': '你的角色无权执行此操作。',
  'Your session has ended. Sign in again.': '登录已过期，请重新登录。',
  'Another change landed at the same time. Reload and try again.': '同时有其他修改提交，请重新加载后再试。',
  'A signed file must be a PDF or an image (JPEG, PNG or WebP) of at most 20 MB.': '签署文件必须是 PDF 或图片（JPEG、PNG 或 WebP），且不超过 20 MB。',
  'The file could not be uploaded. Try again.': '文件上传失败，请重试。',
  'This file was already removed. Reload the contract.': '该文件已被移除，请重新加载合同。',
  'The stored file failed its integrity check. Ask an administrator.': '已存储文件未通过完整性校验，请联系管理员。',
  'File storage is not available right now.': '文件存储暂不可用。',
  'The request could not be completed. Try again.': '请求未能完成，请重试。',
  'The file could not be downloaded.': '文件下载失败。',
  // Field errors.
  'Enter a title.': '请填写标题。', 'Choose a contract type.': '请选择合同类型。', 'Choose a supplier.': '请选择供应商。',
  'An active contract needs its signed date and start date.': '生效中的合同需要签署日期和开始日期。',
  'Enter the termination date.': '请填写终止日期。', 'Enter why the contract was terminated.': '请填写终止原因。',
  'Use at most {max} characters.': '最多 {max} 个字符。', 'Choose how the contract renews.': '请选择续约方式。',
  'Enter a date as YYYY-MM-DD.': '请按 YYYY-MM-DD 格式填写日期。', 'Enter a whole number of days from 0 to {max}.': '请输入 0 到 {max} 之间的整数天数。',
  'Choose a valid currency.': '请选择有效币种。', 'Enter an amount of 0 or more with at most four decimal places.': '请输入不小于 0、最多四位小数的金额。',
  'The end date must be on or after the start date.': '到期日不能早于开始日期。', 'The signed date cannot be after today.': '签署日期不能晚于今天。',
  'The termination date cannot be before the signed date.': '终止日期不能早于签署日期。', 'Choose a supplier of this workspace.': '请选择本工作区的供应商。',
  'Choose an active user of this workspace.': '请选择本工作区的在职用户。', 'Choose one of the workspace payment terms.': '请选择工作区中的付款条款。',
  'An active contract keeps its supplier and type.': '生效中的合同保留其供应商和类型。', 'Upload the file first.': '请先上传文件。', 'Check this field.': '请检查此字段。',
};

const fill = (text: string, variables: Record<string, string | number>) =>
  Object.entries(variables).reduce((output, [name, value]) => output.replaceAll(`{${name}}`, String(value)), text);

// The English to Chinese pairs, read by the owner-rule tests.
export const contractCopyPairs: Readonly<Record<string, string>> = zh;
export const contractCopy = (value: string, language: string, variables: Record<string, string | number> = {}) =>
  fill(language === 'en-US' ? value : zh[value] || value, variables);

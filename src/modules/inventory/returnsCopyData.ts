// Display copy for the returns and quarantine screens (inventory returns
// workbench, quarantine inventory, sales returns list and the sales return
// form). English is the source text; each entry below is its Chinese
// translation. Codes and stored values sent to or read from the server are
// never translated here, only their display labels.
//
// This file has no imports so a node test can load it directly.

export const returnsChinese: Record<string, string> = {
  // Shared states
  "Retry": "重试",
  "Loading returns and quarantine records…": "正在读取退货与隔离库存数据…",
  "Returns and quarantine are not enabled yet. Records are read only, and create, authorize, post and reverse actions are off.":
    "退货与隔离库存尚未启用。正式记录保持只读，创建、授权、过账和冲销动作均已关闭。",
  "Preview · {result}": "执行预览 · {result}",
  "Allowed": "允许执行",
  "Blocked": "存在阻断",
  "Available {before} → {after}": "可用 {before} → {after}",
  "Working…": "正在执行…",
  "Confirm": "确认执行",
  "The action is blocked.": "该动作被阻断。",
  "Check this before you continue.": "请在继续前核对此项。",
  "Open workbench →": "打开工作台 →",
  "Open workbench": "打开工作台",

  // Landing
  "Returns": "退货管理",
  "Requests, authorizations, physical execution and quarantine disposition share one evidence trail.":
    "申请、授权、物理执行与隔离库存处置使用同一证据链。",
  "Return requests": "退货申请",
  "Create, submit and track customer or supplier return requests.": "创建、提交并追踪客户或供应商退货申请。",
  "Return authorizations": "退货授权",
  "A manager reviews quantities and disposition routes.": "由经理复核数量与处置路径。",
  "Return execution": "退货执行",
  "Preview, post, reconcile line by line and reverse safely.": "预览、过账、逐行对账与安全冲销。",
  "Quarantined inventory": "隔离库存",
  "Shown apart from available inventory and cannot be reserved.": "与可用库存分开显示，不可预留。",

  // Lists
  "Could not load returns": "退货列表读取失败",
  "Records: {n}": "共 {n} 条正式记录",
  "New return request": "新建退货申请",
  "Search returns": "搜索退货记录",
  "Number, partner, source document, SKU": "单号、伙伴、来源单据、SKU",
  "Return type": "退货类型",
  "All types": "全部类型",
  "Workflow status": "流程状态",
  "All statuses": "全部状态",
  "Sort by": "排序字段",
  "Updated": "更新时间",
  "Number": "单号",
  "Sort direction": "排序方向",
  "Descending": "降序",
  "Ascending": "升序",
  "Type": "类型",
  "Status": "状态",
  "Source / related": "来源 / 关联",
  "Lines": "行数",
  "Warehouse": "仓库",
  "Actions": "操作",
  "No records match the current filters.": "当前筛选范围没有正式记录。",
  "Page {page} of {pages}": "第 {page} / {pages} 页",
  "Previous": "上一页",
  "Next": "下一页",

  // New return request
  "Could not load source documents": "来源数据读取失败",
  "Could not load the preview": "预览失败",
  "Could not create the request": "创建失败",
  "← Back to return requests": "← 返回退货申请",
  "Request number": "申请单号",
  "Source document (choose one)": "来源单据（必须明确选择）",
  "Source document": "来源单据",
  "Select a posted source document": "请选择正式已过账来源单据",
  "Unnamed partner": "未命名伙伴",
  "Reason code": "原因代码",
  "Reason details": "原因说明",
  "Source lines (choose each line)": "来源行（必须逐行明确选择）",
  "Select source line {sku}": "选择来源行 {sku}",
  "Source quantity {quantity} {unit} · warehouse {warehouses}": "来源数量 {quantity} {unit} · 仓库 {warehouses}",
  "Requested quantity {sku}": "申请数量 {sku}",
  "Requested quantity": "申请数量",
  "Choose a source document to see its lines. No line is selected for you.":
    "选择来源单据后显示可申请行；系统不会自动选择第一行。",
  "Preview request": "预览申请",
  "Confirm request": "确认创建申请",

  // Request workbench
  "Could not load the workbench": "工作台读取失败",
  "Preview submit": "预览提交",
  "Preview cancellation": "预览取消",
  "Action limits: {codes}": "动作限制：{codes}",
  "Item": "物料",
  "Source line": "来源行",
  "Source quantity": "来源数量",
  "Quarantine release authorization": "隔离库存释放授权",
  "Manager authorization": "经理授权",
  "Authorization number": "授权单号",
  "Requested {quantity} {unit}": "申请 {quantity} {unit}",
  "Authorized quantity {sku}": "授权数量 {sku}",
  "Authorized quantity": "授权数量",
  "Disposition route {sku}": "处置路径 {sku}",
  "Select a disposition route": "请选择处置路径",
  "Preview authorization": "预览授权",
  "Cancellation reason": "取消原因",
  "Confirm authorization": "确认授权",
  "Confirm submit": "确认提交",
  "Confirm cancellation": "确认取消",
  "Authorization history": "授权历史",
  "No authorizations yet.": "尚无授权记录。",

  // Authorization workbench
  "← Back to return authorizations": "← 返回退货授权",
  "Source request {number}": "来源申请 {number}",
  "Version {n}": "版本 {n}",
  "Authorized {quantity} {unit}": "授权 {quantity} {unit}",
  "{route}; choose every balance. None is selected for you.": "{route}；所有余额必须明确选择，系统不会默认第一条。",
  "Posting quantity {sku}": "执行数量 {sku}",
  "Posting quantity": "执行数量",
  "Available balance {sku}": "可用库存余额 {sku}",
  "Quarantine balance {sku}": "隔离库存余额 {sku}",
  "Destination available balance {sku}": "目标可用库存余额 {sku}",
  "Posting number": "执行单号",
  "Preview posting draft": "预览执行草稿",
  "Create posting draft": "确认创建执行单",
  "Select a balance": "请选择余额",
  "No location": "无库位",
  "Available {quantity}": "可用 {quantity}",
  "Quarantine {quantity}": "隔离 {quantity}",

  // Posting workbench
  "← Back to return execution": "← 返回退货执行",
  "Preview: mark ready to post": "预览就绪",
  "Preview posting": "预览过账",
  "Preview reversal": "预览冲销",
  "Request {number}": "申请 {number}",
  "Authorization {number}": "授权 {number}",
  "Batch {id}": "批次 {id}",
  "Not created yet": "尚未生成",
  "Quantity": "数量",
  "Disposition route": "处置路径",
  "Source balance": "来源余额",
  "Destination balance": "目标余额",
  "Warehouse / location": "仓库 / 库位",
  "Reversal reason": "冲销原因",
  "Reversal reason (required)": "必须填写冲销原因",
  "Confirm ready to post": "确认就绪",
  "Confirm posting": "确认过账",
  "Confirm reversal": "确认冲销",
  "Related records": "智能链接",
  "Line reconciliation": "逐行对账",
  "Each return line is checked on its own. Lines never offset each other to show a match.":
    "不同退货行独立核对，不允许通过总量正负抵消显示一致。",
  "Calculated {calculated} / recorded {recorded}": "计算 {calculated} / 记录 {recorded}",
  "The action could not be completed": "操作未能完成",
  "Evidence and activity log": "证据与操作日志",
  "No evidence yet.": "暂无证据记录。",
  "System": "系统",
  "Audit event": "正式审计事件",
  "In {in} / out {out}": "入 {in} / 出 {out}",

  // Quarantine inventory
  "Could not load quarantine inventory": "隔离库存读取失败",
  "Quarantined quantities are shown apart from available inventory and cannot be reserved or sold.":
    "隔离数量与普通可用库存分开显示，不能预留或销售。",
  "Quarantine SKU": "隔离库存 SKU",
  "Quarantine warehouse": "隔离库存仓库",
  "Warehouse ID": "仓库 ID",
  "Quarantine status": "隔离库存状态",
  "Rows per page": "每页条数",
  "{n} / page": "{n} / 页",
  "Location": "库位",
  "Quarantine quantity": "隔离数量",
  "Available quantity": "可用数量",
  "Reservable": "可预留",
  "— (separate stock type)": "—（独立库存类别）",
  "No": "否",
  "No quarantined inventory matches the current filters.": "当前筛选范围没有隔离库存。",

  // Sales returns list (/app/sales/returns)
  "New sales return": "新建退货单",
  "Sales returns": "退货单",
  "In progress": "处理中",
  "Search sales returns": "搜索销售退货单",
  "Search by return number, customer or order": "搜索退货单号、客户、订单",
  "Return status": "退货状态",
  "Sales returns: {n}": "{n} 张退货单",
  "Return number": "退货单号",
  "Customer": "客户",
  "Sales order number": "销售订单号",
  "Delivery number": "发货单号",
  "Return date": "退货日期",
  "Return quantity": "退货数量",
  "Return reason": "退货原因",
  "Processing status": "处理状态",
  "View details": "查看详情",
  "Sales return details": "销售退货单详情",
  "Sales order": "销售订单",
  "Delivery": "发货单",
  "Receiving warehouse": "收货仓库",
  "Created by": "创建人",
  "Reviewed by": "审核人",
  "Awaiting review": "待审核",
  "Notes": "备注",
  "Return lines": "退货明细",
  "Item name": "商品名称",
  "Shipped quantity": "原发货数",
  "Received quantity": "已收数量",
  "Unit": "单位",
  "Condition": "货况",
  "No sales returns are recorded here. Customer returns are requested under Inventory › Returns.":
    "此处没有销售退货记录。客户退货请在“库存管理 › 退货管理”中申请。",

  // Sales return form (/app/sales/returns/new)
  "Sales return": "销售退货单",
  "New {label}": "新建{label}",
  "Edit {label}": "编辑{label}",
  "Back to list": "返回列表",
  "Unsaved changes": "有未保存修改",
  "Drafts are not stored here": "此处不保存草稿",
  "Document number": "单据编号",
  "Business date": "业务日期",
  "Party": "业务对象",
  "Customer, supplier or warehouse": "客户、供应商或仓库",
  "Cancel": "取消",
  "This form does not store anything. Customer returns are requested under Inventory › Returns.":
    "此表单不保存任何内容。客户退货请在“库存管理 › 退货管理”中申请。",

  // Error text built from a server field name
  "Enter the {field}.": "请填写{field}。",
};

// Status, type, route, balance, movement and audit action codes as the
// returns server sends them. [English, Chinese]. Returns keep their own
// wording for some statuses (submitted = awaiting authorization, ready =
// ready to post), so these are not shared with the global status labels.
export const returnsCodeLabels: Record<string, [string, string]> = {
  // Workflow and posting statuses
  draft: ["Draft", "草稿"],
  submitted: ["Awaiting authorization", "待授权"],
  authorized: ["Authorized", "已授权"],
  partially_executed: ["Partially executed", "部分执行"],
  executed: ["Executed", "已执行"],
  approved: ["Approved", "已批准"],
  rejected: ["Rejected", "已拒绝"],
  cancelled: ["Cancelled", "已取消"],
  expired: ["Expired", "已过期"],
  ready: ["Ready to post", "待过账"],
  unposted: ["Unposted", "未过账"],
  posted: ["Posted", "已过账"],
  reversed: ["Reversed", "已冲销"],
  matched: ["Matched", "已匹配"],
  mismatch: ["Mismatch", "不一致"],
  unavailable: ["Unavailable", "不可用"],
  active: ["Active", "有效"],
  // Return and posting types
  customer_return: ["Customer return", "客户退货"],
  supplier_return: ["Supplier return", "供应商退货"],
  customer_return_receipt: ["Customer return receipt", "客户退货收货"],
  supplier_return_dispatch: ["Supplier return dispatch", "供应商退货出库"],
  quarantine_release: ["Quarantine release", "隔离库存释放"],
  // Disposition routes
  receive_to_quarantine: ["Receive to quarantine", "收货至隔离库存"],
  return_from_available: ["Return from available stock", "从可用库存退回"],
  return_from_quarantine: ["Return from quarantine", "从隔离库存退回"],
  release_quarantine_to_available: ["Release to available stock", "释放至可用库存"],
  // Balance types
  available: ["Available", "可用"],
  quarantine: ["Quarantine", "隔离"],
  // Movement types missing from the shared movement labels
  quarantine_release_reversal_available_out: ["Release reversal out of available", "隔离释放冲销出可用"],
  quarantine_release_reversal_in: ["Release reversal into quarantine", "隔离释放冲销入隔离"],
  // Audit actions
  return_request_created: ["Return request created", "退货申请已创建"],
  return_request_revised: ["Return request revised", "退货申请已修改"],
  return_request_submitted: ["Return request submitted", "退货申请已提交"],
  return_request_cancelled: ["Return request cancelled", "退货申请已取消"],
  return_request_rejected: ["Return request rejected", "退货申请已拒绝"],
  return_request_authorized: ["Return request authorized", "退货申请已授权"],
  return_authorization_cancelled: ["Return authorization cancelled", "退货授权已取消"],
  return_authorization_expired: ["Return authorization expired", "退货授权已过期"],
  customer_return_receipt_draft_created: ["Customer return receipt drafted", "客户退货收货草稿已创建"],
  customer_return_receipt_draft_revised: ["Customer return receipt revised", "客户退货收货草稿已修改"],
  customer_return_receipt_readied: ["Customer return receipt ready to post", "客户退货收货已就绪"],
  customer_return_receipt_cancelled: ["Customer return receipt cancelled", "客户退货收货已取消"],
  customer_return_received_to_quarantine: ["Customer return received to quarantine", "客户退货已收货至隔离库存"],
  customer_return_receipt_reversed: ["Customer return receipt reversed", "客户退货收货已冲销"],
  quarantine_release_draft_created: ["Quarantine release drafted", "隔离库存释放草稿已创建"],
  quarantine_release_draft_revised: ["Quarantine release revised", "隔离库存释放草稿已修改"],
  quarantine_release_readied: ["Quarantine release ready to post", "隔离库存释放已就绪"],
  quarantine_release_cancelled: ["Quarantine release cancelled", "隔离库存释放已取消"],
  quarantine_released_to_available: ["Quarantine released to available stock", "隔离库存已释放至可用库存"],
  quarantine_release_reversed: ["Quarantine release reversed", "隔离库存释放已冲销"],
  supplier_return_posting_draft_created: ["Supplier return drafted", "供应商退货执行草稿已创建"],
  supplier_return_posting_draft_revised: ["Supplier return revised", "供应商退货执行草稿已修改"],
  supplier_return_posting_readied: ["Supplier return ready to post", "供应商退货执行已就绪"],
  supplier_return_posting_cancelled: ["Supplier return cancelled", "供应商退货执行已取消"],
  supplier_return_posted: ["Supplier return posted", "供应商退货已过账"],
  supplier_return_reversed: ["Supplier return reversed", "供应商退货已冲销"],
};

// Reconciliation check rules. Fixed names are matched exactly; the patterned
// rules carry a movement or balance type in the middle ({type}).
export const returnsRuleLabels: Record<string, [string, string]> = {
  request_workflow_status: ["Request status", "申请状态"],
  authorization_workflow_status: ["Authorization status", "授权状态"],
  authorization_consumed_within_authorized: ["Posted within the authorized quantity", "执行未超出授权数量"],
  authorization_current_posting_line_included: ["Posting line counted in the authorization", "本执行行已计入授权"],
  request_authorization_posting_lineage: ["Request, authorization and posting are linked", "申请、授权与执行相互关联"],
  "movement_{type}_count": ["One movement recorded: {type}", "库存流水条数：{type}"],
  "movement_{type}_identity": ["Movement matches the line: {type}", "库存流水与行一致：{type}"],
  "movement_{type}_quantity_direction": ["Movement quantity and direction: {type}", "库存流水数量与方向：{type}"],
  "balance_{type}": ["Balance change: {type}", "余额变动：{type}"],
  // Passes when an unreversed posting has no compensating movement, or a
  // reversed posting has exactly one.
  "reversal_{id}": ["Reversal matches posting status", "冲销补偿与状态一致"],
};

// Fixed words the server puts in a check's calculated / recorded values.
// Other values are identifiers or numbers and are shown as sent.
export const returnsCheckValueLabels: Record<string, [string, string]> = {
  "no compensation": ["no compensation", "无补偿"],
  "one exact compensation": ["one exact compensation", "一条完全对应的补偿"],
  none: ["none", "无"],
  missing: ["missing", "缺失"],
};

// Server field names that "<field> is required." errors name and that a
// user fills in. Identifier fields fall back to the generic label.
export const returnsFieldLabels: Record<string, [string, string]> = {
  reason: ["reason", "原因"],
  authorizationNumber: ["authorization number", "授权单号"],
  postingNumber: ["posting number", "执行单号"],
};

// Codes the server sends for more than one cause. In English the server's
// own message names the cause, so it is shown instead of the label.
export const returnsServerWordedCodes = [
  "RETURN_QUANTITY_INVALID",
  "RETURN_REVERSAL_NOT_SAFE",
  "RETURN_AUTHORIZATION_ALREADY_ACTIVE",
];

// Error and blocking codes that the returns API and previews show to users.
export const returnsErrorLabels: Record<string, [string, string]> = {
  // Access and request handling
  AUTHENTICATION_REQUIRED: ["Sign in to continue.", "请先登录。"],
  PERMISSION_DENIED: ["Your role does not allow this action.", "当前角色无权执行此操作。"],
  WAREHOUSE_SCOPE_DENIED: ["This warehouse is outside your access.", "该仓库不在您的访问范围内。"],
  PARTIAL_WAREHOUSE_SCOPE: ["Some warehouses are outside your access, so not every line is shown.", "部分仓库不在您的访问范围内，未显示全部行。"],
  METHOD_NOT_ALLOWED: ["This action is not supported here.", "此处不支持该操作。"],
  IDEMPOTENCY_KEY_REQUIRED: ["The request is missing its command key. Reload the page and try again.", "请求缺少命令标识，请刷新页面后重试。"],
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: ["This command was already sent with different values. Reload the page and try again.", "该命令已用不同内容提交过，请刷新页面后重试。"],
  COMMAND_EXECUTION_IN_PROGRESS: ["This action is already in progress. Wait a moment, then refresh.", "该操作正在执行中，请稍后刷新。"],
  // Role and sign-in checks (authorization service, workspace identity)
  AUTHORIZATION_PERMISSION_DENIED: ["Your role does not allow this action.", "当前角色无权执行此操作。"],
  AUTHORIZATION_WAREHOUSE_SCOPE_DENIED: ["This warehouse is outside your access.", "该仓库不在您的访问范围内。"],
  AUTHORIZATION_ROLE_INACTIVE: ["Your role is inactive. Ask an administrator to activate it.", "您的角色已停用，请联系管理员启用。"],
  AUTHORIZATION_CONTEXT_INCOMPLETE: ["Your sign-in is incomplete. Sign in again.", "登录信息不完整，请重新登录。"],
  AUTHORIZATION_TENANT_MISMATCH: ["This record belongs to another workspace.", "该记录属于其他工作区。"],
  AUTHORIZATION_CAPABILITY_DISABLED: ["This feature is not enabled for this workspace.", "此工作区尚未启用该功能。"],
  TENANT_CONTEXT_REQUIRED: ["Your workspace could not be identified. Sign in again.", "无法识别您的工作区，请重新登录。"],
  ACTOR_NOT_PROVISIONED: ["Your account is not set up for this workspace. Ask an administrator.", "您的账户尚未在此工作区开通，请联系管理员。"],
  USER_DISABLED: ["Your account in this workspace is disabled.", "您在此工作区的账户已停用。"],
  SESSION_STALE: ["Your access changed. Sign in again.", "您的权限已变更，请重新登录。"],
  RECEIVING_NOT_FOUND: ["Receiving document not found.", "未找到收货单。"],
  // Capabilities
  RETURN_GOVERNANCE_CAPABILITY_NOT_AVAILABLE: ["Returns are not enabled for this workspace.", "此工作区尚未启用退货。"],
  RETURN_REQUEST_CAPABILITY_NOT_AVAILABLE: ["Return requests are not enabled for this workspace.", "此工作区尚未启用退货申请。"],
  RETURN_AUTHORIZATION_CAPABILITY_NOT_AVAILABLE: ["Return authorizations are not enabled for this workspace.", "此工作区尚未启用退货授权。"],
  RETURN_POSTING_CAPABILITY_NOT_AVAILABLE: ["Return posting is not enabled for this workspace.", "此工作区尚未启用退货执行。"],
  RETURN_GOVERNANCE_FAILED: ["The return action could not be completed.", "退货操作未能完成。"],
  RETURN_COMMAND_INVALID: ["This return action is not recognized.", "无法识别该退货操作。"],
  RETURN_POSTING_COMMAND_INVALID: ["This posting action is not recognized.", "无法识别该执行操作。"],
  // Validation
  RETURN_VALIDATION_FAILED: ["A required field is missing.", "缺少必填项。"],
  RETURN_POSTING_VALIDATION_FAILED: ["A required posting field is missing.", "缺少执行单必填项。"],
  RETURN_VERSION_INVALID: ["The record version is not valid. Refresh and try again.", "记录版本无效，请刷新后重试。"],
  RETURN_POSTING_VERSION_INVALID: ["The posting version is not valid. Refresh and try again.", "执行单版本无效，请刷新后重试。"],
  RETURN_TYPE_INVALID: ["Choose customer return or supplier return.", "请选择客户退货或供应商退货。"],
  RETURN_REASON_REQUIRED: ["Enter a return reason.", "请填写退货原因。"],
  RETURN_LINES_REQUIRED: ["Select at least one line.", "请至少选择一行。"],
  RETURN_QUANTITY_INVALID: ["Enter a positive quantity with at most four decimal places.", "请输入大于零且最多四位小数的数量。"],
  RETURN_REQUEST_NUMBER_REQUIRED: ["Enter a request number.", "请填写申请单号。"],
  RETURN_REQUEST_NUMBER_CONFLICT: ["This request number is already in use.", "该申请单号已被使用。"],
  RETURN_AUTHORIZATION_NUMBER_REQUIRED: ["Enter an authorization number.", "请填写授权单号。"],
  RETURN_AUTHORIZATION_NUMBER_CONFLICT: ["This authorization number is already in use.", "该授权单号已被使用。"],
  RETURN_POSTING_NUMBER_CONFLICT: ["This posting number is already in use.", "该执行单号已被使用。"],
  RETURN_AUTHORIZATION_EXPIRY_INVALID: ["The authorization expiry must be a future date.", "授权到期时间必须晚于当前时间。"],
  // Source documents
  RETURN_SOURCE_REQUIRED: ["Select a source document.", "请选择来源单据。"],
  RETURN_SOURCE_TYPE_INVALID: ["This source document type does not fit the return type.", "该来源单据类型与退货类型不符。"],
  RETURN_SOURCE_LINE_REQUIRED: ["Every return line needs a source line.", "每个退货行都必须对应来源行。"],
  RETURN_SOURCE_LINE_DUPLICATE: ["A source line can be returned only once per request.", "同一来源行在一张申请中只能出现一次。"],
  RETURN_SOURCE_LINE_NOT_FOUND: ["A return line does not match a posted shipment or receipt line.", "退货行未对应已过账的发货或收货行。"],
  RETURN_SOURCE_DOCUMENT_MIXED: ["A request can only use lines from one source document.", "一张申请只能使用同一来源单据的行。"],
  RETURN_SOURCE_QUANTITY_UNAVAILABLE: ["A source line has no posted quantity left to return.", "来源行没有可退回的已过账数量。"],
  RETURN_QUANTITY_EXCEEDS_SOURCE: ["The requested quantity is more than the source line has left.", "申请数量超过来源行剩余数量。"],
  CUSTOMER_RETURN_SOURCE_INVALID: ["A shipment line is not a posted customer return source.", "发货行不是已过账的客户退货来源。"],
  CUSTOMER_RETURN_CONTEXT_MISMATCH: ["The shipment lines do not belong to the selected document.", "发货行不属于所选单据。"],
  SUPPLIER_RETURN_SOURCE_INVALID: ["A receiving line is not a posted supplier return source.", "收货行不是已过账的供应商退货来源。"],
  SUPPLIER_RETURN_CONTEXT_MISMATCH: ["The receiving lines do not belong to the selected document.", "收货行不属于所选单据。"],
  // Request lifecycle
  RETURN_REQUEST_NOT_FOUND: ["Return request not found.", "未找到退货申请。"],
  RETURN_REQUEST_VERSION_CONFLICT: ["The return request changed. Refresh and try again.", "退货申请已变更，请刷新后重试。"],
  RETURN_REQUEST_FROZEN: ["Only a draft request can be changed.", "只有草稿申请可以修改。"],
  RETURN_REQUEST_NOT_DRAFT: ["Only a draft request can be submitted.", "只有草稿申请可以提交。"],
  RETURN_REQUEST_NOT_SUBMITTED: ["The request is not waiting for authorization.", "该申请不处于待授权状态。"],
  RETURN_REQUEST_CANNOT_CANCEL: ["Only a draft or unapproved submitted request can be cancelled.", "只有草稿或未批准的已提交申请可以取消。"],
  RETURN_GOVERNANCE_CONCURRENT_CONFLICT: ["Someone else changed this return. Refresh and try again.", "该退货已被他人修改，请刷新后重试。"],
  // Authorization lifecycle
  RETURN_AUTHORIZATION_NOT_FOUND: ["Return authorization not found.", "未找到退货授权。"],
  RETURN_AUTHORIZATION_VERSION_CONFLICT: ["The return authorization changed. Refresh and try again.", "退货授权已变更，请刷新后重试。"],
  RETURN_AUTHORIZATION_ALREADY_ACTIVE: ["This request has an active authorization, so it cannot be authorized again or cancelled.", "该申请已有有效授权，不能再次授权或取消。"],
  RETURN_AUTHORIZATION_LINES_REQUIRED: ["Authorize at least one line.", "请至少授权一行。"],
  RETURN_AUTHORIZATION_LINE_DUPLICATE: ["A request line can be authorized only once.", "同一申请行只能授权一次。"],
  RETURN_AUTHORIZATION_LINE_INVALID: ["Every authorized line must belong to this request.", "授权行必须属于本申请。"],
  RETURN_AUTHORIZATION_LINE_NOT_FOUND: ["A line does not belong to this authorization.", "某行不属于本授权。"],
  RETURN_AUTHORIZATION_EXCEEDS_REQUEST: ["The authorized quantity is more than the requested quantity.", "授权数量超过申请数量。"],
  RETURN_AUTHORIZATION_QUANTITY_EXCEEDED: ["The quantity is more than the authorization has left.", "数量超过授权剩余数量。"],
  RETURN_AUTHORIZATION_INVALID_STATE: ["Only an approved or partially executed authorization can be used.", "只有已批准或部分执行的授权可以使用。"],
  RETURN_AUTHORIZATION_EXPIRED: ["The return authorization has expired.", "退货授权已过期。"],
  RETURN_AUTHORIZATION_NOT_EXPIRED: ["The authorization has not reached its expiry date.", "授权尚未到期。"],
  RETURN_AUTHORIZATION_CANNOT_CLOSE: ["Only an unused active authorization can be closed.", "只有未执行的有效授权可以关闭。"],
  RETURN_DISPOSITION_NOT_ALLOWED: ["This disposition route is not allowed for this return at this stage.", "该处置路径不适用于当前退货类型或阶段。"],
  RETURN_DISPOSITION_ROUTE_NOT_EXECUTABLE: ["This disposition route cannot be executed here.", "该处置路径无法在此执行。"],
  RETURN_RELEASE_EXCEEDS_RECEIVED_QUARANTINE: ["The release quantity is more than the received quantity still in quarantine.", "释放数量超过已收货且仍在隔离中的数量。"],
  // Postings
  RETURN_POSTING_NOT_FOUND: ["Return posting not found.", "未找到退货执行单。"],
  RETURN_POSTING_VERSION_CONFLICT: ["The return posting changed. Refresh and try again.", "退货执行单已变更，请刷新后重试。"],
  RETURN_POSTING_INVALID_STATE: ["The posting is not in a state that allows this action.", "执行单当前状态不允许此操作。"],
  RETURN_POSTING_TYPE_MISMATCH: ["This posting does not match the authorization type.", "执行单与授权类型不符。"],
  RETURN_POSTING_LINES_REQUIRED: ["Add at least one posting line.", "请至少填写一行执行明细。"],
  RETURN_POSTING_QUANTITY_INVALID: ["Enter a positive quantity with at most four decimal places.", "请输入大于零且最多四位小数的数量。"],
  RETURN_POSTING_DUPLICATE_AUTHORIZATION_LINE: ["An authorization line can appear only once in a posting.", "同一授权行在执行单中只能出现一次。"],
  RETURN_POSTING_MULTIPLE_WAREHOUSES_NOT_ALLOWED: ["A posting must use a single warehouse.", "一张执行单只能使用一个仓库。"],
  RETURN_POSTING_BALANCE_SELECTION_INVALID: ["Select the required balances for this posting.", "请为此执行单选择所需的余额。"],
  RETURN_POSTING_BALANCE_NOT_FOUND: ["The selected balance was not found.", "未找到所选余额。"],
  RETURN_POSTING_DESTINATION_BALANCE_NOT_FOUND: ["The selected destination balance was not found.", "未找到所选目标余额。"],
  RETURN_POSTING_BALANCE_IDENTITY_MISMATCH: ["The selected balance does not match the authorized line.", "所选余额与授权行不符。"],
  RETURN_POSTING_DESTINATION_IDENTITY_MISMATCH: ["The destination balance does not match the authorized line.", "目标余额与授权行不符。"],
  RETURN_POSTING_LOCATION_POLICY_MISMATCH: ["A release must go to an available balance in the same warehouse and location.", "释放必须进入同一仓库和库位的可用余额。"],
  RETURN_POSTING_LINE_IDENTITY_MISMATCH: ["The posting lines no longer match the authorization and balances.", "执行行与授权及余额已不一致。"],
  RETURN_POSTING_WAREHOUSE_IDENTITY_MISMATCH: ["The posting warehouse no longer matches its lines.", "执行单仓库与其明细行已不一致。"],
  RETURN_POSTING_CONCURRENT_CONFLICT: ["Inventory changed while this was being posted. Refresh and try again.", "过账期间库存已变化，请刷新后重试。"],
  RETURN_AVAILABLE_INVENTORY_INSUFFICIENT: ["There is not enough available stock for this return.", "可用库存不足，无法退货。"],
  RETURN_QUARANTINE_INVENTORY_INSUFFICIENT: ["There is not enough quarantined stock for this action.", "隔离库存不足。"],
  RETURN_INVENTORY_BALANCE_INTEGRITY_FAILED: ["The available balance is inconsistent. Contact an administrator.", "可用库存余额不一致，请联系管理员。"],
  QUARANTINE_LINEAGE_INTEGRITY_FAILED: ["The quarantine balance does not reconcile with its receipts. Contact an administrator.", "隔离库存余额与收货记录无法核对，请联系管理员。"],
  RETURN_REVERSAL_NOT_SAFE: ["This posting cannot be reversed safely. It may not be posted, may already be reversed, or its stock has changed since.", "无法安全冲销此执行单：执行单可能未过账、已被冲销，或其库存已发生变化。"],
};

// Smart links on the return posting workbench, keyed by link id.
export const returnsLinkLabels: Record<string, [string, string]> = {
  "return-request": ["Return request", "退货申请"],
  "return-authorization": ["Return authorization", "退货授权"],
  "inventory-movements": ["Inventory movements", "库存流水"],
  "quarantine-inventory": ["Quarantined inventory", "隔离库存"],
};

// Sales return statuses are stored as Chinese values (they also appear in the
// status= URL parameter); only their display text is translated.
export const salesReturnStatusLabels: Record<string, [string, string]> = {
  "全部": ["All statuses", "全部"],
  "草稿": ["Draft", "草稿"],
  "待审核": ["Awaiting review", "待审核"],
  "待收货": ["Awaiting receipt", "待收货"],
  "处理中": ["In progress", "处理中"],
  "已完成": ["Completed", "已完成"],
  "已驳回": ["Rejected", "已驳回"],
};

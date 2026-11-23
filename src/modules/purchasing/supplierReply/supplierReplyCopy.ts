// The supplier reply card's words, English first with the Chinese beside it
// (AGENTS.md). Placeholders in braces are filled with values as recorded:
// dates in the workspace's regional format, numbers, SKUs and names.

export const SUPPLIER_REPLY_COPY = {
  // Where a reply is pasted.
  openFromToday: ["Got a reply? Paste it here", "收到回复了？粘贴到这里"],
  openFromOrder: ["Record supplier reply", "记录供应商回复"],
  pasteAnother: ["Paste a newer reply", "粘贴更新的回复"],
  sectionTitle: ["Supplier replies", "供应商回复"],
  sectionNote: ["Paste the supplier's answer: FlowChain reads the new delivery dates for you to check and record. Nothing is sent to the supplier.", "粘贴供应商的回复：FlowChain 会读出新的交期，由你核对后记录。不会向供应商发送任何内容。"],
  pasteLabel: ["Supplier's reply", "供应商回复"],
  pastePlaceholder: ["Paste the email text. Earlier messages quoted below it are set aside and not read.", "粘贴邮件正文。下方引用的往来邮件会被放在一边，不会被读取。"],
  receivedOn: ["Reply received on", "回复收到日期"],
  characters: ["{n} of {limit} characters", "{n} / {limit} 字符"],
  tooLong: ["The reply is longer than {limit} characters. Paste the part with the dates.", "回复超过 {limit} 字符，请只粘贴含交期的部分。"],
  read: ["Read reply", "读取回复"],
  reading: ["Reading the reply…", "正在读取回复…"],
  cancel: ["Cancel", "取消"],
  loadFailed: ["Supplier replies could not be loaded.", "供应商回复加载失败。"],
  pasteFailed: ["The reply could not be saved", "回复保存失败"],
  earlier: ["Earlier replies ({n})", "之前的回复（{n}）"],
  none: ["No supplier replies recorded on this order yet.", "该订单尚未记录供应商回复。"],

  // The card's head.
  title: ["Supplier reply", "供应商回复"],
  received: ["received {date}", "{date} 收到"],
  pasted: ["Pasted", "粘贴"],
  emailed: ["By email", "邮件"],
  from: ["from {sender}", "发件人 {sender}"],
  senderNotOnRecord: ["The sender is not this supplier's email on record, so this reply is not offered for recording. If it is genuine, paste it on the order.", "发件人不是该供应商记录中的邮箱，因此这封回复不能在这里记录。如确认来自供应商，请把它粘贴到订单上。"],

  // The proposal (#363 §4.6).
  line: ["Line", "订单行"],
  now: ["Now", "当前交期"],
  proposed: ["Proposed", "建议交期"],
  left: ["{qty} left", "剩余 {qty}"],
  noDate: ["No date", "无交期"],
  daysLate: ["{n} days late", "已逾期 {n} 天"],
  dayLate: ["1 day late", "已逾期 1 天"],
  readAs: ["\"{phrase}\" read as {date}, from the reply date {from}", "“{phrase}”按回复日期 {from} 推算为 {date}"],
  readInferred: ["Read as {date} — the reply gave no exact delivery day", "按 {date} 读取——回信没有给出确切交货日"],
  split: ["Split delivery: {parts}. The line is recorded at the last date.", "分批交货：{parts}。该行按最后一批的日期记录。"],
  part: ["{qty} on {date}", "{date} {qty}"],
  partNoQty: ["part on {date}", "{date} 一批"],
  confirms: ["Confirms the current date", "确认当前交期"],
  notUsed: ["Not used from the reply:", "以下内容未采用："],
  alsoMentioned: ["Also mentioned, not recorded here:", "回复还提到以下内容，此处不记录："],
  openOrder: ["Open {po}", "打开 {po}"],
  instructionsIgnored: ["This reply contains text addressed to the system. It was not followed.", "这封回复包含针对系统的指令文字，系统没有执行。"],
  reasonGiven: ["Reason given: ", "供应商说明的原因："],
  reasonNote: ["The reason recorded with each date is the supplier's sentence.", "每个交期记录的原因为供应商原话。"],
  // The stock line (#363 §4.6): what the new dates do to stock before they come.
  stockLabel: ["Stock:", "库存："],
  stock_short: ["{sku} is out of stock from {from}, before this delivery on {date}.", "{sku} 自 {from} 起缺货，早于本次交货日 {date}。"],
  stock_below_reorder_point: ["{sku} is below its reorder point from {from}, before this delivery on {date}.", "{sku} 自 {from} 起低于再订货点，早于本次交货日 {date}。"],
  stock_below_then_short: ["{sku} is below its reorder point from {from} and out of stock from {out}, before this delivery on {date}.", "{sku} 自 {from} 起低于再订货点，自 {out} 起缺货，早于本次交货日 {date}。"],
  stockBeyondYear: ["The new date is more than a year away; the projection covers the year ahead.", "新交期在一年以后，推算只覆盖未来一年。"],
  stockMore: ["{n} more items are affected.", "另有 {n} 个物料受影响。"],
  stockMoreOne: ["1 more item is affected.", "另有 1 个物料受影响。"],
  stockBasis_open_sales_orders: ["Projected from the stock available today, the open purchase order lines on their dates and the open sales orders on the days promised to customers. The whole line counts on its new date.", "按今天的可用库存、未结采购订单行的交期和未结销售订单承诺给客户的日期推算。整行按新交期计入。"],
  stockBasis_recorded_rate: ["Projected from the stock available today, the open purchase order lines on their dates and the average shipped per day over the last 90 days. The whole line counts on its new date.", "按今天的可用库存、未结采购订单行的交期和近 90 天的日均发货量推算。整行按新交期计入。"],
  stockBasis_none: ["Projected from the stock available today and the open purchase order lines on their dates: there is no dated sales order demand and no shipping rate on record. The whole line counts on its new date.", "按今天的可用库存和未结采购订单行的交期推算：没有带日期的销售订单需求，也没有发货速度记录。整行按新交期计入。"],

  // Needs you, nothing to record, outages (#363 §4.5, §4.9).
  needsYou: ["Needs you: the reply mentions a date FlowChain could not confirm. Check the marked sentence and enter the dates.", "需要你确认：回复中的日期无法自动确认。请查看标记的句子并填写交期。"],
  nothing: ["Nothing to record: the reply gives no new date. It is kept on the order.", "无需记录：回复中没有新的交期，已保存在订单上。"],
  outage_ai_off: ["AI is off for this workspace, so the reply was not read. It is kept on the order; enter the dates yourself.", "本工作区未开启 AI，回复未被读取。回复已保存在订单上，请自行填写交期。"],
  outage_no_provider: ["No AI model is set up, so the reply was not read. It is kept on the order; enter the dates yourself.", "尚未配置 AI 模型，回复未被读取。回复已保存在订单上，请自行填写交期。"],
  outage_over_cap: ["This month's AI budget is used up, so the reply was not read. It is kept on the order; enter the dates yourself.", "本月 AI 额度已用完，回复未被读取。回复已保存在订单上，请自行填写交期。"],
  outage_failed: ["The reply could not be read just now. It is kept on the order; enter the dates yourself.", "暂时无法读取回复。回复已保存在订单上，请自行填写交期。"],
  outage_invalid: ["The reading could not be used. The reply is kept on the order; enter the dates yourself.", "读取结果无法使用。回复已保存在订单上，请自行填写交期。"],
  reply: ["Reply", "回复内容"],
  showReply: ["Show the reply", "查看回复"],
  hideReply: ["Hide the reply", "收起回复"],
  quotedHidden: ["Quoted earlier messages and signature hidden", "已隐藏引用的往来邮件和签名"],
  showQuoted: ["Show", "显示"],
  hideQuoted: ["Hide", "隐藏"],
  quotedNote: ["Shown for reference only; FlowChain did not read it.", "仅供参考，FlowChain 未读取这部分内容。"],
  promisedDate: ["New promised date", "新的承诺交期"],
  useReading: ["Use {date}", "按 {date}"],
  ambiguous: ["Day and month could be read either way:", "日和月的顺序无法确定："],
  severalDates: ["The sentence names two dates. Which is the new one?", "这句话提到两个日期，哪个是新的交期？"],
  vagueChoices: ["No exact day was given. It could mean:", "回复没有给出确切日期，可能指："],
  weekdayChoices: ["\"next\" with a weekday can mean this week or next:", "“next + 星期几” 可能指本周或下周："],
  noOrderPartChoice: ["This text may not be about this order. If it is, the day is:", "这段文字可能不是关于本订单的。如果是，交期为："],
  vagueSaid: ["The supplier said: \"{quote}\"", "供应商说：“{quote}”"],

  // Why a line is not proposed (SUPPLIER_REPLY_LINE_ISSUES).
  issue_quote_not_found: ["the sentence was not found in the reply", "回复中找不到该句"],
  issue_date_mismatch: ["the date does not match its sentence", "日期与原句不符"],
  issue_ambiguous_numeric: ["day and month could be either way", "日和月的顺序无法确定"],
  issue_vague: ["no exact day given", "没有给出具体日期"],
  issue_relative_unreadable: ["the date could not be worked out", "无法推算日期"],
  issue_before_reply: ["the date is before the reply date", "日期早于回复日期"],
  issue_too_far: ["the date is more than a year after the reply", "日期晚于回复日期一年以上"],
  issue_unknown_line: ["not a line of this order", "不是本订单的行"],
  issue_ambiguous_weekday: ["\"next\" with a weekday can mean this week or next: pick the day", "英文 “next + 星期几” 可能指本周或下周：请选择日期"],
  issue_line_mismatch: ["the reply names another line's item code or name here", "回复此处写的是另一行的物料编码或名称"],
  issue_other_order_text: ["this text is about another order in the same email: nothing is recorded from it here", "这段文字说的是同一封邮件里的另一张订单：这里不记录"],
  issue_no_order_part: ["the email names several orders and this text is not about this order alone: check which order it is for", "邮件提到了几张订单，这段文字不只关于本订单：请确认它属于哪张订单"],
  issue_several_orders: ["this email is about several orders, so no date is filled in: check the line against the whole email and enter the date yourself", "这封邮件涉及几张订单，系统不自动填日期：请对照整封邮件确认这一行，自己填写日期"],
  issue_correction_across_orders: ["the supplier corrects in this email which order some lines are for: check each line against the whole email", "供应商在这封邮件里更正了某些行属于哪张订单：请对照整封邮件逐行确认"],
  issue_not_open: ["nothing left to receive on this line", "该行已无待收数量"],
  issue_unchanged: ["same as the current date", "与当前交期相同"],
  issue_split_incomplete: ["the parts do not cover what is still open", "分批数量未覆盖剩余待收数量"],
  issue_several_dates: ["the sentence names more than one date", "该句提到不止一个日期"],
  issue_refused: ["the reply refuses this date and names no other", "回复拒绝了该日期，且未给出新日期"],
  issue_addressed_to_system: ["the sentence is text addressed to the system, not followed", "该句是针对系统的指令文字，未执行"],
  unnamedLine: ["A line", "某一行"],
  supplierCode: ["supplier code {code}", "供应商编码 {code}"],

  // What the reply mentions that this card does not record (§4.7).
  flag_quantity_change: ["Quantity change", "数量变更"],
  flag_price_change: ["Price change", "价格变更"],
  flag_cancellation: ["Cancellation", "取消"],
  flag_substitution: ["Substitution", "替代品"],
  flag_other_order: ["Another order", "其他订单"],

  // An email that names several orders: this card shows only its own lines
  // and fills in no dates (the final gate).
  emailOrders: ["This email names {n} orders. FlowChain reads up to {limit} of them, each on its own order with one reading. This card shows only {number}'s lines and fills in no dates.", "这封邮件提到了 {n} 张订单。FlowChain 最多读取其中 {limit} 张，每张在各自订单上读取一次。本卡片只显示 {number} 的行，不自动填日期。"],
  emailOrder_read: ["{number}: read on its own order", "{number}：已在该订单上读取"],
  emailOrder_open_card_kept: ["{number}: already has an open card, kept; not read there", "{number}：已有待处理的卡片，保留原卡片，未在该订单上读取"],
  emailOrder_closed: ["{number}: closed, not read", "{number}：已关闭，未读取"],
  emailOrder_other_supplier: ["{number}: another supplier's order, not read", "{number}：其他供应商的订单，未读取"],
  emailOrder_unknown: ["{number}: no such order, not read", "{number}：找不到该订单，未读取"],
  emailOrder_over_limit: ["{number}: more than {limit} orders in one email, not read", "{number}：一封邮件超过 {limit} 张订单，未读取"],

  // Buttons.
  record: ["Record new dates", "记录新交期"],
  recordThese: ["Record these dates", "记录这些交期"],
  edit: ["Edit", "修改"],
  notNow: ["Not now", "暂不处理"],
  dontRecord: ["Don't record", "不记录"],
  save: ["Save", "保存"],
  dismissReason: ["Why not record it?", "不记录的原因"],
  dismiss_wrong_reading: ["Wrong reading", "读取有误"],
  dismiss_supplier_will_confirm: ["Supplier will confirm later", "供应商稍后确认"],
  dismiss_other: ["Other", "其他"],
  notePlaceholder: ["Note, required for Other (up to 200 characters)", "备注，选择“其他”时必填（最多 200 字）"],
  enterADate: ["Enter at least one date that differs from the current one.", "请至少填写一个与当前不同的交期。"],
  openQuestions: ["These lines need you before the dates are recorded:", "以下订单行需要你确认后才能记录交期："],
  leaveUnchanged: ["Leave this line unchanged", "此行保持不变"],
  resolveFirst: ["Give each line that needs you a date, or leave it unchanged.", "请为需要确认的每一行填写交期，或选择保持不变。"],
  movedLine: ["Moved to {now} since the reply was read (was {was}). Check before recording.", "读取回复后已改为 {now}（原为 {was}），记录前请核对。"],
  viewOnly: ["Only people who may change this order can record its dates.", "只有可以修改该订单的人才能记录交期。"],
  inactive: ["Kept on the order. Another open reply on this order is the one to record or dismiss.", "已保存在订单上。该订单另有一条待处理的回复，请在那条回复上记录或不记录。"],

  // After a decision.
  recorded: ["Recorded on {date}.", "已于 {date} 记录。"],
  recordedEdited: ["Recorded on {date}. Dates entered or changed by hand: {n}.", "已于 {date} 记录，其中手动填写或修改 {n} 行。"],
  notRecorded: ["Not recorded on {date}: {reason}.", "{date} 选择不记录：{reason}。"],
  superseded: ["A later reply replaced this one.", "已被之后的回复取代。"],
  setAside: ["Set aside until {date}.", "暂不处理，至 {date}。"],
  recordedToast: ["New promised dates recorded on {po}", "已在 {po} 上记录新的承诺交期"],
  dismissedToast: ["The reply is kept on {po}; no date was recorded", "回复已保存在 {po} 上，未记录交期"],
  notNowToast: ["Set aside; the reply stays on {po}", "已暂不处理，回复保留在 {po} 上"],
  stale: ["This order changed since the card was shown, so nothing was recorded. The card has been refreshed; check it and try again.", "该订单在卡片显示后已被更改，本次未记录。卡片已刷新，请核对后重试。"],
  closed: ["This reply was already handled, or a later reply replaced it. The card has been refreshed.", "该回复已被处理，或已被之后的回复取代。卡片已刷新。"],
  moved: ["A line's date changed since the reply was read, so nothing was recorded. Check the marked lines and record again.", "读取回复后有订单行的交期已被更改，本次未记录。请核对标记的行后重新记录。"],
  failed: ["The change could not be saved", "保存失败"],
  retry: ["Try again in a moment.", "请稍后重试。"],
} as const satisfies Record<string, readonly [string, string]>;

export type SupplierReplyCopyKey = keyof typeof SUPPLIER_REPLY_COPY;

export function supplierReplyText(language: string, key: SupplierReplyCopyKey, values: Record<string, string | number> = {}) {
  const [english, chinese] = SUPPLIER_REPLY_COPY[key];
  return Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), language === "en-US" ? english : chinese);
}

// The routes' refusals the card words itself (SUPPLIER_REPLY_ERROR_CODES); a
// stale card and a reply no longer open have their own sentences above, and
// the rest fall back to the purchasing words (procurementErrors.ts).
export const SUPPLIER_REPLY_ERROR_TEXT: Record<string, readonly [string, string]> = {
  SUPPLIER_REPLY_ORDER_NOT_OPEN: ["Replies are recorded on an issued or partly received order only.", "只能在已下达或部分收货的订单上记录回复。"],
  SUPPLIER_REPLY_CONFLICT: ["Another reply was pasted on this order at the same moment. Reload and try again.", "另一条回复同时粘贴到了该订单，请刷新后重试。"],
  SUPPLIER_REPLY_EMPTY: ["Nothing is left to read once the quoted earlier messages are set aside. Paste the supplier's own answer.", "去掉引用的往来邮件后没有可读取的内容，请粘贴供应商本人的回复。"],
  SUPPLIER_REPLY_RECEIVED_IN_FUTURE: ["The reply date cannot be after today.", "回复收到日期不能晚于今天。"],
  SUPPLIER_REPLY_RECEIVED_TOO_EARLY: ["The reply date can be at most 60 days ago.", "回复收到日期最早只能是 60 天前。"],
  SUPPLIER_REPLY_NO_DATES: ["There is no date to record. Enter at least one date that differs from the current one.", "没有可记录的交期，请至少填写一个与当前不同的交期。"],
  PROMISED_DATE_UNCHANGED: ["That date is already the line's promised date.", "该日期已是该行的承诺交期。"],
  SUPPLIER_REPLY_NOT_FOUND: ["This reply is no longer on the order. Reload the order.", "该回复已不在订单上，请重新加载订单。"],
  SUPPLIER_REPLY_INVALID: ["Some details are not valid. Check them and try again.", "部分信息无效，请检查后重试。"],
  SUPPLIER_REPLY_INVALID_BODY: ["Some details are not valid. Check them and try again.", "部分信息无效，请检查后重试。"],
};

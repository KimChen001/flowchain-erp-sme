// The supplier reply card's words, English first with the Chinese beside it
// (AGENTS.md). Placeholders in braces are filled with values as recorded:
// dates in the workspace's regional format, numbers, SKUs and names.

export const SUPPLIER_REPLY_COPY = {
  // Where a reply is pasted.
  openFromToday: ["Got a reply? Paste it here", "收到回复了？粘贴到这里"],
  openFromOrder: ["Record supplier reply", "记录供应商回复"],
  sectionTitle: ["Supplier replies", "供应商回复"],
  sectionNote: ["Paste the supplier's answer: FlowChain reads the new delivery dates for you to check and record. Nothing is sent to the supplier.", "粘贴供应商的回复：FlowChain 会读出新的交期，由你核对后记录。不会向供应商发送任何内容。"],
  pasteLabel: ["Supplier's reply", "供应商回复"],
  pastePlaceholder: ["Paste the email text. Earlier messages quoted below it are set aside and not read.", "粘贴邮件正文。下方引用的往来邮件会被放在一边，不会被读取。"],
  receivedOn: ["Reply received on", "回复收到日期"],
  characters: ["{n} of 8,000 characters", "{n} / 8,000 字符"],
  tooLong: ["The reply is longer than 8,000 characters. Paste the part with the dates.", "回复超过 8,000 字符，请只粘贴含交期的部分。"],
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

  // The proposal (#363 §4.6).
  line: ["Line", "订单行"],
  now: ["Now", "当前交期"],
  proposed: ["Proposed", "建议交期"],
  left: ["{qty} left", "剩余 {qty}"],
  noDate: ["No date", "无交期"],
  daysLate: ["{n} days late", "已逾期 {n} 天"],
  dayLate: ["1 day late", "已逾期 1 天"],
  readAs: ["\"{phrase}\" read as {date}, from the reply date {from}", "“{phrase}”按回复日期 {from} 推算为 {date}"],
  split: ["Split delivery: {parts}. The line is recorded at the last date.", "分批交货：{parts}。该行按最后一批的日期记录。"],
  part: ["{qty} on {date}", "{date} {qty}"],
  partNoQty: ["part on {date}", "{date} 一批"],
  confirms: ["Confirms the current date", "确认当前交期"],
  notUsed: ["Not used from the reply:", "以下内容未采用："],
  alsoMentioned: ["Also mentioned, not recorded here:", "回复还提到以下内容，此处不记录："],
  openOrder: ["Open {po}", "打开 {po}"],
  instructionsIgnored: ["This reply contains text addressed to the system. It was not followed.", "这封回复包含针对系统的指令文字，系统没有执行。"],
  supplierSaid: ["The supplier wrote", "供应商原话"],
  reasonNote: ["The reason recorded with each date is the supplier's sentence.", "每个交期记录的原因为供应商原话。"],

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
  issue_not_open: ["nothing left to receive on this line", "该行已无待收数量"],
  issue_unchanged: ["same as the current date", "与当前交期相同"],
  issue_split_incomplete: ["the parts do not cover what is still open", "分批数量未覆盖剩余待收数量"],
  unnamedLine: ["A line", "某一行"],
  supplierCode: ["supplier code {code}", "供应商编码 {code}"],

  // What the reply mentions that this card does not record (§4.7).
  flag_quantity_change: ["Quantity change", "数量变更"],
  flag_price_change: ["Price change", "价格变更"],
  flag_cancellation: ["Cancellation", "取消"],
  flag_substitution: ["Substitution", "替代品"],
  flag_other_order: ["Another order", "其他订单"],

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
  viewOnly: ["Only people who may change this order can record its dates.", "只有可以修改该订单的人才能记录交期。"],

  // After a decision.
  recorded: ["Recorded on {date}.", "已于 {date} 记录。"],
  recordedEdited: ["Recorded on {date}, {n} edited.", "已于 {date} 记录，修改了 {n} 行。"],
  notRecorded: ["Not recorded on {date}: {reason}.", "{date} 选择不记录：{reason}。"],
  superseded: ["A later reply replaced this one.", "已被之后的回复取代。"],
  setAside: ["Set aside until {date}.", "暂不处理，至 {date}。"],
  recordedToast: ["New promised dates recorded on {po}", "已在 {po} 上记录新的承诺交期"],
  dismissedToast: ["The reply is kept on {po}; no date was recorded", "回复已保存在 {po} 上，未记录交期"],
  notNowToast: ["Set aside; the reply stays on {po}", "已暂不处理，回复保留在 {po} 上"],
  stale: ["This order changed since the card was shown, so nothing was recorded. The card has been refreshed; check it and try again.", "该订单在卡片显示后已被更改，本次未记录。卡片已刷新，请核对后重试。"],
  closed: ["This reply was already handled, or a later reply replaced it. The card has been refreshed.", "该回复已被处理，或已被之后的回复取代。卡片已刷新。"],
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
  SUPPLIER_REPLY_NO_DATES: ["There is no date to record. Enter at least one date that differs from the current one.", "没有可记录的交期，请至少填写一个与当前不同的交期。"],
  PROMISED_DATE_UNCHANGED: ["That date is already the line's promised date.", "该日期已是该行的承诺交期。"],
  SUPPLIER_REPLY_NOT_FOUND: ["This reply is no longer on the order. Reload the order.", "该回复已不在订单上，请重新加载订单。"],
  SUPPLIER_REPLY_INVALID: ["Some details are not valid. Check them and try again.", "部分信息无效，请检查后重试。"],
  SUPPLIER_REPLY_INVALID_BODY: ["Some details are not valid. Check them and try again.", "部分信息无效，请检查后重试。"],
};

import { useCallback } from "react";
import { useI18n } from "../../i18n/I18n";

// Copy for the decision cards on Today (docs/drafted-decisions-design.md).
// English is the source; zh-CN is chosen by the interface language. The
// follow-up message has its own templates in both languages, picked on the
// card, since the supplier may read either.
const EN = {
  title: "Waiting for your decision",
  note: "FlowChain prepared the next step for each. Nothing is created or sent until you click.",
  readOnly: "FlowChain prepared the next step for each. Your role can see them but not decide; a buyer or an administrator can.",
  none: "Nothing is waiting for a decision.",
  tile: "Waiting for your decision",
  tileNote: "Prepared next steps to confirm",
  tileWork: "Other work",
  tileWorkNote: "Rows in Today's work below",
  returned: "Back again",
  prepared: "Prepared",
  basis: "Why",
  // Reorder
  reorderDraft: "A purchase request for {qty} from {supplier}",
  reorderDraftNoSupplier: "A purchase request for {qty}; no preferred supplier is recorded",
  reorderDraftNoQuantity: "A purchase request from {supplier}; enter the quantity on the form",
  raisedToMinimum: "Shortfall {shortfall}, raised to the supplier's minimum order of {minimum}.",
  reorderBasis: "Stock position {position} against reorder point {reorderPoint}.",
  reorderReason: "Today: stock position {position} against reorder point {reorderPoint}; order by {date}.",
  reviewRequest: "Review and create the request",
  // Follow-up
  followUpDraft: "A follow-up to {supplier}",
  followUpBasis: "{n} lines still to receive, due {date}.",
  followUpBasisOne: "{sku}: {qty} still to receive, due {date}.",
  followUpTo: "To {who}",
  showMessage: "Show the message",
  hideMessage: "Hide the message",
  followUpNoEmail: "No email is recorded for this supplier.",
  followUpLanguage: "Message language",
  followUpNotSent: "FlowChain does not send it: copy it into your email.",
  followUpSendNote: "Nothing is sent until you confirm the text and then the address.",
  reviewAndSend: "Review and send",
  confirmText: "Is the text right? Edit it above if not.",
  nextRecipient: "Next: check the recipient",
  toLabel: "To",
  replyToYou: "Replies come to your own email.",
  outboxNote: "This workspace has no mail provider, so it is saved to the local outbox and not sent.",
  sendTo: "Send to {to}",
  back: "Back",
  sentEmail: "Sent to {to} and marked chased.",
  sentOutbox: "Saved to the local outbox, not sent, and marked chased.",
  copyAndChased: "Copy and mark chased",
  copied: "Copied. Marked chased; it comes back in 3 workdays if nothing arrives.",
  copyFailed: "Could not copy. Select the text and copy it yourself.",
  recordNewDate: "Record a new promised date",
  // Conversion
  convertDraft: "{n} purchase orders from this request",
  convertDraftOne: "1 purchase order from this request",
  convertOrder: "{supplier}: {n} lines, {currency}",
  convertOrderOne: "{supplier}: 1 line, {currency}",
  convertMissing: "Line {line} ({sku}) has no {fields}. Fill it in on the request first.",
  field_supplierId: "supplier",
  field_currency: "currency",
  field_targetWarehouseId: "delivery warehouse",
  createOrders: "Create the purchase orders",
  creating: "Creating…",
  created: "Created {numbers}.",
  openRequest: "Open the request",
  // Set aside
  notNow: "Not now",
  notNeeded: "Not needed",
  tomorrow: "Tomorrow",
  nextMonday: "Next Monday",
  pickDay: "Or a day",
  save: "Save",
  cancel: "Cancel",
  reason: "Reason",
  reason_seasonal: "Seasonal",
  reason_discontinued: "Discontinued",
  reason_covered_elsewhere: "Covered elsewhere",
  reason_supplier_confirmed: "Supplier confirmed",
  reason_other: "Other",
  notePlaceholder: "A short note (needed for Other)",
  setAsideTitle: "Set aside ({n})",
  setAsideNote: "Each comes back by itself when its condition changes materially.",
  aside_not_now: "Not now, until {date}",
  aside_not_needed: "Not needed: {reason}",
  aside_chased: "Chased on {date}",
  aside_emailed: "Emailed on {date}",
  aside_accepted: "Created {document}",
  aside_covered: "Already requested: {document}",
  by: "{name}, {date}",
  reopen: "Reopen",
  failed: "That did not work: {message}",
  stale: "Someone has already decided on this. Today was reloaded.",
  chatLoading: "Loading the cards from Today…",
  chatUnavailable: "Today's decisions could not be loaded here. Open Today to see them.",
  chatGone: "This is no longer on Today.",
  chatMore: "{n} more waiting on Today",
  welcomeTitle: "Waiting for your decision · {n}",
  // One line per card (owner, 2026-11-13: Today was too full): what it is,
  // the fact that decides it, the main button; the rest under Details.
  details: "Details",
  hideDetails: "Hide details",
  followUpShort: "{n} lines still to receive",
  followUpShortOne: "{sku}: {qty} still to receive",
  reorderShort: "Request {qty}",
  reorderShortNoQuantity: "Request; enter the quantity",
  moreDecisions: "Show {n} more",
  fewerDecisions: "Show fewer",
  // A held supplier invoice (invoice-exception-draft.mjs).
  invoiceShortPrice: "{sku}: invoiced at {invoice}, ordered at {order}{percent}",
  invoiceShortPriceHidden: "{sku}: the unit price differs from the order",
  invoiceShortQuantity: "{sku}: {invoiced} invoiced, {received} received",
  invoiceShortAmount: "{sku}: line amount off by {variance}",
  invoiceShortMore: " and {n} more",
  invoiceForOrder: "Invoice {invoice} for {order}",
  invoiceStep_ask_supplier: "A message asking the supplier for a corrected invoice or a credit note",
  invoiceStep_review_price: "The supplier's price likely changed: check it, then approve the difference on the invoice or ask the supplier",
  invoiceStep_wait_receipt: "The invoice bills goods not yet received: check the receipt, then match again",
  cause_price_changed: "{order} already orders at {price}, so the price likely changed and this order kept the old one",
  cause_invoice_price: "no order has this price, so the invoice is likely priced wrong",
  cause_over_ordered: "more is invoiced than the {ordered} ordered",
  cause_already_invoiced: "{previous} of what was received was invoiced before, so this may bill it again",
  cause_not_yet_received: "{missing} not received yet, or not posted as received",
  cause_line_amount: "the line amount is not the quantity times the order price",
  cause_hidden: "your role cannot see prices",
  showInvoiceMessage: "Show the message to the supplier",
  copyAndContacted: "Copy and mark contacted",
  invoiceCopied: "Copied. Marked contacted; it comes back in 3 workdays if the invoice is still held.",
  openInvoice: "Open the invoice",
  checkReceipt: "Check the receipt",
  aside_contacted: "Supplier contacted on {date}",
} as const;

export type DecisionCopyKey = keyof typeof EN;

const ZH: Record<DecisionCopyKey, string> = {
  title: "等你决定",
  note: "FlowChain 已为每件事准备好下一步。你点之前，不会创建或发送任何东西。",
  readOnly: "FlowChain 已为每件事准备好下一步。你的角色可以查看，但不能做决定；采购员或管理员可以。",
  none: "暂时没有等你决定的事。",
  tile: "等你决定",
  tileNote: "已准备好、待你确认的下一步",
  tileWork: "其他待办",
  tileWorkNote: "下面今日需处理里的事项",
  returned: "再次出现",
  prepared: "已准备",
  basis: "依据",
  reorderDraft: "向 {supplier} 采购 {qty} 的采购申请",
  reorderDraftNoSupplier: "采购 {qty} 的采购申请；未记录首选供应商",
  reorderDraftNoQuantity: "向 {supplier} 采购的申请；请在表单里填写数量",
  raisedToMinimum: "缺口 {shortfall}，已按供应商最小订货量 {minimum} 凑整。",
  reorderBasis: "库存头寸 {position}，再订货点 {reorderPoint}。",
  reorderReason: "今日：库存头寸 {position}，再订货点 {reorderPoint}；最晚下单日 {date}。",
  reviewRequest: "核对并创建申请",
  followUpDraft: "给 {supplier} 的催货信息",
  followUpBasis: "{n} 行尚未到货，交货日期 {date}。",
  followUpBasisOne: "{sku}：{qty} 尚未到货，交货日期 {date}。",
  followUpTo: "收件人 {who}",
  showMessage: "查看邮件内容",
  hideMessage: "收起邮件内容",
  followUpNoEmail: "该供应商没有记录邮箱。",
  followUpLanguage: "邮件语言",
  followUpNotSent: "FlowChain 不会代发：请复制到你的邮箱里发送。",
  followUpSendNote: "先确认内容，再确认收件地址，之后才会发送。",
  reviewAndSend: "核对并发送",
  confirmText: "内容对吗？不对可以在上面直接修改。",
  nextRecipient: "下一步：确认收件人",
  toLabel: "收件人",
  replyToYou: "供应商的回复会直接回到你自己的邮箱。",
  outboxNote: "本工作区没有配置邮件服务，邮件只写入本地发件箱，不会发出。",
  sendTo: "发送给 {to}",
  back: "返回",
  sentEmail: "已发送给 {to}，并记为已催。",
  sentOutbox: "已写入本地发件箱（未发出），并记为已催。",
  copyAndChased: "复制并记为已催",
  copied: "已复制，并记为已催。3 个工作日内仍未到货会再次提醒。",
  copyFailed: "复制失败，请手动选中文字复制。",
  recordNewDate: "记录新的承诺日期",
  convertDraft: "由此申请生成 {n} 张采购订单",
  convertDraftOne: "由此申请生成 1 张采购订单",
  convertOrder: "{supplier}：{n} 行，{currency}",
  convertOrderOne: "{supplier}：1 行，{currency}",
  convertMissing: "第 {line} 行（{sku}）缺少{fields}，请先在申请里补上。",
  field_supplierId: "供应商",
  field_currency: "币种",
  field_targetWarehouseId: "收货仓库",
  createOrders: "生成采购订单",
  creating: "正在生成…",
  created: "已生成 {numbers}。",
  openRequest: "打开申请",
  notNow: "以后再说",
  notNeeded: "不需要",
  tomorrow: "明天",
  nextMonday: "下周一",
  pickDay: "或选日期",
  save: "保存",
  cancel: "取消",
  reason: "原因",
  reason_seasonal: "季节性",
  reason_discontinued: "已停用",
  reason_covered_elsewhere: "已有其他安排",
  reason_supplier_confirmed: "供应商已确认",
  reason_other: "其他",
  notePlaceholder: "简短说明（选“其他”时必填）",
  setAsideTitle: "已放下（{n}）",
  setAsideNote: "情况明显变化时，会自动回到等你决定。",
  aside_not_now: "以后再说，到 {date}",
  aside_not_needed: "不需要：{reason}",
  aside_chased: "{date} 已催货",
  aside_emailed: "{date} 已发邮件催货",
  aside_accepted: "已创建 {document}",
  aside_covered: "已有申请：{document}",
  by: "{name}，{date}",
  reopen: "重新打开",
  failed: "操作没有成功：{message}",
  stale: "已有人对这件事做了决定，今日页已刷新。",
  chatLoading: "正在从今日页加载卡片…",
  chatUnavailable: "这里无法加载今日页的决定事项，请打开今日页查看。",
  chatGone: "这件事已不在今日页上。",
  chatMore: "今日页上还有 {n} 件等你决定",
  welcomeTitle: "等你决定 · {n}",
  details: "详情",
  hideDetails: "收起详情",
  followUpShort: "还有 {n} 行未到货",
  followUpShortOne: "{sku} 还差 {qty}",
  reorderShort: "建议申请 {qty}",
  reorderShortNoQuantity: "建议申请，数量待填",
  moreDecisions: "再显示 {n} 项",
  fewerDecisions: "收起",
  invoiceShortPrice: "{sku} 发票单价 {invoice}，订单单价 {order}{percent}",
  invoiceShortPriceHidden: "{sku} 单价与订单不一致",
  invoiceShortQuantity: "{sku} 开票 {invoiced}，已收货 {received}",
  invoiceShortAmount: "{sku} 行金额差 {variance}",
  invoiceShortMore: " 等 {n} 处",
  invoiceForOrder: "发票 {invoice}，对应 {order}",
  invoiceStep_ask_supplier: "给供应商的信息：请对方开更正发票或红字发票",
  invoiceStep_review_price: "供应商可能已调价：核对后在发票页批准差异，或联系供应商",
  invoiceStep_wait_receipt: "发票开了还没收到的货：先核对收货，收货后重新匹配",
  cause_price_changed: "{order} 已按 {price} 下单，可能已调价，本单仍是旧价",
  cause_invoice_price: "没有订单是这个价，发票可能开错了价",
  cause_over_ordered: "开票合计超过订货数 {ordered}",
  cause_already_invoiced: "已收的货中有 {previous} 此前开过票，可能重复开票",
  cause_not_yet_received: "还有 {missing} 未收货，或未登记收货",
  cause_line_amount: "行金额不等于数量乘订单单价",
  cause_hidden: "你的角色看不到价格",
  showInvoiceMessage: "查看给供应商的信息",
  copyAndContacted: "复制并记为已联系",
  invoiceCopied: "已复制，并记为已联系。3 个工作日后发票仍被挂起会再次提醒。",
  openInvoice: "打开发票",
  checkReceipt: "核对收货",
  aside_contacted: "{date} 已联系供应商",
};

const COPY: Record<"en-US" | "zh-CN", Record<DecisionCopyKey, string>> = { "en-US": EN, "zh-CN": ZH };

export function decisionText(language: string, key: DecisionCopyKey, params: Record<string, string | number> = {}) {
  const table = COPY[language === "zh-CN" ? "zh-CN" : "en-US"];
  return Object.entries(params).reduce((value, [name, replacement]) => value.split(`{${name}}`).join(String(replacement)), table[key]);
}

export function useDecisionCopy() {
  const { language } = useI18n();
  const t = useCallback((key: DecisionCopyKey, params?: Record<string, string | number>) => decisionText(language, key, params), [language]);
  const count = useCallback((key: DecisionCopyKey, n: number, params?: Record<string, string | number>) => {
    const one = `${key}One` as DecisionCopyKey;
    return decisionText(language, n === 1 && one in EN ? one : key, { n, ...params });
  }, [language]);
  return Object.assign(t, { count, language });
}

// The message about a held invoice, in the language picked on the card:
// what differs, then a request for a corrected invoice or a credit note.
// Amounts and quantities arrive formatted.
export type InvoiceCorrectionFacts = {
  invoiceNumber: string;
  orderNumber: string | null;
  contactName: string | null;
  differences: Array<{ kind: "price" | "quantity" | "amount"; sku: string; expected: string; actual: string; received: string; previouslyInvoiced: string | null }>;
  moreDifferences: number;
};

export function invoiceCorrectionMessage(language: "en-US" | "zh-CN", facts: InvoiceCorrectionFacts) {
  if (language === "zh-CN") {
    const lines = facts.differences.map((entry) => entry.kind === "price"
      ? `- ${entry.sku}：发票单价 ${entry.actual}，订单单价 ${entry.expected}`
      : entry.kind === "quantity"
        ? `- ${entry.sku}：发票数量 ${entry.actual}，我方已收货 ${entry.received}${entry.previouslyInvoiced ? `，此前已开票 ${entry.previouslyInvoiced}` : ""}`
        : `- ${entry.sku}：发票行金额 ${entry.actual}，按订单应为 ${entry.expected}`);
    if (facts.moreDifferences > 0) lines.push(`- 另有 ${facts.moreDifferences} 处`);
    return {
      subject: `发票 ${facts.invoiceNumber}${facts.orderNumber ? ` 与采购订单 ${facts.orderNumber}` : ""} 不一致`,
      body: [
        `${facts.contactName ? `${facts.contactName}，` : ""}您好：`,
        "",
        `贵司发票 ${facts.invoiceNumber}${facts.orderNumber ? `（对应我方采购订单 ${facts.orderNumber}）` : ""}在核对时有以下差异：`,
        ...lines,
        "",
        "请核对后开具更正发票或红字发票。如价格已调整，请告知调整依据和生效日期。",
        "",
        "谢谢！",
      ].join("\n"),
    };
  }
  const lines = facts.differences.map((entry) => entry.kind === "price"
    ? `- ${entry.sku}: invoiced at ${entry.actual}, our order price is ${entry.expected}`
    : entry.kind === "quantity"
      ? `- ${entry.sku}: ${entry.actual} invoiced, ${entry.received} received${entry.previouslyInvoiced ? `, ${entry.previouslyInvoiced} invoiced before` : ""}`
      : `- ${entry.sku}: line amount ${entry.actual}, ${entry.expected} by our order`);
  if (facts.moreDifferences > 0) lines.push(`- and ${facts.moreDifferences} more`);
  return {
    subject: `Invoice ${facts.invoiceNumber}${facts.orderNumber ? ` and purchase order ${facts.orderNumber}` : ""}: differences`,
    body: [
      `Dear ${facts.contactName || "Sir or Madam"},`,
      "",
      `Checking your invoice ${facts.invoiceNumber}${facts.orderNumber ? ` against our purchase order ${facts.orderNumber}` : ""}, we found these differences:`,
      ...lines,
      "",
      "Please send a corrected invoice or a credit note. If your price has changed, please tell us why and from when.",
      "",
      "Thank you,",
    ].join("\n"),
  };
}

// The follow-up to a supplier, in the language picked on the card. Dates and
// quantities arrive formatted in the workspace locale.
export type FollowUpFacts = {
  orderNumber: string;
  contactName: string | null;
  due: string | null;
  overdueDays: number;
  lines: Array<{ sku: string; quantity: string; promised: string | null }>;
  moreLines: number;
};

export function followUpMessage(language: "en-US" | "zh-CN", facts: FollowUpFacts) {
  if (language === "zh-CN") {
    const lines = facts.lines.map((line) => `- ${line.sku}：${line.quantity}${line.promised ? `（承诺日期 ${line.promised}）` : ""}`);
    if (facts.moreLines > 0) lines.push(`- 另有 ${facts.moreLines} 行`);
    return {
      subject: `采购订单 ${facts.orderNumber} 交货逾期`,
      body: [
        `${facts.contactName ? `${facts.contactName}，` : ""}您好：`,
        "",
        `我方采购订单 ${facts.orderNumber}${facts.due ? ` 的交货日期为 ${facts.due}，` : "，"}目前已逾期 ${facts.overdueDays} 天。以下行尚未到货：`,
        ...lines,
        "",
        "请确认发货时间，或告知新的交货日期。",
        "",
        "谢谢！",
      ].join("\n"),
    };
  }
  const lines = facts.lines.map((line) => `- ${line.sku}: ${line.quantity}${line.promised ? ` (promised ${line.promised})` : ""}`);
  if (facts.moreLines > 0) lines.push(`- and ${facts.moreLines} more ${facts.moreLines === 1 ? "line" : "lines"}`);
  return {
    subject: `Purchase order ${facts.orderNumber}: delivery overdue`,
    body: [
      `Dear ${facts.contactName || "Sir or Madam"},`,
      "",
      `Our purchase order ${facts.orderNumber}${facts.due ? ` was due on ${facts.due} and` : ""} is now ${facts.overdueDays} ${facts.overdueDays === 1 ? "day" : "days"} overdue. These lines are still to be delivered:`,
      ...lines,
      "",
      "Please confirm when they will ship, or send us a new delivery date.",
      "",
      "Thank you,",
    ].join("\n"),
  };
}

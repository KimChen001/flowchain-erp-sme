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
  followUpTo: "To {who}",
  followUpNoEmail: "No email is recorded for this supplier.",
  followUpLanguage: "Message language",
  followUpNotSent: "FlowChain does not send it: copy it into your email.",
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
  aside_accepted: "Created {document}",
  aside_covered: "Already requested: {document}",
  by: "{name}, {date}",
  reopen: "Reopen",
  failed: "That did not work: {message}",
  stale: "Someone has already decided on this. Today was reloaded.",
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
  followUpTo: "收件人 {who}",
  followUpNoEmail: "该供应商没有记录邮箱。",
  followUpLanguage: "邮件语言",
  followUpNotSent: "FlowChain 不会代发：请复制到你的邮箱里发送。",
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
  aside_accepted: "已创建 {document}",
  aside_covered: "已有申请：{document}",
  by: "{name}，{date}",
  reopen: "重新打开",
  failed: "操作没有成功：{message}",
  stale: "已有人对这件事做了决定，今日页已刷新。",
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

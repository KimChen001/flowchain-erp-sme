// The follow-up to a supplier about an overdue purchase order, in the language
// picked on the decision card (DecisionCards.tsx), since the supplier may read
// either. Dates and quantities arrive formatted in the workspace locale. Each
// line names the SKU, the item and, when the item-supplier link records one,
// the supplier's own part number, so the supplier can tell which item is
// meant (design audit L11-22). Only lines past their promised date are given
// (server/domain/decision-drafts.mjs). No imports, so tests can load it.
export type FollowUpLine = { sku: string; itemName?: string | null; supplierSku?: string | null; quantity: string; promised: string | null };

export type FollowUpFacts = {
  orderNumber: string;
  contactName: string | null;
  due: string | null;
  overdueDays: number;
  lines: FollowUpLine[];
  moreLines: number;
};

// The item name only when it says more than the SKU.
const nameOf = (line: FollowUpLine) => {
  const name = String(line.itemName ?? "").trim();
  return name && name !== line.sku ? name : "";
};

function englishItem(line: FollowUpLine) {
  const name = nameOf(line);
  const part = String(line.supplierSku ?? "").trim();
  return `${line.sku}${name ? ` ${name}` : ""}${part ? ` (your part no. ${part})` : ""}`;
}

function chineseItem(line: FollowUpLine) {
  const name = nameOf(line);
  const part = String(line.supplierSku ?? "").trim();
  return `${line.sku}${name ? ` ${name}` : ""}${part ? `（贵司料号 ${part}）` : ""}`;
}

export function followUpMessage(language: "en-US" | "zh-CN", facts: FollowUpFacts) {
  if (language === "zh-CN") {
    const lines = facts.lines.map((line) => `- ${chineseItem(line)}：${line.quantity}${line.promised ? `（承诺日期 ${line.promised}）` : ""}`);
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
  const lines = facts.lines.map((line) => `- ${englishItem(line)}: ${line.quantity}${line.promised ? ` (promised ${line.promised})` : ""}`);
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

// What the card says when the server refuses to send the follow-up, in the
// interface language (design audit L5-12: the order number stays, the
// figures are the order's, no prices; the server's own message is English
// for developers). detail: the refusal's first detail, which names the figure
// that is not on the order and the order number. null: not one of these.
const SEND_REFUSALS: Record<string, readonly [english: string, chinese: string]> = {
  SUPPLIER_EMAIL_FIGURE_CHANGED: ["{figure} is not on order {order}. The order's figures cannot be changed; edit only the wording.", "{figure} 不是订单 {order} 上的数字。订单的数字不能改，只能改措辞。"],
  SUPPLIER_EMAIL_ORDER_MISSING: ["Keep the order number {order} in the message.", "请在邮件中保留订单号 {order}。"],
  SUPPLIER_EMAIL_PRICE: ["Leave prices and currencies out of a supplier follow-up.", "催货邮件里不要写价格或币种。"],
  SUPPLIER_EMAIL_RECIPIENT_NOT_ON_RECORD: ["This address is not the supplier's email on record. Confirm it to send.", "这个地址不是供应商档案里的邮箱，确认后才能发送。"],
  SUPPLIER_EMAIL_ADDRESS_INVALID: ["Enter one email address.", "请填写一个邮箱地址。"],
  SUPPLIER_EMAIL_NOT_CONFIRMED: ["Confirm the address before sending.", "发送前请先确认邮箱地址。"],
  SUPPLIER_EMAIL_SUBJECT_INVALID: ["Write a subject of one line, up to 200 characters.", "主题只能写一行，最多 200 个字符。"],
  SUPPLIER_EMAIL_BODY_INVALID: ["Write a message of up to 5,000 characters.", "正文最多 5,000 个字符。"],
  SUPPLIER_EMAIL_DRAFT_MISSING: ["This order has no follow-up to send. Reload Today.", "这张订单没有可发送的催货邮件，请刷新今日页面。"],
  SUPPLIER_EMAIL_NOT_OVERDUE: ["Only an overdue purchase order can be followed up by email.", "只有逾期的采购订单才能发催货邮件。"],
  SUPPLIER_EMAIL_ORDER_NOT_SENT: ["This order has not been sent to the supplier yet. Send the order from its page.", "这张订单还没有发给供应商，请先在订单页面发出订单。"],
  SUPPLIER_EMAIL_OFF: ["Supplier email is off in this workspace. An administrator can turn it on in Settings.", "本工作区未开启供应商邮件，管理员可在设置中开启。"],
  SUPPLIER_EMAIL_ORDER_LIMIT: ["This order was already followed up by email today.", "这张订单今天已经发过催货邮件。"],
  SUPPLIER_EMAIL_WORKSPACE_LIMIT: ["This workspace has sent today's 20 supplier emails. Try again tomorrow.", "本工作区今天已发满 20 封供应商邮件，请明天再试。"],
  SUPPLIER_EMAIL_NO_PROVIDER: ["No mail provider is set up for this server.", "这台服务器没有配置发信服务。"],
  SUPPLIER_EMAIL_NOT_ALLOWED: ["Your role cannot email suppliers. Ask an administrator.", "你的角色不能给供应商发邮件，请联系管理员。"],
};

export function followUpSendErrorText(code: string, detail: Record<string, unknown> | null | undefined, language: string): string | null {
  const pair = SEND_REFUSALS[code];
  if (!pair) return null;
  const text = language === "zh-CN" ? pair[1] : pair[0];
  const figure = String(detail?.figure ?? "").trim();
  const order = String(detail?.orderNumber ?? "").trim();
  // Without the figure or the order number the sentence still reads.
  if (code === "SUPPLIER_EMAIL_FIGURE_CHANGED" && !figure) return language === "zh-CN" ? "邮件里有订单上没有的数字。订单的数字不能改，只能改措辞。" : "A figure in the message is not on the order. The order's figures cannot be changed; edit only the wording.";
  return text.replace("{figure}", figure).replace("{order}", order).replace(/ {2,}/g, " ").replace(" .", ".").replace(/\s+。/, "。");
}

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

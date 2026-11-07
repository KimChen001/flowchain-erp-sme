import { statusCodeLabel } from "./statusLabels.ts";

// Audit rows keep the summary the server wrote, in English, with the record
// numbers inside ("Shipment SH-202611-0001 posted."). The audit log shows a
// known summary from its action and those numbers in the interface language;
// one this file does not know keeps its recorded text, with codes read as
// words. Internal ids (assistant skill and plan ids, session and link ids,
// uuids) and entity class names are never shown. The stored row is unchanged.

type Pair = readonly [string, string];
export type AuditSummaryEntry = { action?: string | null; summary?: string | null; entity?: { type?: string | null; id?: string | null } | null };

const pick = (pair: Pair, language: string) => pair[language === "en-US" ? 0 : 1];
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");

// A uuid, a cuid or a long hex id names no record a person knows.
export const isInternalAuditId = (id: string | null | undefined) =>
  !String(id ?? "").trim() || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(String(id)) || /^c[a-z0-9]{20,}$/.test(String(id)) || /^[0-9a-f]{24,}$/i.test(String(id));

const ACRONYMS: Record<string, string> = { ai: "AI", po: "PO", pr: "PR", rfq: "RFQ", grn: "GRN", sku: "SKU", id: "ID" };
// "today_priorities" and "ShipmentDocument" as words: "Today priorities", "Shipment document".
export function humanizeAuditCode(code: string) {
  const words = String(code || "").replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_.:-]+/).filter(Boolean).map((word, index) => ACRONYMS[word.toLowerCase()] || (index ? word.toLowerCase() : word));
  const text = words.join(" ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}
// Codes inside a recorded summary ("today_priorities") read as words.
const readableSummary = (summary: string) => summary.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (code) => code.split("_").map((word) => ACRONYMS[word] || word).join(" "));

// Entity types as the server stores them, snake_case or class names, by
// their letters only: "purchase_order", "PurchaseOrder" and "PO" alike.
const ENTITY_LABELS: Record<string, Pair> = {
  purchaseorder: ["Purchase order", "采购订单"], po: ["Purchase order", "采购订单"], purchaseorderline: ["Purchase order line", "采购订单行"],
  purchaserequest: ["Purchase request", "采购申请"], rfq: ["RFQ", "询价单"], supplierquotation: ["Supplier quotation", "供应商报价"], rfqawarddecision: ["Award decision", "授标决定"],
  supplier: ["Supplier", "供应商"], item: ["Item", "物料"], sku: ["Item", "物料"], inventoryitem: ["Item", "物料"], itemsupplier: ["Supplier price", "供应商价格"],
  customer: ["Customer", "客户"], warehouse: ["Warehouse", "仓库"], warehousebin: ["Bin", "库位"], taxcode: ["Tax code", "税码"], paymentterm: ["Payment term", "付款条款"],
  receivingdoc: ["Receipt", "收货单"], receivingdocument: ["Receipt", "收货单"], grn: ["Receipt", "收货单"], receivingattachment: ["Receipt attachment", "收货附件"],
  supplierinvoice: ["Supplier invoice", "采购发票"], invoice: ["Supplier invoice", "采购发票"], customerinvoice: ["Customer invoice", "销售发票"],
  salesorder: ["Sales order", "销售订单"], customerorder: ["Sales order", "销售订单"], shipmentdocument: ["Shipment", "发货单"],
  inventoryreservation: ["Reservation", "库存预留"], inventorymovement: ["Inventory movement", "库存流水"], inventorybalance: ["Inventory balance", "库存余额"],
  stocktransferdocument: ["Inventory transfer", "库存调拨"], inventoryadjustmentdocument: ["Inventory adjustment", "库存调整单"], cyclecountsession: ["Cycle count", "循环盘点"],
  returnrequest: ["Return request", "退货申请"], returnauthorization: ["Return authorization", "退货授权"], returnpostingdocument: ["Return posting", "退货过账单"],
  settlementdocument: ["Settlement", "结算单"], settlementattachment: ["Settlement attachment", "结算附件"], internaltransferdocument: ["Internal transfer", "内部调拨"],
  advanceapplicationdocument: ["Advance application", "预付款核销"], paymentrecord: ["Payment record", "付款记录"], cashbookaccount: ["Cashbook account", "现金账户"],
  bankstatementline: ["Bank statement line", "银行流水"], bankstatementimportbatch: ["Bank statement import", "银行流水导入"], bankreconciliationgroup: ["Bank reconciliation", "银行对账"],
  financematchexception: ["Match exception", "匹配异常"], payableobligation: ["Payable", "应付款"], contract: ["Contract", "合同"],
  tenantrole: ["Role", "角色"], role: ["Role", "角色"], user: ["User", "用户"], tenant: ["Workspace", "工作区"], settings: ["Settings", "设置"], settingssection: ["Settings", "设置"],
  workspacesession: ["Sign-in session", "登录会话"], workspacesigninlink: ["Sign-in link", "登录链接"], aiskill: ["Assistant answer", "助手回答"],
  actiondraft: ["Action draft", "行动草稿"], intakebatch: ["Import batch", "导入批次"], dataimport: ["Data import", "数据导入"], dataqualityissue: ["Data quality issue", "数据质量问题"],
  reportworkspace: ["Report", "报表"],
};
const entityKey = (type: string | null | undefined) => String(type ?? "").toLowerCase().replace(/[^a-z]/g, "");
// Types whose id is a session, a link or an assistant skill: never shown.
const HIDDEN_ID_TYPES = new Set(["aiskill", "workspacesession", "workspacesigninlink", "tenant", "user"]);

export function auditEntityLabel(type: string | null | undefined, language: string) {
  const pair = ENTITY_LABELS[entityKey(type)];
  return pair ? pick(pair, language) : humanizeAuditCode(String(type ?? ""));
}

// The id to show beside the entity type, or "" when it is internal.
export function auditEntityIdText(type: string | null | undefined, id: string | null | undefined) {
  const value = String(id ?? "").trim();
  if (HIDDEN_ID_TYPES.has(entityKey(type)) || isInternalAuditId(value)) return "";
  return /^[a-z]+(?:_[a-z]+)+$/.test(value) ? humanizeAuditCode(value) : value;
}

// The assistant's skills by id (titles from server/domain/ai-skill-copy.mjs);
// a plan or clarification id reads as the kind of answer, never as the id.
const SKILL_TOPICS: Record<string, Pair> = {
  today_priorities: ["Today's priorities", "今日优先事项"], highest_risk_items: ["Open problems, oldest first", "未解决的问题（最早的在前）"],
  records_needing_data: ["Records needing data", "需要补齐的数据"], prepare_action_draft: ["Prepare an action draft", "准备处理草稿"],
  workspace_metrics: ["Open purchase orders and spend", "未结采购订单与金额"], purchase_orders: ["Purchase orders", "采购订单"],
  pending_approvals: ["Waiting for approval", "待审批"], inventory_availability: ["Stock and availability", "库存与可用量"],
  invoice_summary: ["Supplier invoices", "采购发票"], rfq_followups: ["RFQ follow-ups", "询价单跟进"], receiving_issues: ["Receiving issues", "收货问题"],
  supplier_attention: ["Suppliers needing attention", "需要注意的供应商"], spend_analysis: ["Spend by supplier, item and month", "按供应商、物料和月份看采购花费"],
  supplier_comparison: ["Supplier delivery performance", "供应商交付表现"], late_order_impact: ["What a late order affects", "订单延误的影响"],
  capability_overview: ["What I can help with", "我可以帮你做什么"], business_query_clarification: ["A clarifying question", "澄清问题"],
  knowledge_retrieval: ["Product and policy documents", "产品与政策资料"],
};
const skillTopic = (id: string) => SKILL_TOPICS[id] || (/^business_query_plan(_v\d+)?$/.test(id) ? (["A business question", "业务查询"] as Pair) : null);

const SETTINGS_SECTIONS: Record<string, Pair> = {
  company: ["Company & workspace", "公司与工作区"], roles: ["Users & roles", "用户与角色"], numbering: ["Numbering rules", "编号规则"], review: ["Review policies", "复核策略"],
  modules: ["Menus & modules", "菜单与模块"], ai: ["AI governance", "AI 治理"], advanced: ["Advanced settings", "高级设置"], documents: ["Documents", "单据"],
};

const PO_ACTIONS: Record<string, Pair> = {
  submit: ["Submitted purchase order {n} for approval.", "已提交采购订单 {n} 审批。"], approve: ["Approved purchase order {n}.", "已批准采购订单 {n}。"],
  reject: ["Rejected purchase order {n}.", "已驳回采购订单 {n}。"], return_for_revision: ["Returned purchase order {n} for revision.", "已退回采购订单 {n} 修改。"],
  issue: ["Issued purchase order {n}.", "已下达采购订单 {n}。"], cancel: ["Cancelled purchase order {n}.", "已取消采购订单 {n}。"], close: ["Closed purchase order {n}.", "已关闭采购订单 {n}。"],
};

// "<Document> <number> <what happened>[: reason]." from the stock, sales,
// returns and receiving services.
const DOCUMENTS: Record<string, Pair> = {
  "Shipment": ["Shipment", "发货单"], "Sales order": ["Sales order", "销售订单"], "Stock transfer": ["Stock transfer", "库存调拨"],
  "Inventory adjustment": ["Inventory adjustment", "库存调整单"], "Cycle count": ["Cycle count", "循环盘点"], "Return request": ["Return request", "退货申请"],
  "Return authorization": ["Return authorization", "退货授权"], "Supplier return posting": ["Supplier return posting", "供应商退货过账单"],
  "Customer return receipt": ["Customer return receipt", "客户退货收货单"], "Quarantine release": ["Quarantine release", "隔离释放单"], "Receiving": ["Receipt", "收货单"],
};
const DOCUMENT_EVENTS: Record<string, Pair> = {
  "draft created": ["draft created", "草稿已创建"], "draft revised": ["draft revised", "草稿已修改"], "created as draft": ["created as a draft", "已创建为草稿"],
  "created": ["created", "已创建"], "revised": ["revised", "已修改"], "updated": ["updated", "已更新"], "submitted": ["submitted", "已提交"], "reviewed": ["reviewed", "已复核"],
  "rejected": ["rejected", "已驳回"], "approved": ["approved", "已批准"], "closed": ["closed", "已关闭"], "completed": ["completed", "已完成"],
  "is ready": ["is ready", "已就绪"], "marked ready": ["marked ready", "已就绪"], "posted to inventory": ["posted to inventory", "已过账入库"],
  "posted to quarantine": ["posted to quarantine", "已过账至隔离区"], "posted with zero tenant net inventory change": ["posted; total stock is unchanged", "已过账，库存总量不变"],
  "posted": ["posted", "已过账"], "reversed": ["reversed", "已冲销"], "cancelled": ["cancelled", "已取消"],
  "confirm completed": ["confirmed", "已确认"], "hold completed": ["put on hold", "已暂停"], "resume completed": ["resumed", "已恢复"],
};
const DOCUMENT_PATTERN = new RegExp(`^(${Object.keys(DOCUMENTS).join("|")}) (\\S+) (${Object.keys(DOCUMENT_EVENTS).sort((a, b) => b.length - a.length).join("|")})(?:: (.+?))?\\.?$`);

// Other known summaries: the pattern, then [English, Chinese] with $1… for
// the parts the pattern captures. English null keeps the recorded text.
const RULES: Array<[RegExp, string | null, string]> = [
  [/^Sign-in link requested\.$/, null, "已申请登录链接。"],
  [/^Sign-in link used\.$/, null, "已使用登录链接。"],
  [/^Signed in with an email link\.$/, null, "已通过邮件链接登录。"],
  [/^Signed out\.$/, null, "已退出登录。"],
  [/^Ended (\d+) signed-in sessions?\.$/, null, "已结束 $1 个登录会话。"],
  [/^Role (.+) created\.$/, null, "已创建角色 $1。"],
  [/^Role (.+) updated\.$/, null, "已更新角色 $1。"],
  [/^Role assignments changed for (.+)\.$/, null, "已更改 $1 的角色。"],
  [/^Backfilled (\d+) legacy user role assignments\.$/, null, "已补录 $1 条旧版角色分配。"],
  [/^User profile and language preference updated\.$/, null, "已更新个人资料和语言偏好。"],
  [/^Company, workspace, locale, language, timezone, or base currency settings updated\.$/, null, "已更新公司、工作区、区域、语言、时区或本位币设置。"],
  [/^Created purchase request (\S+)\.$/, null, "已创建采购申请 $1。"],
  [/^Updated purchase request (\S+)\.$/, null, "已更新采购申请 $1。"],
  [/^Created RFQ (\S+) from purchase request (\S+)\.$/, null, "已根据采购申请 $2 创建询价单 $1。"],
  [/^Created (\d+) approved purchase order\(s\) from purchase request (\S+): (.+)\.$/, null, "已根据采购申请 $2 创建 $1 张已批准的采购订单：$3。"],
  [/^Created (\d+) purchase order\(s\) from purchase request (\S+): (.+)\.$/, null, "已根据采购申请 $2 创建 $1 张采购订单：$3。"],
  [/^Revised promised dates on (\d+) line\(s\) of purchase order (\S+)\.$/, null, "已修改采购订单 $2 中 $1 行的承诺交期。"],
  [/^Recorded reviewed RFQ Award Decision \S+\.$/, "Recorded the reviewed award decision.", "已记录经复核的授标决定。"],
  [/^Created receiving draft (\S+)\.$/, "Created receipt draft $1.", "已创建收货单草稿 $1。"],
  [/^Revised receiving draft (\S+)\.$/, "Revised receipt draft $1.", "已修改收货单草稿 $1。"],
  [/^Submitted receiving (\S+)\.$/, "Submitted receipt $1.", "已提交收货单 $1。"],
  [/^Cancelled receipt (\S+)\.$/, null, "已取消收货单 $1。"],
  [/^Inventory reserved for sales order (\S+)\.$/, null, "已为销售订单 $1 预留库存。"],
  [/^Inventory reservation released: (.+)$/, null, "已释放库存预留：$1"],
  [/^Return request (\S+) authorized as (\S+)\.$/, null, "退货申请 $1 已授权，退货授权为 $2。"],
  [/^Created contract (\S+) to renew (\S+)\.$/, null, "已创建合同 $1，用于续签 $2。"],
  [/^Created contract (\S+)\.$/, null, "已创建合同 $1。"],
  [/^Updated contract (\S+)\.$/, null, "已更新合同 $1。"],
  [/^Activated contract (\S+)\.$/, null, "已生效合同 $1。"],
  [/^Terminated contract (\S+)\.$/, null, "已终止合同 $1。"],
  [/^Started renewal (\S+) of contract (\S+)\.$/, null, "已开始续签合同 $2（$1）。"],
  [/^Deleted draft contract (\S+)\.$/, null, "已删除合同草稿 $1。"],
  [/^Added (.+) to contract (\S+)\.$/, null, "已向合同 $2 添加 $1。"],
  [/^Removed (.+) from contract (\S+)\.$/, null, "已从合同 $2 移除 $1。"],
  [/^Downloaded attachment (.+)\.$/, null, "已下载附件 $1。"],
  [/^Item (.+) created$/, null, "已创建物料 $1"],
  [/^Item (.+) updated$/, null, "已更新物料 $1"],
  [/^Customer (.+) created$/, null, "已创建客户 $1"],
  [/^Customer (.+) updated$/, null, "已更新客户 $1"],
  [/^Warehouse (\S+) created$/, null, "已创建仓库 $1"],
  [/^Warehouse (\S+) updated$/, null, "已更新仓库 $1"],
  [/^Bin (\S+) in warehouse (\S+) updated$/, null, "已更新仓库 $2 的库位 $1"],
  [/^Bin (\S+) added to warehouse (\S+)$/, null, "已向仓库 $2 添加库位 $1"],
  [/^Added supplier \S+ for item (.+)$/, "Added a supplier price for item $1", "已为物料 $1 添加供应商价格"],
  [/^Updated supplier \S+ for item (.+)$/, "Updated a supplier price for item $1", "已更新物料 $1 的供应商价格"],
  [/^Supplier profile created$/, null, "已创建供应商资料"],
  [/^Supplier profile updated$/, null, "已更新供应商资料"],
  [/^Supplier business owner changed$/, null, "已更改供应商负责人"],
  [/^Supplier business owner removed$/, null, "已移除供应商负责人"],
  [/^Supplier invoice draft created from authoritative PO and receiving facts\.$/, "Supplier invoice draft created from the purchase order and its receipts.", "已根据采购订单和收货记录创建采购发票草稿。"],
  [/^Supplier invoice draft recorded against its purchase order; it waits for the receipt before matching\.$/, null, "已按采购订单登记采购发票草稿；收货后再匹配。"],
  [/^Supplier invoice draft revised\.$/, null, "采购发票草稿已修改。"],
  [/^Supplier invoice submitted for three-way matching\.$/, null, "采购发票已提交三单匹配。"],
  [/^Supplier invoice cancelled; its receipt is released for a corrected invoice\.$/, null, "采购发票已取消；其收货可用于更正后的发票。"],
  [/^Supplier invoice recorded before the goods arrived is now linked to its posted receipt\.$/, null, "到货前登记的采购发票已关联到已过账的收货单。"],
  [/^Supplier invoice three-way match completed line by line\.$/, null, "采购发票已逐行完成三单匹配。"],
  [/^Line-level supplier invoice match exception reviewed\.$/, null, "已复核采购发票行的匹配异常。"],
  [/^Supplier invoice approved and payable obligation recorded\.$/, null, "采购发票已批准，并已登记应付款。"],
  [/^Duplicate flag dismissed with a reason; the supplier invoice itself was not changed\.$/, null, "已填写原因排除重复标记；采购发票本身未更改。"],
  [/^Supplier credit memo draft created from posted supplier return evidence\.$/, null, "已根据已过账的供应商退货创建供应商贷项草稿。"],
  [/^Supplier credit memo approved; no payment or ledger entry was created\.$/, null, "供应商贷项已批准；未产生付款或账务分录。"],
  [/^Customer invoice draft created from posted shipment facts\.$/, null, "已根据已过账的发货创建销售发票草稿。"],
  [/^Customer credit note draft created from posted return receipt\.$/, null, "已根据已过账的退货收货创建客户贷项通知单草稿。"],
  [/^Customer credit note approved without refund execution\.$/, null, "客户贷项通知单已批准，未执行退款。"],
  [/^Payment of (\S+) ([A-Z]{3}) recorded on (\S+); no money was moved\.$/, null, "已在 $3 上登记付款 $1 $2；未实际转账。"],
  [/^Payment of (\S+) ([A-Z]{3}) on (\S+) voided; the amount is outstanding again\.$/, null, "$3 上的付款 $1 $2 已作废；该金额重新计为未付。"],
  [/^AI answered .+$/, "Assistant answered a question.", "助手已回答问题。"],
];

const capture = (template: string, match: RegExpMatchArray) => template.replace(/\$(\d)/g, (_, n) => (match[Number(n)] ?? "").trim());

// The summary of one audit row in the interface language.
export function auditSummaryText(entry: AuditSummaryEntry, language: string): string {
  const action = String(entry.action ?? "");
  const summary = String(entry.summary ?? "").trim();
  if (!summary) return humanizeAuditCode(action);
  const english = language === "en-US";

  // "Assistant answered with today_priorities from workspace data."
  const answered = /^Assistant answered with (\S+) from workspace (data|documents)\.$/.exec(summary);
  if (answered) {
    const topic = skillTopic(answered[1]);
    if (answered[2] === "documents") return english ? "Assistant answered from workspace documents." : "助手已根据工作区资料回答。";
    return topic ? fill(english ? "Assistant answered: {topic}" : "助手已回答：{topic}", { topic: pick(topic, language) }) : english ? "Assistant answered from workspace data." : "助手已根据工作区数据回答。";
  }

  // "approve purchase order PO-202611-0001."
  const po = /^([a-z_]+) purchase order (\S+)\.$/.exec(summary);
  if (po) {
    const number = isInternalAuditId(po[2]) ? "" : po[2];
    const pair = PO_ACTIONS[po[1]] || (["Purchase order {n}: " + humanizeAuditCode(po[1]).toLowerCase() + ".", "采购订单 {n}：" + humanizeAuditCode(po[1]) + "。"] as Pair);
    return fill(pick(pair, language), { n: number }).replace(/\s{2,}/g, " ").replace(/ ([。：.:])/g, "$1");
  }

  // "review settings updated."
  const settings = /^(\w+) settings updated\.$/.exec(summary);
  if (settings) {
    const section = SETTINGS_SECTIONS[settings[1]];
    const name = section ? pick(section, language) : humanizeAuditCode(settings[1]);
    return english ? `Settings updated: ${name}.` : `已更新设置：${name}。`;
  }

  const document = DOCUMENT_PATTERN.exec(summary);
  if (document) {
    const [, kind, number, event, reason] = document;
    const doc = DOCUMENTS[kind], what = DOCUMENT_EVENTS[event];
    if (english) return `${doc[0]} ${number} ${what[0]}${reason ? `: ${reason}` : "."}`;
    return `${doc[1]} ${number} ${what[1]}${reason ? `：${reason}` : "。"}`;
  }

  // "Warehouse WH-01 set inactive", "Bin A-01 in warehouse WH-01 set active".
  const status = /^(?:(Bin) (\S+) in warehouse (\S+)|(Warehouse) (\S+)) set (\w+)$/.exec(summary);
  if (status) {
    const word = statusCodeLabel(status[6], language) || status[6];
    if (english) return `${status[1] ? `Bin ${status[2]} in warehouse ${status[3]}` : `Warehouse ${status[5]}`} set to ${word.toLowerCase()}`;
    return status[1] ? `仓库 ${status[3]} 的库位 ${status[2]} 已设为${word}` : `仓库 ${status[5]} 已设为${word}`;
  }

  for (const [pattern, en, zh] of RULES) {
    const match = summary.match(pattern);
    if (match) return english ? (en === null ? readableSummary(summary) : capture(en, match)) : capture(zh, match);
  }
  return readableSummary(summary);
}

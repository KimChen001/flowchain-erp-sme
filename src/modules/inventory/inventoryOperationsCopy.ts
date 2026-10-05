import { useMemo } from "react";
import { useI18n } from "../../i18n/I18n";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { workspaceCopy } from "../../i18n/workspaceCopy";

// Display copy for the inventory transfer, cycle count and adjustment
// workbench. Chinese source strings have an English entry; English source
// strings have a Chinese entry. Codes sent to the server are never translated.
const english: Record<string, string> = {
  "库存操作入口读取失败": "Could not load inventory operations",
  "正在读取正式库存操作数据...": "Loading inventory operations...",
  "库存操作 Beta 尚未由管理员启用；正式记录保持只读，所有交易动作均已关闭。": "An administrator has not enabled inventory operations (beta). Records are read only and all actions are off.",
  "库存操作": "Inventory operations",
  "正式 PostgreSQL 调拨、循环盘点与库存调整工作台。": "Transfers, cycle counts, and inventory adjustments.",
  "库存调拨": "Inventory transfers",
  "原子式来源扣减与目标增加，支持安全冲销。": "Moves stock out of the source and into the target in one step, with safe reversal.",
  "循环盘点": "Cycle counts",
  "快照、盲盘、复核与差异过账。": "Snapshot, blind count, review, and variance posting.",
  "库存调整": "Inventory adjustments",
  "受控原因、预览、过账与冲销。": "Reason codes, preview, posting, and reversal.",
  "打开工作台 →": "Open workbench →",
  "新建": "New",
  "单号": "Number",
  "流程状态": "Workflow status",
  "过账状态": "Posting status",
  "行数": "Lines",
  "更新时间": "Updated",
  "暂无正式记录": "No records yet",
  "创建失败": "Could not create the document",
  "新建库存调拨": "New inventory transfer",
  "调拨单号": "Transfer number",
  "物料": "Item",
  "调拨物料 {n}": "Transfer item {n}",
  "请选择": "Select",
  "数量": "Quantity",
  "调拨数量 {n}": "Transfer quantity {n}",
  "来源仓库": "Source warehouse",
  "来源仓库 {n}": "Source warehouse {n}",
  "来源库位": "Source location",
  "来源库位 {n}": "Source location {n}",
  "目标仓库": "Target warehouse",
  "目标仓库 {n}": "Target warehouse {n}",
  "目标库位": "Target location",
  "目标库位 {n}": "Target location {n}",
  "删除行": "Remove line",
  "添加行": "Add line",
  "保存草稿": "Save draft",
  "新建循环盘点": "New cycle count",
  "盘点单号": "Count number",
  "仓库": "Warehouse",
  "盘点仓库": "Count warehouse",
  "盲盘": "Blind count",
  "可用 {n}": "available {n}",
  "建立盘点快照": "Take count snapshot",
  "新建库存调整": "New inventory adjustment",
  "调整单号": "Adjustment number",
  "原因": "Reason",
  "调整原因": "Adjustment reason",
  "备注": "Notes",
  "调整备注": "Adjustment notes",
  "库存余额": "Inventory balance",
  "调整余额 {n}": "Adjustment balance {n}",
  "调整数量": "Adjustment quantity",
  "调整数量 {n}": "Adjustment quantity {n}",
  "减少库存不会影响已预留数量；调整后 On Hand 不得低于 Reserved。": "A decrease does not touch reserved stock. On hand cannot fall below reserved.",
  "读取失败": "Could not load",
  "操作失败": "The action failed",
  "预览失败": "Could not load the preview",
  "盘点录入失败": "Could not save the counted quantities",
  "正在读取库存操作工作台...": "Loading the workbench...",
  "返回列表": "Back to list",
  "盘点录入": "Count entry",
  "盲盘隐藏": "Hidden for blind count",
  "记录 {n}": "Recorded {n}",
  "实盘数量 {n}": "Counted quantity {n}",
  "差异待复核": "Variance to review",
  "差异 {n}": "Variance {n}",
  "保存盘点数量": "Save counted quantities",
  "业务行与库存影响": "Lines and inventory impact",
  "数量 / 调整": "Quantity / adjustment",
  "来源 / 仓库": "Source / warehouse",
  "目标 / 库位": "Target / location",
  "状态": "Status",
  "可执行动作": "Available actions",
  "操作原因": "Reason",
  "Preview 允许执行": "The preview allows this action",
  "Preview 阻止执行": "The preview blocks this action",
  "确认执行": "Confirm",
  "入 {in} · 出 {out}": "in {in} · out {out}",
  "Reconciliation：": "Reconciliation: ",
};

const chinese: Record<string, string> = {
  Ready: "标记就绪", Submit: "提交", Review: "复核", "Post Preview": "预览过账", "Reverse Preview": "预览冲销", Cancel: "取消",
  "Movement Evidence": "库存流水证据", "Reconciliation：": "对账：",
  "Stock record for line {n}": "第 {n} 行库存记录",
  "Existing stock record": "已有库存记录",
  "Item at a location with no stock record": "无库存记录的库位",
  "Adjustment item {n}": "调整物料 {n}",
  "Adjustment warehouse {n}": "调整仓库 {n}",
  "Adjustment location {n}": "调整库位 {n}",
  Location: "库位",
  "New stock record": "新库存记录",
  "This item already has a stock record here. Choose it under Existing stock record.": "该物料在此库位已有库存记录，请在“已有库存记录”中选择。",
  "Opening stock records what you already hold on go-live day. Posting creates the stock record. No cost is recorded.": "期初库存用于录入上线当天已有的数量，过账时创建库存记录，不记录成本。",
  "If the target location has no stock record yet, posting creates it.": "目标库位还没有库存记录时，过账会创建它。",
  "This item already holds {qty} here. Opening stock cannot be added on top of it. Choose another reason to correct it.": "该物料在此库位已有 {qty} 的库存，不能再录入期初库存。请改用其他原因更正。",
  "This item already has a stock record here. Opening stock is refused if the record has any history. Choose another reason to correct it.": "该物料在此库位已有库存记录；如该记录已有任何库存历史，期初库存将被拒绝。请改用其他原因更正。",
  "This item already has stock or stock history at this location, so opening stock cannot be recorded. Use another reason to correct it.": "该物料在此库位已有库存或库存历史，不能录入期初库存。请改用其他原因更正。",
  opening_balance: "期初库存",
  damage: "损坏", shrinkage: "损耗", found_stock: "盘盈", data_correction: "数据更正", quality_disposition: "质量处置", other: "其他",
};

const englishCodes: Record<string, string> = {
  damage: "Damage", shrinkage: "Shrinkage", found_stock: "Found stock", data_correction: "Data correction",
  quality_disposition: "Quality disposition", opening_balance: "Opening stock", other: "Other",
  ready: "Ready", counting: "Counting", counted: "Counted", reviewed: "Reviewed",
};
const chineseCodes: Record<string, string> = { ready: "已就绪", counting: "盘点中", counted: "已盘点", reviewed: "已复核" };

// Server refusals shown in this page's own words. The code is matched; the
// server's English message is shown for any other code.
const errorCodeCopy: Record<string, string> = {
  ADJUSTMENT_OPENING_BALANCE_EXISTS: "This item already has stock or stock history at this location, so opening stock cannot be recorded. Use another reason to correct it.",
};

function translate(language: string, label: string, vars: Record<string, string | number> = {}): string {
  const text = language === "en-US" ? english[label] || workspaceCopy(label, language) : chinese[label] || label;
  return Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text);
}

// Reason codes whose wording on this page differs from the shared status
// labels: the movement type "opening_balance" reads "Opening balance"
// elsewhere, while the adjustment reason reads "Opening stock".
const ownCodes = new Set(["opening_balance"]);

// Reason and status codes shown as labels; the code itself is what is stored.
function codeLabel(language: string, code: string): string {
  if (ownCodes.has(code)) return (language === "en-US" ? englishCodes[code] : chinese[code]) || code;
  return statusCodeLabel(code, language) || (language === "en-US" ? englishCodes[code] : chineseCodes[code] || chinese[code]) || code;
}

// Reads the active language so the page re-renders when it changes (the
// workspace language arrives after the first render).
export function useInventoryOperationsCopy() {
  const { language } = useI18n();
  return useMemo(() => ({
    copy: (label: string, vars?: Record<string, string | number>) => translate(language, label, vars),
    inventoryCodeLabel: (code: string) => codeLabel(language, code),
    // A refusal code this page knows, in the active language, or undefined.
    issueText: (code?: string) => (code && errorCodeCopy[code] ? translate(language, errorCodeCopy[code]) : undefined),
    // What a failed request shows: known refusal codes are translated, other
    // errors keep the server message, and anything else uses the fallback.
    errorText: (reason: unknown, fallback: string) => {
      const code = (reason as { code?: unknown } | null)?.code;
      const known = typeof code === "string" && errorCodeCopy[code];
      if (known) return translate(language, known);
      return reason instanceof Error ? reason.message : translate(language, fallback);
    },
  }), [language]);
}

import { Sparkles } from "lucide-react";
import { useI18n } from "../../i18n/I18n";
import { A } from "../ui";
import type { PrefillEntry, PrefillOrigin, PrefillSource } from "../../lib/prefill";

// A prefilled field's label says where its value came from
// (docs/ai-prefill-autocomplete-design.md §3). English with its Chinese
// translation, chosen by the interface language.
const SOURCE_LABELS: Record<PrefillSource, readonly [string, string]> = {
  record: ["From the record", "来自记录"],
  default: ["Default", "默认值"],
  template: ["Template", "模板"],
  history: ["Your last value", "你上次填写"],
  workspace_history: ["Used in this workspace", "本工作区用过"],
  model: ["AI wording", "AI 措辞"],
};

// Known references get a precise label; any other keeps the source's label.
const REF_LABELS: Record<string, readonly [string, string]> = {
  "assistant:gap": ["From the stock check", "来自库存检查"],
  "assistant:reason": ["Reason from the assistant", "来自助手的原因"],
  "assistant:due": ["Date from the assistant", "来自助手的日期"],
  "assistant:supplier": ["Supplier from the assistant", "来自助手的供应商"],
  "assistant:item": ["Item from the assistant", "来自助手的物料"],
  "reorder_list:gap": ["Shortfall from the reorder list", "来自补货清单的缺口"],
  "reorder_list:reason": ["Reason from the reorder list", "来自补货清单的原因"],
  "reorder_list:due": ["Date from the reorder list", "来自补货清单的日期"],
  "reorder_list:supplier": ["Preferred supplier from the reorder list", "来自补货清单的首选供应商"],
  "reorder_list:item": ["Item from the reorder list", "来自补货清单的物料"],
  "item_supplier:moq": ["Raised to the minimum order quantity", "已提高到最小起订量"],
  "item_supplier:lead_time": ["Today plus the supplier lead time", "今天加供应商提前期"],
  "item_supplier:preferred": ["Preferred supplier", "首选供应商"],
  "item_supplier:first_approved": ["First approved supplier", "第一个已批准供应商"],
  "item_supplier:reference_price": ["Reference price", "参考价"],
  "item:default_warehouse": ["Item default warehouse", "物料默认仓库"],
  "supplier:email": ["Supplier contact", "供应商联系人"],
  "purchase_order:warehouse": ["Purchase order warehouse", "采购订单仓库"],
  "user:default_warehouse": ["Your default warehouse", "你的默认仓库"],
  "workspace:only_warehouse": ["Your only warehouse", "你唯一可用的仓库"],
  "clock:now": ["Now", "当前时间"],
  "rfq:quantity": ["From the RFQ", "来自询价单"],
  "rfq:required_date": ["Required date from the RFQ", "询价单的需求日期"],
};

const ORIGIN_LABELS: Record<PrefillOrigin, readonly [string, string]> = {
  ai_assistant: ["the assistant", "助手"],
  today_cockpit: ["Today", "今日概览"],
  reorder_list: ["the reorder list", "补货清单"],
  form: ["this form", "本表单"],
};

const pick = (pair: readonly [string, string], language: string) => (language === "zh-CN" ? pair[1] : pair[0]);

export function prefillSourceLabel(entry: Pick<PrefillEntry, "source" | "ref">, language: string) {
  const byRef = entry.ref ? REF_LABELS[entry.ref] : undefined;
  return pick(byRef || SOURCE_LABELS[entry.source] || SOURCE_LABELS.default, language);
}

// Shown under a field while it still holds the suggested value.
export function PrefillSourceChip({ entry, current, testId }: { entry?: PrefillEntry | null; current?: string | number | null; testId?: string }) {
  const { language } = useI18n();
  if (!entry || String(current ?? "").trim() !== String(entry.value ?? "").trim()) return null;
  return (
    <span
      data-testid={testId || "prefill-source"}
      data-prefill-source={entry.source}
      className="mt-1 inline-flex w-fit max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4"
      style={{ background: "#eef4ff", color: A.blue }}
    >
      <Sparkles size={11} className="shrink-0" aria-hidden />
      <span>{prefillSourceLabel(entry, language)}</span>
    </span>
  );
}

const BANNER = {
  "en-US": {
    title: "Prefilled from {origin}",
    body: "Each suggested field says where its value came from. Check every field before you save; nothing is saved or submitted until you do.",
    rfq: "An RFQ starts from an approved purchase request. Save and submit this request; once it is approved, create the RFQ from it.",
  },
  "zh-CN": {
    title: "已根据{origin}预填",
    body: "每个预填字段都标明了来源。保存前请逐项核对；在你保存之前，不会保存或提交任何内容。",
    rfq: "询价单从已批准的采购申请发起。请先保存并提交这张申请，批准后再从申请创建询价单。",
  },
} as const;

export function PrefillBanner({ origin, intent }: { origin: PrefillOrigin; intent?: string | null }) {
  const { language } = useI18n();
  const copy = BANNER[language === "zh-CN" ? "zh-CN" : "en-US"];
  return (
    <div data-testid="prefill-banner" data-prefill-origin={origin} role="status" className="mt-3 rounded-md px-3 py-2 text-xs leading-5" style={{ background: "#f0f6ff", color: A.blue, border: `0.5px solid ${A.blue}30` }}>
      <div className="flex items-center gap-1.5 font-semibold"><Sparkles size={13} aria-hidden />{copy.title.replace("{origin}", pick(ORIGIN_LABELS[origin], language))}</div>
      <div className="mt-0.5" style={{ color: A.sub }}>{copy.body}</div>
      {intent === "rfq" ? <div data-testid="prefill-banner-rfq" className="mt-0.5" style={{ color: A.sub }}>{copy.rfq}</div> : null}
    </div>
  );
}

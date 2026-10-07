import type { Tier } from "./SupplierTier";

// Supplier list metrics and tier suggestions, as GET
// /api/master-data/supplier-insights serves them (server/domain/supplier-insights.mjs).
// A metric the reader may not see is null.
export type SuggestionReason =
  | { code: "spend_share"; share: number; rank: number; of: number; basis: "amount" | "orders"; currency?: string }
  | { code: "only_source" | "other_sources" | "sources_not_recorded"; skus: string[]; more: number }
  | { code: "orders"; orders: number }
  | { code: "no_orders" | "not_a_source" };
export type TierSuggestion = { tier: Tier; reasons: SuggestionReason[]; partial: boolean };
export type SupplierInsight = {
  spend12m: Array<{ currency: string; amount: number }> | null;
  spendComplete: boolean | null;
  orders12m: number | null;
  openPos: number | null;
  overduePos: number | null;
  onTime: { rate: number | null; count: number; of: number; sampleStatus: string } | null;
  openIssues: number | null;
  suggestion: TierSuggestion | null;
};
export type SupplierInsights = {
  asOf: string;
  visibility: { orders: boolean; amounts: boolean; onTime: boolean; issues: boolean };
  suppliers: Record<string, SupplierInsight>;
};

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] || "th";
  return `${n}${suffix}`;
};
const skuList = (reason: { skus: string[]; more: number }, zh: boolean) =>
  reason.skus.join(zh ? "、" : ", ") + (reason.more ? (zh ? ` 等 ${reason.skus.length + reason.more} 个物料` : ` and ${reason.more} more`) : "");

// One reason as a sentence in the interface language; numbers use the
// workspace locale, whatever the language.
export function formatSuggestionReason(reason: SuggestionReason, language: string, locale: string) {
  const zh = language === "zh-CN";
  switch (reason.code) {
    case "spend_share": {
      const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(reason.share);
      if (reason.basis === "amount") return zh ? `近 12 个月承诺采购额的 ${pct}，${reason.of} 家供应商中排第 ${reason.rank}` : `${pct} of committed spend in the last 12 months, ${ordinal(reason.rank)} of ${reason.of} suppliers`;
      return zh ? `近 12 个月已承诺采购单数的 ${pct}（按单数计），${reason.of} 家供应商中排第 ${reason.rank}` : `${pct} of committed purchase orders in the last 12 months, counted by orders, ${ordinal(reason.rank)} of ${reason.of} suppliers`;
    }
    case "only_source": return zh ? `${skuList(reason, true)} 唯一的已批准来源` : `Only approved source of ${skuList(reason, false)}`;
    case "other_sources": return zh ? `所供物料 ${skuList(reason, true)} 有其他已批准来源` : `Its items ${skuList(reason, false)} have other approved sources`;
    case "sources_not_recorded": return zh ? `${skuList(reason, true)} 的首选供应商（未记录其他来源）` : `Preferred supplier of ${skuList(reason, false)}; other sources are not recorded`;
    case "orders": return zh ? `近 12 个月 ${reason.orders} 张已承诺采购单` : `${reason.orders} committed purchase ${reason.orders === 1 ? "order" : "orders"} in the last 12 months`;
    case "no_orders": return zh ? "近 12 个月没有已承诺的采购单" : "No committed purchase orders in the last 12 months";
    case "not_a_source": return zh ? "不是任何在用物料的来源" : "Not a source of any active item";
    default: return "";
  }
}

// The reason prefilled when a suggestion is accepted: its facts, in order.
export const suggestionReasonText = (suggestion: TierSuggestion, language: string, locale: string) =>
  suggestion.reasons.map((reason) => formatSuggestionReason(reason, language, locale)).filter(Boolean).join(language === "zh-CN" ? "；" : "; ").slice(0, 500);

export const suggestionDiffers = (tier: Tier, suggestion: TierSuggestion | null | undefined) => Boolean(suggestion && suggestion.tier !== null && suggestion.tier !== tier);

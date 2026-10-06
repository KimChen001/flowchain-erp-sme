import { useI18n } from "../../i18n/I18n";
import { A } from "../ui";
import type { SupplierChoice } from "../../lib/prefill";

// An item's approved sources when none is preferred, for a person to choose
// one (shared/purchase-request-prefill.mjs orderSupplierChoices): by the day
// of the last issued PO for this item, most recent first; never ordered last;
// ties A-Z. Only issued (or received or closed) POs count, so the copy says
// "issued": a draft or cancelled PO is not a last PO here. Choosing a row sets the supplier only; nothing else is filled.
// Days are workspace days, printed YYYY-MM-DD in either language.
const COPY = {
  "en-US": {
    title: "Approved sources, most recent issued PO first",
    titleNoDates: "Approved sources, A–Z",
    noDates: "PO dates not available",
    lastPo: "Last issued PO {date} · {po}",
    orderDate: "(order date; issue date not recorded)",
    notIssued: "(order date; not issued in FlowChain)",
    noPo: "No issued PO yet",
    chosen: "Chosen",
  },
  "zh-CN": {
    title: "已批准供应来源，按最近已下达的采购订单排序",
    titleNoDates: "已批准供应来源，按名称排序",
    noDates: "无法查看采购订单日期",
    lastPo: "最近已下达的采购订单 {date} · {po}",
    orderDate: "（下单日期；未记录发出日期）",
    notIssued: "（下单日期，未在 FlowChain 下达）",
    noPo: "尚无已下达的采购订单",
    chosen: "已选择",
  },
} as const;

export function SupplierChoices({ choices, selectedId, onChoose, testId = "pr-supplier-choices" }: { choices: SupplierChoice[]; selectedId?: string; onChoose: (supplierId: string) => void; testId?: string }) {
  const { language } = useI18n();
  const copy = COPY[language === "zh-CN" ? "zh-CN" : "en-US"];
  if (!choices.length) return null;
  const datesKnown = choices.some((choice) => "lastOrder" in choice);
  const when = (choice: SupplierChoice) => {
    if (!datesKnown) return "";
    if (!choice.lastOrder) return copy.noPo;
    const last = copy.lastPo.replace("{date}", choice.lastOrder.day).replace("{po}", choice.lastOrder.orderNumber || choice.lastOrder.purchaseOrderId);
    if (choice.lastOrder.dateSource === "order_date") return `${last} ${copy.orderDate}`;
    if (choice.lastOrder.dateSource === "order_date_not_issued") return `${last} ${copy.notIssued}`;
    return last;
  };
  return (
    <div data-testid={testId} data-dates={datesKnown ? "known" : "unavailable"} className="mt-1 rounded-md border px-2 py-1.5 text-[11px] leading-4" style={{ borderColor: `${A.blue}30`, background: "#f7faff" }}>
      <div className="font-semibold" style={{ color: A.label }}>{datesKnown ? copy.title : copy.titleNoDates}</div>
      {!datesKnown ? <div data-testid={`${testId}-no-dates`} style={{ color: A.sub }}>{copy.noDates}</div> : null}
      <ul className="mt-1 space-y-0.5">
        {choices.map((choice) => {
          const chosen = selectedId === choice.id;
          return (
            <li key={choice.id}>
              <button
                type="button"
                data-testid={`${testId}-option`}
                data-supplier-id={choice.id}
                aria-pressed={chosen}
                onClick={() => onChoose(choice.id)}
                className="flex w-full flex-wrap items-baseline justify-between gap-x-2 rounded px-1 py-0.5 text-left hover:bg-white"
                style={chosen ? { background: "#fff", outline: `1px solid ${A.blue}` } : undefined}
              >
                <span className="font-medium" style={{ color: A.label }}>{choice.name}{chosen ? ` · ${copy.chosen}` : ""}</span>
                {datesKnown ? <span className="tabular-nums" style={{ color: A.sub }}>{when(choice)}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { useI18n } from "../../i18n/I18n";

// The purchasing lists a detail page returns to, with the link's wording.
const LISTS = {
  orders: { to: "/app/procurement/orders", label: ["Back to purchase orders", "返回采购订单"] },
  rfq: { to: "/app/procurement/rfq", label: ["Back to RFQs", "返回询价单与报价"] },
  receiving: { to: "/app/procurement/receiving", label: ["Back to receipts", "返回收货记录"] },
  bills: { to: "/app/procurement/bills", label: ["Back to supplier invoices", "返回采购发票"] },
  match: { to: "/app/procurement/three-way-match", label: ["Back to three-way match", "返回三单匹配"] },
} as const;

export type PurchasingList = keyof typeof LISTS;

// "← Back to <list>" at the top of a purchasing detail page, styled as the
// purchase request page's link.
export function BackToListLink({ list, className = "" }: { list: PurchasingList; className?: string }) {
  const { language } = useI18n();
  const { to, label } = LISTS[list];
  return (
    <Link to={to} data-testid={`back-to-${list}`} className={`inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline ${className}`}>
      <ArrowLeft size={13} />{label[language === "en-US" ? 0 : 1]}
    </Link>
  );
}

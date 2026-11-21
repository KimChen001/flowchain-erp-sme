import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { useI18n } from "../../i18n/I18n";
import { backLinkClass } from "../../components/ui/listLayout";

// The purchasing lists a detail page returns to, with the link's wording.
const LISTS = {
  requests: { to: "/app/procurement/requests", label: ["Back to purchase requests", "返回采购申请列表"] },
  orders: { to: "/app/procurement/orders", label: ["Back to purchase orders", "返回采购订单"] },
  rfq: { to: "/app/procurement/rfq", label: ["Back to RFQs", "返回询价单与报价"] },
  receiving: { to: "/app/procurement/receiving", label: ["Back to receipts", "返回收货记录"] },
  bills: { to: "/app/procurement/bills", label: ["Back to supplier invoices", "返回采购发票"] },
  match: { to: "/app/procurement/three-way-match", label: ["Back to three-way match", "返回三单匹配"] },
} as const;

export type PurchasingList = keyof typeof LISTS;

// The back link's look (listLayout.tsx), also for the pages whose link is not
// to a list: an RFQ's comparison back to the RFQ, a document back to its order.
export { backLinkClass };

// "← Back to <list>" at the top of a purchasing detail page, styled as the
// purchase request page's link.
export function BackToListLink({ list, className = "" }: { list: PurchasingList; className?: string }) {
  const { language } = useI18n();
  const { to, label } = LISTS[list];
  return (
    <Link to={to} data-testid={`back-to-${list}`} className={`${backLinkClass} ${className}`}>
      <ArrowLeft size={13} />{label[language === "en-US" ? 0 : 1]}
    </Link>
  );
}

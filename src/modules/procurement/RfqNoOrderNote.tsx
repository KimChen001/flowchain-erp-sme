import { A } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";

// What an RFQ can and cannot do yet (design audit A7): it records and compares
// quotes, but cannot become a purchase order. Shown on the RFQ list and here.
export function RfqNoOrderNote() {
  const { language } = useI18n();
  return (
    <p className="rounded-lg border px-4 py-3 text-xs leading-5" style={{ borderColor: A.border, background: A.gray6, color: A.sub }} data-testid="rfq-no-po-note">
      {language === "en-US"
        ? "An RFQ records supplier quotes so you can compare them. It cannot be turned into a purchase order yet: once you have chosen, cancel the RFQ and create the order from its purchase request, which uses the request's suppliers and prices."
        : "询价单用于记录和比较供应商报价，目前还不能直接转成采购订单：选定后请取消询价单，再从对应的采购申请生成采购订单（订单沿用申请上的供应商和价格）。"}
    </p>
  );
}

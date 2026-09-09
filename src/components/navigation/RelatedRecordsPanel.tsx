import { Link2 } from "lucide-react";
import { A, Card, Chip } from "../ui";
import { groupBusinessLinkedRecords, type BusinessLinkedRecord } from "../../lib/businessLinks";
import { workspaceCopy } from "../../i18n/workspaceCopy";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

const entityLabels: Record<string, string> = {
  sales_order: "客户订单",
  customer_order: "客户订单",
  inventory_item: "SKU",
  item: "SKU",
  purchase_request: "采购申请",
  rfq: "RFx",
  purchase_order: "采购订单",
  receiving_doc: "收货单",
  supplier: "供应商",
  supplier_invoice: "供应商发票",
  exception_case: "异常工单",
};

export function RelatedRecordsPanel({
  records,
  onNavigate,
}: {
  records: BusinessLinkedRecord[];
  onNavigate?: (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null) => void;
}) {
  const groups = groupBusinessLinkedRecords(records);
  const groupEntries = Object.entries(groups);

  return (
    <Card className="p-4" data-testid="related-records-panel">
      <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: A.label }}>
        <Link2 size={13} />
        {copy("相关记录")}
      </div>
      <div className="mt-3 space-y-3">
        {groupEntries.length ? groupEntries.map(([label, rows]) => (
          <div key={label}>
            <div className="mb-1.5 text-[11px] font-semibold" style={{ color: A.gray1 }}>{copy(label)}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {rows.map((record) => {
                const clickable = record.routeAvailable && record.focusTarget && onNavigate;
                const body = (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-[11px] font-semibold" style={{ color: clickable ? A.blue : A.label }}>
                        {record.displayLabel}
                      </div>
                      {record.status ? <Chip label={record.status} color={A.gray1} bg={A.gray6} /> : null}
                    </div>
                    <div className="mt-0.5 truncate fc-caption" style={{ color: A.gray2 }}>
                      {copy(entityLabels[record.entityType] || "业务记录")}
                    </div>
                    <div className="mt-1 fc-caption leading-4" style={{ color: record.disabledReason ? A.orange : A.sub }}>
                      {record.disabledReason || (record.relationshipReason ? copy(record.relationshipReason) : copy("已找到关联依据。"))}
                    </div>
                  </>
                );
                return clickable ? (
                  <button
                    key={`${record.entityType}-${record.entityId}-${label}`}
                    type="button"
                    onClick={() => onNavigate(record.route, record.focusTarget || null)}
                    className="rounded-lg px-2.5 py-2 text-left"
                    style={{ background: "#f8fbff", boxShadow: `0 0 0 0.5px ${A.border}` }}
                  >
                    {body}
                  </button>
                ) : (
                  <div
                    key={`${record.entityType}-${record.entityId}-${label}`}
                    className="rounded-lg px-2.5 py-2"
                    style={{ background: A.gray6, boxShadow: `0 0 0 0.5px ${A.border}` }}
                  >
                    {body}
                  </div>
                );
              })}
            </div>
          </div>
        )) : (
          <div className="rounded-lg px-2.5 py-2 text-[11px]" style={{ background: A.gray6, color: A.sub }}>
            {copy("暂无可追溯的相关记录。")}
          </div>
        )}
      </div>
    </Card>
  );
}

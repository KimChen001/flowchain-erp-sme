import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { AlertTriangle, CheckCircle2, Clock3, PackageCheck } from "lucide-react";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { EntityLink } from "../../components/business/EntityLink";
import { A, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, StatusChip, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { receivingApi, type ReceiptListItem } from "./receivingApi";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { ListPager, usePagedRows } from "./listPaging";

// Receipts drawn at a time; the cards, search and filters cover every receipt.
const PAGE_SIZE = 50;

// Receipts come from PostgreSQL through /api/procurement/receiving, drafts
// included, for the warehouses the signed-in user may read: all of them, so
// the total and the cards are true and older receipts are a page away.
export function ReceivingListPage() {
  const { language, locale, timezone, formatNumber, formatDateTime } = useI18n();
  // The list shows the arrival day; the time is in the cell's tooltip.
  const arrivalDay = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: timezone }).format(new Date(value));
  const quantity = (value?: string | null) => value && Number.isFinite(Number(value)) ? formatNumber(Number(value)) : "—";
  const tr = (zh: string, en: string) => language === "en-US" ? en : zh;
  const statusLabel = (status: string) => language === "en-US"
    ? (workspaceCopy(status, language) !== status ? workspaceCopy(status, language) : status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()))
    : workspaceCopy(status, language);
  const [rows, setRows] = useState<ReceiptListItem[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [query, setQuery] = useState("");
  const [supplier, setSupplier] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  // The posting filter lives in the address, so the metric cards can set it.
  const posting = searchParams.get("posting") || "";
  const setPosting = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set("posting", value); else params.delete("posting");
    setSearchParams(params, { replace: true });
  };

  const load = useCallback(async () => {
    setState("loading");
    try {
      setRows(await receivingApi.list());
      setState("loaded");
    } catch {
      setRows([]);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rejected = (row: ReceiptListItem) => Number(row.rejectedQuantity || 0) > 0;
  const postingOf = (row: ReceiptListItem) => row.postingStatus === "posted" ? "posted" : row.workflowStatus === "cancelled" ? "cancelled" : "unposted";
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) =>
    (!posting || (posting === "rejected" ? rejected(row) : postingOf(row) === posting))
    && (!supplier || row.supplierName === supplier)
    && (!warehouse || row.warehouse?.name === warehouse)
    && (!needle || [row.documentNumber, row.id, row.poNumber, row.poId, row.supplierName, row.receiver].some((value) => String(value || "").toLowerCase().includes(needle))),
  );
  const suppliers = [...new Set(rows.map((row) => row.supplierName || "").filter(Boolean))].sort();
  const warehouses = [...new Set(rows.map((row) => row.warehouse?.name || "").filter(Boolean))].sort();
  const count = (value: number) => state === "loaded" ? String(value) : "—";
  const { page, pageRows, setPage } = usePagedRows(shown, PAGE_SIZE, [posting, supplier, warehouse, needle].join("|"));
  const reset = () => {
    setQuery("");
    setSupplier("");
    setWarehouse("");
    setPosting("");
  };

  return (
    <div className="space-y-5" data-testid="procurement-receiving-list">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={tr("收货单", "Receipts")} value={count(rows.length)} description={tr("当前工作区可查看的收货单", "Receipts in the warehouses you can see")} to="/app/procurement/receiving" icon={PackageCheck} color={A.blue} />
        <ActionableMetricCard label={tr("已过账", "Posted")} value={count(rows.filter((row) => postingOf(row) === "posted").length)} description={tr("已计入库存", "Counted in inventory")} to="/app/procurement/receiving?posting=posted" icon={CheckCircle2} color={A.purple} />
        <ActionableMetricCard label={tr("未过账", "Not posted")} value={count(rows.filter((row) => postingOf(row) === "unposted").length)} description={tr("草稿或待过账，尚未计入库存", "Drafts or waiting to post, not in inventory yet")} to="/app/procurement/receiving?posting=unposted" icon={Clock3} color={A.orange} />
        <ActionableMetricCard label={tr("有拒收", "With rejections")} value={count(rows.filter(rejected).length)} description={tr("收货时拒收了部分数量", "Some quantity was rejected at receipt")} to="/app/procurement/receiving?posting=rejected" icon={AlertTriangle} color={A.red} />
      </div>

      <ListSearchCard
        title={tr("收货查询", "Receipt search")}
        subtitle={tr("点击编号查看收货、过账与库存影响。在采购订单上点击“收货”新建收货单。", "Select a number to review receiving, posting, and inventory impact. Start a new receipt with Receive on a purchase order.")}
        actions={<>
          <ResetButton onClick={reset} />
          <RefreshButton onClick={() => void load()} />
        </>}
      >
        <Field label={tr("搜索", "Search")}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("收货单、采购订单或供应商", "Receipt, purchase order or supplier")} style={inputStyle} />
        </Field>
        <Field label={tr("供应商", "Supplier")}>
          <select value={supplier} onChange={(event) => setSupplier(event.target.value)} style={inputStyle}>
            <option value="">{tr("全部供应商", "All suppliers")}</option>
            {suppliers.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <Field label={tr("仓库", "Warehouse")}>
          <select value={warehouse} onChange={(event) => setWarehouse(event.target.value)} style={inputStyle}>
            <option value="">{tr("全部仓库", "All warehouses")}</option>
            {warehouses.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <Field label={tr("过账", "Posting")}>
          <select value={posting} onChange={(event) => setPosting(event.target.value)} style={inputStyle}>
            <option value="">{tr("全部", "All")}</option>
            <option value="posted">{tr("已过账", "Posted")}</option>
            <option value="unposted">{tr("未过账", "Not posted")}</option>
            <option value="cancelled">{tr("已取消", "Cancelled")}</option>
            <option value="rejected">{tr("有拒收", "With rejections")}</option>
          </select>
        </Field>
      </ListSearchCard>

      <ListCard title={tr("收货单列表", "Receipt list")} total={state === "loaded" ? shown.length : undefined} shown={pageRows.length} testId="receiving-record-list">
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[1000px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("收货单", "Receipt")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("采购订单", "Purchase order")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("供应商", "Supplier")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("仓库", "Warehouse")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{tr("合格 / 拒收", "Accepted / rejected")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("到货时间", "Arrival time")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("状态", "Status")}</th>
                <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("操作", "Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {state === "loading" && <tr><td colSpan={8} className="px-4 py-12 text-center text-sm" style={{ color: A.sub }}>{tr("正在读取收货记录…", "Loading receiving records…")}</td></tr>}
              {state === "error" && <ListStateRow colSpan={8} state="error" title={tr("收货记录加载失败", "Could not load receiving records")} onRetry={() => void load()} />}
              {state === "loaded" && shown.length === 0 && (
                rows.length === 0
                  ? <ListStateRow colSpan={8} state="empty" title={tr("当前工作区暂无收货记录", "No receiving records in this workspace")} detail={tr("在采购订单上收货后，收货单会显示在这里。", "Receipts appear here after you receive against a purchase order.")} />
                  : <ListStateRow colSpan={8} state="empty" title={tr("没有符合筛选条件的收货单", "No receipts match these filters")} />
              )}
              {state === "loaded" && pageRows.map((row, index) => (
                <tr key={row.id} className={listRowClass} style={listRowStyle(index, pageRows.length)}>
                  <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                    <BusinessEntityLink entityType="receiving_doc" entityId={row.id} className={tableLinkClass}>
                      {row.documentNumber || row.id}
                    </BusinessEntityLink>
                    {row.receiver && <div className="text-[11px] font-normal" style={{ color: A.sub }}>{row.receiver}</div>}
                  </td>
                  <td className={tdNowrapClass}>
                    <BusinessEntityLink entityType="purchase_order" entityId={row.poId} number={row.poNumber}>
                      {row.poId || "—"}
                    </BusinessEntityLink>
                  </td>
                  <td className={`${tdNameClass} max-w-[200px] truncate`} title={row.supplierName || undefined}>{row.supplierName || "—"}</td>
                  <td className={tdNameClass}>
                    {row.warehouse?.name || "—"}
                    {row.warehouse?.code && <div className="text-[11px]" style={{ color: A.sub }}>{row.warehouse.code}</div>}
                  </td>
                  <td className={tdNumericRightClass}>
                    <span className="font-semibold" style={{ color: A.label }}>{quantity(row.acceptedQuantity)}</span>
                    <span style={{ color: rejected(row) ? "#b91c1c" : A.gray2 }}> / {quantity(row.rejectedQuantity)}</span>
                  </td>
                  <td className={tdNowrapClass} style={{ color: A.sub }} title={row.arrivedAt || row.createdAt ? formatDateTime(String(row.arrivedAt || row.createdAt)) : undefined}>
                    {row.arrivedAt || row.createdAt ? arrivalDay(String(row.arrivedAt || row.createdAt)) : "—"}
                  </td>
                  <td className={tdNowrapClass}>
                    {/* A posted receipt says Posted; one not posted also says where it stands (draft, ready, cancelled). */}
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip label={statusLabel(row.postingStatus || "—")} tone={statusToneOf(row.postingStatus)} testId="receipt-posting-status" />
                      {row.postingStatus !== "posted" && row.workflowStatus && (
                        <StatusChip label={statusLabel(row.workflowStatus)} tone={statusToneOf(row.workflowStatus)} testId="receipt-workflow-status" />
                      )}
                    </div>
                  </td>
                  <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                    {/* Not BusinessEntityLink: its "Receipt <number>" name would repeat the number link's. */}
                    <EntityLink kind="receiving_doc" id={row.id} className={`${rowActionClass.primary} !no-underline`}>
                      {tr("查看", "View")}
                    </EntityLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {state === "loaded" && <ListPager page={page} pageSize={PAGE_SIZE} total={shown.length} onPage={setPage} testId="receiving-record-pager" />}
      </ListCard>
    </div>
  );
}

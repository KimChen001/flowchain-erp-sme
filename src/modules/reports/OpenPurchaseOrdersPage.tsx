import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { apiJson } from '../../lib/api-client';
import { useI18n } from '../../i18n/I18n';
import { unitLabel } from '../../i18n/unitLabels';
import { formatCalendarDay, formatLocaleAmount } from '../../lib/format';
import { BusinessEntityLink } from '../../components/business/BusinessEntityLink';
import { exportWorkbookSheets } from '../../lib/excel/excelWorkbookService';
import { A, Card } from '../../components/ui';
import { StatusChip, listHeadRowStyle, statusToneOf } from '../../components/ui/listLayout';
import { listTableCardsRef, tableBodyTextClass, thClass, thRightClass } from '../../components/ui/workbenchTable';
import { ReportDateInput } from './ReportDateInput';

type Row = { id: string; orderNumber: string; supplier: string; supplierId: string; createdDate: string; dueDate: string; overdueDays: number | null; owner: string; ordered: number | null; received: number | null; remaining: number | null; unit: string; openLines?: number; lineCount?: number; amount: number | null; currency: string; status: string; isOpen: boolean; dataIncomplete: boolean };
type Report = { overdueSuppliers: { supplier: string; count: number }[]; overdueSupplierTotal?: number; overdueOrdersNotShown?: number; asOf: string; generatedAt: string; total: number; page: number; pageSize: number; pages: number; suppliers: string[]; currencies: string[]; rows: Row[]; exportRows?: Row[]; summary: { open: number; overdue: number; incomplete: number; totals: { currency: string; amount: number | null }[] } };
const zh: Record<string, string> = {
  'Enter a valid date range in YYYY-MM-DD format.': '请输入有效的日期范围，格式为 YYYY-MM-DD。',
  'Suppliers with overdue orders': '逾期订单供应商', 'Top 5 suppliers with overdue orders': '逾期订单最多的 5 家供应商', 'Select a supplier to view its overdue orders.': '选择供应商查看其逾期订单。', 'No overdue orders in this scope.': '当前范围没有逾期订单。',
  'Open purchase orders': '未结采购订单', 'Track delivery commitments and remaining receipts.': '跟踪交期承诺与待收货数量。',
  'Export all results': '导出全部结果', 'Exporting…': '正在导出…', 'Refresh': '刷新', 'Columns': '显示列', 'Order date from': '订单开始日期', 'Order date to': '订单结束日期',
  'Supplier': '供应商', 'All suppliers': '全部供应商', 'Currency': '币种', 'All currencies': '全部币种', 'Search PO, supplier or owner': '搜索订单、供应商或负责人',
  'Open orders': '未结订单', 'Overdue': '已逾期', 'Missing data': '资料不完整', 'All orders': '全部订单', 'Clear filters': '清除筛选', 'Order scope': '订单范围',
  'Order amount': '订单金额', 'Unavailable': '暂无数据', 'Multiple currencies — totals shown separately': '多币种金额分别汇总',
  'PO number': '采购单号', 'Order date': '订单日期', 'Next promised date': '最近承诺交期', 'Days overdue': '逾期天数', 'Ordered': '订购数量', 'Received': '已收数量', 'Remaining': '待收数量', 'Still to receive': '待收货', 'Unit': '单位', 'Owner': '负责人', 'Status': '状态', 'Actions': '操作', 'View order': '查看订单', 'Mixed units': '多种单位', 'Multiple SKUs': '多个 SKU',
  'Draft': '草稿', 'Pending approval': '待审批', 'Approved': '已批准', 'Issued': '已下达', 'Partially received': '部分收货', 'Fully received': '全部收货', 'Cancelled': '已取消', 'Closed': '已关闭', 'Completed': '已完成', 'Rejected': '已驳回', 'Unknown': '未知',
  'Loading report…': '正在加载报表…', 'Could not load report. Please retry.': '无法加载报表，请重试。', 'Could not export report. Please retry.': '无法导出报表，请重试。',
  'No orders match these filters.': '没有符合筛选条件的订单。', 'Previous': '上一页', 'Next': '下一页', 'Rows per page': '每页条数',
  'Updated': '更新于', 'As of (workspace time)': '统计日期（工作区时间）', 'Metric definitions': '指标说明',
  'Open orders are committed purchase orders (approved, issued or partially received) that still have quantity to receive. Drafts, orders pending approval, and rejected, cancelled or fully received orders are excluded.': '未结订单是已承诺（已批准、已下达或部分收货）且仍有待收数量的采购订单，不含草稿、待审批、已驳回、已取消或已全部收货的订单。',
  'Overdue uses the earliest promised date of an outstanding line, falling back to the order expected date. Missing dates are unknown, not on time.': '逾期按待收货行的最早承诺交期计算，没有行承诺交期则使用订单预计日期；缺少交期不视为准时。',
  'Quantities use recorded purchase order receipts. Quantities of different SKUs or units are not added together. Amount is the full order amount, not the unpaid balance.': '数量来自采购订单已记账收货记录，不同 SKU 或不同单位的数量不相加。金额为完整订单金额，并非未付款余额。',
  'Date filters use the order date, or the creation date when no order date is recorded; orders with neither are left out of a date range. KPIs and exports include every matching order; pagination only changes the displayed rows.': '日期按订单日期筛选，没有订单日期时使用创建日期；两者都没有的订单不计入日期范围。指标与导出包含全部符合条件的订单，分页仅影响显示行。',
  'Purchase orders': '采购订单', 'Report scope': '报表范围', 'Generated at': '生成时间', 'Matching orders': '符合条件的订单', 'FX converted': '已做汇率换算', 'No': '否', 'Field': '字段', 'Definition': '说明', 'Scope': '范围',
  'Bookmark this page to keep your filters and columns.': '收藏当前页面以保留筛选条件和显示列。',
};
// The table's columns, Status and the amount first after the order and its
// supplier; the order number opens the order, so there is no separate action
// column, and the table fits a 1440 px screen. "Still to receive" is the remaining quantity of a one-SKU order,
// or how many lines are open on an order of several SKUs, whose quantities are
// never added. The export keeps every field (EXPORT_COLUMNS).
type Column = { key: keyof Row; label: string; numeric?: boolean; sort?: keyof Row };
const columns: Column[] = [
  { key: 'orderNumber', label: 'PO number', sort: 'orderNumber' }, { key: 'supplier', label: 'Supplier', sort: 'supplier' }, { key: 'status', label: 'Status', sort: 'status' },
  { key: 'amount', label: 'Order amount', numeric: true }, { key: 'createdDate', label: 'Order date', sort: 'createdDate' }, { key: 'dueDate', label: 'Next promised date', sort: 'dueDate' },
  { key: 'overdueDays', label: 'Days overdue', numeric: true, sort: 'overdueDays' }, { key: 'remaining', label: 'Still to receive', numeric: true, sort: 'remaining' }, { key: 'owner', label: 'Owner', sort: 'owner' },
];
const EXPORT_COLUMNS: Column[] = [
  { key: 'orderNumber', label: 'PO number' }, { key: 'supplier', label: 'Supplier' }, { key: 'status', label: 'Status' }, { key: 'createdDate', label: 'Order date' }, { key: 'dueDate', label: 'Next promised date' },
  { key: 'overdueDays', label: 'Days overdue', numeric: true }, { key: 'ordered', label: 'Ordered', numeric: true }, { key: 'received', label: 'Received', numeric: true }, { key: 'remaining', label: 'Remaining', numeric: true },
  { key: 'unit', label: 'Unit' }, { key: 'amount', label: 'Order amount', numeric: true }, { key: 'currency', label: 'Currency' }, { key: 'owner', label: 'Owner' },
];
const statusLabels: Record<string, string> = { draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', issued: 'Issued', partially_received: 'Partially received', fully_received: 'Fully received', cancelled: 'Cancelled', closed: 'Closed', completed: 'Completed', rejected: 'Rejected' };
const definitions = [
  'Open orders are committed purchase orders (approved, issued or partially received) that still have quantity to receive. Drafts, orders pending approval, and rejected, cancelled or fully received orders are excluded.',
  'Overdue uses the earliest promised date of an outstanding line, falling back to the order expected date. Missing dates are unknown, not on time.',
  'Quantities use recorded purchase order receipts. Quantities of different SKUs or units are not added together. Amount is the full order amount, not the unpaid balance.',
  'Date filters use the order date, or the creation date when no order date is recorded; orders with neither are left out of a date range. KPIs and exports include every matching order; pagination only changes the displayed rows.',
];
// The look of the other dashboards: small buttons and controls on a gray fill.
const toolButton = 'h-8 rounded-lg px-3 text-xs font-medium disabled:opacity-40';
const control = 'h-8 w-full rounded-lg px-2 text-xs';
const SCOPES = [['open', 'Open orders'], ['overdue', 'Overdue'], ['incomplete', 'Missing data'], ['all', 'All orders']] as const;

export function OpenPurchaseOrdersPage() {
  const { language, locale, timezone, formatDateTime } = useI18n();
  const english = language !== 'zh-CN';
  // A recorded day (YYYY-MM-DD) in the workspace date format, read as that
  // calendar day; the export keeps the stored value.
  const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatCalendarDay(value, locale) : value;
  const t = (value: string) => english ? value : zh[value] || value;
  // Whole sentences with their figures, English and Chinese.
  const say = (englishText: string, chineseText: string) => english ? englishText : chineseText;
  const count = new Intl.NumberFormat(locale);
  const [params, setParams] = useSearchParams();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [customize, setCustomize] = useState(false);
  const dataParams = new URLSearchParams(params);
  dataParams.delete('hiddenColumns');
  const query = dataParams.toString();
  const scope = params.get('scope') || (params.get('overdue') === 'true' ? 'overdue' : 'open');
  const hidden = (params.get('hiddenColumns') || '').split(',');
  const visible = columns.filter(column => column.key === 'orderNumber' || !hidden.includes(column.key));
  const number = (value: number | null) => value === null ? t('Unavailable') : value.toLocaleString(locale, { maximumFractionDigits: 4 });
  const money = (value: number | null, currency: string) => {
    if (value === null || !/^[A-Z]{3}$/.test(currency)) return t('Unavailable');
    return formatLocaleAmount(value, currency, locale);
  };
  // What is still to receive: the quantity of a one-SKU order in its unit, or
  // the lines still open on an order of several SKUs or units.
  const severalItems = (row: Row) => row.unit === 'multiple_skus' || row.unit === 'mixed';
  const stillToReceive = (row: Row) => {
    if (severalItems(row) && Number.isFinite(row.openLines)) {
      const open = Number(row.openLines);
      return say(`${count.format(open)} ${open === 1 ? 'line' : 'lines'} open`, `${count.format(open)} 行未收`);
    }
    if (severalItems(row)) return t(row.unit === 'mixed' ? 'Mixed units' : 'Multiple SKUs');
    if (row.remaining === null) return t('Unavailable');
    return `${number(row.remaining)}${row.unit && !severalItems(row) ? ` ${unitLabel(row.unit, language, row.remaining)}` : ''}`;
  };
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const dates = ['from', 'to'].map(key => new URLSearchParams(query).get(key) || '');
    const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (dates.some(value => value && !validDay(value)) || (dates[0] && dates[1] && dates[0] > dates[1])) {
      setError('Enter a valid date range in YYYY-MM-DD format.'); setLoading(false); return;
    }
    apiJson<Report>(`/api/reports/open-purchase-orders?${query}`).then(value => { if (active) setReport(value); }).catch(() => { if (active) setError('Could not load report. Please retry.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, revision]);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params); if (key !== 'hiddenColumns') next.delete('page');
    if (key === 'scope') { next.delete('overdue'); next.delete('status'); }
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const sort = (key: string) => {
    const next = new URLSearchParams(params); next.delete('page'); next.set('sort', key);
    next.set('direction', params.get('sort') === key && params.get('direction') === 'asc' ? 'desc' : 'asc');
    setParams(next, { replace: true });
  };
  const cell = (row: Row, key: keyof Row) => key === 'status' ? t(statusLabels[row.status] || 'Unknown') : key === 'unit' ? row.unit === 'mixed' ? t('Mixed units') : row.unit === 'multiple_skus' ? t('Multiple SKUs') : row.unit || t('Unavailable') : row[key] === null || row[key] === '' ? t('Unavailable') : row[key];
  const exportAll = async () => {
    setExporting(true); setError('');
    try {
      const exportParams = new URLSearchParams(params); exportParams.set('export', 'true');
      const result = await apiJson<Report>(`/api/reports/open-purchase-orders?${exportParams}`);
      const exportColumns = EXPORT_COLUMNS.filter(column => column.key === 'orderNumber' || !hidden.includes(column.key));
      const rows = (result.exportRows || []).map(row => Object.fromEntries(exportColumns.map(column => [t(column.label), cell(row, column.key)])));
      await exportWorkbookSheets('Open-Purchase-Orders', [
        { name: t('Purchase orders'), rows: rows.length ? rows : [{ [t('Scope')]: t('No orders match these filters.') }] },
        { name: t('Report scope'), rows: [{ [t('Generated at')]: result.generatedAt, [t('As of (workspace time)')]: result.asOf, [t('Matching orders')]: result.total, [t('Scope')]: t(({ open: 'Open orders', all: 'All orders', overdue: 'Overdue', incomplete: 'Missing data' } as Record<string, string>)[scope]), [t('Order date from')]: params.get('from') || '', [t('Order date to')]: params.get('to') || '', [t('Supplier')]: params.get('supplier') || t('All suppliers'), [t('Currency')]: params.get('currency') || t('All currencies'), [t('Search PO, supplier or owner')]: params.get('search') || '', [t('FX converted')]: t('No') }] },
        { name: t('Metric definitions'), rows: definitions.map(value => ({ [t('Definition')]: t(value) })) },
      ], timezone);
    } catch { setError('Could not export report. Please retry.'); } finally { setExporting(false); }
  };
  const overdueTotal = report?.overdueSupplierTotal ?? report?.overdueSuppliers.length ?? 0;
  const moreSuppliers = Math.max(0, overdueTotal - (report?.overdueSuppliers.length ?? 0));
  const kpis = report ? [['Open orders', report.summary.open, 'open'], ['Overdue', report.summary.overdue, 'overdue'], ['Missing data', report.summary.incomplete, 'incomplete']] as const : [];
  return <section className="space-y-3" data-testid="open-purchase-orders-report">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-xl font-semibold tracking-tight" style={{ color: A.label }}>{t('Open purchase orders')}</h1><p className="mt-1 text-xs" style={{ color: A.sub }}>{t('Track delivery commitments and remaining receipts.')}</p></div>
      <div className="flex flex-wrap gap-2"><button className={toolButton} style={{ background: A.gray6, color: A.gray1 }} onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} className="mr-1 inline" />{t('Refresh')}</button><button className={`${toolButton} text-white`} style={{ background: A.blue }} disabled={loading || exporting || !report} onClick={exportAll}><Download size={13} className="mr-1 inline" />{t(exporting ? 'Exporting…' : 'Export all results')}</button></div>
    </div>
    {/* One filter card, as on the other dashboards: the scope as a segmented
        control, the dates, the supplier and currency, the search. */}
    <Card className="p-3" data-testid="open-po-filters">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-lg p-0.5" style={{ background: A.gray6 }} role="group" aria-label={t('Order scope')}>{SCOPES.map(([key, label]) => { const active = scope === key; return <button key={key} type="button" aria-pressed={active} onClick={() => change('scope', key)} className="h-7 rounded-md px-2.5 text-[11px] font-medium transition" style={active ? { background: '#ffffff', color: A.blue, boxShadow: '0 1px 2px rgba(15,23,42,0.1)' } : { color: A.gray1 }}>{t(label)}</button>; })}</div>
        <div className="flex items-center gap-1.5"><ReportDateInput className="h-8 w-[7.25rem] text-xs" label={t('Order date from')} value={params.get('from') || ''} language={language} onChange={value => change('from', value)} /><span aria-hidden="true" style={{ color: A.gray2 }}>–</span><ReportDateInput className="h-8 w-[7.25rem] text-xs" label={t('Order date to')} value={params.get('to') || ''} language={language} onChange={value => change('to', value)} /></div>
        <button type="button" onClick={() => setParams({}, { replace: true })} className="ml-auto h-8 rounded-lg px-2 text-[11px] font-medium hover:bg-blue-50" style={{ color: A.blue }}>{t('Clear filters')}</button>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
        {([['supplier', 'Supplier', 'All suppliers', report?.suppliers || []], ['currency', 'Currency', 'All currencies', report?.currencies || []]] as const).map(([key, label, all, values]) => <label key={key} className="text-[11px] font-medium" style={{ color: A.gray1 }}>{t(label)}<select className={`${control} mt-1`} style={{ background: A.gray6 }} value={params.get(key) || ''} onChange={event => change(key, event.target.value)}><option value="">{t(all)}</option>{values.map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}
        <label className="text-[11px] font-medium" style={{ color: A.gray1 }}>{t('Search PO, supplier or owner')}<input className={`${control} mt-1`} style={{ background: A.gray6 }} aria-label={t('Search PO, supplier or owner')} placeholder={t('Search PO, supplier or owner')} value={params.get('search') || ''} onChange={event => change('search', event.target.value)} /></label>
      </div>
    </Card>
    {error && <div role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{t(error)}</div>}
    {loading ? <p role="status" className="text-xs" style={{ color: A.sub }}>{t('Loading report…')}</p> : report && !error && <>
      {/* KPI cards as on the other dashboards; each one sets the scope. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map(([label, value, key]) => <button key={key} type="button" className="group min-w-0 text-left" aria-pressed={scope === key} onClick={() => change('scope', key)}><Card className="h-full min-w-0 p-4 transition hover:shadow-md" style={{ containerType: 'inline-size', ...(scope === key ? { boxShadow: `inset 0 0 0 1px ${A.blue}` } : {}) }}><span className="text-[11px] font-medium" style={{ color: A.gray1 }}>{t(label)}</span><div className="mt-2 font-semibold tabular-nums tracking-tight" style={{ fontSize: 'clamp(1rem, 11cqi, 1.5rem)', lineHeight: 1.25, color: key === 'overdue' && value ? '#dc2626' : A.label }}>{number(value)}</div></Card></button>)}
        <Card className="min-w-0 p-4" style={{ containerType: 'inline-size' }}><span className="text-[11px] font-medium" style={{ color: A.gray1 }}>{t('Order amount')}</span>{report.summary.totals.length ? report.summary.totals.map(total => <div key={total.currency} className="mt-2 whitespace-nowrap font-semibold tabular-nums tracking-tight" style={{ fontSize: report.summary.totals.length > 1 ? 'clamp(0.875rem, 8cqi, 1.125rem)' : 'clamp(1rem, 11cqi, 1.5rem)', lineHeight: 1.25, color: A.label }}>{money(total.amount, total.currency)}</div>) : <div className="mt-2 text-sm" style={{ color: A.sub }}>{t('Unavailable')}</div>}{report.summary.totals.length > 1 && <p className="mt-2 text-[11px]" style={{ color: A.sub }}>{t('Multiple currencies — totals shown separately')}</p>}</Card>
      </div>
      <Card className="p-4" data-testid="open-po-overdue-suppliers">
        <h2 className="text-sm font-semibold" style={{ color: A.label }}>{t(moreSuppliers ? 'Top 5 suppliers with overdue orders' : 'Suppliers with overdue orders')}</h2>
        <p className="mt-0.5 text-[11px]" style={{ color: A.gray2 }}>{t('Select a supplier to view its overdue orders.')}</p>
        <div className="mt-3 space-y-1">{report.overdueSuppliers.length ? report.overdueSuppliers.map(item => <button key={item.supplier} type="button" className="flex w-full items-center gap-3 rounded p-1.5 text-xs hover:bg-slate-50" onClick={() => { const next = new URLSearchParams(params); next.set('supplier', item.supplier); next.set('scope', 'overdue'); next.delete('page'); setParams(next, { replace: true }); }}><span className="w-32 shrink-0 truncate text-left sm:w-48" title={item.supplier}>{item.supplier || t('Unavailable')}</span><span className="h-2.5 flex-1 rounded" style={{ background: A.gray5 }}><span className="block h-2.5 rounded" style={{ width: `${item.count / Math.max(...report.overdueSuppliers.map(value => value.count)) * 100}%`, background: A.orange }} /></span><strong className="w-8 text-right tabular-nums">{count.format(item.count)}</strong></button>) : <p className="py-3 text-xs" style={{ color: A.sub }}>{t('No overdue orders in this scope.')}</p>}</div>
        {moreSuppliers > 0 && <button type="button" className="mt-2 text-[11px] font-medium" style={{ color: A.blue }} data-testid="open-po-overdue-more" onClick={() => change('scope', 'overdue')}>{say(`+${count.format(moreSuppliers)} more ${moreSuppliers === 1 ? 'supplier' : 'suppliers'} with ${count.format(report.overdueOrdersNotShown ?? 0)} overdue ${(report.overdueOrdersNotShown ?? 0) === 1 ? 'order' : 'orders'}`, `另有 ${count.format(moreSuppliers)} 家供应商共 ${count.format(report.overdueOrdersNotShown ?? 0)} 张逾期订单`)}</button>}
      </Card>
      <div className="text-[11px]" style={{ color: A.sub }}>{t('Updated')}: {formatDateTime(report.generatedAt)} · {t('As of (workspace time)')}: {day(report.asOf)}</div>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${A.border}` }}><h2 className="text-sm font-semibold">{say(`${count.format(report.total)} ${report.total === 1 ? 'result' : 'results'}`, `${count.format(report.total)} 条结果`)}</h2><button type="button" className={toolButton} style={{ background: A.gray6, color: A.blue }} aria-expanded={customize} onClick={() => setCustomize(!customize)}><SlidersHorizontal size={13} className="mr-1 inline" />{t('Columns')}</button></div>
        {customize && <div className="px-4 py-3" style={{ borderBottom: `1px solid ${A.border}` }}><div className="flex flex-wrap gap-4">{columns.filter(column => column.key !== 'orderNumber').map(column => <label key={column.key} className="text-xs"><input type="checkbox" checked={!hidden.includes(column.key)} onChange={() => change('hiddenColumns', hidden.includes(column.key) ? hidden.filter(key => key !== column.key).join(',') : [...hidden.filter(Boolean), column.key].join(','))} /> {t(column.label)}</label>)}</div><p className="mt-2 text-[11px]" style={{ color: A.sub }}>{t('Bookmark this page to keep your filters and columns.')}</p></div>}
        <div className="overflow-x-auto" ref={listTableCardsRef}><table className={`w-full min-w-[920px] text-left ${tableBodyTextClass}`} data-testid="open-po-table"><thead><tr style={listHeadRowStyle}>{visible.map(column => {
          const sortable = Boolean(column.sort);
          const sorted = column.sort && params.get('sort') === column.sort ? params.get('direction') === 'asc' ? 'ascending' : 'descending' : 'none';
          const SortIcon = sorted === 'ascending' ? ArrowUp : sorted === 'descending' ? ArrowDown : ChevronsUpDown;
          return <th key={column.key} aria-sort={sorted} className={`${column.numeric ? thRightClass : thClass} ${column.key === 'orderNumber' ? 'sticky left-0 z-20 bg-white' : ''}`} style={{ color: '#6b7280' }}>
            {sortable ? <button className={`inline-flex items-center gap-1 hover:text-slate-900 ${column.numeric ? 'flex-row-reverse' : ''}`} onClick={() => sort(String(column.sort))}>{t(column.label)}<SortIcon size={12} className={sorted === 'none' ? 'opacity-40' : 'text-blue-600'} aria-hidden /></button> : t(column.label)}
          </th>;
        })}</tr></thead><tbody>{report.rows.map(row => <tr key={row.id} className="border-t border-slate-100 transition-colors hover:bg-blue-50/40">{visible.map(column => <td key={column.key} className={`px-3 py-3 ${column.key === 'supplier' ? 'min-w-[9rem] max-w-[14rem]' : 'whitespace-nowrap'} ${column.numeric ? 'text-right tabular-nums' : ''} ${column.key === 'orderNumber' ? 'sticky left-0 bg-white z-10 font-medium' : ''} ${column.key === 'overdueDays' && Number(row.overdueDays) > 0 ? 'text-red-700 font-semibold' : ''}`}>{column.key === 'orderNumber' ? <BusinessEntityLink entityType="purchase_order" entityId={row.id} number={row.orderNumber} returnLabel={t('Open purchase orders')}>{row.orderNumber}</BusinessEntityLink> : column.key === 'amount' ? money(row.amount, row.currency) : column.key === 'status' ? <StatusChip label={String(cell(row, column.key))} tone={statusToneOf(row.status)} /> : column.key === 'remaining' ? stillToReceive(row) : (column.key === 'createdDate' || column.key === 'dueDate') && row[column.key] ? day(String(row[column.key])) : column.numeric ? number(row[column.key] as number | null) : String(cell(row, column.key))}</td>)}</tr>)}</tbody></table>{!report.rows.length && <p className="p-10 text-center text-xs" style={{ color: A.sub }}>{t('No orders match these filters.')}</p>}</div>
        <footer className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs" style={{ borderTop: `1px solid ${A.border}`, color: A.gray1 }}><span>{say(`Showing ${report.total ? count.format((report.page - 1) * report.pageSize + 1) : 0}–${count.format(Math.min(report.page * report.pageSize, report.total))} of ${count.format(report.total)}`, `显示第 ${report.total ? count.format((report.page - 1) * report.pageSize + 1) : 0}–${count.format(Math.min(report.page * report.pageSize, report.total))} 条，共 ${count.format(report.total)} 条`)}</span><label className="flex items-center gap-2 text-xs font-normal">{t('Rows per page')} <select className="h-7 rounded-lg px-2 text-xs" style={{ background: A.gray6 }} value={report.pageSize} onChange={event => change('pageSize', event.target.value)}>{[15, 25, 50, 100].map(size => <option key={size}>{size}</option>)}</select></label><div className="flex items-center gap-2"><button className={toolButton} style={{ background: A.gray6, color: A.gray1 }} disabled={report.page <= 1} onClick={() => change('page', String(report.page - 1))}>{t('Previous')}</button><span>{say(`Page ${report.page} of ${report.pages}`, `第 ${report.page} 页，共 ${report.pages} 页`)}</span><button className={toolButton} style={{ background: A.gray6, color: A.gray1 }} disabled={report.page >= report.pages} onClick={() => change('page', String(report.page + 1))}>{t('Next')}</button></div></footer>
      </Card>
      <details className="rounded-xl border bg-white p-4" style={{ borderColor: A.border }}><summary className="cursor-pointer text-sm font-medium">{t('Metric definitions')}</summary><ul className="mt-3 list-disc space-y-2 pl-5 text-xs" style={{ color: A.sub }}>{definitions.map(value => <li key={value}>{t(value)}</li>)}</ul></details>
    </>}
  </section>;
}

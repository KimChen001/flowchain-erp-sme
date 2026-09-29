import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Download, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { apiJson } from '../../lib/api-client';
import { useI18n } from '../../i18n/I18n';
import { BusinessEntityLink } from '../../components/business/BusinessEntityLink';
import { exportWorkbookSheets } from '../../lib/excel/excelWorkbookService';

type Row = { id: string; orderNumber: string; supplier: string; supplierId: string; createdDate: string; dueDate: string; overdueDays: number | null; owner: string; ordered: number | null; received: number | null; remaining: number | null; unit: string; amount: number | null; currency: string; status: string; isOpen: boolean; dataIncomplete: boolean };
type Report = { overdueSuppliers: { supplier: string; count: number }[]; asOf: string; generatedAt: string; total: number; page: number; pageSize: number; pages: number; suppliers: string[]; currencies: string[]; rows: Row[]; exportRows?: Row[]; summary: { open: number; overdue: number; incomplete: number; totals: { currency: string; amount: number | null }[] } };
const zh: Record<string, string> = {
  'Enter a valid date range in YYYY-MM-DD format.': '请输入有效的日期范围，格式为 YYYY-MM-DD。',
  'Suppliers with overdue orders': '逾期订单供应商', 'Select a supplier to view its overdue orders.': '选择供应商查看其逾期订单。', 'No overdue orders in this scope.': '当前范围没有逾期订单。',
  'Open purchase orders': '未完成采购订单', 'Track delivery commitments and remaining receipts.': '跟踪交期承诺与待收货数量。',
  'Export all results': '导出全部结果', 'Exporting…': '正在导出…', 'Refresh': '刷新', 'Columns': '显示列', 'Order date from': '订单开始日期', 'Order date to': '订单结束日期',
  'Supplier': '供应商', 'All suppliers': '全部供应商', 'Currency': '币种', 'All currencies': '全部币种', 'Search PO, supplier or owner': '搜索订单、供应商或负责人',
  'Open orders': '未完成订单', 'Overdue': '已逾期', 'Missing data': '资料不完整', 'All orders': '全部订单', 'Clear filters': '清除筛选',
  'Order amount': '订单金额', 'Unavailable': '暂无数据', 'Multiple currencies — totals shown separately': '多币种金额分别汇总',
  'PO number': '采购单号', 'Order date': '订单日期', 'Next promised date': '最近承诺交期', 'Days overdue': '逾期天数', 'Ordered': '订购数量', 'Received': '已收数量', 'Remaining': '待收数量', 'Unit': '单位', 'Owner': '负责人', 'Status': '状态', 'Actions': '操作', 'View order': '查看订单', 'Mixed units': '多种单位',
  'Draft': '草稿', 'Pending approval': '待审批', 'Approved': '已审批', 'Issued': '已下发', 'Partially received': '部分收货', 'Fully received': '全部收货', 'Cancelled': '已取消', 'Closed': '已关闭', 'Completed': '已完成', 'Rejected': '已驳回', 'Unknown': '未知',
  'Loading report…': '正在加载报表…', 'Could not load report. Please retry.': '无法加载报表，请重试。', 'Could not export report. Please retry.': '无法导出报表，请重试。',
  'No orders match these filters.': '没有符合筛选条件的订单。', 'Previous': '上一页', 'Next': '下一页', 'Rows per page': '每页条数', 'Page': '页', 'of': '/', 'results': '条结果', 'Showing': '显示',
  'Updated': '更新于', 'As of (UTC)': '统计日期（UTC）', 'Metric definitions': '指标说明',
  'Open orders exclude cancelled, rejected, closed and fully received orders. Drafts awaiting completion are included.': '未完成订单不含取消、驳回、关闭或已全部收货的订单，包括尚待完成的草稿。',
  'Overdue uses the earliest promised date of an outstanding line, falling back to the order expected date. Missing dates are unknown, not on time.': '逾期按待收货行的最早承诺交期计算，没有行交期则使用订单预计日期；缺少交期不视为准时。',
  'Quantities use recorded purchase order receipts. Different units are not added together. Amount is the full order amount, not the unpaid balance.': '数量来自采购订单已记账收货记录，不同单位不相加。金额为完整订单金额，并非未付款余额。',
  'Filters use order creation dates. KPIs and exports include every matching order; pagination only changes the displayed rows.': '日期按订单创建日期筛选。指标与导出包含全部符合条件的订单，分页仅影响显示行。',
  'Purchase orders': '采购订单', 'Report scope': '报表范围', 'Generated at': '生成时间', 'Matching orders': '符合条件的订单', 'FX converted': '已做汇率换算', 'No': '否', 'Field': '字段', 'Definition': '说明', 'Scope': '范围',
  'Bookmark this page to keep your filters and columns.': '收藏当前页面以保留筛选条件和显示列。',
};
const columns: { key: keyof Row; label: string; numeric?: boolean }[] = [
  { key: 'orderNumber', label: 'PO number' }, { key: 'supplier', label: 'Supplier' }, { key: 'createdDate', label: 'Order date' }, { key: 'dueDate', label: 'Next promised date' },
  { key: 'overdueDays', label: 'Days overdue', numeric: true }, { key: 'ordered', label: 'Ordered', numeric: true }, { key: 'received', label: 'Received', numeric: true }, { key: 'remaining', label: 'Remaining', numeric: true },
  { key: 'unit', label: 'Unit' }, { key: 'amount', label: 'Order amount', numeric: true }, { key: 'currency', label: 'Currency' }, { key: 'owner', label: 'Owner' }, { key: 'status', label: 'Status' },
];
const statusLabels: Record<string, string> = { draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', issued: 'Issued', partially_received: 'Partially received', fully_received: 'Fully received', cancelled: 'Cancelled', closed: 'Closed', completed: 'Completed', rejected: 'Rejected' };
const definitions = [
  'Open orders exclude cancelled, rejected, closed and fully received orders. Drafts awaiting completion are included.',
  'Overdue uses the earliest promised date of an outstanding line, falling back to the order expected date. Missing dates are unknown, not on time.',
  'Quantities use recorded purchase order receipts. Different units are not added together. Amount is the full order amount, not the unpaid balance.',
  'Filters use order creation dates. KPIs and exports include every matching order; pagination only changes the displayed rows.',
];
const fieldClass = 'mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm';
const buttonClass = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-40';

export function OpenPurchaseOrdersPage() {
  const { language, locale } = useI18n();
  const t = (value: string) => language === 'zh-CN' ? zh[value] || value : value;
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
    try { return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' }).format(value); } catch { return t('Unavailable'); }
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
  const cell = (row: Row, key: keyof Row) => key === 'status' ? t(statusLabels[row.status] || 'Unknown') : key === 'unit' ? row.unit === 'mixed' ? t('Mixed units') : row.unit || t('Unavailable') : row[key] === null || row[key] === '' ? t('Unavailable') : row[key];
  const exportAll = async () => {
    setExporting(true); setError('');
    try {
      const exportParams = new URLSearchParams(params); exportParams.set('export', 'true');
      const result = await apiJson<Report>(`/api/reports/open-purchase-orders?${exportParams}`);
      const exportColumns = columns.filter(column => visible.includes(column) || ['currency', 'unit'].includes(column.key));
      const rows = (result.exportRows || []).map(row => Object.fromEntries(exportColumns.map(column => [t(column.label), cell(row, column.key)])));
      await exportWorkbookSheets('Open-Purchase-Orders', [
        { name: t('Purchase orders'), rows: rows.length ? rows : [{ [t('Scope')]: t('No orders match these filters.') }] },
        { name: t('Report scope'), rows: [{ [t('Generated at')]: result.generatedAt, [t('As of (UTC)')]: result.asOf, [t('Matching orders')]: result.total, [t('Scope')]: t(({ open: 'Open orders', all: 'All orders', overdue: 'Overdue', incomplete: 'Missing data' } as Record<string, string>)[scope]), [t('Order date from')]: params.get('from') || '', [t('Order date to')]: params.get('to') || '', [t('Supplier')]: params.get('supplier') || t('All suppliers'), [t('Currency')]: params.get('currency') || t('All currencies'), [t('Search PO, supplier or owner')]: params.get('search') || '', [t('FX converted')]: t('No') }] },
        { name: t('Metric definitions'), rows: definitions.map(value => ({ [t('Definition')]: t(value) })) },
      ]);
    } catch { setError('Could not export report. Please retry.'); } finally { setExporting(false); }
  };
  return <section className="space-y-4" data-testid="open-purchase-orders-report">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{t('Open purchase orders')}</h1><p className="mt-1 text-sm text-slate-500">{t('Track delivery commitments and remaining receipts.')}</p></div><div className="flex gap-2"><button className={buttonClass} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} className="mr-2 inline" />{t('Refresh')}</button><button className={buttonClass} disabled={loading || exporting || !report} onClick={exportAll}><Download size={15} className="mr-2 inline" />{t(exporting ? 'Exporting…' : 'Export all results')}</button></div></header>
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['from', 'Order date from'], ['to', 'Order date to']].map(([key, label]) => <label key={key} className="text-xs text-slate-600">{t(label)}<input className={fieldClass} type="text" placeholder="YYYY-MM-DD" maxLength={10} pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" value={params.get(key) || ''} onChange={event => change(key, event.target.value)} /></label>)}{[['supplier', 'Supplier', 'All suppliers', report?.suppliers || []], ['currency', 'Currency', 'All currencies', report?.currencies || []]].map(([key, label, all, values]) => <label key={String(key)} className="text-xs text-slate-600">{t(String(label))}<select className={fieldClass} value={params.get(String(key)) || ''} onChange={event => change(String(key), event.target.value)}><option value="">{t(String(all))}</option>{(values as string[]).map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}</div>
      <input className={fieldClass} aria-label={t('Search PO, supplier or owner')} placeholder={t('Search PO, supplier or owner')} value={params.get('search') || ''} onChange={event => change('search', event.target.value)} />
      <div className="flex flex-wrap gap-2">{[['open', 'Open orders'], ['overdue', 'Overdue'], ['incomplete', 'Missing data'], ['all', 'All orders']].map(([key, label]) => <button key={key} aria-pressed={scope === key} className={`${buttonClass} ${scope === key ? '!bg-blue-50 !border-blue-300 text-blue-700' : ''}`} onClick={() => change('scope', key)}>{t(label)}</button>)}<button className={`${buttonClass} ml-auto`} onClick={() => setParams({}, { replace: true })}>{t('Clear filters')}</button></div>
    </div>
    {error && <div role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{t(error)}</div>}
    {loading ? <p role="status">{t('Loading report…')}</p> : report && !error && <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['Open orders', report.summary.open, 'open'], ['Overdue', report.summary.overdue, 'overdue'], ['Missing data', report.summary.incomplete, 'incomplete']].map(([label, value, key]) => <button key={String(key)} className="rounded-xl border border-slate-200 bg-white p-5 text-left hover:border-blue-300" onClick={() => change('scope', String(key))}><span className="text-sm text-slate-500">{t(String(label))}</span><div className={`mt-2 text-3xl font-semibold tabular-nums ${key === 'overdue' && Number(value) ? 'text-red-600' : ''}`}>{number(Number(value))}</div></button>)}<div className="rounded-xl border border-slate-200 bg-white p-5"><span className="text-sm text-slate-500">{t('Order amount')}</span>{report.summary.totals.length ? report.summary.totals.map(total => <div key={total.currency} className="mt-2 text-lg font-semibold tabular-nums">{money(total.amount, total.currency)}</div>) : <div className="mt-2">{t('Unavailable')}</div>}{report.summary.totals.length > 1 && <p className="mt-2 text-xs text-slate-500">{t('Multiple currencies — totals shown separately')}</p>}</div></div>
      <div className="rounded-xl border border-slate-200 bg-white p-4"><h2 className="font-semibold">{t('Suppliers with overdue orders')}</h2><p className="mt-1 text-xs text-slate-500">{t('Select a supplier to view its overdue orders.')}</p><div className="mt-3 space-y-2">{report.overdueSuppliers.length ? report.overdueSuppliers.map(item => <button key={item.supplier} className="flex w-full items-center gap-4 rounded p-2 text-sm hover:bg-slate-50" onClick={() => { const next = new URLSearchParams(params); next.set('supplier', item.supplier); next.set('scope', 'overdue'); next.delete('page'); setParams(next, { replace: true }); }}><span className="w-48 truncate text-left">{item.supplier || t('Unavailable')}</span><span className="flex-1 rounded bg-slate-100 h-3"><span className="block h-3 rounded bg-amber-500" style={{ width: `${item.count / Math.max(...report.overdueSuppliers.map(value => value.count)) * 100}%` }} /></span><strong className="w-8 text-right">{item.count}</strong></button>) : <p className="py-3 text-sm text-slate-500">{t('No overdue orders in this scope.')}</p>}</div></div>
      <div className="text-xs text-slate-500">{t('Updated')}: {new Date(report.generatedAt).toLocaleString(locale)} · {t('As of (UTC)')}: {report.asOf}</div>
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4"><strong>{report.total} {t('results')}</strong><button className={buttonClass} aria-expanded={customize} onClick={() => setCustomize(!customize)}><SlidersHorizontal size={15} className="mr-2 inline" />{t('Columns')}</button></div>
        {customize && <div className="border-t p-4"><div className="flex flex-wrap gap-4">{columns.filter(column => column.key !== 'orderNumber').map(column => <label key={column.key} className="text-sm"><input type="checkbox" checked={!hidden.includes(column.key)} onChange={() => change('hiddenColumns', hidden.includes(column.key) ? hidden.filter(key => key !== column.key).join(',') : [...hidden.filter(Boolean), column.key].join(','))} /> {t(column.label)}</label>)}</div><p className="mt-3 text-xs text-slate-500">{t('Bookmark this page to keep your filters and columns.')}</p></div>}
        <div className="overflow-auto max-h-[560px]"><table className="w-full text-sm" data-testid="open-po-table"><thead className="sticky top-0 z-20 bg-slate-50"><tr>{visible.map(column => { const sortable = ['orderNumber', 'supplier', 'createdDate', 'dueDate', 'overdueDays', 'remaining', 'owner', 'status'].includes(column.key); return <th key={column.key} aria-sort={params.get('sort') === column.key ? params.get('direction') === 'asc' ? 'ascending' : 'descending' : 'none'} className={`border-y px-4 py-3 ${column.numeric ? 'text-right' : 'text-left'} ${column.key === 'orderNumber' ? 'sticky left-0 z-30 bg-slate-50' : ''}`}><div className="resize-x overflow-auto min-w-[100px]">{sortable ? <button className="w-full text-inherit" onClick={() => sort(column.key)}>{t(column.label)} {params.get('sort') === column.key ? params.get('direction') === 'asc' ? '↑' : '↓' : '↕'}</button> : t(column.label)}</div></th>; })}<th className="border-y px-4 py-3">{t('Actions')}</th></tr></thead><tbody>{report.rows.map(row => <tr key={row.id} className="border-b last:border-0 hover:bg-blue-50/30">{visible.map(column => <td key={column.key} className={`px-4 py-3 whitespace-nowrap ${column.numeric ? 'text-right tabular-nums' : ''} ${column.key === 'orderNumber' ? 'sticky left-0 bg-white z-10' : ''} ${column.key === 'overdueDays' && Number(row.overdueDays) > 0 ? 'text-red-700 font-semibold' : ''}`}>{column.key === 'orderNumber' ? <BusinessEntityLink entityType="purchase_order" entityId={row.id} returnLabel={t('Open purchase orders')}>{row.orderNumber}</BusinessEntityLink> : column.key === 'amount' ? money(row.amount, row.currency) : column.numeric ? number(row[column.key] as number | null) : String(cell(row, column.key))}</td>)}<td className="px-4 py-3 whitespace-nowrap"><BusinessEntityLink entityType="purchase_order" entityId={row.id} returnLabel={t('Open purchase orders')}>{t('View order')}</BusinessEntityLink></td></tr>)}</tbody></table>{!report.rows.length && <p className="p-10 text-center text-slate-500">{t('No orders match these filters.')}</p>}</div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm"><span>{t('Showing')} {report.total ? (report.page - 1) * report.pageSize + 1 : 0}–{Math.min(report.page * report.pageSize, report.total)} {t('of')} {report.total}</span><label>{t('Rows per page')} <select className="rounded border p-1" value={report.pageSize} onChange={event => change('pageSize', event.target.value)}>{[15, 25, 50, 100].map(size => <option key={size}>{size}</option>)}</select></label><div className="flex items-center gap-3"><button className={buttonClass} disabled={report.page <= 1} onClick={() => change('page', String(report.page - 1))}>{t('Previous')}</button><span>{t('Page')} {report.page} {t('of')} {report.pages}</span><button className={buttonClass} disabled={report.page >= report.pages} onClick={() => change('page', String(report.page + 1))}>{t('Next')}</button></div></footer>
      </div>
      <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer text-sm font-medium">{t('Metric definitions')}</summary><ul className="mt-3 list-disc pl-5 space-y-2 text-sm text-slate-600">{definitions.map(value => <li key={value}>{t(value)}</li>)}</ul></details>
    </>}
  </section>;
}

import { isCommittedPurchaseOrder } from './open-purchase-order.mjs';

// What a status chart or detail table of purchase orders covers.
export const ALL_PURCHASE_ORDERS = 'All purchase orders in range, every status.';

// What a chart over records the reader may not read says instead of its
// figures, as a KPI over them reads "Restricted": the records are hidden, not
// absent, so the chart never draws them as zero.
export const WITHHELD_SUBJECT = {
  purchase_orders: 'Your role cannot view purchase orders.',
  sales_orders: 'Your role cannot view sales orders.',
  inventory_balances: 'Your role cannot view inventory.',
};
export const WITHHELD_RECORDS = 'Your role cannot view these records.';

// The analytics tab each area of the overview opens for detail. The procurement
// tab is named with its dashboard view, because a date or supplier filter the
// link carries would otherwise open the open purchase orders report.
export const OVERVIEW_TABS = {
  procurement: '/app/reports/procurement?view=analytics',
  sales: '/app/reports/sales',
  inventory: '/app/reports/inventory',
  finance: '/app/reports/finance',
};

// Aggregate the loaded, permission-scoped records before applying the detail limit.
// Each chart says which purchase orders it covers: the supplier chart counts
// committed orders, like the committed PO amount; the activity chart covers
// every status, drafts and cancellations included.
// salesDemand holds the open demand of each sales order line in scope
// ({ orderId, open }); an order is unfulfilled while any of its lines has
// demand left, so lines in different units are never added to decide it.
// reorder is the reorder list's summary ({ orderNow }), read as the reorder
// list and Today read it, so the three show the same count; without it (no
// database, a reader of only some warehouses) the card is left out.
// salesActivity, when given, is the groups of sales orders the figures count
// (each with its number of orders, count), so the monthly activity covers
// every order even when only the latest were read; partial is the months the
// range or today cuts short (partialMonths), which the chart marks.
// restrictedSubjects are the subjects the reader may not read: their series,
// charts and attention cards are left out, never shown as zero.
export function buildBusinessOverview(all, { salesDemand = null, reorder = null, salesActivity = null, partial = null, restrictedSubjects = new Set() } = {}) {
  const hidden = restrictedSubjects instanceof Set ? restrictedSubjects : new Set(restrictedSubjects || []);
  const purchases = all.purchase_orders;
  const sales = all.sales_orders;
  const active = row => !['closed', 'cancelled', 'canceled', 'completed', 'fully_received', 'rejected'].includes(row.status);
  const ordersWithDemand = salesDemand ? new Set(salesDemand.filter(line => line.open > 0).map(line => line.orderId)) : null;
  const unfulfilled = row => ordersWithDemand ? ordersWithDemand.has(row.id) : row.quantity > row.fulfilled;
  // One series per subject the reader may read.
  const series = [[purchases, 'Purchase orders', 'purchase_orders', '#2563eb'], [Array.isArray(salesActivity) ? salesActivity : sales, 'Sales orders', 'sales_orders', '#14b8a6']].filter(([, , subject]) => !hidden.has(subject));
  const months = new Map();
  for (const [rows, key] of series) {
    for (const row of rows) {
      const month = /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date.slice(0, 7) : 'Undated';
      if (!months.has(month)) months.set(month, { name: month, ...Object.fromEntries(series.map(([, name]) => [name, 0])) });
      months.get(month)[key] += Number.isFinite(row.count) ? row.count : 1;
    }
  }
  const activity = [...months.values()].sort((a, b) => a.name.localeCompare(b.name));
  const groups = (rows, field) => {
    const counts = new Map();
    for (const row of rows) { const key = row[field] || 'Unspecified'; counts.set(key, (counts.get(key) || 0) + 1); }
    return [...counts].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  };
  const common = { unit: 'number', valueFormat: 'number', categoryKey: 'name', valueKey: 'value', tooltip: true, legend: true, emptyState: 'No records in the selected range.' };
  const purchasesHidden = hidden.has('purchase_orders');
  // Each card counts records of one subject; a reader who may not read them gets no card.
  const card = (subject, item) => hidden.has(subject) ? [] : [item];
  return {
    charts: [
      { ...common, id: 'overview_activity', title: 'Record activity by month', type: 'bar', data: activity, partialPeriods: activity.filter(row => partial?.has?.(row.name)).map(row => ({ period: row.name, reason: partial.get(row.name) })), seriesKeys: series.map(([, name]) => name), colors: series.map(([, , , color]) => color), drilldownPath: OVERVIEW_TABS.procurement, crossFilter: 'period', description: 'Purchase and sales orders in range by order date, every status, drafts included.', ...(series.length ? {} : { emptyState: WITHHELD_RECORDS }) },
      { ...common, id: 'overview_suppliers', title: 'Committed purchase orders by supplier', type: 'horizontal_bar', data: purchasesHidden ? [] : groups(purchases.filter(isCommittedPurchaseOrder), 'supplier').slice(0, 8), drilldownPath: OVERVIEW_TABS.procurement, crossFilter: 'supplier', description: 'Committed purchase orders in range (approved, issued or received), counted per supplier.', ...(purchasesHidden ? { emptyState: WITHHELD_SUBJECT.purchase_orders } : {}) },
    ],
    attention: [
      // isOpen is set once per purchase order by the report read model from the
      // full record, using the shared definition, so this card and the open
      // purchase orders report it links to always count the same orders.
      ...card('purchase_orders', { id: 'open_orders', label: 'Open purchase orders', count: purchases.filter(row => row.isOpen).length, path: '/app/reports/procurement?status=open', action: 'Review orders' }),
      ...(Number.isInteger(reorder?.orderNow) ? [{ id: 'items_to_reorder', label: 'Items to reorder', count: reorder.orderNow, path: '/app/inventory/reorder', action: 'Open reorder list' }] : []),
      // Short against open sales orders; an item below its reorder point is in
      // the card above and in the low-stock KPI.
      ...card('inventory_balances', { id: 'inventory_shortages', label: 'Short for sales orders', count: all.inventory_balances.filter(row => row.shortage !== null && row.shortage > 0).length, path: '/app/inventory?risk=high', action: 'Review inventory' }),
      ...card('sales_orders', { id: 'unfulfilled_sales', label: 'Unfulfilled sales orders', count: sales.filter(row => active(row) && row.status !== 'draft' && unfulfilled(row)).length, path: '/app/sales/orders', action: 'Review orders' }),
    ],
  };
}

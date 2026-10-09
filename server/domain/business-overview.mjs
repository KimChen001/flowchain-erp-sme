import { isCommittedPurchaseOrder } from './open-purchase-order.mjs';

// What a status chart or detail table of purchase orders covers.
export const ALL_PURCHASE_ORDERS = 'All purchase orders in range, every status.';

// Aggregate the loaded, permission-scoped records before applying the detail limit.
// Each chart says which purchase orders it covers: the supplier chart counts
// committed orders, like the committed PO amount next to it; the activity and
// status charts cover every status, drafts and cancellations included.
// salesDemand holds the open demand of each sales order line in scope
// ({ orderId, open }); an order is unfulfilled while any of its lines has
// demand left, so lines in different units are never added to decide it.
// reorder is the reorder list's summary ({ orderNow }), read as the reorder
// list and Today read it, so the three show the same count; without it (no
// database, a reader of only some warehouses) the card is left out.
export function buildBusinessOverview(all, { salesDemand = null, reorder = null } = {}) {
  const purchases = all.purchase_orders;
  const sales = all.sales_orders;
  const active = row => !['closed', 'cancelled', 'canceled', 'completed', 'fully_received', 'rejected'].includes(row.status);
  const ordersWithDemand = salesDemand ? new Set(salesDemand.filter(line => line.open > 0).map(line => line.orderId)) : null;
  const unfulfilled = row => ordersWithDemand ? ordersWithDemand.has(row.id) : row.quantity > row.fulfilled;
  const months = new Map();
  for (const [rows, key] of [[purchases, 'Purchase orders'], [sales, 'Sales orders']]) {
    for (const row of rows) {
      const month = /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date.slice(0, 7) : 'Undated';
      if (!months.has(month)) months.set(month, { name: month, 'Purchase orders': 0, 'Sales orders': 0 });
      months.get(month)[key] += 1;
    }
  }
  const groups = (rows, field) => {
    const counts = new Map();
    for (const row of rows) { const key = row[field] || 'Unspecified'; counts.set(key, (counts.get(key) || 0) + 1); }
    return [...counts].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  };
  const common = { unit: 'number', valueFormat: 'number', categoryKey: 'name', valueKey: 'value', tooltip: true, legend: true, emptyState: 'No records in the selected range.' };
  return {
    charts: [
      { ...common, id: 'overview_activity', title: 'Record activity by month', type: 'bar', data: [...months.values()].sort((a, b) => a.name.localeCompare(b.name)), seriesKeys: ['Purchase orders', 'Sales orders'], colors: ['#2563eb', '#14b8a6'], drilldownPath: '/app/reports/procurement', crossFilter: 'period', description: 'Purchase and sales orders in range by order date, every status, drafts included.' },
      { ...common, id: 'overview_status', title: 'Purchase order status', type: 'donut', data: groups(purchases, 'status'), drilldownPath: '/app/reports/procurement', crossFilter: 'status', description: ALL_PURCHASE_ORDERS },
      { ...common, id: 'overview_suppliers', title: 'Committed purchase orders by supplier', type: 'horizontal_bar', data: groups(purchases.filter(isCommittedPurchaseOrder), 'supplier').slice(0, 8), drilldownPath: '/app/reports/procurement', crossFilter: 'supplier', description: 'Committed purchase orders in range (approved, issued or received), counted per supplier.' },
    ],
    attention: [
      // isOpen is set once per purchase order by the report read model from the
      // full record, using the shared definition, so this card and the open
      // purchase orders report it links to always count the same orders.
      { id: 'open_orders', label: 'Open purchase orders', count: purchases.filter(row => row.isOpen).length, path: '/app/reports/procurement?status=open', action: 'Review orders' },
      ...(Number.isInteger(reorder?.orderNow) ? [{ id: 'items_to_reorder', label: 'Items to reorder', count: reorder.orderNow, path: '/app/inventory/reorder', action: 'Open reorder list' }] : []),
      // Short against open sales orders, as the "SKUs short for sales orders"
      // KPI counts; an item below its reorder point is in the card above.
      { id: 'inventory_shortages', label: 'Short for sales orders', count: all.inventory_balances.filter(row => row.shortage !== null && row.shortage > 0).length, path: '/app/inventory?risk=high', action: 'Review inventory' },
      { id: 'unfulfilled_sales', label: 'Unfulfilled sales orders', count: sales.filter(row => active(row) && row.status !== 'draft' && unfulfilled(row)).length, path: '/app/sales/orders', action: 'Review orders' },
    ],
  };
}

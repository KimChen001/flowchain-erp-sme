// Aggregate the loaded, permission-scoped records before applying the detail limit.
export function buildBusinessOverview(all) {
  const purchases = all.purchase_orders;
  const sales = all.sales_orders;
  const active = row => !['closed', 'cancelled', 'completed'].includes(row.status);
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
      { ...common, id: 'overview_activity', title: 'Record activity by month', type: 'bar', data: [...months.values()].sort((a, b) => a.name.localeCompare(b.name)), seriesKeys: ['Purchase orders', 'Sales orders'], colors: ['#2563eb', '#14b8a6'], drilldownPath: '/app/reports/procurement', crossFilter: 'period' },
      { ...common, id: 'overview_status', title: 'Purchase order status', type: 'donut', data: groups(purchases, 'status'), drilldownPath: '/app/reports/procurement', crossFilter: 'status' },
      { ...common, id: 'overview_suppliers', title: 'Purchasing by supplier', type: 'horizontal_bar', data: groups(purchases, 'supplier').slice(0, 8), drilldownPath: '/app/reports/procurement', crossFilter: 'supplier' },
    ],
    attention: [
      { id: 'open_orders', label: 'Open purchase orders', count: purchases.filter(active).length, path: '/app/reports/procurement?status=open', action: 'Review orders' },
      { id: 'inventory_shortages', label: 'Inventory shortages', count: all.inventory_balances.filter(row => row.shortage !== null && row.shortage > 0).length, path: '/app/inventory?risk=high', action: 'Review inventory' },
      { id: 'unfulfilled_sales', label: 'Unfulfilled sales orders', count: sales.filter(row => active(row) && row.quantity > row.fulfilled).length, path: '/app/sales/orders', action: 'Review orders' },
    ],
  };
}

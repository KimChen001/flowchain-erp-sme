import { getPrismaClient, disconnectPrismaClient } from '../server/persistence/prisma-client.mjs';
import { assertLocalDevelopment } from '../server/domain/local-development-contract.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const marker = { localDemo: true, reportingDemoVersion: 1, description: 'Fictional US reporting demonstration data.' };
const day = (value, offset = 0) => new Date(value.getTime() + offset * 86400000);
const suffix = value => String(value).padStart(3, '0');
const extraItems = [
  ['Pressure Transmitter', 'Electronic components', 'pcs', 5, 85],
  ['Protective Foam Insert', 'Packaging materials', 'pcs', 6, 3],
  ['Hex Bolt Kit', 'Industrial supplies', 'box', 7, 24],
  ['Shielded Signal Wire', 'Electronic components', 'ft', 9, 2],
  ['Thermal Shipping Label', 'Packaging materials', 'roll', 10, 18],
  ['Safety Glove Pack', 'Industrial supplies', 'box', 3, 32],
];

// Use stable identifiers and preserve every existing row, including edited demo rows.
export async function seedReportingDemo(prisma, env = process.env, anchor = new Date()) {
  assertLocalDevelopment(env, 'pilot:setup:reports');
  const tenantId = env.FLOWCHAIN_DEFAULT_TENANT_ID;
  if (!tenantId) throw new Error('An explicit local demo workspace is required.');
  if (!Number.isFinite(anchor.getTime())) throw new Error('A valid demo date is required.');
  const today = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate(), 12));
  return prisma.$transaction(async tx => {
    await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const added = {};
    async function insert(model, data) {
      const existing = await tx[model].findUnique({ where: { id: data.id } });
      if (existing) {
        if (existing.tenantId !== tenantId || !existing.metadata?.reportingDemoVersion) throw new Error(`Refusing to overwrite ${model} ${data.id}.`);
        return false;
      }
      await tx[model].create({ data: { ...data, tenantId } });
      added[model] = (added[model] || 0) + 1;
      return true;
    }
    const suppliers = await tx.supplier.findMany({ where: { tenantId, code: { in: Array.from({ length: 10 }, (_, i) => `LDS-${suffix(i + 1)}`) } } });
    const supplier = n => {
      const result = suppliers.find(row => row.code === `LDS-${suffix(n)}`);
      if (!result) throw new Error('Load the ten-supplier local demo first.');
      return result;
    };
    const warehouse = await tx.warehouse.findFirst({ where: { id: 'LOCAL-DEMO-WH-001', tenantId } });
    if (!warehouse) throw new Error('Load the local demo warehouse first.');
    const baseItems = await tx.item.findMany({ where: { tenantId, sku: { in: Array.from({ length: 6 }, (_, i) => `LDM-${suffix(i + 1)}`) } }, orderBy: { sku: 'asc' } });
    if (baseItems.length !== 6) throw new Error('Load the six base demo items first.');
    const items = baseItems.map((row, i) => ({ ...row, supplierNumber: [1, 1, 2, 3, 1, 2][i], price: [100, 65, 8, 12, 4, 22][i] }));
    for (const [index, [name, category, unit, supplierNumber, price]] of extraItems.entries()) {
      const item = { id: `DEMO-RPT-ITEM-${suffix(index + 7)}`, sku: `LDM-${suffix(index + 7)}`, name, category, unit, preferredSupplierId: supplier(supplierNumber).id, safetyStock: 20, reorderPoint: 40, metadata: marker };
      await insert('item', item);
      const stored = await tx.item.findUniqueOrThrow({ where: { id: item.id } });
      items.push({ ...stored, supplierNumber, price });
    }
    // Opening snapshots are independent of the unposted receiving documents below.
    // They do not imply posted stock movements, reservations, shipments, or payments.
    const stocks = [8, 60, 340, 18, 950, 110, 5, 480, 42, 1200, 9, 160];
    for (const [index, item] of items.entries()) {
      const existing = await tx.inventoryBalance.findFirst({ where: { tenantId, sku: item.sku, warehouseKey: warehouse.id, locationKey: 'a-01' } });
      if (existing) continue;
      await insert('inventoryBalance', { id: `DEMO-RPT-BAL-${suffix(index + 1)}`, itemId: item.id, sku: item.sku, itemName: item.name, warehouseId: warehouse.id, warehouseKey: warehouse.id, location: 'A-01', locationKey: 'a-01', onHandQuantity: stocks[index], availableQuantity: stocks[index], reservedQuantity: 0, safetyStock: item.safetyStock, reorderPoint: item.reorderPoint, unit: item.unit, status: 'active', riskLevel: stocks[index] < Number(item.safetyStock) ? 'shortage' : 'normal', metadata: { ...marker, source: 'demo_opening_snapshot' } });
    }
    const activityDate = (month, index) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 5 + month, Math.min(2 + index, month === 5 ? Math.max(1, today.getUTCDate() - 2) : 25), 12));
    const states = ['fully_received', 'partially_received', 'issued', 'pending_approval', 'draft', 'fully_received', 'cancelled'];
    let poIndex = 0;
    for (const [month, count] of [2, 3, 4, 5, 6, 8].entries()) {
      for (let j = 0; j < count; j++) {
        const n = ++poIndex;
        const item = items[(n - 1) % items.length];
        const vendor = supplier(item.supplierNumber);
        const createdAt = activityDate(month, j);
        const status = states[(n - 1) % states.length];
        const orderedQuantity = [40, 75, 120, 200, 350][n % 5];
        const receivedQuantity = status === 'fully_received' ? orderedQuantity : status === 'partially_received' ? Math.floor(orderedQuantity * 0.4) : 0;
        const unitPrice = item.price;
        const amount = orderedQuantity * unitPrice;
        const expectedDate = ['issued', 'partially_received'].includes(status) ? day(today, n % 2 ? -(n % 9 + 2) : n % 12 + 3) : day(createdAt, 14);
        const id = `DEMO-RPT-PO-${suffix(n)}`;
        const lineId = `${id}-L1`;
        const lineMeta = { ...marker, targetWarehouseId: warehouse.id, promisedDate: expectedDate.toISOString().slice(0, 10), requestedDate: expectedDate.toISOString().slice(0, 10) };
        const created = await insert('purchaseOrder', { id, supplierId: vendor.id, supplierName: vendor.name, status, expectedDate, amount, currency: 'USD', owner: ['Kim', 'Alex Morgan', 'Jordan Lee'][n % 3], priority: n % 4 === 0 ? 'high' : 'medium', metadata: { ...marker, targetWarehouseId: warehouse.id, transmissionStatus: ['issued', 'partially_received', 'fully_received'].includes(status) ? 'sent' : 'not_sent' }, createdAt, updatedAt: createdAt, lines: { create: [{ id: lineId, itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity, receivedQuantity, unit: item.unit, unitPrice, amount, metadata: lineMeta }] } });
        if (!created || !receivedQuantity) continue;
        const receivedAt = new Date(Math.min(day(createdAt, 1).getTime(), today.getTime()));
        const grnId = `DEMO-RPT-GRN-${suffix(n)}`;
        await insert('receivingDocument', { id: grnId, documentNumber: grnId, poId: id, supplierId: vendor.id, supplierName: vendor.name, status: receivedQuantity === orderedQuantity ? 'received' : 'partial', workflowStatus: 'received', postingStatus: 'unposted', warehouseId: warehouse.id, receiver: 'Demo Receiving Team', currency: 'USD', arrivedAt: receivedAt, createdAt: receivedAt, updatedAt: receivedAt, metadata: { ...marker, note: 'Receipt recorded; inventory posting is pending.' }, lines: { create: [{ id: `${grnId}-L1`, purchaseOrderLineId: lineId, itemId: item.id, sku: item.sku, itemName: item.name, acceptedQty: receivedQuantity, rejectedQty: 0, unit: item.unit, warehouseId: warehouse.id, location: 'A-01', locationKey: 'a-01', metadata: marker }] } });
        const invoiceId = `DEMO-RPT-INV-${suffix(n)}`;
        const invoicePrice = n % 3 === 0 ? Math.round(unitPrice * 1.08 * 100) / 100 : unitPrice;
        const subtotal = Math.round(receivedQuantity * invoicePrice * 100) / 100;
        await insert('supplierInvoice', { id: invoiceId, invoiceNumber: invoiceId, supplierId: vendor.id, supplierName: vendor.name, relatedPoId: id, relatedGrnId: grnId, invoiceDate: receivedAt, dueDate: day(receivedAt, 30), subtotalAmount: subtotal, enteredTaxAmount: 0, totalAmount: subtotal, amount: subtotal, currency: 'USD', status: 'draft', matchStatus: 'pending', createdAt: receivedAt, updatedAt: receivedAt, metadata: { ...marker, note: invoicePrice !== unitPrice ? 'Demo price discrepancy for three-way review.' : 'Demo invoice awaiting three-way review.' }, lines: { create: [{ id: `${invoiceId}-L1`, lineNumber: 1, purchaseOrderLineId: lineId, receivingLineId: `${grnId}-L1`, itemId: item.id, sku: item.sku, itemName: item.name, quantity: receivedQuantity, unit: item.unit, unitPrice: invoicePrice, lineAmount: subtotal, enteredTaxAmount: 0, amount: subtotal, metadata: marker }] } });
      }
    }
    const customers = await tx.runtimeRecord.findMany({ where: { tenantId, namespace: 'master-data.customers', recordKey: { in: ['LDC-001', 'LDC-002', 'LDC-003'] } }, orderBy: { recordKey: 'asc' } });
    if (customers.length !== 3) throw new Error('Load the three demo customers first.');
    let salesIndex = 0;
    for (const [month, count] of [1, 2, 2, 3, 4, 6].entries()) {
      for (let j = 0; j < count; j++) {
        const n = ++salesIndex;
        const item = items[(n * 5) % items.length];
        const customer = customers[n % customers.length].payload;
        const createdAt = activityDate(month, j);
        const id = `DEMO-RPT-SO-${suffix(n)}`;
        const quantity = [12, 25, 45, 80, 150][n % 5];
        const price = Math.round(item.price * 1.6 * 100) / 100;
        await insert('salesOrder', { id, orderNumber: id, customerId: customer.id, customerName: customer.name, workflowStatus: n % 7 === 0 ? 'cancelled' : n % 5 === 0 ? 'draft' : 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', promisedDate: day(today, n % 4 === 0 ? -3 : n % 14 + 2), currency: 'USD', createdAt, updatedAt: createdAt, metadata: marker, lines: { create: [{ id: `${id}-L1`, itemId: item.id, sku: item.sku, itemName: item.name, orderedQuantity: quantity, unit: item.unit, unitPrice: price, amount: Math.round(quantity * price * 100) / 100, metadata: marker }] } });
      }
    }
    return { added, anchorDate: today.toISOString().slice(0, 10), note: 'Opening inventory snapshots; receipts unposted; invoices unapproved; sales unreserved.' };
  }, { timeout: 60000 });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  assertLocalDevelopment(process.env, 'pilot:setup:reports');
  const prisma = await getPrismaClient(process.env);
  try { console.log(JSON.stringify(await seedReportingDemo(prisma), null, 2)); }
  finally { await disconnectPrismaClient(); }
}

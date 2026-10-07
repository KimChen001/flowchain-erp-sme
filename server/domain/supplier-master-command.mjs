import { randomUUID } from 'node:crypto';
import { SUPPLIER_SENSITIVE_FIELDS, isMaskedValue } from './master-data-read-access.mjs';
const fields = ['shortName', 'businessType', 'contactName', 'telephone', 'email', 'address', 'postalCode', 'defaultCurrency', 'paymentTermsId', 'settlementMethod', 'creditCode', 'taxIdentificationNumber', 'bankName', 'bankAccountName', 'bankAccountNumber', 'internalComment'];
const fail = (status, code, message, details = []) => Object.assign(new Error(message), { status, code, details });
const currencies = new Set(Intl.supportedValuesOf('currency'));

// The field checks of a supplier write that need no database, in the order
// the form shows them, and the merged metadata they were run on. The empty
// default currency is filled in by saveSupplierMaster from the workspace, so
// the currency is checked there (supplierCurrencyIssue).
export function supplierInputIssues(input = {}, old = null) {
  const meta = old?.metadata && typeof old.metadata === 'object' ? old.metadata : {};
  const code = String(input.supplierCode ?? old?.code ?? '').trim();
  const name = String(input.supplierName ?? old?.name ?? '').trim();
  const status = input.status ?? old?.status ?? 'active';
  const next = { ...meta };
  for (const key of fields) if (Object.hasOwn(input, key)) next[key] = String(input[key] ?? '').trim();
  // A masked value ("****1234") is what a reader without
  // finance.partner_snapshot.read was shown; saving it keeps the stored value.
  for (const key of SUPPLIER_SENSITIVE_FIELDS) if (isMaskedValue(next[key])) next[key] = meta[key] || '';
  if (Object.hasOwn(input, 'categories')) next.categories = Array.isArray(input.categories) ? [...new Set(input.categories.map(value => String(value).trim()).filter(Boolean))] : [];
  if (Object.hasOwn(input, 'deliveryCycleDays')) next.deliveryCycleDays = Number(input.deliveryCycleDays);
  const issues = [];
  const issue = (field, issueCode, message) => issues.push({ field, code: issueCode, message });
  if (!code) issue('supplierCode', 'CODE_REQUIRED', 'Enter a supplier code.');
  if (!name) issue('supplierName', 'NAME_REQUIRED', 'Enter a supplier name.');
  if (!['active', 'inactive', 'draft'].includes(status)) issue('status', 'STATUS_INVALID', 'Choose a valid status.');
  if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) issue('email', 'EMAIL_INVALID', 'Enter a valid email address.');
  if (next.deliveryCycleDays != null && (!Number.isInteger(next.deliveryCycleDays) || next.deliveryCycleDays < 0)) issue('deliveryCycleDays', 'WHOLE_NUMBER_REQUIRED', 'Lead time must be a whole number of days, zero or greater.');
  return { issues, values: { code, name, status, metadata: next } };
}

export function supplierCurrencyIssue(currency) {
  return currencies.has(currency) ? null : { field: 'defaultCurrency', code: 'CURRENCY_INVALID', message: 'Choose a valid currency.' };
}

export async function saveSupplierMaster(prisma, id, input, actorId, scope) {
  if (!scope?.tenantId || !actorId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.');
  try {
    return await prisma.$transaction(async tx => {
      const old = id ? await tx.supplier.findFirst({ where: { id, tenantId: scope.tenantId } }) : null;
      if (id && !old) throw fail(404, 'NOT_FOUND', 'Supplier not found.');
      const meta = old?.metadata && typeof old.metadata === 'object' ? old.metadata : {};
      if (old && Number(input.expectedVersion) !== Number(meta.version || 1)) throw fail(409, 'VERSION_CONFLICT', 'This supplier changed. Reopen it and try again.');
      const { issues, values: { code, name, status, metadata: next } } = supplierInputIssues(input, old);
      if (!next.defaultCurrency) next.defaultCurrency = (await tx.tenant.findUnique({ where: { id: scope.tenantId } })).currency;
      const currencyIssue = supplierCurrencyIssue(next.defaultCurrency);
      if (currencyIssue) issues.push(currencyIssue);
      if (issues.length) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', issues);
      next.version = Number(meta.version || 0) + 1;
      if (old) next.version = Number(meta.version || 1) + 1;
      next.updatedBy = actorId;
      const data = { code, name, status, category: Array.isArray(next.categories) ? next.categories[0] || null : old?.category || null, metadata: next };
      const saved = old ? await tx.supplier.update({ where: { id: old.id }, data }) : await tx.supplier.create({ data: { ...data, id: `SUP-${randomUUID()}`, tenantId: scope.tenantId } });
      await tx.auditLog.create({ data: { id: randomUUID(), tenantId: scope.tenantId, source: 'supplier-master', module: 'srm', action: old ? 'update' : 'create', entityType: 'supplier', entityId: saved.id, actorId, summary: old ? 'Supplier profile updated' : 'Supplier profile created', metadata: { version: next.version } } });
      return saved;
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (error.code === 'P2002') throw fail(409, 'DUPLICATE_CODE', 'This supplier code is already in use.', [{ field: 'supplierCode', message: 'This supplier code is already in use.' }]);
    if (error.code === 'P2034') throw fail(409, 'VERSION_CONFLICT', 'This supplier changed. Reopen it and try again.');
    throw error;
  }
}

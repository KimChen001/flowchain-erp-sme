import { randomUUID } from 'node:crypto';
import { SUPPLIER_SENSITIVE_FIELDS, isMaskedValue } from './master-data-read-access.mjs';
const fields = ['shortName', 'businessType', 'contactName', 'telephone', 'email', 'address', 'postalCode', 'defaultCurrency', 'paymentTermsId', 'settlementMethod', 'creditCode', 'taxIdentificationNumber', 'bankName', 'bankAccountName', 'bankAccountNumber', 'internalComment'];
const fail = (status, code, message, details = []) => Object.assign(new Error(message), { status, code, details });
const currencies = new Set(Intl.supportedValuesOf('currency'));

// The field checks of a supplier write that need no database, in the order
// the form shows them, and the merged metadata they were run on. The empty
// default currency is filled in by saveSupplierMaster from the workspace, so
// the currency is checked there (supplierCurrencyIssue).
//
// The registration ID, tax ID, account holder and bank account number
// (SUPPLIER_SENSITIVE_FIELDS) are changed only by a writer who may read them
// (finance.partner_snapshot.read, passed as sensitiveFieldsWritable). Anyone
// else was shown "****1234" and cannot see what they would replace, so
// whatever they send for these fields is not saved: an existing supplier keeps
// its stored values and a new one gets none. The fields they sent are listed
// in restrictedFieldsKept for the audit row. A masked value from any writer
// also keeps the stored value.
// A supplier's bank details change only for a writer with
// master_data.supplier.bank.manage (bankFieldsWritable false refuses a
// change; a caller that does not say, the import of new suppliers, is not
// asked). Sending the stored or masked value is no change (design audit C4).
export const SUPPLIER_BANK_FIELDS = Object.freeze(['bankName', 'bankAccountName', 'bankAccountNumber']);

export function supplierInputIssues(input = {}, old = null, { sensitiveFieldsWritable = false, bankFieldsWritable } = {}) {
  const meta = old?.metadata && typeof old.metadata === 'object' ? old.metadata : {};
  // The code is the key imports match on, so like a SKU or a customer code
  // it cannot change once the supplier exists (design audit L4-17).
  const code = old ? String(old.code ?? '').trim() : String(input.supplierCode ?? '').trim();
  const codeChanged = Boolean(old) && Object.hasOwn(input, 'supplierCode') && String(input.supplierCode ?? '').trim() !== '' && String(input.supplierCode ?? '').trim() !== code;
  const name = String(input.supplierName ?? old?.name ?? '').trim();
  const status = input.status ?? old?.status ?? 'active';
  const next = { ...meta };
  for (const key of fields) if (Object.hasOwn(input, key)) next[key] = String(input[key] ?? '').trim();
  const restrictedFieldsKept = [];
  for (const key of SUPPLIER_SENSITIVE_FIELDS) {
    if (!Object.hasOwn(input, key) || (sensitiveFieldsWritable && !isMaskedValue(next[key]))) continue;
    if (!sensitiveFieldsWritable && !isMaskedValue(next[key]) && next[key] !== String(meta[key] ?? '')) restrictedFieldsKept.push(key);
    if (Object.hasOwn(meta, key)) next[key] = meta[key];
    else delete next[key];
  }
  // An empty payment term is not recorded: nothing is stored, and a legacy
  // "paymentTerms" value is replaced by the field the form sends.
  if (Object.hasOwn(input, 'paymentTermsId')) {
    delete next.paymentTerms;
    if (!next.paymentTermsId) delete next.paymentTermsId;
  }
  if (Object.hasOwn(input, 'categories')) next.categories = Array.isArray(input.categories) ? [...new Set(input.categories.map(value => String(value).trim()).filter(Boolean))] : [];
  if (Object.hasOwn(input, 'deliveryCycleDays')) next.deliveryCycleDays = Number(input.deliveryCycleDays);
  const issues = [];
  const issue = (field, issueCode, message) => issues.push({ field, code: issueCode, message });
  if (codeChanged) issue('supplierCode', 'CODE_LOCKED', 'The supplier code cannot be changed once the supplier exists.');
  if (bankFieldsWritable === false) {
    for (const key of SUPPLIER_BANK_FIELDS) {
      if (String(next[key] ?? '') !== String(meta[key] ?? '')) issue(key, 'BANK_DETAILS_PERMISSION_REQUIRED', "Changing a supplier's bank details needs the Manage supplier bank details permission.");
    }
  }
  if (!code) issue('supplierCode', 'CODE_REQUIRED', 'Enter a supplier code.');
  if (!name) issue('supplierName', 'NAME_REQUIRED', 'Enter a supplier name.');
  if (!['active', 'inactive', 'draft'].includes(status)) issue('status', 'STATUS_INVALID', 'Choose a valid status.');
  if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) issue('email', 'EMAIL_INVALID', 'Enter a valid email address.');
  if (next.deliveryCycleDays != null && (!Number.isInteger(next.deliveryCycleDays) || next.deliveryCycleDays < 0)) issue('deliveryCycleDays', 'WHOLE_NUMBER_REQUIRED', 'Lead time must be a whole number of days, zero or greater.');
  return { issues, values: { code, name, status, metadata: next }, restrictedFieldsKept };
}

export function supplierCurrencyIssue(currency) {
  return currencies.has(currency) ? null : { field: 'defaultCurrency', code: 'CURRENCY_INVALID', message: 'Choose a valid currency.' };
}

// scope.sensitiveFieldsWritable is true only when the writer may read the
// registration, tax and bank details (see supplierInputIssues); a caller
// that does not say so cannot change them.
export async function saveSupplierMaster(prisma, id, input, actorId, scope) {
  if (!scope?.tenantId || !actorId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.');
  try {
    return await prisma.$transaction(async tx => {
      const old = id ? await tx.supplier.findFirst({ where: { id, tenantId: scope.tenantId } }) : null;
      if (id && !old) throw fail(404, 'NOT_FOUND', 'Supplier not found.');
      const meta = old?.metadata && typeof old.metadata === 'object' ? old.metadata : {};
      if (old && Number(input.expectedVersion) !== Number(meta.version || 1)) throw fail(409, 'VERSION_CONFLICT', 'This supplier changed. Reopen it and try again.');
      const { issues, values: { code, name, status, metadata: next }, restrictedFieldsKept } = supplierInputIssues(input, old, { sensitiveFieldsWritable: scope.sensitiveFieldsWritable === true, bankFieldsWritable: scope.bankFieldsWritable });
      if (!next.defaultCurrency) next.defaultCurrency = (await tx.tenant.findUnique({ where: { id: scope.tenantId } })).currency;
      const currencyIssue = supplierCurrencyIssue(next.defaultCurrency);
      if (currencyIssue) issues.push(currencyIssue);
      // A newly chosen payment term must be one of the workspace's terms (by
      // code, or by id as the import stores it). An unchanged one is kept as is.
      if (next.paymentTermsId && next.paymentTermsId !== (meta.paymentTermsId || meta.paymentTerms)) {
        const term = await tx.paymentTerm.findFirst({ where: { tenantId: scope.tenantId, OR: [{ code: next.paymentTermsId }, { id: next.paymentTermsId }] }, select: { id: true } });
        if (!term) issues.push({ field: 'paymentTermsId', code: 'PAYMENT_TERM_NOT_FOUND', message: 'Choose one of the workspace payment terms.' });
      }
      if (issues.length) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', issues);
      next.version = Number(meta.version || 0) + 1;
      if (old) next.version = Number(meta.version || 1) + 1;
      next.updatedBy = actorId;
      const data = { code, name, status, category: Array.isArray(next.categories) ? next.categories[0] || null : old?.category || null, metadata: next };
      const saved = old ? await tx.supplier.update({ where: { id: old.id }, data }) : await tx.supplier.create({ data: { ...data, id: `SUP-${randomUUID()}`, tenantId: scope.tenantId } });
      await tx.auditLog.create({ data: { id: randomUUID(), tenantId: scope.tenantId, source: 'supplier-master', module: 'srm', action: old ? 'update' : 'create', entityType: 'supplier', entityId: saved.id, actorId, summary: old ? 'Supplier profile updated' : 'Supplier profile created', metadata: { version: next.version, ...(restrictedFieldsKept.length ? { restrictedFieldsKept } : {}) } } });
      return saved;
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (error.code === 'P2002') throw fail(409, 'DUPLICATE_CODE', 'This supplier code is already in use.', [{ field: 'supplierCode', message: 'This supplier code is already in use.' }]);
    if (error.code === 'P2034') throw fail(409, 'VERSION_CONFLICT', 'This supplier changed. Reopen it and try again.');
    throw error;
  }
}

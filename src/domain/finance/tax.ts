import type { ItemMaster, SupplierCreditMemo, SupplierInvoice, SupplierInvoiceLine, TaxCode } from "../../types/scm";

type TaxFacts = { items?: ItemMaster[]; taxCodes?: TaxCode[] };

export function formatTaxRate(rate: number) {
  return `${Number((rate * 100).toFixed(2))}%`;
}

export function taxCodeForSku(sku: string, fallbackRate = 0, facts: TaxFacts = {}) {
  const items = facts.items || [];
  const taxCodes = facts.taxCodes || [];
  const item = items.find((entry) => entry.sku === sku);
  return taxCodes.find((entry) => entry.code === item?.defaultTaxCode)
    || taxCodes.find((entry) => Math.abs(entry.rate - fallbackRate) < 0.0001)
    || { code: "", name: "", rate: fallbackRate };
}

export function calculateLineTax(line: SupplierInvoiceLine, facts: TaxFacts = {}) {
  const taxCode = taxCodeForSku(line.sku, Number(line.taxRate || 0), facts);
  const netAmount = Number(line.lineSubtotal || 0);
  const taxAmount = Number(line.taxAmount || netAmount * taxCode.rate);
  const grossAmount = Number(line.lineTotal || netAmount + taxAmount);
  return {
    taxCode: taxCode.code,
    taxName: taxCode.name,
    taxRate: Number(line.taxRate ?? taxCode.rate),
    netAmount,
    taxAmount,
    grossAmount,
  };
}

export function calculateInvoiceTaxSummary(invoice: SupplierInvoice, facts: TaxFacts = {}) {
  const lineSummaries = invoice.lines.map((line) => calculateLineTax(line, facts));
  const netAmount = Number(invoice.subtotal || lineSummaries.reduce((sum, line) => sum + line.netAmount, 0));
  const taxAmount = Number(invoice.tax || lineSummaries.reduce((sum, line) => sum + line.taxAmount, 0));
  const freightAmount = Number(invoice.freight || 0);
  const grossAmount = Number(invoice.total || netAmount + taxAmount + freightAmount);
  const taxCodes = Array.from(new Set(lineSummaries.map((line) => line.taxCode)));
  const taxRates = Array.from(new Set(lineSummaries.map((line) => formatTaxRate(line.taxRate))));
  return {
    netAmount,
    taxAmount,
    freightAmount,
    grossAmount,
    taxCodes,
    taxRates,
    lineSummaries,
  };
}

export function getTaxVarianceSummary(invoice: SupplierInvoice, facts: TaxFacts = {}) {
  const summary = calculateInvoiceTaxSummary(invoice, facts);
  const expectedTax = summary.lineSummaries.reduce((sum, line) => sum + line.netAmount * line.taxRate, 0);
  const delta = Number((summary.taxAmount - expectedTax).toFixed(2));
  if (Math.abs(delta) <= Math.max(1, Math.abs(summary.taxAmount) * 0.01)) return "税额与税码/税率拆分在容差内。";
  return `税额与税码/税率拆分存在 ${delta.toLocaleString("zh-CN")} 差异，需采购与 AP 复核。`;
}

function dominantInvoiceTaxRate(invoice?: SupplierInvoice, facts: TaxFacts = {}) {
  if (!invoice) return undefined;
  const totalsByRate = new Map<number, number>();
  invoice.lines.forEach((line) => {
    const rate = Number(line.taxRate ?? taxCodeForSku(line.sku, 0, facts).rate);
    const amount = Number(line.lineSubtotal || 0);
    totalsByRate.set(rate, (totalsByRate.get(rate) || 0) + amount);
  });
  return Array.from(totalsByRate.entries())
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
}

export function creditMemoTaxSummary(
  memo: SupplierCreditMemo,
  invoices: SupplierInvoice[],
  facts: TaxFacts = {},
) {
  const linkedInvoice = memo.relatedInvoice
    ? invoices.find((invoice) => invoice.invoiceNumber === memo.relatedInvoice || invoice.id === memo.relatedInvoice)
    : undefined;
  const rate = dominantInvoiceTaxRate(linkedInvoice, facts)
    ?? (linkedInvoice?.lines[0] ? taxCodeForSku(linkedInvoice.lines[0].sku, 0, facts).rate : undefined)
    ?? facts.taxCodes?.find((entry) => entry.isDefault)?.rate
    ?? 0;
  const grossAmount = Number(memo.totalCredit || 0);
  const netAmount = Number((grossAmount / (1 + rate)).toFixed(2));
  const taxAmount = Number((grossAmount - netAmount).toFixed(2));
  const taxCode = facts.taxCodes?.find((entry) => Math.abs(entry.rate - rate) < 0.0001)
    || { code: "", rate };
  return {
    taxCode: taxCode.code,
    taxRate: rate,
    netAmount,
    taxAmount,
    grossAmount,
  };
}

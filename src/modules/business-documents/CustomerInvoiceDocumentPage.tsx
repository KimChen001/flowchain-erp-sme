import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import type { CustomerInvoiceDocument, DocumentLanguage } from "../../../shared/business-documents.mjs";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { documentCopy } from "./documentCopy";
import { formatAmount, formatCalendarDay, formatDecimal } from "./documentFormat";
import { DocumentShell, type DocumentBlock } from "./DocumentShell";

type ReadState = "loading" | "loaded" | "notFound" | "forbidden" | "error";

const dash = (value: string | null | undefined) => (value === null || value === undefined || value === "" ? "—" : value);

// The customer invoice as the document a person prints or saves as PDF and
// sends to the customer. Everything on it is what the invoice, its receivable
// and the customer master record: a header field nobody recorded (letterhead,
// customer contact, payment terms) is left off, and a missing value in the
// line table prints "—". Calendar days (invoice and due date) print as the
// day recorded, read in UTC, in any browser time zone. FlowChain
// prepares it and stops there: issuing the invoice stays a step on the
// invoice page.
function CustomerInvoiceSheet({ doc, language }: { doc: CustomerInvoiceDocument; language: DocumentLanguage }) {
  const { locale } = useI18n();
  const c = documentCopy(language);
  const { seller, billTo, columns, paymentSummary } = doc;
  const amount = (value: string | null) => formatAmount(value, doc.currency, locale);
  const billToLines = [
    billTo.code && `${c("customerCode")}: ${billTo.code}`,
    billTo.contactName && `${c("contact")}: ${billTo.contactName}`,
    billTo.telephone && `${c("phone")}: ${billTo.telephone}`,
    billTo.email && `${c("email")}: ${billTo.email}`,
    billTo.address,
  ].filter(Boolean) as string[];
  const sellerContact = [seller.phone && `${c("phone")}: ${seller.phone}`, seller.email && `${c("email")}: ${seller.email}`, seller.taxId && `${c("taxId")}: ${seller.taxId}`].filter(Boolean) as string[];
  return (
    <>
      <header className="business-document-head">
        <div className="business-document-letterhead" data-testid="invoice-document-letterhead">
          {seller.companyName && <strong>{seller.companyName}</strong>}
          {seller.addressLines.map((line, index) => <div key={index}>{line}</div>)}
          {sellerContact.map((line) => <div key={line}>{line}</div>)}
        </div>
        <div className="business-document-meta">
          <h1 data-testid="invoice-document-title">{doc.title || c("invoice")}</h1>
          <dl>
            <dt>{c("invoiceNumber")}</dt><dd data-testid="invoice-document-number">{dash(doc.number)}</dd>
            <dt>{c("invoiceDate")}</dt><dd data-testid="invoice-document-date">{formatCalendarDay(doc.invoiceDate, locale)}</dd>
            <dt>{c("dueDate")}</dt><dd data-testid="invoice-document-due-date">{formatCalendarDay(doc.dueDate, locale)}</dd>
            {doc.salesOrderNumber && <><dt>{c("salesOrder")}</dt><dd data-testid="invoice-document-sales-order">{doc.salesOrderNumber}</dd></>}
            {doc.shipmentNumber && <><dt>{c("shipment")}</dt><dd data-testid="invoice-document-shipment">{doc.shipmentNumber}</dd></>}
            <dt>{c("currency")}</dt><dd data-testid="invoice-document-currency">{dash(doc.currency)}</dd>
          </dl>
        </div>
      </header>
      <section className="business-document-parties">
        <div data-testid="invoice-document-bill-to">
          <h2>{c("billTo")}</h2>
          {billTo.name && <p><strong>{billTo.name}</strong></p>}
          {billToLines.map((line) => <p key={line}>{line}</p>)}
        </div>
        {/* The terms recorded on the customer, never a default; left off when none were recorded. */}
        {doc.paymentTerms && (
          <div data-testid="invoice-document-payment-terms">
            <h2>{c("paymentTerms")}</h2>
            <p>{doc.paymentTerms}</p>
          </div>
        )}
      </section>
      <table className="business-document-lines" data-testid="invoice-document-lines">
        <thead>
          <tr>
            <th>{c("lineNo")}</th>
            <th>{c("sku")}</th>
            <th>{c("description")}</th>
            <th className="is-number">{c("quantity")}</th>
            <th>{c("unit")}</th>
            <th className="is-number">{c("unitPrice")}</th>
            <th className="is-number">{c("amount")}</th>
            {columns.tax && <th className="is-number">{c("tax")}</th>}
            {columns.tax && <th className="is-number">{c("lineTotal")}</th>}
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((line) => (
            <tr key={line.lineNo} data-testid={`invoice-document-line-${line.lineNo}`}>
              <td>{line.lineNo}</td>
              <td data-testid="invoice-document-line-sku">{dash(line.sku)}</td>
              <td>{dash(line.description)}</td>
              <td className="is-number" data-testid="invoice-document-line-quantity">{formatDecimal(line.quantity, locale)}</td>
              <td>{dash(line.unit)}</td>
              <td className="is-number" data-testid="invoice-document-line-unit-price">{amount(line.unitPrice)}</td>
              <td className="is-number" data-testid="invoice-document-line-amount">{amount(line.amount)}</td>
              {columns.tax && <td className="is-number" data-testid="invoice-document-line-tax">{amount(line.tax)}</td>}
              {columns.tax && <td className="is-number" data-testid="invoice-document-line-total">{amount(line.total)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {/* The amounts recorded on the invoice, in its one currency; quantities are never added up. */}
      <div className="business-document-totals">
        <dl data-testid="invoice-document-totals">
          {doc.totals.map((total) => (
            <div key={total.currency || "none"} className="contents">
              <dt>{c("subtotal")}</dt>
              <dd data-testid="invoice-document-subtotal">{formatAmount(total.subtotal, total.currency, locale)}</dd>
              <dt>{c("tax")}</dt>
              <dd data-testid="invoice-document-tax">{formatAmount(total.tax, total.currency, locale)}</dd>
              <dt>{c("total", { currency: dash(total.currency) })}</dt>
              <dd data-testid="invoice-document-total">{formatAmount(total.total, total.currency, locale)}</dd>
            </div>
          ))}
        </dl>
      </div>
      {/* What the customer has paid, in the invoice's own currency only. */}
      {paymentSummary && (
        <div className="business-document-totals">
          <dl data-testid="invoice-document-payment-summary">
            <dt>{c("amountPaid")}</dt>
            <dd data-testid="invoice-document-amount-paid">{formatAmount(paymentSummary.amountPaid, paymentSummary.currency, locale)}</dd>
            <dt>{c("creditsApplied")}</dt>
            <dd data-testid="invoice-document-credits-applied">{formatAmount(paymentSummary.creditsApplied, paymentSummary.currency, locale)}</dd>
            <dt>{c("balanceDue")}</dt>
            <dd data-testid="invoice-document-balance-due">{formatAmount(paymentSummary.balanceDue, paymentSummary.currency, locale)}</dd>
          </dl>
        </div>
      )}
      {doc.paymentInstructions && (
        <section className="business-document-terms" data-testid="invoice-document-payment-instructions">
          <h2>{c("paymentInstructions")}</h2>
          {doc.paymentInstructions}
        </section>
      )}
      {doc.termsText && (
        <section className="business-document-terms" data-testid="invoice-document-terms">
          <h2>{c("terms")}</h2>
          {doc.termsText}
        </section>
      )}
      {doc.footerText && <footer className="business-document-footer" data-testid="invoice-document-footer">{doc.footerText}</footer>}
    </>
  );
}

function failureState(error: unknown): Exclude<ReadState, "loading" | "loaded"> {
  if (error instanceof ApiError && error.status === 404) return "notFound";
  if (error instanceof ApiError && error.status === 403) return "forbidden";
  return "error";
}

// Why the invoice cannot be printed: not issued yet (shown to be checked,
// "do not send"), not a document yet (only the notice), or hidden amounts or
// customer.
function blockFor(doc: CustomerInvoiceDocument): DocumentBlock {
  if (doc.printable.ok) return null;
  if (doc.printable.reason === "not_issued") return "not_issued";
  if (doc.printable.reason === "amounts_hidden") return "amounts_hidden";
  return "invoice_status";
}

export function CustomerInvoiceDocumentPage({ invoiceId }: { invoiceId: string }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<CustomerInvoiceDocument | null>(null);
  const [state, setState] = useState<ReadState>("loading");
  // The document language for this print only; it starts at the workspace default and is never saved.
  const [language, setLanguage] = useState<DocumentLanguage>("en-US");

  const load = useCallback(async () => {
    setState("loading");
    setDoc(null);
    if (!invoiceId.trim()) { setState("notFound"); return; }
    try {
      const result = await apiJson<{ document: CustomerInvoiceDocument }>(`/api/finance/customer-invoices/${encodeURIComponent(invoiceId)}/document`);
      setDoc(result.document);
      setLanguage(result.document.documentLanguage === "zh-CN" ? "zh-CN" : "en-US");
      setState("loaded");
    } catch (error) {
      setState(failureState(error));
    }
  }, [invoiceId]);
  useEffect(() => { void load(); }, [load]);

  const backTo = invoiceId ? `/app/sales/invoices/${encodeURIComponent(invoiceId)}` : "/app/sales/invoices";
  if (state === "loaded" && doc) {
    const blocked = blockFor(doc);
    return (
      <DocumentShell backTo={backTo} backLabel={t("documents.invoiceBack")} blocked={blocked} language={language} onLanguageChange={setLanguage} showSheet={blocked !== "invoice_status"}>
        <CustomerInvoiceSheet doc={doc} language={language} />
      </DocumentShell>
    );
  }
  const message = { notFound: t("documents.invoiceNotFound"), forbidden: t("documents.invoiceForbidden"), error: t("documents.invoiceLoadFailed") };
  return (
    <div className="space-y-4" data-testid="invoice-document-state">
      <Card className="p-8 text-center">
        {state === "loading"
          ? <div className="text-sm" style={{ color: A.sub }}>{t("documents.invoiceLoading")}</div>
          : <>
              <TriangleAlert className="mx-auto text-amber-600" size={30} />
              <div className="mt-3 text-sm font-semibold" data-testid="invoice-document-unavailable">{message[state as keyof typeof message]}</div>
              {state === "error" && <button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold" style={{ color: A.blue }}><RefreshCw size={15} />{t("documents.retry")}</button>}
            </>}
      </Card>
      <Link to={backTo} className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: A.blue }}><ArrowLeft size={16} />{t("documents.invoiceBack")}</Link>
    </div>
  );
}

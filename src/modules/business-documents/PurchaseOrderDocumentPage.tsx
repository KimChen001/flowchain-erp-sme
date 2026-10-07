import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import type { DocumentLanguage, PurchaseOrderDocument } from "../../../shared/business-documents.mjs";
import { A, Card } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { documentCopy } from "./documentCopy";
import { formatAmount, formatCalendarDay, formatDecimal, formatInstantDay } from "./documentFormat";
import { DocumentShell } from "./DocumentShell";

type ReadState = "loading" | "loaded" | "notFound" | "forbidden" | "error";

const dash = (value: string | null | undefined) => (value === null || value === undefined || value === "" ? "—" : value);

// The purchase order as the document a person prints or saves as PDF and
// sends to the supplier. Everything on it is what the PO and master data
// record; a missing value prints "—". FlowChain prepares it and stops there:
// marking the PO issued stays a separate step on the PO page.
function PurchaseOrderSheet({ doc, language }: { doc: PurchaseOrderDocument; language: DocumentLanguage }) {
  const { locale, timezone } = useI18n();
  const c = documentCopy(language);
  const { buyer, supplier, columns } = doc;
  const amount = (value: string | null) => formatAmount(value, doc.currency, locale);
  const supplierLines = [
    supplier.code && `${c("supplierCode")}: ${supplier.code}`,
    supplier.contactName && `${c("contact")}: ${supplier.contactName}`,
    supplier.telephone && `${c("phone")}: ${supplier.telephone}`,
    supplier.email && `${c("email")}: ${supplier.email}`,
    supplier.address,
    supplier.postalCode,
  ].filter(Boolean) as string[];
  const buyerContact = [buyer.phone && `${c("phone")}: ${buyer.phone}`, buyer.email && `${c("email")}: ${buyer.email}`, buyer.taxId && `${c("taxId")}: ${buyer.taxId}`].filter(Boolean) as string[];
  return (
    <>
      <header className="business-document-head">
        <div className="business-document-letterhead" data-testid="po-document-letterhead">
          <strong>{dash(buyer.companyName)}</strong>
          {buyer.addressLines.map((line, index) => <div key={index}>{line}</div>)}
          {buyerContact.map((line) => <div key={line}>{line}</div>)}
        </div>
        <div className="business-document-meta">
          <h1 data-testid="po-document-title">{doc.title || c("purchaseOrder")}</h1>
          <dl>
            <dt>{c("poNumber")}</dt><dd data-testid="po-document-number">{dash(doc.number)}</dd>
            <dt>{c("issueDate")}</dt><dd data-testid="po-document-issue-date">{formatInstantDay(doc.issuedAt, locale, timezone)}</dd>
            <dt>{c("expectedDelivery")}</dt><dd data-testid="po-document-expected-date">{formatCalendarDay(doc.expectedDate, locale)}</dd>
            <dt>{c("currency")}</dt><dd data-testid="po-document-currency">{dash(doc.currency)}</dd>
          </dl>
        </div>
      </header>
      <section className="business-document-parties">
        <div data-testid="po-document-supplier">
          <h2>{c("supplier")}</h2>
          <p><strong>{dash(supplier.name)}</strong></p>
          {supplierLines.map((line) => <p key={line}>{line}</p>)}
        </div>
        <div data-testid="po-document-ship-to">
          <h2>{c("shipTo")}</h2>
          {/* A warehouse has no recorded address: its code and name are printed. */}
          <p><strong>{dash(doc.shipTo.name)}</strong></p>
          <p>{dash(doc.shipTo.code)}</p>
        </div>
      </section>
      <table className="business-document-lines" data-testid="po-document-lines">
        <thead>
          <tr>
            <th>{c("lineNo")}</th>
            <th>{c("sku")}</th>
            {columns.supplierSku && <th>{c("supplierSku")}</th>}
            <th>{c("description")}</th>
            <th className="is-number">{c("quantity")}</th>
            <th>{c("unit")}</th>
            <th className="is-number">{c("unitPrice")}</th>
            <th className="is-number">{c("amount")}</th>
            {columns.requestedDate && <th>{c("requestedDate")}</th>}
            {columns.promisedDate && <th>{c("promisedDate")}</th>}
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((line) => (
            <tr key={line.lineNo} data-testid={`po-document-line-${line.lineNo}`}>
              <td>{line.lineNo}</td>
              <td>{dash(line.sku)}</td>
              {columns.supplierSku && <td>{dash(line.supplierSku)}</td>}
              <td>{dash(line.description)}</td>
              <td className="is-number" data-testid="po-document-line-quantity">{formatDecimal(line.quantity, locale)}</td>
              <td>{dash(line.unit)}</td>
              <td className="is-number" data-testid="po-document-line-unit-price">{amount(line.unitPrice)}</td>
              <td className="is-number" data-testid="po-document-line-amount">{amount(line.amount)}</td>
              {columns.requestedDate && <td>{formatCalendarDay(line.requestedDate, locale)}</td>}
              {columns.promisedDate && <td>{formatCalendarDay(line.promisedDate, locale)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {/* One total per currency, as recorded on the PO; quantities are never added up. */}
      <div className="business-document-totals">
        <dl data-testid="po-document-totals">
          {doc.totals.map((total) => (
            <div key={total.currency || "none"} className="contents">
              <dt>{c("total", { currency: dash(total.currency) })}</dt>
              <dd data-testid="po-document-total">{formatAmount(total.amount, total.currency, locale)}</dd>
            </div>
          ))}
        </dl>
      </div>
      {doc.termsText && (
        <section className="business-document-terms" data-testid="po-document-terms">
          <h2>{c("terms")}</h2>
          {doc.termsText}
        </section>
      )}
      {doc.signatureBlock && (
        <section className="business-document-signature" data-testid="po-document-signature">
          <div>{c("signature")}</div>
          <div>{c("signatureDate")}</div>
        </section>
      )}
      {doc.footerText && <footer className="business-document-footer" data-testid="po-document-footer">{doc.footerText}</footer>}
    </>
  );
}

function failureState(error: unknown): Exclude<ReadState, "loading" | "loaded"> {
  if (error instanceof ApiError && error.status === 404) return "notFound";
  if (error instanceof ApiError && error.status === 403) return "forbidden";
  return "error";
}

export function PurchaseOrderDocumentPage({ orderId }: { orderId: string }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<PurchaseOrderDocument | null>(null);
  const [state, setState] = useState<ReadState>("loading");
  // The document language for this print only; it starts at the workspace default and is never saved.
  const [language, setLanguage] = useState<DocumentLanguage>("en-US");

  const load = useCallback(async () => {
    setState("loading");
    setDoc(null);
    if (!orderId.trim()) { setState("notFound"); return; }
    try {
      const result = await apiJson<{ document: PurchaseOrderDocument }>(`/api/procurement/orders/${encodeURIComponent(orderId)}/document`);
      setDoc(result.document);
      setLanguage(result.document.documentLanguage === "zh-CN" ? "zh-CN" : "en-US");
      setState("loaded");
    } catch (error) {
      setState(failureState(error));
    }
  }, [orderId]);
  useEffect(() => { void load(); }, [load]);

  const backTo = orderId ? `/app/procurement/orders/${encodeURIComponent(orderId)}` : "/app/procurement/orders";
  if (state === "loaded" && doc) {
    return (
      <DocumentShell backTo={backTo} backLabel={t("documents.back")} blocked={doc.printable.ok ? null : doc.printable.reason || "status"} language={language} onLanguageChange={setLanguage}>
        <PurchaseOrderSheet doc={doc} language={language} />
      </DocumentShell>
    );
  }
  const message = { notFound: t("documents.notFound"), forbidden: t("documents.forbidden"), error: t("documents.loadFailed") };
  return (
    <div className="space-y-4" data-testid="po-document-state">
      <Card className="p-8 text-center">
        {state === "loading"
          ? <div className="text-sm" style={{ color: A.sub }}>{t("documents.loading")}</div>
          : <>
              <TriangleAlert className="mx-auto text-amber-600" size={30} />
              <div className="mt-3 text-sm font-semibold" data-testid="po-document-unavailable">{message[state as keyof typeof message]}</div>
              {state === "error" && <button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold" style={{ color: A.blue }}><RefreshCw size={15} />{t("documents.retry")}</button>}
            </>}
      </Card>
      <Link to={backTo} className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: A.blue }}><ArrowLeft size={16} />{t("documents.back")}</Link>
    </div>
  );
}

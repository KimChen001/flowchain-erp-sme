import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Download, FileUp, Upload } from "lucide-react";
import { A, Card, Chip } from "../../components/ui";
import { tableBodyTextClass, tdIdClass, tdNumericClass, thClass } from "../../components/ui/workbenchTable";
import { ApiError, apiJson, AUTH_TOKEN_KEY } from "../../lib/api-client";
import { DATA_IMPORT_COLUMNS, dataImportCsv } from "../../../shared/data-import-columns.mjs";
import { useDataImportCopy } from "./dataImportCopy";
import { DATA_IMPORT_PERMISSION, useDataImportAccess, type DataImportType } from "./DataImportLink";

// Download a template, choose a file, check it, then import the rows the
// check accepted, chunk by chunk. Rows with errors are never sent: the person
// fixes the file and uploads it again. Existing records are skipped.

type Issue = { field: string; code: string; message: string; params?: Record<string, string> };
type Existing = {
  reason?: string;
  entity?: { type: string; id: string; label: string };
  document?: { type: string; id: string; number: string; workflowStatus?: string };
};
type PreviewRow = {
  rowNumber: number;
  key: string;
  action: "create" | "skip_existing" | "error";
  issues: Issue[];
  values: Record<string, string>;
  details?: Record<string, string | boolean | null>;
  existing?: Existing;
};
type WarehouseGroup = { warehouseId: string | null; warehouseCode: string; warehouseName: string | null; rows: number; create: number; newStockRecords: number };
type Preview = {
  type: DataImportType;
  fileName: string;
  fileSha256: string;
  sourceFormat: string;
  sheetName: string | null;
  sheetList: Array<{ name: string; state: string }>;
  ignoredColumns: Array<{ header: string; reason: string }>;
  rows: PreviewRow[];
  counts: { rows: number; create: number; skip_existing: number; error: number };
  chunkSize: number;
  warehouses?: WarehouseGroup[];
};
// not_sent: never requested; unknown: in the request that failed, which the
// server may have written in part or in full.
type ResultRow = Existing & { rowNumber: number; key: string; outcome: "created" | "skipped_existing" | "error" | "not_sent" | "unknown"; issues: Issue[] };
type CommitResult = { rows: ResultRow[]; documents: Array<{ id: string; number: string }> };

const TYPES: Array<{ type: DataImportType; label: string }> = [
  { type: "items", label: "Items" },
  { type: "suppliers", label: "Suppliers" },
  { type: "customers", label: "Customers" },
  { type: "item-suppliers", label: "Item suppliers" },
  { type: "opening-stock", label: "Opening stock" },
];
const RETRY_CODES = new Set(["VERSION_CONFLICT", "INVENTORY_OPERATIONS_CONCURRENT_TRANSACTION_CONFLICT", "COMMAND_EXECUTION_IN_PROGRESS"]);
// Button and field sizes of the other list and search cards.
const button = "inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40";
const secondary = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40";
const field = "h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400";

const isType = (value: string | null): value is DataImportType => TYPES.some((entry) => entry.type === value);

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function DataImportPage() {
  const { copy, issueText, language } = useDataImportCopy();
  const access = useDataImportAccess();
  const [params, setParams] = useSearchParams();
  const type: DataImportType = isType(params.get("type")) ? (params.get("type") as DataImportType) : "items";
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [sheets, setSheets] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [busy, setBusy] = useState<"" | "checking" | "importing">("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<CommitResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const columns = DATA_IMPORT_COLUMNS[type];
  const columnLabel = (key: string) => {
    const column = columns.find((entry) => entry.key === key);
    return column ? (language === "en-US" ? column.en : column.zh) : "";
  };
  const issueLine = (issue: Issue) => [columnLabel(issue.field), issueText(issue)].filter(Boolean).join(": ");
  const errorText = (cause: unknown, fallback: string) => {
    if (!(cause instanceof ApiError)) return copy(fallback);
    const details = (cause.payload as { details?: { columns?: Array<{ en: string; zh: string }>; column?: number } }).details;
    const missing = (details?.columns || []).map((entry) => (language === "en-US" ? entry.en : entry.zh)).join(", ");
    const code = cause.code || "";
    const translated = copy(code, { columns: missing, column: details?.column ?? "" });
    // A code with no sentence of its own: the server's English message, or
    // the translated fallback in Chinese.
    if (translated !== code) return translated;
    return language === "en-US" ? cause.message || copy(fallback) : copy(fallback);
  };

  const reset = () => {
    setPreview(null);
    setResults(null);
    setError("");
    setNotice("");
    setProgress({ done: 0, total: 0 });
    setErrorsOnly(false);
  };
  const chooseType = (next: DataImportType) => {
    reset();
    setFile(null);
    setSheets([]);
    setSheetName("");
    if (fileInput.current) fileInput.current.value = "";
    setParams({ type: next }, { replace: true });
  };

  const downloadTemplate = async () => {
    setError("");
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY) || "";
      const response = await fetch(`/api/data-import/templates/${type}?language=${language === "zh-CN" ? "zh-CN" : "en-US"}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error(String(response.status));
      saveBlob(await response.blob(), `flowchain-${type}-template.csv`);
    } catch {
      setError(copy("Could not download the template."));
    }
  };

  const check = async () => {
    if (!file) return;
    reset();
    setBusy("checking");
    try {
      const result = await apiJson<Preview>(`/api/data-import/${type}/preview`, {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, contentBase64: await fileToBase64(file), sheetName: sheetName || undefined, encoding: encoding || undefined }),
      });
      setPreview(result);
      setSheets(result.sheetList.filter((sheet) => sheet.state === "visible").map((sheet) => sheet.name));
      if (result.sheetName) setSheetName(result.sheetName);
    } catch (cause) {
      const sheetList = cause instanceof ApiError ? (cause.payload as { details?: { sheetList?: Array<{ name: string; state: string }> } }).details?.sheetList : undefined;
      if (sheetList?.length) setSheets(sheetList.filter((sheet) => sheet.state === "visible").map((sheet) => sheet.name));
      setError(errorText(cause, "Could not check the file."));
    } finally {
      setBusy("");
    }
  };

  // Every row the check accepted is sent, the skipped ones too, so the same
  // file always makes the same chunks and a second import replays.
  const runImport = async () => {
    if (!preview) return;
    const rows = preview.rows.filter((row) => row.action !== "error").map(({ rowNumber, values }) => ({ rowNumber, values }));
    const size = preview.chunkSize || 200;
    const collected: CommitResult = { rows: [], documents: [] };
    // The rows of the request in flight: when it fails, the server may still
    // have written some or all of them.
    let inFlight = new Set<number>();
    setBusy("importing");
    setError("");
    setProgress({ done: 0, total: rows.length });
    try {
      for (let index = 0; index * size < rows.length; index += 1) {
        const chunk = rows.slice(index * size, (index + 1) * size);
        inFlight = new Set(chunk.map((row) => row.rowNumber));
        const result = await apiJson<CommitResult>(`/api/data-import/${type}/commit`, {
          method: "POST",
          body: JSON.stringify({ fileSha256: preview.fileSha256, chunkIndex: index, rows: chunk }),
        });
        collected.rows.push(...result.rows);
        inFlight = new Set();
        for (const document of result.documents || []) if (!collected.documents.some((row) => row.id === document.id)) collected.documents.push(document);
        setProgress({ done: Math.min(rows.length, (index + 1) * size), total: rows.length });
      }
    } catch (cause) {
      const stopped = copy("The import stopped. Rows already imported are kept; check the file again to continue.");
      setError(cause instanceof ApiError ? `${errorText(cause, stopped)} ${stopped}` : stopped);
    } finally {
      // Rows with no answer because the import stopped are listed, so the
      // counts add up to the file and the results file names them: unknown
      // for the request that failed, not sent for the ones never made.
      const answered = new Set(collected.rows.map((row) => row.rowNumber));
      for (const row of rows) {
        if (answered.has(row.rowNumber)) continue;
        const key = preview.rows.find((entry) => entry.rowNumber === row.rowNumber)?.key || "";
        collected.rows.push({ rowNumber: row.rowNumber, key, outcome: inFlight.has(row.rowNumber) ? "unknown" : "not_sent", issues: [] });
      }
      setResults({ ...collected });
      if (collected.rows.some((row) => row.issues.some((issue) => RETRY_CODES.has(issue.code)))) setNotice(copy("Some rows hit a conflict with another change. Check the file again and import it to finish them."));
      setBusy("");
    }
  };

  const actionLabel = (row: PreviewRow) => (row.action === "create" ? copy("Create") : row.action === "skip_existing" ? copy("Skipped — already exists") : copy("Error"));
  const outcomeLabel = (row: ResultRow) => (row.outcome === "created" ? copy("Created")
    : row.outcome === "skipped_existing" ? copy("Skipped — already exists")
    : row.outcome === "not_sent" ? copy("Not sent: the import stopped")
    : row.outcome === "unknown" ? copy("Unknown: the import stopped while these rows were being sent; check the file again")
    : copy("Not imported"));
  const existingNote = (existing?: Existing) => {
    if (!existing) return "";
    if (existing.reason === "IN_OPENING_DRAFT" && existing.document) return copy("Already in draft {number}", { number: existing.document.number });
    if (existing.reason === "STOCK_RECORD_HAS_STOCK") return copy("This location already holds stock.");
    return existing.entity?.label || "";
  };
  const currencyNote = (details?: Record<string, string | boolean | null>) => {
    if (!details || !("currency" in details)) return "";
    if (!details.currency) return copy("Not recorded");
    const source = details.currencySource === "workspace" ? copy("Workspace currency") : details.currencySource === "supplier" ? copy("Supplier's default currency") : copy("From the file");
    return `${details.currency} · ${source}`;
  };

  const shown = useMemo(() => (preview ? preview.rows.filter((row) => !errorsOnly || row.action === "error") : []), [preview, errorsOnly]);
  const resultsCsv = () => {
    if (!preview || !results) return;
    const sent = new Map(results.rows.map((row) => [row.rowNumber, row]));
    const lines: string[][] = [[copy("Row"), copy("Key"), copy("Outcome"), copy("Details")]];
    for (const row of preview.rows) {
      const result = sent.get(row.rowNumber);
      if (!result) {
        if (row.action === "error") lines.push([String(row.rowNumber), row.key, copy("Not sent: fix the file and upload it again"), row.issues.map(issueLine).join("; ")]);
        continue;
      }
      const details = result.issues.length ? result.issues.map(issueLine).join("; ") : result.document ? result.document.number : existingNote(result) || result.entity?.label || "";
      lines.push([String(row.rowNumber), row.key, outcomeLabel(result), details]);
    }
    saveBlob(new Blob([dataImportCsv(lines)], { type: "text/csv;charset=utf-8" }), `flowchain-${type}-import-results.csv`);
  };

  const allowed = access.permissions.has(DATA_IMPORT_PERMISSION[type]);
  const opening = type === "opening-stock";
  const toSend = preview ? preview.counts.create : 0;

  return (
    <div className="space-y-5" data-testid="data-import-page">
      {/* One card for the record type and the file, like the search card on
          the list pages; the module shell already shows the page title. */}
      <Card className="space-y-4 p-5">
      <div>
        <h2 className="fc-section-title" style={{ color: A.label }}>{copy("Import a file")}</h2>
        <p className="mt-1 text-xs" style={{ color: A.sub }}>{copy("Create records from a CSV or XLSX file. Existing records are skipped, never changed.")}</p>
        <p className="mt-0.5 text-xs" style={{ color: A.sub }}>{copy("Import in this order: items, suppliers, customers, item suppliers, then opening stock.")}</p>
      </div>

      <div role="tablist" aria-label={copy("Import data")} className="flex flex-wrap gap-1 border-b" style={{ borderColor: A.border }}>
        {TYPES.map((entry) => (
          <button key={entry.type} type="button" role="tab" aria-selected={type === entry.type} data-testid={`data-import-type-${entry.type}`} onClick={() => chooseType(entry.type)}
            className="px-3 py-2 text-xs font-semibold" style={{ color: type === entry.type ? A.blue : A.gray1, borderBottom: type === entry.type ? `2px solid ${A.blue}` : "2px solid transparent" }}>
            {copy(entry.label)}
          </button>
        ))}
      </div>

        {opening ? <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800" data-testid="data-import-opening-note">{copy("Opening stock is created as a draft adjustment. A person approves and posts it in Inventory.")}</p> : null}
        <div className="flex flex-wrap items-end gap-3">
          <button type="button" className={secondary} onClick={() => void downloadTemplate()} data-testid="data-import-template">
            <Download size={14} />{copy("Download template")}
          </button>
          <label className={secondary}>
            <FileUp size={14} />{copy("Choose file")}
            <input ref={fileInput} type="file" className="sr-only" data-testid="data-import-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => { reset(); setSheets([]); setSheetName(""); setFile(event.target.files?.[0] || null); }} />
          </label>
          <span className="text-xs text-slate-500" data-testid="data-import-file-name">{file ? file.name : copy("No file chosen")}</span>
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            {copy("File encoding")}
            <select className={field} value={encoding} onChange={(event) => { setEncoding(event.target.value); reset(); }} aria-label={copy("File encoding")}>
              <option value="">{copy("UTF-8 (recommended)")}</option>
              <option value="gb18030">{copy("GB18030 (Chinese Excel on Windows)")}</option>
            </select>
          </label>
          {sheets.length > 1 ? (
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              {copy("Sheet")}
              <select className={field} value={sheetName} onChange={(event) => { setSheetName(event.target.value); reset(); }} aria-label={copy("Sheet")} data-testid="data-import-sheet">
                <option value="">—</option>
                {sheets.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          ) : null}
          <button type="button" className={button} disabled={!file || !allowed || Boolean(busy)} onClick={() => void check()} data-testid="data-import-check">
            {busy === "checking" ? copy("Checking…") : copy("Check file")}
          </button>
        </div>
        {error ? <p role="alert" className="text-sm" style={{ color: A.red }} data-testid="data-import-error">{error}</p> : null}
      </Card>

      {preview && !results ? (
        <Card className="space-y-3 p-5" data-testid="data-import-preview">
          <p className="text-sm font-semibold" data-testid="data-import-counts">
            {copy("{rows} rows: {create} to create, {skip} already exist, {error} with errors", { rows: preview.counts.rows, create: preview.counts.create, skip: preview.counts.skip_existing, error: preview.counts.error })}
          </p>
          {preview.counts.error ? <p className="text-xs text-slate-500">{copy("Rows with errors are never imported. Fix them in the file and upload it again.")}</p> : null}
          {preview.ignoredColumns.length ? (
            <p className="text-xs text-slate-500" data-testid="data-import-ignored">{copy("Columns ignored: {columns}", { columns: preview.ignoredColumns.map((entry) => entry.header).join(", ") })}</p>
          ) : null}
          {opening && preview.warehouses?.length ? (
            <div className="text-xs" data-testid="data-import-warehouses">
              <p className="font-semibold">{copy("By warehouse")}</p>
              <ul className="mt-1 space-y-0.5">
                {preview.warehouses.map((group) => (
                  <li key={group.warehouseId || group.warehouseCode}>
                    {group.warehouseCode}{group.warehouseName ? ` · ${group.warehouseName}` : ""}: {copy("{rows} rows, {create} to create, {newRecords} new stock records", { rows: group.rows, create: group.create, newRecords: group.newStockRecords })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <label className="inline-flex items-center gap-2 text-xs">
            <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} data-testid="data-import-errors-only" />
            {copy("Errors only")}
          </label>
          <div className="overflow-x-auto">
            <table className={`w-full min-w-[760px] text-left ${tableBodyTextClass}`} data-testid="data-import-preview-table">
              <thead>
                <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)", color: A.gray1 }}>
                  <th className={thClass}>{copy("Row")}</th>
                  <th className={thClass}>{copy("Key")}</th>
                  <th className={thClass}>{copy("Action")}</th>
                  {opening ? <><th className={thClass}>{copy("Quantity")}</th><th className={thClass}>{copy("Unit")}</th><th className={thClass}>{copy("Stock record")}</th></> : null}
                  {type === "suppliers" || type === "customers" || type === "item-suppliers" ? <th className={thClass}>{copy("Currency")}</th> : null}
                  <th className={thClass}>{copy("Issues")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.rowNumber} className="align-top" style={{ borderTop: "0.5px solid rgba(0,0,0,0.04)" }} data-testid={`data-import-row-${row.rowNumber}`}>
                    <td className={tdNumericClass}>{row.rowNumber}</td>
                    <td className={tdIdClass}>{row.key || "—"}</td>
                    <td className="px-4 py-3">
                      <Chip label={actionLabel(row)} color={row.action === "error" ? A.red : row.action === "create" ? A.green : A.gray1} bg={row.action === "error" ? "#fff1f0" : row.action === "create" ? "#edf9f2" : "#f4f5f7"} />
                      {row.existing ? <div className="mt-1 text-slate-500">{existingNote(row.existing)}</div> : null}
                      {row.action === "create" && row.details?.preferredSource === "item" ? <div className="mt-1 text-slate-500">{copy("Stays the item's preferred supplier")}</div> : null}
                    </td>
                    {opening ? (
                      <>
                        <td className={tdNumericClass}>{row.details?.quantity ?? "—"}</td>
                        <td className="px-4 py-3">{row.details?.unit || "—"}</td>
                        <td className="px-4 py-3">{row.action === "create" ? copy(row.details?.stockRecord === "new" ? "New stock record" : "Existing stock record") : "—"}</td>
                      </>
                    ) : null}
                    {type === "suppliers" || type === "customers" || type === "item-suppliers" ? <td className="px-4 py-3">{row.action === "error" ? "—" : currencyNote(row.details)}</td> : null}
                    <td className="px-4 py-3" style={{ color: row.issues.length ? A.red : undefined }}>
                      {row.issues.length ? <ul className="space-y-0.5">{row.issues.map((issue, index) => <li key={index}>{issueLine(issue)}</li>)}</ul> : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {busy === "importing" ? (
            <div className="space-y-1" data-testid="data-import-progress">
              <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-2 w-full overflow-hidden rounded bg-slate-100">
                <div className="h-2 bg-blue-600" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <p className="text-xs text-slate-500">{copy("Imported {done} of {total} rows", progress)}</p>
            </div>
          ) : null}
          <button type="button" className={button} disabled={!toSend || !allowed || Boolean(busy)} onClick={() => void runImport()} data-testid="data-import-commit">
            <Upload size={14} />{busy === "importing" ? copy("Importing…") : copy(toSend === 1 ? "Import 1 row" : "Import {n} rows", { n: toSend })}
          </button>
        </Card>
      ) : null}

      {preview && results ? (
        <Card className="space-y-3 p-5" data-testid="data-import-results">
          <p className="text-sm font-semibold" data-testid="data-import-result-counts">
            {copy("{rows} rows: {created} created, {skipped} already existed, {error} not imported", {
              rows: preview.counts.rows,
              created: results.rows.filter((row) => row.outcome === "created").length,
              skipped: results.rows.filter((row) => row.outcome === "skipped_existing").length,
              error: results.rows.filter((row) => row.outcome === "error").length + preview.counts.error,
            })}
          </p>
          {results.rows.some((row) => row.outcome === "unknown") ? (
            <p className="text-xs text-amber-700" data-testid="data-import-unknown">
              {copy("{n} rows may or may not have been imported: the import stopped while they were being sent. Check the file again to see which already exist.", { n: results.rows.filter((row) => row.outcome === "unknown").length })}
            </p>
          ) : null}
          {results.rows.some((row) => row.outcome === "not_sent") ? (
            <p className="text-xs text-amber-700" data-testid="data-import-not-sent">
              {copy("{n} rows were not sent because the import stopped. Check the file again and import it to send them.", { n: results.rows.filter((row) => row.outcome === "not_sent").length })}
            </p>
          ) : null}
          {notice ? <p className="text-xs text-amber-700">{notice}</p> : null}
          {results.documents.length ? (
            <div className="text-xs" data-testid="data-import-documents">
              <p className="font-semibold">{copy("Draft adjustments")}</p>
              <p className="text-slate-500">{copy("Opening stock is created as a draft adjustment. A person approves and posts it in Inventory.")}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {results.documents.map((document) => (
                  <Link key={document.id} className="font-semibold text-blue-600" to={`/app/inventory/adjustments/${encodeURIComponent(document.id)}`}>{copy("Open {number}", { number: document.number })}</Link>
                ))}
              </div>
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className={`w-full min-w-[640px] text-left ${tableBodyTextClass}`} data-testid="data-import-results-table">
              <thead>
                <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)", color: A.gray1 }}>
                  <th className={thClass}>{copy("Row")}</th>
                  <th className={thClass}>{copy("Key")}</th>
                  <th className={thClass}>{copy("Outcome")}</th>
                  <th className={thClass}>{copy("Details")}</th>
                </tr>
              </thead>
              <tbody>
                {results.rows.map((row) => (
                  <tr key={row.rowNumber} className="align-top" style={{ borderTop: "0.5px solid rgba(0,0,0,0.04)" }} data-testid={`data-import-result-${row.rowNumber}`}>
                    <td className={tdNumericClass}>{row.rowNumber}</td>
                    <td className={tdIdClass}>{row.key}</td>
                    <td className="px-4 py-3">{outcomeLabel(row)}</td>
                    <td className="px-4 py-3" style={{ color: row.issues.length ? A.red : undefined }}>
                      {row.issues.length ? row.issues.map(issueLine).join("; ") : row.document ? row.document.number : existingNote(row) || row.entity?.label || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondary} onClick={resultsCsv} data-testid="data-import-download-results"><Download size={14} />{copy("Download results")}</button>
            <button type="button" className={secondary} onClick={() => { reset(); setFile(null); if (fileInput.current) fileInput.current.value = ""; }}>{copy("Import another file")}</button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

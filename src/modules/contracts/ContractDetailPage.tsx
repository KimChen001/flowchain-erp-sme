import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ArrowLeft, Download, FileText, Paperclip, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card, Modal, inputStyle } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { ContractForm } from "./ContractForm";
import {
  CONTRACT_FILE_MAX_BYTES,
  CONTRACT_FILE_TYPES,
  ContractStateChip,
  RENEWAL_LABEL,
  TYPE_LABEL,
  contractErrorText,
  contractsApi,
  downloadContractFile,
  fieldIssueText,
  fieldIssues,
  fileToBase64,
  isVersionConflict,
  keyDateLabel,
  useContractCopy,
  useContractFormat,
  type ContractDetail,
  type ContractFile,
  type ContractHistoryRow,
  type FieldIssue,
} from "./contractShared";

// One contract (docs/contracts-module-design.md §3): its header and the
// actions its state allows, then its terms, dates, value, signed files,
// renewal links and history. Every action needs contracts.contract.manage
// (the response's access.manage) and sends the version the page shows, so a
// change made meanwhile by someone else is refused and offered for reload.

type Dialog =
  | { kind: "activate" }
  | { kind: "terminate" }
  | { kind: "renew" }
  | { kind: "delete" }
  | { kind: "remove-file"; file: ContractFile }
  | null;

const FIELD_NAMES: Record<string, string> = {
  title: "Title", externalReference: "Their reference", type: "Type", supplierId: "Supplier", ownerId: "Owner",
  startDate: "Start date", endDate: "End date", signedOn: "Signed on", renewal: "Renewal", noticeDays: "Notice period",
  reminderDays: "Remind me", paymentTermsId: "Payment terms", currency: "Currency", totalValue: "Total value", notes: "Notes",
};
const DAY_FIELDS = new Set(["startDate", "endDate", "signedOn"]);

export function ContractDetailPage({ contractId }: { contractId: string }) {
  const t = useContractCopy();
  const f = useContractFormat();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [detail, setDetail] = useState<ContractDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogIssues, setDialogIssues] = useState<FieldIssue[]>([]);
  const [activation, setActivation] = useState({ signedOn: "", startDate: "" });
  const [termination, setTermination] = useState({ terminatedOn: "", reason: "" });
  const [terms, setTerms] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const editing = params.get("edit") === "1";

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setDetail(await contractsApi.get(contractId));
    } catch (caught) {
      setLoadError(caught);
    }
  }, [contractId]);
  useEffect(() => { setDetail(null); setActionError(null); void load(); }, [load]);
  useEffect(() => {
    apiJson<{ options: Array<{ id: string; code?: string; label?: string }> }>("/api/master-data/payment-terms/select")
      .then(({ options }) => setTerms(Object.fromEntries((options || []).map((option) => [option.code || option.id, option.label || option.code || option.id]))))
      .catch(() => setTerms({}));
  }, []);
  const contract = detail?.contract;
  useDetailCrumb(contract?.number);

  const setEditing = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set("edit", "1");
    else next.delete("edit");
    setParams(next, { replace: true });
  };
  const reload = async () => { setActionError(null); await load(); };

  if (loadError) {
    const missing = loadError instanceof ApiError && loadError.status === 404;
    return (
      <Card className="p-8 text-center" data-testid="contract-load-error">
        <p role="alert" className="text-sm" style={{ color: A.red }}>{missing ? t("This contract was not found. It may have been deleted.") : `${t("Could not load this contract.")} ${contractErrorText(loadError, t)}`}</p>
        <div className="mt-4 flex justify-center gap-2">
          {!missing && <button type="button" className="fc-action-button fc-action-secondary" onClick={() => void load()}>{t("Retry")}</button>}
          <Link to="/app/contracts/list" className="fc-action-button fc-action-quiet">{t("Back to contracts")}</Link>
        </div>
      </Card>
    );
  }
  if (!detail || !contract) return <Card className="p-8 text-center text-xs" style={{ color: A.sub }}>{t("Loading…")}</Card>;

  const manage = detail.access.manage;
  const valueHidden = contract.restrictedFields.includes("totalValue");
  const openRenewal = contract.renewals.find((renewal) => !renewal.activatedAt) || null;
  const activeRenewals = contract.renewals.filter((renewal) => renewal.activatedAt);

  if (editing && manage && contract.status !== "terminated") {
    return (
      <ContractForm
        contract={contract}
        onCancel={() => setEditing(false)}
        onReload={() => void reload()}
        onSaved={async () => { toast.success(t("Contract saved")); setEditing(false); await load(); }}
      />
    );
  }

  // Runs one command; a refused version offers a reload.
  const run = async (command: () => Promise<unknown>, done: string, after?: (result: any) => Promise<void> | void) => {
    setBusy(true);
    setActionError(null);
    setDialogIssues([]);
    try {
      const result = await command();
      toast.success(t(done));
      setDialog(null);
      if (after) await after(result);
      else await load();
    } catch (caught) {
      const issues = fieldIssues(caught);
      if (issues.length && dialog) setDialogIssues(issues);
      else setDialog(null);
      setActionError(caught);
    } finally {
      setBusy(false);
    }
  };

  const addFile = async (file: File) => {
    setActionError(null);
    if (!CONTRACT_FILE_TYPES.includes(file.type) || file.size < 1 || file.size > CONTRACT_FILE_MAX_BYTES) {
      setActionError(new ApiError(422, { code: "CONTRACT_FILE_TYPE_NOT_ALLOWED" }, "file"));
      return;
    }
    setUploading(true);
    try {
      const staged = await contractsApi.stage({ purpose: "contract", fileName: file.name, mimeType: file.type, contentBase64: await fileToBase64(file) });
      await contractsApi.addFile(contract.id, { uploadId: staged.uploadId, expectedVersion: contract.version });
      toast.success(t("File added"));
      await load();
    } catch (caught) {
      setActionError(caught);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const download = async (file: ContractFile) => {
    try { await downloadContractFile(file); } catch { toast.error(t("The file could not be downloaded.")); }
  };

  const action = (label: string, onClick: () => void, testId: string, icon?: ReactNode, tone: "primary" | "secondary" | "danger" | "quiet" = "secondary") => (
    <button type="button" data-testid={testId} disabled={busy || uploading} onClick={onClick} className={`fc-action-button fc-action-${tone} fc-action-compact`}>{icon}{t(label)}</button>
  );
  const actions: ReactNode[] = [];
  if (manage) {
    if (contract.status !== "terminated") actions.push(action("Edit", () => setEditing(true), "contract-action-edit", <Pencil size={13} />, "quiet"));
    if (contract.status === "draft") actions.push(action("Activate", () => { setDialogIssues([]); setActivation({ signedOn: contract.signedOn || "", startDate: contract.startDate || "" }); setDialog({ kind: "activate" }); }, "contract-action-activate", undefined, "primary"));
    if (contract.status === "active" && contract.renewals.length === 0) actions.push(action("Renew", () => setDialog({ kind: "renew" }), "contract-action-renew", <RefreshCw size={13} />));
    if (contract.status === "active") actions.push(action("Terminate", () => { setDialogIssues([]); setTermination({ terminatedOn: detail.today, reason: "" }); setDialog({ kind: "terminate" }); }, "contract-action-terminate", undefined, "danger"));
    actions.push(action(uploading ? "Uploading…" : "Add file", () => fileInput.current?.click(), "contract-action-add-file", <Paperclip size={13} />));
    if (contract.status === "draft") actions.push(action("Delete draft", () => setDialog({ kind: "delete" }), "contract-action-delete", <Trash2 size={13} />, "danger"));
  }
  const keyKind = keyDateLabel(contract);
  const notRecorded = <span style={{ color: A.gray2 }}>{t("Not recorded")}</span>;
  const row = (label: string, value: ReactNode, testId?: string) => (
    <div className="fc-detail-field" data-testid={testId}>
      <div className="text-[11px]" style={{ color: A.sub }}>{t(label)}</div>
      <div className="mt-1 text-sm font-medium break-words" style={{ color: A.label }}>{value ?? notRecorded}</div>
    </div>
  );
  const days = (value: number) => t(value === 1 ? "1 day" : "{n} days", { n: value });
  const dialogIssue = (field: string) => {
    const issue = dialogIssues.find((item) => item.field === field);
    return issue ? <p className="mt-1 text-xs text-red-600" data-testid={`contract-dialog-error-${field}`}>{fieldIssueText(issue, t)}</p> : null;
  };

  return (
    <div className="space-y-4" data-testid="contract-detail" data-contract-id={contract.id} data-state={contract.state}>
      <div>
        <Link to="/app/contracts/list" className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: A.blue }}><ArrowLeft size={13} />{t("Back to contracts")}</Link>
      </div>
      <Card className="p-5" data-testid="contract-header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="fc-page-title tabular-nums" style={{ color: A.label }} data-testid="contract-number">{contract.number}</h1>
              <ContractStateChip state={contract.state} />
            </div>
            <div className="mt-1 text-base font-medium" style={{ color: A.label }} data-testid="contract-title">{contract.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: A.sub }}>
              {contract.supplier && <span>{t("Supplier")}: <EntityLink kind="supplier" id={contract.supplier.id}>{contract.supplier.name}</EntityLink></span>}
              {contract.externalReference && <span>{t("Their reference")}: {contract.externalReference}</span>}
              {contract.keyDate && keyKind && <span data-testid="contract-key-date-line">{t(keyKind)} {f.day(contract.keyDate)}</span>}
            </div>
          </div>
          {actions.length > 0 && <div className="fc-detail-actions flex flex-wrap items-center gap-2" data-testid="contract-actions">{actions}</div>}
        </div>
        <input ref={fileInput} type="file" accept={CONTRACT_FILE_TYPES.join(",")} className="hidden" data-testid="contract-file-input" onChange={(event) => { const file = event.target.files?.[0]; if (file) void addFile(file); }} />
        {Boolean(actionError) && (
          <div role="alert" data-testid="contract-action-error" className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{contractErrorText(actionError, t)}</span>
            {isVersionConflict(actionError) && <button type="button" data-testid="contract-reload" className="fc-action-button fc-action-secondary fc-action-compact" onClick={() => void reload()}>{t("Reload")}</button>}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5" data-testid="contract-terms">
          <h2 className="fc-section-title" style={{ color: A.label }}>{t("Terms")}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {row("Type", t(TYPE_LABEL[contract.type] || "Other"))}
            {row("Supplier", contract.supplier ? <EntityLink kind="supplier" id={contract.supplier.id}>{contract.supplier.name}</EntityLink> : null)}
            {row("Owner", contract.owner?.name || null)}
            {row("Their reference", contract.externalReference)}
            {row("Payment terms", contract.paymentTermsId ? (terms[contract.paymentTermsId] ? `${terms[contract.paymentTermsId]} (${contract.paymentTermsId})` : contract.paymentTermsId) : null)}
            {contract.status === "terminated" && row("Terminated on", f.day(contract.terminatedOn))}
          </div>
          {contract.status === "terminated" && contract.terminationReason && <div className="mt-3">{row("Termination reason", contract.terminationReason)}</div>}
          <div className="mt-3">{row("Notes", contract.notes ? <span className="whitespace-pre-wrap font-normal">{contract.notes}</span> : null)}</div>
        </Card>

        <Card className="p-5" data-testid="contract-dates">
          <h2 className="fc-section-title" style={{ color: A.label }}>{t("Dates and renewal")}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {row("Start date", contract.startDate ? f.day(contract.startDate) : null)}
            {row("End date", contract.endDate ? f.day(contract.endDate) : t("No end date"))}
            {row("Signed on", contract.signedOn ? f.day(contract.signedOn) : null)}
            {row("Renewal", t(RENEWAL_LABEL[contract.renewal] || "Does not renew"))}
            {contract.renewal === "automatic" && row("Notice period", days(contract.noticeDays))}
            {contract.renewal === "automatic" && row("Notice deadline", contract.noticeDeadline ? f.day(contract.noticeDeadline) : null, "contract-notice-deadline")}
            {row("Remind me", t("{n} days before the key date", { n: contract.reminderDays }))}
          </div>
        </Card>

        <Card className="p-5" data-testid="contract-value">
          <h2 className="fc-section-title" style={{ color: A.label }}>{t("Value")}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {row("Total value", valueHidden ? <span style={{ color: A.sub }} data-testid="contract-value-hidden">{t("Hidden for your role")}</span> : contract.totalValue === null ? null : f.money(contract.totalValue, contract.currency))}
            {!valueHidden && row("Currency", contract.currency)}
          </div>
        </Card>

        <Card className="p-5" data-testid="contract-renewals">
          <h2 className="fc-section-title" style={{ color: A.label }}>{t("Renewal links")}</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {contract.renewsContract && <li data-testid="contract-renews">{t("Renews {number}", { number: "" })}<EntityLink kind="contract" id={contract.renewsContract.id}>{contract.renewsContract.number}</EntityLink></li>}
            {activeRenewals.map((renewal) => <li key={renewal.id} data-testid="contract-renewed-by">{t("Renewed by {number}", { number: "" })}<EntityLink kind="contract" id={renewal.id}>{renewal.number}</EntityLink></li>)}
            {openRenewal && <li data-testid="contract-renewal-draft"><EntityLink kind="contract" id={openRenewal.id}>{t("Renewal draft {number} in progress", { number: openRenewal.number })}</EntityLink></li>}
            {!contract.renewsContract && contract.renewals.length === 0 && <li style={{ color: A.sub }}>{t("No renewal recorded.")}</li>}
          </ul>
        </Card>
      </div>

      <Card className="p-5" data-testid="contract-files">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="fc-section-title" style={{ color: A.label }}>{t("Files")}</h2>
          <span className="text-[11px]" style={{ color: A.sub }}>{t("PDF or image (JPEG, PNG, WebP), up to 20 MB.")}</span>
        </div>
        {contract.files.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: A.sub }}>{t("No files yet. Add the signed agreement as a PDF or an image.")}</p>
        ) : (
          <ul className="mt-3 divide-y" style={{ borderColor: A.border }}>
            {contract.files.map((file) => (
              <li key={file.id} data-testid="contract-file" className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText size={16} style={{ color: A.gray1 }} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" style={{ color: A.label }} data-testid="contract-file-name">{file.fileName}</div>
                    <div className="text-[11px]" style={{ color: A.sub }}>{f.size(file.sizeBytes)} · {t("Added by {name} on {date}", { name: file.createdBy?.name || t("System"), date: f.instant(file.createdAt) })}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" data-testid="contract-file-download" className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: A.blue }} onClick={() => void download(file)}><Download size={13} />{t("Download")}</button>
                  {manage && <button type="button" data-testid="contract-file-remove" className="text-xs font-semibold" style={{ color: A.red }} disabled={busy} onClick={() => setDialog({ kind: "remove-file", file })}>{t("Remove")}</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5" data-testid="contract-history">
        <h2 className="fc-section-title" style={{ color: A.label }}>{t("History")}</h2>
        {contract.history.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: A.sub }}>{t("No history yet.")}</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {contract.history.map((entry) => <HistoryEntry key={entry.id} entry={entry} />)}
          </ol>
        )}
      </Card>

      <Modal
        open={dialog?.kind === "activate"}
        onClose={() => setDialog(null)}
        title={t("Activate contract")}
        subtitle={t("Record the day it was signed and the day it starts.")}
        footer={<>
          <button type="button" className="fc-action-button fc-action-quiet" onClick={() => setDialog(null)}>{t("Cancel")}</button>
          <button type="button" data-testid="contract-activate-confirm" className="fc-action-button fc-action-primary" disabled={busy} onClick={() => void run(() => contractsApi.activate(contract.id, { ...activation, expectedVersion: contract.version }), "Contract activated")}>{t(busy ? "Working…" : "Activate")}</button>
        </>}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-[13px] font-semibold" style={{ color: A.sub }}>{t("Signed on")}
            <input type="date" data-testid="contract-activate-signed" value={activation.signedOn} max={detail.today} onChange={(event) => setActivation({ ...activation, signedOn: event.target.value })} style={{ ...inputStyle, marginTop: 6 }} />
            {dialogIssue("signedOn")}
          </label>
          <label className="text-[13px] font-semibold" style={{ color: A.sub }}>{t("Start date")}
            <input type="date" data-testid="contract-activate-start" value={activation.startDate} onChange={(event) => setActivation({ ...activation, startDate: event.target.value })} style={{ ...inputStyle, marginTop: 6 }} />
            {dialogIssue("startDate")}
          </label>
        </div>
      </Modal>

      <Modal
        open={dialog?.kind === "terminate"}
        onClose={() => setDialog(null)}
        title={t("Terminate contract")}
        subtitle={t("Ending a contract early cannot be undone. Record the date and the reason.")}
        footer={<>
          <button type="button" className="fc-action-button fc-action-quiet" onClick={() => setDialog(null)}>{t("Cancel")}</button>
          <button type="button" data-testid="contract-terminate-confirm" className="fc-action-button fc-action-danger" disabled={busy} onClick={() => void run(() => contractsApi.terminate(contract.id, { ...termination, expectedVersion: contract.version }), "Contract terminated")}>{t(busy ? "Working…" : "Terminate the contract")}</button>
        </>}
      >
        <div className="grid gap-4">
          <label className="text-[13px] font-semibold" style={{ color: A.sub }}>{t("Termination date")}
            <input type="date" data-testid="contract-terminate-date" value={termination.terminatedOn} onChange={(event) => setTermination({ ...termination, terminatedOn: event.target.value })} style={{ ...inputStyle, marginTop: 6 }} />
            {dialogIssue("terminatedOn")}
          </label>
          <label className="text-[13px] font-semibold" style={{ color: A.sub }}>{t("Reason")}
            <textarea data-testid="contract-terminate-reason" rows={3} maxLength={1000} value={termination.reason} onChange={(event) => setTermination({ ...termination, reason: event.target.value })} style={{ ...inputStyle, marginTop: 6 }} />
            {dialogIssue("reason")}
          </label>
        </div>
      </Modal>

      <Modal
        open={dialog?.kind === "renew"}
        onClose={() => setDialog(null)}
        title={t("Renew")}
        footer={<>
          <button type="button" className="fc-action-button fc-action-quiet" onClick={() => setDialog(null)}>{t("Cancel")}</button>
          <button type="button" data-testid="contract-renew-confirm" className="fc-action-button fc-action-primary" disabled={busy} onClick={() => void run(() => contractsApi.renew(contract.id, { expectedVersion: contract.version }), "Renewal draft created", (result) => { if (result?.contract?.id) navigate(`/app/contracts/${encodeURIComponent(result.contract.id)}`); })}>{t(busy ? "Working…" : "Start the renewal")}</button>
        </>}
      >
        <p>{t("Start a renewal? A new draft is created with these terms; this contract stays as it is until the renewal is activated.")}</p>
      </Modal>

      <Modal
        open={dialog?.kind === "delete"}
        onClose={() => setDialog(null)}
        title={t("Delete draft")}
        footer={<>
          <button type="button" className="fc-action-button fc-action-quiet" onClick={() => setDialog(null)}>{t("Cancel")}</button>
          <button type="button" data-testid="contract-delete-confirm" className="fc-action-button fc-action-danger" disabled={busy} onClick={() => void run(() => contractsApi.deleteDraft(contract.id, contract.version), "Draft deleted", () => { navigate("/app/contracts/list"); })}>{t(busy ? "Working…" : "Delete draft")}</button>
        </>}
      >
        <p>{t("Delete this draft? Its files are removed with it. This cannot be undone.")}</p>
      </Modal>

      <Modal
        open={dialog?.kind === "remove-file"}
        onClose={() => setDialog(null)}
        title={t("Remove")}
        footer={<>
          <button type="button" className="fc-action-button fc-action-quiet" onClick={() => setDialog(null)}>{t("Cancel")}</button>
          <button type="button" data-testid="contract-file-remove-confirm" className="fc-action-button fc-action-danger" disabled={busy} onClick={() => { if (dialog?.kind === "remove-file") void run(() => contractsApi.removeFile(contract.id, dialog.file.id, contract.version), "File removed"); }}>{t(busy ? "Working…" : "Remove")}</button>
        </>}
      >
        <p>{dialog?.kind === "remove-file" ? t("Remove {name}? It stays in the history.", { name: dialog.file.fileName }) : null}</p>
      </Modal>
    </div>
  );
}

// One audit row with a readable action name; never the stored code.
function HistoryEntry({ entry }: { entry: ContractHistoryRow }) {
  const t = useContractCopy();
  const f = useContractFormat();
  const details = entry.details || {};
  const changed = (changes: Record<string, { before: unknown; after: unknown; restricted?: boolean }> = {}) =>
    Object.entries(changes).map(([field, change]) => {
      const name = t(FIELD_NAMES[field] || "Changed");
      if (DAY_FIELDS.has(field)) return `${name} ${change.before ? f.day(String(change.before)) : "—"} → ${change.after ? f.day(String(change.after)) : "—"}`;
      return name;
    }).join(", ");
  const [title, line] = (() => {
    switch (entry.action) {
      case "contract_created": return [details.renewsNumber ? t("Created to renew {number}", { number: details.renewsNumber }) : t("Created"), ""];
      case "contract_updated": return [t("Updated"), details.changes ? t("Changed: {fields}", { fields: changed(details.changes) }) : ""];
      case "contract_activated": return [t("Activated"), details.signedOn || details.startDate ? t("Signed {signed}, starts {start}", { signed: f.day(details.signedOn), start: f.day(details.startDate) }) : ""];
      case "contract_terminated": return [t("Terminated"), details.terminatedOn ? t("On {date}: {reason}", { date: f.day(details.terminatedOn), reason: String(details.reason || "") }) : ""];
      case "contract_renewed": return [t("Renewal started"), details.renewalNumber ? t("Renewal draft {number}", { number: details.renewalNumber }) : ""];
      case "contract_file_added": return [t("File added"), String(details.fileName || "")];
      case "contract_file_removed": return [t("File removed"), String(details.fileName || "")];
      case "contract_draft_deleted": return [t("Draft removed"), ""];
      default: return [t("Changed"), ""];
    }
  })();
  return (
    <li data-testid="contract-history-entry" data-action={entry.action} className="flex flex-wrap items-start gap-x-3 gap-y-0.5 text-sm">
      <span className="w-44 shrink-0 text-xs tabular-nums" style={{ color: A.sub }}>{f.instant(entry.at)}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium" style={{ color: A.label }}>{title}</div>
        {line && <div className="text-xs break-words" style={{ color: A.sub }}>{line}</div>}
        <div className="text-[11px]" style={{ color: A.gray2 }}>{t("by {name}", { name: entry.actor?.name || t("System") })}</div>
      </div>
    </li>
  );
}

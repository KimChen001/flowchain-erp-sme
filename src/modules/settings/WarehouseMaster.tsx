import { Fragment, useCallback, useEffect, useState } from "react";
import { Boxes, Pencil, Plus, Save } from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { forgetWarehouseNames } from "../../lib/useWarehouseNames";
import { A } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";

// Warehouses and their bins, kept by a workspace administrator: add one,
// rename it, or set it inactive or active again. Codes never change, and
// nothing is deleted. The server checks settings.workspace.manage on every
// write and operate access to the warehouse for every change after it exists;
// a warehouse the administrator adds gives them operate access, and everyone
// else gets access in the Warehouse access table below.

type WarehouseRow = { id: string; code: string; name: string; status: string; version: number };
type BinRow = { id: string; warehouseId: string; code: string; name: string | null; status: string; updatedAt: string };
type Issue = { field?: string; code?: string; count?: number; message?: string };
type Key = Parameters<ReturnType<typeof useI18n>["t"]>[0];

const field = "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm";
const button = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50";
const small = "inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50";

// What still depends on a warehouse or bin, as the server counts it.
const REASONS: Record<string, Key> = {
  INVENTORY_ON_HAND: "settings.warehouseReasonOnHand",
  QUARANTINE_ON_HAND: "settings.warehouseReasonQuarantine",
  ACTIVE_RESERVATIONS: "settings.warehouseReasonReservations",
  OPEN_COUNTS: "settings.warehouseReasonCounts",
  UNPOSTED_RECEIVING: "settings.warehouseReasonReceiving",
};
const ISSUES: Record<string, Key> = {
  CODE_REQUIRED: "settings.warehouseIssueCodeRequired",
  CODE_INVALID: "settings.warehouseIssueCodeInvalid",
  CODE_TOO_LONG: "settings.warehouseIssueCodeTooLong",
  CODE_IMMUTABLE: "settings.warehouseIssueCodeImmutable",
  NAME_REQUIRED: "settings.warehouseIssueNameRequired",
  NAME_TOO_LONG: "settings.warehouseIssueNameTooLong",
  DUPLICATE_CODE: "settings.warehouseDuplicate",
  DUPLICATE_BIN: "settings.binDuplicate",
};
const ERRORS: Record<string, Key> = {
  VERSION_CONFLICT: "settings.warehouseChanged",
  LAST_ACTIVE_WAREHOUSE: "settings.warehouseLastActive",
  WAREHOUSE_SCOPE_DENIED: "settings.warehouseScopeDenied",
  WAREHOUSE_INACTIVE: "settings.warehouseInactiveBins",
  DUPLICATE_CODE: "settings.warehouseDuplicate",
  DUPLICATE_BIN: "settings.binDuplicate",
};

function StatusChip({ status, testId }: { status: string; testId: string }) {
  const { t } = useI18n();
  return <span data-testid={testId} className={`rounded-full px-2 py-0.5 text-xs ${status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"}`}>{status === "active" ? t("settings.warehouseActive") : t("settings.warehouseInactive")}</span>;
}

export default function WarehouseMaster({ operateIds, onChanged }: { operateIds: Set<string>; onChanged: () => void }) {
  const { t } = useI18n();
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [bins, setBins] = useState<Record<string, BinRow[]>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ code: "", name: "" });
  const [binDraft, setBinDraft] = useState({ code: "", name: "" });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [open, setOpen] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ tone: "info" | "alert"; title: string; lines: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await apiJson<{ warehouses: WarehouseRow[] }>("/api/master-data/warehouses");
      setWarehouses(payload.warehouses || []);
    } catch (error) {
      setNotice({ tone: "alert", title: error instanceof Error ? error.message : t("settings.loadFailed"), lines: [] });
    }
  }, [t]);
  const loadBins = useCallback(async (warehouseId: string) => {
    const payload = await apiJson<{ bins: BinRow[] }>(`/api/master-data/warehouses/${encodeURIComponent(warehouseId)}/bins`);
    setBins(current => ({ ...current, [warehouseId]: payload.bins || [] }));
  }, []);
  useEffect(() => { void load(); }, [load]);

  // A refusal in plain words: what blocks a status change, or which field to fix.
  const explain = (error: unknown, subject: string) => {
    if (!(error instanceof ApiError)) return { tone: "alert" as const, title: error instanceof Error ? error.message : t("settings.saveFailed"), lines: [] };
    const details = error.details as Issue[];
    if (error.code === "WAREHOUSE_IN_USE" || error.code === "BIN_IN_USE") {
      return {
        tone: "alert" as const,
        title: t(error.code === "WAREHOUSE_IN_USE" ? "settings.warehouseInUse" : "settings.binInUse", { code: subject }),
        lines: details.map(detail => REASONS[String(detail.code)] ? t(REASONS[String(detail.code)], { count: Number(detail.count || 0) }) : String(detail.code)),
      };
    }
    if (error.code === "VALIDATION_ERROR") return { tone: "alert" as const, title: t("settings.saveFailed"), lines: details.map(detail => ISSUES[String(detail.code)] ? t(ISSUES[String(detail.code)]) : String(detail.message || detail.code)) };
    return { tone: "alert" as const, title: ERRORS[String(error.code)] ? t(ERRORS[String(error.code)]) : error.message, lines: [] };
  };
  // Every write reloads what it changed, and the page around it, so access
  // and default warehouses show the result.
  const run = async (key: string, subject: string, work: () => Promise<string | void>, warehouseId = "") => {
    setBusy(key); setNotice(null);
    try {
      const done = await work();
      if (done) setNotice({ tone: "info", title: done, lines: [] });
      forgetWarehouseNames();
      onChanged();
      return true;
    } catch (error) {
      setNotice(explain(error, subject));
      return false;
    } finally {
      await load();
      if (warehouseId) await loadBins(warehouseId).catch(() => undefined);
      setBusy("");
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const code = draft.code.trim().toUpperCase();
    const saved = await run("new", code, async () => {
      await apiJson("/api/master-data/warehouses", { method: "POST", body: JSON.stringify({ code, name: draft.name.trim() }) });
      return t("settings.warehouseCreated", { code });
    });
    if (saved) { setDraft({ code: "", name: "" }); setAdding(false); }
  };
  const rename = async (warehouse: WarehouseRow) => {
    if (!renaming) return;
    const saved = await run(warehouse.id, warehouse.code, async () => {
      await apiJson(`/api/master-data/warehouses/${encodeURIComponent(warehouse.id)}`, { method: "PATCH", body: JSON.stringify({ name: renaming.name.trim(), expectedVersion: warehouse.version }) });
    });
    if (saved) setRenaming(null);
  };
  const setStatus = async (warehouse: WarehouseRow, active: boolean) => {
    if (!active && !window.confirm(t("settings.warehouseConfirmInactive", { code: warehouse.code }))) return;
    await run(warehouse.id, warehouse.code, async () => {
      const result = await apiJson<{ clearedDefaults?: number }>(`/api/master-data/warehouses/${encodeURIComponent(warehouse.id)}/${active ? "activate" : "deactivate"}`, { method: "POST", body: JSON.stringify({ expectedVersion: warehouse.version }) });
      if (!active && result.clearedDefaults) return t("settings.warehouseClearedDefaults", { code: warehouse.code, count: result.clearedDefaults });
    });
  };
  const toggleBins = async (warehouse: WarehouseRow) => {
    if (open === warehouse.id) { setOpen(""); return; }
    setOpen(warehouse.id); setBinDraft({ code: "", name: "" }); setNotice(null);
    try { await loadBins(warehouse.id); } catch (error) { setNotice(explain(error, warehouse.code)); }
  };
  const createBin = async (event: React.FormEvent, warehouse: WarehouseRow) => {
    event.preventDefault();
    const saved = await run(`bin-${warehouse.id}`, binDraft.code.trim(), async () => {
      await apiJson(`/api/master-data/warehouses/${encodeURIComponent(warehouse.id)}/bins`, { method: "POST", body: JSON.stringify({ code: binDraft.code.trim(), name: binDraft.name.trim() }) });
    }, warehouse.id);
    if (saved) setBinDraft({ code: "", name: "" });
  };
  const renameBin = async (warehouse: WarehouseRow, bin: BinRow) => {
    if (!renaming) return;
    const saved = await run(bin.id, bin.code, async () => {
      await apiJson(`/api/master-data/warehouses/${encodeURIComponent(warehouse.id)}/bins/${encodeURIComponent(bin.id)}`, { method: "PATCH", body: JSON.stringify({ name: renaming.name.trim(), expectedUpdatedAt: bin.updatedAt }) });
    }, warehouse.id);
    if (saved) setRenaming(null);
  };
  const setBinStatus = async (warehouse: WarehouseRow, bin: BinRow, active: boolean) => {
    await run(bin.id, bin.code, async () => {
      await apiJson(`/api/master-data/warehouses/${encodeURIComponent(warehouse.id)}/bins/${encodeURIComponent(bin.id)}/${active ? "activate" : "deactivate"}`, { method: "POST", body: JSON.stringify({ expectedUpdatedAt: bin.updatedAt }) });
    }, warehouse.id);
  };

  const nameCell = (id: string, name: string, onSave: () => void, canEdit: boolean, testId: string) => renaming?.id === id
    ? <span className="flex flex-wrap items-center gap-2">
      <input aria-label={t("settings.warehouseName")} data-testid={`${testId}-name`} className={`${field} w-56`} value={renaming.name} onChange={event => setRenaming({ id, name: event.target.value })} />
      <button type="button" data-testid={`${testId}-save-name`} disabled={busy === id} className={small} onClick={onSave}><Save size={13} />{t("settings.warehouseSaveName")}</button>
      <button type="button" className={small} onClick={() => setRenaming(null)}>{t("settings.cancel")}</button>
    </span>
    : <span className="flex flex-wrap items-center gap-2">{name || "—"}{canEdit && <button type="button" data-testid={`${testId}-rename`} className={small} onClick={() => setRenaming({ id, name })}><Pencil size={13} />{t("settings.warehouseRename")}</button>}</span>;

  return <section className="mt-5" data-testid="warehouse-master">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold">{t("settings.warehouses")}</h3><p className="mt-1 text-sm text-slate-500">{t("settings.warehousesHint")}</p></div>
      {!adding && <button type="button" data-testid="warehouse-new" className={`${button} text-white`} style={{ background: A.blue }} onClick={() => { setAdding(true); setNotice(null); }}><Plus size={15} />{t("settings.warehouseNew")}</button>}
    </div>
    {notice && <div role={notice.tone === "alert" ? "alert" : "status"} data-testid="warehouse-notice" className={`mt-3 rounded-lg p-3 text-sm ${notice.tone === "alert" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-900"}`}>
      <div>{notice.title}</div>{notice.lines.length > 0 && <ul className="mt-1 list-disc pl-5">{notice.lines.map(line => <li key={line}>{line}</li>)}</ul>}
    </div>}

    {adding && <form onSubmit={event => void create(event)} className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3" data-testid="warehouse-form">
      <label className="text-sm">{t("settings.warehouseCode")}<input data-testid="warehouse-field-code" required maxLength={32} className={`${field} mt-1 block w-40 uppercase`} value={draft.code} onChange={event => setDraft({ ...draft, code: event.target.value })} /></label>
      <label className="text-sm">{t("settings.warehouseName")}<input data-testid="warehouse-field-name" required maxLength={120} className={`${field} mt-1 block w-64`} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <button type="submit" data-testid="warehouse-save" disabled={busy === "new" || !draft.code.trim() || !draft.name.trim()} className={`${button} text-white`} style={{ background: A.blue }}><Save size={15} />{t("settings.warehouseAdd")}</button>
      <button type="button" className={`${button} border border-slate-200 bg-white`} onClick={() => { setAdding(false); setDraft({ code: "", name: "" }); }}>{t("settings.cancel")}</button>
      <p className="w-full text-xs text-slate-500">{t("settings.warehouseCodeHint")}</p>
    </form>}

    <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[640px] text-sm" data-testid="warehouse-table">
      <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-2">{t("settings.warehouseCode")}</th><th className="p-2">{t("settings.warehouseName")}</th><th className="p-2">{t("settings.status")}</th><th className="p-2" /></tr></thead>
      <tbody>{warehouses.length === 0 && <tr><td colSpan={4} className="p-2 text-slate-500">{t("settings.warehouseEmpty")}</td></tr>}
        {warehouses.map(warehouse => {
          const canOperate = operateIds.has(warehouse.id);
          const active = warehouse.status === "active";
          return <Fragment key={warehouse.id}>
            <tr className="border-t" data-testid={`warehouse-row-${warehouse.code}`}>
              <td className="p-2 font-medium">{warehouse.code}</td>
              <td className="p-2">{nameCell(warehouse.id, warehouse.name, () => void rename(warehouse), canOperate, `warehouse-${warehouse.code}`)}</td>
              <td className="p-2"><StatusChip status={warehouse.status} testId={`warehouse-status-${warehouse.code}`} /></td>
              <td className="p-2 text-right"><span className="inline-flex flex-wrap justify-end gap-2">
                {canOperate ? <>
                  <button type="button" data-testid={`warehouse-toggle-${warehouse.code}`} disabled={busy === warehouse.id} className={small} onClick={() => void setStatus(warehouse, !active)}>{active ? t("settings.warehouseSetInactive") : t("settings.warehouseSetActive")}</button>
                  <button type="button" data-testid={`warehouse-bins-${warehouse.code}`} aria-expanded={open === warehouse.id} className={small} onClick={() => void toggleBins(warehouse)}><Boxes size={13} />{t("settings.bins")}</button>
                </> : <span className="text-xs text-slate-500">{t("settings.warehouseNoOperate")}</span>}
              </span></td>
            </tr>
            {open === warehouse.id && canOperate && <tr className="bg-slate-50/60" data-testid={`warehouse-bin-panel-${warehouse.code}`}><td colSpan={4} className="p-3">
              <div className="text-sm font-semibold">{t("settings.binsFor", { code: warehouse.code })}</div>
              <p className="text-xs text-slate-500">{t("settings.binsHint")}</p>
              {active && <form onSubmit={event => void createBin(event, warehouse)} className="mt-2 flex flex-wrap items-end gap-2">
                <label className="text-sm">{t("settings.binCode")}<input data-testid={`bin-field-code-${warehouse.code}`} required maxLength={64} className={`${field} mt-1 block w-40`} value={binDraft.code} onChange={event => setBinDraft({ ...binDraft, code: event.target.value })} /></label>
                <label className="text-sm">{t("settings.binName")}<input data-testid={`bin-field-name-${warehouse.code}`} maxLength={120} className={`${field} mt-1 block w-56`} value={binDraft.name} onChange={event => setBinDraft({ ...binDraft, name: event.target.value })} /></label>
                <button type="submit" data-testid={`bin-new-${warehouse.code}`} disabled={busy === `bin-${warehouse.id}` || !binDraft.code.trim()} className={small}><Plus size={13} />{t("settings.binAdd")}</button>
              </form>}
              {!active && <p className="mt-2 text-xs text-amber-700">{t("settings.warehouseInactiveBins")}</p>}
              <table className="mt-2 w-full text-sm" data-testid={`bin-table-${warehouse.code}`}><tbody>
                {(bins[warehouse.id] || []).length === 0 && <tr><td className="p-2 text-slate-500">{t("settings.binEmpty")}</td></tr>}
                {(bins[warehouse.id] || []).map(bin => <tr key={bin.id} className="border-t" data-testid={`bin-row-${warehouse.code}-${bin.code}`}>
                  <td className="p-2 font-medium">{bin.code}</td>
                  <td className="p-2">{nameCell(bin.id, bin.name || "", () => void renameBin(warehouse, bin), active, `bin-${warehouse.code}-${bin.code}`)}</td>
                  <td className="p-2"><StatusChip status={bin.status} testId={`bin-status-${warehouse.code}-${bin.code}`} /></td>
                  <td className="p-2 text-right">{(active || bin.status === "active") && <button type="button" data-testid={`bin-toggle-${warehouse.code}-${bin.code}`} disabled={busy === bin.id} className={small} onClick={() => void setBinStatus(warehouse, bin, bin.status !== "active")}>{bin.status === "active" ? t("settings.warehouseSetInactive") : t("settings.warehouseSetActive")}</button>}</td>
                </tr>)}
              </tbody></table>
            </td></tr>}
          </Fragment>;
        })}
      </tbody>
    </table></div>
  </section>;
}

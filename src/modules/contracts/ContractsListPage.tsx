import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AlarmClock, CalendarClock, FilePen, FileSignature, Plus, RefreshCw, Search } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Field, KpiCard, inputStyle } from "../../components/ui";
import { CONTRACT_TYPES } from "../../../shared/contract-status.mjs";
import { ContractTable } from "./ContractTable";
import {
  CONTRACT_PAGE_SIZE,
  ContractStateChip,
  ENDING_STATES,
  STATE_EXPLANATION,
  STATE_LABEL,
  TYPE_LABEL,
  contractErrorText,
  contractsApi,
  useContractCopy,
  type ContractList,
  type ContractState,
  type Person,
} from "./contractShared";

// The Contracts list and Ending soon (docs/contracts-module-design.md §3),
// laid out like the purchase-order list: cards, a search card with labelled
// filters, then the list card. Ending soon is the same table filtered to the
// contracts whose key date is inside their reminder window (or past the end
// of one that renews automatically), earliest key date first, never by a
// score (owner rule 2026-10-03). The cards count by state under every
// filter but the state, as the API counts them.

type SupplierOption = { id: string; name: string; code: string };
const LIST_STATES: ContractState[] = ["draft", "active", "notice_due", "ending", "past_end", "ended", "renewed", "terminated"];

export function ContractsListPage({ mode }: { mode: "all" | "ending" }) {
  const t = useContractCopy();
  const navigate = useNavigate();
  const ending = mode === "ending";
  const [data, setData] = useState<ContractList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [state, setState] = useState("");
  const [owner, setOwner] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  // Every owner seen so far, so choosing one does not empty the filter's own options.
  const [knownOwners, setKnownOwners] = useState<Person[]>([]);
  const sequence = useRef(0);
  const loadedOnce = useRef(false);

  const load = async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: String(CONTRACT_PAGE_SIZE), sort: ending ? "key_date" : "recent" });
      if (query.trim()) params.set("search", query.trim());
      if (type) params.set("type", type);
      if (ending) params.set("state", ENDING_STATES.join(","));
      else if (state) params.set("state", state);
      if (owner) params.set("ownerId", owner);
      if (supplierId) params.set("supplierId", supplierId);
      const next = await contractsApi.list(params);
      if (current !== sequence.current) return;
      setData(next);
      setKnownOwners((seen) => {
        const byId = new Map(seen.map((person) => [person.id, person]));
        for (const contract of next.contracts) if (contract.owner) byId.set(contract.owner.id, contract.owner);
        return [...byId.values()].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
      });
    } catch (caught) {
      if (current === sequence.current) setError(caught);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };
  // Filters apply as they change; typing waits for a short pause.
  useEffect(() => {
    const timer = setTimeout(load, loadedOnce.current ? 300 : 0);
    loadedOnce.current = true;
    return () => clearTimeout(timer);
  }, [query, type, state, owner, supplierId, mode]);
  useEffect(() => {
    apiJson<{ suppliers: Array<{ id: string; supplierName?: string; name?: string; supplierCode?: string }> }>("/api/master-data/suppliers")
      .then(({ suppliers: rows }) => setSuppliers((rows || []).map((row) => ({ id: row.id, name: String(row.supplierName || row.name || row.id), code: String(row.supplierCode || "") }))))
      .catch(() => setSuppliers([]));
  }, []);

  const counts = data?.counts;
  const contracts = data?.contracts || [];
  const filtered = Boolean(query || type || (!ending && state) || owner || supplierId);
  const total = ending ? data?.total ?? 0 : counts?.all ?? 0;
  const truncated = (data?.total ?? 0) > contracts.length;
  const canManage = Boolean(data?.access.manage);
  const resetFilters = () => { setQuery(""); setType(""); setState(""); setOwner(""); setSupplierId(""); };
  const newButton = (testId: string) => canManage ? (
    <button type="button" data-testid={testId} onClick={() => navigate("/app/contracts/new")} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white">
      <Plus size={13} /> {t("New contract")}
    </button>
  ) : null;
  const count = (value: number | undefined) => (counts ? String(value ?? 0) : "—");

  return (
    <div className="space-y-5" data-testid={ending ? "contracts-ending-page" : "contracts-list-page"}>
      {ending ? (
        <Card className="p-5" data-testid="contracts-ending-explained">
          <p className="text-xs" style={{ color: A.sub }}>{t("Earliest key date first, never by a score. A contract shows here once its key date is inside its own reminder window.")}</p>
          <ul className="mt-3 space-y-2">
            {ENDING_STATES.map((value) => (
              <li key={value} className="flex flex-wrap items-center gap-2 text-xs" style={{ color: A.label }}>
                <ContractStateChip state={value} testId="contract-state-legend" />
                <span className="tabular-nums font-semibold">{count(counts?.[value])}</span>
                <span style={{ color: A.sub }}>{t(STATE_EXPLANATION[value] || "")}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label={t("Active")} value={counts ? String(counts.active + counts.notice_due + counts.ending + counts.past_end) : "—"} sub={t("Signed and in force")} icon={FileSignature} color={A.green} />
          <KpiCard label={t("Ending soon")} value={count(counts?.ending)} sub={t("End date within the reminder window")} icon={CalendarClock} color={A.orange} />
          <KpiCard label={t("Notice due")} value={count(counts?.notice_due)} sub={t("Renews automatically unless notice is given")} icon={AlarmClock} color={A.orange} />
          <KpiCard label={t("Drafts")} value={count(counts?.draft)} sub={t("Not active yet")} icon={FilePen} color={A.gray1} />
        </div>
      )}

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{t("Contract search")}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{t("Search contracts by number, their reference, title, supplier, type, state and owner.")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={resetFilters} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>{t("Reset")}</button>
            <button type="button" onClick={load} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>
              <RefreshCw size={13} /> {t("Refresh")}
            </button>
            {newButton("contract-new")}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
          <Field label={t("Search")}>
            <label className="flex items-center gap-2" style={{ ...inputStyle, paddingTop: 0, paddingBottom: 0 }}>
              <Search size={14} style={{ color: A.gray2 }} />
              <input aria-label={t("Search contracts")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Number, title or supplier")} className="h-9 min-w-0 flex-1 bg-transparent outline-none" />
            </label>
          </Field>
          <Field label={t("Type")}>
            <select aria-label={t("Type filter")} value={type} onChange={(event) => setType(event.target.value)} style={inputStyle}>
              <option value="">{t("All types")}</option>
              {CONTRACT_TYPES.map((value) => <option key={value} value={value}>{t(TYPE_LABEL[value])}</option>)}
            </select>
          </Field>
          {!ending && (
            <Field label={t("State")}>
              <select aria-label={t("State filter")} value={state} onChange={(event) => setState(event.target.value)} style={inputStyle}>
                <option value="">{t("All states")}</option>
                {LIST_STATES.map((value) => <option key={value} value={value}>{t(STATE_LABEL[value])}{counts ? ` (${counts[value] ?? 0})` : ""}</option>)}
              </select>
            </Field>
          )}
          <Field label={t("Owner")}>
            <select aria-label={t("Owner filter")} value={owner} onChange={(event) => setOwner(event.target.value)} style={inputStyle}>
              <option value="">{t("All owners")}</option>
              <option value="me">{t("Mine")}</option>
              <option value="none">{t("No owner")}</option>
              {knownOwners.map((person) => <option key={person.id} value={person.id}>{person.name || person.id}</option>)}
            </select>
          </Field>
          <Field label={t("Supplier")}>
            <select aria-label={t("Supplier filter")} value={supplierId} onChange={(event) => setSupplierId(event.target.value)} style={inputStyle}>
              <option value="">{t("All suppliers")}</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: A.label }}>{t(ending ? "Contracts to act on" : "Contract list")}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: A.sub }} data-testid="contracts-count">
              {t(total === 1 ? "1 contract, {shown} shown" : "{total} contracts, {shown} shown", { total, shown: contracts.length })}
            </div>
          </div>
        </div>
        {truncated && <p className="px-5 pt-3 text-[11px]" style={{ color: A.sub }}>{t("Only the first {count} are shown. Narrow the search to see the rest.", { count: contracts.length })}</p>}
        {error ? (
          <div className="p-8 text-center">
            <div role="alert" className="text-sm" style={{ color: A.red }}>{t("Could not load contracts.")} {contractErrorText(error, t)}</div>
            <button type="button" onClick={load} className="mt-3 text-xs text-blue-600">{t("Retry")}</button>
          </div>
        ) : loading && !data ? (
          <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{t("Loading…")}</div>
        ) : contracts.length === 0 ? (
          <div className="py-14 text-center text-sm" style={{ color: A.sub }} data-testid="contracts-empty">
            {filtered ? (
              <>
                <span className="font-semibold" style={{ color: A.label }}>{t("No contracts match these filters")}</span>
                <br />
                <span className="text-xs">{t("Reset the filters to see every contract.")}</span>
              </>
            ) : ending ? (
              <>
                <span className="font-semibold" style={{ color: A.label }}>{t("Nothing to act on now")}</span>
                <br />
                <span className="text-xs">{t("Contracts whose notice deadline or end date is inside their reminder window are listed here.")}</span>
              </>
            ) : (
              <>
                <span>{t("No contracts yet. Record a signed agreement to track its dates.")}</span>
                {canManage && <div className="mt-4 flex justify-center">{newButton("contract-new-empty")}</div>}
              </>
            )}
          </div>
        ) : (
          <ContractTable contracts={contracts} canManage={canManage} />
        )}
      </Card>
    </div>
  );
}

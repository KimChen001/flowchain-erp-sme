import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, FileJson, FileSpreadsheet, ShieldCheck, Upload } from "lucide-react";
import { A, Card } from "../../components/ui";
import { apiJson, AUTH_TOKEN_KEY } from "../../lib/api-client";

type SourceMode = "csv" | "xlsx" | "table" | "json";
type Profile = {
  sourceFormat: string; encoding: string | null; delimiter: string | null; selectedSheet: string | null;
  rowCount: number; columnCount: number; sourceFieldNames: string[]; sampleRows: Array<Record<string, unknown>>;
  warnings: Array<{ code?: string }>; parserVersion: string;
};
type Batch = {
  id: string; status: string; recordCount: number; validRecordCount: number; warningCount: number; errorCount: number;
};
type SchemaField = {
  fieldPath: string; label: string; dataType: string; required: boolean; custom?: boolean;
};
type Suggestion = {
  sourceField: string; targetFieldPath: string | null; suggestionSource: string; confidenceTier: string; explanation: string;
};
type IntakeRecord = {
  id: string; rowNumber: number; status: string; sourcePayload: Record<string, unknown>;
  normalizedPayload?: { fields?: Record<string, unknown>; customFields?: Record<string, unknown> };
  normalizationEvidence?: Array<Record<string, unknown>>;
};
type IntakeIssue = { id: string; recordId: string; severity: string; code: string; field?: string; message: string };

const steps = ["Add Source", "Profile", "Map", "Validate", "Review"];
const sourceModes: Array<{ id: SourceMode; label: string; icon: typeof Upload }> = [
  { id: "csv", label: "Upload CSV", icon: Upload },
  { id: "xlsx", label: "Upload XLSX", icon: FileSpreadsheet },
  { id: "table", label: "Paste Table", icon: FileSpreadsheet },
  { id: "json", label: "Paste JSON", icon: FileJson },
];
const button = "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400";
const fileBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error);
  reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
  reader.readAsDataURL(file);
});

export default function UniversalIntakePage() {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<SourceMode>("csv");
  const [recordType, setRecordType] = useState("supplier");
  const [file, setFile] = useState<File | null>(null);
  const [paste, setPaste] = useState("");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [schema, setSchema] = useState<SchemaField[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [transforms, setTransforms] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [records, setRecords] = useState<IntakeRecord[]>([]);
  const [issues, setIssues] = useState<IntakeIssue[]>([]);
  const [reviewFilter, setReviewFilter] = useState("all");
  const [reviewDecision, setReviewDecision] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const standardFields = useMemo(() => schema.filter(field => !field.custom), [schema]);
  const customFields = useMemo(() => schema.filter(field => field.custom), [schema]);

  async function addSource() {
    setBusy(true); setError("");
    try {
      let result: { batch: Batch; profile: Profile };
      if (mode === "table" || mode === "json") {
        result = await apiJson(`/api/intake/paste/${mode}`, {
          method: "POST",
          body: JSON.stringify({ recordType, content: paste }),
        });
      } else {
        if (!file) throw new Error(`Choose a ${mode.toUpperCase()} file.`);
        const artifact = await apiJson<{ id: string }>("/api/intake/artifacts", {
          method: "POST",
          body: JSON.stringify({
            sourceType: "manual_upload",
            originalFilename: file.name,
            mimeType: mode === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv",
            contentBase64: await fileBase64(file),
          }),
        });
        result = await apiJson("/api/intake/artifacts/profile", {
          method: "POST",
          body: JSON.stringify({ artifactId: artifact.id, recordType, sourceFormat: mode }),
        });
      }
      setBatch(result.batch); setProfile(result.profile); setStep(1);
    } catch (next) {
      setError(next instanceof Error ? next.message : "Source profiling failed.");
    } finally { setBusy(false); }
  }

  async function loadMapping() {
    if (!batch) return;
    setBusy(true); setError("");
    try {
      const [resolved, proposed] = await Promise.all([
        apiJson<{ fields: SchemaField[] }>(`/api/intake/batches/${batch.id}/schema`),
        apiJson<{ suggestions: Suggestion[] }>(`/api/intake/batches/${batch.id}/mapping-suggestions`),
      ]);
      setSchema(resolved.fields);
      setSuggestions(proposed.suggestions);
      setTargets(Object.fromEntries(proposed.suggestions.map(value => [value.sourceField, value.targetFieldPath || ""])));
      setTransforms(Object.fromEntries(proposed.suggestions.map(value => [value.sourceField, "trim"])));
      setStep(2);
    } catch (next) { setError(next instanceof Error ? next.message : "Mapping targets are unavailable."); }
    finally { setBusy(false); }
  }

  async function normalizeAndValidate() {
    if (!batch) return;
    setBusy(true); setError("");
    try {
      await apiJson(`/api/intake/batches/${batch.id}/mapping`, {
        method: "POST",
        body: JSON.stringify({
          mappings: suggestions.filter(value => targets[value.sourceField]).map(value => ({
            sourceField: value.sourceField,
            targetFieldPath: targets[value.sourceField],
            transformType: transforms[value.sourceField] || "trim",
            defaultValue: defaults[value.sourceField] || undefined,
          })),
        }),
      });
      await apiJson(`/api/intake/batches/${batch.id}/normalize`, { method: "POST", body: "{}" });
      const result = await apiJson<{ batch: Batch; counts: Record<string, number> }>(`/api/intake/batches/${batch.id}/validate`, { method: "POST", body: "{}" });
      setBatch(result.batch); setCounts(result.counts); setStep(3);
    } catch (next) { setError(next instanceof Error ? next.message : "Normalization or validation failed."); }
    finally { setBusy(false); }
  }

  async function loadReview() {
    if (!batch) return;
    setBusy(true); setError("");
    try {
      const [recordResult, issueResult] = await Promise.all([
        apiJson<{ records: IntakeRecord[] }>(`/api/intake/batches/${batch.id}/records?limit=100`),
        apiJson<{ issues: IntakeIssue[] }>(`/api/intake/batches/${batch.id}/issues?limit=500`),
      ]);
      setRecords(recordResult.records); setIssues(issueResult.issues); setStep(4);
    } catch (next) { setError(next instanceof Error ? next.message : "Review records are unavailable."); }
    finally { setBusy(false); }
  }

  async function toggleExcluded(record: IntakeRecord) {
    if (!batch) return;
    await apiJson(`/api/intake/records/${record.id}/${record.status === "excluded" ? "restore" : "exclude"}`, { method: "POST", body: "{}" });
    await loadReview();
  }

  async function revalidate() {
    if (!batch) return;
    setBusy(true); setError("");
    try {
      const result = await apiJson<{ batch: Batch; counts: Record<string, number> }>(`/api/intake/batches/${batch.id}/validate`, { method: "POST", body: "{}" });
      setBatch(result.batch); setCounts(result.counts);
      await loadReview();
    } catch (next) { setError(next instanceof Error ? next.message : "Revalidation failed."); }
    finally { setBusy(false); }
  }

  async function decideReview(decision: "approve" | "reject") {
    if (!batch) return;
    setBusy(true); setError("");
    try {
      const review = await apiJson<{ id: string }>(`/api/intake/batches/${batch.id}/reviews`, { method: "POST", body: "{}" });
      await apiJson(`/api/intake/reviews/${review.id}/${decision}`, { method: "POST", body: JSON.stringify({ comment: "Structured preview review decision" }) });
      setReviewDecision(decision === "approve" ? "Preview approved" : "Preview rejected");
    } catch (next) { setError(next instanceof Error ? next.message : "Review decision failed."); }
    finally { setBusy(false); }
  }

  async function downloadIssueReport() {
    if (!batch) return;
    setError("");
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY) || "";
      const response = await fetch(`/api/intake/batches/${batch.id}/issue-report`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error((await response.text()) || `Issue report download failed: ${response.status}`);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `intake-issues-${batch.id}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch (next) {
      setError(next instanceof Error ? next.message : "Issue report download failed.");
    }
  }

  useEffect(() => {
    setFile(null); setPaste(""); setError("");
  }, [mode]);

  return <div className="space-y-5" data-testid="structured-intake-wizard">
    <div>
      <div className="text-[11px] font-semibold tracking-wide" style={{ color: A.blue }}>PHASE 5.4B · STRUCTURED PREVIEW</div>
      <h1 className="mt-1 text-2xl font-semibold" style={{ color: A.label }}>Structured Smart Intake</h1>
      <p className="mt-2 max-w-3xl text-sm" style={{ color: A.sub }}>CSV、XLSX、Paste Table 与 Paste JSON 进入同一受控 Artifact → Mapping → Validation → Review 链路。</p>
    </div>

    <Card className="p-4" style={{ background: "#fff9ed" }}>
      <div className="flex gap-3"><ShieldCheck size={20} style={{ color: A.orange }} /><div>
        <div className="text-sm font-semibold">Business commit adapters are not available in Phase 5.4B.</div>
        <div className="mt-1 text-xs" style={{ color: A.sub }}>No Supplier, Item, or Customer will be created. All normalized records are preview truth only.</div>
      </div></div>
    </Card>

    <div className="grid grid-cols-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
      {steps.map((label, index) => <div key={label} className={`px-2 py-3 text-center text-xs font-medium ${index === step ? "bg-blue-600 text-white" : index < step ? "bg-blue-50 text-blue-700" : "text-slate-400"}`}><span className="mr-1">{index < step ? "✓" : index + 1}.</span>{label}</div>)}
    </div>

    {error && <Card className="p-4"><div className="flex gap-2 text-sm text-red-700"><AlertCircle size={18} />{error}</div></Card>}

    {step === 0 && <Card className="p-5">
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <div><label className="text-sm font-medium">Record type</label><select className={`${input} mt-2`} value={recordType} onChange={event => setRecordType(event.target.value)}><option value="supplier">Supplier</option><option value="item">Item</option><option value="customer">Customer</option></select>
          <div className="mt-5 space-y-2">{sourceModes.map(option => <button key={option.id} type="button" onClick={() => setMode(option.id)} className={`flex w-full items-center gap-2 rounded-lg border p-3 text-left text-sm ${mode === option.id ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200"}`}><option.icon size={16} />{option.label}</button>)}</div>
        </div>
        <div className="rounded-xl border border-dashed border-slate-300 p-5">
          {(mode === "csv" || mode === "xlsx") ? <label className="block"><span className="text-sm font-medium">Choose {mode.toUpperCase()}</span><input data-testid="intake-file" className="mt-3 block w-full text-sm" type="file" accept={mode === "xlsx" ? ".xlsx" : ".csv,text/csv"} onChange={event => setFile(event.target.files?.[0] || null)} /></label>
            : <label className="block"><span className="text-sm font-medium">{mode === "json" ? "Paste an object array or { records: [] }" : "Paste a table copied from a spreadsheet"}</span><textarea data-testid="intake-paste" className={`${input} mt-3 min-h-64 font-mono`} value={paste} onChange={event => setPaste(event.target.value)} placeholder={mode === "json" ? '[{\"code\":\"SUP-001\",\"name\":\"Suzhou Components\"}]' : "code\tname\nSUP-001\tSuzhou Components"} /></label>}
          <button data-testid="intake-profile-source" type="button" onClick={() => void addSource()} disabled={busy || ((mode === "csv" || mode === "xlsx") ? !file : !paste.trim())} className={`${button} mt-5 text-white`} style={{ background: A.blue }}>{busy ? "Profiling…" : "Register artifact and profile"}</button>
        </div>
      </div>
    </Card>}

    {step === 1 && profile && <Card className="p-5" data-testid="intake-profile">
      <h2 className="text-base font-semibold">Source profile</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">{[
        ["Format", profile.sourceFormat], ["Encoding", profile.encoding || "n/a"], ["Sheet", profile.selectedSheet || "n/a"],
        ["Rows", profile.rowCount], ["Columns", profile.columnCount], ["Parser", profile.parserVersion],
      ].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 truncate text-sm font-medium">{value}</div></div>)}</div>
      <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="bg-slate-50"><tr>{profile.sourceFieldNames.map(field => <th key={field} className="px-3 py-2">{field}</th>)}</tr></thead><tbody>{profile.sampleRows.map((row, index) => <tr key={index} className="border-t border-slate-100">{profile.sourceFieldNames.map(field => <td key={field} className="max-w-64 truncate px-3 py-2">{String(row[field] ?? "")}</td>)}</tr>)}</tbody></table></div>
      <button type="button" disabled={busy} onClick={() => void loadMapping()} className={`${button} mt-5 text-white`} style={{ background: A.blue }}>Continue to mapping</button>
    </Card>}

    {step === 2 && <Card className="p-5" data-testid="intake-mapping">
      <h2 className="text-base font-semibold">Confirm deterministic mapping</h2>
      <p className="mt-1 text-xs text-slate-500">Targets come from the immutable batch schema snapshot. Company Custom Fields are grouped separately.</p>
      <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[1100px] text-left text-sm"><thead className="bg-slate-50"><tr>{["Source Column", "Suggested Target", "Suggestion Source", "Required", "Data Type", "Transform", "Default", "Confirmed"].map(label => <th key={label} className="px-3 py-2">{label}</th>)}</tr></thead><tbody>{suggestions.map(suggestion => {
        const selected = schema.find(field => field.fieldPath === targets[suggestion.sourceField]);
        return <tr key={suggestion.sourceField} className="border-t border-slate-100"><td className="px-3 py-2 font-medium">{suggestion.sourceField}</td><td className="px-3 py-2"><select aria-label={`Map ${suggestion.sourceField}`} className={input} value={targets[suggestion.sourceField] || ""} onChange={event => setTargets(current => ({ ...current, [suggestion.sourceField]: event.target.value }))}><option value="">Ignored</option><optgroup label="Standard Fields">{standardFields.map(field => <option key={field.fieldPath} value={field.fieldPath}>{field.label}</option>)}</optgroup><optgroup label="Company Custom Fields">{customFields.map(field => <option key={field.fieldPath} value={field.fieldPath}>{field.label}</option>)}</optgroup></select></td><td className="px-3 py-2">{suggestion.suggestionSource} · {suggestion.confidenceTier}</td><td className="px-3 py-2">{selected?.required ? "Yes" : "No"}</td><td className="px-3 py-2">{selected?.dataType || "—"}</td><td className="px-3 py-2"><select aria-label={`Transform ${suggestion.sourceField}`} className={input} value={transforms[suggestion.sourceField] || "trim"} onChange={event => setTransforms(current => ({ ...current, [suggestion.sourceField]: event.target.value }))}>{["identity", "trim", "uppercase", "lowercase", "integer", "decimal", "boolean", "date", "currency_code"].map(value => <option key={value}>{value}</option>)}</select></td><td className="px-3 py-2"><input aria-label={`Default ${suggestion.sourceField}`} className={input} value={defaults[suggestion.sourceField] || ""} onChange={event => setDefaults(current => ({ ...current, [suggestion.sourceField]: event.target.value }))} /></td><td className="px-3 py-2">{selected && <Check size={16} className="text-emerald-600" />}</td></tr>;
      })}</tbody></table></div>
      <button type="button" disabled={busy} onClick={() => void normalizeAndValidate()} className={`${button} mt-5 text-white`} style={{ background: A.blue }}>{busy ? "Processing…" : "Confirm, normalize and validate"}</button>
    </Card>}

    {step === 3 && counts && <Card className="p-5" data-testid="intake-validation">
      <h2 className="text-base font-semibold">Validation result</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-4 lg:grid-cols-8">{["total", "valid", "warnings", "errors", "excluded", "duplicates", "existingIdentical", "existingDifferent"].map(key => <div key={key} className="rounded-lg bg-slate-50 p-4"><div className="text-xs text-slate-500">{key.replace(/([A-Z])/g, " $1")}</div><div className="mt-1 text-xl font-semibold">{counts[key] || 0}</div></div>)}</div>
      {batch && <button type="button" className="mt-5 text-sm text-blue-600" onClick={() => void downloadIssueReport()}>Download issue report</button>}
      <div><button type="button" disabled={busy} onClick={() => void loadReview()} className={`${button} mt-5 text-white`} style={{ background: A.blue }}>Review normalized records</button></div>
    </Card>}

    {step === 4 && <Card className="p-5" data-testid="intake-review">
      <h2 className="text-base font-semibold">Canonical review</h2>
      <div className="mt-4 flex flex-wrap gap-2">{["all", "valid", "warning", "invalid", "excluded"].map(value => <button key={value} type="button" className={`${button} border ${reviewFilter === value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200"}`} onClick={() => setReviewFilter(value)}>{value}</button>)}</div>
      <div className="mt-4 space-y-3">{records.filter(record => reviewFilter === "all" || record.status === reviewFilter).map(record => <div key={record.id} className="rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-medium">Row {record.rowNumber} · <span className={record.status === "invalid" ? "text-red-600" : "text-emerald-700"}>{record.status}</span></div><button type="button" className={`${button} border border-slate-200`} onClick={() => void toggleExcluded(record)}>{record.status === "excluded" ? "Restore" : "Exclude"}</button></div>
        <div className="mt-3 grid gap-3 lg:grid-cols-4"><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">Source{`\n`}{JSON.stringify(record.sourcePayload, null, 2)}</pre><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">Normalized{`\n`}{JSON.stringify(record.normalizedPayload?.fields || {}, null, 2)}</pre><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">customFields{`\n`}{JSON.stringify(record.normalizedPayload?.customFields || {}, null, 2)}</pre><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">Evidence{`\n`}{JSON.stringify(record.normalizationEvidence || [], null, 2)}</pre></div>
        <div className="mt-3 space-y-1">{issues.filter(issue => issue.recordId === record.id).map(issue => <div key={issue.id} className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">{issue.severity} · {issue.code}{issue.field ? ` · ${issue.field}` : ""}: {issue.message}</div>)}</div>
      </div>)}</div>
      <div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={busy} className={`${button} border border-slate-200`} onClick={() => void revalidate()}>Re-run validation</button><button type="button" disabled={busy} className={`${button} border border-slate-200`} onClick={() => void decideReview("approve")}>Approve preview</button><button type="button" disabled={busy} className={`${button} border border-slate-200`} onClick={() => void decideReview("reject")}>Reject preview</button><button disabled className={`${button} border border-slate-200`}>Business commit unavailable in Phase 5.4B</button></div>
      {reviewDecision && <div className="mt-3 text-sm text-emerald-700">{reviewDecision}. No business object was written.</div>}
    </Card>}
  </div>;
}

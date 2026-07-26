import { useEffect, useState } from "react";
import { Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { A, Card } from "../../components/ui";
import { apiJson } from "../../lib/api-client";

type Option = { value: string; label: string; position: number; active: boolean };
type Revision = {
  id: string; version: number; label: string; description?: string | null; dataType: string;
  required: boolean; options: Option[];
};
type Definition = {
  id: string; entityType: string; fieldKey: string; fieldPath: string; status: string;
  currentRevisionId?: string | null; revisions: Revision[];
};
const fieldClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400";
const buttonClass = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

export default function CustomFieldsSettings() {
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [entityType, setEntityType] = useState("supplier");
  const [fieldKey, setFieldKey] = useState("");
  const [label, setLabel] = useState("");
  const [dataType, setDataType] = useState("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("A|Grade A\nB|Grade B");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setBusy(true); setError("");
    try {
      const result = await apiJson<{ customFields: Definition[] }>("/api/custom-fields");
      setDefinitions(result.customFields);
    } catch (next) { setError(next instanceof Error ? next.message : "Custom fields are unavailable."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  async function create() {
    setBusy(true); setError("");
    try {
      await apiJson("/api/custom-fields", {
        method: "POST",
        body: JSON.stringify({
          entityType, fieldKey, label, dataType, required,
          ...(dataType === "single_select" ? {
            options: options.split(/\r?\n/).filter(Boolean).map((line, position) => {
              const [value, optionLabel = value] = line.split("|");
              return { value: value.trim(), label: optionLabel.trim(), position };
            }),
          } : {}),
        }),
      });
      setFieldKey(""); setLabel(""); await load();
    } catch (next) { setError(next instanceof Error ? next.message : "Custom field could not be created."); setBusy(false); }
  }

  async function action(definition: Definition, actionName: "publish" | "retire" | "revisions") {
    setBusy(true); setError("");
    try {
      const latest = definition.revisions[0];
      await apiJson(`/api/custom-fields/${definition.id}/${actionName}`, {
        method: "POST",
        body: JSON.stringify(actionName === "revisions" ? {
          label: latest.label,
          description: latest.description,
          dataType: latest.dataType,
          required: latest.required,
          options: latest.options.map(({ value, label: optionLabel, position, active }) => ({ value, label: optionLabel, position, active })),
        } : {}),
      });
      await load();
    } catch (next) { setError(next instanceof Error ? next.message : "Custom field action failed."); setBusy(false); }
  }

  return <div className="space-y-5" data-testid="custom-fields-settings">
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-semibold text-blue-600">SETTINGS · DATA MODEL</div><h2 className="mt-1 text-xl font-semibold">Custom Fields</h2><p className="mt-1 text-sm text-slate-500">Custom fields become available to Structured Intake after publication.</p></div><button type="button" className={`${buttonClass} border border-slate-200`} onClick={() => void load()} disabled={busy}><RefreshCw size={15} className={busy ? "animate-spin" : ""} />Refresh</button></div>
      <div className="mt-4 flex gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900"><ShieldCheck size={16} />Operational form display and workflow conditions are planned for later phases.</div>
      {error && <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    </Card>

    <Card className="p-5">
      <h3 className="font-semibold">Create draft field</h3>
      <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">Entity<select className={`${fieldClass} mt-1`} value={entityType} onChange={event => setEntityType(event.target.value)}><option>supplier</option><option>item</option><option>customer</option></select></label>
        <label className="text-sm">Stable fieldKey<input className={`${fieldClass} mt-1 font-mono`} value={fieldKey} onChange={event => setFieldKey(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} placeholder="strategic_grade" /></label>
        <label className="text-sm">Label<input className={`${fieldClass} mt-1`} value={label} onChange={event => setLabel(event.target.value)} placeholder="Strategic Grade" /></label>
        <label className="text-sm">Type<select className={`${fieldClass} mt-1`} value={dataType} onChange={event => setDataType(event.target.value)}>{["text", "long_text", "integer", "decimal", "date", "boolean", "single_select"].map(type => <option key={type}>{type}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={event => setRequired(event.target.checked)} />Required</label>
        {dataType === "single_select" && <label className="text-sm md:col-span-2">Options (value|label)<textarea className={`${fieldClass} mt-1 font-mono`} rows={4} value={options} onChange={event => setOptions(event.target.value)} /></label>}
      </div>
      <button data-testid="custom-field-create" type="button" disabled={busy || !fieldKey || !label} onClick={() => void create()} className={`${buttonClass} mt-4 text-white`} style={{ background: A.blue }}><Plus size={15} />Create draft</button>
    </Card>

    <Card className="p-5">
      <h3 className="font-semibold">Definitions</h3>
      <div className="mt-4 space-y-3">{definitions.map(definition => {
        const current = definition.revisions.find(revision => revision.id === definition.currentRevisionId) || definition.revisions[0];
        return <div key={definition.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-medium">{current?.label || definition.fieldKey}</div><div className="mt-1 font-mono text-xs text-slate-500">{definition.fieldPath}</div><div className="mt-2 text-xs text-slate-500">{current?.dataType} · revision {current?.version} · {definition.status}</div>{current?.options.length > 0 && <div className="mt-2 text-xs">Options: {current.options.filter(option => option.active).map(option => `${option.value} (${option.label})`).join(", ")}</div>}</div><div className="flex flex-wrap gap-2">{definition.status !== "retired" && <button className={`${buttonClass} border border-slate-200`} onClick={() => void action(definition, "revisions")}>New revision</button>}{definition.status !== "published" && definition.status !== "retired" && <button className={`${buttonClass} bg-blue-600 text-white`} onClick={() => void action(definition, "publish")}>Publish</button>}{definition.status !== "retired" && <button className={`${buttonClass} border border-red-200 text-red-700`} onClick={() => void action(definition, "retire")}>Retire</button>}</div></div></div>;
      })}{!definitions.length && !busy && <div className="py-8 text-center text-sm text-slate-500">No custom field definitions.</div>}</div>
    </Card>
  </div>;
}

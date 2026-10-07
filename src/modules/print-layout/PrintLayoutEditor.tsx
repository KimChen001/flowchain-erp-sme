import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Eraser, Printer, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { useUnsavedChanges } from "../../components/navigation/UnsavedChangesProvider";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import PrintCanvas from "./PrintCanvas";
import PrintElementInspector from "./PrintElementInspector";
import PrintInstancePanel, { printInstanceFields } from "./PrintInstancePanel";
import PrintLayoutImportBanner from "./PrintLayoutImportBanner";
import { printFieldOptions } from "./printDataAdapters";
import { clearPrintInstance, loadPrintInstance, savePrintInstance } from "./printInstanceStorage";
import { defaultPrintTemplate } from "./printLayoutPresets";
import { fetchWorkspacePrintSettings, loadLastTemplate, restoreDefaultTemplate, savePrintTemplate, savePrintTemplateAs, templatesFor, workspaceLayouts } from "./printLayoutStorage";
import { PAGE_SIZES, type PrintDocumentData, type PrintDocumentType, type PrintElementType, type PrintLayoutElement, type PrintLayoutTemplate } from "./printLayoutTypes";
import "./print-layout.css";

// While the editor is open the body carries this class, and only then do the
// print rules in print-layout.css hide the rest of the page.
export const PRINT_LAYOUT_BODY_CLASS = "fc-print-layout-open";

function instanceElementId(key: string) { return `instance-${key}`; }

function withInstanceFields(template: PrintLayoutTemplate, documentType: PrintDocumentType) {
  const existing = new Set(template.elements.map((element) => element.id));
  const startY = Math.max(template.page.margin + 220, template.page.height - 265);
  const additions = printInstanceFields[documentType]
    .filter((field) => !existing.has(instanceElementId(field.key)))
    .map((field, index): PrintLayoutElement => ({
      id: instanceElementId(field.key), type: "comment", title: field.label, placeholder: `${field.label}（本次打印）`,
      contentMode: "instance", x: template.page.margin, y: startY + index * 54,
      width: template.page.width - template.page.margin * 2, height: 46, visible: true, draggable: true, resizable: true,
      style: { fontSize: 11, lineHeight: 1.45, align: "left", bordered: false },
    }));
  return { ...template, elements: [...template.elements, ...additions] };
}

function createElement(type: PrintElementType, index: number): PrintLayoutElement {
  const definitions: Record<string, { title: string; value?: string; mode?: "static" | "instance"; width: number; height: number }> = {
    text: { title: "自由文本", value: "请输入固定文字", mode: "static", width: 320, height: 54 },
    comment: { title: "Comments", mode: "instance", width: 420, height: 90 },
    remark: { title: "备注", mode: "instance", width: 420, height: 80 },
    terms: { title: "条款", value: "请在此输入固定条款", mode: "static", width: 520, height: 110 },
    signature: { title: "签字栏", value: "签字：________________    日期：____________", mode: "static", width: 460, height: 58 },
    line: { title: "横线", width: 500, height: 20 },
  };
  const definition = definitions[type] || definitions.text;
  return {
    id: `${type}-${Date.now()}-${index}`, type, title: definition.title, value: definition.value,
    placeholder: type === "comment" ? "输入本次打印 Comments" : undefined,
    contentMode: definition.mode, x: 72 + (index % 3) * 18, y: 300 + (index % 6) * 65,
    width: definition.width, height: definition.height, visible: true, draggable: true, resizable: true,
    style: { fontSize: type === "terms" || type === "comment" ? 11 : 12, lineHeight: 1.45, align: "left", bordered: type === "comment" },
  };
}

type WorkspaceState = "loading" | "ready" | "failed";
type Access = { tenantId: string; canManage: boolean };
type FailureDetails = { field?: string; limit?: number };

export default function PrintLayoutEditor({ open, documentType, documentNo, data, onClose }: {
  open: boolean;
  documentType: PrintDocumentType;
  documentNo: string;
  data: PrintDocumentData;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [template, setTemplate] = useState<PrintLayoutTemplate>(() => withInstanceFields(defaultPrintTemplate(documentType), documentType));
  const [selectedId, setSelectedId] = useState("title");
  const [availableTemplates, setAvailableTemplates] = useState<PrintLayoutTemplate[]>([]);
  const [instanceValues, setInstanceValues] = useState<Record<string, string>>({});
  const [savedTemplateSnapshot, setSavedTemplateSnapshot] = useState("");
  const [savedInstanceSnapshot, setSavedInstanceSnapshot] = useState("{}");
  const [closePrompt, setClosePrompt] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>("loading");
  const [companyName, setCompanyName] = useState("");
  const [access, setAccess] = useState<Access | null>(null);
  const [saving, setSaving] = useState(false);

  // Scope the print rules to the time the editor is open.
  useEffect(() => {
    if (!open) return;
    document.body.classList.add(PRINT_LAYOUT_BODY_CLASS);
    return () => document.body.classList.remove(PRINT_LAYOUT_BODY_CLASS);
  }, [open]);

  function showTemplate(next: PrintLayoutTemplate) {
    const withFields = withInstanceFields(next, documentType);
    setTemplate(withFields);
    setSavedTemplateSnapshot(JSON.stringify(withFields));
  }

  // The built-in template first; the workspace's saved templates once read.
  useEffect(() => {
    if (!open) return;
    const instance = loadPrintInstance(documentType, documentNo);
    showTemplate(defaultPrintTemplate(documentType));
    setInstanceValues(instance.values);
    setSavedInstanceSnapshot(JSON.stringify(instance.values));
    setAvailableTemplates(templatesFor(documentType, []));
    setSelectedId("title");
    setClosePrompt(false);
    setWorkspaceState("loading");
    let alive = true;
    Promise.all([
      fetchWorkspacePrintSettings(),
      apiJson<{ tenantId?: string; effectivePermissions?: string[] }>("/api/authorization/context").catch(() => null),
    ]).then(([settings, context]) => {
      if (!alive) return;
      const layouts = workspaceLayouts(settings.documents);
      showTemplate(loadLastTemplate(documentType, layouts));
      setAvailableTemplates(templatesFor(documentType, layouts));
      setCompanyName(settings.companyName);
      setAccess({ tenantId: context?.tenantId || "", canManage: Boolean(context?.effectivePermissions?.includes("settings.workspace.manage")) });
      setWorkspaceState("ready");
    }).catch(() => {
      if (!alive) return;
      setAccess(null);
      setWorkspaceState("failed");
    });
    return () => { alive = false; };
  }, [documentNo, documentType, open]);

  // The company printed is the recorded one: the letterhead, else the workspace.
  const printData = useMemo<PrintDocumentData>(() => ({ ...data, companyName: data.companyName || companyName }), [companyName, data]);
  const canSave = workspaceState === "ready" && Boolean(access?.canManage);
  const selected = useMemo(() => template.elements.find((element) => element.id === selectedId), [selectedId, template.elements]);
  // Someone who cannot save templates may still adjust the layout for one print; that is not an unsaved template.
  const templateDirty = Boolean(open && canSave && savedTemplateSnapshot && JSON.stringify(template) !== savedTemplateSnapshot);
  const instanceDirty = Boolean(open && JSON.stringify(instanceValues) !== savedInstanceSnapshot);
  const anyDirty = templateDirty || instanceDirty;

  function updateElement(id: string, patch: Partial<PrintLayoutElement>) {
    setTemplate((current) => ({ ...current, elements: current.elements.map((element) => element.id === id ? { ...element, ...patch } : element) }));
  }

  function changeSelected(patch: Partial<PrintLayoutElement>) {
    if (!selected) return;
    if (patch.contentMode === "instance" && !instanceValues[selected.id] && selected.value) {
      setInstanceValues((current) => ({ ...current, [selected.id]: selected.value || "" }));
      patch = { ...patch, value: "" };
    }
    updateElement(selected.id, patch);
  }

  function changeOrientation(orientation: "portrait" | "landscape") {
    if (template.page.orientation === orientation) return;
    const nextSize = PAGE_SIZES[orientation];
    const xRatio = nextSize.width / template.page.width;
    const yRatio = nextSize.height / template.page.height;
    setTemplate((current) => ({
      ...current,
      page: { ...current.page, orientation, ...nextSize },
      elements: current.elements.map((element) => ({
        ...element,
        x: Math.round(element.x * xRatio), y: Math.round(element.y * yRatio),
        width: Math.max(40, Math.min(nextSize.width, Math.round(element.width * xRatio))),
        height: Math.max(20, Math.min(nextSize.height, Math.round(element.height * yRatio))),
      })),
    }));
  }

  // Why a save failed, from the shared check here or the same check on the server.
  function describeFailure(error: unknown) {
    const local = error as { code?: string; details?: unknown; message?: string };
    const details = (error instanceof ApiError ? error.payload.details : local.details) as FailureDetails | undefined;
    const code = error instanceof ApiError ? error.code : local.code;
    if (error instanceof ApiError && error.status === 403) return t("printLayout.saveForbidden");
    if (code === "DOCUMENT_LAYOUTS_TOO_MANY") return t("printLayout.tooMany", { limit: details?.limit ?? "" });
    if (code === "DOCUMENT_LAYOUTS_TOO_LARGE") return t("printLayout.tooLarge", { limit: details?.limit ? Math.floor(details.limit / 1024) : "" });
    if (details && typeof details === "object" && !Array.isArray(details) && details.field) return t("printLayout.invalidValue", { field: details.field });
    return local.message || "";
  }

  function afterSave(saved: PrintLayoutTemplate, layouts: PrintLayoutTemplate[]) {
    showTemplate(saved);
    setAvailableTemplates(templatesFor(documentType, layouts));
  }

  async function saveTemplate() {
    if (!canSave) throw new Error(t("printLayout.saveForbidden"));
    setSaving(true);
    try {
      const { saved, layouts } = await savePrintTemplate(template.isDefault ? { ...template, id: `${documentType}-custom`, isDefault: false } : template);
      afterSave(saved, layouts);
      toast.success(t("printLayout.templateSaved"), { description: t("printLayout.templateSavedHelp") });
    } catch (error) {
      toast.error(t("printLayout.saveFailed"), { description: describeFailure(error) });
      throw error;
    } finally {
      setSaving(false);
    }
  }

  function saveInstance() {
    const saved = savePrintInstance(documentType, documentNo, instanceValues);
    setSavedInstanceSnapshot(JSON.stringify(saved.values));
    toast.success(t("printLayout.instanceSaved"), { description: t("printLayout.instanceSavedHelp", { documentNo }) });
  }

  async function saveAll() {
    if (templateDirty) await saveTemplate();
    if (instanceDirty) saveInstance();
  }

  useUnsavedChanges({
    key: `print-layout:${documentType}:${documentNo}`,
    label: `${documentNo} ${[templateDirty ? t("printLayout.unsavedLabelTemplate") : "", instanceDirty ? t("printLayout.unsavedLabelInstance") : ""].filter(Boolean).join(t("printLayout.unsavedLabelJoin"))}`,
    dirty: anyDirty,
    onSave: saveAll,
  });

  async function saveAs() {
    if (!canSave) return;
    setSaving(true);
    try {
      const { saved, layouts } = await savePrintTemplateAs(template, t("printLayout.copyName", { name: template.name }));
      afterSave(saved, layouts);
      toast.success(t("printLayout.savedAs"));
    } catch (error) {
      toast.error(t("printLayout.saveFailed"), { description: describeFailure(error) });
    } finally {
      setSaving(false);
    }
  }

  function restore() {
    showTemplate(restoreDefaultTemplate(documentType));
    setSelectedId("title");
    toast.success(t("printLayout.restored"), { description: t("printLayout.restoredHelp") });
  }

  function addElement(type: PrintElementType | "remark") {
    const element = createElement(type === "remark" ? "comment" : type, template.elements.length);
    if (type === "remark") element.title = "备注";
    setTemplate((current) => ({ ...current, elements: [...current.elements, element] }));
    setSelectedId(element.id);
  }

  function requestClose() {
    if (anyDirty) setClosePrompt(true);
    else onClose();
  }

  function clearInstance() {
    clearPrintInstance(documentType, documentNo);
    setInstanceValues({});
    setSavedInstanceSnapshot("{}");
    toast.success(t("printLayout.cleared"), { description: t("printLayout.clearedHelp") });
  }

  if (!open) return null;
  const scale = template.page.orientation === "portrait" ? 0.62 : 0.58;

  return (
    <div className="print-layout-editor" data-testid="print-layout-editor" role="dialog" aria-modal="true" aria-label={t("printLayout.dialogLabel", { documentNo })}>
      <style>{`@media print { @page { size: A4 ${template.page.orientation}; margin: 0; } }`}</style>
      <header className="print-layout-toolbar">
        <div className="print-toolbar-group">
          <button type="button" onClick={requestClose}><ArrowLeft size={15} /> {t("printLayout.back")}</button>
          <strong>{documentNo}</strong>
          {templateDirty && <span className="print-dirty-chip">{t("printLayout.templateUnsaved")}</span>}
          {instanceDirty && <span className="print-dirty-chip">{t("printLayout.instanceUnsaved")}</span>}
        </div>
        <div className="print-toolbar-group print-template-controls">
          <input aria-label={t("printLayout.templateName")} value={template.name} onChange={(event) => setTemplate((current) => ({ ...current, name: event.target.value }))} />
          <select aria-label={t("printLayout.templateSelect")} data-testid="print-layout-template-select" value={template.id} onChange={(event) => {
            const selectedTemplate = availableTemplates.find((item) => item.id === event.target.value);
            if (selectedTemplate) { showTemplate(structuredClone(selectedTemplate)); setSelectedId("title"); }
          }}>{availableTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <div className="print-orientation-toggle">
            <button type="button" className={template.page.orientation === "portrait" ? "active" : ""} onClick={() => changeOrientation("portrait")}>{t("printLayout.portrait")}</button>
            <button type="button" className={template.page.orientation === "landscape" ? "active" : ""} onClick={() => changeOrientation("landscape")}>{t("printLayout.landscape")}</button>
          </div>
        </div>
        <div className="print-toolbar-group">
          {canSave && <button type="button" data-testid="print-layout-save-template" disabled={saving} onClick={() => void saveTemplate().catch(() => undefined)}><Save size={14} /> {t("printLayout.saveTemplate")}</button>}
          {canSave && <button type="button" disabled={saving} onClick={() => void saveAs()}>{t("printLayout.saveAs")}</button>}
          <button type="button" onClick={restore}><RotateCcw size={14} /> {t("printLayout.restore")}</button>
          <button type="button" onClick={saveInstance}><Save size={14} /> {t("printLayout.saveInstance")}</button>
          <button type="button" onClick={clearInstance}><Eraser size={14} /> {t("printLayout.clearInstance")}</button>
          <button type="button" className="primary" data-testid="print-document-button" onClick={() => window.print()}><Printer size={14} /> {t("printLayout.print")}</button>
        </div>
      </header>
      <div className="print-component-toolbar" aria-label={t("printLayout.addElements")}>
        <button type="button" onClick={() => addElement("text")}>{t("printLayout.addText")}</button>
        <button type="button" onClick={() => addElement("comment")}>{t("printLayout.addComments")}</button>
        <button type="button" onClick={() => addElement("remark")}>{t("printLayout.addRemark")}</button>
        <button type="button" onClick={() => addElement("terms")}>{t("printLayout.addTerms")}</button>
        <button type="button" onClick={() => addElement("signature")}>{t("printLayout.addSignature")}</button>
        <button type="button" onClick={() => addElement("line")}>{t("printLayout.addLine")}</button>
      </div>
      {workspaceState === "loading" && <div className="print-readonly-note" role="status">{t("printLayout.loading")}</div>}
      {workspaceState === "failed" && <div className="print-readonly-note" role="alert" data-testid="print-layout-load-failed">{t("printLayout.loadFailed")}</div>}
      {workspaceState === "ready" && access && !access.canManage && <div className="print-readonly-note" role="note" data-testid="print-layout-read-only">{t("printLayout.readOnly")}</div>}
      {workspaceState === "ready" && access && <PrintLayoutImportBanner
        tenantId={access.tenantId}
        canManage={access.canManage}
        describeFailure={describeFailure}
        onImported={(layouts) => setAvailableTemplates(templatesFor(documentType, layouts))}
      />}
      <div className="print-layout-workspace">
        <main className="print-canvas-stage">
          <div className="print-paper-label">{t("printLayout.paperHint", { orientation: t(template.page.orientation === "portrait" ? "printLayout.portraitShort" : "printLayout.landscapeShort") })}</div>
          <PrintCanvas template={template} data={printData} instanceValues={instanceValues} selectedId={selectedId} scale={scale} onSelect={setSelectedId} onElementChange={updateElement} />
        </main>
        <aside className="print-layout-sidepanels">
          <PrintInstancePanel documentType={documentType} values={instanceValues} onChange={(key, value) => setInstanceValues((current) => ({ ...current, [instanceElementId(key)]: value }))} />
          <PrintElementInspector
            elements={template.elements}
            selected={selected}
            fieldOptions={printFieldOptions[documentType]}
            instanceValue={selected ? instanceValues[selected.id] : ""}
            onSelect={setSelectedId}
            onChange={changeSelected}
            onInstanceValueChange={(value) => selected && setInstanceValues((current) => ({ ...current, [selected.id]: value }))}
            onDelete={() => selected && !selected.required && (() => {
              setTemplate((current) => ({ ...current, elements: current.elements.filter((element) => element.id !== selected.id) }));
              setInstanceValues((current) => { const next = { ...current }; delete next[selected.id]; return next; });
              setSelectedId("");
            })()}
          />
        </aside>
      </div>
      {closePrompt && <div className="print-unsaved-backdrop" data-testid="print-unsaved-dialog">
        <div className="print-unsaved-dialog">
          <h2>{t("printLayout.unsavedTitle")}</h2>
          <p>{[templateDirty ? t("printLayout.unsavedTemplate") : "", instanceDirty ? t("printLayout.unsavedInstance") : ""].filter(Boolean).join(" ")}</p>
          <div>
            <button type="button" onClick={() => setClosePrompt(false)}>{t("printLayout.keepEditing")}</button>
            <button type="button" className="danger" onClick={onClose}>{t("printLayout.discard")}</button>
            <button type="button" className="primary" disabled={saving} onClick={() => { void saveAll().then(onClose, () => setClosePrompt(false)); }}>{t("printLayout.saveAndLeave")}</button>
          </div>
        </div>
      </div>}
    </div>
  );
}

import { validateDocumentSettings, type DocumentSettings } from "../../../shared/business-documents.mjs";
import { apiJson } from "../../lib/api-client";
import { saveDocumentSettings } from "../settings/settingsRuntime";
import { defaultPrintTemplate } from "./printLayoutPresets";
import type { PrintDocumentType, PrintLayoutTemplate } from "./printLayoutTypes";

// Saved print templates belong to the workspace: they are stored in the
// documents section of the workspace settings (documents.layouts) and saved
// with PATCH /api/settings-runtime/documents, which needs
// settings.workspace.manage. The built-in templates are in code
// (printLayoutPresets.ts). Only which template this browser used last for
// each document type stays in the browser; what is typed for one print is
// kept by printInstanceStorage.ts.
const LAST_KEY = "flowchain.print-layout.last.v1";

export type WorkspacePrintSettings = {
  documents: DocumentSettings;
  // The letterhead company name, else the workspace's legal name or name; "" when none is recorded.
  companyName: string;
};

export async function fetchWorkspacePrintSettings(): Promise<WorkspacePrintSettings> {
  const settings = await apiJson<{ company?: { companyName?: string | null }; documents: DocumentSettings }>("/api/settings-runtime");
  return { documents: settings.documents, companyName: settings.documents?.letterhead?.companyName || settings.company?.companyName || "" };
}

export function workspaceLayouts(documents: DocumentSettings | null | undefined): PrintLayoutTemplate[] {
  return (documents?.layouts || []) as unknown as PrintLayoutTemplate[];
}

// The built-in template first, then the workspace's saved ones of that type.
export function templatesFor(type: PrintDocumentType, layouts: PrintLayoutTemplate[]): PrintLayoutTemplate[] {
  const preset = defaultPrintTemplate(type);
  return [preset, ...layouts.filter((item) => item.documentType === type && item.id !== preset.id)];
}

function readLast(): Partial<Record<PrintDocumentType, string>> {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeLast(last: Partial<Record<PrintDocumentType, string>>) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(last)); } catch { /* The last-used choice is a convenience only. */ }
}

export function rememberLastTemplate(type: PrintDocumentType, id: string) {
  writeLast({ ...readLast(), [type]: id });
}

export function loadLastTemplate(type: PrintDocumentType, layouts: PrintLayoutTemplate[]): PrintLayoutTemplate {
  const templates = templatesFor(type, layouts);
  const last = readLast()[type];
  return structuredClone(templates.find((item) => item.id === last) || templates.find((item) => !item.isDefault) || templates[0]);
}

// Saves the workspace's layouts with `change` applied to the ones stored now
// (read again just before, since PATCH replaces the whole documents section),
// and returns the layouts as saved.
export async function saveWorkspaceLayouts(change: (layouts: PrintLayoutTemplate[]) => PrintLayoutTemplate[]): Promise<PrintLayoutTemplate[]> {
  const { documents } = await fetchWorkspacePrintSettings();
  const next = validateDocumentSettings({ ...documents, layouts: change(workspaceLayouts(documents)) });
  const result = await saveDocumentSettings(next);
  return workspaceLayouts(result.settings);
}

export async function savePrintTemplate(template: PrintLayoutTemplate): Promise<{ saved: PrintLayoutTemplate; layouts: PrintLayoutTemplate[] }> {
  const candidate: PrintLayoutTemplate = { ...structuredClone(template), isDefault: false, updatedAt: new Date().toISOString(), version: template.version + 1 };
  const layouts = await saveWorkspaceLayouts((current) => current.some((item) => item.id === candidate.id)
    ? current.map((item) => item.id === candidate.id ? candidate : item)
    : [...current, candidate]);
  const saved = structuredClone(layouts.find((item) => item.id === candidate.id) || candidate);
  rememberLastTemplate(saved.documentType, saved.id);
  return { saved, layouts };
}

export function savePrintTemplateAs(template: PrintLayoutTemplate, name: string) {
  return savePrintTemplate({ ...template, id: `${template.documentType}-${Date.now()}`, name, isDefault: false, version: 0 });
}

// Back to the built-in template in this browser; no saved template changes.
export function restoreDefaultTemplate(type: PrintDocumentType): PrintLayoutTemplate {
  const last = readLast();
  delete last[type];
  writeLast(last);
  return defaultPrintTemplate(type);
}

import { validateDocumentSettings, type DocumentSettings } from "../../../shared/business-documents.mjs";
import { apiJson } from "../../lib/api-client";
import { saveDocumentSettings } from "../settings/settingsRuntime";
import { defaultPrintTemplate } from "./printLayoutPresets";
import type { PrintLayoutCopy } from "./printLayoutElements";
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

// Refused because the stored template is no longer the one the editor loaded.
export class PrintLayoutChangedError extends Error {
  code = "DOCUMENT_LAYOUT_CHANGED";
  templateId: string;
  constructor(templateId: string) {
    super(`Print template ${templateId} was changed by someone else.`);
    this.templateId = templateId;
  }
}

// A failed save carries the layouts it sent, so a refused value can be named
// by its template and element.
export type PrintLayoutSaveError = Error & { code?: string; sentLayouts?: PrintLayoutTemplate[] };

export async function fetchWorkspacePrintSettings(): Promise<WorkspacePrintSettings> {
  const settings = await apiJson<{ company?: { companyName?: string | null }; documents: DocumentSettings }>("/api/settings-runtime");
  return { documents: settings.documents, companyName: settings.documents?.letterhead?.companyName || settings.company?.companyName || "" };
}

export function workspaceLayouts(documents: DocumentSettings | null | undefined): PrintLayoutTemplate[] {
  return (documents?.layouts || []) as unknown as PrintLayoutTemplate[];
}

// The built-in template first, then the workspace's saved ones of that type.
export function templatesFor(type: PrintDocumentType, layouts: PrintLayoutTemplate[], copy: PrintLayoutCopy): PrintLayoutTemplate[] {
  const preset = defaultPrintTemplate(type, copy);
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

function forgetLastTemplate(type: PrintDocumentType) {
  const last = readLast();
  delete last[type];
  writeLast(last);
}

export function loadLastTemplate(type: PrintDocumentType, layouts: PrintLayoutTemplate[], copy: PrintLayoutCopy): PrintLayoutTemplate {
  const templates = templatesFor(type, layouts, copy);
  const last = readLast()[type];
  return structuredClone(templates.find((item) => item.id === last) || templates.find((item) => !item.isDefault) || templates[0]);
}

// Saves the workspace's layouts with `change` applied to the ones stored now
// (read again just before, since PATCH replaces the whole documents section;
// the letterhead, the PO and invoice templates and any unreadable layouts are
// sent back as read), and returns the section as saved.
export async function saveWorkspaceLayouts(change: (layouts: PrintLayoutTemplate[]) => PrintLayoutTemplate[]): Promise<DocumentSettings> {
  const { documents } = await fetchWorkspacePrintSettings();
  const layouts = change(workspaceLayouts(documents));
  try {
    const result = await saveDocumentSettings(validateDocumentSettings({ ...documents, layouts }));
    return result.settings;
  } catch (error) {
    if (error && typeof error === "object") (error as PrintLayoutSaveError).sentLayouts = layouts;
    throw error;
  }
}

// A fresh id no stored template has.
export function newTemplateId(type: PrintDocumentType, taken: Iterable<string>) {
  const used = new Set(taken);
  for (;;) {
    const id = `${type}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(id)) return id;
  }
}

function assertStoredVersion(current: PrintLayoutTemplate[], template: PrintLayoutTemplate) {
  const stored = current.find((item) => item.id === template.id);
  if (!stored || stored.version !== template.version) throw new PrintLayoutChangedError(template.id);
}

type SaveResult = { saved: PrintLayoutTemplate; documents: DocumentSettings };

function savedFrom(documents: DocumentSettings, candidate: PrintLayoutTemplate): PrintLayoutTemplate {
  return structuredClone(workspaceLayouts(documents).find((item) => item.id === candidate.id) || candidate);
}

// A new template (from a built-in one, or Save as): always a new id, never
// replacing a stored template.
export async function saveNewPrintTemplate(template: PrintLayoutTemplate, name = template.name): Promise<SaveResult> {
  let candidate = template;
  const documents = await saveWorkspaceLayouts((current) => {
    candidate = { ...structuredClone(template), id: newTemplateId(template.documentType, current.map((item) => item.id)), name, isDefault: false, version: 1, updatedAt: new Date().toISOString() };
    return [...current, candidate];
  });
  const saved = savedFrom(documents, candidate);
  rememberLastTemplate(saved.documentType, saved.id);
  return { saved, documents };
}

// A stored template edited: saved over itself only if it is still the
// version the editor loaded; otherwise refused (PrintLayoutChangedError here,
// or DOCUMENT_LAYOUT_CHANGED from the server if it changed in between).
export async function saveExistingPrintTemplate(template: PrintLayoutTemplate): Promise<SaveResult> {
  let candidate = template;
  const documents = await saveWorkspaceLayouts((current) => {
    assertStoredVersion(current, template);
    candidate = { ...structuredClone(template), isDefault: false, version: template.version + 1, updatedAt: new Date().toISOString() };
    return current.map((item) => item.id === candidate.id ? candidate : item);
  });
  const saved = savedFrom(documents, candidate);
  rememberLastTemplate(saved.documentType, saved.id);
  return { saved, documents };
}

// Removed from the workspace, if it is still the version the editor loaded.
export async function deletePrintTemplate(template: PrintLayoutTemplate): Promise<DocumentSettings> {
  const documents = await saveWorkspaceLayouts((current) => {
    assertStoredVersion(current, template);
    return current.filter((item) => item.id !== template.id);
  });
  if (readLast()[template.documentType] === template.id) forgetLastTemplate(template.documentType);
  return documents;
}

// Back to the built-in template in this browser; no saved template changes.
export function restoreDefaultTemplate(type: PrintDocumentType, copy: PrintLayoutCopy): PrintLayoutTemplate {
  forgetLastTemplate(type);
  return defaultPrintTemplate(type, copy);
}

import { validatePrintLayout } from "../../../shared/business-documents.mjs";
import type { PrintLayoutTemplate } from "./printLayoutTypes";

// Print templates saved before they became the workspace's were kept in this
// browser under the key below. They are no longer used. Someone who may
// manage the workspace settings is offered to import them, never silently:
// Review and import, Not now (asked again next time), or Don't ask again in
// this browser (the decision key). After an import, Remove takes only the
// imported templates out of the browser; the others are written back as they
// were. Nothing is removed without that choice.
const LEGACY_TEMPLATES_KEY = "flowchain.print-layout.templates.v1";
const DECISION_KEY_PREFIX = "flowchain.print-layout.import-decision.v1:";

// Each stored entry as it is in the browser, and as a template when it can be read.
export type BrowserTemplateEntry = { raw: unknown; template: PrintLayoutTemplate | null };

export function readBrowserTemplates(storage: Pick<Storage, "getItem"> = localStorage): BrowserTemplateEntry[] {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(LEGACY_TEMPLATES_KEY) || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  return stored.map((raw) => {
    try {
      return { raw, template: validatePrintLayout(raw) as unknown as PrintLayoutTemplate };
    } catch {
      return { raw, template: null };
    }
  });
}

const decisionKey = (tenantId: string) => `${DECISION_KEY_PREFIX}${tenantId}`;

export function importDecided(tenantId: string, storage: Pick<Storage, "getItem"> = localStorage) {
  try { return Boolean(storage.getItem(decisionKey(tenantId))); } catch { return false; }
}

// Recorded when the person chooses Don't ask again, or once everything in
// the browser has been imported.
export function rememberImportDecision(tenantId: string, decision: "dont_ask" | "imported", storage: Pick<Storage, "setItem"> = localStorage) {
  try { storage.setItem(decisionKey(tenantId), JSON.stringify({ decision, at: new Date().toISOString() })); } catch { /* Asked again next time. */ }
}

// Only when the person chooses Remove after a successful import: the entries
// not imported (unticked or unreadable) are written back exactly as they were.
// Returns how many stay in the browser.
export function removeImportedBrowserTemplates(entries: BrowserTemplateEntry[], imported: ReadonlySet<number>, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage) {
  const remaining = entries.filter((_, index) => !imported.has(index)).map((entry) => entry.raw);
  try {
    if (remaining.length) storage.setItem(LEGACY_TEMPLATES_KEY, JSON.stringify(remaining));
    else storage.removeItem(LEGACY_TEMPLATES_KEY);
  } catch { /* Nothing removed. */ }
  return remaining.length;
}

// The chosen templates as they are added to the workspace: a template whose
// id is already there (or already taken by another chosen one) is added as a
// copy with a new id and `suffix` after its name.
export function importCopies(chosen: PrintLayoutTemplate[], existing: PrintLayoutTemplate[], suffix: string, now = Date.now()): PrintLayoutTemplate[] {
  const taken = new Set(existing.map((item) => item.id));
  return chosen.map((template, index) => {
    const copy = structuredClone(template);
    if (taken.has(copy.id)) {
      copy.id = `${copy.documentType}-imported-${now}-${index}`;
      copy.name = `${copy.name} ${suffix}`.slice(0, 120);
    }
    taken.add(copy.id);
    return { ...copy, isDefault: false };
  });
}

import { validatePrintLayout } from "../../../shared/business-documents.mjs";
import type { PrintLayoutTemplate } from "./printLayoutTypes";

// Print templates saved before they became the workspace's were kept in this
// browser under the key below. They are no longer used. Someone who may
// manage the workspace settings is offered to import them, never silently:
// Review and import, Not now (asked again next time), or Don't ask again in
// this browser (the decision key). Nothing here writes templates to the
// browser, and the old copies are removed only when the person chooses Remove.
const LEGACY_TEMPLATES_KEY = "flowchain.print-layout.templates.v1";
const DECISION_KEY_PREFIX = "flowchain.print-layout.import-decision.v1:";

export type BrowserTemplates = { importable: PrintLayoutTemplate[]; unreadable: number };

export function readBrowserTemplates(): BrowserTemplates {
  let stored: unknown = [];
  try {
    stored = JSON.parse(localStorage.getItem(LEGACY_TEMPLATES_KEY) || "[]");
  } catch {
    return { importable: [], unreadable: 0 };
  }
  if (!Array.isArray(stored)) return { importable: [], unreadable: 0 };
  const importable: PrintLayoutTemplate[] = [];
  let unreadable = 0;
  for (const item of stored) {
    try {
      importable.push(validatePrintLayout(item) as unknown as PrintLayoutTemplate);
    } catch {
      unreadable += 1;
    }
  }
  return { importable, unreadable };
}

export function hasBrowserTemplates() {
  const { importable, unreadable } = readBrowserTemplates();
  return importable.length + unreadable > 0;
}

const decisionKey = (tenantId: string) => `${DECISION_KEY_PREFIX}${tenantId}`;

export function importDecided(tenantId: string) {
  try { return Boolean(localStorage.getItem(decisionKey(tenantId))); } catch { return false; }
}

// Recorded when the person chooses Don't ask again, or after they import.
export function rememberImportDecision(tenantId: string, decision: "dont_ask" | "imported") {
  try { localStorage.setItem(decisionKey(tenantId), JSON.stringify({ decision, at: new Date().toISOString() })); } catch { /* Asked again next time. */ }
}

// Only when the person chooses Remove after a successful import.
export function removeBrowserTemplates() {
  try { localStorage.removeItem(LEGACY_TEMPLATES_KEY); } catch { /* Nothing to remove. */ }
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

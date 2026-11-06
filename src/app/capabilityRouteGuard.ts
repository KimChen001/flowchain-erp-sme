export type CapabilityMaturity = "stable" | "beta" | "preview" | "unavailable";

export type ModuleCapability = {
  id: string;
  enabled: boolean;
  maturity: CapabilityMaturity;
  readReady: boolean;
  writeReady: boolean;
  businessCommitReady?: boolean;
  reason: string;
};

export type CapabilityLoadState = "loading" | "ready" | "failed";
export const EXPERIMENTAL_MODULES_KEY = "flowchain:experimental-modules";

// What each page needs when the capability list cannot be read. The reasons
// are plain words a person may see; the server's list replaces them once read.
const localCapabilityFallback: Record<string, ModuleCapability> = Object.fromEntries([
  ["overview", "stable", "Today's work and overview."],
  ["master-data", "stable", "Items, suppliers and customers."],
  ["procurement", "stable", "Purchase requests and orders."],
  ["sales", "stable", "Sales orders."],
  ["inventory", "stable", "Stock on hand and stock movements."],
  ["inventory-bin-read", "unavailable", "Stock by bin is not available yet."],
  ["finance", "beta", "Payables and receivables are off until an administrator turns them on."],
  ["reports", "stable", "Reports."],
  ["settings", "beta", "Workspace settings."],
  ["imports", "unavailable", "This import page was replaced by Data intake."],
  ["universal-intake", "preview", "Data intake is a preview: files can be uploaded but not yet turned into records."],
  ["forecast", "unavailable", "Forecast and MRP planning are not available yet."],
  ["exception-cases", "preview", "Exception cases are an internal preview."],
  ["collaboration-drafts", "preview", "Collaboration drafts are an internal preview."],
  ["review-actions", "preview", "The review queue is an internal preview."],
  ["audit-history", "preview", "Audit history is an internal preview."],
  ["pilot-readiness", "preview", "Readiness checks are an internal preview."],
].map(([id, maturity, reason]) => [id, {
  id,
  maturity,
  reason,
  enabled: maturity === "stable" || maturity === "beta",
  readReady: maturity !== "unavailable",
  writeReady: false,
  businessCommitReady: id === "imports" || id === "universal-intake" ? false : undefined,
} as ModuleCapability]));

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readExperimentalModuleIds(storage: Pick<Storage, "getItem"> = localStorage): Set<string> {
  try {
    const saved: unknown = JSON.parse(storage.getItem(EXPERIMENTAL_MODULES_KEY) || "[]");
    const ids: unknown[] = Array.isArray(saved)
      ? saved
      : isUnknownRecord(saved) && Array.isArray(saved.enabled)
        ? saved.enabled
        : [];
    return new Set<string>(ids.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set<string>();
  }
}

export function resolveCapabilityRouteAccess(input: {
  moduleId: string;
  loadState: CapabilityLoadState;
  capabilities: Record<string, ModuleCapability>;
  experimentalModuleIds: Set<string>;
}) {
  const fallback = localCapabilityFallback[input.moduleId] || {
    id: input.moduleId,
    enabled: false,
    maturity: "unavailable" as const,
    readReady: false,
    writeReady: false,
    reason: "This feature is not available.",
  };
  const capability = input.capabilities[input.moduleId] || fallback;

  if (input.loadState === "loading") return { status: "loading" as const, capability };
  if (input.loadState === "failed") {
    if (fallback.maturity === "stable" && fallback.enabled) return { status: "allowed" as const, capability: fallback };
    return { status: "blocked" as const, capability: fallback, reason: "FlowChain could not check which features are turned on, so features that are not generally available stay closed." };
  }
  if (capability.maturity === "preview") {
    return input.experimentalModuleIds.has(input.moduleId)
      ? { status: "allowed" as const, capability }
      : { status: "blocked" as const, capability, reason: `${capability.reason} It opens only when turned on in this browser's preview settings.` };
  }
  if (capability.maturity === "unavailable" || !capability.enabled) {
    return { status: "blocked" as const, capability, reason: capability.reason };
  }
  return { status: "allowed" as const, capability };
}

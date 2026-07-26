export type CapabilityMaturity = "stable" | "beta" | "preview" | "unavailable";

export type ModuleCapability = {
  id: string;
  enabled: boolean;
  maturity: CapabilityMaturity;
  readReady: boolean;
  writeReady: boolean;
  reason: string;
};

export type CapabilityLoadState = "loading" | "ready" | "failed";
export const EXPERIMENTAL_MODULES_KEY = "flowchain:experimental-modules";

const localCapabilityFallback: Record<string, ModuleCapability> = Object.fromEntries([
  ["overview", "stable", "Authoritative runtime overview"],
  ["master-data", "stable", "Runtime item, supplier, and customer masters"],
  ["procurement", "stable", "Canonical PR and draft PO workflow"],
  ["sales", "stable", "Durable sales order runtime"],
  ["inventory", "stable", "Durable inventory balances and movements"],
  ["finance", "beta", "Operational finance requires database mode and explicit enablement"],
  ["reports", "stable", "Authoritative runtime analytics"],
  ["settings", "beta", "Local/UAT workspace settings"],
  ["imports", "beta", "Supplier, item, customer, and inventory imports are connected"],
  ["universal-intake", "preview", "Tenant-scoped Intake foundation without parsing or business commit adapters"],
  ["forecast", "unavailable", "Forecast and MRP planning are unavailable until PostgreSQL authoritative models exist"],
  ["exception-cases", "preview", "Internal exception workflow preview"],
  ["collaboration-drafts", "preview", "Internal draft-only workflow"],
  ["review-actions", "preview", "Human review workflow preview"],
  ["audit-history", "preview", "Internal audit exploration"],
  ["pilot-readiness", "preview", "Internal readiness assessment"],
].map(([id, maturity, reason]) => [id, {
  id,
  maturity,
  reason,
  enabled: maturity === "stable" || maturity === "beta",
  readReady: maturity !== "unavailable",
  writeReady: false,
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
    reason: "Capability is not registered",
  };
  const capability = input.capabilities[input.moduleId] || fallback;

  if (input.loadState === "loading") return { status: "loading" as const, capability };
  if (input.loadState === "failed") {
    if (fallback.maturity === "stable" && fallback.enabled) return { status: "allowed" as const, capability: fallback };
    return { status: "blocked" as const, capability: fallback, reason: "能力注册表暂不可用；非 stable 模块已按安全策略关闭。" };
  }
  if (capability.maturity === "preview") {
    return input.experimentalModuleIds.has(input.moduleId)
      ? { status: "allowed" as const, capability }
      : { status: "blocked" as const, capability, reason: `${capability.reason}；需要在本地实验设置中明确启用。` };
  }
  if (capability.maturity === "unavailable" || !capability.enabled) {
    return { status: "blocked" as const, capability, reason: capability.reason };
  }
  return { status: "allowed" as const, capability };
}

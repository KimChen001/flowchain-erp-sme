export const LEGACY_IMPORT_PIPELINE_RETIRED = Object.freeze({
  code: "FLOWCHAIN_LEGACY_IMPORT_PIPELINE_RETIRED",
  capability: "legacy-imports",
  message: "The legacy direct-import pipeline has been retired in favor of Universal Intake.",
  limitations: [
    "CSV/XLSX parsing is not implemented until Phase 5.4B.",
    "Governed business commit adapters are not implemented until Phase 5.4C.",
  ],
});

export async function handlePilotImportRoute(ctx) {
  const path = ctx.url.pathname;
  const legacyPath = path === "/api/imports" || path.startsWith("/api/imports/")
    || path === "/api/import-batches" || path.startsWith("/api/import-batches/");
  if (!legacyPath) return false;
  if (!ctx.identity?.authenticated) {
    ctx.send(ctx.res, 401, { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return true;
  }
  ctx.send(ctx.res, 501, LEGACY_IMPORT_PIPELINE_RETIRED);
  return true;
}

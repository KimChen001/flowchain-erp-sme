// Regenerates the classification summary and the executable route table in
// docs/frontend-route-authority-matrix.md from the typed route manifest.
// The prose sections stay hand-written. Run after changing any route:
//
//   node scripts/generate-route-authority-matrix.mjs
//
// server/domain/frontend-route-governance.test.mjs checks that every route
// has a matching row.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "vite";

const docUrl = new URL("../docs/frontend-route-authority-matrix.md", import.meta.url);
const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
try {
  const registry = await vite.ssrLoadModule("/src/app/routeRegistry.tsx");
  const routes = registry.appRouteRegistry;
  const cell = (value) =>
    String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
  const row = (route) =>
    `| \`${cell(route.id)}\` | \`${cell(route.path)}\` | ${cell(route.label)} | \`${cell(route.moduleId)}\` | ${cell(route.classification)} | ${cell(route.navigationVisibility)} | ${route.compatibilityOnly ? "yes" : "no"} | ${cell(route.businessObject)} | \`${cell(route.owner)}\` | ${cell(route.apiDependency)} | ${cell(route.repositoryAuthority)} | ${cell(route.readMaturity)} | ${cell(route.writeMaturity)} | ${cell(route.requiredCapability)} | ${cell(route.requiredPermission)} | ${cell(route.directAccessBehavior)} | ${cell(route.canonicalReplacement)} | ${cell(route.knownLimitations)} |`;

  const count = (classification) =>
    routes.filter((route) => route.classification === classification).length;
  const summary = [
    "## Classification summary",
    "",
    `- Core: ${count("CORE")}`,
    `- Extension: ${count("EXTENSION")}`,
    `- Internal: ${count("INTERNAL")}`,
    `- Frozen: ${count("FROZEN")}`,
    `- Legacy: ${count("LEGACY")}`,
    `- Total: ${routes.length}`,
    "",
  ].join("\n");

  const doc = readFileSync(docUrl, "utf8");
  const header = "| Route ID | Path | Label |";
  const tableStart = doc.indexOf(header);
  if (tableStart < 0) throw new Error("route table header not found");
  const separatorEnd = doc.indexOf("\n", doc.indexOf("\n", tableStart) + 1) + 1;
  let tableEnd = separatorEnd;
  while (doc.startsWith("| `", tableEnd)) tableEnd = doc.indexOf("\n", tableEnd) + 1;

  const next = (
    doc.slice(0, separatorEnd) +
    routes.map(row).join("\n") +
    "\n" +
    doc.slice(tableEnd)
  )
    .replace(/## Classification summary\n[\s\S]*?\n(?=## )/, `${summary}\n`)
    .replace(/\d+\/\d+ frontend route stability audit/, `${routes.length}/${routes.length} frontend route stability audit`);
  writeFileSync(docUrl, next);
  console.log(`${routes.length} routes written`);
} finally {
  await vite.close();
}

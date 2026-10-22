import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const cli = join(
  resolve(import.meta.dirname, ".."),
  "node_modules",
  "playwright",
  "cli.js",
);
function run(spec, extra = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, "test", spec], {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_OPERATIONAL_FINANCE_DB: "true",
        PLAYWRIGHT_WORKERS: "1",
        ...extra,
      },
    });
    child.once("exit", (code) => resolveRun(code ?? 1));
  });
}
const enabled = await run("tests/browser/operational-finance.spec.ts");
if (enabled !== 0) process.exit(enabled);
// The invoice screens, on a fresh seeded database of their own.
const screens = await run("tests/browser/supplier-invoice-ui.spec.ts");
if (screens !== 0) process.exit(screens);
// Bills and invoices started from their source documents, on a fresh database.
const entry = await run("tests/browser/billing-entry.spec.ts");
if (entry !== 0) process.exit(entry);
// Payments recorded on bills to pay and receivables, on a fresh database.
const payments = await run("tests/browser/payment-records.spec.ts");
if (payments !== 0) process.exit(payments);
// The customer invoice document, approved and then issued, on a fresh database.
const invoiceDocument = await run("tests/browser/customer-invoice-document.spec.ts");
if (invoiceDocument !== 0) process.exit(invoiceDocument);
process.exit(
  await run("tests/browser/operational-finance-disabled.spec.ts", {
    PLAYWRIGHT_OPERATIONAL_FINANCE_DISABLED: "true",
  }),
);

#!/usr/bin/env node
// Sends one test alert to FLOWCHAIN_ERROR_WEBHOOK_URL, the same way the
// server sends error alerts, and says whether it arrived. Run it after
// setting up the webhook and once a month (docs/operations-alerts.md):
//
//   FLOWCHAIN_ERROR_WEBHOOK_URL=https://hooks.slack.com/services/... node scripts/send-test-alert.mjs
//
// In PowerShell: $env:FLOWCHAIN_ERROR_WEBHOOK_URL = "https://..."; node scripts/send-test-alert.mjs
//
// The URL is read from the environment only and is never printed.
import { createErrorReporter } from "../server/observability/error-reporter.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const reporter = createErrorReporter({
  logger: quiet,
  env: process.env,
  commitSha: process.env.FLOWCHAIN_COMMIT_SHA || "",
  timeoutMs: 10_000,
});

const result = await reporter.sendTestAlert();
if (result.sent) {
  console.log(`Test alert sent (HTTP ${result.status}). Check the channel for "FlowChain ...: test alert".`);
} else {
  const why = {
    not_configured: "FLOWCHAIN_ERROR_WEBHOOK_URL is not set.",
    https_required: "FLOWCHAIN_ERROR_WEBHOOK_URL must start with https://.",
    invalid_url: "FLOWCHAIN_ERROR_WEBHOOK_URL is not a valid URL.",
    rejected: `The webhook answered HTTP ${result.status}. Check that the URL is current and the integration is still installed.`,
    unreachable: "The webhook could not be reached (network error or no answer within 10 seconds).",
  }[result.reason] || `Not sent (${result.reason}).`;
  console.error(`Test alert not sent. ${why}`);
  process.exitCode = 1;
}

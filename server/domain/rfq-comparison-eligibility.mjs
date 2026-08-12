import { normalizeProcurementAuthorityStatus } from "./procurement-status-authority.mjs";

export function canonicalQuotationRevisionStatus(value) {
  try {
    return normalizeProcurementAuthorityStatus("supplierQuotationRevision", value);
  } catch {
    return null;
  }
}

export function rfqRevisionCoverage(targetLines = [], revisionLines = []) {
  const targetIds = new Set(targetLines.map((line) => line.id));
  const matchedIds = new Set();
  let unmappedLineCount = 0;
  for (const line of revisionLines) {
    if (line.rfqLineId && targetIds.has(line.rfqLineId)) matchedIds.add(line.rfqLineId);
    else unmappedLineCount += 1;
  }
  const missingRfqLineIds = targetLines.map((line) => line.id).filter((id) => !matchedIds.has(id));
  const state = targetLines.length === 0
    ? "not_applicable"
    : matchedIds.size === targetLines.length && unmappedLineCount === 0
      ? "complete"
      : matchedIds.size === 0 ? "none" : "partial";
  return { state, requiredLineCount: targetLines.length, matchedLineCount: matchedIds.size, missingRfqLineIds, unmappedLineCount };
}

export function rfqComparisonEligibility({ revision, status = canonicalQuotationRevisionStatus(revision?.status), coverageState }) {
  if (!revision) return { state: "authority_missing", reasons: ["authoritative_revision_missing"] };
  if (!status) return { state: "unknown_status", reasons: ["revision_status_unknown"] };
  if (["draft", "incomplete"].includes(status)) return { state: "not_ready", reasons: [`revision_status_${status}`] };
  if (status === "not_selected") return { state: "historical_only", reasons: ["revision_status_not_selected"] };
  if (status === "withdrawn") return { state: "withdrawn", reasons: ["revision_status_withdrawn"] };
  if (["submitted", "shortlisted"].includes(status)) {
    return coverageState === "complete"
      ? { state: "eligible", reasons: [] }
      : { state: "incomplete_coverage", reasons: [`rfq_line_coverage_${coverageState}`] };
  }
  return { state: "unknown_status", reasons: ["revision_status_unknown"] };
}

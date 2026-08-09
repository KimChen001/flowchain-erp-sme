import { assertAuthorized } from "../auth/authorization-service.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { normalizeProcurementAuthorityStatus } from "./procurement-status-authority.mjs";

export class RfqSupplierComparisonError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "RfqSupplierComparisonError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const text = (value) => String(value ?? "").trim();
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const fail = (code, message, status = 400, details) => {
  throw new RfqSupplierComparisonError(code, message, status, details);
};

function exactDecimal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.toFixed === "function") return value.toFixed(4);
  const raw = text(value);
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}

function isoDateTime(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function canonicalStatus(domain, value) {
  try {
    return normalizeProcurementAuthorityStatus(domain, value);
  } catch {
    return null;
  }
}

function mapRfqLine(line) {
  return {
    rfqLineId: line.id,
    itemId: text(line.itemId) || null,
    sku: text(line.sku) || null,
    itemName: text(line.itemName) || null,
    requestedQuantity: exactDecimal(line.quantity),
    unit: text(line.unit) || null,
  };
}

function lineAuthority(line, targetLineIds) {
  if (!line.rfqLineId) return "unlinked";
  return targetLineIds.has(line.rfqLineId) ? "exact_target_rfq_line" : "different_rfq_line";
}

function comparisonEligibility(latest, status, coverageState) {
  if (!latest) {
    return { state: "authority_missing", reasons: ["authoritative_revision_missing"] };
  }
  if (!status) {
    return { state: "unknown_status", reasons: ["revision_status_unknown"] };
  }
  if (["draft", "incomplete"].includes(status)) {
    return { state: "not_ready", reasons: [`revision_status_${status}`] };
  }
  if (status === "not_selected") {
    return { state: "historical_only", reasons: ["revision_status_not_selected"] };
  }
  if (status === "withdrawn") {
    return { state: "withdrawn", reasons: ["revision_status_withdrawn"] };
  }
  if (["submitted", "shortlisted"].includes(status)) {
    return coverageState === "complete"
      ? { state: "eligible", reasons: [] }
      : { state: "incomplete_coverage", reasons: [`rfq_line_coverage_${coverageState}`] };
  }
  return { state: "unknown_status", reasons: ["revision_status_unknown"] };
}

function mapResponse(quotation, targetLines) {
  const latest = quotation.revisions?.[0] || null;
  const targetLineIds = new Set(targetLines.map((line) => line.id));
  const revisionLines = [...(latest?.lines || [])]
    .map((line) => ({
      revisionLineId: line.id,
      rfqLineId: text(line.rfqLineId) || null,
      lineAuthorityState: lineAuthority(line, targetLineIds),
      itemId: text(line.itemId) || null,
      sku: text(line.skuSnapshot) || null,
      itemName: text(line.itemNameSnapshot) || null,
      quantity: exactDecimal(line.quantity),
      unit: text(line.unit) || null,
      unitPrice: exactDecimal(line.unitPrice),
      amount: exactDecimal(line.amount),
      deliveryDate: isoDateTime(line.deliveryDate),
    }))
    .sort((left, right) => compareText(left.rfqLineId || "", right.rfqLineId || "") || compareText(left.revisionLineId, right.revisionLineId));
  const matchedIds = new Set(revisionLines
    .filter((line) => line.lineAuthorityState === "exact_target_rfq_line")
    .map((line) => line.rfqLineId));
  const missingRfqLineIds = targetLines.map((line) => line.id).filter((id) => !matchedIds.has(id));
  const unmappedLineCount = revisionLines.filter((line) => line.lineAuthorityState !== "exact_target_rfq_line").length;
  const coverageState = targetLines.length === 0
    ? "not_applicable"
    : matchedIds.size === targetLines.length && unmappedLineCount === 0
      ? "complete"
      : matchedIds.size === 0
        ? "none"
        : "partial";
  const status = latest ? canonicalStatus("supplierQuotationRevision", latest.status) : null;
  const coverage = {
    state: coverageState,
    requiredLineCount: targetLines.length,
    matchedLineCount: matchedIds.size,
    missingRfqLineIds,
    unmappedLineCount,
  };
  const eligibility = comparisonEligibility(latest, status, coverageState);
  return {
    quotationId: quotation.id,
    supplierId: quotation.supplierId,
    supplierName: text(quotation.supplier?.name || quotation.supplierName) || null,
    authorityState: latest ? "revision_authoritative" : "revision_missing",
    comparisonEligibility: eligibility.state,
    eligibilityReasons: eligibility.reasons,
    latestRevision: latest ? {
      revisionId: latest.id,
      revisionNumber: latest.revisionNumber,
      status,
      statusRaw: text(latest.status) || null,
      currency: text(latest.currency) || null,
      quotedAmount: exactDecimal(latest.quotedAmount),
      submittedAt: isoDateTime(latest.submittedAt),
      validUntil: isoDateTime(latest.validUntil),
      deliveryDate: isoDateTime(latest.deliveryDate),
      paymentTerms: text(latest.paymentTerms) || null,
      source: text(latest.source) || null,
      createdAt: isoDateTime(latest.createdAt),
      lines: revisionLines,
    } : null,
    coverage,
  };
}

function availability(responses) {
  const eligible = responses.filter((response) => response.comparisonEligibility === "eligible");
  if (eligible.length === 0) return "no_eligible_responses";
  if (eligible.length === 1) return "single_eligible_response";
  const currencies = new Set(eligible.map((response) => response.latestRevision.currency).filter(Boolean));
  return currencies.size > 1 ? "multi_currency_unconverted" : "side_by_side_available";
}

function mapParticipant(participation) {
  return {
    participationId: participation.id,
    supplierId: participation.supplierId,
    supplierName: text(participation.supplier?.name) || null,
    status: canonicalStatus("rfqSupplierParticipation", participation.status),
    statusRaw: text(participation.status) || null,
    invitedAt: isoDateTime(participation.invitedAt),
    respondedAt: isoDateTime(participation.respondedAt),
    withdrawnAt: isoDateTime(participation.withdrawnAt),
    version: participation.version,
  };
}

function participationSummary(participants, nonResponseParticipants) {
  const count = (status) => participants.filter((participant) => participant.status === status).length;
  return {
    participantCount: participants.length,
    plannedCount: count("planned"),
    invitedInternalCount: count("invited_internal"),
    responseRecordedCount: count("response_recorded"),
    noResponseCount: nonResponseParticipants.length,
    declinedCount: count("declined"),
    withdrawnCount: count("withdrawn"),
    closedCount: count("closed"),
  };
}

function limitationsFor(responses, comparisonAvailability) {
  const limitations = [
    "Comparison is read-only and does not rank, score, recommend, award, approve, or create a purchase order.",
    "Commercial authority comes only from the maximum revisionNumber for each SupplierQuotation.",
  ];
  if (responses.some((response) => response.authorityState === "revision_missing")) {
    limitations.push("At least one quotation has no authoritative revision and exposes no commercial facts.");
  }
  if (responses.some((response) => ["partial", "none"].includes(response.coverage.state))) {
    limitations.push("At least one latest revision does not cover every target RFQ line.");
  }
  if (responses.some((response) => response.comparisonEligibility !== "eligible")) {
    limitations.push("Non-eligible responses remain visible but are excluded from active comparison availability.");
  }
  if (comparisonAvailability === "multi_currency_unconverted") {
    limitations.push("Currency conversion is unavailable; amounts in different currencies are not normalized.");
  }
  return limitations;
}

export function createRfqSupplierComparisonService({ prisma, env = process.env, now = () => new Date() } = {}) {
  const db = async () => prisma || getPrismaClient(env);

  return {
    async getComparison(rfqId, context) {
      const client = await db();
      const actor = await resolveProvisionedActor(client, context?.identity || context);
      assertAuthorized({ actor, permission: "procurement.prices.read", tenantId: actor.tenantId });
      const targetRfqId = text(rfqId);
      if (!targetRfqId) fail("RFQ_ID_REQUIRED", "rfqId is required.", 422);

      const snapshot = await client.$transaction(async (tx) => {
        const rfq = await tx.rfq.findFirst({
          where: { tenantId: actor.tenantId, id: targetRfqId },
          include: { lines: { orderBy: { id: "asc" } } },
        });
        if (!rfq) fail("RFQ_NOT_FOUND", "RFQ was not found.", 404);
        const quotations = await tx.supplierQuotation.findMany({
          where: { tenantId: actor.tenantId, rfqId: targetRfqId },
          include: {
            supplier: true,
            revisions: {
              take: 1,
              orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }, { id: "desc" }],
              include: { lines: true },
            },
          },
          orderBy: [{ supplierId: "asc" }, { id: "asc" }],
        });
        const participations = await tx.rfqSupplierParticipation.findMany({
          where: { tenantId: actor.tenantId, rfqId: targetRfqId },
          include: { supplier: true },
          orderBy: [{ supplierId: "asc" }, { id: "asc" }],
        });
        return { rfq, quotations, participations };
      }, { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 30_000 });

      const responses = snapshot.quotations.map((quotation) => mapResponse(quotation, snapshot.rfq.lines));
      const comparisonAvailability = availability(responses);
      const eligibleResponses = responses.filter((response) => response.comparisonEligibility === "eligible");
      const currencies = [...new Set(responses
        .filter((response) => response.comparisonEligibility === "eligible")
        .map((response) => response.latestRevision.currency)
        .filter(Boolean))].sort(compareText);
      const participants = snapshot.participations.map(mapParticipant);
      const quotationSupplierIds = new Set(snapshot.quotations.map((quotation) => quotation.supplierId));
      const nonResponseParticipants = participants.filter((participant) => !quotationSupplierIds.has(participant.supplierId));
      return {
        entityType: "RfqSupplierComparison",
        rfqId: snapshot.rfq.id,
        rfqTitle: text(snapshot.rfq.title) || null,
        rfqStatus: canonicalStatus("rfq", snapshot.rfq.status),
        rfqStatusRaw: text(snapshot.rfq.status) || null,
        rfqCurrency: text(snapshot.rfq.currency) || null,
        generatedAt: now().toISOString(),
        comparisonAvailability,
        commercialAuthority: "supplier_quotation_revision_max_revision_number",
        displayOrderAuthority: "supplier_id_ascending",
        rankingAuthority: "unavailable",
        recommendationAuthority: "unavailable",
        awardAuthority: "unavailable",
        poConversionAuthority: "unavailable",
        participationAuthority: "authoritative",
        invitationDeliveryAuthority: "unavailable",
        externalSupplierIdentityAuthority: "unavailable",
        currencies,
        lines: snapshot.rfq.lines.map(mapRfqLine),
        responses,
        participationSummary: participationSummary(participants, nonResponseParticipants),
        nonResponseParticipants,
        summary: {
          quotationCount: responses.length,
          authoritativeResponseCount: responses.filter((response) => response.latestRevision).length,
          submittedResponseCount: responses.filter((response) => response.latestRevision?.status === "submitted").length,
          completeCoverageCount: responses.filter((response) => response.coverage.state === "complete").length,
          eligibleResponseCount: eligibleResponses.length,
        },
        limitations: limitationsFor(responses, comparisonAvailability),
      };
    },
  };
}

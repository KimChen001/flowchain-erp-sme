import {
  outboundDecimalUnits as units,
} from "./outbound-transaction-policy.mjs";

// The returns quantity ledger of a source document line (a shipment line or
// a receiving line), shared by the return request, the reversal of the
// source document, supplier bill matching and customer invoicing (design
// audit batch A10).
//
// - Returned: what posted, unreversed return postings physically executed
//   against the line. Only the customer return receipt and the supplier
//   return dispatch count; a quarantine release moves goods that a receipt
//   already brought in (L8-05).
// - Credited: what approved credits based on those returns took off the
//   bill or invoice. A draft credit has not changed what is owed yet.
// - Uncredited returned = returned - credited: goods that came back (or went
//   back) and are not yet settled by a credit, so they may not be billed or
//   matched as if they were still delivered (L2-06, L8-08).

const ZERO = 0n;
const text = (value) => String(value ?? "").trim();
const unique = (values) => [...new Set(values.map(text).filter(Boolean))];

const SOURCE_RULES = Object.freeze({
  ShipmentDocument: {
    postingType: "customer_return_receipt",
    creditLines: "customerCreditNoteLine",
    creditRelation: "customerCreditNote",
  },
  ReceivingDocument: {
    postingType: "supplier_return_dispatch",
    creditLines: "supplierCreditMemoLine",
    creditRelation: "supplierCreditMemo",
  },
});

const add = (map, key, value) =>
  map.set(key, (map.get(key) || ZERO) + value);

function rulesFor(sourceDocumentType) {
  const rules = SOURCE_RULES[text(sourceDocumentType)];
  if (!rules)
    throw new Error(`Unknown return source document type ${sourceDocumentType}.`);
  return rules;
}

// Returned quantity per source line, also split per return request line so a
// pending request can count only what is still outstanding on it.
export async function returnedSourceQuantities({
  prisma,
  tenantId,
  sourceDocumentType,
  sourceLineIds,
}) {
  const { postingType } = rulesFor(sourceDocumentType);
  const ids = unique(sourceLineIds);
  const bySourceLine = new Map();
  const byRequestLine = new Map();
  if (!ids.length) return { bySourceLine, byRequestLine };
  const rows = await prisma.returnPostingLine.findMany({
    where: {
      returnAuthorizationLine: {
        returnRequestLine: {
          sourceDocumentType: text(sourceDocumentType),
          sourceDocumentLineId: { in: ids },
          returnRequest: { tenantId },
        },
      },
      returnPosting: { tenantId, postingType, postingStatus: "posted" },
    },
    select: {
      quantity: true,
      returnAuthorizationLine: {
        select: {
          returnRequestLineId: true,
          returnRequestLine: { select: { sourceDocumentLineId: true } },
        },
      },
    },
  });
  for (const row of rows) {
    const quantity = units(row.quantity);
    add(
      bySourceLine,
      row.returnAuthorizationLine.returnRequestLine.sourceDocumentLineId,
      quantity,
    );
    add(byRequestLine, row.returnAuthorizationLine.returnRequestLineId, quantity);
  }
  return { bySourceLine, byRequestLine };
}

// Quantity of approved credits based on returns of these source lines.
export async function creditedSourceQuantities({
  prisma,
  tenantId,
  sourceDocumentType,
  sourceLineIds,
}) {
  const { postingType, creditLines, creditRelation } =
    rulesFor(sourceDocumentType);
  const ids = unique(sourceLineIds);
  const bySourceLine = new Map();
  if (!ids.length) return bySourceLine;
  const rows = await prisma[creditLines].findMany({
    where: {
      [creditRelation]: { tenantId, status: "approved" },
      returnPostingLine: {
        returnPosting: { tenantId, postingType, postingStatus: "posted" },
        returnAuthorizationLine: {
          returnRequestLine: {
            sourceDocumentType: text(sourceDocumentType),
            sourceDocumentLineId: { in: ids },
          },
        },
      },
    },
    select: {
      quantity: true,
      returnPostingLine: {
        select: {
          returnAuthorizationLine: {
            select: {
              returnRequestLine: { select: { sourceDocumentLineId: true } },
            },
          },
        },
      },
    },
  });
  for (const row of rows)
    add(
      bySourceLine,
      row.returnPostingLine.returnAuthorizationLine.returnRequestLine
        .sourceDocumentLineId,
      units(row.quantity),
    );
  return bySourceLine;
}

// Returned and not yet credited, per source line (never negative).
export async function uncreditedReturnedQuantities({
  prisma,
  tenantId,
  sourceDocumentType,
  sourceLineIds,
}) {
  const [returned, credited] = await Promise.all([
    returnedSourceQuantities({ prisma, tenantId, sourceDocumentType, sourceLineIds }),
    creditedSourceQuantities({ prisma, tenantId, sourceDocumentType, sourceLineIds }),
  ]);
  const result = new Map();
  for (const [lineId, quantity] of returned.bySourceLine) {
    const open = quantity - (credited.get(lineId) || ZERO);
    result.set(lineId, { returned: quantity, credited: credited.get(lineId) || ZERO, uncredited: open > ZERO ? open : ZERO });
  }
  return result;
}

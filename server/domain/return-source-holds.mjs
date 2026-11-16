// Return holds on a source document (a shipment or a receipt) and the source
// check repeated when a return posts (design audit batch A10, L8-07). No
// imports, so the shipment and receiving policies can use it without an
// import cycle.

const text = (value) => String(value ?? "").trim();
const unique = (values) => [...new Set(values.map(text).filter(Boolean))];

// A return request that is cancelled or rejected no longer holds anything.
export const CLOSED_RETURN_REQUEST_STATUSES = Object.freeze([
  "cancelled",
  "rejected",
]);

// Return requests, not cancelled or rejected, that reference lines of this
// source document (L8-07). While one exists the source document may not be
// reversed: the return names goods that the reversal would take back out of
// the record. Every such request has a way out (cancel the request, cancel or
// close its authorization, reverse its postings), so the hold is never
// permanent.
export async function sourceDocumentReturnHolds({
  prisma,
  tenantId,
  sourceDocumentType,
  sourceLineIds,
}) {
  const ids = unique(sourceLineIds);
  if (!ids.length) return [];
  const rows = await prisma.returnRequestLine.findMany({
    where: {
      sourceDocumentType: text(sourceDocumentType),
      sourceDocumentLineId: { in: ids },
      returnRequest: {
        tenantId,
        workflowStatus: { notIn: [...CLOSED_RETURN_REQUEST_STATUSES] },
      },
    },
    select: {
      returnRequest: {
        select: { id: true, requestNumber: true, workflowStatus: true },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.returnRequest.id, row.returnRequest]));
  return [...byId.values()].sort((a, b) =>
    text(a.requestNumber).localeCompare(text(b.requestNumber)),
  );
}

// A return posting may execute only while its source document is still
// posted: the reversal check above refuses to reverse a document a return
// names, and this repeats the source check of the request at posting time.
export async function returnSourceStillPostedIssues({
  prisma,
  tenantId,
  requestLines,
}) {
  const shipmentLineIds = unique(
    requestLines
      .filter((line) => line.sourceDocumentType === "ShipmentDocument")
      .map((line) => line.sourceDocumentLineId),
  );
  const receivingLineIds = unique(
    requestLines
      .filter((line) => line.sourceDocumentType === "ReceivingDocument")
      .map((line) => line.sourceDocumentLineId),
  );
  const [shipmentLines, receivingLines] = await Promise.all([
    shipmentLineIds.length
      ? prisma.shipmentLine.findMany({
          where: { id: { in: shipmentLineIds } },
          select: {
            id: true,
            shipment: {
              select: { tenantId: true, postingStatus: true, reversedAt: true },
            },
          },
        })
      : [],
    receivingLineIds.length
      ? prisma.receivingLine.findMany({
          where: { id: { in: receivingLineIds } },
          select: {
            id: true,
            receivingDocument: {
              select: { tenantId: true, postingStatus: true, reversedAt: true },
            },
          },
        })
      : [],
  ]);
  const live = (document) =>
    document?.tenantId === tenantId &&
    document.postingStatus === "posted" &&
    !document.reversedAt;
  // The request checked its source lines when it was created and submitted;
  // here a line whose document was reversed or unposted since then stops the
  // posting.
  const notPosted = [
    ...shipmentLines.filter((row) => !live(row.shipment)).map((row) => row.id),
    ...receivingLines
      .filter((row) => !live(row.receivingDocument))
      .map((row) => row.id),
  ].sort();
  return notPosted.length
    ? [
        {
          code: "RETURN_SOURCE_NOT_POSTED",
          message:
            "The shipment or receipt this return is based on is no longer posted, so the return cannot be posted.",
          status: 409,
          details: { sourceDocumentLineIds: notPosted },
        },
      ]
    : [];
}

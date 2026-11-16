import {
  outboundDecimalString as fixed,
  outboundDecimalUnits as units,
} from "./outbound-transaction-policy.mjs";

// How a return authorization is closed before it is fully executed:
// - cancel / expire: nothing was executed, so the request goes back to
//   "submitted" (or stays "executed" when an earlier authorization already
//   received or dispatched stock, for example a cancelled release);
// - close remainder: part was executed (a customer sent back 3 of 5), so the
//   unexecuted rest is closed per line and the authorization is executed.
// Postings that were cancelled as drafts or reversed no longer count.

const ZERO = 0n;
const text = (value) => String(value ?? "").trim();
const issue = (code, message, status = 422, details) => ({
  code,
  message,
  status,
  ...(details ? { details } : {}),
});

// Postings that physically execute a return. A quarantine release only moves
// stock that a receipt already brought in.
export const RETURN_EXECUTION_POSTING_TYPES = Object.freeze([
  "customer_return_receipt",
  "supplier_return_dispatch",
]);

// Authorized minus the closed remainder: the quantity postings may still use.
export function executableAuthorizedUnits(line) {
  return units(line?.authorizedQuantity || 0) - units(line?.closedQuantity || 0);
}

// A cancelled draft keeps postingStatus "unposted", so the workflow status
// has to be read too. A reversed posting keeps nothing in stock.
export function isLivePosting(posting) {
  if (posting?.postingStatus === "posted") return !posting.reversedAt;
  return (
    posting?.postingStatus === "unposted" &&
    posting?.workflowStatus !== "cancelled"
  );
}

const isPostedExecution = (posting) =>
  RETURN_EXECUTION_POSTING_TYPES.includes(posting?.postingType) &&
  posting?.postingStatus === "posted" &&
  !posting?.reversedAt;

// The request status once its active authorization is closed: "executed"
// while any receipt or supplier dispatch is still posted, else "submitted".
export function requestStatusAfterAuthorizationClose(authorizations = []) {
  return authorizations.some((authorization) =>
    (authorization.postings || []).some(isPostedExecution),
  )
    ? "executed"
    : "submitted";
}

export const RETURN_AUTHORIZATION_CLOSE_ACTIONS = Object.freeze([
  "cancel",
  "expire",
  "close_remainder",
]);

function warehouseIds(lines = []) {
  return [
    ...new Set(
      lines.flatMap((line) =>
        Array.isArray(line.sourceWarehouseIds)
          ? line.sourceWarehouseIds.map(text).filter(Boolean)
          : [],
      ),
    ),
  ].sort();
}

export async function buildReturnAuthorizationClosurePlan({
  prisma,
  tenantId,
  authorizationId,
  action,
  now = new Date(),
}) {
  const operation = `${action}_return_authorization`;
  const blockingIssues = [];
  const base = (extra = {}) => ({
    operation,
    allowed: blockingIssues.length === 0,
    blockingIssues,
    warnings: [],
    inventoryMutation: false,
    ...extra,
  });
  if (!RETURN_AUTHORIZATION_CLOSE_ACTIONS.includes(action)) {
    blockingIssues.push(
      issue("RETURN_COMMAND_INVALID", "Unknown return authorization close action.", 422),
    );
    return base();
  }
  const authorization = await prisma.returnAuthorization.findFirst({
    where: { id: text(authorizationId), tenantId },
    include: {
      lines: { orderBy: { id: "asc" } },
      postings: {
        include: { lines: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      returnRequest: {
        include: {
          lines: { orderBy: { id: "asc" } },
          authorizations: { include: { postings: true } },
        },
      },
    },
  });
  if (!authorization) {
    blockingIssues.push(
      issue("RETURN_AUTHORIZATION_NOT_FOUND", "Return authorization was not found.", 404),
    );
    return base();
  }
  const live = authorization.postings.filter(isLivePosting);
  const posted = live.filter((posting) => posting.postingStatus === "posted");
  const open = live.filter((posting) => posting.postingStatus === "unposted");
  if (action === "close_remainder") {
    if (authorization.workflowStatus !== "partially_executed")
      blockingIssues.push(
        issue(
          "RETURN_AUTHORIZATION_NO_REMAINDER",
          "Only a partly executed authorization has a remaining quantity to close.",
          409,
        ),
      );
  } else {
    if (
      !["draft", "approved"].includes(authorization.workflowStatus) ||
      posted.length
    )
      blockingIssues.push(
        issue(
          "RETURN_AUTHORIZATION_CANNOT_CLOSE",
          "Only an authorization with nothing posted can be cancelled or expired. Close the remaining quantity of a partly executed one instead.",
          409,
        ),
      );
    if (
      action === "expire" &&
      (!authorization.expiresAt || authorization.expiresAt > now)
    )
      blockingIssues.push(
        issue(
          "RETURN_AUTHORIZATION_NOT_EXPIRED",
          "The authorization has not reached its expiration timestamp.",
          409,
        ),
      );
  }
  if (open.length)
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_OPEN_POSTINGS",
        "Cancel or post the open return postings of this authorization first.",
        409,
        { postingNumbers: open.map((posting) => posting.postingNumber) },
      ),
    );
  const postedByLine = new Map();
  for (const posting of posted)
    for (const line of posting.lines || [])
      postedByLine.set(
        line.returnAuthorizationLineId,
        (postedByLine.get(line.returnAuthorizationLineId) || ZERO) +
          units(line.quantity),
      );
  const lines = authorization.lines.map((line) => {
    const executable = executableAuthorizedUnits(line);
    const postedUnits = postedByLine.get(line.id) || ZERO;
    const closing =
      action === "close_remainder" && executable > postedUnits
        ? executable - postedUnits
        : ZERO;
    const closedBefore = units(line.closedQuantity || 0);
    return {
      returnAuthorizationLineId: line.id,
      returnRequestLineId: line.returnRequestLineId,
      authorizedQuantity: fixed(units(line.authorizedQuantity)),
      postedQuantity: fixed(postedUnits),
      closedQuantityBefore: fixed(closedBefore),
      closingQuantity: fixed(closing),
      closedQuantityAfter: fixed(closedBefore + closing),
    };
  });
  if (
    action === "close_remainder" &&
    !blockingIssues.length &&
    lines.every((line) => units(line.closingQuantity) === ZERO)
  )
    blockingIssues.push(
      issue(
        "RETURN_AUTHORIZATION_NO_REMAINDER",
        "Only a partly executed authorization has a remaining quantity to close.",
        409,
      ),
    );
  const request = authorization.returnRequest;
  const authorizationsAfter = request.authorizations.map((row) =>
    row.id === authorization.id ? authorization : row,
  );
  return base({
    authorization,
    request,
    lines,
    warehouseIds: warehouseIds(request.lines),
    authorizationStatusAfter:
      action === "cancel"
        ? "cancelled"
        : action === "expire"
          ? "expired"
          : "executed",
    requestStatusAfter: requestStatusAfterAuthorizationClose(authorizationsAfter),
  });
}

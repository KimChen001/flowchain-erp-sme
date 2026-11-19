import assert from "node:assert/strict";
import test from "node:test";
import {
  returnAuthorizationAvailableActions,
  returnRequestAvailableActions,
} from "./return-governance-read-service.mjs";
import {
  buildReturnAuthorizationClosurePlan,
  executableAuthorizedUnits,
  isLivePosting,
  requestStatusAfterAuthorizationClose,
} from "./return-authorization-closure-policy.mjs";

const tenantId = "tenant-return-state";
const enabled = {
  "return-request": { enabled: true },
  "return-authorization": { enabled: true },
  "return-posting": { enabled: true },
};
const actor = (...codes) => ({
  complete: true,
  authenticated: true,
  tenantId,
  permissionCodes: new Set(codes),
  readWarehouseIds: new Set(),
  operateWarehouseIds: new Set(),
});
const draftRequest = (returnType = "supplier_return") => ({
  returnType,
  workflowStatus: "draft",
  authorizations: [],
});

test("each request button follows its own permission (L8-20)", () => {
  const submitOnly = returnRequestAvailableActions(
    actor("returns.request.submit"),
    draftRequest(),
    enabled,
  );
  assert.equal(submitOnly.submit, true);
  assert.equal(submitOnly.revise, false);
  assert.equal(submitOnly.cancel, false);

  const cancelOnly = returnRequestAvailableActions(
    actor("returns.request.cancel"),
    draftRequest(),
    enabled,
  );
  assert.equal(cancelOnly.cancel, true);
  assert.equal(cancelOnly.submit, false);
  assert.equal(cancelOnly.revise, false);

  const reviseOnly = returnRequestAvailableActions(
    actor("returns.request.revise"),
    draftRequest(),
    enabled,
  );
  assert.equal(reviseOnly.revise, true);
  assert.equal(reviseOnly.submit, false);
  assert.equal(reviseOnly.cancel, false);
  assert.deepEqual(reviseOnly.blockingReasonCodes, []);

  // A customer return draft is revised only by someone who manages customer
  // return requests, as the revise command requires.
  assert.equal(
    returnRequestAvailableActions(
      actor("returns.request.revise"),
      draftRequest("customer_return"),
      enabled,
    ).revise,
    false,
  );
  assert.equal(
    returnRequestAvailableActions(
      actor("returns.request.revise", "returns.customer_request.manage"),
      draftRequest("customer_return"),
      enabled,
    ).revise,
    true,
  );
  assert.deepEqual(
    returnRequestAvailableActions(actor(), draftRequest(), enabled)
      .blockingReasonCodes,
    ["PERMISSION_DENIED"],
  );
});

const posting = (postingNumber, postingStatus, workflowStatus, extra = {}) => ({
  postingNumber,
  postingStatus,
  workflowStatus,
  reversedAt: postingStatus === "reversed" ? new Date() : null,
  ...extra,
});

test("cancelled drafts and reversed postings do not keep an authorization open (L8-06)", () => {
  const manager = actor(
    "returns.authorization.cancel",
    "returns.authorization.expire",
  );
  const now = new Date("2026-11-15T12:00:00Z");
  const approved = {
    workflowStatus: "approved",
    expiresAt: new Date("2026-11-14T00:00:00Z"),
    postings: [
      posting("P-1", "unposted", "cancelled"),
      posting("P-2", "reversed", "ready"),
    ],
  };
  const actions = returnAuthorizationAvailableActions(
    manager,
    approved,
    enabled,
    now,
  );
  assert.equal(actions.cancel, true);
  assert.equal(actions.expire, true);
  assert.equal(actions.closeRemainder, false);
  assert.deepEqual(actions.openPostingNumbers, []);

  const withDraft = returnAuthorizationAvailableActions(
    manager,
    { ...approved, postings: [posting("P-3", "unposted", "draft")] },
    enabled,
    now,
  );
  assert.equal(withDraft.cancel, false);
  assert.equal(withDraft.expire, false);
  assert.deepEqual(withDraft.openPostingNumbers, ["P-3"]);

  const partial = {
    workflowStatus: "partially_executed",
    expiresAt: null,
    postings: [posting("P-4", "posted", "ready")],
  };
  const partialActions = returnAuthorizationAvailableActions(
    manager,
    partial,
    enabled,
    now,
  );
  assert.equal(partialActions.cancel, false);
  assert.equal(partialActions.closeRemainder, true);
  assert.equal(
    returnAuthorizationAvailableActions(
      manager,
      { ...partial, postings: [...partial.postings, posting("P-5", "unposted", "ready")] },
      enabled,
      now,
    ).closeRemainder,
    false,
  );
});

test("live postings, executable quantity and the request status after a close", () => {
  assert.equal(isLivePosting(posting("A", "posted", "ready")), true);
  assert.equal(isLivePosting(posting("B", "unposted", "draft")), true);
  assert.equal(isLivePosting(posting("C", "unposted", "cancelled")), false);
  assert.equal(isLivePosting(posting("D", "reversed", "ready")), false);
  assert.equal(
    executableAuthorizedUnits({ authorizedQuantity: "5", closedQuantity: "2" }),
    30000n,
  );
  // A cancelled release keeps an executed customer return executed (L8-04).
  assert.equal(
    requestStatusAfterAuthorizationClose([
      { postings: [posting("R", "posted", "ready", { postingType: "customer_return_receipt" })] },
      { postings: [] },
    ]),
    "executed",
  );
  assert.equal(
    requestStatusAfterAuthorizationClose([
      { postings: [posting("R", "reversed", "ready", { postingType: "customer_return_receipt" })] },
    ]),
    "submitted",
  );
  assert.equal(
    requestStatusAfterAuthorizationClose([
      { postings: [posting("Q", "posted", "ready", { postingType: "quarantine_release" })] },
    ]),
    "submitted",
  );
});

function fakePrisma(authorization) {
  return {
    returnAuthorization: {
      findFirst: async ({ where }) =>
        where.id === authorization.id && where.tenantId === tenantId
          ? authorization
          : null,
    },
  };
}

function partlyReceived() {
  const receipt = {
    id: "posting-receipt",
    postingNumber: "CRR-1",
    postingType: "customer_return_receipt",
    postingStatus: "posted",
    workflowStatus: "ready",
    reversedAt: null,
    lines: [{ returnAuthorizationLineId: "auth-line-1", quantity: "3" }],
  };
  const authorization = {
    id: "auth-1",
    workflowStatus: "partially_executed",
    expiresAt: null,
    lines: [
      {
        id: "auth-line-1",
        returnRequestLineId: "request-line-1",
        authorizedQuantity: "5",
        closedQuantity: "0",
      },
    ],
    postings: [receipt],
  };
  authorization.returnRequest = {
    id: "request-1",
    lines: [{ id: "request-line-1", sourceWarehouseIds: ["wh-1"] }],
    authorizations: [authorization],
  };
  return authorization;
}

test("authorize 5, receive 3: closing the remainder closes 2 and executes the request (L8-03)", async () => {
  const authorization = partlyReceived();
  const plan = await buildReturnAuthorizationClosurePlan({
    prisma: fakePrisma(authorization),
    tenantId,
    authorizationId: "auth-1",
    action: "close_remainder",
  });
  assert.equal(plan.allowed, true, JSON.stringify(plan.blockingIssues));
  assert.deepEqual(
    plan.lines.map((line) => [
      line.postedQuantity,
      line.closingQuantity,
      line.closedQuantityAfter,
    ]),
    [["3.0000", "2.0000", "2.0000"]],
  );
  assert.equal(plan.authorizationStatusAfter, "executed");
  assert.equal(plan.requestStatusAfter, "executed");
  assert.deepEqual(plan.warehouseIds, ["wh-1"]);

  // Cancelling is for authorizations with nothing posted.
  const cancel = await buildReturnAuthorizationClosurePlan({
    prisma: fakePrisma(partlyReceived()),
    tenantId,
    authorizationId: "auth-1",
    action: "cancel",
  });
  assert.equal(cancel.allowed, false);
  assert.equal(cancel.blockingIssues[0].code, "RETURN_AUTHORIZATION_CANNOT_CLOSE");

  // An open draft has to be cancelled or posted first.
  const withDraft = partlyReceived();
  withDraft.postings.push({
    id: "posting-draft",
    postingNumber: "CRR-2",
    postingType: "customer_return_receipt",
    postingStatus: "unposted",
    workflowStatus: "draft",
    reversedAt: null,
    lines: [{ returnAuthorizationLineId: "auth-line-1", quantity: "1" }],
  });
  const blocked = await buildReturnAuthorizationClosurePlan({
    prisma: fakePrisma(withDraft),
    tenantId,
    authorizationId: "auth-1",
    action: "close_remainder",
  });
  assert.deepEqual(
    blocked.blockingIssues.map((row) => row.code),
    ["RETURN_AUTHORIZATION_OPEN_POSTINGS"],
  );
  assert.deepEqual(blocked.blockingIssues[0].details.postingNumbers, ["CRR-2"]);
});

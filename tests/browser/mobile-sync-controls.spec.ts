import { expect, test } from "@playwright/test";

test.setTimeout(180_000);

async function login(request: any, email: string) {
  const response = await request.post("/api/auth/login", { data: { email, name: "Ignored", company: "Ignored" } });
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function api(request: any, token: string, method: string, path: string, data?: any, extraHeaders: Record<string, string> = {}) {
  const response = await request[method](path, { headers: { Authorization: `Bearer ${token}`, ...extraHeaders }, ...(data === undefined ? {} : { data }) });
  const body = await response.json();
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${response.status()} ${JSON.stringify(body)}`).toBeTruthy();
  return body;
}

async function initialSync(request: any, token: string, deviceId: string) {
  const registered = await api(request, token, "post", "/api/sync/clients/register", { deviceId, platform: "pwa", appVersion: "0.5.2c1" }, { "X-Device-Id": deviceId });
  const changes: any[] = [];
  let page = await api(request, token, "get", `/api/sync/initial?clientId=${encodeURIComponent(registered.clientId)}&deviceId=${encodeURIComponent(deviceId)}&pageSize=2`, undefined, { "X-Device-Id": deviceId });
  changes.push(...page.changes);
  while (page.hasMore) {
    page = await api(request, token, "get", `/api/sync/initial?clientId=${encodeURIComponent(registered.clientId)}&deviceId=${encodeURIComponent(deviceId)}&snapshotSessionId=${encodeURIComponent(page.snapshotSessionId)}&snapshotCursor=${encodeURIComponent(page.snapshotCursor)}`, undefined, { "X-Device-Id": deviceId });
    changes.push(...page.changes);
  }
  return { registered, changes, cursor: page.cursor };
}

test("mobile sync browser acceptance enforces cursor/device, monotonic acknowledgement, and revocation controls", async ({ request }) => {
  const mobile = await login(request, "mobile@example.com");
  const deviceA = "browser-sync-controls-device-a";
  const registrationA = await api(request, mobile.token, "post", "/api/sync/clients/register", { deviceId: deviceA, platform: "pwa", appVersion: "0.5.2c1" }, { "X-Device-Id": deviceA });
  let initial = await api(request, mobile.token, "get", `/api/sync/initial?clientId=${encodeURIComponent(registrationA.clientId)}&deviceId=${encodeURIComponent(deviceA)}&pageSize=2`, undefined, { "X-Device-Id": deviceA });
  expect(initial.consistencyContract).toBe("convergent_keyset_initial_sync");
  expect(initial.pageSize).toBe(2);
  while (initial.hasMore) {
    expect(typeof initial.nextEntityType).toBe("string");
    initial = await api(request, mobile.token, "get", `/api/sync/initial?clientId=${encodeURIComponent(registrationA.clientId)}&deviceId=${encodeURIComponent(deviceA)}&snapshotSessionId=${encodeURIComponent(initial.snapshotSessionId)}&snapshotCursor=${encodeURIComponent(initial.snapshotCursor)}`, undefined, { "X-Device-Id": deviceA });
  }
  const deviceB = "browser-sync-controls-device-b";
  const initialB = await initialSync(request, mobile.token, deviceB);
  await api(request, mobile.token, "post", "/api/mobile/receiving/drafts", { poId: "mobile-browser-receiving-po", warehouseId: "finance-browser-warehouse", lines: [{ purchaseOrderLineId: "mobile-browser-receiving-po-line", acceptedQuantity: "0.1000", location: "SYNC-01" }], idempotencyKey: "mobile-browser-sync-control-change", clientMutationId: "mobile-browser-sync-control-change", sourceDeviceId: deviceA }, { "X-Device-Id": deviceA });
  const changes = await api(request, mobile.token, "get", `/api/sync/changes?clientId=${encodeURIComponent(registrationA.clientId)}&deviceId=${encodeURIComponent(deviceA)}&cursor=${encodeURIComponent(initial.cursor)}`, undefined, { "X-Device-Id": deviceA });
  expect(changes.changes.length).toBeGreaterThan(0);
  const acknowledged = await api(request, mobile.token, "post", "/api/sync/acknowledge", { clientId: registrationA.clientId, deviceId: deviceA, cursor: changes.cursor }, { "X-Device-Id": deviceA });
  const equal = await api(request, mobile.token, "post", "/api/sync/acknowledge", { clientId: registrationA.clientId, deviceId: deviceA, cursor: changes.cursor }, { "X-Device-Id": deviceA });
  expect(equal.acknowledgedSequence).toBe(acknowledged.acknowledgedSequence);
  const regression = await request.post("/api/sync/acknowledge", { headers: { Authorization: `Bearer ${mobile.token}`, "X-Device-Id": deviceA }, data: { clientId: registrationA.clientId, deviceId: deviceA, cursor: initial.cursor } });
  expect(regression.status()).toBe(409);
  expect((await regression.json()).code).toBe("SYNC_ACKNOWLEDGEMENT_REGRESSION");
  const deviceBChanges = await api(request, mobile.token, "get", `/api/sync/changes?clientId=${encodeURIComponent(initialB.registered.clientId)}&deviceId=${encodeURIComponent(deviceB)}&cursor=${encodeURIComponent(initialB.cursor)}`, undefined, { "X-Device-Id": deviceB });
  expect(deviceBChanges.changes.length).toBeGreaterThan(0);
  const observedByA = new Set(changes.changes.map((change: any) => `${change.entityType}:${change.entityId}:${change.operation}`));
  expect(deviceBChanges.changes.some((change: any) => observedByA.has(`${change.entityType}:${change.entityId}:${change.operation}`))).toBeTruthy();
  const deviceBAck = await api(request, mobile.token, "post", "/api/sync/acknowledge", { clientId: initialB.registered.clientId, deviceId: deviceB, cursor: deviceBChanges.cursor }, { "X-Device-Id": deviceB });
  expect(Number(deviceBAck.acknowledgedSequence)).toBeGreaterThan(0);
  const crossDevice = await request.get(`/api/sync/changes?clientId=${encodeURIComponent(initialB.registered.clientId)}&deviceId=${encodeURIComponent(deviceB)}&cursor=${encodeURIComponent(changes.cursor)}`, { headers: { Authorization: `Bearer ${mobile.token}`, "X-Device-Id": deviceB } });
  expect(crossDevice.status()).toBe(403);
  expect((await crossDevice.json()).code).toBe("SYNC_CURSOR_DEVICE_MISMATCH");
  await api(request, mobile.token, "post", `/api/sync/clients/${encodeURIComponent(registrationA.clientId)}/revoke`, { deviceId: deviceA }, { "X-Device-Id": deviceA });
  const revoked = await request.get(`/api/sync/changes?clientId=${encodeURIComponent(registrationA.clientId)}&deviceId=${encodeURIComponent(deviceA)}&cursor=${encodeURIComponent(changes.cursor)}`, { headers: { Authorization: `Bearer ${mobile.token}`, "X-Device-Id": deviceA } });
  expect(revoked.status()).toBe(403);
  expect((await revoked.json()).code).toBe("SYNC_CLIENT_REVOKED");
});

test("browser API acceptance proves CustomerInvoice read isolation, warehouse tombstones, and role-change reset", async ({ request }) => {
  const admin = await login(request, "admin@example.com");
  const role = async (name: string, permissionCodes: string[]) => api(request, admin.token, "post", "/api/authorization/roles", { name, roleKey: name.toLowerCase().replaceAll(" ", "-"), permissionCodes });
  const mobileUse = await role("Sync Browser Mobile Use", ["mobile.sync.use"]);
  const createOnly = await role("Sync Browser Create Only", ["mobile.sync.use", "finance.customer_invoice.create", "finance.amounts.read", "finance.partner_snapshot.read"]);
  const invoiceReader = await role("Sync Browser Invoice Reader", ["mobile.sync.use", "finance.customer_invoice.read"]);
  const receiver = await role("Sync Browser Warehouse Receiver", ["mobile.sync.use", "mobile.receiving.prepare", "receiving.prepare", "receiving.read"]);
  const model = await api(request, admin.token, "get", "/api/authorization/roles");
  const user = (email: string) => model.users.find((item: any) => item.email === email);
  const viewer = user("viewer@example.com");
  const createUser = user("sync-create@example.com");
  const warehouseAUser = user("sync-warehouse-a@example.com");
  const warehouseBUser = user("sync-warehouse-b@example.com");
  await api(request, admin.token, "put", `/api/authorization/users/${viewer.id}/roles`, { roleIds: [...viewer.roleIds, mobileUse.id] });
  await api(request, admin.token, "put", `/api/authorization/users/${createUser.id}/roles`, { roleIds: [createOnly.id] });
  await api(request, admin.token, "put", `/api/authorization/users/${warehouseAUser.id}/roles`, { roleIds: [receiver.id] });
  await api(request, admin.token, "put", `/api/authorization/users/${warehouseBUser.id}/roles`, { roleIds: [receiver.id] });

  const readSession = await login(request, "viewer@example.com");
  const createSession = await login(request, "sync-create@example.com");
  const readInitial = await initialSync(request, readSession.token, "sync-browser-read-only");
  const createInitial = await initialSync(request, createSession.token, "sync-browser-create-only");
  const invoice = readInitial.changes.find((change) => change.entityType === "CustomerInvoice");
  expect(invoice).toBeTruthy();
  expect(invoice.projection.amount).toBeNull();
  expect(invoice.projection.customerId).toBeNull();
  expect(createInitial.changes.some((change) => change.entityType === "CustomerInvoice")).toBeFalsy();

  await api(request, admin.token, "put", `/api/authorization/users/${createUser.id}/roles`, { roleIds: [invoiceReader.id] });
  const changesUrl = `/api/sync/changes?clientId=${encodeURIComponent(createInitial.registered.clientId)}&deviceId=sync-browser-create-only&cursor=${encodeURIComponent(createInitial.cursor)}`;
  // A role change ends the user's sessions, so the old token is refused outright.
  const ended = await request.get(changesUrl, { headers: { Authorization: `Bearer ${createSession.token}`, "X-Device-Id": "sync-browser-create-only" } });
  expect(ended.status()).toBe(401);
  // Signing in again does not revive the cursor issued under the old roles.
  const createSessionAfterRoleChange = await login(request, "sync-create@example.com");
  const reset = await request.get(changesUrl, { headers: { Authorization: `Bearer ${createSessionAfterRoleChange.token}`, "X-Device-Id": "sync-browser-create-only" } });
  expect(reset.status()).toBe(409);
  const resetBody = await reset.json();
  expect(resetBody.code).toBe("SYNC_AUTHORIZATION_CHANGED");
  expect(resetBody.resetRequired).toBeTruthy();

  const sessionA = await login(request, "sync-warehouse-a@example.com");
  const sessionB = await login(request, "sync-warehouse-b@example.com");
  const initialA = await initialSync(request, sessionA.token, "sync-browser-warehouse-device-a");
  const initialB = await initialSync(request, sessionB.token, "sync-browser-warehouse-device-b");
  const evidence = async (session: any, receivingId: string, suffix: string) => {
    const bytes = Buffer.from(`warehouse ${suffix} evidence`).toString("base64");
    const staged = await api(request, session.token, "post", "/api/uploads/stage", { fileName: `${suffix}.txt`, mimeType: "text/plain", contentBase64: bytes });
    const bound = await api(request, session.token, "post", `/api/receiving/drafts/${receivingId}/attachments`, { uploadId: staged.uploadId, sourceDeviceId: `warehouse-${suffix}` });
    await api(request, session.token, "delete", `/api/attachments/${bound.attachmentId}`);
    return bound.attachmentId;
  };
  const attachmentA = await evidence(sessionA, "sync-browser-receiving-a", "a");
  const attachmentB = await evidence(sessionB, "sync-browser-receiving-b", "b");
  const changesA = await api(request, sessionA.token, "get", `/api/sync/changes?clientId=${encodeURIComponent(initialA.registered.clientId)}&deviceId=sync-browser-warehouse-device-a&cursor=${encodeURIComponent(initialA.cursor)}`, undefined, { "X-Device-Id": "sync-browser-warehouse-device-a" });
  const changesB = await api(request, sessionB.token, "get", `/api/sync/changes?clientId=${encodeURIComponent(initialB.registered.clientId)}&deviceId=sync-browser-warehouse-device-b&cursor=${encodeURIComponent(initialB.cursor)}`, undefined, { "X-Device-Id": "sync-browser-warehouse-device-b" });
  const tombstonesA = changesA.changes.filter((change) => change.entityType === "ReceivingAttachment" && change.operation === "tombstone");
  const tombstonesB = changesB.changes.filter((change) => change.entityType === "ReceivingAttachment" && change.operation === "tombstone");
  expect(tombstonesA.some((change) => change.entityId === attachmentA)).toBeTruthy();
  expect(tombstonesA.some((change) => change.entityId === attachmentB)).toBeFalsy();
  expect(tombstonesB.some((change) => change.entityId === attachmentB)).toBeTruthy();
  expect(tombstonesB.some((change) => change.entityId === attachmentA)).toBeFalsy();
});

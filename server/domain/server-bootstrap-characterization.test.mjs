import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createScmServer } from "../bootstrap/scm-server.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function request(port, method, pathname) {
  return await new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, method, path: pathname }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("server bootstrap preserves health, preflight, session, API 404, and SPA boundaries", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:5432/flowchain_server_characterization";
  const server = createScmServer();
  try {
    const port = await listen(server);
    const health = await request(port, "GET", "/api/health");
    const preflight = await request(port, "OPTIONS", "/api/anything");
    const session = await request(port, "GET", "/api/auth/me");
    const missingApi = await request(port, "GET", "/api/not-a-route");
    const spa = await request(port, "GET", "/app/procurement/orders");
    const missingAsset = await request(port, "GET", "/assets/not-a-real-build-chunk.js");

    assert.equal(health.status, 200);
    const healthPayload = JSON.parse(health.body);
    assert.deepEqual({
      ok: healthPayload.ok,
      service: healthPayload.service,
      persistenceMode: healthPayload.persistenceMode,
      dataMode: healthPayload.dataMode,
      readsDemoData: healthPayload.readsDemoData,
      authority: healthPayload.authority,
    }, {
      ok: true,
      service: "flowchain-scm-api",
      persistenceMode: "database",
      dataMode: "user",
      readsDemoData: false,
      authority: "postgresql",
    });
    assert.equal(preflight.status, 204);
    assert.deepEqual(JSON.parse(session.body), {
      code: "INVALID_SESSION",
      error: "invalid or expired workspace session token",
    });
    assert.equal(session.status, 401);
    assert.equal(missingApi.status, 404);
    assert.deepEqual(JSON.parse(missingApi.body), { error: "Not found" });
    assert.equal(spa.status, 200);
    assert.match(spa.headers["content-type"], /^text\/html/);
    assert.equal(spa.headers["cache-control"], "no-cache");
    assert.equal(missingAsset.status, 404);
    assert.doesNotMatch(missingAsset.headers["content-type"] || "", /^text\/html/);
  } finally {
    await close(server);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

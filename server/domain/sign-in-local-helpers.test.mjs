import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRuntimeRoutes } from "../bootstrap/runtime-routes.mjs";
import { sendStaticAsset } from "../bootstrap/static-assets.mjs";
import { createOutboxMailer } from "../mail/outbox-mailer.mjs";

function fakeResponse() {
  const response = { status: 0, headers: {}, body: "" };
  response.writeHead = (status, headers = {}) => { response.status = status; response.headers = headers; };
  response.end = (body) => { response.body = body ? String(body) : ""; };
  return response;
}

async function getLinks(env, search = "") {
  const res = fakeResponse();
  const handled = await handleRuntimeRoutes({ req: { method: "GET" }, res, url: new URL(`http://local/api/dev/sign-in-links${search}`), env });
  assert.equal(handled, true);
  return { status: res.status, body: JSON.parse(res.body) };
}

test("the sign-in link helper reads the local outbox only while local development is on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowchain-sign-in-helper-"));
  try {
    const outbox = join(directory, "outbox.json");
    const mailer = createOutboxMailer({ path: outbox });
    await mailer.send({ to: "admin@flowchain.local", subject: "Your FlowChain sign-in link", text: "Sign in\n\nhttp://127.0.0.1:5173/sign-in/confirm?token=first_TOKEN-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", html: "", tag: "sign-in-link" });
    await mailer.send({ to: "kim@example.com", subject: "Other", text: "No link here", html: "", tag: "other" });
    await mailer.send({ to: "admin@flowchain.local", subject: "Your FlowChain sign-in link", text: "Sign in\n\nhttp://127.0.0.1:5173/sign-in/confirm?token=second_TOKEN-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", html: "", tag: "sign-in-link" });
    const local = { NODE_ENV: "development", FLOWCHAIN_DEV_LOCAL: "true", DATABASE_URL: "postgresql://user:pass@127.0.0.1:5432/flowchain", FLOWCHAIN_MAIL_OUTBOX_PATH: outbox };

    const links = await getLinks(local, "?email=Admin@FlowChain.local");
    assert.equal(links.status, 200);
    assert.deepEqual(links.body.links.map((link) => link.url), [
      "http://127.0.0.1:5173/sign-in/confirm?token=second_TOKEN-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "http://127.0.0.1:5173/sign-in/confirm?token=first_TOKEN-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    assert.deepEqual((await getLinks(local, "?email=kim@example.com")).body.links, []);
    assert.deepEqual((await getLinks({ ...local, FLOWCHAIN_MAIL_PROVIDER: "postmark" })).body.links, [], "only the outbox is read");

    for (const env of [
      { ...local, NODE_ENV: "production" },
      { ...local, NODE_ENV: "test" },
      { ...local, FLOWCHAIN_DEV_LOCAL: "false" },
      { ...local, DATABASE_URL: "postgresql://user:pass@db.example.com:5432/flowchain" },
    ]) {
      const hidden = await getLinks(env);
      assert.equal(hidden.status, 404);
      assert.equal(JSON.stringify(hidden.body).includes("token"), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the static server sends Referrer-Policy: no-referrer for the sign-in confirm page only", async () => {
  const distDir = await mkdtemp(join(tmpdir(), "flowchain-dist-"));
  try {
    await writeFile(join(distDir, "index.html"), "<!doctype html><title>FlowChain</title>");
    const serve = async (path) => {
      const res = fakeResponse();
      await sendStaticAsset({ req: { method: "GET" }, res, url: new URL(`http://local${path}`), distDir });
      return res;
    };
    const confirm = await serve("/sign-in/confirm?token=abc");
    assert.equal(confirm.status, 200);
    assert.equal(confirm.headers["Referrer-Policy"], "no-referrer");
    const app = await serve("/app/overview");
    assert.equal(app.status, 200);
    assert.equal(app.headers["Referrer-Policy"], undefined);
  } finally {
    await rm(distDir, { recursive: true, force: true });
  }
});

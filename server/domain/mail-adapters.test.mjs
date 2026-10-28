import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailer, mailProviderName } from "../mail/mailer.mjs";
import { createOutboxMailer, defaultOutboxPath, readOutbox } from "../mail/outbox-mailer.mjs";
import { createPostmarkMailer } from "../mail/postmark-mailer.mjs";
import { createResendMailer } from "../mail/resend-mailer.mjs";

const message = { to: "buyer@example.com", subject: "Your FlowChain sign-in link", text: "Plain text", html: "<p>HTML</p>", tag: "sign-in-link" };

// Records every request the adapter makes; it never reaches the network.
function fakeFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const { status = 200, body = {} } = respond(calls.at(-1));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, calls };
}

test("the Postmark adapter posts one message to the Postmark email API with the server token", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: { ErrorCode: 0, Message: "OK", MessageID: "pm-123" } }));
  const mailer = createPostmarkMailer({ serverToken: "pm-test-token", from: "FlowChain <signin@example.com>", fetch });
  const result = await mailer.send(message);
  assert.deepEqual(result, { provider: "postmark", messageId: "pm-123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.postmarkapp.com/email");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-Postmark-Server-Token"], "pm-test-token");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.deepEqual(calls[0].body, {
    From: "FlowChain <signin@example.com>",
    To: "buyer@example.com",
    Subject: message.subject,
    TextBody: message.text,
    HtmlBody: message.html,
    Tag: "sign-in-link",
    MessageStream: "outbound",
  });
});

test("a Postmark rejection fails with the provider code and never echoes the token", async () => {
  const { fetch } = fakeFetch(() => ({ status: 422, body: { ErrorCode: 300, Message: "Invalid email request" } }));
  const mailer = createPostmarkMailer({ serverToken: "pm-secret-token", from: "signin@example.com", fetch });
  await assert.rejects(mailer.send(message), (error) => {
    assert.equal(error.code, "MAIL_DELIVERY_FAILED");
    assert.equal(error.provider, "postmark");
    assert.equal(error.status, 422);
    assert.equal(error.providerCode, "300");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /pm-secret-token/);
    return true;
  });
  // Postmark can also answer 200 with a non-zero ErrorCode.
  const soft = createPostmarkMailer({ serverToken: "t", from: "signin@example.com", fetch: fakeFetch(() => ({ body: { ErrorCode: 406, Message: "Inactive recipient" } })).fetch });
  await assert.rejects(soft.send(message), { code: "MAIL_DELIVERY_FAILED", providerCode: "406" });
});

test("the Resend adapter posts one message to the Resend emails API with a bearer key", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: { id: "rs-456" } }));
  const mailer = createResendMailer({ apiKey: "re_test_key", from: "FlowChain <signin@example.com>", fetch });
  const result = await mailer.send(message);
  assert.deepEqual(result, { provider: "resend", messageId: "rs-456" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_test_key");
  assert.deepEqual(calls[0].body, {
    from: "FlowChain <signin@example.com>",
    to: ["buyer@example.com"],
    subject: message.subject,
    text: message.text,
    html: message.html,
    tags: [{ name: "category", value: "sign-in-link" }],
  });
});

test("a Resend rejection fails with the provider code and never echoes the key", async () => {
  const { fetch } = fakeFetch(() => ({ status: 403, body: { statusCode: 403, name: "validation_error", message: "Domain not verified" } }));
  const mailer = createResendMailer({ apiKey: "re_secret_key", from: "signin@example.com", fetch });
  await assert.rejects(mailer.send(message), (error) => {
    assert.equal(error.code, "MAIL_DELIVERY_FAILED");
    assert.equal(error.provider, "resend");
    assert.equal(error.status, 403);
    assert.equal(error.providerCode, "validation_error");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /re_secret_key/);
    return true;
  });
});

test("the outbox adapter appends messages to a local JSON file that tests can read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowchain-outbox-test-"));
  try {
    const path = join(directory, "outbox.json");
    const mailer = createOutboxMailer({ path });
    assert.deepEqual(await readOutbox(path), []);
    const [first, second] = await Promise.all([mailer.send(message), mailer.send({ ...message, to: "viewer@example.com" })]);
    assert.equal(first.provider, "outbox");
    assert.notEqual(first.messageId, second.messageId);
    const messages = await readOutbox(path);
    assert.deepEqual(messages.map((entry) => entry.to), ["buyer@example.com", "viewer@example.com"]);
    assert.equal(messages[0].subject, message.subject);
    assert.equal(messages[0].text, message.text);
    assert.equal(messages[0].html, message.html);
    assert.equal(messages[0].tag, "sign-in-link");
    assert.ok(messages[0].createdAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a message is not lost while a reader holds the outbox file open", async () => {
  // On Windows the rename that replaces the outbox fails while the file is
  // open (a test polling it, a virus scanner); the adapter retries it.
  const directory = await mkdtemp(join(tmpdir(), "flowchain-outbox-test-"));
  try {
    const path = join(directory, "outbox.json");
    const mailer = createOutboxMailer({ path });
    await mailer.send(message);
    const handle = await open(path, "r");
    const sending = mailer.send({ ...message, to: "approver@example.com" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.close();
    assert.equal((await sending).provider, "outbox");
    assert.deepEqual((await readOutbox(path)).map((entry) => entry.to), ["buyer@example.com", "approver@example.com"]);
    assert.deepEqual(await readdir(directory), ["outbox.json"], "no temporary file is left behind");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the outbox defaults to the OS temp directory, never the repository", () => {
  assert.ok(defaultOutboxPath().startsWith(tmpdir()));
  assert.equal(defaultOutboxPath({ FLOWCHAIN_MAIL_OUTBOX_PATH: "/tmp/custom.json" }), "/tmp/custom.json");
});

test("FLOWCHAIN_MAIL_PROVIDER selects the adapter, defaulting to the outbox outside production", async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: { ErrorCode: 0, MessageID: "pm-1", id: "rs-1" } }));
  assert.equal(mailProviderName({}), "outbox");
  assert.equal(mailProviderName({ FLOWCHAIN_MAIL_PROVIDER: " Postmark " }), "postmark");
  assert.equal(createMailer({ FLOWCHAIN_MAIL_PROVIDER: "outbox", FLOWCHAIN_MAIL_OUTBOX_PATH: join(tmpdir(), "unused.json") }).provider, "outbox");

  const postmark = createMailer({ FLOWCHAIN_MAIL_PROVIDER: "postmark", POSTMARK_SERVER_TOKEN: "pm", FLOWCHAIN_MAIL_FROM: "signin@example.com" }, { fetch });
  assert.equal(postmark.provider, "postmark");
  await postmark.send(message);
  const resend = createMailer({ FLOWCHAIN_MAIL_PROVIDER: "resend", RESEND_API_KEY: "re", FLOWCHAIN_MAIL_FROM: "signin@example.com" }, { fetch });
  assert.equal(resend.provider, "resend");
  await resend.send(message);
  assert.deepEqual(calls.map((call) => new URL(call.url).host), ["api.postmarkapp.com", "api.resend.com"]);

  assert.throws(() => createMailer({ FLOWCHAIN_MAIL_PROVIDER: "smtp" }), { code: "MAIL_PROVIDER_UNSUPPORTED" });
  assert.throws(() => createMailer({ FLOWCHAIN_MAIL_PROVIDER: "postmark", FLOWCHAIN_MAIL_FROM: "signin@example.com" }), { code: "MAIL_PROVIDER_CONFIG_REQUIRED" });
  assert.throws(() => createMailer({ FLOWCHAIN_MAIL_PROVIDER: "resend", RESEND_API_KEY: "re" }), { code: "MAIL_PROVIDER_CONFIG_REQUIRED" });
  assert.throws(() => createMailer({ NODE_ENV: "production" }), { code: "MAIL_PROVIDER_CONFIG_REQUIRED" });
  assert.throws(() => createMailer({ NODE_ENV: "production", FLOWCHAIN_MAIL_PROVIDER: "outbox" }), { code: "MAIL_OUTBOX_FORBIDDEN" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { dispatchRouteHandlers } from "../bootstrap/route-dispatcher.mjs";

test("route dispatcher preserves order and stops after the first handled route", async () => {
  const calls = [];
  const handled = await dispatchRouteHandlers(
    { requestId: "request-1" },
    [
      async context => {
        calls.push(["first", context.requestId]);
        return false;
      },
      async context => {
        calls.push(["second", context.requestId]);
        return true;
      },
      async () => {
        throw new Error("must not run after a handled route");
      },
    ],
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    ["first", "request-1"],
    ["second", "request-1"],
  ]);
});

test("route dispatcher reports an unhandled request after every handler declines", async () => {
  const calls = [];
  const handled = await dispatchRouteHandlers(
    {},
    [
      async () => {
        calls.push("first");
        return false;
      },
      async () => {
        calls.push("second");
        return false;
      },
    ],
  );

  assert.equal(handled, false);
  assert.deepEqual(calls, ["first", "second"]);
});


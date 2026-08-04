import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { getAiToolRegistry } from "./ai-tool-registry.mjs";
import { getAiToolHandlerRegistry } from "./ai-tool-handler-registry.mjs";
import {
  AI_HANDLER_IDS,
  aiHandlersForPhase,
  createAiHandlerRegistry,
} from "../routes/ai-handler-registry.mjs";

test("AI handler registry keeps unique ordered phases and stable precedence", () => {
  const registry = createAiHandlerRegistry({});
  const ids = registry.map(handler => handler.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...new Set(registry.map(handler => handler.phase))],
    ["pre_read_context", "read_context", "fallback"],
  );
  assert.equal(aiHandlersForPhase(registry, "pre_read_context")[0].id, AI_HANDLER_IDS.responseContractV2);
  assert.equal(aiHandlersForPhase(registry, "fallback").at(-1).id, AI_HANDLER_IDS.configuredAi);
  assert.ok(ids.indexOf(AI_HANDLER_IDS.financeFastPath) < ids.indexOf(AI_HANDLER_IDS.procurementFastPath));
  assert.ok(ids.indexOf(AI_HANDLER_IDS.procurementQuery) < ids.indexOf(AI_HANDLER_IDS.financeQuery));
});

test("every advertised AI tool has one registered handler and concrete implementation", () => {
  const advertised = getAiToolRegistry();
  const bindings = getAiToolHandlerRegistry();
  const handlerIds = new Set(Object.values(AI_HANDLER_IDS));
  assert.equal(bindings.length, advertised.length);
  assert.deepEqual(
    new Set(bindings.map(binding => binding.toolName)),
    new Set(advertised.map(tool => tool.name)),
  );
  assert.equal(new Set(bindings.map(binding => binding.toolName)).size, bindings.length);
  for (const binding of bindings) {
    assert.ok(handlerIds.has(binding.handlerId), binding.toolName);
    assert.equal(typeof binding.implementation, "function", binding.toolName);
  }
});

test("AI tool authority metadata is read-only or review-only draft preparation", () => {
  for (const tool of getAiToolRegistry()) {
    assert.equal(tool.writesBusinessData, false, tool.name);
    if (tool.mode === "read") assert.equal(tool.requiresUserReview, false, tool.name);
    if (tool.mode === "draft_preparation") assert.equal(tool.requiresUserReview, true, tool.name);
    assert.ok(["read", "draft_preparation"].includes(tool.mode), tool.name);
  }
});

test("AI dispatch layer does not import business command execution", () => {
  const root = resolve(import.meta.dirname, "..", "..");
  const sources = [
    "server/routes/ai.routes.mjs",
    "server/routes/ai-handler-registry.mjs",
    "server/routes/ai-dispatcher.mjs",
    "server/routes/ai-response-finalizer.mjs",
    "server/domain/ai-tool-handler-registry.mjs",
  ].map(file => readFileSync(resolve(root, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /command-service|businessCommandExecution|executeBusinessCommand|\.create\(|\.update\(|\.delete\(/);
});

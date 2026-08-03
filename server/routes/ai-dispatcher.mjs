import { finalizeAiResponse } from "./ai-response-finalizer.mjs";

export async function dispatchAiHandlers({ handlers, state }) {
  for (const handler of handlers) {
    state.branchStartedAt = Date.now();
    const candidate = await handler.resolve(state);
    if (!candidate) continue;
    if (handler.when && !handler.when(candidate, state)) continue;
    return finalizeAiResponse({ handler, candidate, state });
  }
  return { handled: false, result: null, handlerId: null };
}

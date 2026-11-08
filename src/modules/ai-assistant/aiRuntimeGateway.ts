import { apiJson } from "../../lib/api-client";

// Why the assistant cannot answer in this workspace: AI is off for it, no
// model is set up on this server, or the month's allowance is used.
export type AiRuntimeReadinessNotice = "ai_off" | "no_provider" | "over_cap";

// What /api/ai-runtime/readiness says for the signed-in user.
export type AiRuntimeReadiness = {
  // True when the assistant answers this user's questions.
  assistantV2?: boolean;
  // With the assistant on: the first-day checklist, as Today shows it; null
  // when it could not be read.
  setup?: { open: boolean; firstStepsOpen: boolean } | null;
  // With the assistant off: why, as a notice code the panel words.
  notice?: AiRuntimeReadinessNotice;
};

export function fetchAiRuntimeReadiness() {
  return apiJson<AiRuntimeReadiness>("/api/ai-runtime/readiness");
}

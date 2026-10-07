# AI per workspace: switch and spend cap

Status: built 2026-10-05 for the owner's AI direction of that day: AI is on only
for the trial workspaces the owner opts in. This revises V4 ("the trial assistant
stays model-free"). The deployment settings (Render Blueprint) change in a
separate step, once the owner has provided the key and a budget.

## What it does

- **A switch per workspace, off by default.** Settings › AI › "AI features",
  saved by a workspace administrator (`settings.workspace.manage`) and audited as
  `ai_settings_updated`. It is stored in `Tenant.operationalSettings.ai.modelAssistEnabled`.
- **One decision per assistant request.** Every `/api/ai-runtime/` request
  (answers, knowledge, readiness) runs with the access its workspace has
  (`server/domain/ai-workspace-access.mjs`).
  - A workspace that is not switched on, or is over its monthly cap, gets a
    model-free environment: no provider mode, no knowledge or embedding
    provider, and intent routing, the business query planner and agent
    planning all off.
  - Its answers are the rules' answers, exactly as without a provider.
  - Over the cap, answers carry `aiModelAccess: { status: 'over_cap' }` and the
    panel says so.
- **Usage counted per call.** Every provider call made inside an assistant
  request adds to its workspace's row for the month in `AiUsageMonthly`:
  calls, input and output tokens, and cost in millionths of a dollar. The
  increment is atomic.
  - The cap is checked before each request. One request can go over it by at
    most its own calls.
- **Settings shows the status:** whether a model is configured, and this month's
  spend against the cap (`GET /api/settings-runtime/ai-status`).

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLOWCHAIN_AI_WORKSPACE_OPT_IN` | `required` in production, otherwise not | `required`: only switched-on workspaces under the cap call a model. `not_required`: every workspace may (local development, the eval runner). |
| `FLOWCHAIN_AI_MONTHLY_CAP_USD` | `20` | Spend per workspace per calendar month (UTC). |
| `FLOWCHAIN_AI_PRICE_INPUT_PER_MTOK`, `FLOWCHAIN_AI_PRICE_OUTPUT_PER_MTOK` | `1`, `5` | US dollars per million tokens: claude-haiku-4-5 list prices. |
| `FLOWCHAIN_AI_PROVIDER_KIND` | — | `anthropic_chat` for the Anthropic API. |
| `FLOWCHAIN_AI_PROVIDER_ENDPOINT` | — | `https://api.anthropic.com/v1/chat/completions` (Anthropic's OpenAI-compatible endpoint). |
| `FLOWCHAIN_AI_PROVIDER_MODEL` | — | `claude-haiku-4-5` |
| `FLOWCHAIN_AI_PROVIDER_API_KEY` | — | The owner's Anthropic key. Set it as a secret, never in a file in the repository. |
| `FLOWCHAIN_AI_RUNTIME_MODE` | `local` | `provider_assisted` |

Check a configuration without calling the provider: `npm run check:ai-provider-env`.

## The Anthropic adapter

`anthropic_chat` sends a chat completion with `max_tokens` and a bearer key.
- **`response_format`:** not sent, because that endpoint ignores it. Replies are
  validated as for every provider.
- **Production status:** Anthropic describes the compatible endpoint as not a
  long-term production solution. A native Messages API adapter is a later step.
- **Before first use:** verify one real call with the owner's key, in
  particular `tool_choice: "required"`, which agent planning sends (PR #144).
- **No embeddings:** Anthropic has no embeddings endpoint, so knowledge search
  stays keyword search; the answer is written by the model.

## What leaves the workspace

- **Agent planning and intent routing** send the question and the list of
  skills.
  - When the workspace has documents the user may read, agent planning also
    sends their languages (for example "English"), so the model can write search
    words in that language.
  - Those words only search the workspace's own documents. The passages found
    are shown with their sources and are not sent to a model.
- **Knowledge answers** (a question about the documents alone) also send the
  matching passages of the workspace's own documents.
- **Business records** (orders, amounts, suppliers) are not sent. Sending them
  is P3, which is not approved (agent mode decision 4).
- The switch covers every one of these paths.

## Turning it on for a trial workspace

1. Set the provider variables and `FLOWCHAIN_AI_WORKSPACE_OPT_IN=required` on the
   server. The Blueprint change also updates `render-blueprint.test.mjs` (PR #143)
   to allow exactly these keys.
2. Sign in as the workspace's administrator, open Settings › AI and switch
   on "AI features".
3. Ask the assistant a question no rule matches. With agent planning on, the
   answer carries `skillRouting.source: 'model'`.

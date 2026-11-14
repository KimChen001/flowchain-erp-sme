# AI per workspace: switch and spend cap

Status: built 2026-10-05 for the owner's AI direction of that day: AI is on only
for the trial workspaces the owner opts in. This revises V4 ("the trial assistant
stays model-free"). On 2026-11-04 the owner chose MIT Parley with Claude Sonnet
5.5 for the trial servers; the Render Blueprint declares those settings (see
"On the trial servers" below).

## What it does

- **A switch per workspace, off by default.** System administration › AI governance › "AI features",
  saved by a workspace administrator (`settings.workspace.manage`) and audited as
  `ai_settings_updated`. It is stored in `Tenant.operationalSettings.ai.modelAssistEnabled`.
- **One decision per assistant request.** Every `/api/ai-runtime/` request
  (answers, knowledge, readiness) runs with the access its workspace has
  (`server/domain/ai-workspace-access.mjs`).
  - A workspace that is not switched on, or is over its monthly cap, calls no
    model.
  - Since 2026-11-06 assistant v2 answers every question; the rules engine was
    removed at the owner's direction. When v2 cannot answer, the answer is a
    notice that says why, in the question's language: `ai_off` (the workspace
    has not switched AI on), `no_provider` (no model set up on this server or
    the mode is not `assistant_v2`), `over_cap` (the month's cap is used) or
    `unavailable` (the provider failed before anything was shown). Readiness
    returns the same code as `notice`.
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
| `FLOWCHAIN_AI_PRICE_INPUT_PER_MTOK`, `FLOWCHAIN_AI_PRICE_OUTPUT_PER_MTOK` | the configured model's list prices | US dollars per million tokens. Listed: claude-haiku-5-5 (`0.1`, `0.5`), claude-haiku-4-5 (`1`, `5`), claude-sonnet-5-5 (`2`, `10`); another model is priced as claude-haiku-4-5. A cache read costs a tenth of an input token, a cache write 1.25 times one. |
| `FLOWCHAIN_AI_PROVIDER_KIND` | — | `parley_chat` on the trial servers (MIT Parley's chat completions). Also `anthropic_messages` for Anthropic's native Messages API, or `anthropic_chat` for its OpenAI-compatible endpoint. |
| `FLOWCHAIN_AI_PROVIDER_ENDPOINT` | — | `https://parley.api.mit.edu/v1/chat/completions` on the trial servers. |
| `FLOWCHAIN_AI_PROVIDER_MODEL` | — | `claude-sonnet-5-5` on the trial servers. |
| `FLOWCHAIN_AI_PROVIDER_API_KEY` | — | The provider key (the Parley key on the trial servers). Set it as a secret, never in a file in the repository. While it is empty the server calls no model. |
| `FLOWCHAIN_AI_ALLOW_PARLEY_IN_PRODUCTION` | off | `true` lets assistant v2 use Parley when `NODE_ENV=production`. Without it production refuses Parley, and it always refuses OpenCode. |
| `FLOWCHAIN_AI_RUNTIME_MODE` | `local` | `provider_assisted` |
| `FLOWCHAIN_AI_ASSISTANT_MODE` | off | `assistant_v2` (the trial servers): the assistant v2 agent loop answers, and needs `FLOWCHAIN_AI_WORKSPACE_OPT_IN=required` outside local development. Any other value: the assistant answers with the `no_provider` notice (`model_first` and the rules were removed on 2026-11-06). `npm run dev:local` defaults it to `assistant_v2`, and `npm run walkthrough:local -- --ai-env=<file>` sets it. |
| `FLOWCHAIN_AI_ASSISTANT_REASONING_EFFORT` | `low` (native), `none` (chat completions) | How much the loop's model reasons: `none`, `low`, `medium` or `high`. |
| `FLOWCHAIN_AI_ASSISTANT_CHAT_CACHE` | on for a Claude model on Parley, otherwise off | Assistant v2 on chat completions: `on` marks the system prompt for the provider's prompt cache (Anthropic's `cache_control`), `off` never does. Verified on Parley only. |
| `FLOWCHAIN_AI_ASSISTANT_TIMEOUT_MS`, `FLOWCHAIN_AI_ASSISTANT_TOKEN_BUDGET` | `20000`, `80000` | One answer's time (at most 30 s) and tokens read and written. |

Check a configuration without calling the provider: `npm run check:ai-provider-env`.

## The Anthropic adapter

`anthropic_chat` sends a chat completion with `max_tokens` and a bearer key.
- **`response_format`:** not sent, because that endpoint ignores it. Replies are
  validated as for every provider.
- **Production status:** Anthropic describes the compatible endpoint as not a
  long-term production solution. A native Messages API adapter is a later step.
- **Agent planning:** on for this kind too. Anthropic documents `tools` and
  `tool_calls` as supported on that endpoint, but does not list
  `tool_choice: "required"`. So agent planning asks with `"auto"` and without
  the `no_matching_skill` tool. A model that declines may then write text, which
  is ignored and takes longer.
- **Before first use:** verify one real call with the owner's key. If it
  confirms `"required"`, add the kind to `REQUIRED_TOOL_CHOICE_KINDS` in
  `server/domain/ai-agent-planning.mjs`.
- **No embeddings:** Anthropic has no embeddings endpoint, so knowledge search
  stays keyword search; the answer is written by the model.

## Earlier assistants (removed)

The rules engine (workspace skills, the intent router, the business query
planner, agent planning, answer wording) and the model-first loop were
removed on 2026-11-06 and 2026-11-07 at the owner's direction. Assistant v2
answers every question; `docs/ai-model-first-design.md` and the git history
keep the record of what the earlier paths did.

## What leaves the workspace

Only assistant v2 calls a model, and only for a workspace that is switched on
and under its cap. Each model call sends:

- the system prompt and the tool definitions (fixed text, the same for every
  workspace);
- the conversation on the user's thread: their questions, the assistant's
  earlier answers, its tool calls and the tool results;
- one context line per question: the answer language, the workspace day,
  currency and time zone, the page's record (module, type and id) when the
  question is asked on a record's page, and what the user's role cannot see
  (source names only, never the hidden data);
- the tool results: the asking user's own records, read with their own
  permissions and warehouse scope, with the fields each tool lists. Amounts the
  role cannot see are left out. The data tools return no contact emails or
  phone numbers; a user who pastes suppliers with their contact details into
  the chat sends those with the message;
- for a question about the workspace's documents, the passages the search
  found in documents the user may read;
- a note when the user created or moved on a record with a card in the chat
  (its number and status), after the server has checked the click in the
  audit log.

The audit row of each answer keeps codes and counts only: the tools called,
the model, the tokens and the cost, never the question or the answer's words.

## On the trial servers (MIT Parley)

The owner's decision of 2026-11-04: production uses the school's MIT Parley,
with Claude Sonnet 5.5. In a side-by-side run of the same 16 questions, Sonnet
cost about $0.04 an answer and made up no record numbers; Haiku 5.5 cost about
$0.002 but made up record numbers in 2 of 12 showcase answers, and the
check withheld those answers.

- **Settings.** `render.yaml` (staging and production) and
  `deploy/env.production.example` declare `FLOWCHAIN_AI_ASSISTANT_MODE=assistant_v2`,
  `FLOWCHAIN_AI_WORKSPACE_OPT_IN=required`, `FLOWCHAIN_AI_RUNTIME_MODE=provider_assisted`,
  `FLOWCHAIN_AI_PROVIDER_KIND=parley_chat`, the Parley endpoint,
  `FLOWCHAIN_AI_PROVIDER_MODEL=claude-sonnet-5-5`,
  `FLOWCHAIN_AI_ALLOW_PARLEY_IN_PRODUCTION=true`, `FLOWCHAIN_AI_MONTHLY_CAP_USD=25`
  and the key as a secret (`sync: false`). `render-blueprint.test.mjs` fails if
  any other AI setting is added: no knowledge or embedding provider, answer
  wording (P3), model-first mode or the legacy `/api/ai` path.
- **Only assistant v2 calls the model.** A workspace that is not switched on
  or is over its cap gets a notice that says so, and no model is called.
- **The key.** The Parley key is the owner's own, tied to an MIT account. Enter
  it on each service's **Environment** page in Render. Before using it with a
  trial company's records, confirm with MIT that Parley may be used for this.
  Rotate it there if it has been shared or pasted anywhere, and after a
  rotation update both services.
- **When Parley fails.** An expired key or a used-up Parley budget makes the
  call fail. If nothing has been shown yet, the answer is the notice that the
  assistant is not available right now. If the answer was already streaming,
  the panel says the assistant could not answer just now and that nothing was
  changed.
- **The cap.** `FLOWCHAIN_AI_MONTHLY_CAP_USD` is per workspace and counted at the
  model's list prices, not by Parley. Keep the total over all switched-on
  workspaces below the Parley budget, and watch the Parley usage page as well
  as System administration › AI governance.

## Turning it on for a trial workspace

1. Set the provider variables and `FLOWCHAIN_AI_WORKSPACE_OPT_IN=required` on the
   server. On Render they are in the Blueprint; enter the Parley key on each
   service's **Environment** page.
2. Sign in as the workspace's administrator, open System administration ›
   AI governance and switch on "Use an AI model in this workspace".
3. Ask the assistant "What should I reorder this week?". The answer is
   streamed, with its records as chips. AI governance then shows this
   month's spend.

# AI per workspace: switch and spend cap

Status: built 2026-10-05 for the owner's AI direction of that day: AI is on only
for the trial workspaces the owner opts in. This revises V4 ("the trial assistant
stays model-free"). On 2026-11-04 the owner chose MIT Parley with Claude Sonnet
5.5 for the trial servers; the Render Blueprint declares those settings (see
"On the trial servers" below).

## What it does

- **A switch per workspace, off by default.** Settings › AI › "AI features",
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
| `FLOWCHAIN_AI_ASSISTANT_MODE` | off | `assistant_v2` (the trial servers): the assistant v2 agent loop answers, and needs `FLOWCHAIN_AI_WORKSPACE_OPT_IN=required` outside local development. Any other value: the assistant answers with the `no_provider` notice (`model_first` and the rules were removed on 2026-11-06). |
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

## The model-first assistant (removed)

**Removed 2026-11-06:** the gateway no longer routes questions to this loop;
assistant v2 replaced it. The section stays as the record of what it did, and
its remaining code is removed in a later step.

Step S2 of `docs/ai-model-first-design.md` (decisions M1–M7, 2026-10-28), off
unless `FLOWCHAIN_AI_ASSISTANT_MODE=model_first`, and only where the switch above
lets the workspace call a model.
- **Entry.** A free-text question goes to a tool loop. The deterministic guards
  answer first and keep their answers: an instruction to act, a question about
  the outside world, injection phrasing (overriding the rules, other tenants or
  workspaces, SQL) and a greeting. Prompt chips keep their skills. An order
  request ("帮我起草一份PO") goes to the loop, which reads it with the
  conversation so far. Document and mixed questions go to the loop too, which searches the
  documents with `search_documents`; where that tool is not offered (no database
  storage) the knowledge path answers them as before, and it is also the
  fallback, without a model, when the loop gives no checked answer. A contract
  question goes to the loop when `list_contracts` is offered (the contracts
  module is on and the user may read contracts); otherwise the rules answer it
  as before.
- **The loop.** The model reads through the read tools
  (`server/domain/ai-read-tools.mjs`), which hold only what the asking user may
  read. At most 4 rounds, 8 tool calls and 20 s per answer, plus the token
  budget; the calls of one round run together, and a tool error goes back to the
  model as the tool's result.
- **Proposals.** For a user who may draft, `propose_purchase_request`
  (`server/domain/ai-model-first-proposals.mjs`) opens a filled-in purchase
  request form in the panel for the user to review and submit. It saves
  nothing; the request becomes a purchase order after approval. It names only an
  item the user named, in the question or an earlier one, or chose from the
  previous answer's choices; a quantity or supplier the user did not give is
  left for them to fill in. Without a named item the model asks.
- **The check.** Every number with its currency, percent sign or days, every
  date, record number and known supplier, customer or item name in the answer
  must be in this answer's tool results (or the question, or `calculate`), and
  every cited record one a tool returned. On a failure the model gets one retry
  with the list; after a second, the rules answer, with no model call, and say
  so. The audit row keeps the kinds and counts, never the text.
- **Providers.** `anthropic_messages` (the trial): tools with `tool_choice:
  auto`, low effort, the answer as structured output, the system prompt, tools
  and conversation cached; no sampling settings, which current Claude models
  reject. The chat kinds (`deepseek_chat` on OpenCode Go locally): native tool
  calls with `reasoning_effort`.

## What leaves the workspace

- **The model-first assistant** sends the question, up to 3 earlier questions
  and answers of the user's panel as text, the open record's type and name, the
  tool definitions, and the tool results: the asking user's own records, with
  the fields the tools list. Contact emails and phone numbers are never in them.

- **Agent planning and intent routing** send the question and the list of
  skills.
  - When the workspace has documents the user may read, agent planning also
    sends their languages (for example "English"), so the model can write search
    words in that language.
  - Those words only search the workspace's own documents. The passages found
    are shown with their sources and are not sent to a model.
  - **Conversation memory** (owner decision 2 of 2026-10-07): for a question
    that refers to the previous answer ("compare the first two", 这家供应商,
    "it"), agent planning also sends the previous question and up to 8 records
    that answer showed, as type, name and supplier name. Each record is looked
    up again in the asking user's own data first, so a record they cannot read
    is never sent. No ids, amounts or other figures are sent.
  - A question that points at one of those records ("draft a follow-up email
    for it") is usually narrowed to it by the rules, and then no model is asked.
- **Knowledge answers** (a question about the documents alone) also send the
  matching passages of the workspace's own documents.
- **The business query planner** (supplier and payment questions) sends:
  - the question, the workspace time zone and the current time;
  - the page's record, as type, id and name, when the question is asked on a
    record's page;
  - up to 10 records the previous answer cited, as id and name, so "these
    suppliers" can be planned.

  No amounts, counts or other figures are sent.
- **Answer wording (P3)** was approved by the owner on 2026-10-07 (agent mode
  decisions 4 and 7) and built in PR #168. It is off unless
  `FLOWCHAIN_AI_AGENT_MODE=compose`.
  - With it, the model gets the facts a skill returned for the question,
    masked to what the asking user may see, and writes the answer from them.
  - For a follow-up, or a question about the previous answer, it also gets the
    previous question.
  - With it off, skill answers send no business figures to any model.
- The switch covers every one of these paths.

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
- **Only assistant v2 calls the model.** A question v2 hands back, and every
  workspace that is not switched on or is over its cap, runs on the
  model-free environment.
- **The key.** The Parley key is the owner's own, tied to an MIT account. Enter
  it on each service's **Environment** page in Render. Before using it with a
  trial company's records, confirm with MIT that Parley may be used for this.
  Rotate it there if it has been shared or pasted anywhere, and after a
  rotation update both services.
- **When Parley fails.** An expired key or a used-up Parley budget makes the
  call fail. If nothing has been shown yet, the rules answer, with the notice
  that the model is not available. If the answer was already streaming, the
  panel says the assistant could not answer just now and that nothing was
  changed.
- **The cap.** `FLOWCHAIN_AI_MONTHLY_CAP_USD` is per workspace and counted at the
  model's list prices, not by Parley. Keep the total over all switched-on
  workspaces below the Parley budget, and watch the Parley usage page as well
  as Settings > AI.

## Turning it on for a trial workspace

1. Set the provider variables and `FLOWCHAIN_AI_WORKSPACE_OPT_IN=required` on the
   server. On Render they are in the Blueprint; enter the Parley key on each
   service's **Environment** page.
2. Sign in as the workspace's administrator, open Settings › AI and switch
   on "AI features".
3. Ask the assistant "What should I reorder this week?". The answer is
   streamed and labelled "Written by AI from your records". Settings › AI then
   shows this month's spend.

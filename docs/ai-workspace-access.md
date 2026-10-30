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
| `FLOWCHAIN_AI_PRICE_INPUT_PER_MTOK`, `FLOWCHAIN_AI_PRICE_OUTPUT_PER_MTOK` | the configured model's list prices | US dollars per million tokens. Listed: claude-haiku-5-5 (`0.1`, `0.5`), claude-haiku-4-5 (`1`, `5`), claude-sonnet-5-5 (`2`, `10`); another model is priced as claude-haiku-4-5. A cache read costs a tenth of an input token, a cache write 1.25 times one. |
| `FLOWCHAIN_AI_PROVIDER_KIND` | — | `anthropic_messages` for Anthropic's native Messages API (the model-first assistant), or `anthropic_chat` for its OpenAI-compatible endpoint. |
| `FLOWCHAIN_AI_PROVIDER_ENDPOINT` | — | `https://api.anthropic.com/v1/chat/completions` (Anthropic's OpenAI-compatible endpoint). |
| `FLOWCHAIN_AI_PROVIDER_MODEL` | — | `claude-haiku-4-5` |
| `FLOWCHAIN_AI_PROVIDER_API_KEY` | — | The owner's Anthropic key. Set it as a secret, never in a file in the repository. |
| `FLOWCHAIN_AI_RUNTIME_MODE` | `local` | `provider_assisted` |
| `FLOWCHAIN_AI_ASSISTANT_MODE` | off | `model_first`: free-text questions go to the model-first tool loop (below). |
| `FLOWCHAIN_AI_ASSISTANT_REASONING_EFFORT` | `low` (native), `none` (chat completions) | How much the loop's model reasons: `none`, `low`, `medium` or `high`. |
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

## The model-first assistant

Step S2 of `docs/ai-model-first-design.md` (decisions M1–M7, 2026-10-28), off
unless `FLOWCHAIN_AI_ASSISTANT_MODE=model_first`, and only where the switch above
lets the workspace call a model.
- **Entry.** A free-text question goes to a tool loop. The deterministic guards
  answer first and keep their answers: an instruction to act, a question about
  the outside world, injection phrasing (overriding the rules, other tenants or
  workspaces, SQL), a greeting and an order request. Prompt chips keep their
  skills. Document and mixed questions go to the loop too, which searches the
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

## Turning it on for a trial workspace

1. Set the provider variables and `FLOWCHAIN_AI_WORKSPACE_OPT_IN=required` on the
   server. The Blueprint change also updates `render-blueprint.test.mjs` (PR #143)
   to allow exactly these keys.
2. Sign in as the workspace's administrator, open Settings › AI and switch
   on "AI features".
3. Ask the assistant a question no rule matches. With agent planning on, the
   answer carries `skillRouting.source: 'model'`.

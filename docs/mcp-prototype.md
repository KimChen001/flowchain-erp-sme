# FlowChain over MCP: local prototype

**Status: prototype for the owner's decision (draft PR, not for merging as is).** It follows Option A of the 2026-11-18 study of how Pallet builds its agent platform. Pallet does not build its own systems of record. It wraps the customer's existing systems as tools over the Model Context Protocol, and task agents run on top. Option A is the same move for FlowChain: offer FlowChain's existing read and analysis tools to any MCP client, starting with Claude Desktop on this machine.

## What it is

- `server/mcp/flowchain-mcp-server.mjs` maps one MCP JSON-RPC message to its reply. It handles `initialize`, `ping`, `tools/list` and `tools/call`. A message without an `id` is a notification and gets no reply.
- `server/mcp/flowchain-mcp-session.mjs` holds the local identity (the user and their token) and the read-only context the tools read with.
- `scripts/flowchain-mcp.mjs` is the stdio transport: newline-delimited JSON on stdin and stdout, with logs on stderr. It also creates and revokes tokens.

The tools are the assistant's own, through the assistant's own door:

| MCP | FlowChain |
|---|---|
| `tools/list` | `aiReadToolsFor(facts, context)`, kept to the MCP allowlist: the read and analysis tools this user's role and data can serve |
| `tools/call` | `runAiReadTool(name, args, { facts, context })` for a name on the allowlist: checks the arguments against the tool's schema and the user's access again |
| context | `loadAiSkillContext` + `readAiSkillFacts(context, { openPurchaseRequests: true })`, read afresh for every list and call, so permissions match the web app's for the same role |

A call's result is the tool's JSON, once, as a text block. It comes with the record refs, a link that opens each record in FlowChain (orders, requests, RFQs, receipts, supplier invoices, suppliers and items), and, where the role cannot read some kinds of record (a finance specialist: purchase orders, requests, RFQs, inventory and receipts), `hiddenForRole`, so the client's model does not take a missing record for a missing fact.

**Hand-written protocol, no SDK.** The prototype needs four methods over stdio. Writing them by hand (about 220 lines for the message handler) adds no dependency and leaves `package-lock.json` untouched, and the tests can drive the message handler directly. It speaks MCP revisions 2025-06-18 and 2024-11-05; a client asking for another gets 2025-06-18. JSON-RPC batches are refused (neither revision has them). If the owner goes ahead, the transport can move to `@modelcontextprotocol/sdk`, pinned to an exact version at least two weeks old, without changing the tools.

## Connecting Claude Desktop (local)

1. Use a **local database you can write audit rows to**, not the shared walkthrough workspaces on ports 15231/15232: every list and call writes an audit row. A walkthrough started with its own `FLOWCHAIN_WALKTHROUGH_DIR` works. The workspace must have its AI features switched on (Settings → AI): an MCP client is an outside model reading the workspace's data, so a workspace with AI off is not served.
2. Create the token for one provisioned, active user. Its hash is kept in that workspace's database (`RuntimeRecord`, namespace `mcp_access_token`), not in a file:
   ```bash
   NODE_ENV=development FLOWCHAIN_DEV_LOCAL=true DATABASE_URL=postgresql://<local user>:<local password>@127.0.0.1:<port>/<database> node scripts/flowchain-mcp.mjs --create-token --actor=kim@example.com
   ```
   It prints the token once. A new token replaces the user's earlier one. `--revoke-token --actor=…` revokes it.
3. Add the server to Claude Desktop's `claude_desktop_config.json` (on Windows `%APPDATA%\Claude\`, on macOS `~/Library/Application Support/Claude/`). The values below are placeholders, not real keys:
   ```json
   {
     "mcpServers": {
       "flowchain-local": {
         "command": "node",
         "args": ["C:/path/to/flowchain/scripts/flowchain-mcp.mjs"],
         "env": {
           "NODE_ENV": "development",
           "FLOWCHAIN_DEV_LOCAL": "true",
           "DATABASE_URL": "postgresql://<local user>:<local password>@127.0.0.1:<port>/<database>",
           "FLOWCHAIN_DEFAULT_TENANT_ID": "<workspace id>",
           "FLOWCHAIN_MCP_ACTOR": "kim@example.com",
           "FLOWCHAIN_MCP_TOKEN": "<the token printed in step 2>",
           "FLOWCHAIN_PUBLIC_BASE_URL": "http://127.0.0.1:<app port>"
         }
       }
     }
   }
   ```
4. Restart Claude Desktop. "flowchain-local" lists the user's tools, and Claude calls them as that user.

The server refuses to start under `NODE_ENV=production` (or `FLOWCHAIN_DEPLOYMENT_PROFILE=production`), outside local development (`NODE_ENV=development`, `FLOWCHAIN_DEV_LOCAL=true` and a `DATABASE_URL` on this machine), without `FLOWCHAIN_MCP_ACTOR`, for a disabled user, for a workspace with AI off, and with a token that does not stand for the user. The same token and AI checks run again before every list and call.

## The token

- **Kept as a hash, in the database.** `--create-token` makes a random token, keeps its SHA-256 hash with the user's id and role in the workspace's database, and prints the token once. It is valid for 30 days. Only an active, provisioned user whose roles are set gets one. FlowChain sets a user's roles on their first sign-in when nobody has; that is a write this server does not make, so such a user signs in to FlowChain once first (or an administrator sets their roles).
- **Revocable.** `--revoke-token` ends it.
- **Ended by what ends the user's access.** Before every list and call the server checks that the token is the user's current one, not revoked and not expired; that the user is still active; that their role is the one the token was made for (a role change needs a new token) and their roles are set; and that none of their FlowChain sessions was ended after the token was made (signing out, or an administrator ending their sessions). The error code says which, for example `MCP_SIGNED_OUT` or `MCP_ROLE_CHANGED`.
- **Not passed on.** The script reads `FLOWCHAIN_MCP_TOKEN` and deletes it from its environment, and the tools' context is built without it. The token is never sent anywhere.

## Tools exposed

An explicit allowlist in `flowchain-mcp-server.mjs` names the 39 tools the MCP server may offer; the unit test pins it. A tool the assistant gains later is not offered until it is added there. Within the allowlist, the user's role and data decide, as in the web assistant. An administrator on the test workspace gets all 39:

- **Records:** `workspace_summary`, `list_purchase_orders`, `get_purchase_order`, `list_purchase_requests`, `list_receipts`, `list_supplier_invoices`, `list_rfqs`, `rfq_quotes`, `list_sales_orders`, `list_shipments`, `list_receivables`, `list_suppliers`, `item_suppliers`, `search_records`, `record_history`, `records_missing_data`, `setup_status`.
- **Stock and replenishment:** `stock_position`, `stock_projection`, `stock_movements`, `reorder_list`, `suggest_purchase_lines`, `optimize_order_plan`, `order_quantity_costs`, `inventory_value`.
- **Suppliers and money:** `spend_analysis`, `supplier_performance`, `supplier_risks`, `late_order_impact`, `price_history`, `supplier_payables`, `cash_movements`, `gross_profit`, `sales_summary`.
- **Today:** `attention_list`, `decision_items`, `decision_history`.
- **Other:** `calculate`, `search_documents`.

A finance specialist on the test workspace gets 17 and no purchase orders: the tool is not listed, and calling it gets `not_allowed`, as does any name off the allowlist. The web chat's UI tools (cards, forms, buttons) are not on the allowlist, and tool descriptions are offered without the sentences that point to them.

Proposals such as `suggest_purchase_lines` and `optimize_order_plan` come back as data with links. **Nothing changes a record**: a person opens FlowChain and confirms (owner, 2026-11-04).

## Controls

- **Read-only.** Only allowlisted read tools run. They are handed only the repositories the read tools read from (not the purchase order commands, purchase requests, imports or chat history), and a repository method named for a write (create, update, set, approve and so on) throws `MCP_READ_ONLY`, the audit insert aside. Underneath, the Prisma client they are handed keeps only its reads and the audit log's create, inside a transaction too, so a write by any other name fails there. These wrappers are a second line, not the guarantee. For anything beyond a local research database, run the server as a **PostgreSQL role with read access and `INSERT` on `AuditLog` only** (the token commands need write access to `RuntimeRecord`, so run them as another role).
- **No model calls.** The tools run with every model path off (`modelFreeEnv`: no provider, no knowledge or embedding provider, no planner), whatever the environment configures. `search_documents` is then a keyword search. The model is the MCP client's.
- **Arguments:** each tool's JSON schema (`validateAiToolArgs`), as in the web assistant. Every string argument also passes the assistant's prompt-injection pre-check (`aiInjectionDetected`). That check is a heuristic: it catches common phrasings, not every one.
- **Rate limit:** the assistant's per-user limit, 30 lists and calls in 10 minutes per workspace user, checked before anything is read.
- **Size and time:** a result over 24,000 characters (the web assistant's cap) is not sent (`result_too_large`). A call that takes over 20 seconds returns `timeout`; the query it started is not cancelled and finishes on its own.
- **Audit, fail-closed:** one row per list and per call, refusals and errors included, codes only. The fields are action `ai_mcp_tools_listed` or `ai_mcp_tool_called`, the tool, the outcome, the argument names, the number of refs and the record ids returned, and the latency, plus `metadata.channel = 'mcp'`. Argument values and results are never stored, nor a hash of them. The audit log's `source` column holds only `manual`, `ai_assisted` or `system`, so the row is `ai_assisted` and the channel says MCP. It is attributed to the user. If the row cannot be written, no data is returned (`audit_unavailable`).

## Deliberately not done

- **Writes:** no tool creates, submits, approves, sends or changes anything.
- **Remote access:** stdio only, so the server is a child process of the client on the same machine. There is no HTTP or SSE transport and no listening port.
- **OAuth and an API-token system:** one local token proves one provisioned user. A real deployment would need the MCP authorization flow (OAuth 2.1 with resource indicators), tokens issued to the MCP server itself, per-client consent, and a token screen in Settings.
- **Other MCP features:** no resources, prompts, sampling, `listChanged` notifications, cancellation or progress.
- **Real customer data:** none. This is for the public-data research workspaces only.

## Risks and the MCP security practices

- **No token passthrough.** The token only proves the user to this server, on every list and call. It is never sent anywhere, and FlowChain acts with its own server-side permissions for that user. A future remote version must not accept tokens issued for other services.
- **Least privilege.** One user, their role, allowlisted read-only tools, and ideally a read-only database role (above). A dedicated user with a read-only FlowChain role is the safer choice for an MCP client.
- **Prompt injection through results.** Records hold text written by suppliers and customers (names, notes, references). The client's model reads it. The results are data, there is no write tool for injected text to reach, and the server tells the client that results are data. An injected instruction can still bias the answer the client's model writes. That risk is the client's, and the reason writes stay out.
- **Where the data goes.** Results go to the MCP client and, through it, to its model provider. With Claude Desktop that means Anthropic. That is why the workspace's AI switch must be on. It is fine for public data, but for real business data it is a data-sharing decision for the owner.
- **Secrets at rest.** The database keeps only the token's hash. The raw token and the local database URL sit in the client's config file in plain text, as with any local MCP server: keep that file private, and revoke the token if it leaks.
- **Staleness.** The context, the token's standing and the AI switch are read afresh for every list and call: a disabled user, a role change, signing out, a revoked token or AI switched off take effect on the next one.

## Tests

The two database suites run with `npm run test:db:flowchain-mcp`, in CI.

- `server/domain/flowchain-mcp-server.test.mjs`: a scripted MCP client over in-memory facts. It covers the handshake, notifications and JSON-RPC errors; the allowlist (pinned) and the tool list by role, audited; a call with refs, links, `hiddenForRole` and its codes-only audit row; `not_allowed`, schema errors and the injection refusal; the rate limit before any read; the audit failing closed and a failed load audited; the size cap and the timeout; the read-only wrappers; the token rules (hash only, mismatch, expiry, sign-out, role change, disabled, roles never set, revoked); and the local-only guard.
- `tests/postgres/flowchain-mcp-tools.test.mjs`: every allowlisted tool, run through the MCP session (read-only views, token check, AI switch, model paths off) on the seeded walkthrough in a database. Each answers, and only the audit rows are written.
- `tests/postgres/flowchain-mcp.test.mjs`: the real script over stdio against a database. It creates a token with the script, lists the user's tools and returns only their workspace's order with its link. It checks the parse and batch errors, the audit rows in the user's workspace, that signing out ends access at the next call, and that a wrong or revoked token, a workspace with AI off, and production are refused.

No model is called by the server or the tests.

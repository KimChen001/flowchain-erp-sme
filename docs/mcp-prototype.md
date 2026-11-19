# FlowChain over MCP: local prototype

**Status: prototype for the owner's decision (draft PR, not for merging as is).** It follows Option A of the 2026-11-18 study of how Pallet builds its agent platform. Pallet does not build its own systems of record. It wraps the customer's existing systems as tools over the Model Context Protocol, and task agents run on top. Option A is the same move for FlowChain: offer FlowChain's existing read and analysis tools to any MCP client, starting with Claude Desktop on this machine.

## What it is

- `server/mcp/flowchain-mcp-server.mjs` maps one MCP JSON-RPC message to its reply. It handles `initialize`, `ping`, `tools/list` and `tools/call`; notifications are accepted and ignored.
- `server/mcp/flowchain-mcp-session.mjs` holds the local identity: the token, the user, and the context the tools read with.
- `scripts/flowchain-mcp.mjs` is the stdio transport: newline-delimited JSON on stdin and stdout, with logs on stderr.

The tools are the assistant's own, through the assistant's own door, unchanged:

| MCP | FlowChain |
|---|---|
| `tools/list` | `aiReadToolsFor(facts, context)`: the read and analysis tools this user's role and data can serve |
| `tools/call` | `runAiReadTool(name, args, { facts, context })`: checks the arguments against the tool's schema and the user's access again |
| context | `loadAiSkillContext` + `readAiSkillFacts(context, { openPurchaseRequests: true })`, read afresh for every call, so permissions match the web app exactly and a role change takes effect at once |

A call's result is the tool's JSON, given both as text and as `structuredContent`. It comes with the record refs and a link that opens each record in FlowChain: orders, requests, RFQs, receipts, supplier invoices, suppliers and items.

**Hand-written protocol, no SDK.** The prototype needs four methods over stdio. Writing them by hand (about 150 lines) adds no dependency and leaves `package-lock.json` untouched, and the tests can drive the message handler directly. If the owner goes ahead, the transport can move to `@modelcontextprotocol/sdk`, pinned to an exact version at least two weeks old, without changing the tools.

## Connecting Claude Desktop (local)

1. Use a **local database you can write audit rows to**, not the shared walkthrough workspaces on ports 15231/15232: every call writes an audit row. A walkthrough started with its own `FLOWCHAIN_WALKTHROUGH_DIR` works.
2. Create the token for one provisioned user. Only its hash is kept, in `~/.flowchain/mcp-token.json` (or `FLOWCHAIN_MCP_TOKEN_FILE`), outside the repository:
   ```bash
   DATABASE_URL=postgresql://<local user>:<local password>@127.0.0.1:<port>/<database> FLOWCHAIN_DEV_LOCAL=true node scripts/flowchain-mcp.mjs --create-token --actor=kim@example.com
   ```
   It prints the token once.
3. Add the server to Claude Desktop's `claude_desktop_config.json` (on Windows `%APPDATA%\Claude\`, on macOS `~/Library/Application Support/Claude/`). The values below are placeholders, not real keys:
   ```json
   {
     "mcpServers": {
       "flowchain-local": {
         "command": "node",
         "args": ["C:/path/to/flowchain/scripts/flowchain-mcp.mjs"],
         "env": {
           "DATABASE_URL": "postgresql://<local user>:<local password>@127.0.0.1:<port>/<database>",
           "FLOWCHAIN_DEV_LOCAL": "true",
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

The server refuses to start under `NODE_ENV=production` (or `FLOWCHAIN_DEPLOYMENT_PROFILE=production`), outside local development, without `FLOWCHAIN_MCP_ACTOR`, or with a token that does not match.

## Tools exposed

These are the assistant's read and analysis tools, filtered by the user's role, exactly as the web assistant offers them. An administrator on the test workspace gets 39:

- **Records:** `workspace_summary`, `list_purchase_orders`, `get_purchase_order`, `list_purchase_requests`, `list_receipts`, `list_supplier_invoices`, `list_rfqs`, `rfq_quotes`, `list_sales_orders`, `list_shipments`, `list_receivables`, `list_suppliers`, `item_suppliers`, `search_records`, `record_history`, `records_missing_data`, `setup_status`.
- **Stock and replenishment:** `stock_position`, `stock_projection`, `stock_movements`, `reorder_list`, `suggest_purchase_lines`, `optimize_order_plan`, `order_quantity_costs`, `inventory_value`.
- **Suppliers and money:** `spend_analysis`, `supplier_performance`, `supplier_risks`, `late_order_impact`, `price_history`, `supplier_payables`, `cash_movements`, `gross_profit`, `sales_summary`.
- **Today:** `attention_list`, `decision_items`, `decision_history`.
- **Other:** `calculate`, `search_documents`.

A finance specialist gets 17 and no purchase orders: the tool is not listed, and calling it gets `not_allowed`. The assistant's UI tools (cards, forms, buttons in the web chat) are not offered. A tool flagged `build` or `writes` would be left out all the same.

Proposals such as `suggest_purchase_lines` and `optimize_order_plan` come back as data with links. **Nothing changes a record**: a person opens FlowChain and confirms (owner, 2026-11-04).

## Controls reused from the assistant

- **Arguments:** each tool's JSON schema (`validateAiToolArgs`), as in the web assistant. Every string argument also passes the assistant's prompt-injection pre-check (`aiInjectionDetected`).
- **Rate limit:** the assistant's per-user limit, 30 calls in 10 minutes.
- **Audit:** one row per call, codes only. The fields are action `ai_mcp_tool_called`, the tool, the outcome, the argument names, a hash of the values, the record ids returned and the latency, plus `metadata.channel = 'mcp'`. Argument values and results are never stored. The audit log's `source` column holds only `manual`, `ai_assisted` or `system`, so the row is `ai_assisted` and the channel says MCP. It is attributed to the local user's session.

## Deliberately not done

- **Writes:** no tool creates, submits, approves, sends or changes anything.
- **Remote access:** stdio only, so the server is a child process of the client on the same machine. There is no HTTP or SSE transport and no listening port.
- **OAuth and an API-token system:** one local token proves one provisioned user. A real deployment would need the MCP authorization flow (OAuth 2.1 with resource indicators), tokens issued to the MCP server itself, and per-client consent.
- **Other MCP features:** no resources, prompts, sampling, `listChanged` notifications, cancellation or progress.
- **Real customer data:** none. This is for the public-data research workspaces only.

## Risks and the MCP security practices

- **No token passthrough.** The MCP token only lets the server start as its user. It is never sent anywhere, and FlowChain acts with its own server-side permissions for that user. A future remote version must not accept tokens issued for other services.
- **Least privilege.** One user, their role, read-only tools. A dedicated user with a read-only role is the safer choice for an MCP client.
- **Prompt injection through results.** Records hold text written by suppliers and customers (names, notes, references). The client's model reads it. The results are data, there is no write tool for injected text to reach, and the server tells the client that results are data. An injected instruction can still bias the answer the client's model writes. That risk is the client's, and the reason writes stay out.
- **Where the data goes.** Results go to the MCP client and, through it, to its model provider. With Claude Desktop that means Anthropic. That is fine for public data, but for real business data it is a data-sharing decision for the owner.
- **Secrets at rest.** Only the token's hash is kept. The raw token and the local database URL sit in the client's config file in plain text, as with any local MCP server: keep that file private.
- **Staleness.** The context is read afresh for every call, so a disabled user or a removed permission takes effect on the next call.

## Tests

- `server/domain/flowchain-mcp-server.test.mjs`: a scripted MCP client over in-memory facts. It covers the handshake and its errors; the tool list by role (none for UI, all read-only); a call with refs, links and its audit row; `not_allowed` for a role without access; schema errors; the injection refusal and the rate limit; and the local-only guard and token checks.
- `tests/postgres/flowchain-mcp.test.mjs`: the real script over stdio against a database. It lists the user's tools and returns only their workspace's order with its link. It also checks that a malformed line gets a parse error, that the audit row is written to the user's workspace, and that a wrong token and production are refused.

No model is called by the server or the tests.

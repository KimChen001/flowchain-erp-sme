# Product and company knowledge

Open the floating AI assistant, then **Knowledge library**. Workspace administrators
can paste text or import UTF-8 `.txt` / `.md`, PDF, and DOCX product guides and company handbooks.
Choose a readership before importing. Members can search and open only accessible
documents in their authenticated workspace. Archive removes a document from search.

**Auto-detect** is the default. Clear live-data questions (including “Which records
are incomplete?”) use business evidence, even after selecting knowledge mode.
Product specifications and policies use knowledge search. Questions combining
live records and policies display business results with a separate supporting
knowledge card. **Business records** remains an explicit override; **Product &
company knowledge** handles less specific document searches.
**Open cited passage** checks authorization again and highlights the original
passage. Citation numbers remain stable when generation uses only some sources.

## Implementation

### OpenAI connection

For the local application, set `FLOWCHAIN_KNOWLEDGE_PROVIDER=openai` and
`OPENAI_API_KEY` in `.env.local` or the ignored `.local/openai.env`. The latter is
loaded only when `FLOWCHAIN_DEV_LOCAL=true`; restart the server after editing it.
Production should inject these values as server environment secrets. Never use
`VITE_` variables for credentials. This preset only configures knowledge retrieval
and answer generation; it does not enable other business AI provider calls.

Defaults are `text-embedding-3-small` at 1,536 dimensions and `gpt-4.1-mini` using
Responses with a strict answer/citation schema, a 1,200 output-token cap and
`store:false`. Override with `FLOWCHAIN_KNOWLEDGE_EMBEDDING_MODEL`,
`FLOWCHAIN_KNOWLEDGE_EMBEDDING_DIMENSIONS`, and `FLOWCHAIN_KNOWLEDGE_MODEL`.
The preset fixes destinations to `https://api.openai.com/v1/embeddings` and
`https://api.openai.com/v1/responses`; existing custom-provider settings remain
available without opting into this preset.

Run `node scripts/check-knowledge-provider.mjs` to make a small real embedding
and generation check using synthetic text. Success requires a validated vector
and a generated answer citing the supplied passage. It never reads customer
records and does not print credentials, vectors, or provider response bodies.
Then use **Reindex** in the knowledge library for existing documents. A configured
key is not proof of service availability; `insufficient_quota` needs project billing
attention and is not retried like transient rate limiting. Preserve the old index
until a rebuild succeeds.

Official references: [embeddings](https://developers.openai.com/api/docs/guides/embeddings),
[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini),
[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

### Qwen connection

For a separate low-cost generation option, set `FLOWCHAIN_KNOWLEDGE_PROVIDER=qwen`,
`DASHSCOPE_API_KEY`, `FLOWCHAIN_QWEN_REGION`, and `FLOWCHAIN_QWEN_WORKSPACE_ID`.
Use the region and Workspace ID from the same Alibaba Cloud Model Studio account.
Supported endpoint regions are `ap-southeast-1`, `cn-beijing`, and `cn-hongkong`;
model availability must still be checked in that regional workspace. Invalid or
missing region/workspace configuration prevents requests. OpenAI credentials are
never reused for Qwen.

The preset defaults to `qwen-flash` with non-thinking JSON output and a 1,200-token
output cap, plus `text-embedding-v4` with 1,024 dimensions and batches of ten.
Override these using `FLOWCHAIN_QWEN_MODEL`, `FLOWCHAIN_QWEN_EMBEDDING_MODEL`, and
`FLOWCHAIN_QWEN_EMBEDDING_DIMENSIONS`. Citation IDs remain locally validated.
JSON mode guarantees JSON syntax, not factual correctness.

For local development, place configuration in ignored `.local/ai-provider.env`.
It loads before the legacy `.local/openai.env`, after `.env.local` / `.env`;
existing process environment values take precedence. Restart the server after
changes. Run `node scripts/check-knowledge-provider.mjs` to test one synthetic
passage before indexing company documents. Then rebuild knowledge indexes:
OpenAI and Qwen vectors cannot be mixed. Until rebuilt, incompatible vectors are
excluded and lexical retrieval remains available. Unit tests use simulated API
responses and do not demonstrate a live account connection.

Official references: [regional endpoints](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope),
[embeddings and batch limits](https://www.alibabacloud.com/help/en/model-studio/text-embedding-synchronous-api),
[JSON output](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output).

### Retrieval and storage

LangChain `RecursiveCharacterTextSplitter` produces overlapping 1,000-character
chunks stored in PostgreSQL. A `BaseRetriever` implementation ranks authorized
chunks using hybrid reciprocal-rank fusion over lexical BM25 (including Chinese
bigrams) and optional embedding cosine similarity. `RunnableSequence` connects
retrieval to the existing bounded provider adapter. Embeddings are stored as
versioned JSONB vectors for portable fallback. When the
database has pgvector, FlowChain also writes the native vector column, provisions
a model-and-dimension-specific HNSW cosine index (up to 2,000 dimensions), and retrieves a tenant- and
permission-scoped database Top-K. PostgreSQL without the extension continues to
score the bounded 2,000-chunk corpus in the application.

Configure embeddings independently from answer generation with
`FLOWCHAIN_AI_EMBEDDING_ENDPOINT`, `FLOWCHAIN_AI_EMBEDDING_API_KEY`, and
`FLOWCHAIN_AI_EMBEDDING_MODEL`; `FLOWCHAIN_AI_EMBEDDING_DIMENSIONS` is optional.
Each chunk records a SHA-256 content hash, model, dimensions, and indexing time.
Provider failure leaves the document searchable through BM25.

Imports save text before attempting embeddings. The library reports vector
coverage, configured-provider availability, and durable processing / ready / failed
attempts. A failed rebuild keeps the old index; **Retry indexing** starts a new
attempt. Claims prevent simultaneous rebuilds, and attempts older than 15 minutes
can be reclaimed. This is request-driven indexing with durable attempt records,
not a background job queue. There is no automatic retry after a process restart.

Embedding calls use batches of 32 (ten for the Qwen preset) with up to three attempts for transient errors.
Malformed vectors, zero vectors, duplicate response indexes, and dimension changes
are rejected. Unchanged chunks are reused only when content hash, model and explicit
dimensions match. Changed configuration requires reindexing. New JSONB and pgvector
writes commit together; failures roll back. Native pgvector availability does not
prove older JSON-only documents have been backfilled: reindex those documents.

The existing provider configuration enables generation. Only the top five passages
are supplied, as untrusted reference text. Unknown or missing citation IDs, provider
failure, or missing provider configuration return explicitly labelled excerpts.
No matching passages return a no-results message. No business mutations run here.
Citation validation checks source identity; it does not prove every generated claim.

File imports are limited to 5 MB; PDFs are limited to 100 pages and scanned PDFs
need OCR before import. Current retrieval limits are 100,000 extracted characters per
document, 2,000 accessible chunks per query, and 100 documents in the library list.
Document versions, a durable background queue, calibrated retrieval thresholds,
larger-corpus retrieval, restore UI, and automated factuality evaluation remain
future work. No model API credentials or cloud database are provisioned by this
feature. Without configured embeddings/generation, the demo uses keyword retrieval
and labelled source excerpts.
Scope routing does not add new business query executors: completeness questions
still use the existing business evidence handler, whose record-level checks need
further coverage. A knowledge citation is not proof of a current business total.

Run `npm test`, `npm run test:db:ai-knowledge`, `npm run typecheck`, and `npm run build`.
Database tests also cover concurrent claims, cached vectors, failed rebuilds,
transaction rollback, and abandoned-attempt recovery. Unit tests include 30 bilingual
scope cases and embedding validation. Run UI regression tests with
`PLAYWRIGHT_SETTINGS_DB=true npx playwright test tests/browser/ai-knowledge-readiness.spec.ts`
(set the environment variable using the syntax for your shell).

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

Embedding calls use batches of 32 with up to three attempts for transient errors.
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

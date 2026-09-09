# Product and company knowledge

Open the floating AI assistant, then **Knowledge library**. Workspace administrators
can paste text or import UTF-8 `.txt` / `.md` product guides and company handbooks.
Choose a readership before importing. Members can search and open only accessible
documents in their authenticated workspace. Archive removes a document from search.

Choose **Product & company knowledge** before asking a question. Explicit requests
for product manuals or cited sources also route to knowledge search. Answers expose
retrieved passages and an **Open source** action that checks authorization again.

## Implementation

LangChain `RecursiveCharacterTextSplitter` produces overlapping 1,000-character
chunks stored in PostgreSQL. A `BaseRetriever` implementation ranks authorized
chunks using lexical BM25, including Chinese bigrams. `RunnableSequence` connects
retrieval to the existing bounded provider adapter. This is not vector retrieval:
there is no embedding service or semantic similarity index in this first version.

The existing provider configuration enables generation. Only the top five passages
are supplied, as untrusted reference text. Unknown or missing citation IDs, provider
failure, or missing provider configuration return explicitly labelled excerpts.
No matching passages return a no-results message. No business mutations run here.
Citation validation checks source identity; it does not prove every generated claim.

Current limits: 100,000 characters per document, 2,000 accessible chunks per query,
and 100 documents in the library list. PDF/DOCX extraction, embeddings, document
versions, restore UI, and automated factuality evaluation remain future work.

Run `npm test`, `npm run test:db:ai-knowledge`, `npm run typecheck`, and `npm run build`.
Database tests cover persistence, tenant/readership isolation and archive behavior;
unit tests cover retrieval, source validation, generation fallback and authentication.

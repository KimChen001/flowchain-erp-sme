# Knowledge evaluation

Scores the knowledge (RAG) path against the AI master plan's sample documents
(v2.0, section 15) and its starter cases (section 16), plus the plan's demo
request and isolation checks. Everything here is fictional.

```
npm run test:ai:eval:knowledge
```

## What a run does

1. Starts an embedded PostgreSQL through `scripts/run-postgres-test-files.mjs` and
   applies the migrations.
2. Creates two workspaces and imports `corpus` from `cases.json`:
   - workspace C: the three files in `documents/`, read through the real file
     parser as a Markdown upload would be; an archived old guide that contradicts
     them; and a finance-only document;
   - workspace D: a guide that contradicts workspace C's.
3. Asks every case as a buyer in workspace C unless the case says otherwise, and
   checks:
   - `scope`: where automatic mode sends the question (`classifyQueryScope`);
   - `sources`, `notSources`: the documents cited;
   - `sections`, `forbiddenSections`, `firstSection`: the cited sections, by the
     last part of the heading path;
   - on every case: nothing archived, nothing from the other workspace, nothing
     from a reader group the asker is not in, and the first cited passage opens
     again with the asker's own access.
4. Prints a table and writes `knowledge-report.json` to
   `<os tmpdir>/flowchain-ai-eval/`, or to `AI_EVAL_KNOWLEDGE_REPORT`.

The run has no provider: retrieval is keyword-only and answers are excerpts. The
`expect` and `mustNot` text of each case states what a generated answer must say;
scoring it needs a run with a provider, which is not part of this runner yet.

## Known gaps

`knownGaps` names a check that is expected to fail and why. The run reports it
without failing. Today there is one: automatic mode keeps "What is the price of
FC-DEMO-SENSOR-100?" with business data. Choosing between documents and records is
left to model tool planning.

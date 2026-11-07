# Assistant evaluation

## What is here

- `knowledge/`: the knowledge (document search) evaluation, run in CI as
  `npm run test:ai:eval:knowledge`. See `knowledge/README.md`.
- `offline-guard.mjs`: refuses every connection to a host other than this
  machine, so an evaluation run never calls a provider by accident. The
  knowledge evaluation imports it.

## The rules evaluation was removed (2026-11-06)

The 252-case offline evaluation (`run-eval.mjs`, `questions.json`,
`baseline.json`) scored the deterministic rules engine and the model-first
loop. At the owner's direction the assistant now answers only with
assistant v2, and that engine was removed, so the evaluation went with it. It
never measured assistant v2.

Assistant v2 is measured by live conversations against a local server (the
before/after runs in PRs #269 and #271). A checked-in v2 evaluation on public
data (M5 and UCI Online Retail II, with answers computed by scripts) is the
next step; it will live here.

The removed files are in git history: `git show 4c7a8f7b:tests/ai-eval/run-eval.mjs`.

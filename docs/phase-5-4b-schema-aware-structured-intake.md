# Phase 5.4B Schema-Aware Structured Smart Intake

## Release boundary

Phase 5.4B makes Universal Intake usable for structured **Supplier**, **Item**,
and **Customer** previews. It does not create or update those business objects.
Every business commit attempt remains blocked with HTTP 501 and
`FLOWCHAIN_INTAKE_COMMIT_NOT_IMPLEMENTED`.

Supported sources are CSV upload, XLSX upload, Paste Table, and Paste JSON.
Files are adapters, not the core intake model. Paste, future email/voice/chat,
and future API sources converge on the same artifact, parser, schema, mapping,
normalization, validation, and review pipeline.

## Authority and lifecycle

```text
InboundArtifact
  -> parser-owned profile
  -> immutable tenant schema snapshot
  -> confirmed deterministic mapping
  -> normalization + field evidence
  -> validation issues
  -> human review
  -> blocked business commit
```

The public `POST /api/intake/batches/:id/records` route no longer accepts
caller-owned rows. It returns HTTP 501 with
`FLOWCHAIN_INTAKE_DIRECT_RECORD_INSERT_RETIRED`. Only the controlled parser
service creates `IntakeRecord` rows. Legacy `/api/imports*` and
`/api/import-batches*` remain retired and cannot bypass this authority.

## Formats and limits

| Control | Limit |
| --- | ---: |
| Artifact or paste body | 10 MB |
| Records | 5,000 |
| Columns / safe payload fields | 200 |
| Row payload | 64 KiB |
| Nesting | 5 |
| XLSX sheets | 32 |
| XLSX ZIP entries | 2,000 |
| XLSX uncompressed bytes | 64 MiB |
| XLSX compression ratio | 100:1 |
| Profile sample rows | 10 |

CSV supports UTF-8, UTF-8 BOM, and explicitly selected GB18030. Delimiters are
comma, tab, and semicolon. Ambiguous encoding or delimiter selection fails
closed. The parser uses `csv-parse`; it does not implement a partial CSV
grammar.

Only `.xlsx` workbooks are accepted. Hidden sheets are not automatically
selected. Merged cells in the selected header/data region fail closed.
Formulas are never executed: a cached value can be profiled with a warning,
while an unavailable cached result produces a stable error. ZIP entry,
uncompressed-size, and compression-ratio limits are checked before workbook
parsing.

Paste JSON accepts only an object array or `{ "records": [...] }`. Prototype,
secret, excessive-depth, excessive-field, and internal control keys are
rejected. JSON keys remain untrusted source columns until mapping is confirmed.

## Mapping, normalization, and review

Mapping suggestions are deterministic: exact path, case-insensitive,
normalized name, canonical/Chinese alias, or a prior active mapping. Confidence
uses only `exact`, `strong`, `possible`, or `none`. Mapping activation validates
targets against the batch snapshot and rejects duplicate single-value targets
and missing required fields.

Normalized preview payloads separate `fields` and `customFields`. Evidence
records the target path, source column/cell locator, transform, mapping profile
identity/version, and suggestion source. Transforms are allowlisted; scripts,
SQL, formulas, and arbitrary code are not supported.

Validation compares Supplier codes and Item SKUs with tenant-scoped PostgreSQL
master data and classifies matches as existing-identical or
existing-different. Payment term and preferred supplier references are also
checked against PostgreSQL. The current database schema has no authoritative
Customer master model, so Customer existing-record comparison is not claimed
in Phase 5.4B; Customer field validation and batch duplicate checks still run.

Review supports source/normalized/evidence views, valid/warning/error/excluded
filters, exclusion and restoration, revalidation, and issue-report download.
It is intentionally not an online spreadsheet editor.

## Verification

The release gates cover fresh and exact Phase 5.4A additive migrations,
cross-tenant artifacts/batches/snapshots/custom fields, parser safety, mapping,
normalization evidence, direct-record retirement, legacy import retirement,
API authorization, PostgreSQL durability, and Chromium wizard behavior.

## Next phase

Phase 5.4C may introduce governed Supplier/Item/Customer command bundles.
Dynamic forms, conditional field rules, workflow configuration, AI-assisted
configuration, and unstructured email/PDF/voice/chat intake remain later work.

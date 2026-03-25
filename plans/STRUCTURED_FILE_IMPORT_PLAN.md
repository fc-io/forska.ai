# Structured XML/JSON import plan

## Goal

- Upload any XML/JSON file.
- Detect repeating boundaries.
- Let user pick boundary.
- Import each boundary item as 1 article.
- Cover API + UI + PR.

## Assumptions

- No DB migration unless forced. Reuse `data_source.cursor` for structured-file config.
- 1 datasource owns 1 uploaded file + 1 selected boundary.
- `importRoute` stays stable per datasource: `structured-file:<datasourceId>`.
- JSON repeating boundary == array with `length > 1`.
- XML repeating boundary == repeated sibling tag parsed to array.
- Any boundary item can become article content even if schema is unknown.
- Article mapping is heuristic:
  - title: prefer `title|name|label|headline|id`; else datasource title + index.
  - summary: prefer `summary|abstract|description|text|content|body`; else compact markdown from item.
  - authors: prefer `authors|author|creator` strings.
  - created/updated: prefer common date fields; else import time.
  - stable id: prefer explicit id-like field; else content hash.
- Raw boundary item stays in `originalData`.
- Re-import is idempotent when stable ids exist; hash fallback may create new ids if content changes.

## Shape

- Server service parses XML/JSON, saves upload under `assets/structured_file_imports/`, returns boundary candidates.
- Candidate carries path, count, sample keys, sample item preview.
- Create/import endpoint persists datasource + cursor config + imported articles.
- Reimport endpoint reuses saved datasource config.
- Admin UI gets dedicated structured-file import page.
- Datasource list gets new entry point + reimport support for structured-file sources.

## Checklist

- [x] add concise structured-file plan
- [x] add server parse/analyze/import helpers
- [x] add upload storage + cursor config helpers
- [x] add analyze endpoint for XML/JSON upload
- [x] add create+import endpoint
- [x] add reimport endpoint for existing datasource
- [x] expose structured-file metadata from datasource APIs
- [x] add admin UI page: upload -> analyze -> select boundary -> import
- [x] add datasource list button for XML/JSON import
- [x] wire datasource reimport button for structured-file sources
- [x] add tests for JSON boundary detection
- [x] add tests for XML boundary detection
- [x] add tests for article mapping/import flow
- [x] run lint
- [x] run targeted tests
- [x] build app
- [x] commit
- [x] open PR

## Validation notes

- `bun test src/server/services/structuredFileImportService.test.ts` passes.
- `bunx eslint` passes on changed files.
- `bun run build` passes.
- `bun run lint` still reports unrelated pre-existing repo errors outside this change.

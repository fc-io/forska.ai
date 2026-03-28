# Covidence datasource import plan

## Goal

- Import Covidence exports as datasource-backed articles.
- Reuse existing datasource/import-route/article flow.
- Keep reimport idempotent.

## File scope

- Phase 1: reference exports only.
  - `.csv` from Covidence Export -> References.
  - `.ris` from EndNote/Zotero/Mendeley/RefWorks/Cochrane-style exports.
  - Accept any exported list: screening, irrelevant, review/full-text review, missing full text, excluded, included.
- Not phase 1:
  - extraction/quality-assessment CSV
  - inter-rater-reliability CSV
  - PRISMA/docx/text exports
- Reason: current datasource model is article/citation rows; non-reference exports are review analytics/tables.

## Assumptions

- 1 datasource owns 1 uploaded Covidence file.
- Stable `importRoute` per datasource: `covidence:<datasourceId>`.
- Reuse `data_source.cursor` for config, no schema change unless forced.
- Save raw uploads under `assets/covidence_imports/`.
- Datasource becomes immutable after create, same as structured-file imports; archive + reimport still allowed.
- If stage/list is not inferable from file name/content, ask user to pick it in UI.
- Stable article id priority: DOI -> PMID -> source/reference id -> normalized title+year+first-author hash.
- Preserve tags, notes, exclusion reason, stage, source file info in `originalData` + `sourceMetadata`.

## Shape

- Add `src/server/services/covidenceImportService.ts`.
  - detect `csv` vs `ris`
  - parse Covidence reference exports
  - normalize rows to `ArticleImportStoreRow`
  - save upload + config
  - support reimport from saved config
- Add routes.
  - `POST /api/datasources/import/covidence-analyze`
  - `POST /api/datasources/import/covidence-create`
  - `POST /api/datasources/import/covidence`
- Analyze returns: detected format, row count, stage guess, sample fields, warnings.
- Create route persists datasource, imports articles, stores cursor config, updates `last_import_at` + `items_after_last_import`.
- Reimport route reloads saved asset/config and reimports on same route.

## Mapping

- RIS: map title, abstract, authors, journal, date/year, DOI, PMID, URL, notes.
- CSV: map title, abstract, authors, year/date, journal, DOI/PMID when present, tags, notes, exclusion reason.
- Populate `articleTitle`, `articleSummary`, `articleAuthors`, `articleCreatedAt`, `doi`, `pubmedId`, `url`, `importRoute`, `originalData`, `sourceMetadata`.
- Leave full text empty; Covidence reference exports are citation-level, not full-text assets.
- Store stage/list label in metadata even when file already encodes it.

## UI

- Add admin page `src/app/routes/+admin/+datasources/+covidence-import.tsx`.
- Flow: upload -> detect/preview -> optional stage override -> create datasource.
- Add datasource list CTA beside structured-file import.
- Add reimport support from datasource list for Covidence-backed sources.
- Edit page shows Covidence config and same immutability message used for imported files.

## Checklist

- [ ] add Covidence parse/analyze/import service
- [ ] add upload storage + cursor config helpers
- [ ] add analyze/create/reimport routes
- [ ] expose Covidence config from datasource APIs
- [ ] add admin UI upload/preview/import page
- [ ] add datasource list CTA + reimport wiring
- [ ] add CSV parsing tests
- [ ] add RIS parsing tests
- [ ] add idempotent reimport tests
- [ ] run `bun run lint`
- [ ] run targeted `bun test`
- [ ] run `bun run build`

## Quality Gates

- `bun test src/server/services/covidenceImportService.test.ts`
- `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
- `bun run lint`
- `bun run build`
- Browser: import 1 sample `.csv` and 1 sample `.ris`, datasource appears, reimport succeeds, edit page stays read-only except archive.

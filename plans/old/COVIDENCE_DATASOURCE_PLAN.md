# Covidence datasource import plan

## Goal

- Import Covidence screening exports as 1 datasource + 1 project.
- Auto-create/reuse prompt from inclusion/exclusion criteria.
- Seed human judgments from Covidence decisions.

## Import modes

- `title_abstract`
  - files: `all`, `irrelevant`, `full_text`
  - merge files by stable article key
  - datasource stores all merged articles
  - project links same import route
  - seed human judgments: `irrelevant=no`, `full_text=yes`
- `full_text`
  - files: `all`, `irrelevant`, `full_text`, `excluded`, `included`
  - `all` stays canonical metadata source; stage files add decisions/notes/reasons
  - datasource stores all merged articles
  - project scope defaults to articles that reached full-text stage: `full_text ∪ excluded ∪ included`
  - seed human judgments: `excluded=no`, `included=yes`

## File scope

- Accept Covidence reference exports only.
  - `.csv`
  - `.ris`
- Not this work:
  - extraction / quality-assessment CSV
  - inter-rater-reliability CSV
  - PRISMA / docx / text exports

## Assumptions

- 1 datasource owns 1 Covidence import package, not 1 file.
- Save package files under `assets/covidence_imports/<datasourceId>/`.
- Stable `importRoute`: `covidence:<datasourceId>`.
- Reuse `data_source.cursor` for package config.
- Datasource stays immutable after create; archive + reimport allowed.
- Reimport updates datasource/project/prompt seeding; do not duplicate project or prompt.
- Stable article id priority: DOI -> PMID -> Covidence/reference id -> normalized title+year+first-author hash.
- Validate mutually exclusive lists: `irrelevant` vs `full_text`, `excluded` vs `included`.

## Prompt creation

- Import UI collects:
  - screening mode
  - inclusion criteria text
  - exclusion criteria text
  - answer set: `yes|no` or `yes|no|unsure`
  - project name + model
- Build stage-specific prompt text.
  - `title_abstract`: `Based on the inclusion and exclusion criteria, should this study be included for full text review?`
  - `full_text`: `Based on the inclusion and exclusion criteria, should this study be included in the final review?`
  - append allowed answers
  - append `Inclusion:` block
  - append `Exclusion:` block
- Prompt type is `'yes' | 'no'` or `'yes' | 'no' | 'unsure'`.
- Reuse existing prompt when same content + heading + type already exists; only create if missing.

## Project creation

- Create project during import, not later.
- Link project to Covidence import route instead of duplicating curated project articles.
- Attach reused/created prompt to project.
- Title/abstract project defaults to title+abstract enabled.
- Full-text project still starts title+abstract-first; full text can be enabled later if articles get full-text content.
- Create project once per datasource package; reimport refreshes links/judgments in place.

## Mapping

- Merge rows across files by stable key.
- `all` provides best metadata; stage files overlay tags, notes, exclusion reason, stage membership.
- Persist title, abstract, authors, year/date, journal, DOI, PMID, URL, raw row, source metadata.
- Keep stage membership in `originalData` + `sourceMetadata`.
- Keep exclusion reason / notes in metadata and copy into human-judgment comment when useful.

## Analyze + create flow

- Add `covidenceImportService`.
  - detect package mode + file labels
  - parse CSV/RIS
  - preview coverage, duplicate keys, missing matches, conflicting stage memberships
  - normalize merged rows to `ArticleImportStoreRow`
- Add routes.
  - `POST /api/datasources/import/covidence-analyze`
  - `POST /api/datasources/import/covidence-create`
  - `POST /api/datasources/import/covidence`
- Analyze accepts multi-file upload and returns detected file roles, counts, warnings, sample merged rows.
- Create persists datasource, imports articles, creates/reuses prompt, creates/reuses project, seeds human judgments.

## Human judgments seeding

- Seed answered `judgment_human` rows during create/reimport.
- `title_abstract`
  - `irrelevant -> no`
  - `full_text -> yes`
- `full_text`
  - `excluded -> no`
  - `included -> yes`
- If `unsure` is enabled, do not infer it from Covidence exports; keep only `yes/no` seeded rows.
- Rows with no Covidence decision stay unanswered and available for human/LLM review.

## UI

- Add page `src/app/routes/+admin/+datasources/+covidence-import.tsx`.
- Flow: choose mode -> upload package files -> inspect coverage -> enter criteria -> choose answer set/model -> import.
- Add datasource list CTA + reimport support.
- Edit page shows Covidence package config, linked project, linked prompt, immutability state.

## Checklist

- [ ] add Covidence package parse/analyze/import service
- [ ] add package asset storage + cursor config helpers
- [ ] add analyze/create/reimport routes
- [ ] add prompt reuse/create logic
- [ ] add project reuse/create + import-route linking logic
- [ ] add human-judgment seeding for both modes
- [ ] expose Covidence config from datasource APIs
- [ ] add admin UI multi-file import page
- [ ] add datasource list CTA + reimport wiring
- [ ] add CSV tests
- [ ] add RIS tests
- [ ] add merge/conflict tests
- [ ] add prompt/project/judgment seeding tests
- [ ] run `bun run lint`
- [ ] run targeted `bun test`
- [ ] run `bun run build`

## Quality Gates

- `bun test src/server/services/covidenceImportService.test.ts`
- `bun test src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.test.ts`
- `bun run lint`
- `bun run build`
- Browser: import 1 `title_abstract` package and 1 `full_text` package; datasource exists; project exists; prompt reused/created correctly; seeded human judgments match Covidence decisions; reimport does not duplicate prompt/project.

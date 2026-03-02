# FHIR EHR patients -> articles (Patient -> Article)

## Goal

- Import FHIR Bulk NDJSON patient datasets (any size/sharding) from `assets/**` into Postgres `articles`.
- Example dataset: `assets/sample-bulk-fhir-datasets-100-patients/**/*.ndjson`.
- 1 FHIR Patient == 1 `articles` row.
- `articleSummary` == `fullText` (identical string).
- Title info duplicated inside summary/fulltext.

## Decisions (IDs + routing)

- importRoute (linking + project scoping): `fhir:<datasetId>` (caller-provided; size-agnostic).
- default importRoute (if missing): `fhir:` + rel path from `assets/` (`assets/foo/bar` -> `fhir:foo:bar`).
- `articles.articleId` (unique): `<importRoute>:Patient/<patientId>`.
- `articles.articleTitle`: `FHIR Patient <patientId>` (option: include name/sex/birthDate if present).

## Record text (stored in articleSummary + fullText)

- Deterministic, append-only-ish format (easy diffing).
- Top header includes:
  - `record_type: fhir_patient`
  - `patient_id: <id>`
  - `import_route: <importRoute>`
  - `title: <articleTitle>` (duplicate)
  - `assets_folder: <path>`
- Include Patient + linked resources as raw JSON lines (preserve original NDJSON line; no re-stringify).
- Patient linkage extraction (per resource):
  - normalize `*.reference` (accept `Patient/<id>`, `*/Patient/<id>`, `Patient/<id>/_history/*`)
  - prefer `subject.reference`
  - else `patient.reference`
  - else ignore.
- Decode and include embedded note text when present:
  - `DocumentReference.content[].attachment.data` (base64 -> utf8)
  - `DiagnosticReport.presentedForm[].data` (base64 -> utf8)
  - cap bytes; skip non-utf8/binary-ish
- Ordering (stable):
  - `resourceType` alpha
  - within type: `effectiveDateTime`/`issued`/`date`/`authoredOn`/`recordedDate`/`onsetDateTime` (first present), then `id`.

## Importer (server-side, idempotent)

- [ ] Add workflow module (pattern: `src/agent/pubmedWorkflowStoreEntries.ts`):
  - `src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts`
  - input: `{assetsFolder, importRoute?}` (default importRoute derived from assetsFolder)
  - output: stats `{patientsTotal, inserted, updated, skipped, errors}`
- [ ] Walk `**/*.{ndjson,ndjson.gz}` shards under assetsFolder (recursive; stream line-by-line; no limit):
  - pass1 `resourceType=="Patient"` -> spool patient line
  - pass2 `resourceType=="Encounter"` -> index `Encounter/<id> -> Patient/<id>`
  - pass3 all other types -> resolve patientId (subject/patient ref; else encounter ref) -> spool line
- [ ] Avoid full-dataset memory: spool to tmp shards (hash(patientId)%N) then process shard-by-shard.
- [ ] For each patientId with Patient present: build `recordText` then upsert:
  - `articles.articleId`, `articles.articleTitle`, `articles.articleSummary`, `articles.fullText`, `articles.importRoute`, `articles.originalData`.
  - set `fullTextConversionStatus` = `success` and `fullTextCharCount`.
- [ ] Ensure `import_route` row exists (`route=<importRoute>`), then insert `article_route_link` rows.
- [ ] Keep import repeatable: onConflict update content fields + `updatedAt`.

## APIs

### A) DataSource import (Admin)

- [ ] Add route: `POST /api/datasources/import/fhir-ehr-patients`.
- [ ] Body: `{id: string}` (datasource id).
- [ ] Store local assets path on datasource:
  - `datasource.cursor` = `assets/<datasetFolder>` (treat as config, not cursor).
  - `datasource.importRoute` default derived from `cursor`.
- [ ] Handler:
  - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.ts`
  - validate `cursor` startsWith `assets/`.
  - call workflow importer.
  - update datasource: `lastImportAt`, `itemsAfterLastImport` (=patients imported); keep `cursor`.
- [ ] Wire into `src/server/routes/DataSourcesImportRoutes.ts`.

### B) Direct import API (Admin)

- [ ] Add route: `POST /api/fhir-ehr/import/patients-from-assets`.
- [ ] Body: `{assetsFolder: string, importRoute?: string, dryRun?: boolean}`.
- [ ] Same importer + same path validation (`assets/` prefix); if importRoute missing, derive.
- [ ] Response includes stats + sample imported `articleId`s.

## Patient system prompt (different from articles)

- [ ] Add new constants:
  - `src/agent/judge/judgeSinglePromptSystemPromptPatient.ts` (patient EHR wording, same JSON contract)
  - optional: `src/agent/judge/judgeSystemPromptPatient.ts` (multi-prompt parity)
- [ ] Select system prompt at runtime (no schema change):
  - in `src/agent/judge.ts` / `judgeSinglePrompt`: if `article.articleId` startsWith `fhir:` OR `article.importRoute` startsWith `fhir:` => patient system prompt else article system prompt.
- [ ] Keep output identical shape: `{answer, explanation, quotes}`.

## Ops / usage

- Patient projects recommended content settings (avoids fulltext token-budget skip; summary==fulltext anyway):
  - `useTitle=false`, `useAbstract=true`, `useFulltext=false`, `useFulltextNoImages=false`.
- Validate quickly:
  - create datasource with `cursor=assets/<datasetFolder>`, `importRoute=fhir:<datasetId>`
  - call import endpoint
  - create project linked to `fhir:<datasetId>`, run judgments job

# FHIR EHR patients -> articles (Patient -> Article)

## Goal

- Import `assets/sample-bulk-fhir-datasets-100-patients/**.ndjson` into Postgres `articles`.
- 1 FHIR Patient == 1 `articles` row.
- `articleSummary` == `fullText` (identical string).
- Title info duplicated inside summary/fulltext.

## Decisions (IDs + routing)

- import_route (linking + project scoping): `fhir:synthea:100`.
- `articles.articleId` (unique): `fhir:synthea:100:Patient/<patientId>`.
- `articles.articleTitle`: `FHIR Patient <patientId>` (option: include name/sex/birthDate if present).

## Record text (stored in articleSummary + fullText)

- Deterministic, append-only-ish format (easy diffing).
- Top header includes:
  - `record_type: fhir_patient`
  - `patient_id: <id>`
  - `title: <articleTitle>` (duplicate)
  - `assets_folder: <path>`
- Then include ALL patient-linked FHIR resources (raw JSON), grouped by `resourceType`.
- Patient linkage extraction (per resource):
  - prefer `subject.reference == "Patient/<id>"`
  - else `patient.reference == "Patient/<id>"`
  - else ignore.
- Decode and include embedded note text when present:
  - `DocumentReference.content[].attachment.data` (base64 -> utf8)
  - `DiagnosticReport.presentedForm[].data` (base64 -> utf8)
- Ordering (stable):
  - `resourceType` alpha
  - within type: `effectiveDateTime`/`issued`/`date`/`authoredOn`/`recordedDate`/`onsetDateTime` (first present), then `id`.

## Importer (server-side, idempotent)

- [ ] Add workflow module (pattern: `src/agent/pubmedWorkflowStoreEntries.ts`):
  - `src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts`
  - input: `{assetsFolder, importRoute}`
  - output: stats `{patientsTotal, inserted, updated, skipped, errors}`
- [ ] Walk shards under assetsFolder (stream line-by-line; multiple `*.ndjson` files):
  - pass1 `Patient.*` init buckets
  - pass2 `Encounter.*` index `Encounter/<id> -> Patient/<id>`
  - pass3 all other types: attach to patient via `subject.reference`/`patient.reference`, else via `encounter.reference` -> encounter index
- [ ] Build `Map<patientId, {patient: Patient|null, resources: Record<resourceType, unknown[]>}>`.
- [ ] For each patientId with Patient present: build `recordText` then upsert:
  - `articles.articleId`, `articles.articleTitle`, `articles.articleSummary`, `articles.fullText`, `articles.importRoute`, `articles.originalData`.
  - set `fullTextConversionStatus` = `success` and `fullTextCharCount`.
- [ ] Ensure `import_route` row exists (`route=fhir:synthea:100`), then insert `article_route_link` rows.
- [ ] Keep import repeatable: onConflict update content fields + `updatedAt`.

## APIs

### A) DataSource import (Admin)

- [ ] Add route: `POST /api/datasources/import/fhir-ehr-patients`.
- [ ] Body: `{id: string}` (datasource id).
- [ ] Store local assets path on datasource:
  - `datasource.cursor` = `assets/sample-bulk-fhir-datasets-100-patients` (treat as config, not cursor).
  - `datasource.importRoute` default `fhir:synthea:100`.
- [ ] Handler:
  - `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.ts`
  - validate `cursor` startsWith `assets/`.
  - call workflow importer.
  - update datasource: `lastImportAt`, `itemsAfterLastImport` (=patients imported); keep `cursor`.
- [ ] Wire into `src/server/routes/DataSourcesImportRoutes.ts`.

### B) Direct import API (Admin)

- [ ] Add route: `POST /api/fhir-ehr/import/patients-from-assets`.
- [ ] Body: `{assetsFolder: string, importRoute?: string, limit?: number, dryRun?: boolean}`.
- [ ] Same importer + same path validation (`assets/` prefix).
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
  - create datasource with `cursor=assets/sample-bulk-fhir-datasets-100-patients`, `importRoute=fhir:synthea:100`
  - call import endpoint
  - create project linked to `fhir:synthea:100`, run judgments job

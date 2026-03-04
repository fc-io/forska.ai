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

## Record markdown (articleSummary + fullText)

- Goal: 1 self-contained Markdown doc per patient (no ref pointers like `Encounter/<id>` or `Practitioner?identifier=...`).
- Current issues (sample `articles.id=12cfb96e-4908-49c6-9f29-30f0af21e6e2`): refs like `Encounter/<uuid>` not inlined; decoded notes contain `# ...`/`## ...`.
- Headings (strict; ToC must work):
  - `# FHIR Patient <patientId>` (exactly once)
  - `## Patient` (all demographics/identifiers/addresses/telecom; no refs out)
  - `## Timeline`
  - `### <YYYY-MM-DD>` (bucket by event date)
  - `#### <ResourceType>: <display>` (event/resource)
  - `##### Note ...` then note headings demoted to `###### ...` (never `# ...` inside patient doc)
- Code fences:
  - never wrap Markdown headings in fences (seen in sample `articles.id=12cf...` where fences swallow `## Plan`)
  - optional: raw JSON/text payloads only; always close immediately
- Patient linkage (per resource):
  - normalize `*.reference` (accept `Patient/<id>`, `*/Patient/<id>`, `Patient/<id>/_history/*`)
  - prefer `subject.reference`; else `patient.reference`; else resolve via `encounter.reference`; else ignore
- Inline references:
  - build `resourceByKey["Type/id"] -> resource` for patient
  - render refs as inline target fields ONLY (no `Type/id`, no `Type?identifier=...`, no `missing=true`)
  - post-render: no reference-like tokens left in summary/full
- Notes inlining:
  - decode base64 (`DocumentReference.content[].attachment.data`, `DiagnosticReport.presentedForm[].data`)
  - render as Markdown; demote headings to keep hierarchy (avoid note `# ...` -> extra H1s)
- Ordering (stable):
  - timeline sort by event datetime (`effectiveDateTime/issued/date/authoredOn/recordedDate/onsetDateTime`, else resourceType+id)
  - within same timestamp: resourceType alpha, then id

### Checklist: human formatting (store only this)

- [ ] store human-mode only in DB: `articleSummary===fullText`; provenance lives in `originalData` (no debug markdown)
- [ ] drop non-patient metadata noise (`import_route`, `assets_folder`) from markdown (already in DB columns + `originalData`)
- [ ] collapse duplicate info: if heading has display, don't repeat as `- code:`/`- medication:` etc
- [ ] time fields: emit 1 timestamp; label source(s) (e.g. `time(authoredOn)`); dedupe equal timestamps
- [ ] ids: avoid per-event `- id:` spam; if kept, combine with time into 1 compact line
- [ ] refs: inline target fields only; remove `Type/id` + `Type?identifier=...` + `missing=true`; omit `subject=Patient/<this>` repeats
- [ ] notes: keep `##### Note ...`; show `truncated=true` only; strip note-leading date line when it equals bucket date
- [ ] identifiers: keep full values (synthetic/needed; no redaction)

### Checklist: fix heading hierarchy

- [ ] 1 H1 only; `## Patient` + `## Timeline` only top-level
- [ ] timeline: `### <date>` then `#### <ResourceType>: ...` only (no level jumps)
- [ ] notes: never emit `#`/`##` lines from decoded note text; demote to `######` or strip
- [ ] fences: only for raw note payload; always closed; never contain timeline headings
- [ ] validator after render: multiple H1 / unmatched fences / bad jumps => errors++ + sample

### Checklist: inline references

- [ ] build per-patient map `Type/id -> parsed resource` (+ `identifier` query resolver)
- [ ] inline EVERY ref field as plain text context (no ids): encounter/status/period/location/provider; org/name; practitioner/name; device/type+model; location/name
- [ ] if target missing: use available `display` only (no `missing=true`, no query/id)
- [ ] post-render: scan summary/full for `\b[A-Za-z]+\?identifier=` + `\b[A-Za-z]+/[A-Za-z0-9.-]{1,64}\b` and fail if any remain
- [ ] notes: replace `Type/id` and `Type?identifier=...` tokens with context-only text
- [ ] Patient section: include identifiers/telecom/address so summary/full is self-contained

## Importer (server-side, idempotent)

- [x] Workflow importer: `src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts`
  - input: `{assetsFolder, importRoute?, dryRun?}`
  - output: stats `{patientsTotal, inserted, updated, skipped, errors}`
- [x] Walk `**/*.{ndjson,ndjson.gz}` shards under assetsFolder (recursive; stream line-by-line; no limit):
  - pass1 `resourceType=="Patient"` -> spool patient line
  - pass2 `resourceType=="Encounter"` -> index `Encounter/<id> -> Patient/<id>` AND spool Encounter (needed for ref inlining)
  - pass3 all other types -> resolve patientId (subject/patient ref; else encounter ref) -> spool line
- [x] Avoid full-dataset memory: spool to tmp shards (hash(patientId)%N) then process shard-by-shard.
- [x] For each patientId with Patient present: build markdown then upsert:
  - `articles.articleId`, `articles.articleTitle`, `articles.articleSummary`, `articles.fullText`, `articles.importRoute`, `articles.originalData`.
  - set `fullTextConversionStatus` = `success` and `fullTextCharCount`.
- [x] Ensure `import_route` row exists (`route=<importRoute>`), then insert `article_route_link` rows.
- [x] Keep import repeatable: onConflict update content fields + `updatedAt`.

## ArkType validation (imports)

- [x] ArkTypes: `src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowTypes.ts`
  - import bodies: `{assetsFolder, importRoute?, dryRun?}`; trim; enforce `assets/` prefix; enforce `importRoute` startsWith `fhir:` (derive if missing)
  - NDJSON line (open object; validate only read-fields): `resourceType`, `id?`, `subject?.reference?`, `patient?.reference?`, `encounter?.reference?`, `effectiveDateTime?`, `issued?`, `date?`, `authoredOn?`, `recordedDate?`, `onsetDateTime?`
  - type-specific required: `Patient.id`; `Encounter.id` + `Encounter.subject.reference`
  - note payloads: `DocumentReference.content[].attachment.data?` + `DiagnosticReport.presentedForm[].data?`
- [ ] Invalid body => 400 (today: importer throws; route handler maps to 500)

## APIs

### A) DataSource import (Admin)

- [x] Route: `POST /api/datasources/import/fhir-ehr-patients`.
- [x] Body: `{id: string}` (datasource id).
- [x] Store local assets path on datasource:
  - `datasource.cursor` = `assets/<datasetFolder>` (treat as config, not cursor).
  - `datasource.importRoute` default derived from `cursor`.
- [x] Handler: `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.ts`
- [x] Wired: `src/server/routes/DataSourcesImportRoutes.ts`

### B) Direct import API (Admin) (dont implement yet)

- [ ] Add route: `POST /api/fhir-ehr/import/patients-from-assets`.
- [ ] Body: `{assetsFolder: string, importRoute?: string, dryRun?: boolean}`.
- [ ] Same importer + same path validation (`assets/` prefix); if importRoute missing, derive.
- [ ] Response includes stats + sample imported `articleId`s.

## Patient system prompt (different from articles)

- [x] Constants:
  - `src/agent/judge/judgeSinglePromptSystemPromptPatient.ts`
  - `src/agent/judge/judgeSystemPromptPatient.ts`
- [x] Runtime select (no schema change): `src/agent/judge.ts` (articleId/importRoute startsWith `fhir:`)
- [x] Output shape unchanged: `{answer, explanation, quotes}`.

## Ops / usage

- Patient projects recommended content settings (avoids fulltext token-budget skip; summary==fulltext anyway):
  - `useTitle=false`, `useAbstract=true`, `useFulltext=false`, `useFulltextNoImages=false`.
- Validate quickly:
  - create datasource with `cursor=assets/<datasetFolder>`, `importRoute=fhir:<datasetId>`
  - call import endpoint
  - create project linked to `fhir:<datasetId>`, run judgments job

# Nice FHIR patient records (summary vs fulltext)

## Output split

- [x] Stop `articleSummary===fullText` for `fhir:` imports; store 2 markdown strings.
- [x] Add render profile: `summary` vs `fulltext` (`src/agent/fhirEhrPatientsWorkflow/buildFhirPatientMarkdown.ts`).
- [x] Importer writes both fields (`src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts`).

## Summary = human-only

- [x] No ids: remove per-event `- id: \`...\``; remove `patient_id`; no UUID-only headings.
- [x] No ref pointers: never show `Type/<id>` or `?identifier=`; inline context text only.
- [x] No FHIR path noise: remove `identifier[4]`, `performer[0]`, etc; map to human labels.
- [x] Identifiers: keep `type` + `value` only (eg `Passport Number: X25219320X`); drop `system=` + `use=` + indexes.
- [x] Devices: never render `#### Device: <id>`; render `Device: <type/model/udi>` or omit if empty.

## Fulltext = complete, still readable

- [x] Keep full timeline; still prefer displays over ids; ids only behind UI toggle.
- [x] Event heading display: add Device/Practitioner/Organization/Location/etc (no fallback to raw id).
- [x] References: avoid generic `- <path>: ...` dump when a resource-specific bullet exists; keep high-signal only.

## Humanization (both)

- [x] Telecom: `Phone (home): ...`, `Email: ...` (drop `system=`).
- [x] Address: single line; omit `use=` unless meaningful.
- [ ] Dates: show human date/time; keep raw only in technical toggle.
- [ ] Observations: `code: value unit`; add interpretation + ref range; summary shows abnormal/latest.
- [x] Notes: summary excerpt; fulltext full note; keep heading demotion + fence-close.

## UI

- [ ] Default `fhir:` articles to Summary tab.
- [ ] Add `Technical details` toggle (ids, paths, raw `originalData`).
- [x] Hide Article ID for `fhir:` by default (toggle to show/copy).

## QA + backfill

- [x] Tests: summary has no UUIDs, no `system=http`, no `?identifier=`, no `Type/<id>`, no `[...]`, no `- id:`.
- [x] Add summary validator (heading/fence + no-ids/no-refs).
- [ ] Backfill script/job: re-render summary/fulltext for existing `articleId` starting `fhir:` (idempotent).
- [x] Update `FHIR_EHR_PATIENT_PLAN.md` (new decision + new human-only rules).

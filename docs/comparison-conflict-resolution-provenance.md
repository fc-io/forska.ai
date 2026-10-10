# Conflict resolution provenance

A conflict resolution (`app.comparison_project_conflict_resolution`) records who set the current value and which judgment configuration the compare page showed when it was set. The row stays the current state with its old shape; provenance is five nullable columns on it plus one small content-addressed table. Nothing is computed per click: the context is computed once per serving generation.

Design: `forska-plans/2026-10-10-conflict-resolution-provenance.md` (v2). Migration: `src/db/duckdbMigrations/0261_comparisonConflictResolutionProvenance.sql`.

## What is stored

### `app.comparison_judgment_context` (immutable, content-addressed)

| column | meaning |
| --- | --- |
| `id` | sha256 hex of the canonical context identity (see below) |
| `context_json` | canonical context JSON, including display snapshots |
| `prompt_ids`, `model_ids`, `system_prompt_variants` | sorted arrays for cheap "which prompts / models / variants" queries; `prompt_ids` leaves out the synthetic `summary` id |
| `created_at` | first time this context was seen |

Written with `INSERT … ON CONFLICT DO NOTHING`. Identical configurations, in any comparison project, share one row. A few dozen rows in total; never cleaned up. No secondary indexes.

Canonical context (`src/server/services/comparisonJudgmentContext.ts`), keys sorted, arrays sorted, answers excluded:

```json
{
  "v": 1,
  "humanJudgmentMode": "summary",
  "summarySourceProjectId": "…",
  "sourceProjectIds": ["…"],
  "columns": [
    {"kind": "human", "promptId": "summary", "promptHeading": null},
    {"kind": "llm", "promptId": "…", "promptHeading": "Population", "modelId": "…", "modelName": "gpt-5.5",
     "useTitle": true, "useAbstract": true, "useFulltext": false, "useFulltextNoImages": false,
     "useMetadata": false, "systemPromptVariant": "legacy", "sourceProjectId": "…", "criteriaDisposition": "include"}
  ]
}
```

- `humanJudgmentMode` is the effective serving mode (`summary` only when the project compares with humans in summary mode).
- Columns are sorted by `kind, promptId, modelId, contentKey, sourceProjectId, criteriaDisposition` and deduplicated.
- In summary mode an LLM summary cell (`prompt_id = 'summary'`) is expanded into one entry per criteria prompt that feeds it: the source project's enabled prompts with a disposition and a section key, or the comparison project's prompts for the fallback group. `criteriaDisposition` is part of the entry because it changes the summary answer. Prompt-mode entries carry `criteriaDisposition: null`.
- `id = sha256(canonical JSON without promptHeading and modelName)`. The two names are display snapshots: `app.model.name` is rewritten by provider discovery, and a rename must not flag every resolution as resolved under older prompts. Prompt ids already pin the prompt text and heading. `context_json` keeps the names as first seen.

### `mart.comparison_judgment_context_serving`

`(comparison_project_id, generation, judgment_context_id, context_updated_at)`, one row per serving generation. Part of the generation cleanup set (`comparisonProjectServingGenerationService`), so old generations and purged projects drop their row; the next generation number also accounts for it.

### Columns on `app.comparison_project_conflict_resolution` (all nullable)

| column | UI save | file import | PDF import | project import (create from project) |
| --- | --- | --- | --- | --- |
| `reviewer_user_id` (existing) | local user | `transfer:<sha256(name)>` when the artifact names a reviewer, else NULL | `pdf-import:<uuid>` (unchanged) | source row's reviewer |
| `reviewer_display_name` | local user's name at save time | artifact reviewer name | name from the PDF front page, or `Unnamed reviewer` | source row's snapshot, else its registry name |
| `judgment_context_id` | context of the active generation | artifact `contextId` | `judgmentContextId` from the PDF metadata | source row's context |
| `serving_generation` | active generation | NULL | NULL | NULL |
| `origin` | `ui` | `file-import` | `pdf-import` | `project-import` |
| `origin_ref` | NULL | `<source comparison project id>:<sourceResolutionId>` | same formula on the PDF-derived ids | same formula |

Rules:

- Imports never attribute rows to the importing local user. Before this change file imports and create-from-project imports did.
- `transfer:*` reviewer rows are created with `ON CONFLICT(id) DO NOTHING`, so one name maps to one registry row. `transfer:*` and `pdf-import:*` rows are excluded wherever the local user is resolved (`getLocalUserConfigWhereClauseSql` in `userConfigQueryService.ts`, the background stack's memory-limit read).
- The import uses the source context, not the target's: the source context is what that reviewer saw. A file import whose `judgmentContexts` entry validates and hashes to its id upserts that context, so it resolves locally. A context id without a matching entry (or a PDF context id) is stored as is; if the same configuration exists locally the id resolves, otherwise the lookup returns nothing.
- Reset is unchanged (the row is deleted).
- Existing rows: everything NULL, read as provenance unknown. The migration backfills `reviewer_display_name` from `app.user_config` where `reviewer_user_id` is set. No context is guessed for old rows.

## Where the context comes from

`writeComparisonJudgmentContextForGeneration` runs inside the promotion transaction of `promoteComparisonProjectServingGeneration`, right after the generation becomes active. It reads the generation's distinct column identities from `mart.comparison_cell_serving` (`kind, prompt_id, model_id, content_key, source_project_id`), decodes `content_key` back to the five flags and the variant (`getComparisonContentKeySettings`: four `0/1` flags, optional `m` for `use_metadata`, optional `-<variant>`), expands summary columns as described above, joins prompt headings from `app.prompt` and model names from `app.model`, upserts the context and replaces the generation's mart row. One small query set per rebuild.

Backfill for generations that were active before the migration: the comparison serving maintenance worker (`comparisonProjectServingMaintenanceWorker.ts`) calls `backfillNextComparisonJudgmentContext` on ticks where no comparison project needs a rebuild. Each call handles one non-archived active generation without a mart row, inside one transaction that re-checks the generation is still active. It uses the same function as activation, so a backfilled generation and its next rebuild with an unchanged configuration produce the same id. It never runs on a request path. Until it has run, saves record a NULL context (provenance unknown).

`getComparisonProjectServingStatus` reads `activeJudgmentContextId` in the same query as `activeGeneration`; `getComparisonProjectScope` exposes it as `scope.judgmentContextId`.

## API

- `ComparisonProjectConflictResolution` (rows from `POST /api/comparison-projects/:id/judgments`, and the response of `POST /api/comparison-projects/:id/conflict-resolution`) keeps `reviewerUserId` / `reviewerDisplayName` and adds:
  - `reviewer: {userId, displayName} | null`
  - `provenance: {contextId, generation, setAt, origin} | null` (null for rows with no provenance at all)
  - `provenanceMatchesCurrent: boolean | null`, `row.judgment_context_id === scope.judgmentContextId`, null when either side is unknown
- `GET /api/comparison-projects/:id` adds `judgmentContextId` and `judgmentContext` (summary of the active generation's context).
- `POST /api/comparison-projects/judgment-contexts` with `{ids: string[]}` returns summaries for known ids (malformed ids are ignored, at most 200): `{id, createdAt, context, promptIds, prompts: [{id, heading}], modelIds, models: [{id, name}], systemPromptVariants}`.
- Listing, count, CSV/PDF export and resolution export accept `conflictResolutionProvenanceFilter: ('current' | 'outdated' | 'unknown')[]` (string or array, comma-separated allowed). It applies only when conflict resolution is enabled and combines with the other filters by AND, values by OR:
  - `current`: `judgment_context_id = <active context>`
  - `outdated`: `judgment_context_id <> <active context>`
  - `unknown`: `judgment_context_id IS NULL` or no active context
  All three require a resolution on a conflicting article.
- `GET /api/comparison-projects/:id/stats?conflictResolutionProvenance=current` computes the resolution comparisons (`llm-vs-conflict-resolution*`, `human-vs-conflict-resolution`, resolved-truth and resolution-answer stats) against current-context resolutions only. Default `all`. The response echoes `conflictResolutionProvenance` and `judgmentContextId`. A scope parameter was chosen over new comparison kinds because it is one predicate in the two resolution CTEs instead of new groups, labels and kind lists.
- Conflict resolution export is artifact version 2: optional `rows[].provenance = {reviewerDisplayName, contextId, setAt, origin}` and an optional root `judgmentContexts: [{id, context}]` holding each referenced context once (a per-row copy would repeat the same few kilobytes on every row). The importer accepts versions 1 and 2.
- PDF export puts `judgmentContextId` into the hidden `forska.import.comparisonProject` metadata. The reviewer name stays the only personal field; no reviewer id goes into the PDF.

## Compatibility

- Old rows read as `provenance: null`, reviewer unchanged.
- `prompt_id` / `answer_value` semantics are untouched; option validation, filters, stats and exports work unchanged unless the new filter or scope is used.
- Version 1 transfer artifacts and PDFs without the context id import as before, with NULL context.
- No new secondary indexes; the save path is still DELETE + INSERT with no extra read.

## Client follow-ups

The server contract is in `src/services/comparisonProjectsService.ts` (`ComparisonProjectConflictResolutionValue`, `ComparisonJudgmentContextSummary`, `fetchComparisonJudgmentContexts`, the optional `conflictResolutionProvenanceFilters` argument of the page/count fetchers, `fetchComparisonProjectStats(id, 'current')`) and `src/utils/comparisonProjectConflictResolutionFilter.ts` (`comparisonProjectConflictResolutionProvenanceFilters`, options, normalizer). The new resolution fields are optional in the client type until the optimistic update in `+compare-judgments/+$id/+index.tsx` fills them.

- Show reviewer name and set time under the resolution select.
- Badge "resolved under older prompts" when `provenanceMatchesCurrent === false`; tooltip with models, variants and prompt headings from one `fetchComparisonJudgmentContexts` call per page for its distinct context ids.
- Provenance filter control next to the conflict resolution filter, kept in the URL like the other filters.
- Stats toggle for current-context resolutions.
- Optimistic save: use the save response, which now returns the full resolution.

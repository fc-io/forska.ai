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
    {"kind": "llm", "promptId": "summary", "promptHeading": null, "modelId": "…", "modelName": "gpt-5.5",
     "contentKey": "1100m-screening_v1", "useTitle": true, "useAbstract": true, "useFulltext": false,
     "useFulltextNoImages": false, "useMetadata": true, "systemPromptVariant": "screening_v1", "sourceProjectId": "…",
     "criteria": [{"promptId": "…", "promptHeading": "Population", "criteriaDisposition": "include"}]}
  ]
}
```

- One entry per column the generation serves, exactly the generation config's required columns: prompt mode has one LLM column per prompt × model × content variant and one human column per prompt; summary mode has one LLM summary column per source project (or per model for the fallback group) × content variant and the human summary column.
- `humanJudgmentMode` is the effective serving mode (`summary` only when the project compares with humans in summary mode).
- Every LLM column carries its raw `contentKey` next to the flags and the variant, which come from the config, so nothing is decoded and no column is ever dropped.
- Summary LLM columns carry `criteria`: the criteria prompts that feed the column with their dispositions (a disposition changes the summary answer). A column whose criteria list is empty keeps `criteria: []`. Prompt-mode LLM columns have no `criteria`.
- Columns are sorted by `kind, promptId, modelId, contentKey, sourceProjectId`, criteria by `promptId, criteriaDisposition`; duplicates are removed.
- `id = sha256(canonical JSON without promptHeading and modelName)`, also inside `criteria`. The two names are display snapshots: `app.model.name` is rewritten by provider discovery, and a rename must not flag every resolution as resolved under older prompts. Prompt ids already pin the prompt text and heading. `context_json` keeps the names as first seen.

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

The context is derived from the generation's own config snapshot, the per-generation temp config tables (`comparisonProjectServingGenerationConfig.ts`) that the rebuild materializes once and builds every cell from. `comparisonProjectServingCellBuilder.ts` calls `recordComparisonJudgmentContextForGenerationConfig` (`comparisonJudgmentContextDerivation.ts`) right after it materializes that config, before any cell is written. The derivation reads the prompt, content-variant, model, source-project-column and summary-prompt-group config of that generation, joins prompt headings (`app.prompt`) and model names (`app.model`), upserts the context and writes the generation's mart row. A criteria edit while the build runs therefore cannot leak into the generation's context: the context always describes the generation's own cells. The cell mart is never scanned.

The promotion transaction does no provenance work: the per-generation row already exists and becomes visible when the generation is promoted. If the context write fails, the error is logged with the comparison project and generation, the build goes on, promotion succeeds, and the backfill fills the row later.

The backfill (`comparisonJudgmentContextBackfill.ts`) runs on the comparison serving maintenance worker (`comparisonProjectServingMaintenanceWorker.ts`) on ticks where no comparison project needs a rebuild, and is never on a request path. It covers generations that were active before the migration and generations whose write failed.

- Each call takes one non-archived active generation without a mart row: never-attempted ones first, then the least recently attempted.
- It computes the context from that generation's config on the maintenance background connection. That reuses the build's snapshot when the same process built it; otherwise the config is materialized again from the current tables. The backfill only runs when nothing is stale, so the current tables equal the active generation's config. Variant discovery stays in a temp table and is never persisted.
- It writes the row in a small transaction that re-checks the generation is still active.
- Failures are tracked per generation in the worker process: retries back off 1, 2, 4, 8 and 16 minutes, and give up after 5 attempts until the next restart.
- Each failure is logged as a warning naming the comparison project and the generation (`judgmentContextBackfillFailed`).

Until the row exists, saves record a NULL context (provenance unknown).

`getComparisonProjectServingStatus` reads `activeJudgmentContextId` in the same query as `activeGeneration`; `getComparisonProjectScope` exposes it as `scope.judgmentContextId`.

## API

- `ComparisonProjectConflictResolution` (rows from `POST /api/comparison-projects/:id/judgments`, and the response of `POST /api/comparison-projects/:id/conflict-resolution`) keeps `reviewerUserId` / `reviewerDisplayName` and adds:
  - `reviewer: {userId, displayName} | null`
  - `provenance: {contextId, generation, setAt, origin} | null` (null for rows with no provenance at all)
  - `provenanceMatchesCurrent: boolean | null`, `row.judgment_context_id === scope.judgmentContextId`, null when either side is unknown
  - `setAt: Date | null`, the row's `updated_at`, for every resolution including pre-feature rows (independent of `provenance`, which keeps its own `setAt`)
  - A context id with no local row (PDF imports, partial artifacts) is still returned in `provenance`; the lookup simply returns nothing for it.
- `GET /api/comparison-projects/:id` adds `judgmentContextId` and `judgmentContext` (summary of the active generation's context).
- `POST /api/comparison-projects/judgment-contexts` with `{ids: string[]}` (at most 100 ids, each a lowercase sha256 hex string, otherwise 422) returns summaries for the ids known locally: `{id, createdAt, context, promptIds, prompts: [{id, heading}], modelIds, models: [{id, name}], systemPromptVariants}`. `prompts` and `promptIds` include the criteria prompts of summary columns.
- Listing, count, CSV/PDF export and resolution export accept `conflictResolutionProvenanceFilter: ('current' | 'outdated' | 'unknown')[]` (string or array, comma-separated allowed). It applies only when conflict resolution is enabled and combines with the other filters by AND, values by OR:
  - `current`: `judgment_context_id = <active context>`
  - `outdated`: `judgment_context_id <> <active context>`
  - `unknown`: `judgment_context_id IS NULL` or no active context
  All three require a resolution on a conflicting article.
- `GET /api/comparison-projects/:id/stats?conflictResolutionProvenance=all|current` (default `all`). With `current` and an active context, the resolution set is restricted to resolutions whose context equals the active generation's:
  - An article whose resolution is outdated or unknown is removed from every resolution comparison: `llm-vs-conflict-resolution` (it does not fall back to the overruled human answer), `llm-vs-conflict-resolution-no-fallback`, `human-vs-conflict-resolution`, the resolution-answer stats and resolved-truth.
  - Articles that never had a resolution keep today's behaviour: the fallback kind uses the cell answer.
  - Comparisons without resolutions are unchanged.

  The response adds `conflictResolutionProvenanceScope: {requested: 'all' | 'current', applied: boolean, reason: 'no-active-context' | null}` and keeps `conflictResolutionProvenance` (the requested value) and `judgmentContextId`. With `current` and no active context yet, no provenance restriction is applied, the stats equal `all`, and the scope reads `{requested: 'current', applied: false, reason: 'no-active-context'}`. Otherwise `applied` is true. A scope parameter was chosen over new comparison kinds because it touches less code.
- Conflict resolution export is artifact version 2: optional `rows[].provenance = {reviewerDisplayName, contextId, setAt, origin}` and an optional root `judgmentContexts: [{id, context}]` holding each referenced context once (a per-row copy would repeat the same few kilobytes on every row). The importer accepts versions 1 and 2, rejects an artifact with a context above 64 KB (400), and trims imported reviewer names (file and PDF) to 200 characters.
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
- Fix round 1 additions, optional in the client type until the client uses them:
  - the top-level `setAt` on every resolution, for showing the set time on pre-feature rows too;
  - `conflictResolutionProvenanceScope` on stats: when `applied` is false (`reason: 'no-active-context'`), show that the current-prompts toggle had no effect;
  - `contentKey` and `criteria` on context columns (`criteriaDisposition` is no longer on columns).
- `outdated` also covers rows imported from another comparison project with a different context, so the label should not only say "older prompts".

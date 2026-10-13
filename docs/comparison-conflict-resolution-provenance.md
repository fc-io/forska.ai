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
- Reset is unchanged: the row is deleted. Comments live in their own table and are not touched (see Comments).
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
- Conflict resolution export carries provenance since artifact version 2 (the current version is 3, see Comments): optional `rows[].provenance = {reviewerDisplayName, contextId, setAt, origin}` and an optional root `judgmentContexts: [{id, context}]` holding each referenced context once (a per-row copy would repeat the same few kilobytes on every row). The importer accepts versions 1, 2 and 3, rejects an artifact with a context above 64 KB (400), and trims imported reviewer names (file and PDF) to 200 characters.
- PDF export puts `judgmentContextId` into the hidden `forska.import.comparisonProject` metadata. The reviewer name stays the only personal field; no reviewer id goes into the PDF.

## Compatibility

- Old rows read as `provenance: null`, reviewer unchanged.
- `prompt_id` / `answer_value` semantics are untouched; option validation, filters, stats and exports work unchanged unless the new filter or scope is used.
- Version 1 transfer artifacts and PDFs without the context id import as before, with NULL context.
- No new secondary indexes; the save path is still DELETE + INSERT with no extra read.

## Comments

A reviewer can leave a free-text comment on an article of a comparison project, for example what is unclear about a conflict or why it was resolved one way. The comment belongs to the article within the comparison project, not to a resolution: it can be written before any resolution exists, survives setting, changing and resetting the resolution, and stays editable after a rebuild makes the article stop being a conflict.

### Stored

`app.comparison_project_conflict_comment` (migration `src/db/duckdbMigrations/0264_comparisonConflictComment.sql`):

| column | meaning |
| --- | --- |
| `id` | primary key, a new UUID on every write |
| `comparison_project_id`, `article_id` | the article within the comparison project |
| `comment` | normalised text (see API), never empty, at most 4000 UTF-16 code units (an emoji counts 2; `comparisonProjectConflictResolutionCommentMaxLength` in `src/utils/comparisonProjectConflictResolutionComment.ts`), no control characters other than tab, newline and carriage return |
| `author_user_id`, `author_display_name` | who wrote it: the local user (`getOrCreateUserConfig`) with the name snapshotted at save time; both NULL for file imports, which carry no author; the PDF reviewer (`pdf-import:<uuid>` and the name from the PDF front page, or `Unnamed reviewer`) for PDF imports; a name without a user id is possible (comments moved from old imported resolutions) and is shown |
| `created_at` | first time a comment was written for the article (kept when the comment is edited) |
| `updated_at` | last save |

- One row per comparison project and article, kept by code like the resolution table (no UNIQUE, no secondary index): every write runs `DELETE … RETURNING created_at` for the article and then one `INSERT`. Readers take the newest row (`updated_at DESC, id DESC`) if duplicates ever exist.
- Removing a comment deletes the row. There is no empty or NULL comment row.
- Purging a comparison project deletes its comments with its resolutions.
- Migration 0264 creates the table, copies every non-empty `comment` from `app.comparison_project_conflict_resolution` (one per article, the latest `comment_updated_at` wins; author = the resolution's `reviewer_user_id` / `reviewer_display_name`; `created_at` and `updated_at` = `comment_updated_at`, falling back to the resolution's `updated_at`), and then drops the `comment` and `comment_updated_at` columns that migration 0262 had added. The resolution table has no indexes or dependent views since migration 0230, so `DROP COLUMN` is clean; `src/db/migrateDuckdb.comparisonConflictComment.test.ts` pins the moved rows, the dropped columns, a DELETE + INSERT round on both tables after a checkpoint, and a crash before the checkpoint followed by WAL replay, a rewrite and a reopen.
- Reverting to a build without migration 0264 (for example a build with only migration 0262) breaks the compare page listing, the resolution save and the export, because the columns it reads are gone. Take a DB snapshot before the first start on the new build to keep a revert path.

### API

- `POST /api/comparison-projects/:id/conflict-comment` with `{articleId: string, comment: string | null}` returns `{articleId, conflictComment}`.
  - The comment is normalised like imported comments (`getNormalizedComparisonProjectConflictComment`): control characters other than tab, newline and carriage return are removed, then surrounding whitespace is trimmed.
  - `null`, an empty or a whitespace-only comment deletes the row and returns `conflictComment: null`.
  - A comment that is empty only after removing control characters is a 400 and changes nothing, so it can neither be stored nor delete the existing comment. More than 4000 code units after normalising is a 400 too.
  - The project must allow conflict resolution (400 otherwise), and the article must be part of the comparison project: a row of the active serving generation, or of the scoped rows when no generation is active (400 otherwise). Neither a resolution nor a current conflict is required.
  - It schedules the same deferred checkpoint as a resolution save.
- Each judgment row (listing, CSV and PDF export rows) carries `conflictComment: {comment, updatedAt, author: {userId: string | null, displayName: string | null} | null} | null`. The comments of a page are loaded with one query keyed by `comparison_project_id` and `article_id IN (…)`, next to the resolution query. `author.displayName` falls back to `app.user_config.name` when no name was snapshotted; `author` is null only when neither a user id nor a name is stored.
- `ComparisonProjectConflictResolution` has no comment fields. The resolution save (`POST …/conflict-resolution`) and reset (`POST …/conflict-resolution/reset`) do not read or write comments and their responses are unchanged; the client keeps the row's `conflictComment` as is. The save path is still DELETE + INSERT with no extra read.
- Client parsing: the app's Eden client (`src/services/apiClient.ts`) parses successful JSON responses with `parseApiJsonResponse` (`src/services/utils/parseApiJsonResponse.ts`) instead of Eden's default date reviver. It revives only full ISO-8601 timestamps with a time zone (what `JSON.stringify(Date)` produces), and never values under free-text keys (keys ending in `comment`, `description`, `label`, `name`, `note`, `text` or `title`). A comment such as `2026-10-10` or `10/10/2026`, or an author or project named like a date, therefore stays a string, while `conflictComment.updatedAt` becomes a `Date`.

### Export and import

- Resolution export artifact version 3. Every row carries `comment: string | null`: the article's normalised comment, or `null` when the article has none. `null` (like a missing field) means "no comment to bring"; an import never reads it as "delete". An article with a comment but no resolution is exported as a comment-only row: `resolution: null`, `sourceResolutionId: null`, no `provenance`, and a non-empty `comment`. The export reads resolutions and comments of each article batch with a full outer join, so the export filters decide which articles appear; filters that need a resolution (for example the provenance filter) leave comment-only articles out.
- The importer accepts versions 1, 2 and 3. A row without a resolution is a 400 unless the artifact is version 3 and the row's comment is non-empty after normalising (a comment of only control characters is rejected).
- Comment-only rows are matched like other rows (article id, identifiers, id + title, title). Under `conflicting-only` a comment-only row whose target is not a current conflict is listed as skipped (`not-conflicting`) and is not counted in `importable`, but it still brings its comment (see the comment rules). They never count as `same-value` or `existing-target-resolution`, write no resolution, and appear in the preview with an empty `selectedResolution` (the UI shows "Comment only"). When a comment-only row and a resolution row land on the same target article, the resolution row is used for the resolution and its provenance. `importable` counts imported rows, comment-only rows included; `inserted` counts resolution rows written.
- Comment rules (`commentSources` of the import plan, `getComparisonProjectConflictResolutionImportCommentChanges`):
  - An import only ever adds or replaces a comment. It never removes one, in any mode.
  - The source comment is normalised like the API (control characters removed, trimmed, cut to 4000 code units without splitting a surrogate pair). `null`, a missing field, or text that is empty after normalising brings nothing. v1 files and rows without the field therefore never touch comments, and neither does PDF "clear undecided" (it deletes resolutions only).
  - The import mode governs resolutions only. Comments are brought for every source row matched to exactly one target article, in both modes, with the same matching as "All matched articles" (so the ID + title tie-breaker between targets that share a DOI/PMID/arXiv id also applies to non-conflicting targets): imported rows, comment-only rows, rows skipped because the target already has a resolution (`same-value`, or `existing-target-resolution` under `skip-existing`), rows skipped as `not-conflicting` under `conflicting-only` (resolution rows and comment-only rows alike), plus rows later skipped for an invalid or conflicting value. Unmatched, ambiguous and unsupported-mode rows bring nothing. Until 2026-10-13 `not-conflicting` rows brought nothing; this applies to JSON file imports and create-from-project imports as well as PDF imports.
  - When several source rows match one target article, the first of them in source order with non-empty comment text is used, independent of which row supplies the resolution.
  - `skip-existing` adds the source comment only where the target article has no comment. `overwrite-different` also replaces a target comment whose text differs; identical text is left alone.
  - A replaced comment keeps its `created_at`; `updated_at` is the import time. File imports store no author; PDF imports store the PDF reviewer (see PDF below); create-from-project imports read the source projects' resolutions and comments with a full outer join, so comment-only articles are copied too, with the source comment's author (into the new project, so every comment is added); with `conflicting-only` the comments of articles that are not conflicts in the new project are copied as well.
- Preview: the analyze summary has `commentsAdded`, `commentsReplaced` and `commentsKept` (a different target comment that `skip-existing` keeps), computed against the target's current comments. Every listed row (importable or skipped) whose comment is used carries `commentChange: 'add' | 'replace' | 'keep'` (the UI shows "Adds comment", "Replaces comment" or "Keeps target comment"). The analyze and commit endpoints share one computation; the commit repeats it inside its transaction. When no row is importable but comments will be added or replaced (for example only from rows skipped as `not-conflicting`), the importable list says "No resolutions will be imported. N comments will still be added or replaced …" instead of "No rows will be imported.", and the skipped list says that rows marked "Adds comment" or "Replaces comment" still write their comment. The overwrite options say that comments are only added or replaced, never removed; they are offered when an existing resolution or comment would be kept or replaced, and the commit button is enabled when only comments would change.
- Judgment CSV export: a `Conflict comment` column right after `Conflict Handling` (the resolution label), filled from the article's comment whether or not it has a resolution (CSV quoting keeps commas, quotes and line breaks).
- PDF export (`POST …/export` with `format: 'pdf'`): the "Conflict resolution" panel appears when conflict resolution is allowed and the article has a conflict, a resolution or a comment. The radios appear only for a conflict or a resolution (an article with only a comment shows "Current resolution: Not set (no current conflict)" and the comment field). Every panel has a multi-line text field `comparison.<projectId>.article.<articleId>.comment` labelled "Comment (optional)", four lines high, `/MaxLen 4000`, prefilled with the article's normalised comment. The hidden per-article metadata (`…article.<articleId>.metadata`) carries `exportedComment`: that same text, or `null`. Printable ASCII values are written as literal strings; any other value (non-ASCII, line breaks) as a UTF-16BE hex string with BOM, for `/V` and `/DV`. The front page asks the reviewer to fill in or change the radio buttons and comments and says the reviewer name is attached to imported resolutions and comments.
- PDF import (`…/conflict-resolutions/import/pdf/analyze` and `/commit`):
  - The parser decodes what viewers write into text fields (`/T` and `/V`): literal strings (octal escapes, line continuations, nested parentheses), hex strings (whitespace allowed), then UTF-16BE with BOM `FE FF`, UTF-16LE with BOM `FF FE`, UTF-8 with BOM `EF BB BF`, otherwise PDFDocEncoding (PDF 32000-1 Annex D.2): Latin-1 except 0x18-0x1F (˘ ˇ ˆ ˙ ˝ ˛ ˚ ˜), 0x80-0x9E (• † ‡ … — – ƒ ⁄ ‹ › − ‰ „ “ ” ‘ ’ ‚ ™ ﬁ ﬂ Ł Œ Š Ÿ Ž ı ł œ š ž) and 0xA0 (€); the undefined bytes 0x7F, 0x9F and 0xAD are dropped. This matters because Chrome (PDFium) and pypdf write PDFDocEncoding whenever every character fits, for example for curly quotes, dashes, € or Ł. This also applies to the reviewer name and radio values. CR and CRLF become LF.
  - The file is read with a top-level tokenizer: strings and dictionaries are read as tokens (so `>> stream` inside a string starts nothing), stream data after a dictionary is skipped by its direct `/Length` when that lands on `endstream`, otherwise up to the next `endstream`. Only top-level dictionary keys are read, and the last occurrence of a field name wins (incremental updates). An indirect `/V N 0 R` is resolved when the last definition of object `N` in the file is a plain string object; when a later update redefines `N` as a dictionary, stream or anything else, or the object is missing (for example inside an object stream), the value is ignored with the warning "PDF field … has an indirect value that is not a plain string object and was ignored." When nothing else in the PDF counts as a change, that warning is appended to the 400 message. PDFs re-saved with compressed object streams are still not readable.
  - A comment field is touched when its normalised value (as above, plus the 4000 cut) differs from the normalised `exportedComment` of the article metadata; both sides are compared after CR/CRLF → LF and Unicode NFC, so a viewer that re-encodes an untouched value (UTF-16 to PDFDocEncoding, CRLF to CR, composed vs decomposed characters) does not make it count as changed (`null` equals an empty field; a field without metadata counts as exported empty). The imported text itself is not NFC-normalised. Untouched prefilled comments bring nothing, so re-importing an exported PDF never copies the comments it already showed. A touched field that is empty (the reviewer cleared it) brings nothing either: imports never remove.
  - A touched comment rides on the article's filled radio as the row's `comment`. When the radio is unset, `Off` or Undecided, the article becomes a comment-only row (`resolution: null`, `sourceResolutionId: <projectId>:<articleId>:pdf-comment`). An Undecided radio still feeds the "clear undecided" path, which never touches comments. A PDF with neither filled radios nor touched comments is a 400 ("no filled conflict-resolution radio fields and no changed comments").
  - From there the rules above apply unchanged (`skip-existing` adds only where the target has no comment, `overwrite-different` also replaces different text, identical text is a no-op, nothing is removed). The analyze endpoint reads the target comments like the JSON analyze, so the preview shows `commentsAdded` / `commentsReplaced` / `commentsKept` and the row markers; `source.rowCount` counts articles with a decided radio, an Undecided radio or a changed comment (an Undecided radio plus a changed comment on the same article counts once).
  - Written comments get the PDF reviewer as author (`author_user_id` = the `pdf-import:<uuid>` user row, `author_display_name` = its name). The reviewer row is created when the import writes a resolution or a comment; a commit that changes nothing creates none.
  - A PDF without hidden row metadata (radios or comment fields only) can still be imported into the same comparison project, matched by the article id in the field name; comment-only rows count for this check like resolution rows.
  - The import page needs nothing PDF-specific for comments (the PDF analyze result has the JSON shape). Both Undecided options say that changed comments on Undecided articles are still imported; "Set to not set" also says that comments are never removed. The "Only current conflicts" option (import page and create-from-project) says that comments are imported (copied) for every matched article.

### UI

On the compare page the conflict handling cell has a speech-bubble icon on every conflicting row: next to the select, next to the read-only resolution label when no options are available, and next to "No options available" when there is neither. A row that has a comment but no current conflict and no resolution shows the icon next to "No current conflict". The icon is filled and blue when a comment exists. Its tooltip shows the comment and "Comment by <name>, <time>" ("Comment, <time>" when the author is unknown, for example after a file import), otherwise `Add comment`. It is never disabled for lack of a resolution. Clicking it opens a popover (`src/components/ui/popover.tsx`, Kobalte) with a textarea (focused, 4000 character limit with a counter), `Discard`, `Remove` and `Save`. Enter adds a new line, Cmd/Ctrl+Enter saves (not while an IME composes).

- Unsaved text is kept per article while the table is mounted: Esc or an outside click closes the editor and keeps the draft, reopening shows it, and the icon gets an amber dot plus "Unsaved draft" in its tooltip until the text is saved or `Discard` drops it. Saving text equal to the saved comment just closes.
- A pending row disables the icon and the editor. A failed save rolls the optimistic `conflictComment` back, shows the page error and keeps the editor open with the draft. A comment-only row without a conflict stays rendered (with its editor) while its `Remove` is pending, so a failed removal leaves the editor open; after a successful removal the row shows "No conflict".
- The page updates the row's `conflictComment` optimistically (keeping the previous author until the response arrives) and replaces it with the response; it does not refetch any query and changes no query key. Resolution saves and resets do not change `conflictComment`.
- Component: `comparisonProjectJudgmentsTable/comparisonProjectConflictResolutionComment.tsx`; tooltip and label text in `comparisonProjectConflictResolutionComment/comparisonProjectConflictResolutionCommentText.ts`; optimistic helper `getCompareProjectOptimisticConflictComment` in `+compare-judgments/+$id/+index/compareProjectOptimisticConflictResolution.ts`.

## Client

The client contract lives in `src/services/comparisonProjectsService.ts` (`ComparisonProjectConflictResolutionValue`, `ComparisonJudgmentContextSummary`, `fetchComparisonJudgmentContexts`, the `conflictResolutionProvenanceFilters` argument of the page/count fetchers, `fetchComparisonProjectStats(id, 'current')`) and `src/utils/comparisonProjectConflictResolutionFilter.ts` (`comparisonProjectConflictResolutionProvenanceFilters`, options, normalizer).

What the compare page does with it:

- The resolution cell shows the reviewer name and the set time (`setAt`) under the select; rows with a reviewer but no provenance show the name with a "(before tracking)" marker, since old file imports may name the importer. Imported rows show "imported <time>".
- An "Older prompts" badge appears when `provenanceMatchesCurrent === false`, nothing for `true` or `null`. The tooltip lists models, system prompt variants, prompt headings, criteria and content settings, marking entries the current context no longer uses and entries added since. Context summaries come from one `fetchComparisonJudgmentContexts` call per page for the page's distinct context ids, minus the active context, which the project detail already carries. The badge label covers imports from another comparison project with a different context as well.
- The "Resolution prompts" filter (Current prompts / Older prompts / Unknown) sits next to the conflict resolution filter, is kept in the URL, and flows into the page and count queries, CSV/PDF export and resolution export.
- The optimistic save uses the save response, which returns the full resolution.
- When the active generation or active context id changes, the page, count, stats and context-lookup queries are invalidated so badges and filter results refresh after a rebuild.
- Project Stats has the checkbox "Only resolutions made under the current prompts". When the response says `conflictResolutionProvenanceScope.applied === false`, a note explains that current prompts are not known for this generation yet and all resolutions are shown.
- The export page details card shows the active context summary.

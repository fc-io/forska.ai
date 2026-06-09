# Flexible System Prompt Plan

## Goal

Store judge system prompts in DuckDB with explicit versioning and make prompt
changes safe for judgment reuse, project cloning, previews, exports, and reruns.

## Current Snapshot

| Area | Current behavior |
|---|---|
| User question prompts | Immutable rows in `app.prompt`, deduped by `content_hash`, linked through `app.project_prompt` |
| Prompt edits | `getOrCreateImmutablePromptTx` creates or reuses a new immutable prompt row and project links are updated |
| Project clone | Clone copies `app.project_prompt` links to the same `prompt_id` values |
| System prompts | Hard-coded constants in `src/agent/judge/judgeSinglePromptSystemPrompt*.ts` and `judgeSinglePromptEvidenceSystemPrompt*.ts` |
| Prompt selection | `src/agent/judge/judgePromptSelection.ts` picks a variant based on provider and article type |
| Execution snapshot | `app.judgment_execution_snapshot` stores article, project, model, content settings, and question prompt payload, but not the system prompt |
| Judgment identity | Reuse and uniqueness do not include any system-prompt identifier |

## Problems To Solve

1. A system prompt change currently does not change judgment identity.
2. Historical judgments cannot explain which system prompt produced them.
3. Execution snapshots are not fully reproducible because they do not pin the system prompt text.
4. Project clones cannot explicitly inherit or diverge system prompt versions.
5. Provider-specific and article-type-specific prompt variants can drift independently in code.
6. Export and import cannot preserve system prompt provenance.

## Fixed Decisions

| Item | Decision |
|---|---|
| Mutability | System prompts are immutable once created |
| Versioning unit | Version at the system-prompt-set level, not per single string |
| Project link | Each project references one immutable system-prompt set |
| Selection logic | Keep selection logic in code, but source prompt text from DB |
| Judgment identity | Include system-prompt-set identity in judgment reuse and uniqueness |
| Claim reproducibility | Execution snapshots store the resolved system prompt inputs used for execution |
| Clone behavior | Clones copy the same system-prompt-set id until explicitly changed |
| Fallbacks | Do not silently fall back to code constants after cutover |

## Proposed Data Model

### 1. Add Immutable System Prompt Sets

Create `app.system_prompt_set`.

| Column | Purpose |
|---|---|
| `id` | Primary key |
| `name` | Human label, for example `default-v1` |
| `description` | Optional admin note |
| `content_hash` | Canonical hash of the full prompt-set JSON |
| `prompts_json` | All system prompt variants in one immutable payload |
| `archived` | Hide old sets without deleting them |
| `created_at`, `updated_at` | Audit fields |

Recommended `prompts_json` shape:

```json
{
  "final": {
    "default": "...",
    "anthropic": "...",
    "patient": "...",
    "structuredImport": "..."
  },
  "evidence": {
    "default": "...",
    "anthropic": "...",
    "patient": "...",
    "structuredImport": "..."
  },
  "selectionVersion": 1
}
```

This keeps the final and evidence prompts versioned together so they cannot drift apart accidentally.

### 2. Link Projects To A System Prompt Set

Add `project.system_prompt_set_id` as a non-null foreign key.

Behavior:

- New projects default to the seeded default set.
- Editing a project's system prompt means assigning a different immutable set id.
- Cloning a project copies `system_prompt_set_id` unchanged.

### 3. Persist System Prompt Identity On Judgments

Add `judgment.system_prompt_set_id` as a non-null foreign key.

Also add it to the effective judgment uniqueness and reuse conditions alongside:

- `article_id`
- `prompt_id`
- `model_id`
- `use_title`
- `use_abstract`
- `use_fulltext`
- `use_fulltext_no_images`

Without this, changing the system prompt would incorrectly reuse old judgments.

### 4. Persist System Prompt Identity In Execution Snapshots

Add system-prompt-set fields to `app.judgment_execution_snapshot` and to the stored payload.

Minimum additions:

- `system_prompt_set_id`
- `system_prompt_set_hash`

Payload additions:

- selected `systemPrompt`
- selected `evidenceSystemPrompt`
- system prompt set metadata

This makes claim execution reproducible even if the project later changes to a different prompt set.

## Runtime Changes

### 1. Replace Hard-Coded Prompt Sources

Keep `judgePromptSelection.ts` as the selector, but resolve text from the project's `system_prompt_set.prompts_json` instead of imported constants.

The selector should still choose among the same variants:

- `final.default`
- `final.anthropic`
- `final.patient`
- `final.structuredImport`
- `evidence.default`
- `evidence.anthropic`
- `evidence.patient`
- `evidence.structuredImport`

### 2. Snapshot Resolved Prompt Inputs

When creating execution snapshots, resolve and persist the exact final and evidence system prompts that the worker will use.

This is more reliable than storing only the set id because:

- it protects queued claims from later project edits
- it makes debugging exact failures much easier
- it preserves benchmark integrity

### 3. Update Preview APIs

`projectsRoutesGetPromptPreview.ts` should return:

- the resolved system prompt text
- the system prompt set id
- the system prompt set hash or label

This lets users verify what will actually run.

### 4. Treat System Prompt Changes As Judgment-Affecting

Changing `system_prompt_set_id` must be treated like changing model or prompt semantics.

Required behavior:

- future judgment lookup filters by the new set id
- reruns create new judgments under the new set id
- old judgments remain historically valid for the old set id
- serving queries for a project must filter by the project's current set id

Do not reinterpret old rows as if they were produced by the new system prompt.

## Clone And Edit Rules

### Clone

- Copy `project.system_prompt_set_id` directly.
- Do not deep-copy the set because it is immutable.
- The clone initially shares the same question prompts, model, and system prompt set as the source project.

### Edit

- Editing system prompt text never updates a row in place.
- Admin tooling creates a new `system_prompt_set` row.
- Project edit swaps `system_prompt_set_id` to the new row.
- Existing cloned projects keep their old set ids unless explicitly changed.

This mirrors the repo's existing immutable question-prompt behavior.

## Migration Strategy

### 1. Seed A Default Set

Add a DuckDB migration that:

- creates `app.system_prompt_set`
- inserts one seeded row from the current hard-coded prompt constants
- adds `project.system_prompt_set_id`
- backfills existing projects to that seeded id

### 2. Backfill Historical Judgments Carefully

Current rows have no stored system-prompt provenance, so perfect historical reconstruction is impossible.

Recommended cutover:

1. Seed one explicit legacy set such as `legacy-hardcoded-pre-db-v1`.
2. Backfill existing `judgment` and `judgment_execution_snapshot` rows to that legacy set id.
3. Use new set ids only for post-cutover work.
4. Rerun active projects when strict comparability matters.

This is safer than pretending old rows were produced by the new DB-managed prompt set.

### 3. Tighten Reuse Queries

Any query that selects or reuses judgments in project context must include the system prompt set.

This includes:

- judgment creation and reuse
- rebuild and mart-serving queries
- project detail queries
- export assembly
- transfer import remapping

## Admin Workflow

### Create Or Revise A System Prompt Set

1. Load an existing set.
2. Duplicate it into a draft.
3. Edit the JSON variants.
4. Save as a new immutable set.
5. Assign the new set to selected projects.

### Reliability Rules

- no in-place edits
- no silent upgrades of projects to a newer default
- no fallback to code constants when a project points to a missing set
- fail loudly if referenced system-prompt data is missing

## Export And Import

Exports should include all referenced `system_prompt_set` rows and preserve their hashes.

Imports should:

- reuse an existing row when `content_hash` matches
- otherwise insert a new immutable row
- remap project and judgment references to the imported or reused set id

## Tests

| Test | Requirement |
|---|---|
| Seeded default | Migration creates the default immutable set |
| Project backfill | Existing projects receive a non-null `system_prompt_set_id` |
| Clone | Cloned projects keep the same `system_prompt_set_id` |
| Edit detaches | Editing a system prompt creates a new set and updates only the edited project |
| Snapshot | Execution snapshot stores the resolved system prompt inputs |
| Reuse isolation | Judgment reuse does not cross system-prompt-set boundaries |
| Preview | Prompt preview returns the resolved system prompt and set metadata |
| Export/import | Transfers preserve system-prompt-set identity by hash |

## Quality Gates

- `bun run db:mig`
- `bun test src/server/services/immutablePromptService.test.ts`
- `bun test src/server/services/judgmentExecutionSnapshotService.test.ts`
- `bun test src/server/routes/ProjectsRoutes.test.ts`
- `bun test src/agent/judge/judgePromptSelection.test.ts`
- `bun run lint`

## Success Criteria

- System prompt changes produce distinct judgment identities.
- Project clones are stable and do not drift when the source project later changes prompts.
- Execution snapshots fully explain which system prompt text was used.
- Preview, serving, export, and import all agree on the same system prompt set.
- Old judgments remain attributable to their original prompt semantics instead of being silently reinterpreted.

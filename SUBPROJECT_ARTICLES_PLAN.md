# Global Immutable Prompts — Implementation Plan

Goal: Allow the concept of "subprojects" where we can take selected articles associated with a project and make them available in a new project. The articles can come from multiple projects and end up in the same new "subproject". To benefit from already ran promts and completed judgments we also we need to make prior prompts and judgments reusable for the subproject. We do this be making the prompts global and immutable. For now we also keep the existing prompt columns for backward compatibility during rollout.

### Guiding principles (updated)
- Reuse the existing `prompts` table as the single canonical prompt entity; no parallel "subproject prompt" type will be created.
- Prompts are global across all owners (no tenant scoping initially).
- Make prompts global by layering association tables (`project_prompts`, `project_articles`) and migrating every read/write path to those joins.
- Per‑project metadata lives only in `project_prompts` (order, archived). Global, immutable metadata lives on `prompts` (original_text, transformed_text, prompt_heading, type).
- Include `prompt_heading` and `type` in the prompt content hash so identical text with different metadata does not collide.

## Phase 1 — Schema
- [x] Create `project_articles(project_id, article_id)` with:
  - [x] FK to `projects.id`, FK to `articles.id`
  - [x] Unique `(project_id, article_id)`
  - [x] Indexes on `project_id` and `article_id`
- [x] Create `project_prompts(id, project_id FK, prompt_id FK, order, archived)`
  - [x] Unique `(project_id, prompt_id)`
  - [x] Indexes on `project_id`, `prompt_id`, and `(project_id, order)`
- [x] Add `prompts.content_hash TEXT` (nullable initially)
- [x] Add non‑unique index on `prompts.content_hash`
- [x] Add DB trigger to prevent UPDATE of `prompts.original_text`, `prompts.transformed_text`, `prompts.prompt_heading`, and `prompts.type` (immutability)
- [x] Change FK delete behavior for `judgments.prompt_id` and `judgments_human.prompt_id` to `ON DELETE RESTRICT` (from `CASCADE`) to prevent cross‑project data loss when prompts are global

## Phase 2 — Data Backfill
- [x] Backfill `content_hash = md5(normalize(original_text) || '|' || normalize(coalesce(transformed_text,'')) || '|' || normalize(coalesce(prompt_heading,'')) || '|' || normalize(coalesce(type,'')))`
- [x] Populate `project_prompts` from existing `prompts` using legacy fields:
  - [x] Insert `(project_id, prompt_id, order, archived)`
  - [x] Ensure no duplicates per `(project_id, prompt_id)`
- [x] Validation queries:
  - [x] List duplicate prompts by `content_hash` and count references in `judgments` and `judgments_human`

## Phase 3 — Application Read Path
- [x] Update API to fetch a project’s prompts via `project_prompts` join (not `prompts.project_id`)
- [ ] Update UI to manage order/archival via `project_prompts`
- [ ] Audit every existing prompt reader (API routes, Solid stores, cron jobs) and switch them to the association join to avoid any accidental divergence.
- [ ] Project article view: surface “available judgments” for an article from any project using the same `prompt_id` (include both LLM and Human judgments; do not filter by model)
- [x] On adding an article to a project, auto-link project to prompts that already have judgments for that article

## Phase 4 — Write Path (new prompts)
- [x] Implement upsert-by-hash when creating prompts:
  - [x] Compute `content_hash` (normalize inputs)
  - [x] If `prompts.content_hash` exists, reuse existing `prompt_id`; else insert new prompt row
  - [x] Insert `project_prompts` row for current project with per-project metadata
- [x] Block app-level edits of prompt text and metadata (prompt_heading, type) to mirror DB immutability. Existing edit flows may fail — acceptable.
- [x] Block app-level edits of prompt text and metadata (prompt_heading, type) to mirror DB immutability. Enforced at API: association edits reject metadata changes; creation sets metadata on prompts only.
- [x] Update the current prompt creation/edit flows (API + UI) to call the shared upsert-by-hash service and update associations instead of editing prompt rows.

## Phase 5 — Dedup + Consistency (optional now; enforce later)
- [ ] Admin tooling to review duplicates (same `content_hash`) and choose canonical `prompt_id`
- [ ] Data migration to remap `judgments.prompt_id` and `judgments_human.prompt_id` to canonical IDs
- [ ] Delete redundant prompt rows after remap
- [ ] Enforce unique index on `prompts.content_hash` once clean
- [x] Legacy prompt columns removed; no dual-write

## Phase 6 — Project Articles UX
- [x] Server endpoints to manage `project_articles` membership (add/remove)
- [ ] Client UI to curate articles for a project
- [x] On association, auto‑link prompts with prior judgments for that article

## Phase 7 — Clean‑up
- [x] Legacy prompt columns dropped (drop `prompts.project_id`, `prompts.order`, `prompts.archived`; keep `prompts.prompt_heading` and `prompts.type` as global immutable metadata) — Code/schema now read metadata from `prompts`; `project_prompts` no longer has these columns.
- [ ] Ensure remaining callers are using joins only
  - [ ] Refactor HumanAssessment overview routes to use `project_prompts` association (replace `prompts.project_id` usage):
    - src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothProjects.ts:35–49
    - src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothUsers.ts:43–57

## Migrations and Backfill (Drizzle)
- [x] Write Drizzle migrations for:
  - [x] `project_articles`
  - [x] `project_prompts`
  - [x] `prompts.content_hash` + index
- [x] Immutability triggers on `prompts` (text + metadata)
- [x] Alter FKs: drop and recreate `judgments.prompt_id` and `judgments_human.prompt_id` constraints with `ON DELETE RESTRICT`
- [x] Generate/apply: `bun run db:gen` → `bun run db:mig` (re-baseline)
  - [x] Neutralized generated migration `0021_giant_nextwave.sql` with a baseline no-op to align Drizzle snapshots with current DB.
  - [x] Applied migrations to advance journal without changing DB state.
  - [x] Renamed earlier `0021_prompt_hash_includes_metadata.sql` to `0022_prompt_hash_includes_metadata.sql` and applied, keeping numbering sequential; script is idempotent.
- [x] Backfill scripts:
  - [x] Compute and set `content_hash` (hash includes text + metadata) — function updated and backfilled via migration.
  - [x] Populate `project_prompts` from legacy prompt rows (order, archived only)

## Quality Gates
- [ ] Lint and tests: `bun run lint` and `bun test`
- [ ] Smoke tests:
  - [ ] Read prompts via `project_prompts` path
  - [ ] Upsert‑by‑hash behavior reuses existing prompt
  - [ ] “Available judgments” appear cross‑project for shared prompt/article
  - [ ] Attempting to delete a prompt referenced by any `judgments` or `judgments_human` row fails due to `RESTRICT`

## Notes
- Prompts become global and immutable; per‑project mutables live in `project_prompts`.
- Judgments continue to reference `prompt_id`; reuse emerges naturally when multiple projects associate the same prompt.
- Legacy prompt columns removed immediately; associations provide per-project metadata.

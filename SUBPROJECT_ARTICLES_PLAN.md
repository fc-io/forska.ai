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
- [x] Update UI to manage order/archival via `project_prompts`
- [x] Audit every existing prompt reader (API routes, Solid stores, cron jobs) and switch them to the association join to avoid any accidental divergence.
- [x] Project article view: surface “available judgments” for an article from any project using the same `prompt_id` (include both LLM and Human judgments; do not filter by model)
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
- [x] Admin tooling to review duplicates (same `content_hash`) and choose canonical `prompt_id`
- [x] Data migration to remap `judgments.prompt_id` and `judgments_human.prompt_id` to canonical IDs (implemented as admin route transaction)
- [x] Delete redundant prompt rows after remap
- [x] Enforce unique index on `prompts.content_hash` once clean (schema updated; DB migration still required)
- [x] Legacy prompt columns removed; no dual-write

## Phase 6 — Imported Articles UX
- [x] Server endpoints to manage `project_articles` membership (add/remove)
- [x] Client UI to curate articles for a project
- [x] On association, auto‑link prompts with prior judgments for that article

### Phase 6.2 — Read path & UI label

- [x] Read endpoint: `GET /api/projects/:id/articles` returns `{ id, articleTitle }` for rows linked via `project_articles`.
- [x] Project Details page renders an “Imported Articles” table (TanStack Table), listing article ID and Title.
- [x] UI label uses “Imported Articles” (renamed from “Curated Articles”).

### Phase 6.1 — Membership write path (implemented)

- Shared service for consistent writes and prompt auto‑linking:
  - Location: `src/server/services/insertArticlesIntoProject.ts`
  - Responsibilities:
    - Deduplicate and validate article IDs against `articles.id` (ignore unknown IDs).
    - Upsert associations into `project_articles` with `ON CONFLICT DO NOTHING` (idempotent, concurrency‑safe).
    - Auto‑link prompts that already have judgments (LLM or Human) for the added articles into `project_prompts` (default `archived: false`, sequential `order`).
    - Chunk inserts (default 1000) for safety with large batches.
    - Returns a summary object: `{ projectId, totalProvided, totalValid, invalidIds, existingAssociations, insertedCount, linkedPrompts }`.

- Routes wired to the service:
  - Add by filter (used by “Select all matching” in reviews):
    - `POST /api/projects/add_articles_by_filter`
    - Input: `{ targetProjectId, sourceProjectId, listType: 'llm'|'human'|'both'|'unassessed', prompts?, from?, to?, search? }`
    - Behavior: resolves article IDs from the source project using existing selection logic, then calls the shared service to write membership + auto‑link prompts. Returns selection and write summary.
  - Add by explicit IDs (used for page‑level selections):
    - `POST /api/projects/add_artilces_by_ids` (typo preserved for backward compatibility)
    - Input: `{ targetProjectId, sourceProjectId, articleIds: string[] | string }`
    - Behavior: writes membership + auto‑links prompts via the shared service. Returns write summary.
  - Existing route refactor (single canonical write path):
    - `POST /api/projects/:id/articles` now delegates to `insertArticlesIntoProject(...)` to ensure identical behavior across all add flows.

- Notes & guarantees:
  - No schema changes required; aligns with `project_articles` + `project_prompts` model.
  - Idempotent writes via unique `(project_id, article_id)` and `ON CONFLICT DO NOTHING`.
  - Prompt auto‑linking is also idempotent via unique `(project_id, prompt_id)`.
  - Sequential `order` is assigned during auto‑link; callers may re‑order later in UI.
  - Large selections are chunked to avoid parameter/packet limits.

### Testing & Quality Gates (server)

- Manual smoke (suggested):
  - POST `/api/projects/add_articles_by_filter` with a real filter → verify rows in `project_articles` and prompt links in `project_prompts`.
  - POST `/api/projects/add_artilces_by_ids` with known article IDs → verify `insertedCount` and `linkedPrompts` in response and DB rows.
  - POST `/api/projects/:id/articles` → confirm identical behavior.

- Commands (run locally):
  - `bun run lint`
  - `bun test`

### UI Integration

- Reviews bulk add menu calls:
  - “Select all matching” → `POST /api/projects/add_articles_by_filter`
  - “Selected rows” → `POST /api/projects/add_artilces_by_ids`
  - File references: `src/components/main/reviews/reviewsPaginationControls.tsx`

## Phase 7 — Clean‑up
- [x] Legacy prompt columns dropped (drop `prompts.project_id`, `prompts.order`, `prompts.archived`; keep `prompts.prompt_heading` and `prompts.type` as global immutable metadata) — Code/schema now read metadata from `prompts`; `project_prompts` no longer has these columns.
- [x] Ensure remaining callers are using joins only
  - [x] Refactor HumanAssessment overview routes to use `project_prompts` association (replace `prompts.project_id` usage):
    - src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothProjects.ts:35–49
    - src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothUsers.ts:43–57
- [x] Remove temporary admin duplicates UI/routes after canonicalization; rely on unique index to prevent recurrence

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
- [ ] Lint and tests: `bun run lint` and `bun test` (tests pass; lint shows unrelated pre-existing issues)
- [ ] Smoke tests:
  - [ ] Read prompts via `project_prompts` path
  - [ ] Upsert‑by‑hash behavior reuses existing prompt
  - [ ] “Available judgments” appear cross‑project for shared prompt/article
  - [ ] Attempting to delete a prompt referenced by any `judgments` or `judgments_human` row fails due to `RESTRICT`

## Notes
- Prompts become global and immutable; per‑project mutables live in `project_prompts`.
- Judgments continue to reference `prompt_id`; reuse emerges naturally when multiple projects associate the same prompt.
- Legacy prompt columns removed immediately; associations provide per-project metadata.

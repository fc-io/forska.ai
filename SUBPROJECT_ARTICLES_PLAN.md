# Global Immutable Prompts — Implementation Plan

Goal: Allow the concept of "subprojects" where we can take selected articles associated with a project and make them available in a new project. The articles can come from multiple projects and end up in the same new "subproject". To benefit from already ran promts and completed judgments we also we need to make prior prompts and judgments reusable for the subproject. We do this be making the prompts global and immutable. For now we also keep the existing prompt columns for backward compatibility during rollout.

### Guiding principles (updated)
- Reuse the existing `prompts` table as the single canonical prompt entity; no parallel "subproject prompt" type will be created.
- Make prompts global by layering association tables (`project_prompts`, `project_articles`) and migrating every read/write path to those joins.
- Keep legacy prompt columns only for compatibility until all callers are moved; block UI/server code from defining any divergent prompt models.

## Phase 1 — Schema (non‑breaking)
- [ ] Create `project_articles(project_id, article_id)` with:
  - [ ] FK to `projects.id`, FK to `articles.id`
  - [ ] Unique `(project_id, article_id)`
  - [ ] Indexes on `project_id` and `article_id`
- [ ] Create `project_prompts(id, project_id FK, prompt_id FK, order, prompt_heading, archived, type)` with:
  - [ ] Unique `(project_id, prompt_id)`
  - [ ] Indexes on `project_id`, `prompt_id`
- [ ] Add `prompts.content_hash TEXT` (nullable initially)
- [ ] Add non‑unique index on `prompts.content_hash`
- [ ] Add DB trigger to prevent UPDATE of `prompts.original_text` and `prompts.transformed_text` (immutability)
- [ ] Keep legacy columns on `prompts` (project_id, order, prompt_heading, archived, type) for backward compatibility

## Phase 2 — Data Backfill (safe)
- [ ] Backfill `content_hash = md5(normalize(original_text) || '|' || normalize(coalesce(transformed_text,'')))`
- [ ] Populate `project_prompts` from existing `prompts` using legacy fields:
  - [ ] Insert `(project_id, prompt_id, order, prompt_heading, archived, type)`
  - [ ] Ensure no duplicates per `(project_id, prompt_id)`
- [ ] Validation queries:
  - [ ] List duplicate prompts by `content_hash` and count references in `judgments` and `judgments_human`

## Phase 3 — Application Read Path
- [ ] Update API to fetch a project’s prompts via `project_prompts` join (not `prompts.project_id`)
- [ ] Update UI to manage order/archival via `project_prompts`
- [ ] Audit every existing prompt reader (API routes, Solid stores, cron jobs) and switch them to the association join to avoid any accidental divergence.
- [ ] Project article view: surface “available judgments” for an article from any project using the same `prompt_id`
- [ ] On adding an article to a project, auto-link project to prompts that already have judgments for that article

## Phase 4 — Write Path (new prompts)
- [ ] Implement upsert-by-hash when creating prompts:
  - [ ] Compute `content_hash` (normalize inputs)
  - [ ] If `prompts.content_hash` exists, reuse existing `prompt_id`; else insert new prompt row
  - [ ] Insert `project_prompts` row for current project with per-project metadata
- [ ] Block app-level edits of prompt text (mirror DB immutability)
- [ ] Update the current prompt creation/edit flows (API + UI) to call the shared upsert-by-hash service and remove any code paths that attempted to instantiate a different prompt type.

## Phase 5 — Dedup + Consistency (optional now; enforce later)
- [ ] Admin tooling to review duplicates (same `content_hash`) and choose canonical `prompt_id`
- [ ] Data migration to remap `judgments.prompt_id` and `judgments_human.prompt_id` to canonical IDs
- [ ] Delete redundant prompt rows after remap
- [ ] Enforce unique index on `prompts.content_hash` once clean
- [ ] Mark legacy prompt columns read‑only in app code; keep for compatibility during transition

## Phase 6 — Project Articles UX
- [ ] Server endpoints to manage `project_articles` membership (add/remove)
- [ ] Client UI to curate articles for a project
- [ ] On association, auto‑link prompts with prior judgments for that article

## Phase 7 — Backward Compatibility + Clean‑up (later)
- [ ] Verify legacy flows still function (reads using `prompts.project_id`)
- [ ] Feature‑flag: switch reads to new join everywhere
- [ ] When stable, disable writes to legacy columns
- [ ] Plan future migration to drop legacy columns (separate PR)

## Migrations and Backfill (Drizzle)
- [ ] Write Drizzle migrations for:
  - [ ] `project_articles`
  - [ ] `project_prompts`
  - [ ] `prompts.content_hash` + index
  - [ ] Immutability trigger on `prompts`
- [ ] Generate/apply: `bun run db:gen` → `bun run db:mig`
- [ ] Backfill scripts:
  - [ ] Compute and set `content_hash` for existing prompts
  - [ ] Populate `project_prompts` from legacy prompt rows

## Quality Gates
- [ ] Lint and tests: `bun run lint` and `bun test`
- [ ] Smoke tests:
  - [ ] Read prompts via `project_prompts` path
  - [ ] Upsert‑by‑hash behavior reuses existing prompt
  - [ ] “Available judgments” appear cross‑project for shared prompt/article

## Notes
- Prompts become global and immutable; per‑project mutables live in `project_prompts`.
- Judgments continue to reference `prompt_id`; reuse emerges naturally when multiple projects associate the same prompt.
- Keep legacy prompt columns during rollout to avoid breaking existing paths; deprecate later.

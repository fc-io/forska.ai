# Subproject: Articles and Prompts — Implemented Additions (2025-11-11)

This document captures the concrete additions completed in this iteration.

## Project prompts management (UI + API)
- UI: `src/app/routes/+projects/$id/+edit.tsx`
  - Added per‑prompt Archived toggle and Move up/down order controls.
  - Payload now includes `archived`.
- API: `PATCH /api/projects/:id/edit` (and project create)
  - Accepts and persists `archived` on prompts.
  - Computes and stores `content_hash` for prompts on create/update.

## HumanAssessment readers alignment
- Refactored overview endpoints to avoid direct `prompts.project_id` reads:
  - `GET /api/humanassessment/overview-both-projects`
  - `GET /api/humanassessment/overview-both-users`
  - Derive the project’s prompt set from `judgments_human` associations when checking completeness for both LLM and human.

## Article detail — show both LLM and human aggregates
- Server: `POST /api/projectsreview` now returns `humanAnswersByPrompt` (aggregated answers per prompt for qualified users).
- UI: `ReviewHumanAggregates` added and wired into
  `src/app/routes/+projects/$id/+reviews-llm/$articleId/+index.tsx`.

## Dedup + canonicalization groundwork
- Schema / migration:
  - Added `prompts.content_hash` and indexes; backfilled via migration `0015_prompts_content_hash.sql`.
  - Note: Uniqueness scoped to `(project_id, content_hash)` to prevent cross‑project breakage pending full associations refactor.
- Admin API/UI:
  - `GET /api/admin/prompts/duplicates` — lists duplicate groups by `content_hash`.
  - `POST /api/admin/prompts/canonicalize` — remaps `judgments` and `judgments_human` to a chosen canonical `prompt_id` and removes redundant prompts.
  - Admin UI: `src/app/routes/+admin/+prompts-duplicates/+index.tsx` to review and canonicalize.

## Project articles curation
- Schema / migration: added `project_article_link` join table (migration `0014_project_article_link.sql`).
- API: `src/server/routes/ProjectArticlesRoutes.ts`
  - `POST /api/project-articles` (link article to project)
  - `DELETE /api/project-articles` (unlink)
- UI: Buttons on `ProjectDetailsArticles` list to add/remove articles from curated set.

## Notes and follow‑ups
- Cross‑project shared prompts via an association table (`project_prompts`) is not yet introduced; readers were adjusted to avoid direct `prompts.project_id` where feasible. A full migration to associations would enable strict cross‑project canonicalization and a global `UNIQUE (content_hash)`.
- After moving to associations, revisit unique index to `UNIQUE (content_hash)` and extend article detail to show truly cross‑project judgments per canonical prompt.

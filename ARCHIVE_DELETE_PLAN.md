# Archive Delete Plan

## Goal

- Make archived projects selectable on `/projects/archived`.
- Use the reviews-table selection pattern: checkbox column, select-all, selected-count action bar.
- Show `Delete selected` only when selection > 0.
- Only allow permanent delete for projects that are already archived.
- Permanently delete archived projects plus project-owned links/cache/jobs/reviews.
- Never delete `app.article`, `app.prompt`, `app.judgment`, `app.judgment_human`, `app.judgment_assessment`, even if orphaned.

## Data model notes

- Yes: there is a project-article link table: `app.project_article`.
- `app.project_article` links `project_id` -> `article_id`; delete rows where `project_id = targetProjectId`.
- Also null surviving provenance refs: `app.project_article.imported_from_project_id = NULL` where it points at a deleted project.
- Same pattern for prompts: delete `app.project_prompt` rows owned by the project; null surviving `origin_project_id` refs in other projects.

## UI plan

- Update `src/app/routes/+projects/+archived/archivedProjectsTable.tsx`.
- Copy row-selection structure from `src/components/main/reviews/reviewsArticlesTable/reviewsArticlesTable.tsx`.
- Add top action bar, styled like `src/components/main/reviews/reviewsPaginationControls.tsx`:
  - select-all checkbox
  - `N projects selected`
  - destructive `Delete selected`
- Keep row `Unarchive` action.
- Use confirm text that says permanent project delete, no project restore.
- Keep scope simple: current archived page rows only; no cross-page selection unless page gets pagination later.

## Client plan

- Add `deleteArchivedProjects(queryClient, projectIds)` in `src/services/projectsService.ts`.
- Add flat bulk route call: recommended `POST /api/projects/delete-archived` with body `{projectIds: string[]}`.
- On success invalidate `['projects']` and `['projects', 'archived']`.
- Clear selection after success; surface server error inline or via `alert` matching current app patterns.

## Server plan

- Add bulk archived-delete handler in `src/server/routes/ProjectsRoutes.ts` or extracted helper under `src/server/routes/projectsRoutes/`.
- Validate every target id exists and is already `archived = TRUE`; reject active projects.
- For now reject delete if a project has non-terminal `app.judgment_job` rows.
- In one transaction per request or per project, do this order:
  - null downstream provenance refs:
    - `app.project_article.imported_from_project_id`
    - `app.project_prompt.origin_project_id`
  - preserve LLM judgments: update `app.judgment` set `project_id = NULL` where `project_id = targetProjectId`
  - preserve human judgments: update `app.judgment_human` set `project_id = NULL` where `project_id = targetProjectId`
  - preserve judgment assessments: leave `app.judgment_assessment` untouched
  - delete project-owned operational rows:
    - `app.token_use` via job ids
    - `app.judgment_job_prompt` via job ids
    - `app.judgment_job`
    - `app.review`
    - `app.project_import_route`
    - `app.project_article` where owned by project
    - `app.project_prompt` where owned by project
  - purge project-scoped cache/mart rows using same table set as `purgeArchivedProjectMartData` in `src/server/services/getDuckdbMartRefreshService.ts`
  - delete `app.mart_refresh_queue` rows for the project
  - delete `app.project`

## Schema step

- `app.judgment` already allows nullable `project_id`; good fit for detach-not-delete.
- `app.judgment_human.project_id` is `NOT NULL REFERENCES app.project(id)` in current DuckDB schema.
- Add a DuckDB migration to make `app.judgment_human.project_id` nullable.
- Hard delete then matches `app.judgment`: null the project link, keep the row.

## Tests

- Add server tests in `src/server/routes/ProjectsRoutes.test.ts` for:
  - active project rejected
  - archived project deleted
  - owned `app.project_article` / `app.project_prompt` / `app.project_import_route` rows removed
  - surviving `imported_from_project_id` / `origin_project_id` refs nulled
  - `app.judgment` rows preserved with `project_id = NULL`
  - `app.judgment_human` rows preserved with `project_id = NULL`
  - mart/cache rows removed
- Add UI test only if repo already has a practical route/component harness; otherwise do browser verify.

## Quality Gates

- Pass: `bun run lint`
- Pass: `bun run db:mig`
- Pass: `bun test src/server/routes/ProjectsRoutes.test.ts`
- Pass: `bun run build`
- Pass: browser verify `/projects/archived` select, delete, refresh, confirm gone

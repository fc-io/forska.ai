# COMPARE_PLAN

## Goal

Build phase-1 `Compare Judgments`: users can create, list, archive, and unarchive comparison projects that save prompts, import routes, article-content settings, timeline, and a `compareWithHumans` flag. No actual comparison-results pages yet.

## App UI

- [ ] Add `Compare Judgments` nav link in `src/components/Navigation.tsx` between `Prompts` and `Article Search`.
- [ ] Add app routes: `/compare-judgments`, `/compare-judgments/create`, `/compare-judgments/archived`.
- [ ] Build `/compare-judgments` list page with projects-style layout, `Show Archived`, and `Create New Comparison`.
- [ ] Build `/compare-judgments/archived` archived list page.
- [ ] Build `/compare-judgments/create` page based on `Create New Project` and `Create New Subproject`.
- [ ] Include fields: name, description, start date, end date, import routes, article content used, compare with humans, existing prompts.
- [ ] Use submit label `Create Comparison Project`; redirect to `/compare-judgments` on success.

## Database

- [ ] Add `comparison_project` table in `src/db/schema.ts`.
- [ ] Give `comparison_project` these fields: `id`, `name`, `description`, `ownerId`, `modelIds` nullable uuid array, `compareWithHumans`, content flags, `dateFrom`, `dateTo`, `archived`, timestamps.
- [ ] Add `comparison_project_route_link` for selected import routes.
- [ ] Add `comparison_project_prompt` for selected prompts and prompt order.
- [ ] Generate/apply migration later with `bun run db:gen` and `bun run db:mig`.

## Server API

- [ ] Add `src/server/routes/ComparisonProjectsRoutes.ts` and register it in `src/server/index.ts`.
- [ ] Add APIs: list active, list archived, create, archive, unarchive.
- [ ] In create API, validate dates like projects, keep `useFulltext` and `useFulltextNoImages` mutually exclusive, save selected prompts, save selected routes.
- [ ] Return enough list data for cards: name, description, content flags, `compareWithHumans`, prompt count, route count, created date.

## Client Data

- [ ] Add `src/services/comparisonProjectsService.ts` for client queries/mutations.

## Out Of Scope

- comparison results pages
- comparison detail page
- edit page
- clone flow
- model picker UI

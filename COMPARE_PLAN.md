# COMPARE_PLAN

## Goal

Build phase-1 `Compare Judgments`: users can create, list, archive, and unarchive comparison projects that save prompts, import routes, article-content settings, timeline, and a `compareWithHumans` flag. Next, add a `Compare Project Judgments` page that shows article rows with prompt/model answer columns for a comparison project.

## App UI

- [x] Add `Compare Judgments` nav link in `src/components/Navigation.tsx` between `Prompts` and `Article Search`.
- [x] Add app routes: `/compare-judgments`, `/compare-judgments/create`, `/compare-judgments/archived`.
- [x] Build `/compare-judgments` list page with projects-style layout, `Show Archived`, and `Create New Comparison`.
- [x] Build `/compare-judgments/archived` archived list page.
- [x] Build `/compare-judgments/create` page based on `Create New Project` and `Create New Subproject`.
- [x] Include fields: name, description, start date, end date, import routes, article content used, compare with humans, existing prompts.
- [x] Use submit label `Create Comparison Project`; redirect to `/compare-judgments` on success.

## Database

- [x] Add `comparison_project` table in `src/db/schema.ts`.
- [x] Give `comparison_project` these fields: `id`, `name`, `description`, `ownerId`, `modelIds` nullable uuid array, `compareWithHumans`, content flags, `dateFrom`, `dateTo`, `archived`, timestamps.
- [x] Add `comparison_project_route_link` for selected import routes.
- [x] Add `comparison_project_prompt` for selected prompts and prompt order.
- [ ] Generate/apply migration later with `bun run db:gen` and `bun run db:mig`.

## Server API

- [x] Add `src/server/routes/ComparisonProjectsRoutes.ts` and register it in `src/server/index.ts`.
- [x] Add APIs: list active, list archived, create, archive, unarchive.
- [x] In create API, validate dates like projects, keep `useFulltext` and `useFulltextNoImages` mutually exclusive, save selected prompts, save selected routes.
- [x] Return enough list data for cards: name, description, content flags, `compareWithHumans`, prompt count, route count, created date.

## Client Data

- [x] Add `src/services/comparisonProjectsService.ts` for client queries/mutations.

## Compare Project Judgments Page

### App UI

- [x] Add a `Compare Project Judgments` page for a comparison project.
- [x] Take style and layout inspiration from the Project Reviews page.
- [x] Add a route and entry point from the compare judgments list/cards to open the page.
- [x] Show the page title and an articles table.
- [x] Use `Title` as the first column in the table, and make each title link to the article view page for that article.
- [x] Add one column for each prompt + model combination, using the prompt heading and model as the column header.
- [x] Render each cell with the answer for that article/prompt/model combination.
- [x] If human answers are included, render those columns furthest to the right.

### Server API

- [x] Add an API to load the comparison project metadata needed to build the page.
- [x] Add an API to return the article rows and prompt/model answers for the table.
- [x] Return any human answers in a way that lets the client place them in rightmost columns.
- [x] Filter and resolve judgments using the comparison project's selected routes, timeline, prompts, models, and article-content settings.

### Client Data

- [x] Add client queries/services for the `Compare Project Judgments` page.

## Out Of Scope

- edit page
- clone flow
- model picker UI

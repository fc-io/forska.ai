**OpenAlex Integration Plan**

- [ ] Scope: Server only; reuse existing DB schema and add columns to `articles` if needed. No client/UI changes. No new docs.
- [ ] Parity: Mirror `/api/datasources/import/arxiv` and `/api/datasources/import/pubmed` for route flow, counting, and linking via `import_route` + `article_route_link`.

**Env & Config**
- [x] Env: Requires only `OPENALEX_MAILTO`
- [x] Implement the use of OPENALEX_MAILTO in @src/server/utils/env.ts

**Data Model (No New Tables)**
- [ ] Update `src/db/schema.ts` to add OpenAlex columns on `articles`:
  - [ ] `openalexId: text('openalex_id')` (unique)
- [ ] Indexes/constraints:
  - [ ] Unique index: `uniqueIndex('articles_openalex_id_unique').on(openalexId)`
  - [ ] Skip optional indexes on `doi` and `cited_by_count` for now (can revisit later).
- [ ] Generate + run migrations: `bun run db:gen && bun run db:mig`

**Routes**
- [ ] Add POST `/api/datasources/import/openalex` in `src/server/routes/DataSourcesImportRoutes.ts` with `{ body: t.Object({ id: t.String() }) }`.
- [ ] Handler file: `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostOpenalex.ts`
  - [ ] Fetch datasource by `id`.
  - [ ] Derive `fromDate`/`toDate` from datasource (fallback `fromDate='2020-01-01'`; clamp `toDate` to now). Format as `yyyy-MM-dd` strings.
  - [ ] Compute `importRoute = record.importRoute ?? '/api/datasources/import/openalex'`.
  - [ ] Call `openalexHarvest({ fromDate, toDate, importRoute })`.
  - [ ] Count imported items using `article_route_link` + `import_route` logic and date window.
  - [ ] Update `dataSource.lastImportAt` and `itemsAfterLastImport` and return `{ success: true, data: updatedRecord }`.
- [ ] Use a single `filter` query param (comma-separated filters). Use `select` to trim response payload.

**Agent/Service**
- [ ] New file: `src/agent/openalexHarvest.ts` (single named export; filename must match export per CLAUDE.md).
- [ ] Signature: `export const openalexHarvest = async (input: InputData): Promise<void>` using `InputData` from `arxivWorkflow/arxivWorkflowHarvest.ts` (`{ fromDate: string; toDate: string; importRoute: string }` where dates are `yyyy-MM-dd`).
- [ ] Build OpenAlex Works query:
  - [ ] Endpoint: `https://api.openalex.org/works`
  - [ ] Required param: `mailto=${env.OPENALEX_MAILTO}`
  - [ ] `filter`: `from_publication_date:{fromDate},to_publication_date:{toDate},type:journal-article,is_paratext:false`
  - [ ] `per-page=200`, `cursor=*` (follow `meta.next_cursor` until exhausted)
  - [ ] `select`: `id,title,abstract,abstract_inverted_index,authorships,publication_date,updated_date,doi,primary_location,open_access,cited_by_count,language,host_venue,concepts`
- [ ] Rate limiting/backoff:
  - [ ] Global rate limit: cap at 10 requests/second to OpenAlex.
  - [ ] On 429, honor `Retry-After` if present; otherwise use the exponential delays below.
  - [ ] On 5xx/timeout, retry with delays: `10s, 60s, 10m, 20m, 30m, 60m` (same as PubMed). Use ~20s request timeout.
- [ ] For each page:
  - [ ] Map results to `DatabaseItem` (see Mapping).
  - [ ] `openalexWorkflowStoreEntries(entries)` in batches of 500 (same as arXiv/PubMed patterns).
  - [ ] Continue until cursor is exhausted or repeats.
- [ ] Defaults in code: `perPage=200`, `cursor=*`, `timeoutMs=20_000`, `maxRps=10`, unlimited pages until cursor exhaustion, `retryDelays=[10_000, 60_000, 600_000, 1_200_000, 1_800_000, 3_600_000]`.


**Storage**
- [ ] New file: `src/agent/openalexWorkflowStoreEntries.ts`.
- [ ] Pattern mirrors `pubmedWorkflowStoreEntries.ts` and the existing arXiv store (file name there is `arxivWorkflowStoreEntires.ts`).
- [ ] ArkType `DatabaseItem` fields:
  - [ ] `article_id: string` (use `openalex:{short_id}`, e.g., `openalex:W1234...`)
  - [ ] `article_title: string`
  - [ ] `article_summary: string`
  - [ ] `article_authors: string[]`
  - [ ] `article_updated_at: string` (ISO8601)
  - [ ] `article_created_at: string` (ISO8601)
  - [ ] `article_version: string` (default `'1'`)
  - [ ] `doi?: string`
  - [ ] `openalex_id: string`
  - [ ] `language: string`
  - [ ] `venue: string`
  - [ ] `import_route: string`
  - [ ] `original_data?: unknown`
- [ ] Upsert into `articles` using `articles.articleId` as conflict target (`onConflictDoUpdate`) to refresh:
  - [ ] Core fields: `articleTitle`, `articleSummary`, `articleAuthors`, `articleUpdatedAt`, `articleVersion`
  - [ ] OpenAlex fields: `doi`, `openalexId`, `originalData`, and `updatedAt = now()`
  - [ ] If approved (see Decision), also set `url` to preferred source URL
- [ ] Ensure route linking:
  - [ ] Upsert/ensure `import_route` exists
  - [ ] Link via `article_route_link` for each upserted article
  - [ ] Do not write to `articles.import_route`

**Mapping (OpenAlex Work -> DatabaseItem)**
- [ ] make sure the user logs out and paste in the actuall respose strucutre before implementing the mapping
- [ ] `article_id`: `openalex:${work.id.replace('https://openalex.org/', '')}`
- [ ] `article_title`: `work.title ?? ''`
- [ ] `article_summary`: prefer `work.abstract`; otherwise reconstruct from `work.abstract_inverted_index` by placing each token at its positions across an array whose length is the max index+1, then `join(' ')`; fallback to `''` on malformed input
- [ ] `article_authors`: names from `work.authorships[].author.display_name` (fallback to empty array)
- [ ] `article_created_at`: `work.publication_date` (ISO date) if present; else `${work.publication_year}-01-01T00:00:00.000Z`
- [ ] `article_updated_at`: `work.updated_date ?? article_created_at`
- [ ] `article_version`: `'1'`
- [ ] `doi`: normalized from `work.doi` (strip `https://doi.org/`)
- [ ] `url` (if enabled): `work.primary_location?.landing_page_url || work.doi || ''`
- [ ] `original_data`: full `work` object
- [ ] `import_route`: harvester route
- [ ] `openalex_id`: `work.id.replace('https://openalex.org/', '')`

**Testing**
- [ ] Start server: `bun run dev:server`
- [ ] Create a datasource with `importRoute='/api/datasources/import/openalex'` and a date range
- [ ] Trigger import:
      `curl -X POST localhost:3000/api/datasources/import/openalex -H 'Content-Type: application/json' -d '{"id":"<datasource-uuid>"}'`
- [ ] Verify datasource counters updated; verify articles exist and are linked via `article_route_link` to `/api/datasources/import/openalex`
- [ ] Validate article columns populated: `openalex_id`, `doi` (when present), `open_access`, `cited_by_count`, `language`, `venue`, `updated_at_source`, `concepts` and optionally `url`

**Edge Cases**
- [ ] Missing `OPENALEX_MAILTO`: throw clear error and stop
- [ ] Empty page or unchanged `meta.next_cursor`: stop to avoid loops
- [ ] HTTP 429: back off using `Retry-After` if provided; otherwise exponential delays
- [ ] 5xx or timeout: exponential retry with the same delay schedule as PubMed
- [ ] Abstract reconstruction: if only `abstract_inverted_index` exists, attempt reconstruction; else leave empty

**Out of Scope (for now)**
- [ ] Cross-source deduplication on DOI — keep parity with existing importers
- [ ] Admin UI tweaks — current UI accepts arbitrary `importRoute` values
- [ ] No new tables added (only columns + indexes on existing `articles`)

**Rollout Checklist**
- [ ] Update `src/db/schema.ts` and run migrations
- [ ] Add `src/agent/openalexHarvest.ts`
- [ ] Add `src/agent/openalexWorkflowStoreEntries.ts`
- [ ] Add `src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostOpenalex.ts`
- [ ] Register route in `src/server/routes/DataSourcesImportRoutes.ts`
- [ ] Ensure `OPENALEX_MAILTO` in `.env.local`
- [ ] Run: `bun run dev:server` and smoke test with a datasource id

**Checks after implementation**
- [ ] Do not write to `articles.import_route`. Always link imports via `import_route` + `article_route_link` (as current arXiv/PubMed code does).

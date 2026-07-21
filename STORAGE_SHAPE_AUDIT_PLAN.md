# Storage Shape Audit Results

Generated from the review-storage audit strategy in
`REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md`.

## Durable Audit Control Framework

This is the audit control plane. Later stories must resume here and append
normalized evidence rather than creating parallel result files. Narrative
findings retained later in this file are discovery input, not substitutes for
the manifests and proof records below.

### Certification Snapshot

| Field | Value | Reason |
| --- | --- | --- |
| `overallCertification` | `INCOMPLETE` | The API manifest has 22 nonterminal rows and one blocked row, the other manifests are not baselined, benchmark-critical values and physical proof are pending, and no inherited recommendation is actionable. |
| Framework version | `US-001 / 2026-07-21` | First normalized, resumable evidence structure. |
| Latest normalized story | `US-002 / 2026-07-21` | Current route/read-contract semantics and the repository-defined benchmark surface are frozen below; route-registry conflicts and benchmark-critical values remain unresolved. |
| Durable result file | `STORAGE_SHAPE_AUDIT_PLAN.md` | The only audit-result artifact; Ralph may separately update tracker metadata. |

`overallCertification: PASS` is forbidden until every in-scope manifest row is
`classified`, every reconciliation has zero nonterminal and blocked rows, all
completion gates pass, and every actionable recommendation has all applicable
positive and negative proof checks satisfied. Otherwise it remains
`INCOMPLETE`.

### Scope And Mutation Boundary

- Audit work may read repository files and approved immutable snapshots. It
  must not change repository schemas, code, routes, projectors, retention,
  runtime behavior, or data.
- Durable audit results go only in this file. Changes under `.ralph-tui/` are
  tracker metadata, not audit evidence.
- Never open or query the live DuckDB file directly. Physical evidence is
  acceptable only from approved snapshot tooling or an explicitly approved,
  isolated disposable fixture in a story that authorizes it.
- Do not start a server, worker, projector, migration, maintenance command, or
  database writer merely to fill this framework.
- Model, provider, thinking level, prompt set, content flags, memory limit, and
  runtime profile are benchmark-critical. Preserve failures under those
  settings; do not retry, downgrade, or silently work around them.

### Inherited Evidence And Disposition Rule

The pre-US-001 content below is preserved because it contains useful
repo-derived observations. Its factual claims remain discovery leads subject to
exact citation and manifest reconciliation. Every inherited `Disposition:`,
deletion/move candidate, target shape, implementation slice, and current
recommendation is **provisional** with
`recommendationActionability: unresolved` unless a later normalized row
cross-references revised proof.

- A broad path or glob is a discovery source, not a proof citation.
- A test, fixture, plan, comment, generated file, or historical migration does
  not prove production use.
- Absence from literal search does not prove absence from generated SQL,
  aliases, registries, allowlists, scripts, or runtime paths.
- No move, derive, archive, or delete recommendation may become stronger before
  API, writer, lifecycle, recovery, export, transfer, and retention evidence is
  traced. Final actionability also requires all applicable proof domains below.

## Stable Row IDs And Cross-References

Every normalized row receives an opaque stable ID. IDs identify evidence
records, not mutable object names.

| Prefix | Row family |
| --- | --- |
| `API-####` | Mounted API and read-contract manifest |
| `UIR-####` | UI and runtime consumption manifest |
| `BGO-####` | Background and operator surface manifest |
| `DBO-####` | DuckDB object, temporary shape, payload, or generated-file manifest |
| `CMF-####` | Column and material field manifest |
| `MAP-####` | Route-to-query and route-to-table map |
| `LIN-####` | Column-level lineage |
| `TLI-####` | Table, index, and lifecycle inventory |
| `FAN-####` | Fan-out or duplicate-byte measurement |
| `DSP-####` | Storage disposition |
| `PRF-####` | Positive or negative proof check |
| `TGT-####` | Candidate target shape |
| `SLC-####` | Implementation slice and benchmark gate |
| `EVD-####` | Exact evidence citation |
| `CMD-####` | Command or explicitly skipped check |
| `BLK-####` | Audit blocker |
| `OQ-####` | Owner question |

ID rules:

1. Allocate the next decimal ID within its family and zero-pad to four digits.
2. Never renumber, reuse, or derive an ID from a route, symbol, table, or
   column name.
3. A rename keeps the ID and records both locators. A split creates new IDs and
   cross-references the originating ID.
4. Keep retired or superseded rows for history; record an evidence-backed
   terminal state instead of deleting them.
5. Use IDs for all cross-output links. Citations supplement IDs but never
   replace them.

## State Model

The four state fields answer different questions and must never substitute for
one another.

### Manifest `auditStatus`

Only these values are valid:

| Value | Meaning |
| --- | --- |
| `not-started` | Discovered and allocated, but no required lineage has been traced. |
| `traced-to-api` | Product/API or explicit non-route scope is known; writer and lifecycle proof is incomplete. |
| `traced-to-writer` | Producers and mutations are traced; lifecycle/recovery or other required evidence is incomplete. |
| `traced-to-lifecycle` | Invalidation, replay/recovery, retention, and cleanup are traced; measurement or classification is incomplete. |
| `measured` | Required approved physical evidence is recorded; classification is incomplete. |
| `classified` | The in-scope row has complete required evidence and a use classification; this does not make a recommendation actionable. |
| `blocked` | Reconciliation-terminal for counting, but required evidence cannot currently be obtained; any blocked row prevents `PASS`. |
| `out-of-scope` | Evidence proves the row is outside the project-review domain and records the exact reason. |

The nonterminal values are `not-started`, `traced-to-api`,
`traced-to-writer`, `traced-to-lifecycle`, and `measured`. Every row with
one of those values must contain concrete `missingEvidence` and at least one
`ownerQuestionIds` reference. A `blocked` row must contain both as well.
`classified` and `out-of-scope` are the evidence-complete terminal states;
`out-of-scope` additionally requires a cited scope reason.

### `proofCheckState`

| Value | Meaning |
| --- | --- |
| `satisfied` | The named positive or negative proof is present and exactly cited. |
| `pending` | The proof is required but has not been established. |
| `blocked` | The proof is required and an identified blocker prevents collection. |
| `not-applicable` | Cited scope evidence shows why this proof domain cannot apply. |

### `recommendationActionability`

| Value | Meaning |
| --- | --- |
| `actionable` | Every applicable proof check and benchmark gate is satisfied. |
| `unresolved` | One or more proof checks or design consequences remain pending. |
| `blocked` | A required proof check is blocked. |

### `overallCertification`

| Value | Meaning |
| --- | --- |
| `PASS` | All manifests reconcile with no blocked rows, every completion gate passes, and every actionable recommendation has complete proof. |
| `INCOMPLETE` | Any other condition, including an empty/unbaselined manifest, nonterminal row, blocker, pending gate, or unresolved required proof. |

## Exact Evidence And Source Classification

Each `EVD-####` record states the claim it supports, source class, exact
locator, and `CMD-####` or approved snapshot that exposed it. Accepted exact
locators include:

- repository file plus symbol, exported constant, test name, or exact SQL
  statement shape;
- mounted method and route, UI query key, worker/scheduler entry point, or
  operator command;
- fully qualified table, column, JSON key, constraint, index name/expression,
  or temporary-table naming shape;
- exact current/final migration and every forward migration that changes it;
- immutable approved snapshot identity plus collection command and fixed
  benchmark configuration; and
- exact local path scheme or export/transfer mapping plus producer and consumer.

Every evidence record uses one source class:

| Source class | Evidentiary use |
| --- | --- |
| `production` | Runtime route, client, service, writer, worker, projector, lifecycle, recovery, export, transfer, or operator code. |
| `test` | Test behavior only; corroborates but does not prove production use. |
| `fixture` | Seed/mock/disposable-fixture behavior only; never live physical evidence. |
| `plan` | Intended or historical design only. |
| `comment` | Discovery hint only. |
| `generated` | Generated types/files; record the source and do not infer runtime mounting. |
| `historical-migration` | Schema history only; reconcile current declarations and forward migrations. |
| `approved-snapshot` | Immutable approved non-live physical evidence with fixed configuration. |

Globs, directory-level citations, unrecorded searches, and bare claims such as
“the tests cover this” cannot satisfy proof. Conflicting evidence is preserved
and linked to a blocker or owner question, never resolved by assumption.

## US-002 Contract And Benchmark Freeze

This section freezes the behavior found in current repository source before
schema census, physical measurement, or candidate comparison. It records
behavior; it does not endorse every behavior as the intended product contract.
No setting was supplied, changed, retried with a weaker value, or inferred from
live data. `recommendationActionability` remains `unresolved`, and
`overallCertification` remains `INCOMPLETE`.

### US-002 Exact Evidence Ledger

| rowId | Source class | Exact locator | Claim supported | Exposed by |
| --- | --- | --- | --- | --- |
| `EVD-0001` | `production` | `src/server/routes/productApiRoutes.ts#getProductApiRoutes`; `src/server/routes/ProjectsRoutes.ts#projectsRoutes` | Product plugins are composed into the API; the review subroutes actually used by `projectsRoutes` are the mount truth for this source audit. | `CMD-0011` |
| `EVD-0002` | `production` | `src/server/reviewServing/reviewServingReadContracts.ts#reviewServingReadContractRouteInventory` | Declares 17 route entries, 16 with `mounted: true`, and maps route entries to contract keys. | `CMD-0012` |
| `EVD-0003` | `production` | `src/server/reviewServing/reviewServingReadContracts.ts#reviewServingReadContractList`, `#defineContract`, `#rowContract`, `#rowByArticleSetContract`, `#filterFacetContract` | Defines exact filter, order, cursor, freshness, access, count, and budget metadata for all 36 read contracts. | `CMD-0012` |
| `EVD-0004` | `production` | `src/server/reviewServing/reviewServingContracts.ts#ReviewServingReadContract`, `#ReviewServingCountState`, `#ReviewServingSearchState`, `#ReviewServingSnapshotState`, `#namedReviewFastCountDefinitions` | Defines read-contract state vocabularies, snapshot identity, named-count definitions, and budget fields. | `CMD-0011` |
| `EVD-0005` | `production` | `src/server/reviewServing/reviewServingReader.ts#readReviewServingRows`, `#getSnapshotManifest`, `#getManifestFreshness`; `src/server/reviewServing/reviewServingAdmission.ts#admitReviewServingRequest`, `#isFreshnessAccepted` | Reader admission rejects unsupported filters, invalid cursors, missing identities/components, budget excess, synchronous substring search, and disallowed freshness; reads are snapshot-scoped. | `CMD-0011` |
| `EVD-0006` | `production` | `src/server/reviewServing/reviewServingCursor.ts#ReviewServingCursorPayload`, `#decodeAndValidateReviewServingCursor`, `#getReviewServingFilterSignature` | Cursors bind contract, normalized filter signature, review-config hash, snapshot, component generations/identities/watermarks, sort direction/key, and values. | `CMD-0011` |
| `EVD-0007` | `production` | `src/server/reviewServing/reviewServingRouteParityCoverage.ts#reviewServingRouteParityCoverage`, `#reviewServingJobParityCoverage`; `src/server/reviewServing/reviewServingRouteParityEvidence.ts#reviewServingRouteParityEvidence`, `#reviewServingJobParityEvidence` | Declares 11 route-parity and 7 job-parity entries plus their required gates and synthetic evidence budgets. | `CMD-0013` |
| `EVD-0008` | `production` | `src/server/routes/routeSurfaceInventory.ts#routeSurfaceRoutes` | The public route registry omits `POST /api/projectsreviewshealth` and includes the adjacent add/PDF/export status and download routes recorded below. | `CMD-0013` |
| `EVD-0009` | `production` | `src/server/reviewServing/reviewServingLlmReviewRouteService.ts#getLlmReviewArticlesFromServing`, `#countLlmReviewArticlesFromServing`, `#getFilteredCountValue`; `src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.ts#getHumanReviewArticlesFromServing`, `#getBothReviewArticlesFromServing`, `#getUnassessedReviewArticlesFromServing`, `#queryRouteRowsWithRetry` | Defines list response fields, page/cursor behavior, exact dynamic counts, last-known-good reads, and the existing four-attempt transient database-read retry. | `CMD-0011` |
| `EVD-0010` | `production` | `src/server/reviewServing/reviewServingFilterRouteService.ts#getReviewFiltersFromServing`, `#readFacetRows`, `#readOptionRows`; review filter route handlers under `src/server/routes/projectsRoutes/` | Defines filter/facet/option response shape, fixed limits, search scope, and empty unavailable response. | `CMD-0011` |
| `EVD-0011` | `production` | `src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts#projectsRoutesPostArticleReviewDetails`; `projectsRoutesGetPromptPreview.ts#projectsRoutesGetPromptPreview`; `projectsRoutesGetReviewsWarnings.ts#projectsRoutesGetReviewsWarnings`; `projectsRoutesGetReviewsHealth.ts#projectsRoutesGetReviewsHealth` | Defines detail, prompt-preview, warning, and health response and unavailable/stale behavior. | `CMD-0011` |
| `EVD-0012` | `production` | `src/server/routes/ArticlesRoutes.ts#articlesRoutes`; `src/server/routes/ProjectsAddArticlesRoutes.ts#projectsAddArticlesRoutes`; `src/server/routes/ProjectExportRoutes.ts#projectExportRoutes`; `src/server/reviewServing/reviewBulkOperationService.ts#createReviewBulkOperationJob` | Defines job creation/status/download response shapes, latest versus pinned snapshot semantics, and foreground payload caps. | `CMD-0011` |
| `EVD-0013` | `production` | `src/server/reviewServing/reviewServingBenchmark.ts#reviewServingSynthetic10m7PromptOverlapFixture`, `#reviewServingBenchmarkOverlapWorkloadDefinition`, `#getReviewServingBenchmarkMetrics`, `#getDefaultReviewServingBenchmarkReleaseContext` | Fixes repository-declared fixture scale, workload, targets, metric calculations, and release-report fields while exposing missing critical configuration. | `CMD-0014` |
| `EVD-0014` | `production` | `src/server/utils/env.ts#loadEnv`; `src/server/utils/duckdbMemoryDefaults.ts#getDefaultMaintenanceDuckdbMemoryLimit`; `src/server/utils/runtimeLogger.ts#getRuntimeLogProfile`; `package.json` scripts `dev:server`, `bench:review-serving-smoke`, and `bench:review-serving-release-gate` | Defines role-dependent DuckDB memory defaults, runtime-profile resolution, and command wiring; no physical benchmark value is pinned. | `CMD-0015` |
| `EVD-0015` | `test` | `src/server/reviewServing/reviewServingBenchmark.test.ts`; `reviewServingReadContracts.test.ts`; `reviewServingRouteParityCoverage.test.ts`; `reviewServingRouteParityEvidence.test.ts` | Seventy-three passing tests corroborate declared contract coverage, parity registration/evidence, and synthetic benchmark shape; tests do not prove actual mounting or a live physical run. | `CMD-0016` |
| `EVD-0016` | `plan` | `REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md#Phase 0 - Freeze Contracts, Baseline, And Schema Census` | Requires source import/seeding, projection/rebuild, and foreground route-read time to be separate and prohibits direct live-DuckDB inspection. | `CMD-0010` |

### Mounted Route And Contract Registry Baseline

The normalized union below is deliberately wider than the read-contract route
inventory: it includes its explicit unmounted entry, the two parity-only job
routes, and the four directly adjacent status/download routes needed to close
the already-registered add/PDF/export flows. Later API stories still own the
full UI, admin, transfer, and generated-client census.

| rowId | Method and route | Mount/registry truth | Frozen HTTP response contract | Read-contract keys or gap | Evidence IDs |
| --- | --- | --- | --- | --- | --- |
| `API-0001` | `POST /api/articlesreviews` | Mounted by `projectsRoutesGetArticlesReviews`. | `{data, totalCount, page, limit, totalPages, nextCursor}`; each row has article display/import fields, LLM `judgments`, `judgedPromptIds`, and `isFullyJudged`. | `review.llm.rows`, rows-by-set, count, postings, badges, LLM list judgments, token-prefix and async-substring search contracts. | `EVD-0001`, `EVD-0002`, `EVD-0009` |
| `API-0002` | `POST /api/articlesreviewscount` | Mounted by `projectsRoutesGetArticlesReviewsCount`. | Success `{totalCount,totalPages}`; every caught error, including missing snapshot, returns `{totalCount:0,totalPages:0,error}` without setting a non-2xx status. | LLM count, postings, token-prefix, async-substring. | `EVD-0001`, `EVD-0002`, `EVD-0009` |
| `API-0003` | `POST /api/articlesreviewshuman` | Mounted by `projectsRoutesGetArticlesReviewsHuman`. | List envelope plus top-level `humanJudgmentMode`; rows add human judgments, summary answer, judged prompt IDs, and `isFullyJudged:true`. | Human rows, rows-by-set, list judgments, postings, count, search. | `EVD-0001`, `EVD-0002`, `EVD-0009` |
| `API-0004` | `POST /api/articlesreviewsboth` | Mounted by `projectsRoutesGetArticlesReviewsBoth`. | List envelope; rows combine LLM judgments, `humanJudgmentMode`, human/LLM summary answers, and prompt answers when applicable. | Both rows, rows-by-set, LLM/human list judgments, postings, count, search. | `EVD-0001`, `EVD-0002`, `EVD-0009` |
| `API-0005` | `POST /api/articlesreviewsunassessed` | Mounted by `projectsRoutesGetArticlesReviewsUnassessed`. | List envelope; rows have article fields, empty judgments and prompt IDs, and `isFullyJudged:false`. | Unassessed rows, rows-by-set, postings, count, queue, search. | `EVD-0001`, `EVD-0002`, `EVD-0009` |
| `API-0006` | `GET /api/articlesreviewsfilters` | Mounted by `projectsRoutesGetArticlesReviewsFilters`. | `{diagnostics,facets,filterOptions,filters,searchScope}`; missing snapshot returns empty arrays plus unavailable search scope. | Review facets/options, postings, token-prefix and async-substring. | `EVD-0001`, `EVD-0002`, `EVD-0010` |
| `API-0007` | `GET /api/articlesreviewshumanfilters` | Mounted by `projectsRoutesGetArticlesReviewsHumanFilters`. | Same filter response plus top-level `humanJudgmentMode`; missing snapshot has the same empty/unavailable shape. | Human facets/options, token-prefix and async-substring. | `EVD-0001`, `EVD-0002`, `EVD-0010` |
| `API-0008` | `POST /api/projectsreview` | Mounted by `projectsRoutesPostArticleReviewDetails`. | Ready object contains article, prompts, current/all judgments, human assessments/answers, summary answers, related Covidence rows, project names, and overflow flag; rejected/missing serving detail returns structured `status:"unavailable"` and `reason`. | Detail row/payload/LLM and human judgments plus prompt badges. | `EVD-0001`, `EVD-0002`, `EVD-0011` |
| `API-0009` | `POST /api/projectsreviewswarnings` | Mounted by `projectsRoutesGetReviewsWarnings`. | `{data:{projectId,enabledPromptCount,scope,indexing}}`; indexing exposes status/progress/blocking/freshness/search/serving diagnostics and may request or boost repair work when a usable snapshot is absent. | Warning snapshot. | `EVD-0001`, `EVD-0002`, `EVD-0011` |
| `API-0010` | `GET /api/projects/:id/prompts/:promptId/preview` | Mounted by `projectsRoutesGetPromptPreview`. | `{data:{articleId,articleTitle,diagnostics,previewText,reason,status,systemPrompt,userPrompt}}`; unavailable reasons include manifest freshness, `no_articles`, `serving_detail_unavailable`, and `no_fulltext`. | Prompt preview and detail payload. | `EVD-0001`, `EVD-0002`, `EVD-0011` |
| `API-0011` | `POST /api/articles/pdf-fetch-by-filter` | Mounted by `articlesRoutes`; present in contract and job-parity registries. | HTTP 202 `{success:true,job}`; persisted job criteria carry list/filter/search and latest-snapshot semantics. | Bulk selection and PDF selection. | `EVD-0002`, `EVD-0007`, `EVD-0012` |
| `API-0012` | `POST /api/projects/add_articles_by_filter` | Mounted by `projectsAddArticlesRoutes`; present in contract and job-parity registries. | HTTP 202 `{status:"pending",success:true,job,targetProjectId}`. Production uses `review.bulk.selection` with `none` or `tokenPrefix`; inventory maps only `review.bulk.substringSelection`. | Registry maps async substring selection only; production semantic mismatch is unresolved. | `EVD-0002`, `EVD-0007`, `EVD-0012` |
| `API-0013` | `POST /api/articles/pdf-fetch-by-project` | Mounted by `articlesRoutes`; present in contract and job-parity registries. | HTTP 202 `{success:true,job}`; effective dates are intersected with project bounds and selection uses latest snapshot. | PDF selection. | `EVD-0002`, `EVD-0007`, `EVD-0012` |
| `API-0014` | `POST /api/articles/pdf-fetch-bulk` | Mounted by `articlesRoutes`; present in contract and job-parity registries. | HTTP 202 `{success:true,job}` after explicit-ID cap; no project snapshot is required for the article-ID-only job. | PDF selection. | `EVD-0002`, `EVD-0007`, `EVD-0012` |
| `API-0015` | `POST /api/projects/:id/export` | Mounted by `projectExportRoutes`; present in contract and job-parity registries. | HTTP 202 `{downloadUrl,exportContract,job,success:true}`; 400 on config/snapshot incompatibility; supports latest or explicit pinned snapshot. | Export selection. | `EVD-0002`, `EVD-0007`, `EVD-0012` |
| `API-0016` | `POST /api/review-serving/filter-postings` | Explicitly `mounted:false`; no Elysia route is registered. | Contract-documentation entry only; no HTTP response exists. | `review.filters.postings`. | `EVD-0002`, `EVD-0003` |
| `API-0017` | `POST /api/projectsreviewshealth` | Declared `mounted:true` and parity-covered, but `projectsRoutes` neither imports nor uses `projectsRoutesGetReviewsHealth`; absent from `routeSurfaceRoutes`. | Source handler would return `{data:{projectId,enabledPromptCount,scope,serving}}`, but it is not reachable through the product route composition. | Health snapshot; registry conflict blocks mount certification. | `EVD-0001`, `EVD-0002`, `EVD-0007`, `EVD-0008`, `EVD-0011` |
| `API-0018` | `POST /api/projects/add_articles_by_ids` | Mounted and job-parity-covered; absent from read-contract route inventory. | HTTP 202 pending job response with `providedTotal`; explicit-ID cap applies. | No route-inventory mapping; job kind is `review.bulk.selection`. | `EVD-0007`, `EVD-0008`, `EVD-0012` |
| `API-0019` | `GET /api/articles/pdf-fetch-jobs/:jobId` | Mounted and job-parity-covered; absent from read-contract route inventory. | `{job}` or thrown `Job not found`; parity contract says durable ID lookup with no selection scan or hydrated payload. | No route-inventory mapping. | `EVD-0007`, `EVD-0008`, `EVD-0012` |
| `API-0020` | `GET /api/projects/add_articles_jobs` | Mounted in route-surface registry; absent from both read-contract and parity registries. | `{success:true,job,targetProjectId}` or thrown `Add articles job not found`. | No registered read contract or parity entry. | `EVD-0008`, `EVD-0012` |
| `API-0021` | `GET /api/projects/:id/export/:jobId` | Mounted in route-surface registry; absent from both read-contract and parity registries. | 200 `{downloadUrl|null,job:{jobId,status},success:true}` or 404 error object. | No registered read contract or parity entry. | `EVD-0008`, `EVD-0012` |
| `API-0022` | `GET /api/projects/:id/export/:jobId/download` | Mounted in route-surface registry; absent from both read-contract and parity registries. | 404 missing, 409 incomplete/unavailable snapshot, otherwise streamed CSV with content headers after snapshot-scope resolution. | No registered read contract or parity entry. | `EVD-0008`, `EVD-0012` |
| `API-0023` | `POST /api/projects/:id/export-prompts` | Mounted in route-surface registry; absent from both read-contract and parity registries. | 400 for no prompt IDs; otherwise streamed prompt CSV with content headers. | No registered read contract or parity entry. | `EVD-0008`, `EVD-0012` |

### Registry And Parity Discrepancies

| Discrepancy | Exact result | Audit consequence |
| --- | --- | --- |
| Declared mount versus product composition | The 16 `mounted:true` read-inventory entries minus `routeSurfaceRoutes` is exactly `POST /api/projectsreviewshealth`; `ProjectsRoutes.ts#projectsRoutes` confirms the handler is not composed. | `API-0017` is `blocked`; parity evidence cannot establish reachability. |
| Parity union versus read-contract inventory | The 18-entry route/job parity union minus the declared-mounted read inventory is exactly `POST /api/projects/add_articles_by_ids` and `GET /api/articles/pdf-fetch-jobs/:jobId`. | `API-0018` and `API-0019` remain `traced-to-api` pending registry ownership. |
| Adjacent mounted flow closures | Add-job status, export-job status/download, and prompt export are in `routeSurfaceRoutes` but absent from both review-serving registries. | `API-0020` through `API-0023` prevent a claim that the review read registry is exhaustive. |
| Add-by-filter semantic mapping | Route inventory maps `review.bulk.substringSelection`; production creates `review.bulk.selection` and selects `none` or `tokenPrefix` search mode. | Contract parity for `API-0012` needs owner resolution; no value was silently substituted. |

### Read-Contract Matrix

This matrix is the exact `reviewServingReadContractList` baseline. Budget cells
are `maxPageSize / maxResultRows / maxEstimatedResultBytes / timeoutMs /
allowsTempSpill`. Every contract has a 5,000 ms timeout and forbids temp spill.
These are per-reader admission budgets, not aggregate HTTP-response budgets.

| Contract key | Allowed filters | Named exact counts | Order and cursor | Freshness, search, access | Budget |
| --- | --- | --- | --- | --- | --- |
| `review.llm.rows` | `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `searchTokenPrefix`, `conflictFlag`, `llmHasJudgment`, `llmStatus`, `promptAnswer` | `review.list.total`, `review.list.filteredTotal`, `review.llm.assessedByPrompt` | `sort_key DESC, article_id ASC`; same cursor | ready snapshot; token prefix; ordered prefix | `501 / 501 / 2000000 / 5000 / false` |
| `review.llm.rowsByArticleSet` | Previous plus `articleId` | Same as LLM rows | `sort_key DESC, article_id ASC`; same cursor | ready snapshot; no search; article-set lookup | `101 / 101 / 5000000 / 5000 / false` |
| `review.llm.count` | `conflictFlag`, `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `llmHasJudgment`, `llmStatus`, `promptAnswer`, `searchTokenPrefix` | `review.list.total`, `review.list.filteredTotal`, `review.llm.assessedByPrompt`, `review.llm.unassessedByPrompt` | `list_mode_key, count_kind, summary_definition_version, filter_key` ascending; no cursor | ready snapshot; no search; summary lookup | `1 / 1 / 2000000 / 5000 / false` |
| `review.human.rows` | `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `searchTokenPrefix`, `conflictFlag`, `humanStatus`, `promptAnswer` | `review.list.total`, `review.list.filteredTotal`, `review.human.reviewedByPrompt` | `sort_key DESC, article_id ASC`; same cursor | ready snapshot; token prefix; ordered prefix | `501 / 501 / 2000000 / 5000 / false` |
| `review.human.rowsByArticleSet` | Previous plus `articleId` | Same as Human rows | `sort_key DESC, article_id ASC`; same cursor | ready snapshot; no search; article-set lookup | `101 / 101 / 5000000 / 5000 / false` |
| `review.human.count` | `conflictFlag`, `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `humanStatus`, `promptAnswer`, `searchTokenPrefix` | `review.list.total`, `review.list.filteredTotal`, `review.human.reviewedByPrompt` | Count order ascending as above; no cursor | ready snapshot; no search; summary lookup | `1 / 1 / 2000000 / 5000 / false` |
| `review.both.rows` | `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `searchTokenPrefix`, `conflictFlag`, `humanStatus`, `llmStatus`, `promptAnswer` | `review.list.total`, `review.list.filteredTotal`, `review.both.conflictByPrompt` | `sort_key DESC, article_id ASC`; same cursor | ready snapshot; token prefix; ordered prefix | `501 / 501 / 2000000 / 5000 / false` |
| `review.both.rowsByArticleSet` | Previous plus `articleId` | Same as Both rows | `sort_key DESC, article_id ASC`; same cursor | ready snapshot; no search; article-set lookup | `101 / 101 / 5000000 / 5000 / false` |
| `review.both.count` | `conflictFlag`, `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `humanStatus`, `llmStatus`, `promptAnswer`, `searchTokenPrefix` | `review.list.total`, `review.list.filteredTotal`, `review.both.conflictByPrompt` | Count order ascending as above; no cursor | ready snapshot; no search; summary lookup | `1 / 1 / 2000000 / 5000 / false` |
| `review.unassessed.rows` | `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `searchTokenPrefix`, `conflictFlag`, `queueKind` | `review.queue.unassessedReady`, `review.llm.unassessedByPrompt` | `activity_sort_at DESC, article_id DESC`; same cursor | ready snapshot; token prefix; ordered prefix | `501 / 501 / 2000000 / 5000 / false` |
| `review.unassessed.rowsByArticleSet` | Previous plus `articleId` | Same as Unassessed rows | `activity_sort_at DESC, article_id DESC`; same cursor | ready snapshot; no search; article-set lookup | `101 / 101 / 5000000 / 5000 / false` |
| `review.unassessed.count` | `conflictFlag`, `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `queueKind`, `searchTokenPrefix` | `review.queue.unassessedReady`, `review.llm.unassessedByPrompt` | Count order ascending as above; no cursor | ready snapshot; no search; summary lookup | `1 / 1 / 2000000 / 5000 / false` |
| `review.filters.postings` | `articleCreatedAtFrom`, `articleCreatedAtTo`, `articleId`, `conflictFlag`, `duplicateFlag`, `humanStatus`, `importRoute`, `llmStatus`, `promptAnswer`, `publicationYear`, `queueKind`, `searchTokenPrefix` | `review.list.filteredTotal` | `sort_key DESC, article_id ASC`; same cursor | ready snapshot; token prefix; posting intersection | `100 / 100 / 2000000 / 5000 / false` |
| `review.filters.facets` | `articleCreatedAtFrom`, `articleCreatedAtTo`, `conflictFlag`, `duplicateFlag`, `humanStatus`, `importRoute`, `llmStatus`, `promptAnswer`, `publicationYear`, `searchTokenPrefix` | duplicate, import-route, prompt-answer, publication-year facet keys | `facet_key, facet_value` ascending; no cursor | ready snapshot; token prefix; summary lookup | `128 / 128 / 2000000 / 5000 / false` |
| `review.human.filters.facets` | Same except no `llmStatus` | human prompt-answer and summary-answer facet keys | `facet_key, facet_value` ascending; no cursor | ready snapshot; token prefix; summary lookup | `128 / 128 / 2000000 / 5000 / false` |
| `review.filters.options` | Same filters as review facets | None | `filter_kind, facet_key, option_value_key` ascending; no cursor | ready snapshot; token prefix; summary lookup | `512 / 512 / 1000000 / 5000 / false` |
| `review.human.filters.options` | Same filters as human facets | None | `filter_kind, facet_key, option_value_key` ascending; no cursor | ready snapshot; token prefix; summary lookup | `512 / 512 / 1000000 / 5000 / false` |
| `review.prompt.badges` | `promptAnswer` | Both conflict, Human reviewed, LLM assessed, and LLM unassessed by prompt | Count order ascending; no cursor | ready snapshot; no search; summary lookup | `1 / 512 / 2000000 / 5000 / false` |
| `review.queue.unassessed` | `duplicateFlag`, `importRoute`, `publicationYear`, `articleCreatedAtFrom`, `articleCreatedAtTo`, `searchTokenPrefix`, `conflictFlag`, `queueKind` | `review.queue.unassessedReady` | `priority_bucket, activity_sort_at, article_id, prompt_id, queue_identity` descending; same cursor fields | ready snapshot; token prefix; queue ordering | `100 / 100 / 2000000 / 5000 / false` |
| `review.detail.row` | `articleId` | None | list-mode priority then `article_id` ascending; cursor is `article_id` | ready snapshot; no search; keyed lookup | `1 / 1 / 2000000 / 5000 / false` |
| `review.detail.payload` | `articleId` | None | `article_id` ascending; same cursor | ready snapshot; no search; keyed lookup | `1 / 1 / 1000000 / 5000 / false` |
| `review.detail.judgments` | `articleId` | None | list-mode priority, `prompt_order ASC NULLS LAST`, `prompt_id`; same cursor | ready snapshot; no search; keyed lookup | `512 / 512 / 2000000 / 5000 / false` |
| `review.detail.humanJudgments` | `articleId`, `promptAnswer`, `promptId` | None | Same detail-judgment order/cursor | ready snapshot; no search; keyed lookup | `512 / 512 / 1000000 / 5000 / false` |
| `review.llm.list.judgments` | `articleId`, `promptAnswer`, `promptId` | None | `article_id`, `prompt_order ASC NULLS LAST`, `prompt_id`; same cursor | ready snapshot; no search; article-set lookup | `10000 / 10000 / 4000000 / 5000 / false` |
| `review.human.list.judgments` | Previous plus `humanStatus` | None | Same article/prompt order and cursor | ready snapshot; no search; article-set lookup | `10000 / 10000 / 4000000 / 5000 / false` |
| `review.both.list.judgments` | `articleId`, `conflictFlag`, `llmStatus`, `promptAnswer`, `promptId` | None | Same article/prompt order and cursor | ready snapshot; no search; article-set lookup | `10000 / 10000 / 4000000 / 5000 / false` |
| `review.both.list.humanJudgments` | `articleId`, `conflictFlag`, `humanStatus`, `promptAnswer`, `promptId` | None | Same article/prompt order and cursor | ready snapshot; no search; article-set lookup | `10000 / 10000 / 4000000 / 5000 / false` |
| `review.health.snapshot` | None | `review.list.total` | `updated_at DESC, snapshot_id DESC`; same cursor | stale allowed; no search; keyed lookup | `1 / 1 / 2000000 / 5000 / false` |
| `review.warning.snapshot` | None | `review.list.total`, `review.queue.unassessedReady` | `updated_at DESC, snapshot_id DESC`; same cursor | stale allowed; no search; keyed lookup | `8 / 8 / 2000000 / 5000 / false` |
| `review.prompt.preview` | None | None | `article_created_at ASC NULLS LAST, article_id ASC`; same cursor | ready snapshot; no search; ordered prefix | `1 / 1 / 1000000 / 5000 / false` |
| `review.bulk.selection` | Default row filters plus `articleId`, `conflictFlag`, `humanStatus`, `llmStatus`, `promptAnswer`, `queueKind` | None | `updated_at DESC, job_id DESC`; same cursor | ready snapshot; token prefix; job criteria | `1 / 1 / 500000 / 5000 / false` |
| `review.bulk.substringSelection` | Same as bulk selection | None | `updated_at DESC, job_id DESC`; same cursor | async unavailable; async substring; job criteria | `1 / 1 / 500000 / 5000 / false` |
| `review.export.selection` | Default row filters plus `conflictFlag`, `humanStatus`, `llmStatus`, `promptAnswer`, `sourceProject` | None | `updated_at DESC, job_id DESC`; same cursor | ready snapshot; token prefix; job criteria | `1 / 1 / 500000 / 5000 / false` |
| `review.pdf.selection` | Same as bulk selection | None | `updated_at DESC, job_id DESC`; same cursor | ready snapshot; token prefix; job criteria | `1 / 1 / 500000 / 5000 / false` |
| `review.search.tokenPrefix` | `searchTokenPrefix` | None | `token ASC, article_id ASC`; same cursor | ready snapshot; token prefix; token-prefix index | `50 / 50 / 2000000 / 5000 / false` |
| `review.search.substringAsync` | `searchTokenPrefix` | None | `updated_at DESC, job_id DESC`; same cursor | async unavailable; async substring; job criteria | `1 / 1 / 100000 / 5000 / false` |

`Default row filters` in the last group means exactly `duplicateFlag`,
`importRoute`, `publicationYear`, `articleCreatedAtFrom`,
`articleCreatedAtTo`, and `searchTokenPrefix`. The reader separately caps
article-set hydration at 100 article IDs and 2,000,000 estimated payload bytes.
List handlers expose a 1-500 HTTP limit and ask the reader for `limit + 1`,
which explains the 501-row contract budget.

### Exactness, Pagination, Freshness, And Failure Semantics

| Concern | Frozen current behavior | Evidence IDs |
| --- | --- | --- |
| List exactness and pagination | LLM, Human, Both, and Unassessed select snapshot-scoped candidates in contract order, fetch `limit + 1`, return at most `limit`, and derive `nextCursor` from the last returned row. There is no offset selection. LLM echoes normalized body `page`; Human/Both/Unassessed report page 1 until a cursor is supplied, then echo normalized `page`. | `EVD-0003`, `EVD-0005`, `EVD-0009` |
| Count exactness | Unfiltered counts read named summary rows. Dynamic filters execute exact `COUNT(DISTINCT serving.article_id)` over the same project, config hash, snapshot, list mode, date/status/posting/search/queue predicates. Counts are not approximate. The count-only HTTP route converts all failures to zero plus `error`; list routes throw count failures. | `EVD-0004`, `EVD-0009` |
| Filter exactness | Review facets use four named facet definitions; Human facets use two. Options are identity-scoped and bounded to 512. Rejected facet/option reads become empty arrays; a wholly missing manifest returns empty arrays and `searchScope.availability:"unavailable"`. | `EVD-0003`, `EVD-0010` |
| Snapshot selection | List and filter services request the active manifest for the exact review-config hash, otherwise the last-known-good manifest, and pass its snapshot and component identities to every reader. Bulk jobs persist latest or explicit pinned semantics; export pins may include expiry. | `EVD-0005`, `EVD-0009`, `EVD-0012` |
| `requireReadySnapshot` behavior | Admission accepts `ready`; it also accepts `stale` only when the caller explicitly passes `allowStale:true`. Current list/filter services do pass that flag after selecting last-known-good. Candidate is `indexing`; failed or missing is `unavailable`; those states reject foreground reads. The behavior name therefore does not mean stale is impossible. | `EVD-0004`, `EVD-0005`, `EVD-0009` |
| `allowStaleSnapshot` behavior | Health/warning contracts do not reject on freshness alone, but the reader still requires a resolvable project manifest. Warning treats active and retired manifests as usable and exposes readable/usable/status diagnostics. Health has equivalent source behavior but is not mounted. | `EVD-0005`, `EVD-0011` |
| Search unavailable behavior | Synchronous substring search is rejected. Token-prefix search requires `searchState.ready` bound to the same snapshot. Substring contracts represent asynchronous job criteria/state. | `EVD-0004`, `EVD-0005` |
| Cursor validity | A cursor is versioned and rejected on malformed schema, contract, filter signature, review-config hash, snapshot, component base generation, patch watermark, projection identity, sort direction/key, or sort arity mismatch. | `EVD-0005`, `EVD-0006` |
| Existing retry behavior | Human/Both/Unassessed database reads retry only the message containing `An unknown error occurred in Effect.tryPromise`, with at most four attempts and delays of 100, 250, and 500 ms. No retry or fallback was added by this audit, and benchmark evidence must disclose this behavior. | `EVD-0009` |
| Response-budget tiers | Per-reader contracts enforce the matrix above. Synthetic route-parity cases separately cap direct reader latency at 1,000 ms and result/current-behavior bytes at 50,000. The Phase-6 workload separately caps global p95 at 2,000 ms and p99 at 5,000 ms. None is evidence of full serialized HTTP response size unless the later route benchmark measures that boundary. | `EVD-0003`, `EVD-0007`, `EVD-0013` |

### Benchmark-Critical Configuration Freeze

A value marked `pending` is not permission to choose a convenient value. The
first approved physical run must supply it once and later comparisons must use
the same recorded identity. Repository defaults are evidence about resolution
logic, not approval of a benchmark value.

| Configuration dimension | Frozen value or exact absence | proofCheckState | Missing evidence / owner question |
| --- | --- | --- | --- |
| Full fixture kind and scale | `synthetic10m7PromptOverlap`: 10,000,000 articles, 7 prompts, 70,000,000 article-prompt overlap rows; completed schema projectors required. | `satisfied` | None for scale. |
| Workload | `reviewServing.10m7PromptOverlap.v1`, 31 operations, all 15 declared release scopes, Phase 6 release gate, `requiredForPhase0:false`. | `satisfied` | None for the repository-declared workload shape. |
| Smoke fixture | `smoke`: 12 articles, 2 prompts, 24 overlap rows, no completed projectors. Observations are mocked/canned; it is contract validation, not physical evidence. | `satisfied` | None, provided it is never labeled a physical baseline. |
| Seed | No seed field, generator, or value is defined by the fixture, workload, release context, script, or benchmark test found by `CMD-0014`. | `pending` | Record a deterministic generator/version and seed; `OQ-0005`. |
| Model | No model ID, remote model ID, version, or execution identity is fixed in the benchmark fixture or release report. | `pending` | Record exact immutable model identity; `OQ-0005`. |
| Provider | No provider kind or provider-connection identity is fixed. | `pending` | Record provider kind and immutable connection/execution identity without secrets; `OQ-0005`. |
| Thinking level/options | No thinking effort or provider options are fixed. | `pending` | Record the exact normalized thinking/options identity; `OQ-0005`. |
| Prompts | Only `promptCount:7` is fixed. Prompt IDs, order, text/hash, type, thresholds/criteria, enabled/archive state, and answer options are absent. | `pending` | Approve and hash the seven-prompt set; `OQ-0005`. |
| Content flags | The production identity dimensions are `useTitle`, `useAbstract`, `useFulltext`, and `useFulltextNoImages`, but the benchmark fixes no values. | `pending` | Approve all four booleans; `OQ-0005`. |
| DuckDB memory limit | A physical release report requires a valid explicit unit-bearing string, but no value is pinned. The audit shell had no override; empty-environment runtime defaults resolve `SERVER_ROLE=auto` to `6400MiB` on this macOS host. The smoke report instead records `not-set-synthetic-validation`. None is adopted as the physical benchmark value. | `pending` | Approve one explicit release value; `OQ-0005`. |
| Runtime profile and role | `dev:server` uses runtime profile `primary`; an unset profile resolves to `local`. The audit shell had no profile/role override. `ReviewServingBenchmarkReleaseContext` records neither runtime profile nor server role. | `pending` | Approve and add immutable evidence for profile, role, process topology, and runtime version; `OQ-0005`. |
| Snapshot identity | Physical release context requires project, review-config, snapshot, manifest, count, and search identities; synthetic smoke creates labeled synthetic identities. | `pending` | Supply approved immutable physical identities; `OQ-0002`, `OQ-0005`. |
| Retry/fallback policy | Reader contracts forbid temp spill; synchronous substring is unavailable; failures may not be converted to weaker benchmark settings. Existing route-specific retry and last-known-good behavior is frozen in the semantics table and must be visible in results. | `satisfied` | Product approval of the existing retry/count-error behavior remains `OQ-0008`. |

### Timing Boundaries

No current physical timing is claimed. Future evidence must emit these as
separate fields; summing or overlapping them without raw timestamps is invalid.

| Timing field | Start | Stop | Included | Explicitly excluded | Current evidence state |
| --- | --- | --- | --- | --- | --- |
| `sourceSeedOrImportMs` | Fixture generator/import begins writing authoritative source rows. | Final source transaction/checkpoint required by the fixture commits. | Source generation, parsing, and authoritative writes. | Projector/rebuild queue wait or work; route reads. | Definition fixed; value `pending`. |
| `projectionOrRebuildMs` | Rebuild request is durably accepted or the first projection work item starts; record both timestamps when queue wait exists. | Required components publish the active snapshot and manifest identities used by reads. | Queue wait as a separate subfield, projection/rebuild work, publication. | Source import/seeding; foreground route reads. | Definition fixed; value `pending`. |
| `foregroundRouteReadMs` | After request parsing, immediately before route admission/current-behavior read; later reports must also record end-to-end HTTP time separately. | Reader result and required bounded hydration/count work complete; serialized HTTP completion is a separate measurement. | Admission, snapshot/diagnostic reads, candidate query, bounded hydration/count work, and disclosed retries. | Source seeding/import, projection/rebuild, async job execution. | Per-reader synthetic timing exists; physical and HTTP values `pending`. |

The current smoke harness accepts `latencyMs` observations embedded in its
work items and does not time source seeding or projection. Its release report
therefore cannot satisfy these three physical timing fields. Phase-6 scope tags
named `import`, `dirtyMaterialization`, and `servingRefresh` do not change that.

### Metric Definitions And Budgets

| Metric | Exact current definition | Gate |
| --- | --- | --- |
| Latency percentiles | Nearest-rank over all sample `latencyMs` values: sort ascending and choose `ceil(n*p)-1`; empty set is 0. Per-operation p95/p99 use the same function. | Global p95 <= 2,000 ms; p99 <= 5,000 ms. |
| Memory | `startRssBytes` and `endRssBytes` sample `process.memoryUsage().rss`; `peakRssBytes` is the maximum of start, end, and sample RSS. Growth is end minus start in validation. | Peak <= 20 GiB; growth <= 4 GiB. |
| Queue depth | Average of sample queue depths rounded to two decimals; peak is maximum, empty set 0. | Recorded; workload-shape validation requires nonnegative values. |
| Rows | `rowsReturned` and `rowsScanned` are sums across samples; each operation also enforces its declared page and max-scanned rows. | No returned row above operation page; no scanned row above operation cap. |
| Temp usage | Peak and total of sample `tempUsageBytes`; release context separately records `tempDirGrowthBytes`. | Every accepted foreground sample must be zero spill; growth must be nonnegative. |
| Work | Counts admitted, rejected, and total samples from admission results. | Recorded and validated; benchmark-critical failures remain failures. |
| Response bytes | Contract `maxEstimatedResultBytes` is admission metadata; parity uses UTF-8 byte length of JSON reader rows with a 50,000-byte synthetic cap. | Later HTTP evidence must separately measure serialized route bytes against an owner-approved route budget. |

### Approved Evidence Tooling

| Tool/evidence class | Approved use | Not approved in this story |
| --- | --- | --- |
| Repository source inspection (`rg`, `sed`, Bun imports that only enumerate constants) | Exact symbols, route composition, contract/config values, and registry diffs. | Runtime or physical claims. |
| Targeted `bun test` suites in `EVD-0015` | Static/fixture corroboration of contract completeness, parity registration, and benchmark validation logic. | Production reachability or physical performance by themselves. |
| `bun run bench:review-serving-smoke` | Synthetic contract/report validation only; its observations and identities are mocked. | Baseline database size, real route latency, RSS, spill, seed time, or projection time. |
| `bun run bench:review-serving-release-gate` | Repository gate wiring; it currently runs tests plus smoke. | A claim of `releaseScaleDuckDb` evidence without a separately approved physical run/report. |
| `bun run db:query:snapshot -- --sql="..."` or an immutable approved snapshot artifact | Later designated measurement stories only, after snapshot identity and fixed config are approved and recorded. | Not run in US-002; never point it at or substitute it for an unapproved/live writer state. |
| Isolated disposable physical fixture | Later story explicitly authorizes mutation and records scale, seed, critical config, timing boundaries, and cleanup. | Live project data, silent retries/downgrades, or value substitution. |
| Direct DuckDB CLI, direct live-file open, server/projector/migration/maintenance commands | None for US-002. | Explicitly prohibited. |

### US-002 Proof Checks

| rowId | Check | proofCheckState | Evidence IDs | Missing evidence / blocker | Owner question IDs |
| --- | --- | --- | --- | --- | --- |
| `PRF-0001` | Every repository-declared read contract has exact filters, counts, order, cursor, freshness, search/access, and budgets recorded. | `satisfied` | `EVD-0003`, `EVD-0004`, `EVD-0005`, `EVD-0006` | None for source enumeration. | — |
| `PRF-0002` | Declared mounted routes agree with actual product composition and route registry. | `blocked` | `EVD-0001`, `EVD-0002`, `EVD-0008` | `API-0017` health mount conflict; `BLK-0004`. | `OQ-0006` |
| `PRF-0003` | Fixture scale and workload identity are immutable and exact. | `satisfied` | `EVD-0013`, `EVD-0015` | None for scale/workload. | — |
| `PRF-0004` | Seed, model, provider, thinking, prompt set, content flags, memory limit, runtime profile/role, and physical snapshot identity are fixed. | `pending` | `EVD-0013`, `EVD-0014` | Values are absent; `BLK-0002`. | `OQ-0002`, `OQ-0005` |
| `PRF-0005` | Metrics and the three non-overlapping time boundaries are defined. | `satisfied` | `EVD-0013`, `EVD-0016` | Definitions are fixed; physical values remain future evidence. | — |
| `PRF-0006` | Source seeding, projection/rebuild, and foreground route-read values exist for the approved fixture. | `pending` | `EVD-0013`, `EVD-0016` | Smoke has canned route observations and no separate seed/projection time; `BLK-0005`. | `OQ-0009` |
| `PRF-0007` | Evidence tooling cannot be mistaken for direct live-DuckDB inspection or physical proof. | `satisfied` | `EVD-0013`, `EVD-0014`, `EVD-0016` | None for the tooling boundary. | — |
| `PRF-0008` | Route inventory, parity inventory, production job kind/search mode, and adjacent flow closures agree. | `pending` | `EVD-0002`, `EVD-0007`, `EVD-0008`, `EVD-0012` | Registry gaps and add-by-filter mismatch; `BLK-0006`. | `OQ-0007` |

No `DSP-####`, `TGT-####`, or `SLC-####` row is changed by these proof
checks. No move, derive, archive, or delete recommendation is strengthened.

## Recommendation Proof Gate

Create separate `PRF-####` rows for positive and negative proof. For a move,
derive, archive, or delete recommendation, the minimum domains are:

| Domain | Required proof |
| --- | --- |
| API and UI/runtime | Every mounted and shared browser/desktop behavior is preserved, replaced, or proven unrelated. |
| Writer | Every direct, generated, registry-driven, or script writer and invalidation input is traced. |
| Lifecycle | Create, update, publish, pin, retire, orphan, and cleanup behavior is traced. |
| Recovery | Replay, restart, repair, startup probe, audit-history, and disaster-recovery roles are preserved or proven absent. |
| Export | Project export, PDF/bulk hydration, and other exports are preserved or proven unrelated. |
| Transfer | Transfer-package write/read mappings and compatibility needs are preserved or proven unrelated. |
| Retention | Active, failed, last-known-good, pinned, historical, and terminal retention is explicit. |
| Snapshot consistency | Identity, cursor, ordering, count, freshness, and pin semantics remain exact. |
| Benchmark and parity | Same-fixture semantics and budgets pass without retry, fallback, spill, or settings changes. |
| Migration/backfill | Replacement ownership, bounded cutover/backfill, rollback/recovery, and cleanup are explicit. |
| Bounded reads | No foreground path regresses to a project-scale scan or unbounded hydration. |

Any applicable `pending` proof keeps
`recommendationActionability: unresolved`; any applicable `blocked` proof
sets it to `blocked`. Search absence, a test-only guard, historical migration,
or baseline size alone cannot strengthen a recommendation.

## Required Audit Outputs

### Output 01 - API Surface Inventory

Authoritative row family: `API-####`. Record one row per mounted route or
explicit read-contract entry point, including method/query key, inputs, output
fields, ordering, filters, counts, cursors, exactness/freshness, candidate
selection, bounded hydration, query count, owner, and exact tests. Cross-link
each row to `MAP-####`, `UIR-####`, `LIN-####`, and evidence IDs.

Current state: scaffolded. The inherited API list below is discovery input and
must be re-adopted row by row with exact mounting and contract citations.

### Output 02 - Route-To-Query And Route-To-Table Map

Authoritative row family: `MAP-####`. Map each `API-####` or `BGO-####`
entry point to exact reader/query-builder symbols, SQL shapes, tables,
columns/indexes, statement counts, pre-limit work, bounded hydration, and
snapshot/freshness reads. Cross-link UI consumers and lineage rows.

Current state: scaffolded; no inherited route-to-query claim is certified.

### Output 03 - Full Schema, Temporary, And File Census

Authoritative row families: `DBO-####` and `CMF-####`. Include every relevant
current table, material column/JSON key, index expression, constraint,
sequence-like identity, temporary-table pattern, payload directory, generated
file, export artifact, transfer package, backup, and snapshot. Record the final
declaration plus forward migrations, separating production from non-production
references.

Current state: scaffolded. The inherited schema census is a discovery backlog,
not proof that the census is exhaustive or current.

### Output 04 - Column-Level Data Lineage Matrix

Authoritative row family: `LIN-####`. Trace source-of-truth, transform,
persisted copies, API/UI consumers, producer and invalidation, pre-limit and
post-limit use, snapshot identity, export/transfer use, lifecycle, and exact
evidence for every `CMF-####` row.

Current state: scaffolded; inherited column-family observations are provisional.

### Output 05 - Table, Index, And Lifecycle Inventory

Authoritative row family: `TLI-####`. For each `DBO-####`, record key and
owner, production producers/consumers, the real predicate/order path for each
index, create/update/invalidate/publish/pin/retire/delete events, replay/repair
role, retention horizon, orphan handling, and non-production references.

Current state: scaffolded.

### Output 06 - Row Fan-Out And Duplicate-Byte Report

Authoritative row family: `FAN-####`. Record the row formula and every
article-, project-, prompt-, list-mode-, filter-value-, and snapshot-scaling
factor. Keep logical payload bytes, index cost/bytes, WAL bytes, temporary
spill, and physical database bytes separate. Measurements require
`approved-snapshot` evidence and fixed benchmark configuration.

Current state: scaffolded; inherited qualitative width observations are not
physical measurements.

### Output 07 - Storage Disposition Matrix

Authoritative row family: `DSP-####`. Give every table and material column
family exactly one provisional or revised disposition, product/query-budget
reason, bounded replacement when applicable, evidence IDs, proof IDs, and
`recommendationActionability`. A `classified` manifest row is necessary but
not sufficient for an actionable disposition.

Current state: scaffolded. Every disposition in the inherited material is
provisional and `unresolved` pending adoption into this matrix.

### Output 08 - Move/Delete Candidates And Proof Requirements

Authoritative row family: `PRF-####`, cross-referenced from `DSP-####`.
Record separate positive and negative checks for every applicable proof domain,
each with `proofCheckState`, evidence IDs, missing evidence, blockers, and
owner-question IDs.

Current state: scaffolded. The inherited candidate list is preserved but is not
certified and must not drive implementation.

### Output 09 - Candidate Target Shapes

Authoritative row family: `TGT-####`. Record ownership and identity, exact
columns/keys/indexes, read SQL shape, write fan-out, invalidation, publication,
retention, recovery, browser/desktop consequences, migration/backfill, cleanup,
and linked parity/benchmark proof.

Current state: scaffolded; inherited target-shape prose is provisional.

### Output 10 - Prioritized Implementation Slices With Benchmark Gates

Authoritative row family: `SLC-####`. Each slice names touched layers,
dependencies, exact changes, migration/cutover and cleanup, rollback/recovery,
fixed benchmark configuration, semantic parity gates, resource budgets, and
repo-native commands. A slice can be implementation-ready only when every
linked recommendation is `actionable`.

Current state: scaffolded. No implementation slice is certified actionable
while `overallCertification` is `INCOMPLETE`.

### Output 11 - Exhaustive Coverage Manifests

The five append-only manifests below are authoritative for discovery and
reconciliation. Narrative inventories and derived output tables must
cross-reference their stable IDs.

## Coverage Manifest 01 - Mounted API And Read Contracts

| rowId | Surface | Mounted method/route or contract entry | Response contract | Owning service | Exact tests | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `API-0001` | LLM list/count/badges/search | `POST /api/articlesreviews` | List envelope and row fields in the US-002 route table. | `getLlmReviewArticlesFromServing` | `reviewServingLlmReviewRouteService.test.ts` — `LLM review list route service composes serving rows, judgments, and count without raw fallback SQL` | `EVD-0001`, `EVD-0002`, `EVD-0009` | `traced-to-api` | Browser/desktop field consumption, writer/lifecycle lineage, and physical HTTP response budget remain untraced. | `OQ-0008` |
| `API-0002` | LLM count | `POST /api/articlesreviewscount` | Count success or zero-plus-error fallback. | `countLlmReviewArticlesFromServing` | `projectsRoutesGetArticlesReviewsCount.test.ts` — `articles reviews count logs missing review serving snapshot as warning` | `EVD-0001`, `EVD-0002`, `EVD-0009` | `traced-to-api` | Owner approval of zero-on-error semantics, UI handling, lineage, and physical route budget is missing. | `OQ-0008` |
| `API-0003` | Human list | `POST /api/articlesreviewshuman` | Human list envelope and judgment fields. | `getHumanReviewArticlesFromServing` | `reviewServingHumanBothUnassessedRouteService.test.ts` — `human review route service uses serving rows, human payload hydration, and count without raw fallback` | `EVD-0001`, `EVD-0002`, `EVD-0009` | `traced-to-api` | Browser/desktop field consumption, writer/lifecycle lineage, retry approval, and physical budget are missing. | `OQ-0008` |
| `API-0004` | Both list | `POST /api/articlesreviewsboth` | Combined LLM/Human list envelope. | `getBothReviewArticlesFromServing` | `reviewServingHumanBothUnassessedRouteService.test.ts` — `both review route service hydrates LLM and human payloads in bounded article-set reads` | `EVD-0001`, `EVD-0002`, `EVD-0009` | `traced-to-api` | Browser/desktop field consumption, writer/lifecycle lineage, retry approval, and physical budget are missing. | `OQ-0008` |
| `API-0005` | Unassessed list/queue | `POST /api/articlesreviewsunassessed` | Unassessed list envelope with empty judgments. | `getUnassessedReviewArticlesFromServing` | `reviewServingHumanBothUnassessedRouteService.test.ts` — `unassessed review route service pages filtered distinct article rows and queue count` | `EVD-0001`, `EVD-0002`, `EVD-0009` | `traced-to-api` | Browser/desktop field consumption, queue lifecycle, retry approval, and physical budget are missing. | `OQ-0008` |
| `API-0006` | Review filters/facets/options | `GET /api/articlesreviewsfilters` | Filter response and empty/unavailable response. | `getReviewFiltersFromServing` | `reviewServingFilterRouteService.test.ts` — `review filter route service reads facet and option contracts without raw fallback SQL` | `EVD-0001`, `EVD-0002`, `EVD-0010` | `traced-to-api` | UI consumed/ignored fields, projector/lifecycle lineage, and physical HTTP budget are missing. | `OQ-0008` |
| `API-0007` | Human filters/facets/options | `GET /api/articlesreviewshumanfilters` | Filter response plus Human mode. | `getReviewFiltersFromServing` | `projectsRoutesGetArticlesReviewsHumanFilters.test.ts` — `articles reviews human filters returns overall summary filter in summary mode` | `EVD-0001`, `EVD-0002`, `EVD-0010` | `traced-to-api` | UI consumed/ignored fields, projector/lifecycle lineage, and physical HTTP budget are missing. | `OQ-0008` |
| `API-0008` | Review detail | `POST /api/projectsreview` | Ready detail object or structured unavailable object. | `projectsRoutesPostArticleReviewDetails` | `projectsRoutesPostArticleReviewDetails.test.ts` — `project review details hydrates article, judgments, and assessments from V4 detail contracts` | `EVD-0001`, `EVD-0002`, `EVD-0011` | `traced-to-api` | Browser/desktop consumption, residual app-read lineage, export/recovery role, and physical response budget are missing. | `OQ-0008` |
| `API-0009` | Warning/progress | `POST /api/projectsreviewswarnings` | Warning/indexing/freshness/serving diagnostics. | `projectsRoutesGetReviewsWarnings` | `projectsRoutesGetReviewsWarnings.test.ts` — `reviews warnings report ready when serving rows are fresh` | `EVD-0001`, `EVD-0002`, `EVD-0011` | `traced-to-api` | Browser/desktop consumption, repair mutation/lifecycle lineage, and physical poll budget are missing. | `OQ-0008` |
| `API-0010` | Prompt preview | `GET /api/projects/:id/prompts/:promptId/preview` | Ready prompts or explicit unavailable reason. | `projectsRoutesGetPromptPreview` | `reviewServingRouteParityEvidence.test.ts` — `route parity evidence runs real readers for every mounted coverage contract` | `EVD-0001`, `EVD-0002`, `EVD-0011` | `traced-to-api` | Route-specific HTTP test, UI consumption, residual reads, and physical response budget are missing. | `OQ-0008` |
| `API-0011` | Filtered PDF job | `POST /api/articles/pdf-fetch-by-filter` | 202 durable job metadata. | `articlesRoutes`, `createReviewBulkOperationJob` | `ArticlesRoutes.test.ts` — `PDF filter route gives repeated filter jobs durable request identities` | `EVD-0002`, `EVD-0007`, `EVD-0012` | `traced-to-api` | UI caller, worker lifecycle/recovery, status polling, and physical foreground budget remain untraced. | `OQ-0007`, `OQ-0008` |
| `API-0012` | Add by filter | `POST /api/projects/add_articles_by_filter` | 202 pending job metadata. | `projectsAddArticlesRoutes`, `createReviewBulkOperationJob` | `reviewServingReadContracts.test.ts` — `add-articles filter inventory maps to the mounted bulk selection route` | `EVD-0002`, `EVD-0007`, `EVD-0012` | `traced-to-api` | Contract key versus production job/search semantics, UI caller, worker lifecycle, and physical budget are unresolved. | `OQ-0007`, `OQ-0008` |
| `API-0013` | Project PDF job | `POST /api/articles/pdf-fetch-by-project` | 202 durable job metadata. | `articlesRoutes`, `createReviewBulkOperationJob` | `ArticlesRoutes.test.ts` — `PDF project route preserves date-only upper bounds and request identity in criteria` | `EVD-0002`, `EVD-0007`, `EVD-0012` | `traced-to-api` | UI caller, worker lifecycle/recovery, status polling, and physical foreground budget remain untraced. | `OQ-0007`, `OQ-0008` |
| `API-0014` | Explicit-ID PDF job | `POST /api/articles/pdf-fetch-bulk` | 202 durable article-ID-only job metadata. | `articlesRoutes`, `createReviewBulkOperationJob` | `ArticlesRoutes.test.ts` — `PDF explicit bulk route admits durable article-id-only jobs` | `EVD-0002`, `EVD-0007`, `EVD-0012` | `traced-to-api` | UI caller, cap boundary parity, worker lifecycle/recovery, and status polling remain untraced. | `OQ-0007`, `OQ-0008` |
| `API-0015` | Export job | `POST /api/projects/:id/export` | 202 export job/contract or explicit 400 errors. | `projectExportRoutes`, `createReviewBulkOperationJob` | `ProjectExportRoutes.test.ts` — `project export creates a durable serving export job with explicit IDs and metadata contract` | `EVD-0002`, `EVD-0007`, `EVD-0012` | `traced-to-api` | UI caller, worker/pin/retention/recovery lifecycle, download parity, and physical budget remain untraced. | `OQ-0007`, `OQ-0008` |
| `API-0016` | Internal postings contract | `POST /api/review-serving/filter-postings` (`mounted:false`) | No HTTP response; contract documentation only. | `reviewServingReadContractRouteInventory` | `reviewServingReadContracts.test.ts` — `migrated filter posting and facet contracts are mounted for production routes` | `EVD-0002`, `EVD-0003` | `traced-to-api` | Owner decision on continued internal-only status plus writer/lifecycle and production-consumer lineage is missing. | `OQ-0007` |
| `API-0017` | Health snapshot | Conflicting `POST /api/projectsreviewshealth` declaration | Source-only health object; no reachable HTTP contract. | Uncomposed `projectsRoutesGetReviewsHealth` | `reviewServingReadContracts.test.ts` — `health and prompt preview inventories map only to mounted product routes` (corroborates the stale declaration, not actual composition) | `EVD-0001`, `EVD-0002`, `EVD-0007`, `EVD-0008`, `EVD-0011` | `blocked` | Mount truth conflicts with inventory/parity and must be resolved before UI/runtime, lifecycle, or route budget proof. | `OQ-0006` |
| `API-0018` | Add by IDs | `POST /api/projects/add_articles_by_ids` | 202 pending job metadata with provided total. | `projectsAddArticlesRoutes` | `ProjectsAddArticlesRoutes.test.ts` — `add articles by ids creates a durable article-id-only job` | `EVD-0007`, `EVD-0008`, `EVD-0012` | `traced-to-api` | Read-contract mapping, UI caller, worker lifecycle/recovery, and cap parity are missing. | `OQ-0007`, `OQ-0008` |
| `API-0019` | PDF job status | `GET /api/articles/pdf-fetch-jobs/:jobId` | Durable `{job}` lookup. | `articlesRoutes`, `getPdfFetchJobFromDatabase` | `reviewServingRouteParityEvidence.test.ts` — `job parity evidence maps every gate to executable verification tests` | `EVD-0007`, `EVD-0008`, `EVD-0012` | `traced-to-api` | Read-contract mapping, exact route test/404 status, UI polling, retention, and physical poll budget are missing. | `OQ-0007`, `OQ-0008` |
| `API-0020` | Add job status | `GET /api/projects/add_articles_jobs` | Success job/target metadata or thrown missing error. | `projectsAddArticlesRoutes`, `getAddArticlesJob` | No exact route test identified. | `EVD-0008`, `EVD-0012` | `traced-to-api` | Contract/parity registration, route test, UI polling, retention, and physical poll budget are missing. | `OQ-0007`, `OQ-0008` |
| `API-0021` | Export job status | `GET /api/projects/:id/export/:jobId` | Success status/download URL or 404 error. | `projectExportRoutes`, `getExportJob` | `ProjectExportRoutes.test.ts` — export job creation/download tests do not isolate this status response. | `EVD-0008`, `EVD-0012` | `traced-to-api` | Contract/parity registration, exact status-route test, UI polling, retention, and physical poll budget are missing. | `OQ-0007`, `OQ-0008` |
| `API-0022` | Export download | `GET /api/projects/:id/export/:jobId/download` | 404/409 error or streamed CSV. | `projectExportRoutes`, `buildExportCsvStream` | `ProjectExportRoutes.test.ts` — `project export download hydrates completed durable job selection as CSV` | `EVD-0008`, `EVD-0012` | `traced-to-api` | Contract/parity registration, browser/desktop download behavior, pin/retention/recovery, and physical stream budget are missing. | `OQ-0007`, `OQ-0008` |
| `API-0023` | Prompt export | `POST /api/projects/:id/export-prompts` | 400 missing selection or streamed prompt CSV. | `projectExportRoutes`, `buildPromptInfoCsv` | No exact route test identified. | `EVD-0008`, `EVD-0012` | `traced-to-api` | Contract/parity registration, route test, UI/download behavior, and physical response budget are missing. | `OQ-0007`, `OQ-0008` |

## Coverage Manifest 02 - UI And Runtime Consumption

| rowId | Caller/query key | API surface IDs | Consumed fields | Ignored fields | Browser/desktop applicability | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. Browser, desktop, export, PDF, bulk, warning, and
progress consumers remain to be baselined._

## Coverage Manifest 03 - Background And Operator Surfaces

| rowId | Entry point/owner | Read objects | Written objects | Lifecycle role | Recovery role | Exact tests | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. Projectors, workers, schedulers, startup probes,
repair/recovery, retention, import/export/transfer, migrations, scripts, and
operator tools remain to be baselined._

## Coverage Manifest 04 - DuckDB Schema And Persisted Objects

| rowId | Object/kind | Key/index/path shape | Owner | Final declaration and forward migrations | Production refs | Non-production refs | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. Tables, indexes, temporary patterns, payload
directories, generated files, exports, transfers, backups, and snapshots remain
to be baselined without inspecting live DuckDB._

## Coverage Manifest 05 - Columns And Material Fields

| rowId | Object ID | Column/JSON key/material field | Producer | Consumers | Pre-limit use | Post-limit use | Lifecycle | Provisional disposition | Proof IDs | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

_No normalized rows yet. Later census stories must append one row per material
field rather than grouping fields with different producers, consumers, or
lifecycles._

## Reconciliation Summaries

For every manifest family `F`, calculate:

```text
discovered_F = count(all manifest rows in F)
classified_F = count(rows where auditStatus = classified)
out_of_scope_F = count(rows where auditStatus = out-of-scope)
blocked_F = count(rows where auditStatus = blocked)
nonterminal_F = discovered_F - classified_F - out_of_scope_F - blocked_F
required balance: discovered_F = classified_F + out_of_scope_F + blocked_F
```

The required balance is true only when `nonterminal_F = 0`. A balanced family
with `blocked_F > 0` is reconciled for accounting but still prevents
`overallCertification: PASS`. Indexes and payload/file shapes are typed
subsets of the `DBO-####` manifest and require separate summary rows.

| Family | Discovered | Classified | Out of scope | Blocked | Nonterminal | Required balance | Baseline state |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Mounted API/read contracts | 23 | 0 | 0 | 1 | 22 | `23 != 0 + 0 + 1` | US-002 route/registry union baselined; mount conflict and downstream evidence remain |
| UI/runtime consumers | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| Background/operator surfaces | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| DuckDB/persisted objects | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| Columns/material fields | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| Indexes (DBO subset) | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |
| Payload/file shapes (DBO subset) | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |

The remaining bootstrap zeros count only normalized rows. They are not evidence
that the repository has no surfaces or objects; `BLK-0001` prevents that
interpretation. The API family now counts the 23 US-002 rows above and remains
unbalanced because 22 are nonterminal and one is blocked. Each later story must
update affected counts with its rows.

## Commands And Skipped Checks

Record discovery, verification, approved-snapshot, and explicitly skipped
commands. A command proves only the claim linked through its evidence record.

| rowId | Date/story | Exact command or skipped check | Purpose | Result/evidence |
| --- | --- | --- | --- | --- |
| `CMD-0001` | 2026-07-21 / US-001 | `sed -n '1,260p' REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md` and `sed -n '260,620p' REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md` | Read the complete source strategy, including outputs, manifests, and gates. | Framework requirements extracted; repository files only. |
| `CMD-0002` | 2026-07-21 / US-001 | `sed -n '1,320p' .ralph-tui/progress.md` | Read tracker status and prior learnings. | No prior story implementation recorded. |
| `CMD-0003` | 2026-07-21 / US-001 | `sed -n '1,360p' STORAGE_SHAPE_AUDIT_PLAN.md` and `sed -n '300,620p' STORAGE_SHAPE_AUDIT_PLAN.md` | Inspect and preserve the inherited audit artifact. | Existing evidence and provisional recommendations identified. |
| `CMD-0004` | 2026-07-21 / US-001 | `bun run lint` | Run the repo-native lint gate. | Failed on six pre-existing formatting/import-order errors in `src/server/workers/comparisonProjectServingMaintenanceWorker.ts`, `src/server/workers/reviewServingProjectorWorker.test.ts`, and `src/server/workers/reviewServingProjectorWorker.ts`; US-001 does not touch `src/`, and unrelated lint was not fixed. |
| `CMD-0005` | 2026-07-21 / US-001 | `test "$(rg -c '^### Output [0-9]{2} -' STORAGE_SHAPE_AUDIT_PLAN.md)" -eq 11 && test "$(rg -c '^## Coverage Manifest [0-9]{2} -' STORAGE_SHAPE_AUDIT_PLAN.md)" -eq 5` | Verify required section cardinality. | Passed: eleven outputs and five manifests. |
| `CMD-0006` | 2026-07-21 / US-001 | `git diff --check -- STORAGE_SHAPE_AUDIT_PLAN.md` | Check patch whitespace. | Passed. |
| `CMD-0007` | 2026-07-21 / US-001 | `bun run typecheck` (skipped) | Typecheck gate. | `package.json` has no `typecheck` script, and US-001 changes no typed source. |
| `CMD-0008` | 2026-07-21 / US-001 | `bun test` and `bun run build` (skipped) | Runtime test/build gates. | Docs-only framework; no code, route, UI, browser, or desktop behavior changed. |
| `CMD-0009` | 2026-07-21 / US-001 | `bun run db:mig` and all DuckDB inspection commands (skipped) | Schema/data gates. | Schema and data mutation are out of scope; live DuckDB inspection is prohibited. |
| `CMD-0010` | 2026-07-21 / US-002 | `rtk sed -n '1,620p' REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md`; `rtk sed -n '1,320p' .ralph-tui/progress.md`; `rtk sed -n '1,260p' tasks/prd.json` | Read the Phase-0 contract/config prerequisite, prior progress, and story state. | US-001 was complete; US-002 had no prior normalized result. |
| `CMD-0011` | 2026-07-21 / US-002 | Source-only `rtk rg -n` and `rtk sed -n` inspection of every exact production locator in `EVD-0001`, `EVD-0004`-`EVD-0006`, and `EVD-0009`-`EVD-0012` | Trace actual plugin composition, route response semantics, reader admission, cursors, retries, and job flows without starting a server or opening DuckDB. | Exact source behavior is recorded in the route, read-contract, exactness, and failure-semantics tables; no runtime state was touched. |
| `CMD-0012` | 2026-07-21 / US-002 | Source-only `rtk bun -e` imports of `reviewServingReadContractRouteInventory` and `reviewServingReadContractList` from `src/server/reviewServing/reviewServingReadContracts.ts` | Enumerate registry cardinality and all serializable contract fields without executing a reader. | 17 route entries, 16 declared mounted, and 36 contracts; every contract has a 5,000 ms timeout and `allowsTempSpill:false`. |
| `CMD-0013` | 2026-07-21 / US-002 | Source-only `rtk bun -e` set comparison of `reviewServingReadContractRouteInventory`, `reviewServingRouteParityCoverage`, `reviewServingJobParityCoverage`, and `routeSurfaceRoutes` | Reconcile declared mounting, parity, and public route registry. | Counts: 17 inventory entries, 16 declared mounted, 11 route-parity, 7 job-parity, 18 parity-union. Declared-mounted minus route surface is only health; parity minus mounted inventory is add-by-ID and PDF-job status. |
| `CMD-0014` | 2026-07-21 / US-002 | Source-only `rtk rg -n` plus `rtk bun -e` imports of `reviewServingSynthetic10m7PromptOverlapFixture` and `reviewServingBenchmarkOverlapWorkloadDefinition` from `src/server/reviewServing/reviewServingBenchmark.ts` | Freeze fixture/workload scale, operations, scopes, metrics, targets, and exact missing critical settings. | Full fixture is 10M/7/70M with 31 operations and 15 scopes; smoke is 12/2/24 and mocked. Seed/model/provider/thinking/prompt identity/content flags and physical identities are absent. |
| `CMD-0015` | 2026-07-21 / US-002 | Source-only `rtk bun -e` call to `loadEnv({ envValues: {} })`, plus inspection of `package.json`, `duckdbMemoryDefaults.ts`, and `runtimeLogger.ts` | Distinguish resolver defaults and command wiring from approved benchmark values. | Audit shell overrides were unset; empty-environment resolution on this host was role `auto`, memory `6400MiB`, and profile `local`; `dev:server` wires `primary`. None was adopted as a physical benchmark value. |
| `CMD-0016` | 2026-07-21 / US-002 | `rtk bun test src/server/reviewServing/reviewServingReadContracts.test.ts src/server/reviewServing/reviewServingRouteParityCoverage.test.ts src/server/reviewServing/reviewServingRouteParityEvidence.test.ts src/server/reviewServing/reviewServingBenchmark.test.ts` | Run focused source-contract, parity, and synthetic benchmark tests. | Passed: 73 tests, 0 failures, 219 assertions. A preceding run that additionally named `src/server/routes/routeSurfaceInventory.test.ts` preserved 73 passes but failed before that file's tests because `appReadOnlyDatabaseService.ts` lacks the imported `getJudgeWorkerReadOnlyAppDatabaseService` export; source was not changed. |
| `CMD-0017` | 2026-07-21 / US-002 | `rtk bun run lint` | Run the repo-native lint gate. | Failed on the same six unrelated import-order/formatting errors previously recorded by US-001 in `comparisonProjectServingMaintenanceWorker.ts`, `reviewServingProjectorWorker.test.ts`, and `reviewServingProjectorWorker.ts`; no unrelated fix was made. |
| `CMD-0018` | 2026-07-21 / US-002 | Source-only `rtk bun -e` manifest invariant check; `rtk git diff --check -- STORAGE_SHAPE_AUDIT_PLAN.md .ralph-tui/progress.md` | Verify row/state cardinality, required evidence/question cells, and patch whitespace. | Manifest check passed: 23 API rows (22 `traced-to-api`, 1 `blocked`), 36 contracts, 16 evidence rows, 8 proof rows, no invalid status, and no empty missing-evidence/owner-question cells. Diff check passed. |
| `CMD-0019` | 2026-07-21 / US-002 | `bun run typecheck`, full `bun test`, `bun run build`, server/app/browser/desktop checks, both benchmark scripts, `bun run db:mig`, and every DuckDB inspection or mutation command (skipped) | Record non-applicable or prohibited checks. | No `typecheck` script exists. This story changes audit documentation only; focused tests cover imported source constants. Builds/runtime flows would not test Markdown. Benchmark runs cannot fill missing physical values, and database/server/projector/migration commands would violate story scope or the live-DuckDB prohibition. |

## Blockers

| rowId | Scope | Missing evidence | Why blocked | Owner question IDs | Resolution condition |
| --- | --- | --- | --- | --- | --- |
| `BLK-0001` | Five manifests and eleven outputs | The inherited narrative has not been re-censused into stable rows with exact production/non-production evidence. | Later inventory and lineage stories own that work; treating narrative bullets as reconciled would overstate proof. | `OQ-0001` | Populate all manifests, update counts, and reconcile every inherited discovery. |
| `BLK-0002` | Physical fan-out, width, lifecycle age, and benchmark proof | The repository fixes scale/workload but not seed, model, provider, thinking, prompt identities, content flags, physical DuckDB memory, runtime profile/role, or approved snapshot identity; no approved physical evidence is attached. | Live DuckDB inspection is prohibited and US-002 does not authorize fixture mutation or value substitution. | `OQ-0002`, `OQ-0005` | Record approval, every fixed value, immutable identity, collection command, and evidence ID in the designated measurement story. |
| `BLK-0003` | Inherited move/delete/retention candidates | Revised API, writer, lifecycle, recovery, export, transfer, and retention proof is absent. | Inherited evidence predates the normalized proof gate and cannot certify actionability. | `OQ-0003`, `OQ-0004` | All applicable proof checks are `satisfied` or evidence-backed `not-applicable`. |
| `BLK-0004` | Health route mount and parity | `POST /api/projectsreviewshealth` is declared mounted and parity-covered but is absent from product route composition and the public route registry. | Source evidence conflicts; test coverage trusts the stale declaration and cannot prove reachability. | `OQ-0006` | Product/API owner resolves the intended mount state and all registries/tests agree. |
| `BLK-0005` | Seeding, projection, and route-read physical timing | The smoke harness contains canned observations and no separate seed/import or projection/rebuild duration fields. | Phase-6 scope labels are not physical timestamps, and no approved fixture run exists. | `OQ-0009` | Approved physical report emits separate raw timestamps/durations for all three boundaries. |
| `BLK-0006` | Route registry and parity closure | Add-by-ID and PDF-job status are parity-only; four adjacent job/status/download routes are registry-only; add-by-filter production semantics disagree with its route-inventory contract mapping. | The current registries cannot be treated as one exhaustive, internally consistent contract source. | `OQ-0007` | Owners reconcile route inventory, parity coverage, production job/search semantics, and adjacent route scope. |

## Owner Questions

| rowId | Owner needed | Question | Unblocks |
| --- | --- | --- | --- |
| `OQ-0001` | Audit owner | Who signs off that discovery sources are exhausted and all five manifests reconcile, including aliases, generated SQL, registries, allowlists, scripts, and non-production references? | `BLK-0001` and final coverage certification |
| `OQ-0002` | Benchmark/data owner | Which isolated disposable fixture or immutable snapshot is approved, and what fixed scale, seed, model, provider, thinking level, prompts, content flags, memory limit, and runtime profile apply? | `BLK-0002` and physical proof |
| `OQ-0003` | Product/API owner | Which mounted browser/desktop behaviors, export/PDF/bulk flows, transfer mappings, and exact response semantics must approve any move, derive, archive, or delete candidate? | Product and transfer proof in `BLK-0003` |
| `OQ-0004` | Storage/recovery owner | What replay, repair, pin, last-known-good, failed-job, audit/export, cleanup, and retention horizons are mandatory for each candidate object? | Lifecycle, recovery, and retention proof in `BLK-0003` |
| `OQ-0005` | Benchmark owner | Who approves and records the immutable generator/seed, exact model/provider/thinking identity, seven-prompt identity, four content flags, DuckDB memory limit, runtime profile/role/topology/version, and snapshot identities for the first physical comparison? | `PRF-0004` and `BLK-0002` |
| `OQ-0006` | Product/API owner | Is `POST /api/projectsreviewshealth` intentionally public and mounted, or must its `mounted:true` and parity entries be removed/reclassified in a later implementation story? | `API-0017`, `PRF-0002`, and `BLK-0004` |
| `OQ-0007` | API/parity owner | Which registry is authoritative for add/PDF/export job creation, status, download, and prompt export, and should add-by-filter map to token-prefix `review.bulk.selection` rather than async-substring selection? | `API-0012`, `API-0018`-`API-0023`, `PRF-0008`, and `BLK-0006` |
| `OQ-0008` | Product/reliability owner | Are last-known-good stale reads, LLM count zero-plus-error fallback, the Human/Both/Unassessed four-attempt transient retry, and the recorded HTTP response fields the intended exact browser/desktop contract? | Nonterminal API rows and later semantic parity |
| `OQ-0009` | Benchmark/tooling owner | What approved instrumentation emits non-overlapping source seed/import, projection/rebuild queue/work/publication, per-reader, and end-to-end HTTP timing without changing runtime settings? | `PRF-0006` and `BLK-0005` |

## US-001 Quality Gates

- [x] All eleven output sections and five coverage manifests exist.
- [x] Stable IDs and four non-overlapping state fields are defined with only the
      permitted values.
- [x] Reconciliation uses
      `discovered = classified + out-of-scope + blocked` and exposes
      nonterminal rows.
- [x] Every nonterminal or blocked manifest row is required to record missing
      evidence and an owner question.
- [x] Inherited facts are retained while inherited dispositions are explicitly
      provisional and unresolved.
- [x] Exact evidence classes distinguish production from tests, fixtures,
      plans, comments, generated files, and historical migrations.
- [x] The live-DuckDB prohibition and recommendation proof gate are explicit.
- [x] Repository verification and explicitly skipped commands are recorded;
      the lint result is preserved without fixing unrelated source errors.

## US-002 Quality Gates

- [x] Actual product composition, declared route/read inventory, parity
      coverage, and adjacent route-surface entries are recorded separately.
- [x] All 36 read contracts record filters, exact counts, ordering, pagination,
      cursor binding, freshness/search/access behavior, and reader budgets.
- [x] Fixture/workload scale is fixed, and every absent benchmark-critical
      setting remains explicit `pending` evidence rather than receiving a
      resolver default or substituted value.
- [x] Source import/seeding, projection/rebuild, foreground reader, and
      end-to-end HTTP time are separate definitions; no physical value is
      claimed from smoke observations.
- [x] Only source-safe and test tooling ran; no live DuckDB, server, projector,
      migration, fixture mutation, or benchmark-setting override occurred.
- [x] The API manifest reconciles 23 discovered rows as 22 nonterminal plus one
      blocked row, using only the US-001 `auditStatus` vocabulary and keeping
      proof, actionability, and certification states independent.
- [x] No move, derive, archive, delete, target-shape, or implementation-slice
      recommendation was added or strengthened.
- [x] Focused contract/parity/benchmark verification passed 73 tests; the
      separate route-surface import failure and six pre-existing lint errors
      are preserved in `CMD-0016` and `CMD-0017` rather than worked around.
- [x] Commands, skipped checks, blockers, missing evidence, owner questions,
      structural invariants, and whitespace verification are recorded.

---

## Inherited Audit Material (Provisional)

Everything from this point to the end of the file predates the normalized
framework. Substantiated observations are retained for later adoption. All
dispositions, candidates, target shapes, implementation slices, and
recommendations in this inherited portion are provisional with
`recommendationActionability: unresolved` until linked to revised manifest and
proof rows.

## Inherited Status (Provisional)

This was the first durable audit artifact. It records repo-derived evidence from
the mounted API/read-contract inventory, DuckDB migrations, projector/reader
code, tests, and operator scripts. It does not inspect the live DuckDB file
directly.

The inherited version described its schema-shape recommendations as actionable
from code and schema. US-001 supersedes that disposition: its observations are
preserved, but every recommendation is provisional and
`recommendationActionability: unresolved` until revised proof is normalized.
Runtime row counts, physical bytes, null ratios, and oldest/newest update
timestamps also remain missing until collected through approved snapshot
tooling.

## Inherited Discovery Sources

Exact files below remain useful discovery sources. Wildcards are not proof
citations and must be expanded to exact files and symbols during manifest
adoption.

- `src/server/reviewServing/reviewServingReadContracts.ts`
- `src/server/reviewServing/reviewServingRouteParityCoverage.ts`
- `src/server/reviewServing/reviewServingContracts.ts`
- `src/server/reviewServing/reviewServingReader.ts`
- `src/server/reviewServing/*Projector*.ts`
- `src/server/routes/projectsRoutes/*Review*.ts`
- `src/server/routes/ArticlesRoutes.ts`
- `src/server/routes/ProjectExportRoutes.ts`
- `src/db/duckdbMigrations/0097_reviewServingV4Foundation.sql`
- `src/db/duckdbMigrations/0098_reviewServingPayloadOrderColumns.sql`
- `src/db/duckdbMigrations/0099_reviewServingCountScopeAndDetailOptionTables.sql`
- `src/db/duckdbMigrations/0100_reviewServingFilterOptionValueKey.sql`
- `src/db/duckdbMigrations/0101_reviewServingFacetSummaryScope.sql`
- `src/db/duckdbMigrations/0102_reviewWriteOverlayReadSurface.sql`
- `src/db/duckdbMigrations/0103_reviewProjectionInputWatermarks.sql`
- `src/db/duckdbMigrations/0104_reviewServingArticleDisplayMetadata.sql`
- `src/db/duckdbMigrations/0105_reviewServingArticleMetadataStatus.sql`
- `src/db/duckdbMigrations/0106_reviewServingRemoveHotSourceMetadata.sql`
- `src/db/duckdbMigrations/0107_reviewServingRebuildRequest.sql`
- `src/db/duckdbMigrations/0108_reviewSelectedImportPatchDisplayFields.sql`
- `src/db/duckdbMigrations/0109_reviewServingJudgmentDetailPayloadKindForwardMigration.sql`
- `src/db/duckdbMigrations/0111_rebuildReviewRebuildRequestIndex.sql`
- `src/db/duckdbMigrations/0112_reviewServingSummaryRebuildPartial.sql`
- `src/db/duckdbMigrations/0113_reviewServingSummaryContributionRebuildPartial.sql`
- `src/db/duckdbMigrations/0114_dropReviewFilterPostingStatsLookupIndex.sql`
- `src/db/duckdbMigrations/0115_rebuildReviewServingProjectorWatermarkWithoutPrimaryKey.sql`
- `src/db/duckdbMigrations/0116_dropReviewServingProjectorWatermarkLookupIndex.sql`

## Inherited API Surface Inventory

Mounted review read surfaces:

- `POST /api/articlesreviews`: LLM review rows, count state, prompt badges,
  postings, list judgment hydration, token-prefix search, async substring
  search.
- `POST /api/articlesreviewscount`: LLM count with filters and search state.
- `POST /api/articlesreviewshuman`: human review rows/count, postings,
  judgment hydration, search.
- `POST /api/articlesreviewsboth`: both-mode rows/count, LLM and human judgment
  hydration, postings, search.
- `POST /api/articlesreviewsunassessed`: unassessed queue rows/count, postings,
  queue access, search.
- `GET /api/articlesreviewsfilters`: review filter options, facets, and search
  scope.
- `GET /api/articlesreviewshumanfilters`: human filter options, facets, and
  search scope.
- `POST /api/projectsreview`: detail row, detail payload, LLM judgments, human
  judgments, prompt badges.
- `POST /api/projectsreviewswarnings`: snapshot and indexing warning state.
- `POST /api/projectsreviewshealth`: health snapshot.
- `GET /api/projects/:id/prompts/:promptId/preview`: prompt preview plus detail
  payload.
- `POST /api/articles/pdf-fetch-by-filter`: bulk/PDF selection by filter.
- `POST /api/projects/add_articles_by_filter`: bulk add by filter.
- `POST /api/articles/pdf-fetch-by-project`: PDF selection by project.
- `POST /api/articles/pdf-fetch-bulk`: PDF selection by explicit IDs.
- `POST /api/projects/:id/export`: export selection and detail hydration.

Known unmounted/internal route surface:

- `POST /api/review-serving/filter-postings`: classified in read contracts but
  not mounted; use as contract documentation only.

Parity gates already named by the repo:

- Review routes: semantic fixture, sampled parity, cursor, freshness state,
  named count state, SQL shape, forbidden foreground DuckDB work, latency, and
  response size.
- Job routes: durable job persistence, keyset batching, article-ID caps, filter
  signature, snapshot semantics, and foreground payload cap.

## Inherited Current Read Shape

The serving design already has a useful split:

- Candidate/list rows: `mart.review_article_serving_v4`.
- Filter postings: `mart.review_article_filter_posting_serving_v4`.
- Posting cardinality/statistics: `mart.review_filter_posting_stats_v4`.
- Large article payload: `mart.review_article_serving_payload_v4`.
- Judgment detail payload: `mart.review_article_judgment_detail_serving_v4`.
- Exact counts/facets/options: `mart.review_article_count_serving_v4`,
  `mart.review_filter_facet_serving_v4`, and
  `mart.review_filter_option_serving_v4`.
- Queue rows: `mart.review_unassessed_queue_serving_v4`.
- Title token-prefix search: `mart.review_title_search_serving_v4`.
- Snapshot publication/control: `app.review_serving_snapshot_manifest`,
  `app.review_projection_identity_manifest`, pins, dirty work, rebuild requests,
  and chunk manifests.

The main shape problem is not that the whole design is wrong. The problem is
that several hot rows still carry values that are only needed after candidate
selection, and some control/partial tables need explicit disposition and
retention proof.

## Inherited Schema Census

### Source, Delta, And Intake Tables

- `app.import_run_article_delta`
  - Columns: delta identity, source table/row/operation, source partition/high
    water mark, import route, article, selected rank, publication year,
    tombstone, payload JSON, reconciliation timestamps.
  - Classification: read-write delta ledger.
  - Disposition: keep.
  - Reason: import-route changes feed selected-import and project-scope
    projection.
  - Missing evidence: retention horizon and physical row count.

- `app.review_change_delta`
  - Columns: delta identity, source metadata, project/article/prompt/model,
    content flags, judgment IDs, config field set, tombstone, payload JSON.
  - Classification: read-write delta ledger.
  - Disposition: keep.
  - Reason: judgment, human judgment, prompt/config, and article changes feed
    dirty work and rebuild invalidation.
  - Missing evidence: retention horizon and payload JSON size by change kind.

- `app.review_source_change_outbox`
  - Classification: recovery outbox.
  - Disposition: keep with bounded retention.
  - Reason: preserves source-change evidence for reconciliation and recovery.
  - Missing evidence: oldest unreconciled rows and retry/quarantine aging.

- `app.review_delta_reconciliation_cursor`
  - Classification: reconciliation cursor.
  - Disposition: keep.
  - Reason: prevents replay gaps/duplicates per source partition.

- `app.review_import_article_hot_field`
  - Columns include selected rank, publication year, title, journal, external
    ID, duplicate/conflict flags, and filter bucket fields.
  - Classification: reusable hot import fact.
  - Disposition: keep, but audit `article_title`, `journal_title`, and
    `external_id` as possible display duplication.
  - Reason: selected-import and posting projectors need rank/filter facts before
    list rows are built.

### Manifest, Snapshot, And Control Tables

- `app.review_serving_dirty_work`
  - Classification: control queue.
  - Disposition: keep with retention cleanup for completed/stale rows.
  - Reason: incremental projection input.

- `app.review_serving_dirty_work_ack`
  - Classification: acknowledgement ledger.
  - Disposition: keep with bounded retention.
  - Reason: guards component watermarks against double-processing.

- `app.review_project_import_delta_cursor`
  - Classification: unresolved/schema-only candidate.
  - Evidence: current code search found schema/test references but no obvious
    production reader/writer outside schema tests.
  - Disposition: investigate for deletion or merge into dirty intake cursor
    state.
  - Proof needed: confirm no import-delta intake path reads/writes it in
    production and no operator recovery depends on it.

- `app.review_serving_projector_watermark`
  - Classification: projector cursor/control state.
  - Disposition: keep.
  - Reason: stores component/source partition watermarks, leases, and cursor
    JSON; recent migrations intentionally removed fragile primary-key/index
    assumptions.

- `app.review_projection_identity_manifest`
  - Classification: component identity manifest.
  - Disposition: keep.
  - Reason: connects snapshot components to projection identities, generations,
    patch watermarks, input watermarks, and invalidation reasons.

- `app.review_rebuild_request`
  - Classification: rebuild admission/retry policy.
  - Disposition: keep.
  - Reason: foreground/requestless rebuild ownership, retry, OOM/budget
    diagnostics, and terminal state.

- `app.review_rebuild_chunk_manifest`
  - Classification: chunk execution manifest.
  - Disposition: keep, but compact completed old requests under retention.
  - Reason: chunk leases, OOM splitting, budget diagnostics, progress, and
    restart recovery depend on it.

- `app.review_selected_import_snapshot`
  - Classification: selected-import snapshot manifest.
  - Disposition: keep.
  - Reason: selected import membership/rank publication boundary.

- `app.review_selected_article_import_v4`
  - Classification: selected-import base table.
  - Disposition: keep, but audit display/rank duplicates column-by-column.
  - Reason: selected import is a reusable pre-limit fact for project scope,
    postings, display composition, and selected-route semantics.

- `app.review_serving_snapshot_manifest`
  - Classification: published snapshot manifest.
  - Disposition: keep.
  - Reason: active/last-known-good status, component identities, selected import
    snapshot, validation, and freshness/warnings all depend on it.

- `app.review_serving_snapshot_pin`
  - Classification: pin/retention guard.
  - Disposition: keep.
  - Reason: long-running export/PDF/bulk operations need stable snapshot
    semantics.

- `app.review_write_overlay`
  - Classification: foreground write overlay.
  - Disposition: keep if read-surface reconciliation remains required; otherwise
    shrink after proving stale-read windows are gone.
  - Reason: protects UX after fresh writes before projector convergence.

- `app.review_bulk_operation_job`
  - Classification: durable job control.
  - Disposition: keep.
  - Reason: bulk/PDF/export operations need persistent criteria, cursor, result
    manifest, and snapshot pin ownership.

- `app.review_search_job`
  - Classification: async search job control.
  - Disposition: keep.
  - Reason: substring search is intentionally not foreground project-scale scan.

- `app.review_serving_retention_mark`
  - Classification: retention progress marker.
  - Disposition: keep.
  - Reason: cleanup must be bounded and restartable.

### Serving And Projection Tables

- `mart.review_title_search_serving_v4`
  - Classification: token-prefix index.
  - Disposition: keep, with fan-out measurement.
  - Reason: search must avoid foreground title scans; recent performance work
    increased search chunk coalescing because per-token/chunk overhead was high.

- `mart.review_article_serving_v4`
  - Classification: hot candidate/list mart.
  - Disposition: slim.
  - Keep pre-limit fields: project/review/snapshot identity, list mode, article
    ID, sort/activity keys, selected import route/rank when used for list
    semantics, publication year/date fields used for filters/order,
    duplicate/conflict flags, LLM/human status keys, prompt counts, review-open
    state, and snapshot component identities needed by readers.
  - Move or late-hydrate candidates: `article_title`, `article_external_id`,
    `arxiv_id`, `biorxiv_id`, `medrxiv_id`, `doi`, `pmid`, `journal_title`,
    `url`, `full_text_pdf`, `full_text_fetched_at`,
    `full_text_conversion_status` unless a route proves pre-limit use.
  - Reason: the current table is used for candidate selection and list display,
    so display columns are repeated per `project x snapshot x list_mode x
    article`. Display-only values should be fetched after candidate IDs are
    bounded.

- `mart.review_article_display_patch_v4`
  - Classification: display patch/staging.
  - Disposition: keep until the slim-list change is implemented; then re-audit.
  - Reason: it is the component-owned display input for publication and
    incremental replacement.

- `mart.review_selected_import_patch_v4`
  - Classification: selected-import patch/staging.
  - Disposition: keep if incremental selected-import publishing remains; delete
    only if direct base/serving writes fully replace patch semantics.

- `mart.review_llm_status_patch_v4`
  - Classification: LLM status patch/staging.
  - Disposition: keep unless direct status publication removes it.
  - Reason: LLM prompt status drives filters, counts, list badges, and both-mode
    semantics.

- `mart.review_human_status_patch_v4`
  - Classification: human status patch/staging.
  - Disposition: keep unless direct status publication removes it.
  - Reason: human/both/unassessed routes and summary-mode human judgment
    semantics depend on these states.

- `mart.review_queue_patch_v4`
  - Classification: queue patch/staging.
  - Disposition: keep if incremental queue projection remains; otherwise merge
    into queue serving writes.

- `mart.review_article_filter_posting_patch_v4`
  - Classification: posting patch/staging.
  - Disposition: keep until posting rebuild/incremental ownership is simplified.

- `mart.review_article_filter_posting_serving_v4`
  - Classification: hot posting index.
  - Disposition: keep and benchmark selective filter kinds.
  - Reason: prompt answer, import route, publication year, duplicate/conflict,
    status, queue, and search-filter intersections need bounded set selection.

- `mart.review_filter_posting_stats_v4`
  - Classification: posting cardinality/statistics.
  - Disposition: keep table, keep index dropped.
  - Reason: table is still used by projector/diagnostics; migration 0114 removed
    the lookup index after it became more write cost than read benefit.

- `mart.review_article_serving_payload_v4`
  - Classification: keyed article payload.
  - Disposition: keep and expand as the home for display/detail fields that can
    be hydrated after candidate selection.
  - Reason: it already holds `source_metadata`, `abstract_text`,
    `full_text_preview`, and payload byte tracking by article/snapshot.

- `mart.review_article_judgment_detail_serving_v4`
  - Classification: keyed judgment payload/detail rows.
  - Disposition: keep, but split list-badge/minimal judgment fields from large
    detail payload if route evidence shows list pages read more than they render.
  - Reason: detail, prompt preview, list judgment hydration, filters, export, and
    PDF routes all read this table.

- `mart.review_article_summary_contribution_v4`
  - Classification: likely retired main summary contribution ledger.
  - Evidence: `TESTS.md` already names guard coverage for no writer, startup
    probe, projector, or retention dependency on the main summary contribution
    ledger; rebuild now uses request-scoped partial tables.
  - Disposition: delete candidate.
  - Proof needed: migration removes the table; schema/static guards pass; summary
    rebuild, retention, repair, and route parity tests pass.

- `mart.review_article_count_serving_v4`
  - Classification: exact named count serving table.
  - Disposition: keep.
  - Reason: foreground count routes and freshness states require exact named
    counts without project-scale scans.

- `mart.review_filter_facet_serving_v4`
  - Classification: facet summary serving table.
  - Disposition: keep, but verify every facet kind is consumed by the UI.
  - Reason: filter endpoints consume facets with summary identity and
    availability.

- `mart.review_filter_option_serving_v4`
  - Classification: filter option serving table.
  - Disposition: keep, but slim `option_payload_json` after comparing UI fields
    against returned payload.
  - Reason: route builds prompt filters and numeric bins from these rows; large
    unused payload JSON would be pure hot-row width.

- `mart.review_unassessed_queue_serving_v4`
  - Classification: queue serving table.
  - Disposition: keep.
  - Reason: unassessed route needs priority ordering without foreground judgment
    scans.

- `mart.review_article_summary_rebuild_partial_v4`
  - Classification: request-scoped summary rebuild partial.
  - Disposition: keep with strict retention.
  - Reason: enables bounded summary reduction; old partials should not persist
    beyond terminal request cleanup.

- `mart.review_article_summary_contribution_rebuild_partial_v4`
  - Classification: request-scoped contribution rebuild partial.
  - Disposition: keep with strict retention.
  - Reason: replaces the broad persistent contribution ledger during rebuild.

## Inherited Column Family Findings

- Display metadata is the highest-confidence slimming target.
  - Repeated in `app.review_import_article_hot_field`,
    `app.review_selected_article_import_v4`,
    `mart.review_article_display_patch_v4`,
    `mart.review_article_serving_v4`, and payload/detail surfaces.
  - Keep only fields needed for pre-limit filters/order in candidate marts.
  - Hydrate titles, journal/source IDs, external IDs, URLs, and full-text status
    after article IDs are bounded.

- Snapshot/component identity columns are intentionally repeated in hot serving
  tables.
  - Keep until readers can resolve identities once from a manifest and join by
    snapshot/component identity without extra per-row cost.
  - Do not remove before proving cursor and snapshot consistency.

- Posting rows are valid hot index rows, not display duplication.
  - Keep selective postings that serve mounted filters.
  - Remove only posting kinds with no route/UI consumer and no async job use.

- Count/facet/option rows are valid if they correspond to named route contracts.
  - Keep named exact counts.
  - Re-audit option payload JSON and facet kinds against UI consumption.

- Large text/JSON belongs in keyed payload/detail tables.
  - `source_metadata`, abstract, full-text preview, judgment payload JSON,
    explanations, and quotes should not be copied into candidate rows.

- Control tables are not deletion candidates just because no route reads them.
  - Snapshot, pin, dirty-work, chunk, watermark, request, cursor, and retention
    tables are writer/recovery surfaces.

## Inherited Deletion And Move Candidates (Provisional)

1. Delete `mart.review_article_summary_contribution_v4`.
   - Confidence: high.
   - Reason: request-scoped partials have replaced the main ledger and existing
     tests describe static guard coverage for no remaining runtime dependency.
   - Required proof: migration, schema test, summary projector tests, retention
     tests, integration route parity.

2. Investigate/delete `app.review_project_import_delta_cursor`.
   - Confidence: medium-low.
   - Reason: code search found schema/test references only.
   - Required proof: no production writer/reader, no repair/operator dependency,
     and import-delta dirty intake still has exact replay protection elsewhere.

3. Move display fields out of `mart.review_article_serving_v4`.
   - Confidence: high for fields that are display-only.
   - Required proof: reader can first select article IDs/order/counts from the
     slim mart, then hydrate display metadata by bounded article IDs with the
     same p95 and response contract.

4. Slim `mart.review_filter_option_serving_v4.option_payload_json`.
   - Confidence: medium.
   - Required proof: UI and route response only consume typed columns or a
     smaller payload shape for each filter kind.

5. Add retention cleanup for request-scoped partial tables.
   - Confidence: high.
   - Required proof: terminal rebuild requests can be cleaned while preserving
     active, failed evidence, pinned snapshots, and operator diagnostics.

## Inherited Proposed Target Shape (Provisional)

### Slim Candidate Mart

`mart.review_article_serving_v4` should become a narrow candidate/list-state mart
owned by snapshot/list-mode selection:

- identity: project, review config, snapshot, list mode, article
- ordering: sort/activity/article-created keys
- filter/status: publication year, duplicate/conflict, LLM/human status,
  prompt counts, review state, selected import route/rank
- snapshot consistency: component identities and generation/watermark metadata

Display fields should move to keyed hydration through either
`mart.review_article_serving_payload_v4` or a narrower display payload table.

### Payload Hydration

After a route has selected at most the configured page size of article IDs, it
should hydrate display/detail data by key:

- article title, external IDs, journal, URL, full-text status
- abstract/source metadata/full-text preview
- judgment detail payload, answers, placeholders, model metadata

The hydration query must preserve response order from the candidate query and
must remain capped by route page size or explicit bulk batch size.

### Summary And Filter Shapes

Keep exact named summary tables for foreground routes:

- `mart.review_article_count_serving_v4`
- `mart.review_filter_facet_serving_v4`
- `mart.review_filter_option_serving_v4`
- `mart.review_filter_posting_stats_v4`

Do not reintroduce project-scale foreground aggregation. Any dynamic combination
that cannot be answered from a bounded posting intersection should be async or
explicitly unavailable.

## Inherited Implementation Slices (Not Actionable)

1. Remove the retired main summary contribution ledger.
   - Add a migration dropping `mart.review_article_summary_contribution_v4`.
   - Keep request-scoped partial tables.
   - Run summary, retention, schema, projector writer, and phase integration
     tests.

2. Prove and either delete or justify `app.review_project_import_delta_cursor`.
   - Search dynamic SQL and operator scripts again.
   - Add a static guard if deleting.
   - Run dirty intake and selected-import rebuild tests.

3. Introduce bounded display hydration for review list routes.
   - Keep candidate selection in `mart.review_article_serving_v4`.
   - Hydrate display metadata for selected article IDs from payload/display
     storage.
   - Update read-contract/parity tests for identical route responses.

4. Physically slim `mart.review_article_serving_v4`.
   - Drop display-only columns only after slice 3 proves parity and benchmarks.
   - Keep date/status/filter/order fields that are pre-limit.

5. Slim filter option payload.
   - Compare filter endpoint response fields with UI consumption.
   - Replace large generic JSON with typed columns where possible.

6. Add retention for request-scoped rebuild partials.
   - Clean completed terminal request partials after evidence horizon.
   - Preserve failed-request diagnostics and active/pinned snapshot data.

7. Benchmark and route-parity gate the final shape.
   - Same fixture, same prompts/models/content settings.
   - Measure rows scanned, rows written, output bytes, temp spill, RSS, and
     p50/p95/p99 latency.

## Inherited Required Verification

For the next implementation PRs:

- `bun test src/server/reviewServing/reviewServingSchema.test.ts`
- `bun test src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingProjectorWriter.test.ts src/server/reviewServing/reviewServingRetentionService.test.ts`
- `bun test src/server/reviewServing/reviewServingReader.test.ts src/server/reviewServing/reviewServingReadContracts.test.ts src/server/reviewServing/reviewServingRouteParityCoverage.test.ts`
- `bun test src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.test.ts src/server/reviewServing/reviewServingFilterRouteService.test.ts`
- `bun run lint`
- Same-fixture physical benchmark before and after any candidate-mart slimming.
- Browser review-tab verification for LLM, Human, Both, Unassessed, detail, and
  filters.
- Desktop restart/resume verification for storage/runtime changes.

## Inherited Missing Evidence To Collect

- Row counts and physical bytes for every current review-serving table.
- Null ratio and approximate distinct count for each candidate display/status
  column in `mart.review_article_serving_v4`.
- Oldest/newest `updated_at` or equivalent lifecycle timestamp for control,
  delta, partial, and retention tables.
- Per-route SQL timing before and after display hydration split.
- UI field-consumption proof for filter option payload JSON and facet groups.
- Active snapshot/pin counts and retained historical generation counts.

## Inherited Current Recommendation (Provisional)

Proceed in this order:

1. Delete the retired summary contribution ledger if the named proof passes.
2. Resolve the apparently schema-only import delta cursor.
3. Move display-only article metadata out of the hot list mart through bounded
   hydration.
4. Slim option payload JSON and add partial-table retention.

Do not start by deleting broad control tables or changing snapshot identity
columns. Those tables are part of correctness, replay, and recovery, even when no
mounted route reads them directly.

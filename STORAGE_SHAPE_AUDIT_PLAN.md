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
| `overallCertification` | `INCOMPLETE` | The API manifest has 22 nonterminal rows and one blocked row; the US-003/US-004 schema censuses add nonterminal object/field rows, open-JSON blockers, and unresolved review-identity/applicability conflicts; the remaining manifests, lifecycle proof, benchmark-critical values, and physical proof are pending; and no inherited recommendation is actionable. |
| Framework version | `US-001 / 2026-07-21` | First normalized, resumable evidence structure. |
| Latest normalized story | `US-004 / 2026-07-21` | Prompt, project-prompt, model, provider, scope, content, date, selected-route, and logical review-configuration shapes and identity dimensions are statically enumerated; deployed/runtime evidence, closed JSON schemas, and an authoritative cross-contract applicability/identity policy remain unavailable. |
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

## US-003 Article, Import, And Project-Scope Census

This census derives the declared effective schema by applying every checked-in
SQL migration in the same full-file-name lexical order used by
`migrateDuckdb.ts`. It does not claim that a particular deployed database has
applied that chain. No DuckDB file, information-schema function, server,
migration, fixture, or data writer was opened or run for this census.

All table and material-field dispositions below are `unresolved`.
`recommendationActionability` remains `unresolved`,
`overallCertification` remains `INCOMPLETE`, and no `DSP-####`, `TGT-####`, or
`SLC-####` row is created or changed.

### US-003 Exact Evidence Ledger

| rowId | Source class | Exact locator | Claim supported | Exposed by |
| --- | --- | --- | --- | --- |
| `EVD-0017` | `production` | `src/db/migrateDuckdb.ts#getDuckdbMigrationFiles`, `#applyDuckdbMigrationFiles`, `#migrateDuckdb` | Effective declarations are the result of all `.sql` files sorted by full file name with applied names recorded in `app_schema_migration`; file-number prefixes alone are not the ordering rule. | `CMD-0020`, `CMD-0021` |
| `EVD-0018` | `historical-migration` | `src/db/duckdbMigrations/0000_nativeDuckdbSchema.sql` exact `CREATE TABLE` statements for `app.data_source`, `app.import_route`, `app.data_source_import_route`, `app.project`, `app.project_import_route`, `app.article`, `app.article_import_route`, and `app.project_article`; exact base indexes at lines containing their names | Supplies the bootstrap declarations and exposes which constraints/indexes later rebuilds can remove. | `CMD-0021`, `CMD-0022` |
| `EVD-0019` | `historical-migration` | `0012_removeOpenalexArticleId.sql`; `0013_rebuildArticleWithoutOpenalexId.sql`; `0016_articleSourceMetadata.sql`; `0022_fullTextConversionModelConfig.sql`; `0077_articleIdentifierCanonicalSchema.sql`; `0083_providerModelNaturalKey.sql` | Complete article forward chain: the 0012 placeholder is a no-op, 0013 removes the obsolete column, 0016/0022 add JSON/model metadata, 0077 is the final table rebuild and removes `UNIQUE(article_id)`, and 0083 performs only model-reference data remapping. | `CMD-0021`, `CMD-0022` |
| `EVD-0020` | `historical-migration` | `0013_rebuildArticleWithoutOpenalexId.sql`; `0077_articleIdentifierCanonicalSchema.sql`; `0078_articleImportRouteSourceRecords.sql`; `0092_articleImportRouteArticleLookupIndex.sql` | Complete current-link/source-record chain: final link base, eight nullable provenance columns, the source-record table and its constraints/indexes, and the restored article-first link index. | `CMD-0021`, `CMD-0022` |
| `EVD-0021` | `historical-migration` | `0021_rebuildModelWithProviderConnections.sql`; `0029_dropModelProviderConnectionForeignKey.sql`; `0039_humanJudgmentSummaryMode.sql`; `0044_dropProjectEngine.sql`; `0067_archivedProjectDeletePending.sql`; `0081_dropProjectChildParentForeignKeys.sql`; `0089_dropProjectJudgmentModelForeignKeys.sql`; `0091_projectArticleArticleLookupIndex.sql` | Complete project/scope chain: repeated dependent-table rebuilds, Human mode and deletion state, final removal of project-side/model foreign keys, and final reverse indexes. | `CMD-0021`, `CMD-0022` |
| `EVD-0022` | `production` | `src/db/schemaTypes.ts#ArticleRecord`, `#DataSourceRecord`, `#ImportRouteRecord`, `#DataSourceRouteLinkRecord`, `#ProjectRecord`, `#ProjectRouteLinkRecord`, `#ArticleRouteLinkRecord`, `#ArticleImportRouteSourceRecord` | Production TypeScript names corroborate the current column-to-field mapping while leaving JSON values typed `unknown`; types do not prove deployed schema state. | `CMD-0023` |
| `EVD-0023` | `production` | `src/server/services/articleCanonicalMatcher.ts#insertCreatedArticles`; `articleImportStoreService.ts#ensureImportRoutes`, `#upsertArticleImportRouteCurrentLinks`, `#upsertArticleImportRouteSourceRecords`, `#quarantineRemappedArticleImportSourceRecords`; `fullTextConversionJobs.ts#convertArticle`; `projectTransferCommitWriter.ts#articleColumnByPayloadField` | Traces UUID-supplied article/import identities, canonical/current/source-record upserts, quarantine mutation, conversion metadata, and transfer writes. | `CMD-0023`, `CMD-0024` |
| `EVD-0024` | `production` | `src/server/routes/DataSourcesRoutes.ts#dataSourcesRoutes`, `#updateDataSourceTx`; `DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts#dataSourcesImportRoutesPostCovidenceCreate`; `dataSourcesImportRoutesPostStructuredFileCreate.ts#dataSourcesImportRoutesPostStructuredFileCreate`; `src/server/services/dataSourceQueryService.ts#getDataSourceById`, `#updateDataSourceAfterImport`; `src/server/routes/ImportRoutes.ts#importRoutes` | Traces data-source create/read/update/archive/import state and active import-route reads. No production reference to `app.data_source_import_route` was found. | `CMD-0023`, `CMD-0025` |
| `EVD-0025` | `production` | `src/server/routes/ProjectsRoutes.ts#projectsRoutes`; `ProjectArticlesRoutes.ts#projectArticlesRoutes`; `SubprojectsRoutes.ts#subprojectsRoutes`; `src/server/services/insertArticlesIntoProject.ts#insertArticlesIntoProject`; `projectTransfer/projectTransferCommitWriter.ts`; `projectTransfer/projectTransferExport.ts` | Traces project, project-article, and project-import-route UUID writes and reads across create/edit/clone/add/remove/subproject/transfer flows. | `CMD-0023`, `CMD-0025` |
| `EVD-0026` | `production` | `src/utils/articleSourceMetadata.ts#ArticleSourceMetadata`, `#ArticleCovidenceSourceMetadata`, `#getArticleSourceMetadataValue`; `getJournalTitleFromOriginalData.ts#getJournalTitleFromOriginalData`; `src/app/utils/getArticleUrl.ts#sourceUrlPaths`; `src/server/services/articleCanonicalFieldResolver.ts#getSourceMetadataWithResolverState`; `structuredFileImportService.ts#getStructuredFileImportRow`; `covidenceImportService.ts#getCovidenceImportOriginalData`, `#getCovidenceImportSourceMetadata` | Defines every statically material article/original/import metadata key family and proves that raw/structured values also admit source-defined keys. | `CMD-0024` |
| `EVD-0027` | `production` | `src/server/cron/fullTextConversionJobs.ts#convertArticle`; `src/server/services/projectTransfer/projectTransferExportAssets.ts#rewriteFullTextAssetsValue`; `projectTransfer/projectTransferExport.ts`; `projectTransfer/projectTransferCommitWriter.ts` | Conversion metadata has four fixed keys; `full_text_assets` is recursively walked with arbitrary object keys; transfer preserves JSON payloads as `unknown`. | `CMD-0024` |
| `EVD-0028` | `production` | `src/server/services/archivedProjectCleanupService.ts#archivedProjectSourceCleanupMutations`, `#requestArchivedProjectDeletePending`, `#finalDeleteProject`; `articleImportStoreService.ts#syncImportedArticlesWithTx` | Traces bounded project source-link cleanup/final deletion and route-sync deletion, but not complete retention/recovery horizons for all census objects. | `CMD-0023`, `CMD-0025` |
| `EVD-0029` | `test` | `src/db/migrateDuckdb.test.ts` tests `DuckDB migrations add canonical article identifiers and keep legacy article ids non-unique` and `DuckDB migrations add import-scoped source record identity and idempotency constraints`; `DataSourcesRoutes.test.ts`; `articleImportStoreService.test.ts`; `ProjectsRoutes.test.ts`; `SubprojectsRoutes.test.ts`; `archivedProjectCleanupService.test.ts` | Non-production checks corroborate migration intent and route/service behavior; none is evidence about a live or deployed database. | `CMD-0023`, `CMD-0026` |
| `EVD-0030` | `plan` | `plans/old/FOR_KEY_PLAN.md` exact `data_source_import_route` mention; `tasks/forKeyPrd.json` subproject stories | The only non-migration `data_source_import_route` reference is an old plan, and task prose about subprojects does not create a storage object. | `CMD-0025` |

### Effective Table, Identity, Constraint, And Index Inventory

Column declarations below are the final declarations after the complete chain,
not a transcription of `0000` alone. `PK` and `UNIQUE` constraints are listed
separately from named `CREATE INDEX` objects. Every `id` is `VARCHAR` with no
database default or sequence; current production writers supply UUID strings.
The one schema-only bridge has no observed production identity allocator.

| Object ID | Effective object | Every current column | Identity and constraints | Current named indexes |
| --- | --- | --- | --- | --- |
| `DBO-0001` | `app.article` | `id VARCHAR`; `article_id VARCHAR`; `article_title VARCHAR NOT NULL`; `article_summary VARCHAR`; `article_authors VARCHAR[]`; `article_version INTEGER`; `article_created_at TIMESTAMPTZ`; `article_updated_at TIMESTAMPTZ`; `arxiv_id VARCHAR`; `biorxiv_id VARCHAR`; `medrxiv_id VARCHAR`; `doi VARCHAR`; `pubmed_id VARCHAR`; `url VARCHAR`; `full_text VARCHAR`; `full_text_html VARCHAR`; `full_text_pdf VARCHAR`; `full_text_source VARCHAR`; `full_text_original_format VARCHAR`; `full_text_fetched_at TIMESTAMPTZ`; `full_text_assets JSON`; `full_text_conversion_status VARCHAR`; `full_text_conversion_error VARCHAR`; `full_text_conversion_attempts INTEGER`; `full_text_conversion_model_id VARCHAR`; `full_text_conversion_metadata JSON`; `full_text_char_count BIGINT`; `content_hash VARCHAR`; `import_route VARCHAR`; `original_data JSON`; `publication_status VARCHAR`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `source_metadata JSON` | `PRIMARY KEY(id)`. `article_id` is deliberately nullable and non-unique after 0077. No FK constrains `full_text_conversion_model_id`. UUID supplied by canonical matcher/transfer writer. | `DBO-0011`: `idx_app_article_article_id (article_id)` |
| `DBO-0002` | `app.data_source` | `id VARCHAR`; `title VARCHAR NOT NULL`; `description VARCHAR`; `import_route VARCHAR`; `cursor VARCHAR`; `last_import_at TIMESTAMPTZ`; `items_after_last_import BIGINT`; `date_from TIMESTAMPTZ`; `date_to TIMESTAMPTZ`; `archived BOOLEAN NOT NULL DEFAULT FALSE`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; UUID supplied by data-source routes. `import_route` is a denormalized string with no FK. | None declared. |
| `DBO-0003` | `app.import_route` | `id VARCHAR`; `route VARCHAR NOT NULL`; `name VARCHAR`; `description VARCHAR`; `active BOOLEAN NOT NULL DEFAULT TRUE`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; `UNIQUE(route)`; UUID supplied by import-store/FHIR writers. | None beyond constraints. |
| `DBO-0004` | `app.data_source_import_route` | `id VARCHAR`; `data_source_id VARCHAR NOT NULL`; `import_route_id VARCHAR NOT NULL`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; FKs `data_source_id -> app.data_source(id)` and `import_route_id -> app.import_route(id)`; `UNIQUE(data_source_id, import_route_id)`. No production allocator/reference found. | None beyond constraints. |
| `DBO-0005` | `app.article_import_route` | `id VARCHAR`; `article_id VARCHAR NOT NULL`; `import_route_id VARCHAR NOT NULL`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `external_article_id VARCHAR`; `source_kind VARCHAR`; `import_metadata JSON`; `match_metadata JSON`; `import_run_id VARCHAR`; `source_record_key VARCHAR`; `source_record_hash VARCHAR`; `raw_payload JSON` | `PRIMARY KEY(id)`; FKs `article_id -> app.article(id)` and `import_route_id -> app.import_route(id)`; `UNIQUE(article_id, import_route_id)`. UUID supplied by import-store/transfer writers; provenance columns remain nullable for legacy rows. | `DBO-0012`: `idx_app_article_import_route_import_route_id (import_route_id, article_id)`; `DBO-0013`: `idx_app_article_import_route_external_article_id (import_route_id, external_article_id)`; `DBO-0014`: `idx_app_article_import_route_article_id (article_id, import_route_id)` |
| `DBO-0006` | `app.article_import_route_source_record` | `id VARCHAR`; `article_id VARCHAR NOT NULL`; `import_route_id VARCHAR NOT NULL`; `external_article_id VARCHAR`; `source_kind VARCHAR`; `import_metadata JSON`; `match_metadata JSON`; `import_run_id VARCHAR`; `source_record_key VARCHAR NOT NULL`; `source_record_hash VARCHAR NOT NULL`; `raw_payload JSON`; `quarantined_at TIMESTAMPTZ`; `quarantine_reason VARCHAR`; `quarantine_metadata JSON`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; FKs `article_id -> app.article(id)` and `import_route_id -> app.import_route(id)`; `UNIQUE(import_route_id, source_record_key)`. UUID supplied on first upsert; import-scoped source key is the idempotency identity. | `DBO-0015`: `idx_app_article_import_route_source_record_article (article_id, import_route_id)`; `DBO-0016`: `idx_app_article_import_route_source_record_external_article_id (import_route_id, external_article_id, quarantined_at)` |
| `DBO-0007` | `app.project` | `id VARCHAR`; `name VARCHAR NOT NULL`; `description VARCHAR`; `model_id VARCHAR NOT NULL`; `use_title BOOLEAN NOT NULL DEFAULT TRUE`; `use_abstract BOOLEAN NOT NULL DEFAULT TRUE`; `use_fulltext BOOLEAN NOT NULL DEFAULT FALSE`; `use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE`; `date_from TIMESTAMPTZ`; `date_to TIMESTAMPTZ`; `archived BOOLEAN NOT NULL DEFAULT FALSE`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `human_judgment_mode human_judgment_mode DEFAULT 'prompt'`; `delete_pending_at TIMESTAMPTZ` | `PRIMARY KEY(id)`; `human_judgment_mode` is enum-constrained but nullable; 0089 removes the `model_id` FK. UUID supplied by project/subproject/transfer writers. | `DBO-0017`: `idx_app_project_delete_pending (delete_pending_at, id)` |
| `DBO-0008` | `app.project_article` | `id VARCHAR`; `project_id VARCHAR NOT NULL`; `article_id VARCHAR NOT NULL`; `imported_from_project_id VARCHAR`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; FK only `article_id -> app.article(id)`; `UNIQUE(project_id, article_id)`. 0081 removes project/imported-project FKs. UUID supplied by add/clone/subproject/transfer writers. | `DBO-0018`: `idx_app_project_article_project_id (project_id, article_id)`; `DBO-0019`: `idx_app_project_article_article_id (article_id, project_id)` |
| `DBO-0009` | `app.project_import_route` | `id VARCHAR`; `project_id VARCHAR NOT NULL`; `import_route_id VARCHAR NOT NULL`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; FK only `import_route_id -> app.import_route(id)`; `UNIQUE(project_id, import_route_id)`. 0081 removes the project FK. UUID supplied by project/clone/transfer writers. | `DBO-0020`: `idx_app_project_import_route_import_route_id (import_route_id, project_id)`; the bootstrap project-first named index is not recreated after 0044. |
| `DBO-0010` | Logical subproject shape; no `app.subproject` table | No dedicated persisted columns. `POST /api/subprojects` writes ordinary `app.project`, `app.project_prompt`, and `app.project_article` rows. Request-only `sourceProjectIds` and prompt-selection criteria are used to select content but no parent/source-project identity is persisted on the new project. | The returned subproject identity is the new `app.project.id` UUID. Project-prompt fields are deferred to US-004; no separate subproject PK, FK, uniqueness constraint, or discriminator exists. | No subproject index exists. Scope reads use the project/scope indexes above and project-prompt indexes owned by US-004. |

There are **9 physical tables, 1 logical no-table subproject shape, 113
physical columns, and 10 named current index objects** in this story's schema
manifest. Constraint-backed uniqueness is not double-counted as a named index.

### Complete Forward Migration Chain

| Object IDs | Ordered chain | Effective result |
| --- | --- | --- |
| `DBO-0002` | `0000_nativeDuckdbSchema.sql` -> `0011_removeOpenalexImport.sql` (data-only update) | Original 12-column table remains; 0011 clears obsolete OpenAlex import state but changes no declaration. |
| `DBO-0003` | `0000_nativeDuckdbSchema.sql` only | Seven columns, PK, and unique route are unchanged by forward DDL. |
| `DBO-0004` | `0000_nativeDuckdbSchema.sql` only | Five-column bridge remains schema-declared with no forward migration or production reference. |
| `DBO-0001`, `DBO-0011` | `0000` -> `0012_removeOpenalexArticleId.sql` (no-op `SELECT 1`) -> `0013_rebuildArticleWithoutOpenalexId.sql` -> `0016_articleSourceMetadata.sql` -> `0022_fullTextConversionModelConfig.sql` -> `0077_articleIdentifierCanonicalSchema.sql` -> `0083_providerModelNaturalKey.sql` (data-only model remap) | 0077 is the final 34-column declaration and recreates the non-unique `article_id` index; 0083 does not alter the table. |
| `DBO-0005`, `DBO-0012`-`DBO-0014` | `0000` -> `0013` rebuild -> `0077` rebuild -> `0078_articleImportRouteSourceRecords.sql` add columns/index -> `0092_articleImportRouteArticleLookupIndex.sql` | Thirteen-column current-link table, three named indexes, and nullable legacy provenance fields. |
| `DBO-0006`, `DBO-0015`, `DBO-0016` | `0078_articleImportRouteSourceRecords.sql` only | Sixteen-column import-scoped history/quarantine table with unique source key and two named indexes. |
| `DBO-0007`, `DBO-0017` | `0000` -> `0021_rebuildModelWithProviderConnections.sql` -> `0029_dropModelProviderConnectionForeignKey.sql` -> `0039_humanJudgmentSummaryMode.sql` -> `0044_dropProjectEngine.sql` -> `0067_archivedProjectDeletePending.sql` -> `0083_providerModelNaturalKey.sql` (data-only model remap) -> `0089_dropProjectJudgmentModelForeignKeys.sql` | 0089 is the final 15-column declaration; model FK is absent; deletion index is recreated. |
| `DBO-0008`, `DBO-0018`, `DBO-0019` | `0000` -> `0013` rebuild -> `0021` rebuild -> `0029` rebuild -> `0044` rebuild -> `0077` rebuild -> `0081_dropProjectChildParentForeignKeys.sql` -> `0091_projectArticleArticleLookupIndex.sql` | Six-column link, article FK only, unique project/article identity, and both lookup directions. |
| `DBO-0009`, `DBO-0020` | `0000` -> `0021` rebuild -> `0029` rebuild -> `0044` rebuild -> `0081_dropProjectChildParentForeignKeys.sql` -> `0091_projectArticleArticleLookupIndex.sql` | Five-column link, import-route FK only, unique project/route identity, and only the named import-route-first index. |
| `DBO-0010` | No migration contains `CREATE TABLE ... subproject`; `SubprojectsRoutes.ts#subprojectsRoutes` composes existing tables. | Subproject is a product workflow, not a physical schema object. |

### Persisted JSON Key And Open-Domain Census

The SQL type `JSON` does not constrain keys. The rows below enumerate every
statically material key/path family observed in production readers or writers.
An explicit `$.<source-defined...>` row is not shorthand for an omitted finite
list: it is the authoritative effective-schema statement that the column admits
an unbounded producer-defined key domain. Those rows are `blocked` pending a
closed owner schema or approved immutable key-profile evidence.

| Field IDs | JSON column | Exact material keys/paths | Producer/consumer evidence | Closure |
| --- | --- | --- | --- | --- |
| `CMF-0114` | `app.article.full_text_assets` | `$.<arbitrary recursive object/array path>` | Transfer asset export recursively visits every key/value and transfer import preserves the value. | Open; `BLK-0008`. |
| `CMF-0115`-`CMF-0118` | `app.article.full_text_conversion_metadata` | `$.baseURL`; `$.modelId`; `$.modelName`; `$.providerKind` | `fullTextConversionJobs.ts#convertArticle` writes the same four-key object on success and failure. | Statically closed for the current production writer; transfer can preserve older values, so runtime variants are unavailable. |
| `CMF-0119` | `app.article.original_data` | `$.doi`; `$.source`; `$.src`; `$.server`; `$.bookOrReportDetails.publisher` | DOI and preprint-source/host normalization. | Static material aliases. |
| `CMF-0120` | `app.article.original_data` | `$.fullTextUrlList.fullTextUrl[*].url`; `.site`; `.availability`; `.availabilityCode`; `.documentStyle` | Full-text link normalization. | Static material aliases. |
| `CMF-0121` | `app.article.original_data` | `$.pubTypeList.pubType[*]`; `$.versionList.version[*].pubTypeList.pubType[*]` | Preprint detection. | Static material aliases. |
| `CMF-0122` | `app.article.original_data` | `$.journalInfo.journal.title`; `$.journalInfo.title`; `$.journal.title`; `$['container-title'][*]`; `$.containerTitle[*]`; `$.host_venue.display_name`; `$.primary_location.source.display_name`; `$.primary_location.source.host_organization_name`; `$.journalTitle` | Journal-title fallback extraction. | Static material aliases. |
| `CMF-0123` | `app.article.original_data` | `$.sourceUrl`; `$.articleUrl`; `$.landingUrl`; `$.url`; `$.citation.url`; `$.covidence.citation.url` | URL fallback extraction. | Static material aliases. |
| `CMF-0124` | `app.article.original_data` | `$.covidence.{articleKey,articleKeySource,citation,covidenceIds,duplicateStudyRecordCount,exclusionReasons,hasDuplicateStudyRecords,hasStudyDecisionConflict,isSeededHumanJudgmentAnswered,notes,recordKey,recordKeySource,referenceIds,seededHumanJudgmentAnswer,stageMembership,studyDecisionAnswers,studyKey,studyKeySource,tags}`; `$.covidence.sourceRows[*].{citation,exclusionReason,fileRole,notes,rowNumber,sourceFileName,tags}`; `stageMembership.{all,excluded,full_text,included,irrelevant}` | Covidence raw-payload writer and URL/detail consumers. `citation` and `studyDecisionAnswers` themselves carry import-defined child keys. | Named envelope closed; nested import-defined maps remain part of `CMF-0125`. |
| `CMF-0125` | `app.article.original_data` | `$.<source-defined raw key/path>`, including arbitrary structured-file, publication-provider, EHR, Covidence citation, and transfer-preserved children | Import rows accept `originalData?: unknown`; structured-file import stores each input item verbatim. | Open; `BLK-0008`. |
| `CMF-0126` | `app.article.source_metadata` | `$.journalTitle`; `$.preprintSource`; `$.preprintHostLabel`; `$.isPreprint` | Canonical metadata builder, display, full-text, export, and serving consumers. | Statically named. |
| `CMF-0127` | `app.article.source_metadata` | `$.fullTextLinks[*].{url,site,availability,availabilityCode,documentStyle}` | Canonical resolver and full-text/PDF URL consumers. | Statically named. |
| `CMF-0128` | `app.article.source_metadata` | `$.covidence.{articleKey,articleKeySource,recordKey,recordKeySource,studyKey,studyKeySource,mode,sourceFileNames,stageMembership,tags,covidenceIds,referenceIds,duplicateStudyRecordCount,hasDuplicateStudyRecords,hasStudyDecisionConflict,seededHumanJudgmentAnswer,isSeededHumanJudgmentAnswered}`; `stageMembership.{all,excluded,full_text,included,irrelevant}` | `ArticleCovidenceSourceMetadata` normalization and badges/detail consumers. | Statically named. |
| `CMF-0129` | `app.article.source_metadata` | `$.structuredFile.{assetPath,boundaryDisplayPath,boundaryPointer,format,sourceFileName}` | Structured-file import writer and canonical source-rank discriminator. | Statically named. |
| `CMF-0130` | `app.article.source_metadata` | `$.canonicalResolver.fieldTrustRanks.<article field>`; `$.canonicalResolver.manualFields.<article field>`; `$.canonicalResolver.warnings[*].{field,reason,selectedValue}`; `warnings[*].candidates[*].{completeness,sourceKind,sourceRecordKey,trustRank,value}` | Canonical field resolver reads and rewrites manual/rank/conflict state. Article-field map keys are bounded by its exported union. | Statically typed current writer. |
| `CMF-0131` | `app.article.source_metadata` | `$.<producer-defined passthrough key/path>` | Resolver merges unknown source metadata and transfer preserves `unknown`. | Open; `BLK-0008`. |
| `CMF-0132`, `CMF-0142` | Current-link and source-record `import_metadata` | `$.articleTitle`; `$.title`; `$.journalTitle`; `$.journal`; `$.journalName`; `$.publicationYear`; `$.year`; `$.covidence.hasStudyDecisionConflict`; `$.covidence.hasDuplicateStudyRecords`; `$.covidence.studyKey` | Import hot-field ranking/filtering and detail selection. | Statically material aliases. |
| `CMF-0133`, `CMF-0143` | Current-link and source-record `import_metadata` | `$.sourceUrl`; `$.articleUrl`; `$.landingUrl`; `$.url`; `$.citation.url`; `$.covidence.citation.url` | Scoped URL fallback. | Statically material aliases. |
| `CMF-0134`, `CMF-0144` | Current-link and source-record `import_metadata` | `$.journalTitle`; `$.covidence.{articleKey,articleKeySource,covidenceIds,duplicateStudyRecordCount,files,hasDuplicateStudyRecords,hasStudyDecisionConflict,isSeededHumanJudgmentAnswered,mode,recordKey,recordKeySource,referenceIds,seededHumanJudgmentAnswer,sourceFileNames,stageMembership,studyDecisionAnswers,studyKey,studyKeySource,tags}`; `files[*].{assetPath,fileRole,format,sourceFileName}`; `stageMembership.{all,excluded,full_text,included,irrelevant}` | Covidence import metadata writer, hot fields, detail, export, and transfer. | Named envelope closed; dynamic answer-map children are covered by wildcard rows. |
| `CMF-0135`, `CMF-0145` | Current-link and source-record `import_metadata` | All named `source_metadata` paths in `CMF-0126`-`CMF-0130` | `getScopedArticleImportStoreRow` defaults missing `importMetadata` to `sourceMetadata`. | Statically mapped key domain. |
| `CMF-0136`, `CMF-0146` | Current-link and source-record `import_metadata` | `$.<producer-defined key/path>` | Store and transfer accept/preserve `unknown`. | Open; `BLK-0008`. |
| `CMF-0137`, `CMF-0147` | Current-link and source-record `match_metadata` | `$.duplicateKey` | Hot-field duplicate ranking. | Statically material key. |
| `CMF-0138`, `CMF-0148` | Current-link and source-record `match_metadata` | `$.<producer-defined key/path>` | Store and transfer accept/preserve `unknown`. | Open; `BLK-0008`. |
| `CMF-0139`, `CMF-0149` | Current-link and source-record `raw_payload` | `$.sourceUrl`; `$.articleUrl`; `$.landingUrl`; `$.url`; `$.citation.url`; `$.covidence.citation.url` | Scoped URL, selected-import, display-payload, and detail readers. | Statically material aliases. |
| `CMF-0140`, `CMF-0150` | Current-link and source-record `raw_payload` | The full named Covidence envelope from `CMF-0124` | Covidence import stores `originalData` as `rawPayload`. | Named envelope mapped. |
| `CMF-0141`, `CMF-0151` | Current-link and source-record `raw_payload` | `$.<source-defined raw key/path>` | Store accepts `rawPayload?: unknown`, falls back to arbitrary `originalData`, and transfer preserves it. | Open; `BLK-0008`. |
| `CMF-0152`-`CMF-0155` | `app.article_import_route_source_record.quarantine_metadata` | `$.incomingArticleId`; `$.incomingExternalArticleId`; `$.incomingImportRunId`; `$.incomingSourceRecordHash` | `quarantineRemappedArticleImportSourceRecords` writes the four keys and clears them on accepted upsert. | Statically closed for the current writer. |

The material-field manifest therefore contains **113 column rows plus 42 JSON
key/path-family rows = 155 rows**. Nine wildcard rows are `blocked`; they each
represent an unconstrained JSON domain, not nine inferred keys.

### Production And Non-Production Reference Separation

| Object IDs | Production references | Non-production references | Current use conclusion |
| --- | --- | --- | --- |
| `DBO-0001`, `DBO-0011` | Canonical/import/transfer/full-text writers; app query, judgment snapshot, review display/detail, PDF/export/transfer readers; review projectors and workers (`EVD-0023`, `EVD-0025`-`EVD-0028`). | Migrations `EVD-0018`, `EVD-0019`; two exact migration tests plus article/import/service/route tests in `EVD-0029`. | Production read-write authoritative article; lifecycle/physical classification incomplete. |
| `DBO-0002` | Data-source routes and query service create/read/update/archive/import state (`EVD-0024`). | Base/data-only migrations and `DataSourcesRoutes.test.ts` (`EVD-0018`, `EVD-0019`, `EVD-0029`). | Production read-write source configuration; hard-delete/retention proof incomplete. |
| `DBO-0003` | Import store/FHIR ensure rows; import-route route and multiple scope/import/transfer readers (`EVD-0023`-`EVD-0025`). | Base migration and import/data-source tests (`EVD-0018`, `EVD-0029`). | Production read-write route identity. |
| `DBO-0004` | None found by exact qualified or unqualified literal search. | Base migration and old plan only (`EVD-0018`, `EVD-0030`). | Schema-only unresolved object; absence from literal search is not deletion proof. |
| `DBO-0005`, `DBO-0012`-`DBO-0014` | Import/transfer upsert and sync; selected-import/display/detail/scope/job/export/compatibility readers (`EVD-0023`, `EVD-0025`, `EVD-0026`). | Four migration stages and source-record/import/transfer/service tests (`EVD-0020`, `EVD-0029`). | Production read-write current selected route link; retention and index-use measurement incomplete. |
| `DBO-0006`, `DBO-0015`, `DBO-0016` | Import upsert/remap quarantine/sync; canonical matching, compatibility, selected-import/display/detail/export readers (`EVD-0023`, `EVD-0025`, `EVD-0026`). | 0078 plus exact idempotency test and service/Covidence tests (`EVD-0020`, `EVD-0029`). | Production read-write source history/quarantine; retention/recovery horizon unresolved. |
| `DBO-0007`, `DBO-0017` | Project/subproject/transfer create/edit/clone/archive/delete; routes, jobs, projectors, cleanup, export/transfer readers (`EVD-0025`, `EVD-0028`). | Project migration chain and route/cleanup tests (`EVD-0021`, `EVD-0029`). | Production read-write project truth; project-side FK absence is current declared shape. |
| `DBO-0008`, `DBO-0018`, `DBO-0019` | Project/subproject/add/clone/transfer writes, delete/cleanup, and broad scope/projector/job/export reads (`EVD-0025`, `EVD-0028`). | Project/article migration chain and route/service tests (`EVD-0020`, `EVD-0021`, `EVD-0029`). | Production read-write project membership; full replay/retention and physical index proof incomplete. |
| `DBO-0009`, `DBO-0020` | Project/clone/transfer route-link writes, edit/cleanup deletes, and scope/projector/job/export reads (`EVD-0025`, `EVD-0028`). | Project migration chain and route/service tests (`EVD-0021`, `EVD-0029`). | Production read-write project route membership; project-first access relies on uniqueness rather than a current named duplicate index. |
| `DBO-0010` | `SubprojectsRoutes.ts#subprojectsRoutes` reads source projects/prompts/routes, selects articles, then writes project/prompt/article rows (`EVD-0025`). | `SubprojectsRoutes.test.ts`, `SubprojectsRoutes.rollback.test.ts`, and task plans (`EVD-0029`, `EVD-0030`). | Logical workflow only; intended parent/provenance semantics require owner confirmation. |

### Unavailable Runtime Evidence

| Evidence domain | State | Consequence |
| --- | --- | --- |
| Applied migration set and deployed schema/index inventory | `unavailable` | Checked-in effective declarations are enumerated, but no claim is made that a deployed database has every migration or lacks drift; `BLK-0007`. |
| Row counts, logical/physical bytes, null ratios, distinct counts, oldest/newest timestamps, WAL/spill, and index sizes | `unavailable` | No `measured` or `classified` status is used. |
| Actual optimizer selection and cost for the ten named indexes | `unavailable` | Query predicates are source-traced, but index usefulness is unresolved. |
| Runtime JSON key frequencies and unexpected keys | `unavailable` | Open wildcard domains remain blocked; no resolver/default/source fixture is substituted for a snapshot. |
| Subproject parent/source provenance in stored rows | `absent from declared schema and production write` | Source project IDs influence selection only; product intent is an owner question, not an inferred missing column. |

## US-004 Prompt, Model, And Review-Configuration Census

This census continues the US-003 lexical migration-chain method and uses only
checked-in migrations, production source, and tests. No live DuckDB was opened
or queried and no runtime was started. One focused verification suite applied
the checked-in migrations to its auto-cleaned isolated temporary database; that
non-production fixture corroborates tests only and supplies no census or
physical evidence. Physical fields already enumerated by US-003 are
cross-referenced rather than duplicated. Every disposition remains
`unresolved`; no recommendation, repository schema, route, projector, retention
policy, runtime behavior, or persistent data is changed.

### US-004 Exact Evidence Ledger

| rowId | Source class | Exact locator | Claim supported | Exposed by |
| --- | --- | --- | --- | --- |
| `EVD-0031` | `historical-migration` | `src/db/duckdbMigrations/0000_nativeDuckdbSchema.sql` exact `app.prompt` and `app.project_prompt` declarations; `0021_rebuildModelWithProviderConnections.sql`; `0029_dropModelProviderConnectionForeignKey.sql`; `0039_humanJudgmentSummaryMode.sql`; `0040_projectPromptCriteriaDispositionCombined.sql`; `0044_dropProjectEngine.sql`; `0081_dropProjectChildParentForeignKeys.sql` | Supplies the complete prompt/project-prompt chain: prompt remains the nine-column bootstrap declaration; 0081 is the final 12-column project-prompt rebuild, removes project/origin-project FKs, retains the prompt FK and unique pair, and recreates the only named project-prompt index. | `CMD-0029`, `CMD-0030` |
| `EVD-0032` | `historical-migration` | `0000_nativeDuckdbSchema.sql`; `0014_providerConnections.sql`; `0020_cleanupProviderModelColumns.sql`; `0021_rebuildModelWithProviderConnections.sql`; `0029_dropModelProviderConnectionForeignKey.sql`; `0030_providerConnectionMaxInflightRequests.sql`; `0083_providerModelNaturalKey.sql` | Supplies the complete model/provider chain: 0029 is the final 11-column model declaration without a provider FK, 0014 plus 0030 declares the 13-column provider connection, and 0083 adds the model natural-key expression index after remapping duplicate references. | `CMD-0029`, `CMD-0030` |
| `EVD-0033` | `production` | `src/db/schemaTypes.ts#PromptRecord`, `#ProjectPromptRecord`, `#ModelRecord`, `#ProviderConnectionRecord`, `#ProjectRecord`; `src/server/utils/computePromptContentHash.ts#computePromptContentHash`; `src/server/services/immutablePromptService.ts#immutablePromptIdentityReviewServingFields`, `#getOrCreateImmutablePromptTx` | Corroborates field mappings and writer-supplied UUIDs; immutable prompt content identity is MD5 over normalized original/transformed/heading/type values and is stored in the nullable unique `content_hash`. | `CMD-0031` |
| `EVD-0034` | `production` | `src/server/routes/ProjectsRoutes.ts#getChangedReviewConfigFields`, `#upsertProjectPromptTx`, project create/edit/clone handlers; `src/server/routes/PromptsRoutes.ts`; `src/server/services/covidenceImportService.ts`; `src/server/routes/SubprojectsRoutes.ts`; `src/server/services/insertArticlesIntoProject.ts` | Traces project, content/date, prompt membership/order/state/criteria, and selected-route reads and writes. Route validation enforces `dateFrom <= dateTo` and mutual exclusion of full-text modes, but the effective SQL schema has no matching `CHECK`. | `CMD-0031`, `CMD-0033` |
| `EVD-0035` | `production` | `src/server/providers/providerModelRepository.ts`; `providerConnectionRepository.ts`; `providerModelMetadata.ts#ProviderModelMetadata`, `#getProviderModelMetadataOptions`, `#getProviderRuntimeModelIdentity`; `providerDbUtils.ts#getProviderConnectionConfigFromJson`, `#getPersistedProviderConnectionConfigValue`; `src/utils/providerModelOptions.ts` | Traces model/provider allocation, update/archive/delete behavior, the model expression natural key, normalized metadata/config JSON keys, legacy aliases, and execution-option reads. Both JSON columns remain typed `unknown` and admit transfer-preserved extra keys. | `CMD-0031`, `CMD-0032` |
| `EVD-0036` | `production` | `src/server/reviewServing/reviewServingV4RebuildRequestService.ts#getReviewServingV4BootstrapArticleRanges`, `#getReviewServingV4RebuildStats`; `src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts#filterAlreadyJudged`, `#getJobConfig`; `judgmentsJobsCronGetPrompts.ts`; `src/server/services/projectVisibleJudgmentRule.ts#getProjectVisibleJudgmentPromptSql`; `src/agent/judge/judgeStoreJudgment.ts#getAffectedProjectIdsForStoredJudgment` | Enumerates scope/applicability predicates and exposes differing treatment of project/prompt/link archival and date range across queue, projector, and judgment-invalidation paths. | `CMD-0033` |
| `EVD-0037` | `production` | `src/server/reviewServing/reviewServingReviewConfig.ts`; `reviewProjectionIdentity.ts`; `reviewServingSelectedImportProjector.ts#getReviewServingSelectedImportSnapshotId`; `reviewServingV4RebuildRequestService.ts#getReviewServingV4BootstrapSnapshotId`; `src/server/services/reviewServingProjectConfigIdentity.ts`; `src/server/workers/reviewServingProjectorWorker.ts#getReviewConfigHash`; `reviewServingLlmStatusProjector.ts#getReviewConfigHash` | Defines prompt/review hashes, generic and dirty projection identities, selected-import and V4 snapshot IDs, and composed route identity. The duplicated production review-hash implementations use the same enumerated inputs. | `CMD-0033` |
| `EVD-0038` | `production` | `src/server/services/judgmentExecutionSnapshotService.ts#JudgmentExecutionSnapshotRow`, `#SnapshotIdentityInput`, `#getSnapshotPayload`, `#getJudgmentExecutionSnapshotHash`; `src/agent/judge/storeSinglePromptJudgment.ts`; `judgeStoreJudgment.ts`; `src/server/services/projectVisibleJudgmentRule.ts` | Defines judgment natural identity, active-deletion semantics, and the execution snapshot's request identity plus SHA-256 stable-payload identity, including project dates, selected route, prompt, provider/model, article, and four content flags. Physical judgment/snapshot tables are deferred to their owning census stories. | `CMD-0033` |
| `EVD-0039` | `production` | `src/server/reviewServing/reviewConfigReviewServingDeltaService.ts#PromptConfigReviewServingField`, `#ProjectReviewConfigReviewServingField`, provider/model delta appenders; `reviewServingInvalidationRegistry.ts` rules `prompt.config.updated` and `project.reviewConfig.updated`; project/prompt/provider repositories and routes that append those deltas | Enumerates every declared invalidation field and affected component. Project-prompt criteria metadata is consumed downstream but absent from both field unions. | `CMD-0033` |
| `EVD-0040` | `production` | `src/server/services/projectTransfer/projectTransferSnapshotFingerprint.ts`; `projectTransfer/projectTransferCommitWriter.ts#getImportedSnapshotJson`; `projectTransfer/projectTransferExport.ts`; `src/server/services/archivedProjectCleanupService.ts`; provider/model repositories | Enumerates transfer snapshot-fingerprint JSON, import markers, export/transfer fields, and observed archive/delete cleanup while preserving unknown JSON keys. Complete retention/recovery horizons remain unavailable. | `CMD-0031`, `CMD-0032` |
| `EVD-0041` | `test` | `src/server/services/immutablePromptService.test.ts`; `src/server/providers/providerModelRepository.test.ts`; `providerModelMetadata.test.ts`; `providerDbUtils.test.ts`; `src/utils/providerModelOptions.test.ts`; `src/server/reviewServing/reviewProjectionIdentity.test.ts`; `reviewConfigReviewServingDeltaService.test.ts`; `reviewServingInvalidationRegistry.test.ts`; `src/server/services/judgmentExecutionSnapshotService.test.ts`; `src/db/migrateDuckdb.test.ts` test `provider model natural key migration deduplicates existing model references before adding the index` | Non-production corroboration for immutable prompt reuse, model natural-key behavior, JSON normalization, hash ordering/dimensions, delta propagation, invalidation rules, snapshot hashing, and migration intent. Tests do not prove deployed schema or runtime data. | `CMD-0034` |

### Effective Physical Objects, Constraints, And Final Declarations

The effective shape is derived after the entire lexical migration list. Every
`id` is `VARCHAR` with no database allocator; production writers provide UUIDs.
Nullable columns are explicitly shown by the absence of `NOT NULL`.

| Object ID | Effective object and every current column | Identity and constraints | Final declaring migrations | Current named indexes |
| --- | --- | --- | --- | --- |
| `DBO-0021` | `app.prompt`: `id VARCHAR`; `original_text VARCHAR NOT NULL`; `transformed_text VARCHAR`; `prompt_heading VARCHAR`; `type VARCHAR`; `content_hash VARCHAR`; `archived BOOLEAN NOT NULL DEFAULT FALSE`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; `UNIQUE(content_hash)`. The unique value can be null for legacy rows. Current writers use a UUID and normalized four-part MD5 content hash, then reuse on conflict rather than mutate prompt identity. | `0000_nativeDuckdbSchema.sql` is final; no later DDL changes the table. | None beyond constraints. |
| `DBO-0022` | `app.project_prompt`: `id VARCHAR`; `project_id VARCHAR NOT NULL`; `prompt_id VARCHAR NOT NULL`; `prompt_order INTEGER`; `enabled BOOLEAN NOT NULL DEFAULT TRUE`; `archived BOOLEAN NOT NULL DEFAULT FALSE`; `origin_project_id VARCHAR`; `criteria_disposition project_prompt_criteria_disposition_v2`; `criteria_section_key VARCHAR`; `criteria_section_label VARCHAR`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; FK only `prompt_id -> app.prompt(id)`; `UNIQUE(project_id, prompt_id)`; enum values `include`, `exclude`, `combined`. 0081 removes project/origin-project FKs. | Final 0081 rebuild after `0000` -> `0021` -> `0029` -> `0039` -> `0040` -> `0044`. | `DBO-0025`: `idx_app_project_prompt_project_id (project_id, prompt_id)`. |
| `DBO-0023` | `app.model`: `id VARCHAR`; `provider_connection_id VARCHAR NOT NULL`; `name VARCHAR NOT NULL`; `remote_model_id VARCHAR`; `display_name VARCHAR`; `variant VARCHAR`; `source VARCHAR`; `enabled BOOLEAN NOT NULL DEFAULT TRUE`; `metadata_json JSON`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | `PRIMARY KEY(id)`; no provider FK and no enum/check on `source`. Current repository natural lookup is provider connection + remote model + normalized variant. | Final table declaration is 0029 after `0000` -> `0014` -> `0020` -> `0021`; 0083 remaps references/data and adds the expression index. | `DBO-0026`: unique `idx_app_model_provider_remote_variant_unique (provider_connection_id, remote_model_id, COALESCE(variant, ''))`. |
| `DBO-0024` | `app.provider_connection`: `id VARCHAR`; `provider_kind VARCHAR NOT NULL`; `label VARCHAR NOT NULL`; `enabled BOOLEAN NOT NULL DEFAULT TRUE`; `auth_mode VARCHAR`; `base_url VARCHAR`; `config_json JSON`; `secret_ref VARCHAR`; `last_checked_at TIMESTAMPTZ`; `last_error VARCHAR`; `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp`; `max_inflight_requests INTEGER` | `PRIMARY KEY(id)` only. There is no uniqueness, FK, enum, URL, secret-reference, or positive-integer `CHECK`; repository normalization supplies those semantics where used. | 0014 creates 12 columns; 0030 adds `max_inflight_requests`; 0083 changes configuration data but not DDL. | None beyond the PK constraint. |

US-004 adds **4 physical tables, 45 physical columns, and 2 current named
indexes**. Together with five logical composites below, it adds 11 `DBO-####`
rows. Constraint-backed uniqueness is not double-counted as a named index.

### Persisted JSON Key And Open-Domain Census

| Field IDs | JSON column | Exact material keys/paths | Identity/use | Closure |
| --- | --- | --- | --- | --- |
| `CMF-0201` | `app.model.metadata_json` | `$.discovery.capabilities.reasoningEfforts[*]`; `$.discovery.capabilities.supportedOptions.thinking`; `$.discovery.contextWindow.{inputTokens,outputTokens,totalTokens}`; `$.discovery.identity.{displayName,modelName,remoteModelId,variant,version}`; `$.discovery.providerKind`; `$.discovery.runtime.{baseURL,modelName,servedModelName}`; `$.discovery.source` | Normalized discovery, capabilities, context, model/runtime identity, display, and transfer fingerprint inputs. | Statically typed current builder. |
| `CMF-0202` | `app.model.metadata_json` | `$.options.{thinking,thinkingMode}` plus accepted `$.options.thinking_mode` | Persisted benchmark-critical execution options; the whole `$.options` object enters review-config/model-execution identity. | Named current writer plus legacy read alias. |
| `CMF-0203` | `app.model.metadata_json` | Recursive aliases `contextLength`, `context_length`, `contextWindow`, `context_window`, `maxInputTokens`, `max_input_tokens`, `inputTokenLimit`, `input_token_limit`, `maxSequenceLength`, `max_sequence_length`, `tokenLimit`, `token_limit`, `maxModelLen`, `max_model_len`, `maxSeqLen`, `max_seq_len`, `maxPositionEmbeddings`, `max_position_embeddings`, `nCtxTrain`, `n_ctx_train`, `numCtx`, `num_ctx`, `maxOutputTokens`, `max_output_tokens`, `outputTokenLimit`, `output_token_limit`, `maxCompletionTokens`, `max_completion_tokens`, `model`, `modelName`, `model_name`, `modelPath`, `model_path`, `servedModelName`, `served_model_name`, `reasoningEffort`, `reasoning_effort`, `supportedReasoningEfforts`, `supported_reasoning_efforts`; direct `thinking`, `thinkingMode`, `thinking_mode`; legacy `variant` | Backward-compatible context, output, runtime-name, and reasoning resolution. Alias presence can change effective execution without being separately named in the review hash, which reads only `$.options`. | Statically named aliases; locations are recursively searched. |
| `CMF-0204` | `app.model.metadata_json` | `$.projectTransferImportedSnapshot.{sourceModelId,sourceProviderConnectionId,snapshotFingerprint}`; `.snapshotFingerprint.model.{contextLimit,displayName,modelName,name,promptTokenLimit,remoteModelId,variant,version}`; `.snapshotFingerprint.model.modelOptions.{thinking,thinkingMode}`; `.snapshotFingerprint.provider.{authMode,endpointIdentity,providerKind,transportFamily}`; `.snapshotFingerprint.provider.runtimeMode.{llamaCppMode,workerUrlMode}` | Imported model reuse/deduplication and transfer fidelity. | Statically named transfer marker/fingerprint. |
| `CMF-0205` | `app.model.metadata_json` | `$.<provider-, runtime-, legacy-, or transfer-preserved key/path>` | Unknown provider metadata can affect future consumers and is retained by object spreads/transfer. | Open; `BLK-0010`. |
| `CMF-0206` | `app.provider_connection.config_json` | `$.archived`; `$.disabledModelIds[*]`; `$.llamaCppMode`; `$.manualWorkerUrls[*]`; `$.workerUrlMode`; legacy `$.workerUrls[*]` | Effective connection/model enablement, local runtime mode, worker routing, and persisted provider configuration. | Statically named current config plus legacy alias. |
| `CMF-0207` | `app.provider_connection.config_json` | `$.projectTransferImportedSnapshot.{sourceProviderConnectionId,snapshotFingerprint}`; `.snapshotFingerprint.{authMode,endpointIdentity,providerKind,transportFamily}`; `.snapshotFingerprint.runtimeMode.{llamaCppMode,workerUrlMode}` | Imported provider reuse/deduplication and transfer fidelity. | Statically named transfer marker/fingerprint. |
| `CMF-0208` | `app.provider_connection.config_json` | `$.<provider- or transfer-preserved key/path>` | Transfer/config parsing preserves the imported marker and can preserve unrecognized source fields. | Open; `BLK-0010`. |

The eight JSON path-family rows enumerate every statically material key found
for these two columns. `CMF-0205` and `CMF-0208` are authoritative open-domain
rows, not omitted finite lists.

### Logical Configuration Objects And Persisted Backing Fields

No standalone `app.project_scope`, `app.content_setting`, `app.date_range`,
`app.selected_route`, or `app.project_review_config` table exists. These five
objects are logical compositions over the following already-censused fields.

| Object ID | Logical object | Every persisted backing field and constraint | Applicability/consumer semantics | Indexes |
| --- | --- | --- | --- | --- |
| `DBO-0027` | Project scope/applicability | `app.project.{id,archived,date_from,date_to}` (`CMF-0088`, `CMF-0096`-`CMF-0098`); `app.project_article.{project_id,article_id}` (`CMF-0104`, `CMF-0105`, unique pair); `app.project_import_route.{project_id,import_route_id}` (`CMF-0110`, `CMF-0111`, unique pair); `app.article_import_route.{article_id,import_route_id}` (`CMF-0032`, `CMF-0033`, unique pair); `app.article.article_created_at` (`CMF-0058`) | Scope is the union of curated project membership and articles linked to selected routes, with inclusive nullable article-created-at bounds. Project archived gating and date checks are not uniformly applied by every judgment/invalidation consumer; `BLK-0011`. | Existing `DBO-0012`, `DBO-0014`, `DBO-0018`-`DBO-0020`; the selected-route link has no current project-first named index beyond unique-pair enforcement. |
| `DBO-0028` | Content setting | `app.project.{use_title,use_abstract,use_fulltext,use_fulltext_no_images}` (`CMF-0092`-`CMF-0095`), all non-null with defaults `TRUE, TRUE, FALSE, FALSE` | All four enter judgment natural identity, review-config hash, judgment-input-content identity, execution snapshots, and visibility predicates. Routes reject both full-text modes being true; the DB does not. | Project PK only; no content-setting index/check. |
| `DBO-0029` | Date range | `app.project.{date_from,date_to}` (`CMF-0096`, `CMF-0097`), both nullable | Scope projectors apply inclusive `article.article_created_at >= date_from` and `<= date_to`. Routes reject an inverted range; the DB does not. Dates are invalidation fields and execution-snapshot inputs but not review-config-hash or judgment-natural-key dimensions. | Project PK only; no date-range index/check. |
| `DBO-0030` | Selected route | `app.project_import_route.{id,project_id,import_route_id,created_at,updated_at}` (`CMF-0109`-`CMF-0113`), PK, import-route FK only, unique project/route pair | The selected route set feeds scope, selected-import projection, execution snapshots, export/transfer, and `importRoutes` invalidation. Link order/timestamps do not enter the selected-import snapshot ID; membership changes advance deltas/watermarks. | Existing reverse `DBO-0020`; no current named project-first index after final rebuild. |
| `DBO-0031` | Project review configuration/hash | `app.project.{id,model_id,human_judgment_mode,use_title,use_abstract,use_fulltext,use_fulltext_no_images}` (`CMF-0088`, `CMF-0091`-`CMF-0095`, `CMF-0101`); active `app.project_prompt.{project_id,prompt_id,prompt_order,enabled,archived}` (`CMF-0166`-`CMF-0170`); `app.prompt.{id,original_text,content_hash,archived}` (`CMF-0156`, `CMF-0157`, `CMF-0161`, `CMF-0162`); model/provider execution fields `CMF-0177`, `CMF-0178`, `CMF-0180`, `CMF-0182`, `CMF-0185`, `CMF-0188`, `CMF-0189`, `CMF-0193` | Hash input is Human mode, model ID, provider connection/kind/base URL, remote model ID, variant, `metadata_json.$.options`, four content flags, and ordered active prompt config hashes. Dates, selected routes, project archived state, prompt criteria, and most provider/model fields are outside this hash and travel through other identities/invalidation paths. | Backing PK/unique/index rows `DBO-0007`, `DBO-0017`, `DBO-0021`-`DBO-0026`; no standalone review-config index or constraint. |

### Applicability, Judgment, Projection, Snapshot, And Invalidation Dimensions

| Identity/decision | Exact dimensions used | Normalization/order and persistence boundary | Evidence |
| --- | --- | --- | --- |
| Immutable prompt content identity | Normalized `original_text`, `transformed_text`, `prompt_heading`, `type` | Edge spaces/trailing whitespace and line endings normalized, joined with `|`, MD5; persisted as nullable `prompt.content_hash`; UUID remains PK. | `EVD-0033` |
| Project-prompt membership identity | `project_id`, `prompt_id` | SQL unique pair; link UUID is PK. `prompt_order`, states, origin, and criteria are attributes, not membership-key columns. | `EVD-0031`, `EVD-0034` |
| Model natural identity | `provider_connection_id`, `remote_model_id`, `COALESCE(variant,'')` | Unique expression index; UUID is PK. Name/display/source/enabled/metadata are outside the SQL natural key. | `EVD-0032`, `EVD-0035` |
| Provider connection identity | `id` only | UUID PK; provider kind/label/auth/base/config/secret have no SQL uniqueness contract. | `EVD-0032`, `EVD-0035` |
| Applicability/scope | Project ID; curated `(project_id, article_id)` membership; selected `(project_id, import_route_id)` joined to `(article_id, import_route_id)`; nullable inclusive dates against `article_created_at`; project/prompt/link state depending on caller | The projector scope union applies dates. Active prompt review config requires link `enabled`, link not archived, and prompt not archived. Other callers differ as recorded below. | `EVD-0034`, `EVD-0036` |
| Active LLM judgment natural identity | `article_id`, `prompt_id`, `model_id`, `use_title`, `use_abstract`, `use_fulltext`, `use_fulltext_no_images`, with `deleted_at IS NULL` visibility | SQL uniqueness also carries `delete_generation`; provider identity/options and prompt content hash are not direct judgment-key dimensions. Judgment-table DDL is owned by a later census. | `EVD-0036`, `EVD-0038` |
| Prompt config hash | `promptId`, `promptTextHash`, `answerSchemaHash`, `settingsVersion`, `thresholdVersion` | SHA-256 stable JSON. Current rows set answer/threshold null and settings `prompt-v1`; text hash is `content_hash`, else SHA-256 of only `original_text`, then falls back to prompt ID if null. | `EVD-0037` |
| Project review-config hash | Human mode; model ID twice (top level and execution object); execution object `{modelExecutionOptions,modelId,providerBaseUrl,providerConnectionId,providerKind,remoteModelId,variant}`; prompt `{promptConfigHash,promptId,promptOrder}` list; four content flags | SHA-256 stable JSON. Prompt inputs are selected in order but hash builder sorts them by prompt ID; null order becomes query-result index. Persisted later in serving/control rows, not in a dedicated config table. | `EVD-0037` |
| Declared component projection identity | Generic `{component,definitionVersion,upstreamDigests}`; judgment-input helper adds sorted `contentDependencyKeys` plus four flags; project-scope helper adds sorted `projectScopeDependencyKeys`; dirty/bootstrap identity uses `{projectId,projectionComponent}` | SHA-256 stable JSON. Specialized content/scope helpers are source-declared and test-covered but have no non-test call site; current bootstrap production uses the dirty identity. Later manifest rows persist projection identities. | `EVD-0037`, `EVD-0041` |
| Selected-import snapshot ID | Definition version, project ID, project-scope identity, import-run/article source-delta high-water | Stable SHA-256 truncated to 32 hex characters with `selectedImport:` prefix. | `EVD-0037` |
| V4 bootstrap snapshot ID | Project ID, review-config hash, selected-import snapshot ID, complete source-partition watermark record | Stable SHA-256 truncated to 32 hex characters with `snapshot:` prefix. | `EVD-0037` |
| Composed route identity | Required and optional component sets; for each component `{baseGeneration,component,patchWatermark,projectionIdentity}` or null state; contract key; review-config hash; route version; optional selected-import snapshot ID | Component names and object keys are sorted before SHA-256. Persisted serving/snapshot ownership is deferred. | `EVD-0037` |
| Judgment execution snapshot identity | Request lookup `{jobId,queueRecordId,claimId}`; stored row identity includes snapshot UUID/hash, project/article/prompt/model IDs and four flags; stable payload hash covers snapshot version, project name/dates/content flags, selected route/source record, prompt content/order/state, provider auth/base/config/enable/kind/label/max-inflight/secret, model identity/metadata, and article/scoped payload | Full stable payload receives SHA-256; fields are not defaulted into the review-config hash. Snapshot table/JSON field census is deferred, but every US-004 configuration dimension is recorded here. | `EVD-0038` |
| Invalidation identity | Prompt fields: `answerSchema`, `archived`, `enabled`, `promptHeading`, `promptOrder`, `promptText`, `promptType`, `thresholding`. Project fields: `archived`, `dateFrom`, `dateTo`, `humanJudgmentMode`, `importRoutes`, `modelExecutionIdentity`, `modelId`, `promptMembership`, and four content flags. Delta typed keys add project/prompt IDs and source high-water/mutation identity. | `prompt.config.updated` uses prompt-scoped rebuild from LLM status; `project.reviewConfig.updated` uses component rebuild from project scope. Provider/model mutations emit `modelExecutionIdentity`. | `EVD-0039` |

### Preserved Cross-Contract Gaps

These are source observations, not proposed fixes or dispositions.

| Gap | Exact observation | Consequence |
| --- | --- | --- |
| Legacy prompt hash | New immutable prompt identity covers original/transformed/heading/type, but review-config fallback for a null `content_hash` hashes only `original_text`. | Legacy transformed text, heading, or type changes can be invisible to that fallback; authoritative compatibility policy is missing. |
| Prompt criteria metadata | `criteria_disposition`, `criteria_section_key`, and `criteria_section_label` feed payload/summary/comparison/export behavior. They are absent from prompt/review hash inputs and both invalidation field unions. | Configuration can affect review interpretation without an enumerated review-identity/invalidation dimension. |
| Prompt state applicability | Review-config/projector reads require enabled and both link/prompt not archived. Queue/live-prompt and judgment-visibility paths do not all apply the same three predicates. | Reachability and reuse can differ by caller for the same stored configuration. |
| Scope/date applicability | Projector scope applies inclusive dates; stored-judgment affected-project lookup matches archived/model/flags and scope membership but does not apply dates or prompt/link archival. | A judgment delta can target a different project set than a scope rebuild. |
| Model/provider execution | Review hash includes provider connection/kind/base URL, model remote ID/variant, and only `metadata_json.$.options`; judgment natural key uses model UUID plus flags. Execution snapshots include materially more provider/model/config state. | In-place execution-setting changes can invalidate review state while matching the prior judgment key. |
| Route-only constraints | API validation rejects inverted dates and simultaneous full-text modes; DuckDB has no corresponding `CHECK`, and transfer/import writers are separate paths. | Static schema alone cannot certify persisted values satisfy route rules. |

All six gaps remain under `BLK-0011`; no resolver default, migration proposal,
or assumed authoritative contract is introduced.

### US-004 Unavailable Runtime Evidence

| Evidence domain | State | Consequence |
| --- | --- | --- |
| Applied migration set and deployed table/column/constraint/index inventory | `unavailable` | The checked-in effective declarations are complete, but deployed drift/existence is not claimed; `BLK-0007`. |
| Row counts, widths, null/distinct distributions, update ages, index size/use/selectivity/write cost | `unavailable` | All US-004 DBO/CMF rows remain nonterminal or blocked; no physical classification is inferred. |
| Runtime keys for model/provider JSON | `unavailable` | Two open domains remain blocked without a closed schema or approved immutable non-live profile; `BLK-0010`. |
| Authoritative applicability and identity contract | `conflicting source behavior` | The observed hash/key/invalidation/caller differences remain explicit under `BLK-0011` and owner questions rather than being normalized by the audit. |

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
| `DBO-0001` | Table `app.article` | `PRIMARY KEY(id)`; 34 columns; `article_id` nullable/non-unique | Canonical article/import services | Final 0077 rebuild after 0000/0013/0016/0022; 0083 data-only remap | Canonical/import/transfer/full-text writers; app/review/job/export/transfer readers | Article migrations and exact canonical-identifier migration test | `EVD-0017`-`EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0029` | `traced-to-writer` | Complete cleanup/recovery/retention lineage, approved deployed schema, physical shape, and index-plan evidence are missing. | `OQ-0004`, `OQ-0010` |
| `DBO-0002` | Table `app.data_source` | `PRIMARY KEY(id)`; 12 columns | Data-source routes/service | 0000; 0011 data-only OpenAlex reset | Create/read/update/archive/import routes and query service | Base/data migration and DataSources tests | `EVD-0018`, `EVD-0024`, `EVD-0029` | `traced-to-writer` | Hard-delete/retention/recovery behavior, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `DBO-0003` | Table `app.import_route` | `PRIMARY KEY(id)`; `UNIQUE(route)`; 7 columns | Import store and import-route API | 0000 only | Ensure/upsert writers and route/scope/import/transfer readers | Base migration and import/data-source tests | `EVD-0018`, `EVD-0023`-`EVD-0025`, `EVD-0029` | `traced-to-writer` | Deactivation/deletion/retention/recovery, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `DBO-0004` | Table `app.data_source_import_route` | `PRIMARY KEY(id)`; FKs to data source/import route; unique pair; 5 columns | No production owner found | 0000 only | None found | Base migration; old plan says “if/when live writes exist” | `EVD-0018`, `EVD-0030` | `traced-to-api` | Writer, consumer, lifecycle, dynamic-reference closure, deployed schema, and physical evidence are missing; `BLK-0009`. | `OQ-0010`, `OQ-0013` |
| `DBO-0005` | Table `app.article_import_route` | `PRIMARY KEY(id)`; FKs to article/import route; unique pair; 13 columns | Article import/transfer services | 0000 -> 0013 -> 0077 -> 0078; 0092 index | Current-link upsert/sync/transfer; scope/projector/detail/export/compatibility reads | Four migrations and import/source-record/transfer tests | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026`, `EVD-0029` | `traced-to-writer` | Full retention/recovery/cleanup lineage, deployed schema, physical shape, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `DBO-0006` | Table `app.article_import_route_source_record` | `PRIMARY KEY(id)`; FKs; `UNIQUE(import_route_id, source_record_key)`; 16 columns | Article import service | 0078 only | Source-record upsert/remap quarantine/sync; canonical/compatibility/projector/detail/export reads | 0078 and exact idempotency/service/Covidence tests | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026`, `EVD-0029` | `traced-to-writer` | Required history/quarantine retention and replay policy, deployed schema, physical shape, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `DBO-0007` | Table `app.project` | `PRIMARY KEY(id)`; enum Human mode; no model FK; 15 columns | Project/subproject/transfer routes | Final 0089 after 0000/0021/0029/0039/0044/0067/0083 | Create/edit/clone/subproject/transfer/archive/delete and broad project/review reads | Project migration chain and project/subproject/cleanup tests | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028`, `EVD-0029` | `traced-to-writer` | Complete replay/recovery/retention and all dependent cleanup proof, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `DBO-0008` | Table `app.project_article` | `PRIMARY KEY(id)`; article FK only; unique project/article; 6 columns | Project/add/subproject/transfer routes | Final 0081 after 0000/0013/0021/0029/0044/0077; 0091 index | Add/clone/subproject/transfer writes, route removal/cleanup, broad scope reads | Migration chain and project/add/subproject/transfer tests | `EVD-0020`, `EVD-0021`, `EVD-0025`, `EVD-0028`, `EVD-0029` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical shape, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `DBO-0009` | Table `app.project_import_route` | `PRIMARY KEY(id)`; import-route FK only; unique project/route; 5 columns | Project/subproject/transfer routes | Final 0081 after 0000/0021/0029/0044; 0091 index | Project/clone/transfer writes, edit/cleanup deletes, scope/projector/job/export reads | Migration chain and project/transfer/cleanup tests | `EVD-0021`, `EVD-0025`, `EVD-0028`, `EVD-0029` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical shape, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `DBO-0010` | Logical subproject shape; no table | Ordinary project ID plus project-prompt/project-article links; no persisted parent/source ID | Subproject route | No subproject DDL in the ordered migration set | `SubprojectsRoutes.ts#subprojectsRoutes` | Subproject and rollback tests; task plans | `EVD-0025`, `EVD-0029`, `EVD-0030` | `traced-to-writer` | Product intent for subproject identity/provenance and complete prompt/link lifecycle remain unresolved. | `OQ-0012` |
| `DBO-0011` | Index on `app.article` | `idx_app_article_article_id (article_id)` | Migration/index maintenance | Recreated by 0077 | Legacy-ID/canonical lookup predicates | 0000/0013/0077 and canonical migration test | `EVD-0019`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0012` | Index on `app.article_import_route` | `idx_app_article_import_route_import_route_id (import_route_id, article_id)` | Migration/index maintenance | Recreated by 0077 | Route-first scope/selected-import predicates | 0000/0013/0077 and import tests | `EVD-0020`, `EVD-0023`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0013` | Index on `app.article_import_route` | `idx_app_article_import_route_external_article_id (import_route_id, external_article_id)` | Migration/index maintenance | Created by 0078 | Import-scoped external-ID and compatibility predicates | 0078 and exact source-record migration test | `EVD-0020`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0014` | Index on `app.article_import_route` | `idx_app_article_import_route_article_id (article_id, import_route_id)` | Migration/index maintenance | Bootstrap copy is lost in rebuilds; restored by 0092 | Article-first current-link joins | 0000/0092 and exact source-record migration test | `EVD-0018`, `EVD-0020`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0015` | Index on source-record table | `idx_app_article_import_route_source_record_article (article_id, import_route_id)` | Migration/index maintenance | Created by 0078 | Article/import-route source-record joins | 0078 and import/projector tests | `EVD-0020`, `EVD-0023`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0016` | Index on source-record table | `idx_app_article_import_route_source_record_external_article_id (import_route_id, external_article_id, quarantined_at)` | Migration/index maintenance | Created by 0078 | Non-quarantined external-ID compatibility/snapshot lookup | 0078 and exact source-record migration test | `EVD-0020`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0017` | Index on `app.project` | `idx_app_project_delete_pending (delete_pending_at, id)` | Archived-project cleanup | Created 0067; recreated 0089 | Delete-pending cleanup selection | Project migrations and cleanup tests | `EVD-0021`, `EVD-0028`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0018` | Index on `app.project_article` | `idx_app_project_article_project_id (project_id, article_id)` | Migration/index maintenance | Recreated 0081 | Project-first scope/membership reads | Rebuild chain and route/service tests | `EVD-0021`, `EVD-0025`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, duplicate cost versus unique constraint, size/write cost, and deployed existence are missing. | `OQ-0010` |
| `DBO-0019` | Index on `app.project_article` | `idx_app_project_article_article_id (article_id, project_id)` | Migration/index maintenance | Created 0091 | Article-first reference/cleanup/invalidation reads | 0091 and route/service tests | `EVD-0021`, `EVD-0025`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0020` | Index on `app.project_import_route` | `idx_app_project_import_route_import_route_id (import_route_id, project_id)` | Migration/index maintenance | Created 0091 | Import-route-first affected-project lookup | 0091 and delta/projector tests | `EVD-0021`, `EVD-0025`, `EVD-0029` | `traced-to-writer` | Approved optimizer plan, size/write cost, selectivity, rebuild/recovery, and deployed existence are missing. | `OQ-0010` |
| `DBO-0021` | Table `app.prompt` | `PRIMARY KEY(id)`; nullable `UNIQUE(content_hash)`; 9 columns | Prompt/project routes and immutable prompt service | 0000 only | Immutable create/reuse/unarchive, merge/archive/delete/hash repair; project/judgment/projector/export/transfer readers | Bootstrap migration and immutable-prompt/prompt-route tests | `EVD-0031`, `EVD-0033`, `EVD-0034`, `EVD-0040`, `EVD-0041` | `traced-to-writer` | Complete legacy-null-hash, lifecycle/recovery/retention, deployed schema, and physical evidence are missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `DBO-0022` | Table `app.project_prompt` | `PRIMARY KEY(id)`; prompt FK only; unique project/prompt; nullable 3-value criteria enum; 12 columns | Project/prompt/Covidence/subproject/transfer flows | Final 0081 after 0000/0021/0029/0039/0040/0044 | Membership/order/state/criteria writes; judgment, queue, projector, summary, payload, comparison, export/transfer reads | Migration chain and route/delta/invalidation tests | `EVD-0031`, `EVD-0034`, `EVD-0036`, `EVD-0037`, `EVD-0039`-`EVD-0041` | `traced-to-writer` | Authoritative state/criteria identity and invalidation policy, full lifecycle, deployed schema, and physical evidence are missing; `BLK-0011`. | `OQ-0010`, `OQ-0015`, `OQ-0016` |
| `DBO-0023` | Table `app.model` | `PRIMARY KEY(id)`; no provider FK; 11 columns | Provider model repository and project/transfer flows | Final 0029 after 0000/0014/0020/0021; 0083 remap/index | Create/update/upsert/archive/delete/discovery; project, judgment, projector, transfer, execution-snapshot reads | Migration chain and provider model/metadata/natural-key tests | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040`, `EVD-0041` | `traced-to-writer` | Open metadata keys, execution-vs-judgment identity policy, lifecycle, deployed schema, and physical evidence are missing; `BLK-0010`, `BLK-0011`. | `OQ-0010`, `OQ-0014`, `OQ-0015` |
| `DBO-0024` | Table `app.provider_connection` | `PRIMARY KEY(id)` only; 13 columns | Provider connection repository and transfer flows | 0014 plus 0030; 0083 data-only config update | Create/update/archive/delete/check; model execution, projector, transfer, execution-snapshot reads | Provider migration/repository/config/fingerprint tests | `EVD-0032`, `EVD-0035`, `EVD-0037`-`EVD-0041` | `traced-to-writer` | Open config keys, execution-vs-judgment identity policy, lifecycle/secret recovery, deployed schema, and physical evidence are missing; `BLK-0010`, `BLK-0011`. | `OQ-0004`, `OQ-0010`, `OQ-0014`, `OQ-0015` |
| `DBO-0025` | Index on `app.project_prompt` | `idx_app_project_prompt_project_id (project_id, prompt_id)` | Migration/index maintenance | Recreated by final 0081 rebuild | Project-first active prompt/config/judgment/projector reads | Migration chain and project/prompt tests | `EVD-0031`, `EVD-0034`, `EVD-0036`, `EVD-0041` | `traced-to-writer` | Approved optimizer plan, duplicate cost versus unique constraint, size/write cost, and deployed existence are missing. | `OQ-0010` |
| `DBO-0026` | Unique expression index on `app.model` | `idx_app_model_provider_remote_variant_unique (provider_connection_id, remote_model_id, COALESCE(variant, ''))` | Provider model repository/migration | Created by 0083 after data/reference deduplication | Natural-key create/upsert/lookups | 0083 and exact migration/repository natural-key tests | `EVD-0032`, `EVD-0035`, `EVD-0041` | `traced-to-writer` | Null-remote-ID business policy, approved optimizer plan, size/write cost, and deployed existence are missing. | `OQ-0010`, `OQ-0015` |
| `DBO-0027` | Logical project scope/applicability; no table | Project/date + curated membership + selected-route/current-link membership; inclusive dates | Project routes, jobs, projectors, judgment invalidation | No standalone DDL; composed from `DBO-0001`, `DBO-0005`, `DBO-0007`-`DBO-0009` | Scope union/projector/job/judgment-affected-project reads | Scope/projector/delta tests | `EVD-0034`, `EVD-0036`, `EVD-0037`, `EVD-0039`, `EVD-0041` | `traced-to-writer` | Callers disagree on archived/date/prompt-state applicability; deployed/runtime closure and authoritative policy are missing; `BLK-0011`. | `OQ-0010`, `OQ-0016` |
| `DBO-0028` | Logical content-setting object; no table | Four non-null project flags; route-only mutual-exclusion rule | Project routes, judgment service, jobs, projectors | No standalone DDL; `app.project` fields finalized by 0089 | Judgment natural key/visibility, hash/projection/snapshot/invalidation inputs | Project/judgment/identity tests | `EVD-0021`, `EVD-0034`, `EVD-0036`-`EVD-0039`, `EVD-0041` | `traced-to-writer` | DB does not enforce route mutual exclusion; transfer/runtime and authoritative invalid-state behavior are unresolved; `BLK-0011`. | `OQ-0010`, `OQ-0016` |
| `DBO-0029` | Logical date-range object; no table | Nullable project `date_from`/`date_to`; route-only ordered-range rule | Project routes, scope projectors, execution snapshot | No standalone DDL; `app.project` fields finalized by 0089 | Inclusive applicability and invalidation/snapshot inputs; excluded from review/judgment keys | Project/scope/delta/snapshot tests | `EVD-0021`, `EVD-0034`, `EVD-0036`, `EVD-0038`, `EVD-0039`, `EVD-0041` | `traced-to-writer` | DB does not enforce ordering and affected-project judgment lookup omits dates; authoritative policy is missing; `BLK-0011`. | `OQ-0010`, `OQ-0016` |
| `DBO-0030` | Logical selected-route object; no new table | Existing project/import-route link unique pair plus current article/route link | Project/subproject/transfer routes and selected-import projector | No standalone DDL; physical link final 0081, reverse index 0091 | Scope, selected-import snapshot, execution snapshot, export/transfer, invalidation | Project/selected-import/delta/transfer tests | `EVD-0021`, `EVD-0025`, `EVD-0034`, `EVD-0036`-`EVD-0041` | `traced-to-writer` | Membership/watermark lifecycle, project-first optimizer proof, deployed schema, and authoritative invalidation closure are missing. | `OQ-0010`, `OQ-0016` |
| `DBO-0031` | Logical project review configuration/hash; no dedicated table | Active prompt hashes/order + Human mode + model/provider execution identity + four content flags | Review projectors, serving readers, rebuild/snapshot composition | No standalone DDL; composed from project/prompt/model/provider tables | Hash generation, projector manifests, snapshots, route composition, deltas | Review identity/projection/delta tests | `EVD-0033`-`EVD-0039`, `EVD-0041` | `traced-to-writer` | Criteria, legacy prompt hash, provider/model/judgment-key, scope/date/route, and caller applicability differences lack one authoritative contract; `BLK-0011`. | `OQ-0015`, `OQ-0016` |

## Coverage Manifest 05 - Columns And Material Fields

| rowId | Object ID | Column/JSON key/material field | Producer | Consumers | Pre-limit use | Post-limit use | Lifecycle | Provisional disposition | Proof IDs | Evidence IDs | auditStatus | missingEvidence | ownerQuestionIds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

| `CMF-0001` | `DBO-0002` | `id VARCHAR PRIMARY KEY` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0002` | `DBO-0002` | `title VARCHAR NOT NULL` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0003` | `DBO-0002` | `description VARCHAR` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0004` | `DBO-0002` | `import_route VARCHAR` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0005` | `DBO-0002` | `cursor VARCHAR` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0006` | `DBO-0002` | `last_import_at TIMESTAMPTZ` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0007` | `DBO-0002` | `items_after_last_import BIGINT` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0008` | `DBO-0002` | `date_from TIMESTAMPTZ` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0009` | `DBO-0002` | `date_to TIMESTAMPTZ` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0010` | `DBO-0002` | `archived BOOLEAN NOT NULL DEFAULT FALSE` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0011` | `DBO-0002` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0012` | `DBO-0002` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Data-source routes/query service and DB defaults | Data-source API and import handlers | Config/archive/date/import predicates where applicable; full field lineage pending | Data-source API/import state where selected | Create/update/archive/import observed; deletion/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0024` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0013` | `DBO-0003` | `id VARCHAR PRIMARY KEY` | Import-store/FHIR writers and DB defaults | Import-route API, scope/import/projector/transfer readers | Route/active/join predicates where applicable; full field lineage pending | Route labels/config where selected | Ensure/update observed; deactivate/delete/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0023`-`EVD-0025` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0014` | `DBO-0003` | `route VARCHAR NOT NULL` | Import-store/FHIR writers and DB defaults | Import-route API, scope/import/projector/transfer readers | Route/active/join predicates where applicable; full field lineage pending | Route labels/config where selected | Ensure/update observed; deactivate/delete/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0023`-`EVD-0025` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0015` | `DBO-0003` | `name VARCHAR` | Import-store/FHIR writers and DB defaults | Import-route API, scope/import/projector/transfer readers | Route/active/join predicates where applicable; full field lineage pending | Route labels/config where selected | Ensure/update observed; deactivate/delete/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0023`-`EVD-0025` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0016` | `DBO-0003` | `description VARCHAR` | Import-store/FHIR writers and DB defaults | Import-route API, scope/import/projector/transfer readers | Route/active/join predicates where applicable; full field lineage pending | Route labels/config where selected | Ensure/update observed; deactivate/delete/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0023`-`EVD-0025` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0017` | `DBO-0003` | `active BOOLEAN NOT NULL DEFAULT TRUE` | Import-store/FHIR writers and DB defaults | Import-route API, scope/import/projector/transfer readers | Route/active/join predicates where applicable; full field lineage pending | Route labels/config where selected | Ensure/update observed; deactivate/delete/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0023`-`EVD-0025` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0018` | `DBO-0003` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Import-store/FHIR writers and DB defaults | Import-route API, scope/import/projector/transfer readers | Route/active/join predicates where applicable; full field lineage pending | Route labels/config where selected | Ensure/update observed; deactivate/delete/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0023`-`EVD-0025` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0019` | `DBO-0003` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Import-store/FHIR writers and DB defaults | Import-route API, scope/import/projector/transfer readers | Route/active/join predicates where applicable; full field lineage pending | Route labels/config where selected | Ensure/update observed; deactivate/delete/retention incomplete | `unresolved` | — | `EVD-0018`, `EVD-0023`-`EVD-0025` | `traced-to-writer` | Complete field consumers, cleanup/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0020` | `DBO-0004` | `id VARCHAR PRIMARY KEY` | No production writer found; DB defaults are declaration-only | No production consumer found | None established | None established | Schema-only; unknown | `unresolved` | — | `EVD-0018`, `EVD-0030` | `traced-to-api` | Writer, consumer, lifecycle, dynamic-reference closure, deployed schema, and physical evidence are missing; `BLK-0009`. | `OQ-0010`, `OQ-0013` |
| `CMF-0021` | `DBO-0004` | `data_source_id VARCHAR NOT NULL REFERENCES app.data_source(id)` | No production writer found; DB defaults are declaration-only | No production consumer found | None established | None established | Schema-only; unknown | `unresolved` | — | `EVD-0018`, `EVD-0030` | `traced-to-api` | Writer, consumer, lifecycle, dynamic-reference closure, deployed schema, and physical evidence are missing; `BLK-0009`. | `OQ-0010`, `OQ-0013` |
| `CMF-0022` | `DBO-0004` | `import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id)` | No production writer found; DB defaults are declaration-only | No production consumer found | None established | None established | Schema-only; unknown | `unresolved` | — | `EVD-0018`, `EVD-0030` | `traced-to-api` | Writer, consumer, lifecycle, dynamic-reference closure, deployed schema, and physical evidence are missing; `BLK-0009`. | `OQ-0010`, `OQ-0013` |
| `CMF-0023` | `DBO-0004` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | No production writer found; DB defaults are declaration-only | No production consumer found | None established | None established | Schema-only; unknown | `unresolved` | — | `EVD-0018`, `EVD-0030` | `traced-to-api` | Writer, consumer, lifecycle, dynamic-reference closure, deployed schema, and physical evidence are missing; `BLK-0009`. | `OQ-0010`, `OQ-0013` |
| `CMF-0024` | `DBO-0004` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | No production writer found; DB defaults are declaration-only | No production consumer found | None established | None established | Schema-only; unknown | `unresolved` | — | `EVD-0018`, `EVD-0030` | `traced-to-api` | Writer, consumer, lifecycle, dynamic-reference closure, deployed schema, and physical evidence are missing; `BLK-0009`. | `OQ-0010`, `OQ-0013` |
| `CMF-0025` | `DBO-0001` | `id VARCHAR PRIMARY KEY` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0026` | `DBO-0001` | `article_id VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0027` | `DBO-0001` | `article_title VARCHAR NOT NULL` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0028` | `DBO-0001` | `article_summary VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0029` | `DBO-0001` | `article_authors VARCHAR[]` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0030` | `DBO-0001` | `article_version INTEGER` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0031` | `DBO-0001` | `article_created_at TIMESTAMPTZ` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0032` | `DBO-0001` | `article_updated_at TIMESTAMPTZ` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0033` | `DBO-0001` | `arxiv_id VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0034` | `DBO-0001` | `biorxiv_id VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0035` | `DBO-0001` | `medrxiv_id VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0036` | `DBO-0001` | `doi VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0037` | `DBO-0001` | `pubmed_id VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0038` | `DBO-0001` | `url VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0039` | `DBO-0001` | `full_text VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0040` | `DBO-0001` | `full_text_html VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0041` | `DBO-0001` | `full_text_pdf VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0042` | `DBO-0001` | `full_text_source VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0043` | `DBO-0001` | `full_text_original_format VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0044` | `DBO-0001` | `full_text_fetched_at TIMESTAMPTZ` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0045` | `DBO-0001` | `full_text_assets JSON` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0046` | `DBO-0001` | `full_text_conversion_status VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0047` | `DBO-0001` | `full_text_conversion_error VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0048` | `DBO-0001` | `full_text_conversion_attempts INTEGER` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0049` | `DBO-0001` | `full_text_conversion_model_id VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0050` | `DBO-0001` | `full_text_conversion_metadata JSON` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0051` | `DBO-0001` | `full_text_char_count BIGINT` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0052` | `DBO-0001` | `content_hash VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0053` | `DBO-0001` | `import_route VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0054` | `DBO-0001` | `original_data JSON` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0055` | `DBO-0001` | `publication_status VARCHAR` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0056` | `DBO-0001` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0057` | `DBO-0001` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0058` | `DBO-0001` | `source_metadata JSON` | Canonical/import/full-text/transfer writers and DB defaults | Review projectors, app/detail/job/PDF/export/transfer readers | Identity/date/source/projector inputs where applicable; exact per-route role pending | Display/detail/full-text/export/transfer where applicable | Create/canonical update/full-text update observed; full cleanup/retention incomplete | `unresolved` | — | `EVD-0019`, `EVD-0022`, `EVD-0023`, `EVD-0025`-`EVD-0028` | `traced-to-writer` | Complete per-field API and lifecycle/recovery/retention lineage, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0059` | `DBO-0005` | `id VARCHAR PRIMARY KEY` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0060` | `DBO-0005` | `article_id VARCHAR NOT NULL REFERENCES app.article(id)` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0061` | `DBO-0005` | `import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id)` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0062` | `DBO-0005` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0063` | `DBO-0005` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0064` | `DBO-0005` | `external_article_id VARCHAR` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0065` | `DBO-0005` | `source_kind VARCHAR` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0066` | `DBO-0005` | `import_metadata JSON` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0067` | `DBO-0005` | `match_metadata JSON` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0068` | `DBO-0005` | `import_run_id VARCHAR` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0069` | `DBO-0005` | `source_record_key VARCHAR` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0070` | `DBO-0005` | `source_record_hash VARCHAR` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0071` | `DBO-0005` | `raw_payload JSON` | Import-store/transfer upsert and DB defaults | Scope/selected-import/projector/detail/job/export/compatibility readers | Join/rank/filter/source identity where applicable; exact per-route role pending | Selected import/display/detail/export/transfer where applicable | Upsert/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete per-field lifecycle/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0072` | `DBO-0006` | `id VARCHAR PRIMARY KEY` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0073` | `DBO-0006` | `article_id VARCHAR NOT NULL REFERENCES app.article(id)` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0074` | `DBO-0006` | `import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id)` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0075` | `DBO-0006` | `external_article_id VARCHAR` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0076` | `DBO-0006` | `source_kind VARCHAR` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0077` | `DBO-0006` | `import_metadata JSON` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0078` | `DBO-0006` | `match_metadata JSON` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0079` | `DBO-0006` | `import_run_id VARCHAR` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0080` | `DBO-0006` | `source_record_key VARCHAR NOT NULL` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0081` | `DBO-0006` | `source_record_hash VARCHAR NOT NULL` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0082` | `DBO-0006` | `raw_payload JSON` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0083` | `DBO-0006` | `quarantined_at TIMESTAMPTZ` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0084` | `DBO-0006` | `quarantine_reason VARCHAR` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0085` | `DBO-0006` | `quarantine_metadata JSON` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0086` | `DBO-0006` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0087` | `DBO-0006` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Import-store upsert/remap quarantine and DB defaults | Canonical/compatibility/selected-import/projector/detail/export readers | Import identity/quarantine/join/rank inputs where applicable; exact per-route role pending | Selected source/detail/export evidence where applicable | Upsert/quarantine/clear/sync-delete observed; retention/recovery incomplete | `unresolved` | — | `EVD-0020`, `EVD-0023`, `EVD-0025`, `EVD-0026` | `traced-to-writer` | Complete history/quarantine retention and replay policy, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0011` |
| `CMF-0088` | `DBO-0007` | `id VARCHAR PRIMARY KEY` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0089` | `DBO-0007` | `name VARCHAR NOT NULL` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0090` | `DBO-0007` | `description VARCHAR` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0091` | `DBO-0007` | `model_id VARCHAR NOT NULL` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0092` | `DBO-0007` | `use_title BOOLEAN NOT NULL DEFAULT TRUE` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0093` | `DBO-0007` | `use_abstract BOOLEAN NOT NULL DEFAULT TRUE` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0094` | `DBO-0007` | `use_fulltext BOOLEAN NOT NULL DEFAULT FALSE` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0095` | `DBO-0007` | `use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0096` | `DBO-0007` | `date_from TIMESTAMPTZ` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0097` | `DBO-0007` | `date_to TIMESTAMPTZ` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0098` | `DBO-0007` | `archived BOOLEAN NOT NULL DEFAULT FALSE` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0099` | `DBO-0007` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0100` | `DBO-0007` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0101` | `DBO-0007` | `human_judgment_mode human_judgment_mode DEFAULT 'prompt'` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0102` | `DBO-0007` | `delete_pending_at TIMESTAMPTZ` | Project/subproject/transfer routes and DB defaults | Project/review/job/projector/cleanup/export/transfer readers | Identity/config/date/archive/delete predicates where applicable; full field lineage pending | Project/review configuration and diagnostics where selected | Create/edit/clone/archive/delete-pending/final-delete observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0022`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete per-field invalidation/replay/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0103` | `DBO-0008` | `id VARCHAR PRIMARY KEY` | Project/add/subproject/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Membership/join/scope predicates | Membership/provenance where selected | Add/remove/detach/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0020`, `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0104` | `DBO-0008` | `project_id VARCHAR NOT NULL` | Project/add/subproject/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Membership/join/scope predicates | Membership/provenance where selected | Add/remove/detach/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0020`, `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0105` | `DBO-0008` | `article_id VARCHAR NOT NULL REFERENCES app.article(id)` | Project/add/subproject/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Membership/join/scope predicates | Membership/provenance where selected | Add/remove/detach/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0020`, `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0106` | `DBO-0008` | `imported_from_project_id VARCHAR` | Project/add/subproject/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Membership/join/scope predicates | Membership/provenance where selected | Add/remove/detach/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0020`, `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0107` | `DBO-0008` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Project/add/subproject/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Membership/join/scope predicates | Membership/provenance where selected | Add/remove/detach/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0020`, `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0108` | `DBO-0008` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Project/add/subproject/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Membership/join/scope predicates | Membership/provenance where selected | Add/remove/detach/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0020`, `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0109` | `DBO-0009` | `id VARCHAR PRIMARY KEY` | Project/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Route membership/join/scope predicates | Route membership where selected | Add/edit-delete/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0110` | `DBO-0009` | `project_id VARCHAR NOT NULL` | Project/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Route membership/join/scope predicates | Route membership where selected | Add/edit-delete/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0111` | `DBO-0009` | `import_route_id VARCHAR NOT NULL REFERENCES app.import_route(id)` | Project/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Route membership/join/scope predicates | Route membership where selected | Add/edit-delete/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0112` | `DBO-0009` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Project/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Route membership/join/scope predicates | Route membership where selected | Add/edit-delete/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0113` | `DBO-0009` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Project/clone/transfer writers and DB defaults | Scope/projector/job/detail/export/cleanup readers | Route membership/join/scope predicates | Route membership where selected | Add/edit-delete/cleanup observed; replay/retention incomplete | `unresolved` | — | `EVD-0021`, `EVD-0025`, `EVD-0028` | `traced-to-writer` | Complete replay/recovery/retention, deployed schema, physical evidence, and index plans are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0114` | `DBO-0001` | full_text_assets `$.<arbitrary recursive object/array path>` | Import/transfer writers | Transfer asset walker and payload consumers | Not established | Full-text/transfer payload | Preserved recursively; closed retention unknown | `unresolved` | — | `EVD-0027` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0115` | `DBO-0001` | full_text_conversion_metadata `$.baseURL` | Full-text conversion worker | Detail/job/export/transfer payload readers | No source-table pre-limit role established | Conversion diagnostics/payload | Rewritten per conversion attempt | `unresolved` | — | `EVD-0027` | `traced-to-writer` | Transfer-preserved variants, complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0116` | `DBO-0001` | full_text_conversion_metadata `$.modelId` | Full-text conversion worker | Detail/job/export/transfer payload readers | No source-table pre-limit role established | Conversion diagnostics/payload | Rewritten per conversion attempt | `unresolved` | — | `EVD-0027` | `traced-to-writer` | Transfer-preserved variants, complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0117` | `DBO-0001` | full_text_conversion_metadata `$.modelName` | Full-text conversion worker | Detail/job/export/transfer payload readers | No source-table pre-limit role established | Conversion diagnostics/payload | Rewritten per conversion attempt | `unresolved` | — | `EVD-0027` | `traced-to-writer` | Transfer-preserved variants, complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0118` | `DBO-0001` | full_text_conversion_metadata `$.providerKind` | Full-text conversion worker | Detail/job/export/transfer payload readers | No source-table pre-limit role established | Conversion diagnostics/payload | Rewritten per conversion attempt | `unresolved` | — | `EVD-0027` | `traced-to-writer` | Transfer-preserved variants, complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0119` | `DBO-0001` | original_data source aliases `$.{doi,source,src,server}` and `$.bookOrReportDetails.publisher` | Import/transfer writers | DOI and source/preprint normalization | Projector/import normalization input | Metadata fallback | Preserved source payload; retention unknown | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete source variants, lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0120` | `DBO-0001` | original_data `$.fullTextUrlList.fullTextUrl[*].{url,site,availability,availabilityCode,documentStyle}` | Import/transfer writers | Full-text link normalization | Projector/import normalization input | Full-text/PDF URL fallback | Preserved source payload; retention unknown | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete source variants, lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0121` | `DBO-0001` | original_data `$.pubTypeList.pubType[*]` and `$.versionList.version[*].pubTypeList.pubType[*]` | Import/transfer writers | Preprint detection | Projector/import normalization input | Metadata fallback | Preserved source payload; retention unknown | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete source variants, lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0122` | `DBO-0001` | original_data journal aliases `$.journalInfo.journal.title`, `$.journalInfo.title`, `$.journal.title`, `$['container-title'][*]`, `$.containerTitle[*]`, `$.host_venue.display_name`, `$.primary_location.source.{display_name,host_organization_name}`, `$.journalTitle` | Import/transfer writers | Journal-title normalization/display | Projector/import normalization input | Display/export fallback | Preserved source payload; retention unknown | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete source variants, lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0123` | `DBO-0001` | original_data URL aliases `$.{sourceUrl,articleUrl,landingUrl,url}`, `$.citation.url`, `$.covidence.citation.url` | Import/transfer writers | Scoped URL resolution | Projector/import input where selected | Display/detail URL fallback | Preserved source payload; retention unknown | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete source variants, lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0124` | `DBO-0001` | original_data named Covidence envelope and sourceRows/stageMembership keys from US-003 JSON census | Covidence/transfer writers | Covidence detail, URL, and metadata consumers | Import/projector input where selected | Detail/export payload | Preserved source payload; retention unknown | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Nested citation/answer-map variants, lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0125` | `DBO-0001` | original_data `$.<source-defined raw key/path>` | Import/structured-file/EHR/provider/transfer writers | Unknown and source-specific consumers | Unknown | Unknown/source payload | Open payload domain; retention unknown | `unresolved` | — | `EVD-0026` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0126` | `DBO-0001` | source_metadata `$.{journalTitle,preprintSource,preprintHostLabel,isPreprint}` | Metadata/canonical resolver and transfer writers | Display/full-text/export/serving consumers | Source-rank/projector input | Display/export metadata | Merged/recomputed on canonical updates | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0127` | `DBO-0001` | source_metadata `$.fullTextLinks[*].{url,site,availability,availabilityCode,documentStyle}` | Metadata/canonical resolver and transfer writers | Full-text/PDF URL consumers | Source-rank/projector input | Full-text/PDF display/fetch | Merged/recomputed on canonical updates | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0128` | `DBO-0001` | source_metadata named `$.covidence` and stageMembership keys from US-003 JSON census | Covidence/metadata/transfer writers | Badge/detail/display consumers | Import/projector input where selected | Badges/detail/export | Merged/recomputed on canonical updates | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0129` | `DBO-0001` | source_metadata `$.structuredFile.{assetPath,boundaryDisplayPath,boundaryPointer,format,sourceFileName}` | Structured-file/transfer writers | Source-rank and transfer consumers | Source-rank/import input | Transfer metadata | Merged/recomputed on canonical updates | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0130` | `DBO-0001` | source_metadata named `$.canonicalResolver` rank/manual/warning/candidate paths from US-003 JSON census | Canonical resolver/transfer writers | Canonical resolver | Canonical update decision input | Conflict/manual diagnostics | Read/rewritten on canonical updates | `unresolved` | — | `EVD-0026` | `traced-to-writer` | Complete lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0131` | `DBO-0001` | source_metadata `$.<producer-defined passthrough key/path>` | Import/canonical merge/transfer writers | Unknown and source-specific consumers | Unknown | Unknown/source metadata | Open merged domain; retention unknown | `unresolved` | — | `EVD-0026` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0132` | `DBO-0005` | import_metadata hot aliases and Covidence flags from US-003 JSON census | Import/transfer writers | Hot-field/detail consumers | Rank/filter/projector input | Detail/export metadata | Upsert/current-link lifecycle | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete lifecycle/retention, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0133` | `DBO-0005` | import_metadata URL aliases from US-003 JSON census | Import/transfer writers | Scoped URL consumers | Selected-import/projector input | Display/detail URL | Upsert/current-link lifecycle | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete lifecycle/retention, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0134` | `DBO-0005` | import_metadata named Covidence envelope/files/stageMembership keys from US-003 JSON census | Covidence/transfer writers | Hot-field/detail/export consumers | Rank/filter/projector input | Detail/export metadata | Upsert/current-link lifecycle | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete lifecycle/retention, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0135` | `DBO-0005` | import_metadata named source_metadata domain from CMF-0126 through CMF-0130 | Import default-copy/transfer writers | Source-rank/detail/export consumers | Rank/projector input | Display/detail/export | Upsert/current-link lifecycle | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete lifecycle/retention, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0136` | `DBO-0005` | import_metadata `$.<producer-defined key/path>` | Import/transfer writers | Unknown/source-specific consumers | Unknown | Unknown/source metadata | Open current-link domain | `unresolved` | — | `EVD-0023, EVD-0026` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0137` | `DBO-0005` | match_metadata `$.duplicateKey` | Import/transfer writers | Hot-field duplicate ranking | Rank/filter input | Diagnostics/export | Upsert/current-link lifecycle | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete lifecycle/retention, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0138` | `DBO-0005` | match_metadata `$.<producer-defined key/path>` | Import/transfer writers | Unknown/source-specific consumers | Unknown | Unknown/source metadata | Open current-link domain | `unresolved` | — | `EVD-0023, EVD-0026` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0139` | `DBO-0005` | raw_payload URL aliases from US-003 JSON census | Import/transfer writers | Selected-import/display/detail URL consumers | Projector input | Display/detail URL | Upsert/current-link lifecycle | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete lifecycle/retention, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0140` | `DBO-0005` | raw_payload named Covidence envelope from CMF-0124 | Covidence/transfer writers | Selected-import/detail/export consumers | Projector input | Detail/export payload | Upsert/current-link lifecycle | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete lifecycle/retention, deployed schema, and physical evidence are missing. | `OQ-0010, OQ-0011` |
| `CMF-0141` | `DBO-0005` | raw_payload `$.<source-defined raw key/path>` | Import/transfer writers | Unknown/source-specific consumers | Unknown | Unknown/source payload | Open current-link domain | `unresolved` | — | `EVD-0023, EVD-0026` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0142` | `DBO-0006` | import_metadata hot aliases and Covidence flags from US-003 JSON census | Import/transfer writers | Hot-field/detail consumers | Rank/filter/projector input | Detail/export metadata | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete history/quarantine retention, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0143` | `DBO-0006` | import_metadata URL aliases from US-003 JSON census | Import/transfer writers | Scoped URL consumers | Selected-import/projector input | Display/detail URL | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete history/quarantine retention, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0144` | `DBO-0006` | import_metadata named Covidence envelope/files/stageMembership keys from US-003 JSON census | Covidence/transfer writers | Hot-field/detail/export consumers | Rank/filter/projector input | Detail/export metadata | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete history/quarantine retention, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0145` | `DBO-0006` | import_metadata named source_metadata domain from CMF-0126 through CMF-0130 | Import default-copy/transfer writers | Source-rank/detail/export consumers | Rank/projector input | Display/detail/export | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete history/quarantine retention, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0146` | `DBO-0006` | import_metadata `$.<producer-defined key/path>` | Import/transfer writers | Unknown/source-specific consumers | Unknown | Unknown/source metadata | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0147` | `DBO-0006` | match_metadata `$.duplicateKey` | Import/transfer writers | Hot-field duplicate ranking | Rank/filter input | Diagnostics/export | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete history/quarantine retention, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0148` | `DBO-0006` | match_metadata `$.<producer-defined key/path>` | Import/transfer writers | Unknown/source-specific consumers | Unknown | Unknown/source metadata | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0149` | `DBO-0006` | raw_payload URL aliases from US-003 JSON census | Import/transfer writers | Selected-import/display/detail URL consumers | Projector input | Display/detail URL | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete history/quarantine retention, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0150` | `DBO-0006` | raw_payload named Covidence envelope from CMF-0124 | Covidence/transfer writers | Selected-import/detail/export consumers | Projector input | Detail/export payload | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `traced-to-writer` | Complete history/quarantine retention, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0151` | `DBO-0006` | raw_payload `$.<source-defined raw key/path>` | Import/transfer writers | Unknown/source-specific consumers | Unknown | Unknown/source payload | Upsert/quarantine/clear/history lifecycle; retention unknown | `unresolved` | — | `EVD-0023, EVD-0026` | `blocked` | No closed key schema or approved immutable key profile exists; `BLK-0008`. | `OQ-0011` |
| `CMF-0152` | `DBO-0006` | quarantine_metadata `$.incomingArticleId` | Import remap-quarantine writer | Import reconciliation/operator evidence | Remap/quarantine decision | Quarantine diagnostics | Written on remap and cleared on accepted upsert | `unresolved` | — | `EVD-0023` | `traced-to-writer` | Retention/recovery policy, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0153` | `DBO-0006` | quarantine_metadata `$.incomingExternalArticleId` | Import remap-quarantine writer | Import reconciliation/operator evidence | Remap/quarantine decision | Quarantine diagnostics | Written on remap and cleared on accepted upsert | `unresolved` | — | `EVD-0023` | `traced-to-writer` | Retention/recovery policy, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0154` | `DBO-0006` | quarantine_metadata `$.incomingImportRunId` | Import remap-quarantine writer | Import reconciliation/operator evidence | Remap/quarantine decision | Quarantine diagnostics | Written on remap and cleared on accepted upsert | `unresolved` | — | `EVD-0023` | `traced-to-writer` | Retention/recovery policy, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0155` | `DBO-0006` | quarantine_metadata `$.incomingSourceRecordHash` | Import remap-quarantine writer | Import reconciliation/operator evidence | Remap/quarantine decision | Quarantine diagnostics | Written on remap and cleared on accepted upsert | `unresolved` | — | `EVD-0023` | `traced-to-writer` | Retention/recovery policy, deployed schema, and physical evidence are missing. | `OQ-0004, OQ-0010, OQ-0011` |
| `CMF-0156` | `DBO-0021` | `id VARCHAR PRIMARY KEY` | Immutable prompt/project/import/transfer writers | Project-prompt, judgment, projector, route, export/transfer readers | Prompt/judgment join identity | Prompt payload/display/export identity | UUID create, merge/reference-remap, archive/delete observed; full recovery/retention incomplete | `unresolved` | — | `EVD-0031`, `EVD-0033`, `EVD-0034`, `EVD-0040` | `traced-to-writer` | Complete lifecycle, deployed schema, physical evidence, and cross-identity policy are missing. | `OQ-0004`, `OQ-0010`, `OQ-0015` |
| `CMF-0157` | `DBO-0021` | `original_text VARCHAR NOT NULL` | Immutable prompt/project/import/transfer writers | Judgment prompt, config hash fallback, snapshot, display/export readers | Prompt text/hash/judgment input | Payload/display/export | Immutable replacement/reuse plus transfer; legacy-null-hash behavior unresolved | `unresolved` | — | `EVD-0033`, `EVD-0034`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Legacy hash compatibility, complete lifecycle, deployed schema, and physical evidence are missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0158` | `DBO-0021` | `transformed_text VARCHAR` | Immutable prompt/project/import/transfer writers | Snapshot, route, export/transfer readers | Immutable content identity | Payload/export metadata | Immutable replacement/reuse plus transfer | `unresolved` | — | `EVD-0033`, `EVD-0034`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Review-hash fallback excludes this field for null content hashes; lifecycle/deployed/physical proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0159` | `DBO-0021` | `prompt_heading VARCHAR` | Immutable prompt/project/import/transfer writers | Judgment/snapshot/display/export readers | Immutable content identity and prompt context | Payload/display/export label | Immutable replacement/reuse plus transfer | `unresolved` | — | `EVD-0033`, `EVD-0034`, `EVD-0038`, `EVD-0039`, `EVD-0040` | `traced-to-writer` | Legacy hash/invalidation parity, lifecycle, deployed schema, and physical evidence are missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0160` | `DBO-0021` | `type VARCHAR` | Immutable prompt/project/import/transfer writers | Judgment/snapshot/display/export readers | Immutable content identity and prompt behavior | Payload/display/export classification | Immutable replacement/reuse plus transfer | `unresolved` | — | `EVD-0033`, `EVD-0034`, `EVD-0038`-`EVD-0040` | `traced-to-writer` | No DB enum/check and legacy hash compatibility/lifecycle/physical proof are missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0161` | `DBO-0021` | `content_hash VARCHAR UNIQUE` | Immutable prompt service and hash-repair/transfer paths | Prompt reuse and review-config/projector readers | Prompt content/reuse identity | Review-config hash and transfer identity | Insert/recompute/merge/reference-remap observed; nullable legacy rows remain | `unresolved` | — | `EVD-0031`, `EVD-0033`, `EVD-0034`, `EVD-0037`, `EVD-0040` | `traced-to-writer` | Legacy null/hash-algorithm compatibility, deployed uniqueness, and physical evidence are missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0162` | `DBO-0021` | `archived BOOLEAN NOT NULL DEFAULT FALSE` | Prompt/project/cleanup/transfer writers and DB default | Review-config, jobs, projectors, route/export readers | Active-prompt applicability | Active config/payload visibility | Create, archive/unarchive, merge/delete, transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0033`, `EVD-0034`, `EVD-0036`, `EVD-0037`, `EVD-0040` | `traced-to-writer` | Caller applicability parity and full recovery/retention/deployed evidence are missing; `BLK-0011`. | `OQ-0004`, `OQ-0010`, `OQ-0016` |
| `CMF-0163` | `DBO-0021` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | DB default | Routes/export/transfer/audit consumers | Audit/order metadata where selected | Export/audit metadata | Create/transfer observed; retention incomplete | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0040` | `traced-to-writer` | Complete consumers, retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0164` | `DBO-0021` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Prompt writers and DB default | Snapshot, projector watermark, export/transfer readers | Change/watermark input | Audit/export metadata | Unarchive/repair/merge/transfer updates observed | `unresolved` | — | `EVD-0031`, `EVD-0033`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Complete watermark semantics, retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0015` |
| `CMF-0165` | `DBO-0022` | `id VARCHAR PRIMARY KEY` | Project/Covidence/subproject/transfer writers | Routes, cleanup, export/transfer readers | Link row identity | Association payload/export identity | UUID upsert/remove/clone/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0040` | `traced-to-writer` | Complete link recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0166` | `DBO-0022` | `project_id VARCHAR NOT NULL` with no project FK | Project/Covidence/subproject/transfer writers | Prompt/config/judgment/projector/export readers | Project membership and unique-pair identity | Review-config/project payload scope | Upsert/remove/project cleanup/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0036`-`EVD-0040` | `traced-to-writer` | Orphan/recovery policy, deployed schema, and physical/index evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0016` |
| `CMF-0167` | `DBO-0022` | `prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id)` | Project/Covidence/subproject/transfer writers | Prompt/config/judgment/projector/export readers | Prompt membership and unique-pair identity | Review-config/project payload identity | Upsert/remove/remap/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0036`-`EVD-0040` | `traced-to-writer` | Complete reference-remap/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0015` |
| `CMF-0168` | `DBO-0022` | `prompt_order INTEGER` | Project/Covidence/subproject/transfer writers | Review-config, judgment, display/export readers | Active prompt ordering/hash attribute | Prompt display/export order | Upsert/reorder/clone/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0037`-`EVD-0040` | `traced-to-writer` | Null/duplicate-order authority and complete invalidation/lifecycle proof are missing. | `OQ-0010`, `OQ-0015` |
| `CMF-0169` | `DBO-0022` | `enabled BOOLEAN NOT NULL DEFAULT TRUE` | Project/Covidence/subproject/transfer writers and DB default | Review-config, jobs, projectors, payload/export readers | Active-prompt applicability | Review/payload visibility | Enable/disable/upsert/clone/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0036`, `EVD-0037`, `EVD-0039`, `EVD-0040` | `traced-to-writer` | Caller applicability parity, full lifecycle, deployed schema, and physical evidence are missing; `BLK-0011`. | `OQ-0010`, `OQ-0016` |
| `CMF-0170` | `DBO-0022` | `archived BOOLEAN NOT NULL DEFAULT FALSE` | Project/prompt/cleanup/transfer writers and DB default | Review-config/projector/job/payload/export readers | Active-prompt applicability | Review/payload visibility | Archive/remove/clone/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0036`, `EVD-0037`, `EVD-0039`, `EVD-0040` | `traced-to-writer` | Caller applicability parity and complete recovery/retention/deployed proof are missing; `BLK-0011`. | `OQ-0004`, `OQ-0010`, `OQ-0016` |
| `CMF-0171` | `DBO-0022` | `origin_project_id VARCHAR` with no FK | Clone/subproject/transfer writers | Project route/export/transfer readers | Prompt provenance | Payload/export provenance | Clone/subproject/transfer preservation observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0040` | `traced-to-writer` | Provenance semantics, orphan/recovery/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0012` |
| `CMF-0172` | `DBO-0022` | `criteria_disposition project_prompt_criteria_disposition_v2` nullable, enum `include`/`exclude`/`combined` | Project/Covidence/transfer writers | Summary, payload, comparison, export/transfer readers | Judgment interpretation/grouping | Summary/payload/comparison behavior | Upsert/clone/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0039`, `EVD-0040` | `traced-to-writer` | Field is absent from review hash and invalidation union; authoritative identity/lifecycle proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0173` | `DBO-0022` | `criteria_section_key VARCHAR` | Project/Covidence/transfer writers | Summary, comparison, export/transfer readers | Criteria grouping key | Summary/comparison/export grouping | Upsert/clone/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0039`, `EVD-0040` | `traced-to-writer` | Field is absent from review hash and invalidation union; authoritative identity/lifecycle proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0174` | `DBO-0022` | `criteria_section_label VARCHAR` | Project/Covidence/transfer writers | Display, comparison, export/transfer readers | Criteria display metadata | Display/comparison/export label | Upsert/clone/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0039`, `EVD-0040` | `traced-to-writer` | Field is absent from review hash and invalidation union; authoritative identity/lifecycle proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0175` | `DBO-0022` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | DB default | Routes/export/transfer/audit consumers | Association audit/order metadata | Export/audit metadata | Link create/transfer observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0040` | `traced-to-writer` | Complete consumers, retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0176` | `DBO-0022` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Link writers and DB default | Projectors, rebuild stats, export/transfer readers | Change/watermark input | Audit/export metadata | Upsert/reorder/state/criteria/transfer updates observed | `unresolved` | — | `EVD-0031`, `EVD-0034`, `EVD-0037`, `EVD-0040` | `traced-to-writer` | Watermark/invalidation parity, retention, deployed schema, and physical evidence are missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0177` | `DBO-0023` | `id VARCHAR PRIMARY KEY` | Model repository/discovery/transfer writers | Project, judgment, projector, snapshot, route/export readers | Model/judgment identity | Review/payload/export identity | UUID create/upsert/remap/archive/delete/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Execution-vs-judgment identity, complete lifecycle, deployed schema, and physical evidence are missing; `BLK-0011`. | `OQ-0004`, `OQ-0010`, `OQ-0015` |
| `CMF-0178` | `DBO-0023` | `provider_connection_id VARCHAR NOT NULL` with no FK | Model repository/discovery/transfer writers | Provider joins, review hash, snapshot/export readers | Model natural and execution identity | Review/payload/export provider binding | Create/upsert/remap/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Orphan/rebind semantics, judgment-key parity, deployed schema, and physical evidence missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0179` | `DBO-0023` | `name VARCHAR NOT NULL` | Model repository/discovery/transfer writers | Admin/display/snapshot/export readers | Model display/transfer fingerprint | Payload/display/export | Create/update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Hash/key inclusion policy, lifecycle, deployed schema, and physical evidence are missing. | `OQ-0010`, `OQ-0015` |
| `CMF-0180` | `DBO-0023` | `remote_model_id VARCHAR` | Model repository/discovery/transfer writers | Execution, review hash, snapshot/export readers | Model natural/execution identity | Review/payload/export remote identity | Create/update/upsert/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Nullable natural-key semantics and complete lifecycle/deployed/physical proof are missing. | `OQ-0010`, `OQ-0015` |
| `CMF-0181` | `DBO-0023` | `display_name VARCHAR` | Model repository/discovery/transfer writers | Admin/display/snapshot/export readers | Display and transfer fingerprint | Payload/display/export | Create/update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Review/judgment identity inclusion policy, lifecycle, deployed schema, and physical evidence missing. | `OQ-0010`, `OQ-0015` |
| `CMF-0182` | `DBO-0023` | `variant VARCHAR` | Model repository/discovery/transfer writers | Natural lookup, execution, review hash, snapshot/export readers | Model natural/execution identity | Review/payload/export variant | Create/update/upsert/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Variant/options normalization and judgment-key parity, lifecycle, deployed/physical proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0183` | `DBO-0023` | `source VARCHAR` | Model repository/discovery/transfer writers | Admin/snapshot/export readers | Discovery provenance | Payload/export provenance | Create/update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | No DB enum/check; identity inclusion, lifecycle, deployed schema, and physical evidence missing. | `OQ-0010`, `OQ-0015` |
| `CMF-0184` | `DBO-0023` | `enabled BOOLEAN NOT NULL DEFAULT TRUE` | Model repository/discovery/transfer writers and DB default | Admin/selection/execution/export readers | Model availability | Execution/admin/export availability | Enable/archive/delete/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0040` | `traced-to-writer` | Review-hash/judgment reuse behavior on disable, lifecycle, deployed/physical proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0185` | `DBO-0023` | `metadata_json JSON` | Model discovery/repository/transfer writers | Execution option/context/runtime, review hash, snapshot/export readers | Benchmark execution settings and model identity inputs | Payload/export/transfer metadata | Replace/merge/transfer observed; arbitrary keys preserved | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Two identity views and an open key domain need owner closure; deployed/physical proof missing; `BLK-0010`, `BLK-0011`. | `OQ-0010`, `OQ-0014`, `OQ-0015` |
| `CMF-0186` | `DBO-0023` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | DB default | Admin/export/transfer/audit consumers | Audit metadata | Export/audit metadata | Create/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0040` | `traced-to-writer` | Complete consumers, retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0187` | `DBO-0023` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Model repository/transfer writers and DB default | Rebuild watermark, snapshot/export readers | Model execution change watermark | Audit/export metadata | Update/remap/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Watermark/invalidation coverage, retention, deployed schema, and physical evidence missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0188` | `DBO-0024` | `id VARCHAR PRIMARY KEY` | Provider repository/transfer writers | Model joins, review hash, snapshot/export readers | Provider connection identity | Review/payload/export provider identity | UUID create/reuse/archive/delete/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Complete model-reference cleanup/recovery/retention, deployed/physical proof missing. | `OQ-0004`, `OQ-0010`, `OQ-0015` |
| `CMF-0189` | `DBO-0024` | `provider_kind VARCHAR NOT NULL` | Provider repository/transfer writers | Registry/execution, review hash, snapshot/export readers | Provider transport/execution identity | Review/payload/export provider type | Create/update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | No DB enum/check; normalization/identity/lifecycle/deployed proof incomplete. | `OQ-0010`, `OQ-0015` |
| `CMF-0190` | `DBO-0024` | `label VARCHAR NOT NULL` | Provider repository/transfer writers | Admin/snapshot/export readers | Display identity only | Payload/display/export label | Create/update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | No uniqueness; identity inclusion/lifecycle/deployed/physical proof incomplete. | `OQ-0010`, `OQ-0015` |
| `CMF-0191` | `DBO-0024` | `enabled BOOLEAN NOT NULL DEFAULT TRUE` | Provider repository/transfer writers and DB default | Model availability, execution snapshot/admin/export readers | Provider/model availability | Execution/payload/admin/export availability | Enable/archive/delete/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Excluded from review hash/judgment key; invalidation/reuse/lifecycle/deployed proof incomplete; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0192` | `DBO-0024` | `auth_mode VARCHAR` | Provider repository/transfer writers | Credential/execution, snapshot/fingerprint/export readers | Provider authentication/transfer identity | Execution snapshot/export metadata | Create/update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | No DB enum; excluded from review hash, secret recovery/lifecycle/deployed proof incomplete; `BLK-0011`. | `OQ-0004`, `OQ-0010`, `OQ-0015` |
| `CMF-0193` | `DBO-0024` | `base_url VARCHAR` | Provider repository/transfer writers | Execution, review hash, snapshot/fingerprint/export readers | Provider endpoint/execution identity | Review/payload/export endpoint identity | Create/update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | No DB URL check; endpoint normalization/lifecycle/deployed/physical proof incomplete. | `OQ-0010`, `OQ-0015` |
| `CMF-0194` | `DBO-0024` | `config_json JSON` | Provider repository/transfer/migration writers | Availability, worker/runtime, snapshot/fingerprint/export readers | Benchmark/runtime routing configuration | Execution snapshot/export/transfer metadata | Normalize/replace/transfer observed; arbitrary keys preserved | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Open keys and exclusion from review/judgment identity require owner closure; deployed/physical proof missing; `BLK-0010`, `BLK-0011`. | `OQ-0010`, `OQ-0014`, `OQ-0015` |
| `CMF-0195` | `DBO-0024` | `secret_ref VARCHAR` | Provider repository/transfer writers | Credential resolution, execution snapshot/admin readers | Provider credential reference | Execution snapshot/admin secret status | Create/update/transfer/delete observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | No DB reference constraint; secret backup/recovery/identity/lifecycle/deployed proof incomplete. | `OQ-0004`, `OQ-0010`, `OQ-0015` |
| `CMF-0196` | `DBO-0024` | `last_checked_at TIMESTAMPTZ` | Provider health/repository writers | Admin/health consumers | Health freshness | Admin diagnostics | Health check/update observed | `unresolved` | — | `EVD-0032`, `EVD-0035` | `traced-to-writer` | Complete health lifecycle/retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0197` | `DBO-0024` | `last_error VARCHAR` | Provider health/repository writers | Admin/health consumers | Health diagnostics | Admin diagnostics | Health check/update/clear observed | `unresolved` | — | `EVD-0032`, `EVD-0035` | `traced-to-writer` | Error retention/redaction/recovery, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0198` | `DBO-0024` | `created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | DB default | Admin/export/transfer/audit consumers | Audit metadata | Export/audit metadata | Create/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0040` | `traced-to-writer` | Complete consumers, retention, deployed schema, and physical evidence are missing. | `OQ-0004`, `OQ-0010` |
| `CMF-0199` | `DBO-0024` | `updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp` | Provider repository/transfer writers and DB default | Rebuild watermark, snapshot/export readers | Provider execution change watermark | Audit/export metadata | Update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Watermark/invalidation coverage, retention, deployed schema, and physical evidence missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0200` | `DBO-0024` | `max_inflight_requests INTEGER` | Provider repository/transfer writers | Execution admission, snapshot/export readers | Provider concurrency limit | Execution snapshot/export setting | Add/update/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | No positive DB check and excluded from review/judgment identity; authoritative behavior/deployed proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0201` | `DBO-0023` | `metadata_json` normalized `$.discovery` key family from US-004 JSON census | Provider discovery/repository/transfer writers | Capability/context/runtime/display/fingerprint readers | Model capability/execution planning | Snapshot/export/transfer metadata | Discovery replace/merge/transfer observed | `unresolved` | — | `EVD-0035`, `EVD-0040` | `traced-to-writer` | Complete versioning/lifecycle, deployed key profile, and physical evidence are missing. | `OQ-0010`, `OQ-0014`, `OQ-0015` |
| `CMF-0202` | `DBO-0023` | `metadata_json $.options.{thinking,thinkingMode}` and `thinking_mode` read alias | Model repository/UI/transfer writers | Review hash, execution, snapshot/fingerprint readers | Benchmark-critical model execution identity | Snapshot/export execution setting | Set/remove/transfer observed | `unresolved` | — | `EVD-0035`, `EVD-0037`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Alias/version normalization and judgment-key reuse policy, deployed/physical proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0015` |
| `CMF-0203` | `DBO-0023` | `metadata_json` recursive context/output/model-name/reasoning aliases from US-004 JSON census | Provider/runtime/legacy/transfer writers | Context/token/runtime-name/reasoning readers | Model execution planning | Snapshot/fingerprint/export metadata | Legacy/provider values read recursively and transfer-preserved | `unresolved` | — | `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Alias precedence/versioning and review-identity inclusion policy, deployed/physical proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0014`, `OQ-0015` |
| `CMF-0204` | `DBO-0023` | `metadata_json $.projectTransferImportedSnapshot` model/provider fingerprint family | Transfer commit writer | Transfer dedupe/version/fingerprint readers | Import identity/reuse | Transfer diagnostics/export identity | Written on import and compared canonically | `unresolved` | — | `EVD-0035`, `EVD-0040` | `traced-to-writer` | Marker versioning/retention and deployed key/physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0014` |
| `CMF-0205` | `DBO-0023` | `metadata_json $.<provider-, runtime-, legacy-, or transfer-preserved key/path>` | Provider/runtime/transfer writers | Unknown/future consumers | Unknown execution/config use | Unknown payload/export use | Open transfer-preserved domain | `unresolved` | — | `EVD-0035`, `EVD-0040` | `blocked` | No closed versioned model-metadata schema or approved immutable non-live key profile exists; `BLK-0010`. | `OQ-0014` |
| `CMF-0206` | `DBO-0024` | `config_json` named archived/disabled-model/runtime/worker keys and legacy `workerUrls` from US-004 JSON census | Provider repository/migration/transfer writers | Availability, runtime routing, snapshot/fingerprint readers | Provider/model execution configuration | Snapshot/export/transfer configuration | Normalize/replace/transfer observed | `unresolved` | — | `EVD-0032`, `EVD-0035`, `EVD-0038`, `EVD-0040` | `traced-to-writer` | Version/alias and review-identity inclusion policy, deployed/physical proof missing; `BLK-0011`. | `OQ-0010`, `OQ-0014`, `OQ-0015` |
| `CMF-0207` | `DBO-0024` | `config_json $.projectTransferImportedSnapshot` provider fingerprint family | Transfer commit writer | Transfer dedupe/fingerprint readers | Import identity/reuse | Transfer diagnostics/export identity | Written on import and compared canonically | `unresolved` | — | `EVD-0035`, `EVD-0040` | `traced-to-writer` | Marker versioning/retention and deployed key/physical evidence are missing. | `OQ-0004`, `OQ-0010`, `OQ-0014` |
| `CMF-0208` | `DBO-0024` | `config_json $.<provider- or transfer-preserved key/path>` | Provider/transfer writers | Unknown/future consumers | Unknown execution/config use | Unknown payload/export use | Open transfer-preserved domain | `unresolved` | — | `EVD-0035`, `EVD-0040` | `blocked` | No closed versioned provider-config schema or approved immutable non-live key profile exists; `BLK-0010`. | `OQ-0014` |

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
| DuckDB/persisted objects | 31 | 0 | 0 | 0 | 31 | `31 != 0 + 0 + 0` | US-003/US-004 slices: 13 tables, 6 logical no-table shapes, and 12 indexes; lifecycle/runtime and authoritative review-identity proof remain |
| Columns/material fields | 208 | 0 | 0 | 11 | 197 | `208 != 0 + 0 + 11` | US-003/US-004 slices: 158 physical columns plus 50 JSON key/path-family rows; eleven open JSON domains blocked |
| Indexes (DBO subset) | 12 | 0 | 0 | 0 | 12 | `12 != 0 + 0 + 0` | Declared current indexes enumerated; deployed existence, optimizer use, size, and write cost unavailable |
| Payload/file shapes (DBO subset) | 0 | 0 | 0 | 0 | 0 | `0 = 0 + 0 + 0` | Not baselined |

The remaining bootstrap zeros count only normalized rows. They are not evidence
that the repository has no surfaces or objects; `BLK-0001` prevents that
interpretation. The API family remains 22 nonterminal plus one blocked row. The
US-003 and US-004 together add 31 nonterminal object rows and reconcile 208
material fields as 197 nonterminal plus eleven blocked open-JSON rows. US-004
contributes 11 objects (4 tables, 2 indexes, and 5 logical composites) and 53
fields (45 physical columns and 8 JSON path families). Later census stories must
append rather than renumber these rows and update affected counts.

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
| `CMD-0020` | 2026-07-21 / US-003 | `jq`/`sed` reads of `tasks/prd.json`, `.ralph-tui/progress.md`, `REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md`, and `STORAGE_SHAPE_AUDIT_PLAN.md`; complete reads of `.opencode/skills/forskai-reporting/SKILL.md` and `forskai-duckdb/SKILL.md` | Read the prerequisite state, Phase-0 schema-census contract, durable framework, and repo-specific reporting/database rules. | US-001/US-002 were complete; US-003 had no normalized object or field rows. |
| `CMD-0021` | 2026-07-21 / US-003 | Source-only inspection of `src/db/migrateDuckdb.ts#getDuckdbMigrationFiles` plus `rtk rg -n -i` across `src/db/duckdbMigrations/*.sql` for exact table/index DDL | Establish full-file-name lexical ordering and identify every schema/data migration touching the census objects. | Complete per-object chains in the US-003 migration table; no migration was executed. |
| `CMD-0022` | 2026-07-21 / US-003 | Source-only `sed` reads of 0000, 0011-0013, 0016, 0021-0022, 0029, 0039, 0044, 0067, 0077-0078, 0081, 0083, 0089, and 0091-0092; `rtk bun -e` static parser over the final `CREATE TABLE` bodies; exact create/drop-index search | Enumerate final columns, types, nullability/defaults, identities, constraints, and current named indexes without DuckDB. | 9 physical tables, 113 columns, and 10 named current indexes; final rebuild drift from 0000 was preserved. |
| `CMD-0023` | 2026-07-21 / US-003 | Source-only exact table/column searches and `sed` reads of `schemaTypes.ts`, article import/canonical/full-text services, data-source/import routes, project/add/subproject routes, transfer services, and archived cleanup | Separate production readers/writers/lifecycle from types and discover identity allocation. | Production references recorded per object; UUIDs are writer-supplied; cleanup is partial rather than certification-complete. |
| `CMD-0024` | 2026-07-21 / US-003 | Source-only `rtk rg -n` and `sed` inspection of JSON extraction/builders in `articleSourceMetadata.ts`, `getJournalTitleFromOriginalData.ts`, `getArticleUrl.ts`, `articleCanonicalFieldResolver.ts`, `structuredFileImportService.ts`, `covidenceImportService.ts`, `fullTextConversionJobs.ts`, and transfer asset/read/write services | Enumerate named JSON keys and distinguish genuinely open `unknown`/recursive/source-defined domains. | 42 JSON key/path-family rows; nine wildcard domains blocked without inventing a finite key set. |
| `CMD-0025` | 2026-07-21 / US-003 | Exact repository searches for `data_source_import_route`, `subproject`, `source_record`, and all nine qualified table names, separating `src` production files from tests, migrations, tasks, and old plans | Close the static reference inventory and resolve the subproject storage representation. | No production `data_source_import_route` reference and no subproject table; subproject writes ordinary project/prompt/article links. Dynamic/deployed closure remains blocked. |
| `CMD-0026` | 2026-07-21 / US-003 | Source-only `rtk bun -e` manifest invariant checks; `rtk git diff --check -- STORAGE_SHAPE_AUDIT_PLAN.md .ralph-tui/progress.md`; `rtk bun run lint` | Verify ID continuity, row counts, allowed status vocabulary, unresolved dispositions, table shape, whitespace, and repo lint. | Manifest checks passed: 20 sequential DBO rows, 155 sequential CMF rows, 9 blocked JSON rows, no invalid status, no resolved disposition, and correct Markdown column counts. Diff check passed. Lint retained the same six unrelated pre-existing errors in the three worker files recorded by US-001/US-002. |
| `CMD-0027` | 2026-07-21 / US-003 | `bun run typecheck`, `bun test`, `bun run build`, server/app/browser/desktop checks, `bun run db:mig`, benchmark/fixture runs, snapshot queries, and all direct/live DuckDB inspection (skipped) | Preserve the docs-only and no-runtime-mutation boundary. | `package.json` has no `typecheck` script. Builds/runtime flows do not validate Markdown. Migration tests create disposable databases and this is not a designated physical-evidence story; no test fixture, server, migration, benchmark, snapshot query, or database process ran. |
| `CMD-0028` | 2026-07-21 / US-004 | Reads of `tasks/prd.json`, `.ralph-tui/progress.md`, `REVIEW_STORAGE_SHAPE_AUDIT_PLAN.md`, and the complete durable audit; complete reads of `.opencode/skills/forskai-duckdb/SKILL.md` and `forskai-reporting/SKILL.md` | Confirm US-003 prerequisite, story boundary, prior row counts/IDs, full-file lexical schema rule, no-live-DuckDB rule, and reporting gates. | US-003 was complete; US-004 had no object/field rows and every existing disposition was unresolved. |
| `CMD-0029` | 2026-07-21 / US-004 | Source-only `rg -n`/`sed` inspection of prompt/project-prompt/model/provider DDL in 0000, 0014, 0020-0021, 0029-0030, 0039-0040, 0044, 0081, 0083, and 0089 plus `migrateDuckdb.ts#getDuckdbMigrationFiles` | Trace every declaration/rebuild/data step and current create/drop-index state in actual lexical order. | Final four-table, 45-column, two-index shape and every retained/removed FK, uniqueness, enum, default, and nullability rule recorded; no database opened. |
| `CMD-0030` | 2026-07-21 / US-004 | Source-only static extraction/counting of final `CREATE TABLE` bodies and exact `CREATE/DROP INDEX` statements for the four tables | Independently check field and named-index cardinality without using DuckDB metadata. | 9 prompt + 12 project-prompt + 11 model + 13 provider columns = 45; current named indexes are project-prompt project-first and model provider/remote/normalized-variant unique. |
| `CMD-0031` | 2026-07-21 / US-004 | Exact table/column searches and reads of `schemaTypes.ts`, immutable prompt/hash services, project/prompt routes, Covidence/subproject flows, provider repositories, project transfer export/commit, and archived cleanup | Trace field allocation, reads, writes, constraints implemented only in routes, transfer, and lifecycle references. | UUID allocation and production references recorded; full-text/date rules are route-only, and cleanup/retention evidence is incomplete. |
| `CMD-0032` | 2026-07-21 / US-004 | Source-only JSON key searches/reads of `providerModelMetadata.ts`, `providerDbUtils.ts`, `providerModelOptions.ts`, `projectTransferSnapshotFingerprint.ts`, and `projectTransferCommitWriter.ts#getImportedSnapshotJson` | Enumerate every named JSON key/alias/fingerprint and distinguish open spread/transfer-preserved domains. | Eight path-family rows added; model and provider each retain one genuinely open key domain without an invented closure. |
| `CMD-0033` | 2026-07-21 / US-004 | Source-only inspection of review config/hash, projection identity, selected-import/V4 snapshot, judgment visibility/execution snapshot, job/applicability, delta service, and invalidation registry symbols in `EVD-0036`-`EVD-0039` | Enumerate every applicability, judgment, projection, snapshot, route-composition, and invalidation dimension and compare contracts. | Six cross-contract gaps preserved under `BLK-0011`; specialized scope/content identity helpers have test but no production call sites. |
| `CMD-0034` | 2026-07-21 / US-004 | `rtk bun test src/server/services/immutablePromptService.test.ts src/server/providers/providerModelRepository.test.ts src/server/providers/providerModelMetadata.test.ts src/server/providers/providerDbUtils.test.ts src/utils/providerModelOptions.test.ts src/server/reviewServing/reviewProjectionIdentity.test.ts src/server/reviewServing/reviewConfigReviewServingDeltaService.test.ts src/server/reviewServing/reviewServingInvalidationRegistry.test.ts src/server/services/judgmentExecutionSnapshotService.test.ts` | Run focused prompt/model/provider/config/identity/invalidation/snapshot checks. | Passed: 61 tests, 0 failures, 164 expectations across 9 files. `providerModelRepository.test.ts` applied migrations only to an isolated auto-cleaned temporary DB under `.openclaw/tmp`; it did not open live data and is non-production corroboration, not census/physical proof. |
| `CMD-0035` | 2026-07-21 / US-004 | `bun run lint` | Run the repo-native lint gate with raw output. | Failed on the same six unrelated pre-existing import-order/formatting errors in `comparisonProjectServingMaintenanceWorker.ts`, `reviewServingProjectorWorker.test.ts`, and `reviewServingProjectorWorker.ts`; US-004 changes no `src` file and did not fix them. |
| `CMD-0036` | 2026-07-21 / US-004 | Source-only Bun manifest invariant check; `git diff --check -- STORAGE_SHAPE_AUDIT_PLAN.md .ralph-tui/progress.md` | Verify sequential IDs, row counts, allowed statuses, unresolved dispositions, required blocker/question cells, Markdown width, and patch whitespace. | Passed: 31 sequential DBO, 208 sequential CMF, 11 blocked CMF, 12 indexes, 41 evidence, 37 command, 11 blocker, and 16 owner-question rows; allowed status/unresolved-disposition/required-cell/table-width checks and patch whitespace all passed. |
| `CMD-0037` | 2026-07-21 / US-004 | `bun run typecheck`, full `bun test`, `bun run build`, server/app/browser/desktop flows, `bun run db:mig`, benchmark/snapshot commands, and every direct/live DuckDB inspection (skipped) | Preserve docs-only scope and avoid irrelevant, mutating, or prohibited checks. | `package.json` has no `typecheck` script. Focused tests cover source contracts. Build/runtime/full-suite checks do not validate Markdown; direct migration/benchmark/snapshot/live-data commands are out of scope and were not run. |

## Blockers

| rowId | Scope | Missing evidence | Why blocked | Owner question IDs | Resolution condition |
| --- | --- | --- | --- | --- | --- |
| `BLK-0001` | Five manifests and eleven outputs | The inherited narrative has not been re-censused into stable rows with exact production/non-production evidence. | Later inventory and lineage stories own that work; treating narrative bullets as reconciled would overstate proof. | `OQ-0001` | Populate all manifests, update counts, and reconcile every inherited discovery. |
| `BLK-0002` | Physical fan-out, width, lifecycle age, and benchmark proof | The repository fixes scale/workload but not seed, model, provider, thinking, prompt identities, content flags, physical DuckDB memory, runtime profile/role, or approved snapshot identity; no approved physical evidence is attached. | Live DuckDB inspection is prohibited and US-002 does not authorize fixture mutation or value substitution. | `OQ-0002`, `OQ-0005` | Record approval, every fixed value, immutable identity, collection command, and evidence ID in the designated measurement story. |
| `BLK-0003` | Inherited move/delete/retention candidates | Revised API, writer, lifecycle, recovery, export, transfer, and retention proof is absent. | Inherited evidence predates the normalized proof gate and cannot certify actionability. | `OQ-0003`, `OQ-0004` | All applicable proof checks are `satisfied` or evidence-backed `not-applicable`. |
| `BLK-0004` | Health route mount and parity | `POST /api/projectsreviewshealth` is declared mounted and parity-covered but is absent from product route composition and the public route registry. | Source evidence conflicts; test coverage trusts the stale declaration and cannot prove reachability. | `OQ-0006` | Product/API owner resolves the intended mount state and all registries/tests agree. |
| `BLK-0005` | Seeding, projection, and route-read physical timing | The smoke harness contains canned observations and no separate seed/import or projection/rebuild duration fields. | Phase-6 scope labels are not physical timestamps, and no approved fixture run exists. | `OQ-0009` | Approved physical report emits separate raw timestamps/durations for all three boundaries. |
| `BLK-0006` | Route registry and parity closure | Add-by-ID and PDF-job status are parity-only; four adjacent job/status/download routes are registry-only; add-by-filter production semantics disagree with its route-inventory contract mapping. | The current registries cannot be treated as one exhaustive, internally consistent contract source. | `OQ-0007` | Owners reconcile route inventory, parity coverage, production job/search semantics, and adjacent route scope. |
| `BLK-0007` | US-003/US-004 deployed/effective schema and physical evidence | Applied migration names, deployed tables/columns/constraints/indexes, row counts, bytes, distributions, timestamps, and optimizer plans are unavailable. | Live DuckDB inspection is prohibited and no approved immutable schema/physical snapshot was supplied; checked-in SQL proves declared shape only. | `OQ-0010` | Attach an approved immutable non-live snapshot identity and collection output for migration/schema/index/physical evidence under the fixed benchmark configuration. |
| `BLK-0008` | Open JSON key domains | Nine JSON path-family rows accept arbitrary recursive, source-defined, or transfer-preserved keys because production types are `unknown` and the SQL columns have no key constraint. | Static source can enumerate material named keys but cannot turn an open payload contract into a finite list; no runtime key profile may be inferred or collected from live data. | `OQ-0011` | Owners provide versioned closed schemas for each payload or approve an immutable non-live key-profile snapshot and state which unexpected keys are retained. |
| `BLK-0009` | `app.data_source_import_route` ownership | No production reader, writer, delete, repair, transfer, or operator reference was found; only 0000 and an old plan mention the table. | Literal absence is not enough to classify/delete the table, and dynamic/generated reference closure plus deployed-state evidence is missing. | `OQ-0010`, `OQ-0013` | Data-source owner identifies the current lifecycle/consumer or confirms the intended schema-only state, and audit owner closes dynamic/generated reference discovery. |
| `BLK-0010` | Model/provider open JSON key domains | `app.model.metadata_json` and `app.provider_connection.config_json` each retain provider-, legacy-, or transfer-preserved keys outside the statically named current schemas. | Production columns/types accept `unknown`, option updates spread existing records, and transfer import spreads source objects before adding its marker; static source cannot produce a finite exhaustive key list and live profiling is prohibited. | `OQ-0014` | Owners provide closed versioned schemas and unknown-key retention rules, or approve an immutable non-live key profile with exact snapshot identity. |
| `BLK-0011` | Review configuration identity and applicability contract | Legacy prompt hash fallback, criteria metadata, prompt/link state, date/scope applicability, model/provider execution state, judgment natural key, review hash, snapshot identity, and invalidation field sets do not share one source-observed dimension set. | Choosing any one contract or resolver default as authoritative would silently change benchmark-critical judgment reuse or review reachability; route-only constraints are not database constraints. | `OQ-0015`, `OQ-0016` | Product/reliability owners publish the authoritative applicability, reuse, hash, snapshot, and invalidation rules and reconcile every source path in a separately authorized implementation story. |

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
| `OQ-0010` | Database/audit owner | Which immutable non-live snapshot may certify the applied migration set, exact deployed columns/constraints/indexes, optimizer plans, row/byte/distribution/timestamp evidence, and absence of dynamic/generated references for this census? | `BLK-0007`, `BLK-0009`, all nonterminal US-003/US-004 rows, and physical/index proof |
| `OQ-0011` | Import/data-retention owner | What versioned schemas and retention/replay rules govern `original_data`, `source_metadata`, `full_text_assets`, import/match/raw payloads, and source-record quarantine metadata, including unknown transfer-preserved keys? | `BLK-0008`, open JSON rows, source-record lifecycle, and final field classification |
| `OQ-0012` | Product/project owner | Is a subproject intentionally indistinguishable from an ordinary `app.project` after creation, with no persisted parent/source-project IDs or discriminator, and which prompt/article provenance must survive export, transfer, replay, and deletion? | `DBO-0007`-`DBO-0010` and subproject lifecycle classification |
| `OQ-0013` | Data-source owner | Is `app.data_source_import_route` intentionally dormant/schema-only, or which production writer, reader, and lifecycle should own it instead of the denormalized `app.data_source.import_route` string? | `DBO-0004`, `CMF-0020`-`CMF-0024`, and `BLK-0009` |
| `OQ-0014` | Provider/model and transfer owners | What closed, versioned schemas govern `model.metadata_json` and `provider_connection.config_json`, including legacy aliases, import markers, snapshot fingerprints, arbitrary transferred keys, and their retention/version-upgrade behavior? | `CMF-0185`, `CMF-0194`, `CMF-0201`-`CMF-0208`, and `BLK-0010` |
| `OQ-0015` | Benchmark/review-config owner | Which exact dimensions must define immutable prompt identity, model execution identity, active judgment reuse, prompt/review hashes, and execution snapshots; specifically, how should legacy null prompt hashes, prompt criteria, provider enable/auth/config/concurrency, model metadata/enablement, and in-place option changes invalidate or prevent reuse? | `DBO-0021`-`DBO-0026`, `DBO-0031`, `BLK-0011`, and benchmark-critical identity proof |
| `OQ-0016` | Product/project/judgment owner | What is the authoritative applicability rule for project archived state, prompt/link enabled and archived state, inclusive dates, curated membership, selected routes, and invalid stored combinations; must the full-text/date route rules become database/transfer constraints? | `DBO-0027`-`DBO-0030`, `BLK-0011`, and applicability/invalidation proof |

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

## US-003 Quality Gates

- [x] Nine physical article/import/project-scope tables and the logical
      no-table subproject shape enumerate every effective column, identity,
      constraint, default/nullability rule, and ten current named indexes.
- [x] The complete forward chain is traced in the migration runner's actual
      full-file-name lexical order, including no-op/data-only steps and final
      rebuilds that remove bootstrap constraints or indexes.
- [x] Production reads/writes/lifecycle references are separate from tests,
      plans, generated/type evidence, and historical migrations.
- [x] All statically material JSON keys are named, while nine genuinely open
      recursive/source-defined/transfer-preserved domains remain explicit
      `blocked` rows rather than receiving invented keys.
- [x] The schema manifest reconciles 20 discovered rows as 20 nonterminal; the
      material-field manifest reconciles 155 rows as 146 nonterminal plus nine
      blocked; the ten-index subset remains nonterminal pending physical proof.
- [x] Only the US-001 `auditStatus` vocabulary is used; proof-check,
      recommendation-actionability, and overall-certification state remain
      separate.
- [x] Every `CMF-####` disposition is `unresolved`; no move, derive, archive,
      delete, target-shape, or implementation recommendation was added or
      strengthened.
- [x] Applied/deployed schema, physical statistics, optimizer/index use, and
      runtime JSON-key evidence are explicitly unavailable with blockers and
      owner questions; no live DuckDB or substitute resolver default was used.
- [x] Story-specific invariant and whitespace checks pass. Repo lint retains
      the same six unrelated pre-existing errors; no `typecheck` script exists,
      and fixture/runtime/database/build checks were skipped for the recorded
      docs-only scope.

## US-004 Quality Gates

- [x] Four physical tables enumerate all 45 effective columns, SQL names/types,
      nullability/defaults, PK/FK/unique/enum constraints, identity allocation,
      final declaring migrations, and two current named indexes.
- [x] Five logical objects enumerate every persisted backing field for scope,
      content settings, date range, selected routes, and project review config
      without duplicating US-003 manifest rows or inventing standalone tables.
- [x] Eight model/provider JSON path-family rows name every static key and alias;
      the two open transfer-preserved domains remain `blocked` with evidence and
      an owner question.
- [x] Applicability, active judgment, prompt/review hash, declared/production
      projection, selected-import/V4/execution snapshot, composed-route, and
      invalidation dimensions are separately enumerated.
- [x] Six source-observed identity/applicability gaps are preserved under a
      blocker; no hash, resolver default, route rule, or caller is silently made
      authoritative.
- [x] The schema manifest reconciles 31 discovered rows as 31 nonterminal; the
      material-field manifest reconciles 208 as 197 nonterminal plus 11 blocked;
      the 12-index subset remains nonterminal pending physical proof.
- [x] Only the US-001 `auditStatus` vocabulary is used, while
      `proofCheckState`, `recommendationActionability`, and
      `overallCertification` remain independent.
- [x] Every added physical/logical field disposition is `unresolved`; no move,
      derive, archive, delete, target-shape, implementation, retention, or
      runtime recommendation is added or strengthened.
- [x] Focused verification passes 61 tests. The isolated auto-cleaned temporary
      migration fixture is recorded as non-production corroboration only; no
      live DuckDB was opened or queried.
- [x] Story-specific manifest and whitespace verification pass. Repo lint keeps
      the same six unrelated pre-existing errors; no `typecheck` script exists,
      and irrelevant/prohibited full-suite, build, runtime, benchmark, migration,
      snapshot, and live-database checks are recorded as skipped.

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

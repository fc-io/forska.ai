# Open Source Route Surface Audit

Date: 2026-05-11

Status: draft current-state baseline, updated after the initial legacy route cleanup. This document records the route and network surface that must be resolved before an open-source release.

## Goal

Make the repo's exposed HTTP surface explicit so the open-source release can fail closed. Every listener, proxy, route group, and scheduled network-capable runtime should have a classification and a keep/remove/local-only decision before publishing.

## Classifications

| Classification | Meaning |
| --- | --- |
| `public product` | Required for the normal local single-user app flow. |
| `local-only` | Acceptable only when bound to loopback or desktop-local transport. |
| `admin/debug` | Inspection, cleanup, repair, or diagnostic behavior not part of the normal product promise. |
| `operator/infra` | Worker, owner, queue, database, GPU, proxy, SSH, or background-runtime coordination. |
| `dead/remove` | Legacy, typo, duplicate, or unused surface that should be removed or replaced. |
| `unknown/blocker` | Needs a decision before public release. |

## Entrypoint Matrix

| Entrypoint | Surface | Current behavior | Classification | Release decision |
| --- | --- | --- | --- | --- |
| `src/server/serverMain.ts` | API server on `127.0.0.1:${API_SERVER_PORT}` | Mounts proxy routes, runtime readiness, DuckDB owner registry, telemetry, crons, product API routes, and optional private DuckDB-owner mirrored API. CORS is limited to localhost app ports and desktop origins when desktop mode is enabled. | mixed: `public product`, `admin/debug`, `operator/infra` | Keep local-only by default. |
| `src/appServerMain.ts` | Static app server on `127.0.0.1:${APP_SERVER_PORT}` | Serves `/assets`, returns `index.html` for non-API paths, and proxies all `/api` and `/api/*` requests to the API server. API proxy target falls back to `127.0.0.1`. | `public product`, `local-only` | Keep local-only by default. |
| `src/desktop/index.ts` | Desktop wrapper and API bridge | Starts `src/server/index.ts` with `SERVER_ROLE=dev-single`, `FORSKA_DESKTOP_MODE=true`, and API origin `http://127.0.0.1:32101`. Desktop bridge only supports `/api/*`. | `local-only` | Keep. Desktop uses the same backend API surface, so backend route decisions apply to desktop too. |
| `src/server/routes/ApiProxyRoutes.ts` | `onRequest` proxy middleware | Proxies classified API requests to the current DuckDB owner when the current role is an owner-proxy. `unclassified` routes are proxy/fail-closed candidates. | `operator/infra` | Keep internal/local-only. Blocker: product routes need explicit classification so `unclassified` does not remain the audit baseline. |
| `src/server/routes/apiRouteClassification.ts` | Route classification helper | Classifies only runtime ready/state, DuckDB owner diagnostics, a subset of judgment-job diagnostics/control, and DuckDB studio snapshot. Most product routes are currently `unclassified`. | `operator/infra` | Keep, but expand or pair with a route manifest before public release. |
| Cron plugins in `src/server/cron/*` | Scheduled background work mounted by server role | Full-text fetch, PDF conversion, NVIDIA SMI polling, judgment queue import/add/send/check/status/cleanup. These are scheduled Elysia plugins, not normal user HTTP paths. | `operator/infra` | Keep role-gated and local-only. Review defaults and docs because some jobs can call external APIs, provider runtimes, Docling, or SSH. |

## Mounted Route Matrix

| Source | Paths and methods | Data or behavior | Classification | Suggested decision |
| --- | --- | --- | --- | --- |
| `runtimeReadyRoutes.ts` | `GET /api/runtime/ready`, `GET /api/runtime/state` | Runtime readiness, role, capabilities, PID, Bun request-limit state. | `local-only`, `operator/infra` | Keep local-only. |
| `DuckdbOwnerConnectionsRoutes.ts` | `GET /api/duckdb_owner_connections`, `POST /api/duckdb_owner_connections/heartbeat` | DuckDB-owner registry, heartbeats, proxy metadata, mart refresh throughput. | `operator/infra` | Keep internal/local-only. |
| `JudgmentDispatchTelemetryRoutes.ts` | `GET /api/admin/judgment-dispatch-runtime/:jobId` | Local judgment dispatch telemetry and provider capacity diagnostics. | `admin/debug`, `operator/infra` | Keep local-only only if still needed; hide from public product docs. |
| `AdminInvestigateRoutes.ts` | `GET /api/admin/duckdb-append-metrics`, `GET /api/admin/maintenance-runtime-diagnostics`, `GET /api/admin/worker-runtime-diagnostics`, `GET/POST /api/admin/project-mart-large-rebuild-*`, `GET /api/admin/list-prompts-with-types`, `POST /api/admin/delete-unexpected-answers`, `POST /api/admin/auto-sync-all-unexpected-answers`, `GET /api/admin/auto-sync-all-progress`, `GET /api/admin/investigate-unexpected-answers` | Runtime diagnostics, mart rebuild control, prompt/judgment cleanup and investigation. | `admin/debug`, `operator/infra` | Blocker: remove, gate, or explicitly document as local-only debug surface. Current mount contradicts the no-admin product stance. |
| `ComparisonProjectsRoutes.ts` | `GET/POST/PATCH/DELETE /api/comparison-projects*`, including archived, sources, from-project, judgments, conflict-resolution, export, unarchive. | Comparison project CRUD, judgment comparison, conflict resolution, CSV export. | `public product`, `local-only` | Keep for local product flow. |
| `JudgmentsJobsRoutes.ts` | `POST /api/judgmentsjobs`, `GET /api/judgmentsjobs`, `GET /api/judgmentsjobs/:id`, `GET /api/judgmentsjobs/:id/health`, `GET /api/judgmentsjobs-health`, `GET /api/judgmentsjobs-running`, `GET /api/judgmentsjobs-unassessed-*`, `GET /api/judgmentsjobs-total-token-usage`, `PATCH /api/judgmentsjobs/:id`, `DELETE /api/judgmentsjobs/:id` | Judgment job lifecycle, status, health, token totals, control. | mixed: `public product`, `operator/infra` | Keep UI-required lifecycle routes local-only. Split worker/control routes into internal/operator section before release. |
| `JudgmentsJobsRoutes.ts` worker and repair paths | `POST /api/judgmentsjobs/:id/claim(s)`, `POST /api/judgmentsjobs/:id/complete|completions`, `POST /api/judgmentsjobs-worker-heartbeats`, `GET /api/judgmentsjobs/:id/runtime`, `GET /api/judgmentsjobs/execution-snapshots/:id`, `GET /api/judgmentsjobs-execution-snapshots/:id`, `POST /api/judgmentsjobs/:id/start-clean|preflight|drain|checkpoint|quarantine|unquarantine|repair|repair-orphaned-queue` | Worker queue lease/claim/completion APIs, runtime state, repair and quarantine controls. | `operator/infra`, `admin/debug` | Keep internal/local-only if needed. Blocker until separated from public product route surface. |
| `providerAdmissionLeaseRoutes.ts` | `POST /api/provideradmissionleases/{acquire,heartbeat,release,release-result,expire,reconcile}` and alias `/api/provider-admission-leases/...` | Provider admission lease coordination for judgment request capacity. | `operator/infra` | Keep internal/local-only. Consider whether the alias is needed publicly. |
| `ArticlesRoutes.ts` | `GET /api/articles/conversion-stats`, `GET /api/articles/latest`, `GET /api/articles/search`, `GET /api/articles/:id`, `POST /api/articles/batch-upsert`, `POST /api/articles/conversion-reset`, `POST /api/articles/pdf-fetch-reset`, `POST /api/articles/pdf-fetch-bulk`, `POST /api/articles/pdf-fetch-by-filter`, `POST /api/articles/pdf-fetch-by-project`, `GET /api/articles/pdf-fetch-jobs/:jobId`, `DELETE /api/articles/:id` | Article browsing/search/detail, imports, PDF fetch jobs, conversion reset, delete. | mixed: `public product`, `admin/debug` | Keep product reads and PDF workflow local-only. Review/gate reset, batch upsert, bulk fetch, and delete behavior. |
| `ArticleAdminRoutes.ts` | `GET /api/articles/:id/admin-info`, `POST /api/articles/:id/fetch-pdf`, `POST /api/articles/:id/upload-pdf`, `POST /api/articles/:id/convert-pdf` | Article PDF state, external PDF fetch, upload, Docling conversion. | mixed: `public product`, `admin/debug` | Keep local-only if product UI requires it. Rename or document because `admin` naming conflicts with no-admin stance. Audit upload/fetch/path behavior. |
| `JudgmentsRoutes.ts` (removed) | `GET /api/judgments/model` (removed) | Previously got or created a default SGLang model/provider record from query defaults. Empty-model UI now links to explicit provider setup at `/providers`. | `dead/remove` | Removed. Use explicit provider/model setup via `/providers` or product-specific ensure flows. |
| `HumanAssessmentRoutes.ts` | `GET /api/humanassessment/overview`, `GET /api/humanassessment/overview-both-projects`, `POST /api/humanassessment/init`, `POST /api/humanassessment/submit` | Human review/assessment setup and submission. | `public product`, `local-only` | Keep. |
| `ModelsRoutes.ts` | `GET /api/models`, `GET /api/models/stored`, `GET /api/models/codex/status`, `POST /api/models/codex/login`, `GET /api/models/codex/login/:jobId`, `POST /api/models/ensure`, `GET /api/models/gpu-info` | Model list/config, Codex login state, ensure model, GPU/runtime config. | mixed: `public product`, `local-only`, `operator/infra` | Keep model setup local-only. Review Codex login and GPU-info docs/exposure. |
| `ProviderConnectionsRoutes.ts` | `POST /api/provider-auth/:providerKind/begin|finish`, `GET/POST/PATCH/DELETE /api/provider-connections`, `POST /api/provider-connections/:id/test`, `GET /api/provider-connections/:id/discovered-models` | Provider connection CRUD, API key storage, auth flows, provider health/model discovery. | `public product`, `local-only` | Keep local-only. Blocker: document secret storage and ensure no secret values leak through responses/logs. |
| `ProviderModelsRoutes.ts` | `POST /api/provider-connections/:id/sync-models`, `POST /api/provider-connections/:id/models`, `PATCH /api/models/:id` | Provider model sync, manual model add, model update. | `public product`, `local-only` | Keep. |
| `ProjectsRoutes.ts` and nested review routes | `GET/POST/PATCH/DELETE /api/projects*`, `GET /api/projects-without-jobs`, `GET /api/projects/:id/access`, `POST /api/articlesreviews*`, `GET /api/articlesreviewsfilters`, `GET /api/articlesreviewshumanfilters`, `POST /api/projectsreview`, `POST /api/projectsreviewswarnings` | Project CRUD, review lists/details/filters/warnings, prompt and model edits, archive/unarchive/clone. | mostly `public product`, `local-only` | Keep product routes. Review warnings endpoint because it can trigger repair work. |
| `projectsRoutesPostDeleteArchived.ts` | `POST /api/projects/delete-archived` | Requests archived project cleanup. | `admin/debug`, `operator/infra` | Gate or keep local-only with explicit UI/operator decision. |
| `ProjectArticlesRoutes.ts` | `GET/POST /api/projects/:id/articles`, `DELETE /api/projects/:id/articles/:articleId` | Curated project article links. | `public product`, `local-only` | Keep. |
| `ProjectExportRoutes.ts` | `POST /api/projects/:id/export`, `POST /api/projects/:id/export-prompts` | CSV export of project articles, judgments, prompts, and metadata. | `public product`, `local-only` | Keep. |
| `ProjectsAddArticlesRoutes.ts` | `POST /api/projects/add_articles_by_filter`, `POST /api/projects/add_articles_by_ids` | Bulk add articles to projects by filter or id. | `public product`, `local-only` | Keep needed behavior. Typo path removed and active caller updated. |
| `PromptsRoutes.ts` read/user paths | `GET /api/prompts`, `GET /api/prompts/archived`, `PATCH /api/prompts/:id` | Prompt list and archive toggle. | `public product`, `local-only` | Keep. |
| `PromptsRoutes.ts` admin paths | `GET /api/prompts/duplicates`, `POST /api/prompts/regenerate-hashes`, `DELETE /api/prompts/:id`, `GET /api/prompts/orphans`, `POST /api/prompts/merge`, `GET /api/prompts/invalid-judgments`, `POST /api/prompts/delete-invalid-judgments` | Prompt cleanup, merge, hash regeneration, invalid judgment cleanup. | `admin/debug` | Gate or keep local-only with explicit operator docs. Not normal product surface. |
| `ImportRoutes.ts` | `GET /api/import-routes` | Import route list. | `public product`, `local-only` | Keep canonical `/api/import-routes`. Legacy `/api/importroutes` alias removed. |
| `DataSourcesRoutes.ts` | `GET/POST/PATCH/DELETE /api/datasources`, `GET /api/datasources/archived`, `GET /api/datasources/:id` | Data source CRUD/archive and import state. | `public product`, `local-only` | Keep. |
| `DataSourcesImportRoutes.ts` | `POST /api/datasources/import/{covidence-analyze,covidence-create,covidence,arxiv,biorxiv,medrxiv,pubmed,europe-pmc-ppr,fhir-ehr-patients,structured-file-analyze,structured-file-create,structured-file}` | File upload/import and external literature/API import workflows. FHIR/EHR path is privacy-sensitive. | `public product`, `unknown/blocker` for FHIR/EHR | Keep normal literature and structured-file imports local-only. Blocker: decide whether FHIR/EHR patient import should ship in the public Forska release. |
| `DuckdbStudioRoutes.ts` | `POST /api/duckdbStudioSnapshots` | Creates DuckDB snapshots and requires owner role. | `admin/debug`, `operator/infra` | Keep internal/local-only or remove before release. Not public product. |
| `TokensRoutes.ts` | `POST /api/tokens/usage`, `GET /api/tokens`, `GET /api/tokens/largest-*`, `POST /api/tokens/timeline*`, `POST /api/tokens/failed-requests`, `GET /api/tokens/failed-requests/:id` | Token usage analytics and failed request details. | mixed: `public product`, `admin/debug` | Keep local-only. Blocker: failed request detail payloads may include sensitive prompts/content and need redaction/doc decision. |
| `UsersRoutes.ts` | `GET /api/users`, `PATCH /api/users` | Single-user settings, local app settings, full-text conversion model, Unpaywall email, local binary paths. | `public product`, `local-only` | Keep. Consider renaming/docs to avoid implying multi-user/admin. |
| `RuntimeAssetsRoutes.ts` | `GET /api/runtime-asset?path=...` | Reads local runtime asset files restricted to paths beginning with `assets/`. | `local-only`, `unknown/blocker` | Keep only local-only. Audit path handling and confirm public docs never expose arbitrary local file reads. |
| `LlmStatusRoutes.ts` | `GET /api/llmstatus` | LLM runtime metrics from local DB. | `local-only`, `operator/infra` | Keep local-only if status UI needs it. |
| `NvidiaSmiRoutes.ts` | `GET /api/nvidiasmi` | GPU metrics from local DB. | `local-only`, `operator/infra` | Keep local-only or hide when not applicable. |
| `SubprojectsRoutes.ts` | `GET /api/subprojects/sources`, `POST /api/subprojects` | Creates subprojects from source projects and prompt filters. | `public product`, `local-only` | Keep. |
| Owner RPC mirror | `/__duckdb-owner-rpc/**` | Mirrors product API routes under `duckdbOwnerPrivateApiPrefix` when the current role mounts the owner RPC API. | `operator/infra` | Keep internal only. Blocker: ensure it is never exposed beyond loopback/process-local coordination. |

## Current Blockers

| Blocker | Why it matters | Suggested next action |
| --- | --- | --- |
| API and app server bind hosts are now explicit loopback defaults. | The release principle requires loopback-only defaults or a documented exception. | Keep this as a regression guardrail when listener/runtime wiring changes. |
| Admin/debug/operator routes are mounted together with product routes. | This contradicts the README's no-admin product stance unless every route is intentionally local-only/debug. | Split route decisions into keep public product, keep local-only debug, or remove. |
| `/api/*` app-server proxy forwards any API path. | A catch-all proxy makes the actual exposed surface broader than docs unless the API server itself is tightly classified. | Keep only with an explicit route manifest/baseline. |
| `apiRouteClassification.ts` leaves most product routes as `unclassified`. | The owner proxy treats `unclassified` as proxy/fail-closed; this is safe-ish operationally but weak as an audit artifact. | Add an explicit supported-route manifest or extend classification for the release baseline. |
| Several routes can expose sensitive local state or content. | Provider secrets, failed request details, runtime assets, uploaded PDFs, PDF fetches, Codex login, and token/request traces need public-release decisions. | Review and document each sensitive path before release. |
| Remaining aliases and questionable paths need decisions. | Aliases and debug/operator controls become public API once open-sourced. | Decide on provider-admission alias paths and the remaining admin/debug/operator route groups. |
| FHIR/EHR patient import is present. | Patient-related import surface is high-risk for public release and docs. | Remove before release or explicitly justify and document safeguards. |

## Suggested Remediation Order

1. Decide the route groups that stay in the public product baseline.
2. Gate, hide, or remove admin/debug/operator route groups that are not product requirements.
3. Replace legacy or ambiguous routes with explicit product routes.
4. Add a supported-route manifest or tests that fail on unexpected listener/route additions.
5. Update public docs to describe only the supported local OSS flow.

## Touched Layers

| Layer | Notes |
| --- | --- |
| server | API entrypoint, route mounting, route classification, cron plugins. |
| client/docs | Eden clients and public docs must match the supported route baseline. |
| desktop | Desktop backend starts the same API server and must inherit local-only guarantees. |
| release ops | Public release must remove, move, gate, or document internal/debug/operator surfaces. |

## Quality Gates

| Gate | Pass/fail expectation |
| --- | --- |
| Manual verify route coverage | Matrix covers `src/server/serverMain.ts`, `src/appServerMain.ts`, `src/desktop/index.ts`, `src/server/routes/*`, nested `src/server/routes/*Routes/*`, route classification, proxy entrypoints, and cron-mounted Elysia plugins. |
| Manual verify bind posture | Browser and desktop flows bind supported OSS listeners to loopback by default, or every broader bind is explicitly documented and approved. |
| Manual verify route decisions | Every row above has a final keep/remove/local-only decision before public release. |
| `bun run lint` | Run after code/docs cleanup that changes route behavior or docs. |
| Targeted `bun test` | Run for any touched route/proxy/runtime files, especially `ApiProxyRoutes`, `apiRouteClassification`, and route groups being gated or removed. |
| Browser verification | Fresh local web flow can `bun run dev:server` and `bun run dev:app` using only public docs. |
| Desktop verification | Desktop flow still uses local backend/API only after route/bind changes. Use `bun run desktop:build` or targeted desktop runtime tests when desktop runtime wiring changes. |

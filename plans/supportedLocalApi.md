# Supported Local API Plan

Date: 2026-05-12

Status: draft. This plan defines the API surface that local apps, LLM tools, agents, and scripts should be able to call when Forska is running on the same machine.

## Goal

- Keep Forska usable as a local API server for the Forska UI, the desktop app, locally installed LLM apps, local agents, and user scripts.
- Keep the default network posture local: bind API and app listeners to loopback by default.
- Make the supported local API explicit so internal worker, repair, database, and debug routes do not accidentally become stable integration APIs.
- Publish a clear local API contract before opening the repo.

## Plain Language Rule

Local apps should be able to call Forska through `http://127.0.0.1:<api-port>`.

That does not mean every mounted route is a supported API. It means the documented local API is available to local clients, while internal runtime routes stay clearly marked as internal, debug, or unsupported.

## Non-Goals

- Do not add hosted multi-tenant behavior.
- Do not add admin accounts or user auth for the open-source local app unless separately decided.
- Do not expose the API to the LAN or internet by default.
- Do not promise stability for internal worker, repair, database snapshot, or debug routes.

## API Categories

| Category | Meaning | Local Apps Can Use It? | Public Docs? |
| --- | --- | --- | --- |
| `supported local API` | Normal product behavior that the UI, desktop app, local LLM tools, agents, and scripts can call. | Yes | Yes |
| `local diagnostics API` | Local status or observability that helps users understand their own runtime. | Yes, with caution | Yes, but marked diagnostic |
| `sensitive local API` | Product behavior that touches files, provider credentials, failed request content, PDFs, exports, or private article data. | Maybe | Yes only after redaction/safety review |
| `internal runtime API` | Worker, DuckDB owner, queue, proxy, and background coordination routes. | No, except Forska internals | No, or marked internal only |
| `maintenance/debug API` | Repair, rebuild, database snapshot, admin investigation, cleanup, and dangerous one-off tools. | No by default | No, or developer/debug docs only |
| `remove from public seed` | High-risk, legacy, dead, private, or unclear surface. | No | No |

## Starting Route Decisions

These are initial decisions, not final documentation. Each row still needs a route-level review before release.

| Route Group | Starting Decision | Notes |
| --- | --- | --- |
| `src/appServerMain.ts` `/api/*` proxy | Keep | Local apps can call the API server directly; the app server proxy remains useful for the browser app. The API server route manifest must define what is supported. |
| `runtimeReadyRoutes.ts` | Local diagnostics API | Keep `GET /api/runtime/ready` and `GET /api/runtime/state`; document as local runtime status. |
| `ProjectsRoutes.ts` | Supported local API | Project CRUD, review views, filtering, and settings are core local app behavior. Split out maintenance-like cleanup routes. |
| `ComparisonProjectsRoutes.ts` | Supported local API | Keep comparison project flows and exports as local product API. |
| `ProjectArticlesRoutes.ts` | Supported local API | Keep project article add/remove/list behavior. |
| `ProjectExportRoutes.ts` | Sensitive local API | Keep exports, but document that responses can contain local project/article/judgment data. |
| `ProjectsAddArticlesRoutes.ts` | Supported local API | Keep as local product API. |
| `PromptsRoutes.ts` read/user routes | Supported local API | Keep prompt list, archived list, and normal prompt update behavior. |
| `PromptsRoutes.ts` cleanup/admin routes | Maintenance/debug API | Gate, hide, or move out of the supported API contract. |
| `ArticlesRoutes.ts` read/search/detail routes | Supported local API | Keep article browsing and lookup. |
| `ArticlesRoutes.ts` reset/delete/bulk routes | Sensitive local API or maintenance/debug API | Review individually before documenting as supported. |
| `ArticleAdminRoutes.ts` | Sensitive local API | Some PDF fetch/upload/convert behavior may be product behavior, but the `admin` naming and file behavior need review. |
| `DataSourcesRoutes.ts` | Supported local API | Keep data source CRUD/archive/import state. |
| `DataSourcesImportRoutes.ts` literature and structured-file imports | Sensitive local API | Keep if file upload, parsing, and external API behavior are documented safely. |
| `DataSourcesImportRoutes.ts` FHIR/EHR patient import | Remove from public seed or explicitly gated | High-risk patient-data surface. Do not include in first public API unless separately justified. |
| `ImportRoutes.ts` | Supported local API | Keep canonical import route list. |
| `HumanAssessmentRoutes.ts` | Supported local API | Keep local review/assessment behavior. |
| `ModelsRoutes.ts` | Supported local API plus diagnostics | Keep model/provider setup and status. Review GPU info exposure and Codex login wording. |
| `ProviderConnectionsRoutes.ts` | Sensitive local API | Keep provider setup, but ensure API keys and secret refs are never returned as secrets or logged. |
| `ProviderModelsRoutes.ts` | Supported local API | Keep provider model sync/manual model routes. |
| `JudgmentsJobsRoutes.ts` create/list/status routes | Supported local API | Local tools should be able to create and inspect jobs. |
| `JudgmentsJobsRoutes.ts` worker claim/complete/heartbeat/runtime/snapshot routes | Internal runtime API | Keep only for Forska internals; not part of stable local integration API. |
| `JudgmentsJobsRoutes.ts` repair/drain/checkpoint/quarantine routes | Maintenance/debug API | Gate or keep developer-only. Do not document as stable local API. |
| `providerAdmissionLeaseRoutes.ts` | Internal runtime API | Keep for worker/provider capacity coordination only. Review aliases before public release. |
| `DuckdbOwnerConnectionsRoutes.ts` | Internal runtime API or local diagnostics API | Required for split runtime. Document only diagnostics, not as stable integration surface. |
| `DuckdbStudioRoutes.ts` | Maintenance/debug API | Gate or exclude from public seed. |
| `AdminInvestigateRoutes.ts` | Maintenance/debug API | Gate, hide, or exclude from public seed. Current `/api/admin/*` naming conflicts with single-user/no-admin product docs. |
| `JudgmentDispatchTelemetryRoutes.ts` | Local diagnostics API or internal runtime API | Keep only if still needed; mark diagnostic/internal. |
| `TokensRoutes.ts` aggregate routes | Local diagnostics API | Aggregates can be useful locally. |
| `TokensRoutes.ts` failed request detail routes | Sensitive local API | Review and redact before documenting; failed requests may contain prompts, article text, provider metadata, or error payloads. |
| `RuntimeAssetsRoutes.ts` | Sensitive local API | Keep only if path handling and asset scope are proven safe and documented. |
| `LlmStatusRoutes.ts` | Local diagnostics API | Keep if useful to local tools; document as local status. |
| `NvidiaSmiRoutes.ts` | Local diagnostics API | Keep if useful; make clear it is machine-local GPU telemetry. |
| `UsersRoutes.ts` | Supported local API | Single-user settings are product behavior. Consider future rename only if docs are confusing. |
| `SubprojectsRoutes.ts` | Supported local API | Keep local product behavior. |
| `ApiProxyRoutes.ts` | Internal runtime API | Keep as implementation detail. The supported local API should not depend on callers knowing proxy internals. |
| `/__duckdb-owner-rpc/**` | Internal runtime API | Never document as a local integration API. |

## What Needs To Change

| # | Change | Target State |
| --- | --- | --- |
| 1 | Create a supported local API manifest | One reviewed source of truth lists supported local routes, diagnostic routes, internal routes, debug routes, and removed routes. |
| 2 | Split route groups conceptually before release | Product routes, diagnostics, internal runtime routes, and debug routes are not all treated as the same API class. |
| 3 | Document local integration behavior | Local apps can call `127.0.0.1:<api-port>`; the API is not network-exposed by default. |
| 4 | Mark internal routes as unsupported | Worker claims, owner RPC, proxy internals, repair flows, and database snapshot routes are not stable integration APIs. |
| 5 | Review sensitive routes | Provider secrets, failed request details, runtime assets, exports, PDFs, uploads, and FHIR/EHR import receive explicit keep/gate/remove decisions. |
| 6 | Add regression checks | Unexpected new listeners or routes fail review until classified. |
| 7 | Update README and public docs | Docs describe the supported local API and stop implying that all mounted routes are public product API. |

## Suggested Implementation Order

1. Build the first manifest from `src/server/serverMain.ts`, `src/appServerMain.ts`, `src/server/routes/*`, nested route modules, `ApiProxyRoutes.ts`, and `apiRouteClassification.ts`.
2. Mark every route as `supported local API`, `local diagnostics API`, `sensitive local API`, `internal runtime API`, `maintenance/debug API`, or `remove from public seed`.
3. Close the high-risk decisions first: FHIR/EHR import, failed request details, runtime assets, provider secrets, DuckDB studio, `/api/admin/*`, and judgment repair/control routes.
4. Add a route-manifest regression test or route-classification test that fails when a mounted route is missing from the manifest.
5. Update public docs with the supported local API rules and examples for local LLM tools/scripts.
6. Update the open-source release seed allowlist so internal planning files and unsupported debug/operator docs do not enter the public seed.

## Example Public Wording

Forska runs a local API server on loopback by default. Local tools on the same machine can call the documented API at `http://127.0.0.1:<api-port>`. Forska does not expose the API to other machines by default. Routes not listed in the supported local API documentation are internal implementation details and may change without notice.

## Deliverables

- Supported local API manifest with every mounted route classified.
- Public local API documentation for local LLM apps, agents, scripts, browser app, and desktop app.
- Sensitive route decision log covering secrets, failed requests, runtime assets, exports, PDFs/uploads, and FHIR/EHR import.
- Regression check that catches unclassified route or listener additions.
- Updated README language that distinguishes local integration API from internal/debug routes.

## Touched Layers

- server
- client/docs
- desktop
- release ops

## Quality Gates

- Manual verify: manifest covers `src/server/serverMain.ts`, `src/appServerMain.ts`, `src/desktop/index.ts`, `src/server/routes/*`, nested route modules, `ApiProxyRoutes.ts`, `apiRouteClassification.ts`, and cron-mounted Elysia plugins.
- Manual verify: browser, desktop, local LLM tools, agents, and scripts can use documented supported local API routes through loopback.
- Manual verify: unsupported internal routes are marked internal, gated, moved, or excluded from public docs.
- Manual verify: supported OSS listeners bind only to loopback by default, or every broader bind is explicitly documented and approved.
- `bun run lint` after route or docs cleanup that changes source files.
- Targeted `bun test` for changed route, proxy, or route-manifest files.
- `bun run build` if client route consumers or public API docs UI changes are made.
- Desktop verification with `bun run desktop:build` or targeted desktop runtime tests if desktop API wiring changes.

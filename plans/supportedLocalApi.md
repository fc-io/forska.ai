# Supported Local API Plan

Date: 2026-05-12

Status: draft decision framework. This plan defines the API surface that local apps, LLM tools, agents, and scripts should be able to call when Forska is running on the same machine.

Implementation timing: implement this plan last in the open-source cleanup sequence. Use it now to guide route decisions, but do not add the manifest, public local API docs, CORS expansion, or regression guardrails until after route cleanup, sensitive-route decisions, public-seed allowlist/denylist work, and private-material removal are settled.

## Goal

- Keep Forska usable as a local API server for the Forska UI, the desktop app, locally installed LLM apps, local agents, and user scripts.
- Keep the default network posture local: bind API and app listeners to loopback by default.
- Make the supported local API explicit so internal worker, repair, database, and debug routes do not accidentally become stable integration APIs.
- Separate same-machine loopback access from browser-origin access. Native apps, CLIs, agents, and scripts can call loopback directly; browser-based local tools also need an explicit CORS decision.
- Publish a clear local API contract before opening the repo.

## Plain Language Rule

Local apps should be able to call Forska through `http://127.0.0.1:<api-port>`.

That does not mean every mounted route is a supported API. It means the documented local API is available to local clients, while internal runtime routes stay clearly marked as internal, debug, or unsupported.

For browser-based local clients, loopback availability is not enough. The current server uses an explicit CORS allowlist for Forska app origins and desktop origins, so third-party browser tools are supported only if their origin policy is deliberately added and documented.

## Non-Goals

- Do not add hosted multi-tenant behavior.
- Do not add admin accounts or user auth for the open-source local app unless separately decided.
- Do not expose the API to the LAN or internet by default.
- Do not broaden CORS or listener binding as a side effect of documenting the local API.
- Do not support third-party browser origins by default. Native apps, CLIs, agents, and scripts can use loopback directly; browser tools need a separate explicit allowed-origin decision later.
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

The manifest should classify method and path patterns, not only route files. Several route files mix supported product behavior, diagnostics, sensitive data access, internal worker operations, and maintenance controls.

`apiRouteClassification.ts` is the current owner/proxy routing classifier. It is useful input, but its categories are not the public support categories and should not become the supported local API manifest by renaming alone.

## Starting Route Decisions

These are initial decisions, not final documentation. Each row still needs a route-level review before release.

| Route Group | Starting Decision | Notes |
| --- | --- | --- |
| `src/appServerMain.ts` `/api/*` proxy | Keep | Local apps can call the API server directly; the app server proxy remains useful for the browser app. The proxy is transport, not a separate support contract. |
| `src/desktop/index.ts` API bridge | Keep | Desktop forwards only `/api/` paths to the configured API origin. The bridge must not expand the supported surface beyond the API manifest. |
| `runtimeReadyRoutes.ts` | Local bootstrap plus diagnostics API | Keep `GET /api/runtime/ready` as the small readiness/bootstrap route used by desktop and split runtime; keep `GET /api/runtime/state` as diagnostic status. |
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
| `DuckdbOwnerConnectionsRoutes.ts` `GET /api/duckdb_owner_connections` | Local diagnostics API | Useful split-runtime status. Document as diagnostic only, not as a stable product integration dependency. |
| `DuckdbOwnerConnectionsRoutes.ts` `POST /api/duckdb_owner_connections/heartbeat` | Internal runtime API | Runtime heartbeat/write path for server coordination. Do not document as a stable local integration API. |
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
| `ApiProxyRoutes.ts` | Internal runtime API | Keep as implementation detail. The supported local API should not depend on callers knowing proxy internals or DuckDB-owner routing rules. |
| `apiRouteClassification.ts` | Internal runtime classifier | Keep as proxy/owner-routing input. Do not reuse these categories as the public API support taxonomy. |
| `/__duckdb-owner-rpc/**` | Internal runtime API | Never document as a local integration API. |

## Implementation Readiness

This plan is ready to guide route review, but not ready to drive broad route cleanup directly.

Implement it last because the manifest and public docs should describe the final cleaned API surface, not the current mixed route surface.

Ready now:

- Use the categories above while reviewing route groups.
- Use the high-risk route list to decide what must be removed, gated, redacted, or excluded from the public seed.
- Keep loopback access as the intended integration model for native local apps, CLIs, agents, and scripts.

Not ready until later:

- Do not publish the supported local API docs yet.
- Do not treat the starting route decisions as final stable API promises.
- Do not broaden CORS for third-party browser tools yet.
- Do not add route-regression checks until the route surface has been cleaned enough that the manifest represents the intended public shape.

When this plan is implemented, the first implementation step within this plan should be the manifest. That does not make this plan early work; it means the manifest is the first task after this plan becomes the final cleanup workstream.

## Manifest Shape

Suggested location: `src/server/routes/supportedLocalApiManifest.ts`.

Suggested test location: `src/server/routes/supportedLocalApiManifest.test.ts`.

Each manifest row should classify one method/path pattern, not only a route file.

| Field | Meaning |
| --- | --- |
| `method` | HTTP method, or a narrow method list if the same path has identical support semantics. |
| `path` | Elysia route pattern, including dynamic params such as `:id`. |
| `category` | One of the API categories in this plan. |
| `routeModule` | Owning route module or nested route module. |
| `nativeLoopback` | Whether native apps, CLIs, agents, and scripts on the same machine may call it. |
| `browserApp` | Whether the Forska browser UI may call it. |
| `desktop` | Whether the desktop app or desktop bridge may call it. |
| `thirdPartyBrowser` | Whether third-party browser origins are intentionally supported. Default should be `false`. |
| `ownerProxy` | Whether the route is proxied to the DuckDB owner or mirrored under owner-private RPC. |
| `sensitivity` | Short note for secrets, files, exports, failed requests, PDFs, patient data, provider metadata, or local machine telemetry. |
| `notes` | Short release/support note. |

Initial category type:

```ts
export type SupportedLocalApiCategory =
  | 'supported-local-api'
  | 'local-diagnostics-api'
  | 'sensitive-local-api'
  | 'internal-runtime-api'
  | 'maintenance-debug-api'
  | 'remove-from-public-seed'
```

Initial row shape:

```ts
export type SupportedLocalApiManifestRow = {
  browserApp: boolean
  category: SupportedLocalApiCategory
  desktop: boolean
  method: string
  nativeLoopback: boolean
  notes: string
  ownerProxy: 'never' | 'maybe' | 'yes'
  path: string
  routeModule: string
  sensitivity: string | null
  thirdPartyBrowser: boolean
}
```

## Regression Tests

Add tests only after the route cleanup reaches its final intended public shape.

First tests:

- Every manifest row has a valid category.
- Every manifest row has explicit caller flags for native loopback, Forska browser app, desktop, and third-party browser use.
- `thirdPartyBrowser` defaults to `false` unless the route has a documented CORS decision.
- Sensitive categories require a non-empty `sensitivity` note.
- Internal runtime and maintenance/debug categories are not marked as third-party browser supported.

Later tests:

- Every mounted method/path pattern is present in the manifest.
- Every route mounted under `/__duckdb-owner-rpc/**` is classified as internal runtime API.
- CORS-related tests match `allowedOrigins` in `src/server/serverMain.ts`.

## What Needs To Change

| # | Change | Target State |
| --- | --- | --- |
| 1 | Create a supported local API manifest | One reviewed source of truth lists each method/path pattern, route module, support category, sensitivity note, and owner/proxy behavior. |
| 2 | Split route groups conceptually before release | Product routes, diagnostics, internal runtime routes, and debug routes are not all treated as the same API class. |
| 3 | Document local integration behavior | Local apps can call `127.0.0.1:<api-port>`; the API is not network-exposed by default. |
| 4 | Decide browser-client CORS support | Native same-machine clients are supported through loopback; browser-based local tools have an explicit allowed-origin policy or are documented as unsupported. |
| 5 | Mark internal routes as unsupported | Worker claims, owner RPC, proxy internals, repair flows, and database snapshot routes are not stable integration APIs. |
| 6 | Review sensitive routes | Provider secrets, failed request details, runtime assets, exports, PDFs, uploads, and FHIR/EHR import receive explicit keep/gate/remove decisions. |
| 7 | Add regression checks | Unexpected new listeners, routes, owner/proxy classifications, or CORS exposure changes fail review until classified. |
| 8 | Update README and public docs | Docs describe the supported local API and stop implying that all mounted routes are public product API. |

## Suggested Implementation Order

This is the implementation order inside this plan, but this whole plan should be implemented last in the broader open-source cleanup sequence.

1. Confirm route cleanup and sensitive-route decisions are complete.
2. Build the first manifest from `src/server/serverMain.ts`, `src/appServerMain.ts`, `src/desktop/index.ts`, `src/server/routes/*`, nested route modules, `ApiProxyRoutes.ts`, `apiRouteClassification.ts`, and cron-mounted Elysia plugins.
3. Mark every method/path pattern as `supported local API`, `local diagnostics API`, `sensitive local API`, `internal runtime API`, `maintenance/debug API`, or `remove from public seed`.
4. Record whether each documented route is callable from native/CLI loopback clients, the Forska browser app, the desktop bridge, and any intentionally supported third-party browser origins.
5. Add route-manifest regression tests that fail when a mounted method/path pattern is missing from the manifest.
6. Update public docs with the supported local API rules and examples for local LLM tools/scripts, including the browser CORS limitation.
7. Update the open-source release seed allowlist so internal planning files and unsupported debug/operator docs do not enter the public seed.

## Example Public Wording

Forska runs a local API server on loopback by default. Native apps, agents, CLIs, and scripts on the same machine can call the documented API at `http://127.0.0.1:<api-port>`. Browser-based tools are also subject to the documented CORS policy. Forska does not expose the API to other machines by default. Routes not listed in the supported local API documentation are internal implementation details and may change without notice.

## Deliverables

- Supported local API manifest with every mounted method/path pattern classified.
- Local browser-client/CORS decision that matches the server allowlist and public docs.
- Public local API documentation for local LLM apps, agents, scripts, browser app, and desktop app.
- Sensitive route decision log covering secrets, failed requests, runtime assets, exports, PDFs/uploads, and FHIR/EHR import.
- Regression check that catches unclassified route, listener, owner/proxy, or CORS exposure additions.
- Updated README language that distinguishes local integration API from internal/debug routes.

## Touched Layers

- server
- client/docs
- desktop
- release ops

## Quality Gates

- Manual verify: manifest covers method/path patterns from `src/server/serverMain.ts`, `src/appServerMain.ts`, `src/desktop/index.ts`, `src/server/routes/*`, nested route modules, `ApiProxyRoutes.ts`, `apiRouteClassification.ts`, and cron-mounted Elysia plugins.
- Manual verify: the Forska browser app, desktop app, local LLM tools, agents, and scripts can use documented supported local API routes through loopback.
- Manual verify: browser-origin CORS claims match `allowedOrigins` in `src/server/serverMain.ts`; if third-party browser tools are supported, verify the expected preflight/response headers.
- Manual verify: unsupported internal routes are marked internal, gated, moved, or excluded from public docs.
- Manual verify: supported OSS listeners bind only to loopback by default, or every broader bind is explicitly documented and approved.
- `bun run lint` after route or docs cleanup that changes source files.
- Targeted `bun test` for changed route, proxy, or route-manifest files.
- `bun run build` if client route consumers or public API docs UI changes are made.
- Desktop verification with `bun run desktop:build` or targeted desktop runtime tests if desktop API wiring changes.

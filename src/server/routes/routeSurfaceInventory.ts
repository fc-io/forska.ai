import {runtimePrivateApiPrefix} from '../utils/runtimePrivateApi.ts'

export type RouteSurfaceCategory =
  | 'internal-runtime-api'
  | 'local-diagnostics-api'
  | 'maintenance-debug-api'
  | 'remove-before-release'
  | 'sensitive-local-api'
  | 'supported-local-api'

export type RouteSurfaceProxyClassification =
  | 'duckdb-owner-diagnostics'
  | 'local-bootstrap'
  | 'owner-dependent'
  | 'ownerless-readable-diagnostics'

export type RouteSurfaceRoute = {
  category: RouteSurfaceCategory
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'
  path: string
  proxyClassification: RouteSurfaceProxyClassification
  releaseDecision: string
  routeModule: string
  sensitivity: string | null
}

export type RouteSurfaceEntrypoint = {
  category: RouteSurfaceCategory
  defaultBind: 'loopback' | 'process-local'
  releaseDecision: string
  source: string
  surface: string
}

type RouteSurfaceRouteDefaults = Omit<RouteSurfaceRoute, 'method' | 'path'>
type RoutePair = readonly [RouteSurfaceRoute['method'], string]

const supportedProductDecision = 'Keep as supported local product API on loopback.'
const sensitiveProductDecision = 'Keep local-only after public-release sensitivity review.'
const diagnosticsDecision =
  'Gated on the public API by default. Expose only with FORSKA_EXPOSE_LOCAL_OPERATOR_API=true for local diagnostics.'
const internalDecision = 'Gated on the public API by default. Keep internal/local-only and omit from public docs.'
const maintenanceDecision =
  'Gated on the public API by default. Keep developer/operator-only or remove before public release.'
const removeBeforeReleaseDecision =
  'Gated on the public API by default. Remove before release unless explicitly justified.'
const settingsDiagnosticsDecision = 'Keep as read-only Settings diagnostics on the local loopback API.'

const routeGroup = (defaults: RouteSurfaceRouteDefaults, routes: readonly RoutePair[]): RouteSurfaceRoute[] => {
  return routes.map(([method, path]) => {
    return {...defaults, method, path}
  })
}

const ownerDependentProduct = (routeModule: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'supported-local-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: supportedProductDecision,
      routeModule,
      sensitivity: null,
    },
    routes,
  )
}

const ownerDependentSensitive = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: sensitiveProductDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

const ownerDependentMaintenance = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'maintenance-debug-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: maintenanceDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

const ownerDependentDiagnostics = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'local-diagnostics-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: diagnosticsDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

const ownerDependentSettingsDiagnostics = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: settingsDiagnosticsDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

const ownerlessDiagnostics = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'local-diagnostics-api',
      proxyClassification: 'ownerless-readable-diagnostics',
      releaseDecision: diagnosticsDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

const ownerlessSettingsDiagnostics = (routeModule: string, sensitivity: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'ownerless-readable-diagnostics',
      releaseDecision: settingsDiagnosticsDecision,
      routeModule,
      sensitivity,
    },
    routes,
  )
}

const internalRuntime = (routeModule: string, routes: readonly RoutePair[]) => {
  return routeGroup(
    {
      category: 'internal-runtime-api',
      proxyClassification: 'owner-dependent',
      releaseDecision: internalDecision,
      routeModule,
      sensitivity: 'Runtime coordination and worker state.',
    },
    routes,
  )
}

export const routeSurfaceEntrypoints: RouteSurfaceEntrypoint[] = [
  {
    category: 'supported-local-api',
    defaultBind: 'loopback',
    releaseDecision: 'Keep local-only. Mounts mixed product, diagnostics, internal runtime, and debug routes.',
    source: 'src/server/serverMain.ts',
    surface: 'API server listener on 127.0.0.1:${API_SERVER_PORT}',
  },
  {
    category: 'supported-local-api',
    defaultBind: 'loopback',
    releaseDecision: 'Keep local-only. Proxies /api and /api/* to the API server for the browser app.',
    source: 'src/appServerMain.ts',
    surface: 'Static app server listener on 127.0.0.1:${APP_SERVER_PORT}',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'process-local',
    releaseDecision: 'Keep as desktop-local bridge only. Backend route decisions still apply.',
    source: 'src/desktop/index.ts',
    surface: 'Desktop API bridge forwarding /api/* to the configured loopback API origin',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'loopback',
    releaseDecision: 'Keep as split-runtime implementation detail. Unknown /api/* remains fail-closed.',
    source: 'src/server/routes/ApiProxyRoutes.ts',
    surface: 'DuckDB-owner proxy middleware for owner-dependent API routes',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'loopback',
    releaseDecision:
      'Keep before the owner proxy. Blocks public admin, debug, database, status, internal runtime, and remove-before-release routes by default.',
    source: 'src/server/routes/publicRouteSurfaceGate.ts',
    surface: 'Public local API route-surface gate',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'loopback',
    releaseDecision:
      'Keep internal only. Mirrors product routes under /__duckdb-owner-rpc when this process owns DuckDB.',
    source: 'src/server/serverMain.ts',
    surface: '/__duckdb-owner-rpc/** owner-private route mirror',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'process-local',
    releaseDecision: 'Keep role-gated. Jobs can call local/external runtimes and are not public HTTP API.',
    source: 'src/server/cron/*',
    surface: 'Maintenance and judging cron plugins mounted by server role',
  },
]

export const routeSurfaceRoutes: RouteSurfaceRoute[] = [
  ...routeGroup(
    {
      category: 'supported-local-api',
      proxyClassification: 'local-bootstrap',
      releaseDecision: 'Keep local-only as readiness/bootstrap API.',
      routeModule: 'runtimeReadyRoutes.ts',
      sensitivity: null,
    },
    [['GET', '/api/runtime/ready']],
  ),
  ...ownerlessSettingsDiagnostics(
    'runtimeReadyRoutes.ts',
    'Process id, server role, runtime version, and Bun HTTP cap.',
    [['GET', '/api/runtime/state']],
  ),
  ...routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'duckdb-owner-diagnostics',
      releaseDecision: sensitiveProductDecision,
      routeModule: 'DuckdbOwnerConnectionsRoutes.ts',
      sensitivity: 'DuckDB owner, follower, host, process, and mart throughput metadata.',
    },
    [['GET', '/api/duckdb_owner_connections']],
  ),
  ...routeGroup(
    {
      category: 'internal-runtime-api',
      proxyClassification: 'duckdb-owner-diagnostics',
      releaseDecision: internalDecision,
      routeModule: 'DuckdbOwnerConnectionsRoutes.ts',
      sensitivity: 'DuckDB owner heartbeat and process metadata.',
    },
    [['POST', '/api/duckdb_owner_connections/heartbeat']],
  ),
  ...ownerlessDiagnostics(
    'JudgmentDispatchTelemetryRoutes.ts',
    'Local judgment dispatch and provider capacity telemetry.',
    [
      ['GET', '/api/admin/judgment-dispatch-runtime/:jobId'],
      ['GET', `${runtimePrivateApiPrefix}/api/admin/judgment-dispatch-runtime/:jobId`],
    ],
  ),
  ...ownerDependentMaintenance(
    'AdminInvestigateRoutes.ts',
    'Admin diagnostics, rebuild controls, and prompt/judgment cleanup.',
    [
      ['GET', '/api/admin/duckdb-append-metrics'],
      ['GET', '/api/admin/project-mart-large-rebuild-status'],
      ['POST', '/api/admin/project-mart-large-rebuild-run'],
      ['POST', '/api/admin/project-mart-large-rebuild-pause'],
      ['POST', '/api/admin/project-mart-large-rebuild-resume'],
      ['POST', '/api/admin/project-mart-large-rebuild-note'],
      ['POST', '/api/admin/project-mart-dirty-materialization-requeue'],
      ['GET', '/api/admin/list-prompts-with-types'],
      ['POST', '/api/admin/delete-unexpected-answers'],
      ['POST', '/api/admin/auto-sync-all-unexpected-answers'],
      ['GET', '/api/admin/auto-sync-all-progress'],
      ['GET', '/api/admin/investigate-unexpected-answers'],
    ],
  ),
  ...ownerDependentSensitive('AdminInvestigateRoutes.ts', 'Destructive local database reset for the settings page.', [
    ['POST', '/api/admin/clear-databases'],
  ]),
  ...ownerDependentSettingsDiagnostics(
    'AdminInvestigateRoutes.ts',
    'DuckDB path, process memory, and maintenance runtime state.',
    [['GET', '/api/admin/maintenance-runtime-diagnostics']],
  ),
  ...ownerlessSettingsDiagnostics('AdminInvestigateRoutes.ts', 'Local worker runtime diagnostics.', [
    ['GET', '/api/admin/worker-runtime-diagnostics'],
  ]),
  ...ownerDependentProduct('ComparisonProjectsRoutes.ts', [
    ['GET', '/api/comparison-projects'],
    ['GET', '/api/comparison-projects/archived'],
    ['GET', '/api/comparison-projects/sources'],
    ['GET', '/api/comparison-projects/conflict-resolution-import-sources'],
    ['POST', '/api/comparison-projects/conflict-resolution-import-preview'],
    ['POST', '/api/comparison-projects/from-project'],
    ['GET', '/api/comparison-projects/:id/edit'],
    ['GET', '/api/comparison-projects/:id/stats'],
    ['GET', '/api/comparison-projects/:id'],
    ['POST', '/api/comparison-projects/:id/judgments'],
    ['POST', '/api/comparison-projects/:id/judgments/count'],
    ['POST', '/api/comparison-projects/:id/conflict-resolution'],
    ['POST', '/api/comparison-projects/:id/conflict-resolution/reset'],
    ['POST', '/api/comparison-projects/:id/conflict-resolutions/export'],
    ['POST', '/api/comparison-projects/:id/conflict-resolutions/import/analyze'],
    ['POST', '/api/comparison-projects/:id/conflict-resolutions/import/commit'],
    ['POST', '/api/comparison-projects/:id/export'],
    ['POST', '/api/comparison-projects'],
    ['PATCH', '/api/comparison-projects/:id'],
    ['DELETE', '/api/comparison-projects/:id'],
    ['POST', '/api/comparison-projects/:id/unarchive'],
  ]),
  ...ownerDependentProduct('JudgmentsJobsRoutes.ts', [
    ['POST', '/api/judgmentsjobs'],
    ['GET', '/api/judgmentsjobs'],
    ['GET', '/api/judgmentsjobs/:id'],
    ['GET', '/api/judgmentsjobs-unassessed-count'],
    ['GET', '/api/judgmentsjobs-unassessed-articles'],
    ['GET', '/api/judgmentsjobs-total-token-usage'],
    ['PATCH', '/api/judgmentsjobs/:id'],
    ['DELETE', '/api/judgmentsjobs/:id'],
  ]),
  ...ownerlessDiagnostics('JudgmentsJobsRoutes.ts', 'Judgment job status, health, and provider telemetry.', [
    ['GET', '/api/judgmentsjobs/:id/health'],
    ['GET', '/api/judgmentsjobs-health'],
  ]),
  ...routeGroup(
    {
      category: 'sensitive-local-api',
      proxyClassification: 'ownerless-readable-diagnostics',
      releaseDecision: sensitiveProductDecision,
      routeModule: 'JudgmentsJobsRoutes.ts',
      sensitivity: 'Judgment job provider telemetry history and runtime utilization metadata.',
    },
    [['GET', '/api/judgmentsjobs-provider-telemetry-history']],
  ),
  ...internalRuntime('JudgmentsJobsRoutes.ts', [
    ['POST', '/api/judgmentsjobs/:id/claims'],
    ['POST', '/api/judgmentsjobs/:id/claim'],
    ['POST', '/api/judgmentsjobs/:id/completions'],
    ['POST', '/api/judgmentsjobs/:id/complete'],
    ['POST', '/api/judgmentsjobs-worker-heartbeats'],
    ['GET', '/api/judgmentsjobs-running'],
    ['GET', '/api/judgmentsjobs/:id/runtime'],
    ['GET', '/api/judgmentsjobs/execution-snapshots/:executionSnapshotId'],
    ['GET', '/api/judgmentsjobs-execution-snapshots/:executionSnapshotId'],
  ]),
  ...ownerDependentMaintenance(
    'JudgmentsJobsRoutes.ts',
    'Judgment job repair, drain, quarantine, and cleanup controls.',
    [
      ['POST', '/api/judgmentsjobs/:id/start-clean'],
      ['POST', '/api/judgmentsjobs/:id/preflight'],
      ['POST', '/api/judgmentsjobs/:id/drain'],
      ['POST', '/api/judgmentsjobs/:id/checkpoint'],
      ['POST', '/api/judgmentsjobs/:id/quarantine'],
      ['POST', '/api/judgmentsjobs/:id/unquarantine'],
      ['POST', '/api/judgmentsjobs/:id/repair'],
      ['POST', '/api/judgmentsjobs/:id/repair-orphaned-queue'],
    ],
  ),
  ...ownerDependentProduct('ArticlesRoutes.ts', [
    ['GET', '/api/articles/latest'],
    ['GET', '/api/articles/search'],
    ['GET', '/api/articles/:id'],
    ['GET', '/api/articles/pdf-fetch-jobs/:jobId'],
  ]),
  ...ownerDependentDiagnostics('ArticlesRoutes.ts', 'Article conversion and PDF-fetch status.', [
    ['GET', '/api/articles/conversion-stats'],
  ]),
  ...ownerDependentSensitive(
    'ArticlesRoutes.ts',
    'Article records, PDFs, external fetches, and destructive article operations.',
    [
      ['POST', '/api/articles/pdf-fetch-bulk'],
      ['POST', '/api/articles/pdf-fetch-by-filter'],
      ['POST', '/api/articles/pdf-fetch-by-project'],
      ['POST', '/api/articles/batch-upsert'],
      ['DELETE', '/api/articles/:id'],
    ],
  ),
  ...ownerDependentMaintenance('ArticlesRoutes.ts', 'Article conversion and PDF fetch reset controls.', [
    ['POST', '/api/articles/conversion-reset'],
    ['POST', '/api/articles/pdf-fetch-reset'],
  ]),
  ...ownerDependentSensitive(
    'ArticleAdminRoutes.ts',
    'Local PDFs, uploaded files, fetched full text, and conversion state.',
    [
      ['GET', '/api/articles/:id/admin-info'],
      ['POST', '/api/articles/:id/fetch-pdf'],
      ['POST', '/api/articles/:id/upload-pdf'],
      ['POST', '/api/articles/:id/convert-pdf'],
    ],
  ),
  ...ownerDependentProduct('HumanAssessmentRoutes.ts', [
    ['GET', '/api/humanassessment/overview'],
    ['GET', '/api/humanassessment/overview-both-projects'],
    ['POST', '/api/humanassessment/init'],
    ['POST', '/api/humanassessment/submit'],
  ]),
  ...ownerDependentProduct('ModelsRoutes.ts', [
    ['GET', '/api/models'],
    ['GET', '/api/models/stored'],
    ['POST', '/api/models/ensure'],
  ]),
  ...ownerDependentSensitive('ModelsRoutes.ts', 'Codex authentication state and login flow.', [
    ['GET', '/api/models/codex/status'],
    ['POST', '/api/models/codex/login'],
    ['GET', '/api/models/codex/login/:jobId'],
  ]),
  ...ownerDependentDiagnostics('ModelsRoutes.ts', 'Local GPU/runtime capacity details.', [
    ['GET', '/api/models/gpu-info'],
  ]),
  ...ownerDependentSensitive(
    'ProviderConnectionsRoutes.ts',
    'Provider credentials, secret references, auth flow, and model discovery metadata.',
    [
      ['POST', '/api/provider-auth/:providerKind/begin'],
      ['POST', '/api/provider-auth/:providerKind/finish'],
      ['GET', '/api/provider-connections'],
      ['POST', '/api/provider-connections'],
      ['PATCH', '/api/provider-connections/:id'],
      ['DELETE', '/api/provider-connections/:id'],
      ['POST', '/api/provider-connections/:id/test'],
      ['GET', '/api/provider-connections/:id/discovered-models'],
    ],
  ),
  ...ownerDependentProduct('ProviderModelsRoutes.ts', [
    ['POST', '/api/provider-connections/:id/sync-models'],
    ['POST', '/api/provider-connections/:id/models'],
    ['PATCH', '/api/models/:id'],
  ]),
  ...internalRuntime('providerAdmissionLeaseRoutes.ts', [
    ['POST', '/api/provideradmissionleases/acquire'],
    ['POST', '/api/provideradmissionleases/heartbeat'],
    ['POST', '/api/provideradmissionleases/release'],
    ['POST', '/api/provideradmissionleases/release-result'],
    ['POST', '/api/provideradmissionleases/expire'],
    ['POST', '/api/provideradmissionleases/reconcile'],
    ['POST', '/api/provider-admission-leases/acquire'],
    ['POST', '/api/provider-admission-leases/heartbeat'],
    ['POST', '/api/provider-admission-leases/release'],
    ['POST', '/api/provider-admission-leases/release-result'],
    ['POST', '/api/provider-admission-leases/expire'],
    ['POST', '/api/provider-admission-leases/reconcile'],
  ]),
  ...ownerDependentSensitive(
    'projectTransferRoutes.ts',
    'Project export/import packages, uploaded archives, and local runtime assets.',
    [
      ['GET', '/api/projects/:id/export-project'],
      ['POST', '/api/projects/:id/export-project'],
      ['GET', '/api/projects/export/:exportId'],
      ['GET', '/api/projects/export/:exportId/download'],
      ['POST', '/api/projects/import/sessions'],
      ['PUT', '/api/projects/import/:sessionId/upload'],
      ['POST', '/api/projects/import/:sessionId/analyze'],
      ['GET', '/api/projects/import/:sessionId'],
      ['POST', '/api/projects/import/:sessionId/resolve-dependencies'],
      ['POST', '/api/projects/import/:sessionId/commit'],
      ['DELETE', '/api/projects/import/:sessionId'],
    ],
  ),
  ...ownerDependentProduct('ProjectsRoutes.ts', [
    ['POST', '/api/articlesreviews'],
    ['POST', '/api/articlesreviewscount'],
    ['POST', '/api/articlesreviewsboth'],
    ['POST', '/api/articlesreviewshuman'],
    ['POST', '/api/articlesreviewsunassessed'],
    ['GET', '/api/articlesreviewsfilters'],
    ['GET', '/api/articlesreviewshumanfilters'],
    ['POST', '/api/projectsreview'],
    ['POST', '/api/projectsreviewswarnings'],
    ['GET', '/api/projects-without-jobs'],
    ['GET', '/api/projects'],
    ['GET', '/api/projects/archived'],
    ['GET', '/api/projects/:id/access'],
    ['GET', '/api/projects/:id'],
    ['GET', '/api/projects/:id/prompts/:promptId/preview'],
    ['POST', '/api/projects'],
    ['PATCH', '/api/projects/:id'],
    ['PATCH', '/api/projects/:id/edit'],
    ['DELETE', '/api/projects/:id'],
    ['POST', '/api/projects/:id/unarchive'],
    ['POST', '/api/projects/:id/clone'],
  ]),
  ...ownerDependentMaintenance('ProjectsRoutes.ts', 'Archived project deletion and cleanup.', [
    ['POST', '/api/projects/delete-archived'],
  ]),
  ...ownerDependentSensitive('ProjectExportRoutes.ts', 'Project article, judgment, prompt, and metadata exports.', [
    ['POST', '/api/projects/:id/export'],
    ['GET', '/api/projects/:id/export/:jobId'],
    ['GET', '/api/projects/:id/export/:jobId/download'],
    ['POST', '/api/projects/:id/export-prompts'],
  ]),
  ...ownerDependentProduct('ProjectsAddArticlesRoutes.ts', [
    ['POST', '/api/projects/add_articles_by_filter'],
    ['POST', '/api/projects/add_articles_by_ids'],
  ]),
  ...ownerDependentProduct('ProjectArticlesRoutes.ts', [
    ['GET', '/api/projects/:id/articles'],
    ['POST', '/api/projects/:id/articles'],
    ['DELETE', '/api/projects/:id/articles/:articleId'],
  ]),
  ...ownerDependentProduct('PromptsRoutes.ts', [
    ['GET', '/api/prompts'],
    ['GET', '/api/prompts/archived'],
    ['PATCH', '/api/prompts/:id'],
  ]),
  ...ownerDependentMaintenance(
    'PromptsRoutes.ts',
    'Prompt deduplication, hash regeneration, merge, delete, and invalid judgment cleanup.',
    [
      ['GET', '/api/prompts/duplicates'],
      ['POST', '/api/prompts/regenerate-hashes'],
      ['DELETE', '/api/prompts/:id'],
      ['GET', '/api/prompts/orphans'],
      ['POST', '/api/prompts/merge'],
      ['GET', '/api/prompts/invalid-judgments'],
      ['POST', '/api/prompts/delete-invalid-judgments'],
    ],
  ),
  ...ownerDependentSensitive(
    'RuntimeAssetsRoutes.ts',
    'Local persisted runtime asset files under the reviewed asset scope.',
    [['GET', '/api/runtime-asset']],
  ),
  ...ownerDependentProduct('ImportRoutes.ts', [['GET', '/api/import-routes']]),
  ...ownerDependentProduct('DataSourcesRoutes.ts', [
    ['GET', '/api/datasources'],
    ['GET', '/api/datasources/archived'],
    ['GET', '/api/datasources/:id'],
    ['POST', '/api/datasources'],
    ['PATCH', '/api/datasources/:id'],
    ['DELETE', '/api/datasources/:id'],
  ]),
  ...ownerDependentSensitive(
    'DataSourcesImportRoutes.ts',
    'Uploaded files, parsed source data, and external literature API imports.',
    [
      ['POST', '/api/datasources/import/covidence-analyze'],
      ['POST', '/api/datasources/import/covidence-create'],
      ['POST', '/api/datasources/import/covidence'],
      ['POST', '/api/datasources/import/arxiv'],
      ['POST', '/api/datasources/import/biorxiv'],
      ['POST', '/api/datasources/import/medrxiv'],
      ['POST', '/api/datasources/import/pubmed'],
      ['POST', '/api/datasources/import/europe-pmc-ppr'],
      ['POST', '/api/datasources/import/structured-file-analyze'],
      ['POST', '/api/datasources/import/structured-file-create'],
      ['POST', '/api/datasources/import/structured-file'],
    ],
  ),
  ...routeGroup(
    {
      category: 'remove-before-release',
      proxyClassification: 'owner-dependent',
      releaseDecision: removeBeforeReleaseDecision,
      routeModule: 'DataSourcesImportRoutes.ts',
      sensitivity: 'FHIR/EHR patient records and potentially PHI-bearing local assets.',
    },
    [['POST', '/api/datasources/import/fhir-ehr-patients']],
  ),
  ...ownerDependentMaintenance('DuckdbStudioRoutes.ts', 'DuckDB snapshot creation and local database file paths.', [
    ['POST', '/api/duckdbStudioSnapshots'],
  ]),
  ...ownerDependentDiagnostics('TokensRoutes.ts', 'Token usage ingestion includes provider request metadata.', [
    ['POST', '/api/tokens/usage'],
  ]),
  ...ownerDependentSensitive('TokensRoutes.ts', 'Token usage aggregates and provider request metadata.', [
    ['GET', '/api/tokens/largest-per-request'],
    ['GET', '/api/tokens/largest-completion-per-request'],
    ['GET', '/api/tokens'],
    ['POST', '/api/tokens/timeline'],
    ['POST', '/api/tokens/timelineAllJobs'],
    ['POST', '/api/tokens/timelineStats'],
    ['POST', '/api/tokens/timelineAllJobsStats'],
  ]),
  ...ownerDependentSensitive(
    'TokensRoutes.ts',
    'Failed request details can include prompts, article text, provider metadata, and errors.',
    [
      ['POST', '/api/tokens/failed-requests'],
      ['GET', '/api/tokens/failed-requests/:id'],
    ],
  ),
  ...ownerDependentSensitive(
    'UsersRoutes.ts',
    'Single-user settings can include local paths and contact email configuration.',
    [
      ['GET', '/api/users'],
      ['PATCH', '/api/users'],
    ],
  ),
  ...ownerDependentProduct('LlmStatusRoutes.ts', [['GET', '/api/llmstatus']]),
  ...ownerDependentDiagnostics('NvidiaSmiRoutes.ts', 'Local GPU telemetry.', [['GET', '/api/nvidiasmi']]),
  ...ownerDependentProduct('SubprojectsRoutes.ts', [
    ['GET', '/api/subprojects/sources'],
    ['POST', '/api/subprojects'],
  ]),
]

const normalizePathname = (pathname: string) => {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

const escapeRegex = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const getRoutePatternRegex = (path: string) => {
  const segments = path.split('/').map((segment) => {
    return segment.startsWith(':') ? '[^/]+' : escapeRegex(segment)
  })

  return new RegExp(`^${segments.join('/')}$`)
}

const routeSurfaceRouteMatchers = routeSurfaceRoutes.map((route) => {
  return {...route, regex: getRoutePatternRegex(route.path)}
})

export const getRouteSurfaceRouteKey = ({method, path}: Pick<RouteSurfaceRoute, 'method' | 'path'>) => {
  return `${method.toUpperCase()} ${normalizePathname(path)}`
}

export const findRouteSurfaceRoute = ({method, pathname}: {method: string; pathname: string}) => {
  const normalizedMethod = method.toUpperCase()
  const normalizedPathname = normalizePathname(pathname)
  const match = routeSurfaceRouteMatchers.find((route) => {
    return route.method === normalizedMethod && route.regex.test(normalizedPathname)
  })

  return match ?? null
}

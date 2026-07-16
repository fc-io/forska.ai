import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const workspaceRoot = process.cwd()
const srcRoot = join(workspaceRoot, 'src')
const routesRoot = join(workspaceRoot, 'src/server/routes')
const serverMainPath = join(workspaceRoot, 'src/server/serverMain.ts')

const getSourceFiles = (directory: string): string[] => {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const entryPath = join(directory, entry.name)

    return entry.isDirectory() ? getSourceFiles(entryPath) : entryPath
  })
}

const getRouteSourceFiles = () => {
  return getSourceFiles(routesRoot).filter((filePath) => {
    return filePath.endsWith('.ts') && !filePath.endsWith('.test.ts')
  })
}

const getProductionSourceFiles = () => {
  return getSourceFiles(srcRoot).filter((filePath) => {
    return filePath.endsWith('.ts') && !filePath.endsWith('.test.ts')
  })
}

const getRelativeWorkspacePath = (filePath: string) => {
  return relative(workspaceRoot, filePath)
}

const forbiddenDuckdbImportPatterns = [
  {label: '@duckdb/node-api', pattern: /from ['"]@duckdb\/node-api['"]/u},
  {label: 'generic duckdbService', pattern: /from ['"][^'"]*\/utils\/duckdbService(?:\.ts)?['"]/u},
  {label: 'appDatabaseService', pattern: /from ['"][^'"]*\/services\/appDatabaseService(?:\.ts)?['"]/u},
  {label: 'appReadOnlyDatabaseService', pattern: /from ['"][^'"]*\/services\/appReadOnlyDatabaseService(?:\.ts)?['"]/u},
  {label: 'readOnlyDuckdbService', pattern: /from ['"][^'"]*\/services\/readOnlyDuckdbService(?:\.ts)?['"]/u},
  {label: 'getAppQueryService', pattern: /from ['"][^'"]*\/services\/getAppQueryService(?:\.ts)?['"]/u},
  {label: 'duckdbOlap', pattern: /from ['"][^'"]*\/duckdbOlap(?:\.ts)?['"]/u},
  {label: 'duckdbRunner', pattern: /from ['"][^'"]*\/duckdbRunner(?:\.ts)?['"]/u},
]
const retiredOlapImportPatterns = [
  {label: 'duckdbOlap', pattern: /(?:from\s+|import\(\s*)['"][^'"]*\/duckdbOlap(?:\.ts)?['"]/u},
  {
    label: 'articlesReviewsBothOlap',
    pattern: /(?:from\s+|import\(\s*)['"][^'"]*\/articlesReviewsBothOlap(?:\.ts)?['"]/u,
  },
  {
    label: 'articlesReviewsFiltersOlap',
    pattern: /(?:from\s+|import\(\s*)['"][^'"]*\/articlesReviewsFiltersOlap(?:\.ts)?['"]/u,
  },
  {label: 'articlesReviewsOlap', pattern: /(?:from\s+|import\(\s*)['"][^'"]*\/articlesReviewsOlap(?:\.ts)?['"]/u},
  {label: 'selectArticleIdsOlap', pattern: /(?:from\s+|import\(\s*)['"][^'"]*\/selectArticleIdsOlap(?:\.ts)?['"]/u},
  {label: 'unassessedArticlesOlap', pattern: /(?:from\s+|import\(\s*)['"][^'"]*\/unassessedArticlesOlap(?:\.ts)?['"]/u},
]
const routeDuckdbImportAllowlist = new Set([
  'src/server/routes/AdminInvestigateRoutes.ts',
  'src/server/routes/ArticleAdminRoutes.ts',
  'src/server/routes/ArticlesRoutes.ts',
  'src/server/routes/ComparisonProjectsRoutes.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.ts',
  'src/server/routes/DataSourcesRoutes.ts',
  'src/server/routes/DuckdbStudioRoutes.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentPendingJudgments.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverview.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothProjects.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts',
  'src/server/routes/ImportRoutes.ts',
  'src/server/routes/JudgmentsJobsRoutes.ts',
  'src/server/routes/LlmStatusRoutes.ts',
  'src/server/routes/NvidiaSmiRoutes.ts',
  'src/server/routes/ProjectArticlesRoutes.ts',
  'src/server/routes/ProjectExportRoutes.ts',
  'src/server/routes/ProjectsAddArticlesRoutes.ts',
  'src/server/routes/ProjectsRoutes.ts',
  'src/server/routes/PromptsRoutes.ts',
  'src/server/routes/ProviderModelsRoutes.ts',
  'src/server/routes/SubprojectsRoutes.ts',
  'src/server/routes/projectTransferRoutes.ts',
  'src/server/routes/projectsRoutes/projectAccessGuard.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts',
  'src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts',
  'src/server/routes/promptsRoutes/promptsRoutesReadOnly.ts',
])
const forbiddenNormalForegroundSqlPatterns = [
  {label: 'selected scoped import', pattern: /selected_scoped_article_import/iu},
  {label: 'window row number', pattern: /\brow_number\s*\(/iu},
  {label: 'raw article scan', pattern: /\bfrom\s+app\.article\b|\bjoin\s+app\.article\b/iu},
  {label: 'raw judgment scan', pattern: /\bfrom\s+app\.judgment\b|\bjoin\s+app\.judgment\b/iu},
  {label: 'group by aggregation', pattern: /\bgroup\s+by\b/iu},
  {label: 'offset pagination', pattern: /\boffset\b/iu},
  {label: 'json extraction', pattern: /\bjson_(?:extract|extract_string|array|object|valid|type)\s*\(/iu},
]
const normalForegroundSqlAllowlist = new Set([
  'src/server/routes/AdminInvestigateRoutes.ts',
  'src/server/routes/ArticleAdminRoutes.ts',
  'src/server/routes/ArticlesRoutes.ts',
  'src/server/routes/ComparisonProjectsRoutes.ts',
  'src/server/routes/PromptsRoutes.ts',
  'src/server/routes/DuckdbStudioRoutes.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentPendingJudgments.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverview.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothProjects.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts',
  'src/server/routes/JudgmentsJobsRoutes.ts',
  'src/server/routes/ProjectArticlesRoutes.ts',
  'src/server/routes/ProjectExportRoutes.ts',
  'src/server/routes/ProjectsRoutes.ts',
  'src/server/routes/SubprojectsRoutes.ts',
  'src/server/routes/TokensRoutes.ts',
  'src/server/routes/comparisonProjectsRoutes/comparisonProjectConflictResolutionImport.ts',
  'src/server/routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts',
  'src/server/routes/comparisonProjectsRoutes/comparisonProjectStats.ts',
  'src/server/routes/projectTransferRoutes.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts',
  'src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts',
  'src/server/routes/tokensRoutes/tokensRoutesGetFailedRequests.ts',
  'src/server/routes/tokensRoutes/tokensRoutesTimelineUtils.ts',
])
const ownerRoutedDiagnosticRouteContextRequirements = [
  {
    maxResultRowsMarkers: [],
    path: 'src/server/routes/ImportRoutes.ts',
    routeOrJobKeyMarkers: ["routeOrJobKey: 'importRoutes.list'"],
  },
  {
    maxResultRowsMarkers: ['maxResultRows: 1', 'maxResultRows: llmStatusRowsLimit'],
    path: 'src/server/routes/LlmStatusRoutes.ts',
    routeOrJobKeyMarkers: ["routeOrJobKey: 'llmStatus.route'"],
  },
  {
    maxResultRowsMarkers: ['maxResultRows: 1', 'maxResultRows: nvidiaSmiRowsLimit'],
    path: 'src/server/routes/NvidiaSmiRoutes.ts',
    routeOrJobKeyMarkers: ["routeOrJobKey: 'nvidiaSmi.route'"],
  },
]

test('api proxy routes are registered before public product API handlers in serverMain', () => {
  const serverMainText = readFileSync(serverMainPath, 'utf8')
  const proxyIndex = serverMainText.indexOf('.use(apiProxyRoutes)')
  const publicProductIndex = serverMainText.indexOf('.use(publicProductApiRoutes)')
  const ownerPrivateIndex = serverMainText.indexOf('.use(duckdbOwnerPrivateApiRoutes)')

  expect(proxyIndex).toBeGreaterThan(-1)
  expect(publicProductIndex).toBeGreaterThan(proxyIndex)
  expect(ownerPrivateIndex).toBeGreaterThan(publicProductIndex)
})

test('serverMain lazy-loads cron routes so disabled low-memory crons cannot start timers at import time', () => {
  const serverMainText = readFileSync(serverMainPath, 'utf8')

  expect(serverMainText).not.toContain('import {fullTextJobsCron}')
  expect(serverMainText).not.toContain('import {judgmentsJobsJudgingCron')
  expect(serverMainText).not.toContain('import {nvidiaSmiCron}')
  expect(serverMainText).toContain("await import('./cron/judgmentsJobs.ts')")
  expect(serverMainText).toContain("await import('./cron/judgmentsJobsImportCron.ts')")
  expect(serverMainText).toContain("await import('./cron/judgmentsJobsJudgingCron.ts')")
})

test('serverMain low-memory cron deferral follows maintenance-capable roles and normalized env', () => {
  const serverMainText = readFileSync(serverMainPath, 'utf8')

  expect(serverMainText).toContain('parseDuckdbMemoryLimitToMiB(env.DUCKDB_MEMORY_LIMIT)')
  expect(serverMainText).toContain('shouldServerRoleMountMaintenanceCrons(getCurrentServerRole())')
  expect(serverMainText).toContain('shouldMountJudgingCrons && !shouldMountMaintenanceCrons')
})

test('api proxy onRequest intercepts owner-dependent routes before product handlers execute', async () => {
  const apiProxyRoutesModulePath = new URL('./ApiProxyRoutes.ts', import.meta.url).pathname
  const serverRuntimeRoleModulePath = new URL('../utils/serverRuntimeRole.ts', import.meta.url).pathname
  let productHandlerCalled = false

  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      canCurrentServerOwnDuckdb: () => {
        return false
      },
      getCurrentServerDuckdbOwnerUrl: async () => {
        return null
      },
      getCurrentServerRole: () => {
        return 'api'
      },
      getKnownDuckdbOwnerUrl: () => {
        return null
      },
      isCurrentServerDuckdbOwnerProxyDisabled: () => {
        return false
      },
      shouldCurrentServerProxyApiToOwner: () => {
        return true
      },
      shouldCurrentServerProxyApiToDuckdbOwner: () => {
        return true
      },
    }
  })

  try {
    const {apiProxyRoutes} = (await import(
      `${apiProxyRoutesModulePath}?proxy-order=${Date.now()}`
    )) as typeof import('./ApiProxyRoutes.ts')
    const app = new Elysia().use(apiProxyRoutes).get('/api/users', () => {
      productHandlerCalled = true
      return {data: []}
    })
    const response = await app.handle(new Request('http://localhost/api/users'))
    const body = (await response.json()) as {error?: string}

    expect(response.status).toBe(502)
    expect(body.error).toContain('DuckDB owner proxy target unavailable')
    expect(productHandlerCalled).toBe(false)
  } finally {
    mock.restore()
  }
})

test('route handlers cannot add new unallowlisted generic DuckDB imports', () => {
  const violations = getRouteSourceFiles().flatMap((filePath) => {
    const routeFile = getRelativeWorkspacePath(filePath)
    const fileText = readFileSync(filePath, 'utf8')

    return forbiddenDuckdbImportPatterns
      .filter((entry) => {
        return entry.pattern.test(fileText) && !routeDuckdbImportAllowlist.has(routeFile)
      })
      .map((entry) => {
        return `${routeFile}: ${entry.label}`
      })
  })

  expect(violations).toEqual([])
})

test('owner-routed diagnostic route DuckDB reads keep explicit workload contexts and required caps', () => {
  const violations = ownerRoutedDiagnosticRouteContextRequirements.flatMap(
    ({maxResultRowsMarkers, path: routePath, routeOrJobKeyMarkers}) => {
      const fileText = readFileSync(join(workspaceRoot, routePath), 'utf8')
      const requiredMarkers = [
        'import type {DuckdbWorkloadContext}',
        'fallbackIntent:',
        'workloadClass:',
        ...routeOrJobKeyMarkers,
        ...maxResultRowsMarkers,
      ]

      return requiredMarkers
        .filter((marker) => {
          return !fileText.includes(marker)
        })
        .map((marker) => {
          return `${routePath}: missing ${marker}`
        })
    },
  )

  expect(violations).toEqual([])
})

test('normal foreground route SQL cannot add unallowlisted raw OOM-prone shapes', () => {
  const violations = getRouteSourceFiles().flatMap((filePath) => {
    const routeFile = getRelativeWorkspacePath(filePath)
    const fileText = readFileSync(filePath, 'utf8')

    return forbiddenNormalForegroundSqlPatterns
      .filter((entry) => {
        return entry.pattern.test(fileText) && !normalForegroundSqlAllowlist.has(routeFile)
      })
      .map((entry) => {
        return `${routeFile}: ${entry.label}`
      })
  })

  expect(violations).toEqual([])
})

test('prompt preview route cannot reintroduce legacy sample article fallback reads', () => {
  const routeText = readFileSync(join(routesRoot, 'projectsRoutes/projectsRoutesGetPromptPreview.ts'), 'utf8')

  expect(routeText).not.toContain('mart.project_scope_article')
  expect(routeText).not.toContain('app.project_article')
  expect(routeText).not.toContain('getFullArticlesByIds')
})

test('production code cannot reintroduce retired OLAP wrapper or duckdbOlap imports', () => {
  const violations = getProductionSourceFiles().flatMap((filePath) => {
    const sourceFile = getRelativeWorkspacePath(filePath)
    const fileText = readFileSync(filePath, 'utf8')

    return retiredOlapImportPatterns
      .filter((entry) => {
        return entry.pattern.test(fileText)
      })
      .map((entry) => {
        return `${sourceFile}: ${entry.label}`
      })
  })

  expect(violations).toEqual([])
})

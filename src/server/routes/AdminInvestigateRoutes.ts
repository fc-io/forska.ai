import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import * as appQueryHelpers from '../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../services/appReadOnlyDatabaseService.ts'
import {getAppQueryService} from '../services/getAppQueryService.ts'
import {
  getJudgmentJobSqliteHealthProjectionService,
  type JudgmentJobSqliteHealthProjectionReader,
} from '../services/judgmentJobSqliteHealthProjectionService.ts'
import {runProjectMartLargeRebuildCycles} from '../services/projectMartLargeRebuildCyclesService.ts'
import {getProjectMartLargeRebuildStateService} from '../services/projectMartLargeRebuildStateService.ts'
import {type DuckdbOwnerConnectionRecord, getDuckdbOwnerConnectionsOverview} from '../utils/duckdbOwnerConnections.ts'
import {getDuckdbBackgroundRuntimeDiagnostics} from '../utils/duckdbService.ts'
import {getOwnerlessRouteBackendSelections} from '../utils/ownerlessReadableBackends.ts'
import {getProjectMartLargeRebuildRuntimeMetrics} from '../utils/projectMartLargeRebuildRuntimeMetrics.ts'
import {getProjectMartLargeRebuildHeartbeatConfig} from '../utils/projectMartLargeRebuildTuning.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {
  getRuntimeCutoverVersion,
  getRuntimeCutoverVersionMismatchMessage,
  isRuntimeCutoverVersionCompatible,
} from '../utils/runtimeCutover.ts'
import {
  getServerRoleCapabilities,
  type ServerRole,
  type ServerRoleCapability,
  serverRoles,
} from '../utils/serverRole.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerRole,
  getKnownDuckdbOwnerUrl,
  shouldCurrentServerMountDuckdbOwnerPrivateApi,
  shouldCurrentServerMountPublicProductApi,
  shouldCurrentServerProxyApiToOwner,
  shouldCurrentServerRunJudgingLoops,
} from '../utils/serverRuntimeRole.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'

const appDatabaseService = getAppDatabaseService()
const appQueryService = getAppQueryService()
const projectMartLargeRebuildStateService = getProjectMartLargeRebuildStateService()
export const workerRuntimeDiagnosticsPath = '/api/admin/worker-runtime-diagnostics'

type JudgmentJobReadPathMode = 'local-sqlite' | 'owner-duckdb-projection' | 'ownerless-read-only-projection'
type PendingCompletionAckVisibility = {
  available: boolean
  error: string | null
  freshProjectionCount: number
  hasPendingCompletionAck: boolean
  jobCount: number
  latestProjectedAt: string | null
  oldestUnackedCompletionAgeMs: number | null
  pendingCompletionAckCount: number
}
type PendingCompletionAckVisibilityRow = {
  freshProjectionCount: number | null
  hasPendingCompletionAckCount: number | null
  jobCount: number | null
  latestProjectedAt: unknown
  oldestUnackedCompletionAgeMs: number | null
  pendingCompletionAckCount: number | null
}

const getLocalServerRole = (): ServerRole | null => {
  const configuredRole = process.env.SERVER_ROLE

  return serverRoles.includes(configuredRole as ServerRole) ? (configuredRole as ServerRole) : null
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getWorkerDiagnosticsReadDatabase = (): JudgmentJobSqliteHealthProjectionReader => {
  return canCurrentServerOwnDuckdb() ? appDatabaseService : getApiReadOnlyAppDatabaseService()
}

const getJudgmentJobReadPathMode = (): JudgmentJobReadPathMode => {
  return shouldCurrentServerRunJudgingLoops()
    ? 'local-sqlite'
    : canCurrentServerOwnDuckdb()
      ? 'owner-duckdb-projection'
      : 'ownerless-read-only-projection'
}

const getIsoDateFromValue = (value: unknown) => {
  return appQueryHelpers.getDateValue(value)?.toISOString() ?? null
}

const getPendingCompletionAckVisibilityFromSharedState = async (): Promise<PendingCompletionAckVisibility> => {
  try {
    const [row] = await getWorkerDiagnosticsReadDatabase().queryJson<PendingCompletionAckVisibilityRow>(`
      SELECT
        CAST((SELECT COUNT(*) FROM app.judgment_job) AS INTEGER) AS jobCount,
        CAST(SUM(CASE WHEN fresh_until_at > current_timestamp THEN 1 ELSE 0 END) AS INTEGER) AS freshProjectionCount,
        CAST(SUM(
          CASE WHEN fresh_until_at > current_timestamp THEN pending_completion_ack_count ELSE 0 END
        ) AS INTEGER) AS pendingCompletionAckCount,
        CAST(SUM(
          CASE WHEN fresh_until_at > current_timestamp AND has_pending_completion_ack THEN 1 ELSE 0 END
        ) AS INTEGER) AS hasPendingCompletionAckCount,
        MAX(
          CASE WHEN fresh_until_at > current_timestamp THEN oldest_unacked_completion_age_ms ELSE NULL END
        ) AS oldestUnackedCompletionAgeMs,
        MAX(CASE WHEN fresh_until_at > current_timestamp THEN projected_at ELSE NULL END) AS latestProjectedAt
      FROM app.judgment_job_sqlite_health_projection
    `)

    return {
      available: true,
      error: null,
      freshProjectionCount: Number(row?.freshProjectionCount ?? 0),
      hasPendingCompletionAck: Number(row?.hasPendingCompletionAckCount ?? 0) > 0,
      jobCount: Number(row?.jobCount ?? 0),
      latestProjectedAt: getIsoDateFromValue(row?.latestProjectedAt),
      oldestUnackedCompletionAgeMs:
        row?.oldestUnackedCompletionAgeMs == null ? null : Number(row.oldestUnackedCompletionAgeMs),
      pendingCompletionAckCount: Number(row?.pendingCompletionAckCount ?? 0),
    }
  } catch (error) {
    return {
      available: false,
      error: getErrorMessage(error),
      freshProjectionCount: 0,
      hasPendingCompletionAck: false,
      jobCount: 0,
      latestProjectedAt: null,
      oldestUnackedCompletionAgeMs: null,
      pendingCompletionAckCount: 0,
    }
  }
}

const getRouteServingMode = () => {
  const publicProductApi = shouldCurrentServerMountPublicProductApi()
  const duckdbOwnerPrivateApi = shouldCurrentServerMountDuckdbOwnerPrivateApi()
  const ownerProxy = shouldCurrentServerProxyApiToOwner()
  const judgingRuntime = shouldCurrentServerRunJudgingLoops()
  const mode =
    publicProductApi && duckdbOwnerPrivateApi
      ? 'public-and-duckdb-owner-private'
      : publicProductApi && ownerProxy
        ? 'public-api-with-owner-proxy'
        : duckdbOwnerPrivateApi
          ? 'duckdb-owner-private-api'
          : judgingRuntime
            ? 'judging-runtime'
            : 'diagnostics-only'

  return {duckdbOwnerPrivateApi, duckdbOwnerPrivateApiPrefix, judgingRuntime, mode, ownerProxy, publicProductApi}
}

const getConfiguredCapabilities = (localRole: ServerRole | null): ServerRoleCapability[] => {
  return localRole === null ? [] : getServerRoleCapabilities(localRole)
}

const getCutoverRefusedPeer = (record: DuckdbOwnerConnectionRecord) => {
  return {
    connectionId: record.connectionId,
    instanceId: record.instanceId,
    message: getRuntimeCutoverVersionMismatchMessage({
      context: `worker registry process ${record.instanceId}`,
      runtimeVersion: record.runtimeVersion,
    }),
    runtimeVersion: record.runtimeVersion,
    serverRole: record.serverRole,
  }
}

const getCutoverRefusalStatus = (records: DuckdbOwnerConnectionRecord[]) => {
  const refusedRegisteredProcesses = records
    .filter((record) => {
      return !isRuntimeCutoverVersionCompatible(record.runtimeVersion)
    })
    .map(getCutoverRefusedPeer)

  return {
    refusedRegisteredProcessCount: refusedRegisteredProcesses.length,
    refusedRegisteredProcesses,
    refusesIncompatiblePeers: true,
    refusesMissingRuntimeVersion: true,
    runtimeVersion: getRuntimeCutoverVersion(),
    status: refusedRegisteredProcesses.length > 0 ? 'refusing-incompatible-registry' : 'enforced',
  }
}

const getWorkerRuntimeDiagnostics = async () => {
  const localRole = getLocalServerRole()
  const serverRole = getCurrentServerRole()
  const capabilities = getServerRoleCapabilities(serverRole)
  const ownerConnections = await getDuckdbOwnerConnectionsOverview()
  const registeredProcesses = [ownerConnections.owner, ...ownerConnections.followers].filter(
    (record): record is DuckdbOwnerConnectionRecord => {
      return record !== null
    },
  )
  const ownerlessBackendSelections = getOwnerlessRouteBackendSelections()
  const workerRuntimeDiagnosticsBackend =
    ownerlessBackendSelections.find((selection) => {
      return selection.method === 'GET' && selection.pathname === workerRuntimeDiagnosticsPath
    }) ?? null

  return {
    capabilities,
    configuredCapabilities: getConfiguredCapabilities(localRole),
    cutoverRefusal: getCutoverRefusalStatus(registeredProcesses),
    duckdbOwnership: {
      canOwnDuckdb: capabilities.includes('duckdb-owner'),
      duckdbOwnerUrl: getKnownDuckdbOwnerUrl(),
      ownerRecord: ownerConnections.owner,
      ownsDuckdb: canCurrentServerOwnDuckdb(),
    },
    localRole,
    ownerlessBackends: {
      selections: ownerlessBackendSelections,
      validated: ownerlessBackendSelections.length > 0,
      workerRuntimeDiagnostics: workerRuntimeDiagnosticsBackend,
    },
    pendingCompletionAckVisibility: await getPendingCompletionAckVisibilityFromSharedState(),
    readPath: {
      judgmentJobs: {
        mode: getJudgmentJobReadPathMode(),
        sharedProjectionFreshnessMs: getJudgmentJobSqliteHealthProjectionService().getProjectionFreshnessMs(),
      },
    },
    registry: ownerConnections.registry,
    registryDerivedEligibleConsumers: ownerConnections.registry.capabilities.map((capability) => {
      return {
        capability: capability.capability,
        eligibleConsumerCount: capability.eligibleConsumerCount,
        eligibleConsumerPresent: capability.eligibleConsumerPresent,
        freshConsumerCount: capability.freshConsumerCount,
        registeredConsumerCount: capability.registeredConsumerCount,
        staleConsumerCount: capability.staleConsumerCount,
      }
    }),
    registeredProcesses,
    routeServing: getRouteServingMode(),
    runtimeVersion: ownerConnections.runtimeVersion,
    serverRole,
    takeoverState: ownerConnections.registry.takeover,
  }
}

const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  return (
    matches?.map((match) => {
      return match.slice(1, -1)
    }) ?? []
  )
}

const isArrayType = (typeStr: string | null): boolean => {
  if (!typeStr) return false
  return typeStr.includes('[]')
}

const isOpenEndedType = (typeStr: string | null): boolean => {
  if (!typeStr) return true
  return !/['"]/.test(typeStr)
}

type ProjectScope = {
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: Date | null
  dateTo: Date | null
  importRouteIds: string[]
  curatedArticleIds: string[]
}

type PromptWithType = {id: string; promptHeading: string | null; type: string | null}

type StringAnswerBucket = {value: string | null; count: number}
type ArrayAnswerBucket = {value: string | null; parsedValue: unknown; count: number}

type AutoSyncAllProgress = {
  status: 'idle' | 'running' | 'completed' | 'error'
  totalPrompts: number
  processedPrompts: number
  currentPromptId: string | null
  currentPromptHeading: string | null
  totalDeleted: number
  deletedByPrompt: Array<{promptId: string; promptHeading: string; deleted: number}>
  startedAt: Date | null
  completedAt: Date | null
  error: string | null
}

type ProjectMartLargeRebuildOperatorStatus = {
  estimates: {
    currentPhaseProgressPercent: number
    estimatedRemainingCyclesAtBatchSize1: number
    estimatedRemainingMs: number | null
    overallProgressPercent: number
    remainingPhaseArticleCount: number
    scannedPhaseArticleCount: number
    scopeArticleCount: number
  }
  largeRebuild: {
    createdAt: string | null
    cursorArticleCreatedAt: string | null
    cursorArticleId: string | null
    lastCompletedAt: string | null
    lastError: string | null
    lastStartedAt: string | null
    operatorNote: string | null
    rebuildPhase: string | null
    refreshStatus: string | null
    refreshToken: number | null
    updatedAt: string | null
  } | null
  project: {archived: boolean; id: string; name: string}
  refreshState: {
    activeRefreshToken: number
    dirtyToken: number
    lastCompletedRefreshToken: number
    lastError: string | null
    refreshStatus: string
    workerId: string | null
  } | null
}

const largeRebuildPhaseOrder = [
  'project_scope_article',
  'judgment_fact',
  'prompt_answer_fact',
  'review_answer_dictionary',
  'review_article_filter_member',
  'review_article_rollup',
  'review_article_serving',
] as const

const articleScopedLargeRebuildPhases = new Set([
  'project_scope_article',
  'judgment_fact',
  'prompt_answer_fact',
  'review_article_filter_member',
  'review_article_rollup',
  'review_article_serving',
])

const getLargeRebuildPhaseIndex = (phase: string | null) => {
  return phase === null ? -1 : largeRebuildPhaseOrder.indexOf(phase as (typeof largeRebuildPhaseOrder)[number])
}

const getOverallProgressPercent = ({
  currentPhaseProgressPercent,
  refreshStatus,
  rebuildPhase,
}: {
  currentPhaseProgressPercent: number
  rebuildPhase: string | null
  refreshStatus: string | null
}) => {
  const phaseIndex = getLargeRebuildPhaseIndex(rebuildPhase)
  const totalPhaseCount = largeRebuildPhaseOrder.length

  return refreshStatus === 'paused'
    || refreshStatus === 'running'
    || refreshStatus === 'idle'
    || refreshStatus === 'failed'
    ? rebuildPhase === null
      ? refreshStatus === 'idle'
        ? 100
        : 0
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(((Math.max(0, phaseIndex) + currentPhaseProgressPercent / 100) / totalPhaseCount) * 100),
          ),
        )
    : 0
}

const getEstimatedRemainingCyclesAtBatchSize1 = ({
  rebuildPhase,
  remainingPhaseArticleCount,
}: {
  rebuildPhase: string | null
  remainingPhaseArticleCount: number
}) => {
  const phaseIndex = getLargeRebuildPhaseIndex(rebuildPhase)

  return rebuildPhase === null || phaseIndex === -1
    ? 0
    : articleScopedLargeRebuildPhases.has(rebuildPhase)
      ? remainingPhaseArticleCount + (largeRebuildPhaseOrder.length - phaseIndex - 1)
      : largeRebuildPhaseOrder.length - phaseIndex
}

const getActiveLargeRebuild = <T extends {refreshToken: number | null}>(largeRebuild: T | null | undefined) => {
  return largeRebuild && largeRebuild.refreshToken !== null && largeRebuild.refreshToken > 0 ? largeRebuild : null
}

type ProjectMartLargeRebuildProgressState = {
  cursorArticleCreatedAt: string | null
  cursorArticleId: string | null
  rebuildPhase: string | null
}

const getLargeRebuildRemainingPhaseArticleCountSql = ({
  articleCreatedAtColumn,
  articleIdColumn,
  cursorArticleCreatedAt,
  cursorArticleId,
}: {
  articleCreatedAtColumn: string
  articleIdColumn: string
  cursorArticleCreatedAt: string | null
  cursorArticleId: string | null
}) => {
  return `CAST(
    COALESCE(
      SUM(
        CASE
          WHEN ${appQueryHelpers.getSqlLiteral(cursorArticleId)} IS NULL THEN 1
          WHEN COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') > COALESCE(${appQueryHelpers.getSqlLiteral(cursorArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') THEN 1
          WHEN COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') = COALESCE(${appQueryHelpers.getSqlLiteral(cursorArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
            AND ${articleIdColumn} > ${appQueryHelpers.getSqlLiteral(cursorArticleId)} THEN 1
          ELSE 0
        END
      ),
      0
    ) AS INTEGER
  )`
}

const getLiveProjectScopeProgressSql = (projectId: string, largeRebuild: ProjectMartLargeRebuildProgressState) => {
  const projectLiteral = appQueryHelpers.getSqlLiteral(projectId)

  return `
    WITH route_scope AS (
      SELECT air.article_id AS articleId
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${projectLiteral}
    ),
    curated_scope AS (
      SELECT pa.article_id AS articleId
      FROM app.project_article pa
      WHERE pa.project_id = ${projectLiteral}
    ),
    aggregated_scope AS (
      SELECT articleId
      FROM route_scope
      UNION
      SELECT articleId
      FROM curated_scope
    )
    SELECT
      CAST(COUNT(*) AS INTEGER) AS scopeArticleCount,
      ${getLargeRebuildRemainingPhaseArticleCountSql({
        articleCreatedAtColumn: 'article.article_created_at',
        articleIdColumn: 'aggregated_scope.articleId',
        cursorArticleCreatedAt: largeRebuild.cursorArticleCreatedAt,
        cursorArticleId: largeRebuild.cursorArticleId,
      })} AS remainingPhaseArticleCount
    FROM aggregated_scope
    INNER JOIN app.article article ON article.id = aggregated_scope.articleId
  `
}

const getFrozenProjectScopeProgressSql = (projectId: string, largeRebuild: ProjectMartLargeRebuildProgressState) => {
  return `
    SELECT
      CAST(COUNT(*) AS INTEGER) AS scopeArticleCount,
      ${getLargeRebuildRemainingPhaseArticleCountSql({
        articleCreatedAtColumn: 'scope_article.article_created_at',
        articleIdColumn: 'scope_article.article_id',
        cursorArticleCreatedAt: largeRebuild.cursorArticleCreatedAt,
        cursorArticleId: largeRebuild.cursorArticleId,
      })} AS remainingPhaseArticleCount
    FROM mart.project_scope_article scope_article
    WHERE project_id = ${appQueryHelpers.getSqlLiteral(projectId)}
  `
}

const getProjectScopeProgressSql = (projectId: string, largeRebuild: ProjectMartLargeRebuildProgressState) => {
  return largeRebuild.rebuildPhase === 'project_scope_article'
    ? getLiveProjectScopeProgressSql(projectId, largeRebuild)
    : getFrozenProjectScopeProgressSql(projectId, largeRebuild)
}

const getProjectMartLargeRebuildOperatorStatus = async (
  projectId: string,
): Promise<ProjectMartLargeRebuildOperatorStatus> => {
  const [project] = await appDatabaseService.queryJson<{archived: boolean; id: string; name: string}>(`
    SELECT id, name, archived
    FROM app.project
    WHERE id = '${appQueryHelpers.escapeSqlString(projectId)}'
    LIMIT 1
  `)

  if (!project) {
    throw new Error('Project not found')
  }

  const [refreshState] = await appDatabaseService.queryJson<{
    activeRefreshToken: number
    dirtyToken: number
    lastCompletedRefreshToken: number
    lastError: string | null
    refreshStatus: string
    workerId: string | null
  }>(`
    SELECT
      CAST(active_refresh_token AS INTEGER) AS activeRefreshToken,
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
      last_error AS lastError,
      refresh_status AS refreshStatus,
      worker_id AS workerId
    FROM app.project_mart_refresh_state
    WHERE project_id = '${appQueryHelpers.escapeSqlString(projectId)}'
    LIMIT 1
  `)

  const [largeRebuild] = await appDatabaseService.queryJson<{
    createdAt: string | null
    cursorArticleCreatedAt: string | null
    cursorArticleId: string | null
    lastCompletedAt: string | null
    lastError: string | null
    lastStartedAt: string | null
    operatorNote: string | null
    rebuildPhase: string | null
    refreshStatus: string | null
    refreshToken: number | null
    updatedAt: string | null
  }>(`
    SELECT
      created_at AS createdAt,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      last_completed_at AS lastCompletedAt,
      last_error AS lastError,
      last_started_at AS lastStartedAt,
      operator_note AS operatorNote,
      rebuild_phase AS rebuildPhase,
      refresh_status AS refreshStatus,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      updated_at AS updatedAt
    FROM app.project_mart_large_rebuild_state
    WHERE project_id = '${appQueryHelpers.escapeSqlString(projectId)}'
    LIMIT 1
  `)
  const activeLargeRebuild = getActiveLargeRebuild(largeRebuild)

  const [scopeProgressRow] = await appDatabaseService.queryJson<{
    remainingPhaseArticleCount: number
    scopeArticleCount: number
  }>(
    getProjectScopeProgressSql(projectId, {
      cursorArticleCreatedAt: activeLargeRebuild?.cursorArticleCreatedAt ?? null,
      cursorArticleId: activeLargeRebuild?.cursorArticleId ?? null,
      rebuildPhase: activeLargeRebuild?.rebuildPhase ?? null,
    }),
  )
  const scopeArticleCount = scopeProgressRow?.scopeArticleCount ?? 0
  const rawRemainingPhaseArticleCount = scopeProgressRow?.remainingPhaseArticleCount ?? scopeArticleCount
  const boundedRemainingPhaseArticleCount = Math.max(0, Math.min(scopeArticleCount, rawRemainingPhaseArticleCount))
  const scannedPhaseArticleCount = articleScopedLargeRebuildPhases.has(activeLargeRebuild?.rebuildPhase ?? '')
    ? Math.max(0, scopeArticleCount - boundedRemainingPhaseArticleCount)
    : activeLargeRebuild?.rebuildPhase === 'review_answer_dictionary'
      ? scopeArticleCount
      : 0
  const remainingPhaseArticleCount = articleScopedLargeRebuildPhases.has(activeLargeRebuild?.rebuildPhase ?? '')
    ? boundedRemainingPhaseArticleCount
    : 0
  const currentPhaseProgressPercent = articleScopedLargeRebuildPhases.has(activeLargeRebuild?.rebuildPhase ?? '')
    ? scopeArticleCount === 0
      ? 100
      : Math.max(0, Math.min(100, Math.round((scannedPhaseArticleCount / scopeArticleCount) * 100)))
    : activeLargeRebuild?.rebuildPhase === 'review_answer_dictionary'
      ? 100
      : activeLargeRebuild?.rebuildPhase === null
        ? 100
        : 0
  const overallProgressPercent = getOverallProgressPercent({
    currentPhaseProgressPercent,
    rebuildPhase: activeLargeRebuild?.rebuildPhase ?? null,
    refreshStatus: activeLargeRebuild?.refreshStatus ?? null,
  })
  const estimatedRemainingCyclesAtBatchSize1 = getEstimatedRemainingCyclesAtBatchSize1({
    rebuildPhase: activeLargeRebuild?.rebuildPhase ?? null,
    remainingPhaseArticleCount,
  })
  const lastStartedAt = activeLargeRebuild?.lastStartedAt ? new Date(activeLargeRebuild.lastStartedAt) : null
  const estimatedRemainingMs =
    lastStartedAt
    && activeLargeRebuild?.refreshStatus === 'running'
    && overallProgressPercent > 0
    && overallProgressPercent < 100
      ? Math.max(
          0,
          Math.round(
            ((Date.now() - lastStartedAt.getTime()) * (100 - overallProgressPercent)) / overallProgressPercent,
          ),
        )
      : null

  return {
    estimates: {
      currentPhaseProgressPercent,
      estimatedRemainingCyclesAtBatchSize1,
      estimatedRemainingMs,
      overallProgressPercent,
      remainingPhaseArticleCount,
      scannedPhaseArticleCount,
      scopeArticleCount,
    },
    largeRebuild: activeLargeRebuild,
    project,
    refreshState: refreshState ?? null,
  }
}

const getProjectJudgmentClause = (projectScope: ProjectScope | null, judgmentAlias: string) => {
  if (!projectScope) {
    return null
  }

  const curatedClause =
    projectScope.curatedArticleIds.length > 0
      ? `a.id IN (${appQueryHelpers.getQuotedStringList(projectScope.curatedArticleIds).join(', ')})`
      : null
  const routeOrCuratedClause = appQueryHelpers.getAndClause([
    `a.id = ${judgmentAlias}.article_id`,
    projectScope.importRouteIds.length > 0 || curatedClause
      ? `(${[
          projectScope.importRouteIds.length > 0
            ? `EXISTS (
                SELECT 1
                FROM app.article_import_route air
                WHERE air.article_id = a.id
                  AND air.import_route_id IN (${appQueryHelpers.getQuotedStringList(projectScope.importRouteIds).join(', ')})
              )`
            : null,
          curatedClause,
        ]
          .filter(Boolean)
          .join(' OR ')})`
      : null,
    projectScope.dateFrom ? `a.article_created_at >= ${appQueryHelpers.getSqlLiteral(projectScope.dateFrom)}` : null,
    projectScope.dateTo ? `a.article_created_at <= ${appQueryHelpers.getSqlLiteral(projectScope.dateTo)}` : null,
  ])

  return appQueryHelpers.getAndClause([
    `${judgmentAlias}.model_id = ${appQueryHelpers.getSqlLiteral(projectScope.modelId)}`,
    `${judgmentAlias}.use_title = ${appQueryHelpers.getSqlLiteral(projectScope.useTitle)}`,
    `${judgmentAlias}.use_abstract = ${appQueryHelpers.getSqlLiteral(projectScope.useAbstract)}`,
    `${judgmentAlias}.use_fulltext = ${appQueryHelpers.getSqlLiteral(projectScope.useFulltext)}`,
    `${judgmentAlias}.use_fulltext_no_images = ${appQueryHelpers.getSqlLiteral(projectScope.useFulltextNoImages)}`,
    routeOrCuratedClause ? `EXISTS (SELECT 1 FROM app.article a WHERE ${routeOrCuratedClause})` : null,
  ])
}

const getPromptById = async (promptId: string) => {
  const [prompt] = await appDatabaseService.queryJson<{id: string; type: string | null}>(`
    SELECT id, type
    FROM app.prompt
    WHERE id = '${appQueryHelpers.escapeSqlString(promptId)}'
    LIMIT 1
  `)

  return prompt ?? null
}

const getProjectName = async (projectId: string) => {
  const [project] = await appDatabaseService.queryJson<{name: string}>(`
    SELECT name
    FROM app.project
    WHERE id = '${appQueryHelpers.escapeSqlString(projectId)}'
    LIMIT 1
  `)

  return project?.name ?? null
}

const getProjectPrompts = async (projectId: string) => {
  return appQueryService.getProjectPromptRows(projectId).then((rows) => {
    return rows.filter((row) => {
      return row.type !== null
    })
  })
}

const getTypedPrompts = async () => {
  return appDatabaseService.queryJson<{
    id: string
    promptHeading: string | null
    type: string | null
    originalText: string
    createdAt: unknown
    archived: boolean
  }>(`
    SELECT
      id,
      prompt_heading AS promptHeading,
      type,
      original_text AS originalText,
      created_at AS createdAt,
      archived
    FROM app.prompt
    WHERE type IS NOT NULL
    ORDER BY prompt_heading ASC NULLS LAST
  `)
}

const getPromptSelection = async (projectId: string | null, promptId: string | null) => {
  return promptId
    ? appDatabaseService.queryJson<PromptWithType>(`
        SELECT id, prompt_heading AS promptHeading, type
        FROM app.prompt
        WHERE id = '${appQueryHelpers.escapeSqlString(promptId)}'
          AND type IS NOT NULL
      `)
    : projectId
      ? getProjectPrompts(projectId)
      : appDatabaseService.queryJson<PromptWithType>(`
          SELECT id, prompt_heading AS promptHeading, type
          FROM app.prompt
          WHERE type IS NOT NULL
        `)
}

const fetchProjectScope = async (projectId: string): Promise<ProjectScope | null> => {
  const [projectConfig, curatedRows] = await Promise.all([
    appQueryService.getProjectReviewConfig(projectId),
    appDatabaseService.queryJson<{articleId: string}>(`
      SELECT article_id AS articleId
      FROM app.project_article
      WHERE project_id = '${appQueryHelpers.escapeSqlString(projectId)}'
    `),
  ])

  return projectConfig
    ? {
        modelId: projectConfig.modelId,
        useTitle: projectConfig.useTitle,
        useAbstract: projectConfig.useAbstract,
        useFulltext: projectConfig.useFulltext,
        useFulltextNoImages: projectConfig.useFulltextNoImages,
        dateFrom: projectConfig.dateFrom,
        dateTo: projectConfig.dateTo,
        importRouteIds: projectConfig.importRouteIds,
        curatedArticleIds: curatedRows.map((row) => {
          return row.articleId
        }),
      }
    : null
}

const getStringAnswerBuckets = async (
  promptId: string,
  projectScope: ProjectScope | null,
): Promise<StringAnswerBucket[]> => {
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])

  return appDatabaseService.queryJson<StringAnswerBucket>(`
    SELECT
      j.answered_original AS value,
      COUNT(*) AS count
    FROM app.judgment j
    WHERE ${whereClause}
    GROUP BY j.answered_original
  `)
}

const getArrayAnswerBuckets = async (
  promptId: string,
  projectScope: ProjectScope | null,
): Promise<ArrayAnswerBucket[]> => {
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])
  const rows = await appDatabaseService.queryJson<{value: string | null; count: number}>(`
    SELECT
      TO_JSON(j.answered_original_as_array) AS value,
      COUNT(*) AS count
    FROM app.judgment j
    WHERE ${whereClause}
    GROUP BY j.answered_original_as_array
  `)

  return rows.map((row) => {
    return {value: row.value, parsedValue: appQueryHelpers.getJsonValue(row.value), count: row.count}
  })
}

const getUnexpectedArrayAnswers = (buckets: ArrayAnswerBucket[], expectedOptions: string[]) => {
  return buckets
    .filter((bucket) => {
      if (bucket.parsedValue === null) return true
      if (!Array.isArray(bucket.parsedValue)) return true
      if (bucket.parsedValue.length === 0) return true
      return bucket.parsedValue.some((value) => {
        return typeof value !== 'string' || !expectedOptions.includes(value)
      })
    })
    .map((bucket) => {
      return {value: bucket.value, count: bucket.count}
    })
}

const getUnexpectedStringAnswers = (buckets: StringAnswerBucket[], expectedOptions: string[]) => {
  return buckets.filter((bucket) => {
    if (bucket.value === null) return true
    if (bucket.value === '') return true
    return !expectedOptions.includes(bucket.value)
  })
}

const getUnexpectedAnswersSummary = async (params: {
  promptId: string
  promptType: string | null
  projectScope: ProjectScope | null
}) => {
  const expectedOptions = parseArktypeOptions(params.promptType)
  const isArray = isArrayType(params.promptType)
  const arrayBuckets = isArray ? await getArrayAnswerBuckets(params.promptId, params.projectScope) : []
  const stringBuckets = isArray ? [] : await getStringAnswerBuckets(params.promptId, params.projectScope)
  const unexpectedAnswers = isArray
    ? getUnexpectedArrayAnswers(arrayBuckets, expectedOptions).sort((left, right) => {
        return right.count - left.count
      })
    : getUnexpectedStringAnswers(stringBuckets, expectedOptions).sort((left, right) => {
        return right.count - left.count
      })
  const totalJudgments = (isArray ? arrayBuckets : stringBuckets).reduce((sum, bucket) => {
    return sum + bucket.count
  }, 0)

  return {expectedOptions, totalJudgments, unexpectedAnswers}
}

const deleteUnexpectedJudgments = async (
  projectId: string | null,
  promptId: string,
  unexpectedValue: string | null,
) => {
  const prompt = await getPromptById(promptId)

  if (!prompt || isOpenEndedType(prompt.type)) {
    return {deleted: 0}
  }

  const expectedOptions = parseArktypeOptions(prompt.type)
  if (expectedOptions.length === 0) {
    return {deleted: 0}
  }

  const projectScope = projectId ? await fetchProjectScope(projectId) : null
  if (projectId && !projectScope) {
    return {deleted: 0}
  }

  const isArray = isArrayType(prompt.type)
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])
  const judgmentRows = await appDatabaseService.queryJson<{
    id: string
    answeredOriginal: string | null
    answeredOriginalAsArray: string | null
  }>(`
    SELECT
      j.id AS id,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray
    FROM app.judgment j
    WHERE ${whereClause}
  `)
  const idsToDelete = judgmentRows
    .filter((row) => {
      const parsedArray = appQueryHelpers.getJsonValue(row.answeredOriginalAsArray)
      const currentValue = isArray ? (parsedArray === null ? null : JSON.stringify(parsedArray)) : row.answeredOriginal
      return currentValue === unexpectedValue
    })
    .map((row) => {
      return row.id
    })

  if (idsToDelete.length === 0) {
    return {deleted: 0}
  }

  const now = new Date()
  await appDatabaseService.run(`
    UPDATE app.judgment
    SET deleted_at = ${appQueryHelpers.getSqlLiteral(now)},
        updated_at = ${appQueryHelpers.getSqlLiteral(now)}
    WHERE id IN (${appQueryHelpers.getQuotedStringList(idsToDelete).join(', ')})
  `)

  return {deleted: idsToDelete.length}
}

const autoSyncAllProgress: AutoSyncAllProgress = {
  status: 'idle',
  totalPrompts: 0,
  processedPrompts: 0,
  currentPromptId: null,
  currentPromptHeading: null,
  totalDeleted: 0,
  deletedByPrompt: [],
  startedAt: null,
  completedAt: null,
  error: null,
}

const getAutoSyncAllProgress = () => {
  return {...autoSyncAllProgress, deletedByPrompt: [...autoSyncAllProgress.deletedByPrompt]}
}

const runAutoSyncAllAsync = async (projectId: string | null) => {
  if (autoSyncAllProgress.status === 'running') {
    return {started: false, message: 'Auto-sync already in progress'}
  }

  autoSyncAllProgress.status = 'running'
  autoSyncAllProgress.totalPrompts = 0
  autoSyncAllProgress.processedPrompts = 0
  autoSyncAllProgress.currentPromptId = null
  autoSyncAllProgress.currentPromptHeading = null
  autoSyncAllProgress.totalDeleted = 0
  autoSyncAllProgress.deletedByPrompt = []
  autoSyncAllProgress.startedAt = new Date()
  autoSyncAllProgress.completedAt = null
  autoSyncAllProgress.error = null

  const runSync = async () => {
    try {
      console.log(
        `[AutoSyncAll] Starting auto-sync all unexpected answers${projectId ? ` for project ${projectId}` : ''}...`,
      )

      const promptsToProcess = await getPromptSelection(projectId, null)
      const projectScope = projectId ? await fetchProjectScope(projectId) : null
      const filteredPrompts = promptsToProcess.filter((prompt) => {
        return !isOpenEndedType(prompt.type)
      })

      autoSyncAllProgress.totalPrompts = filteredPrompts.length
      console.log(`[AutoSyncAll] Found ${filteredPrompts.length} prompts with defined types to process`)

      for (const prompt of filteredPrompts) {
        autoSyncAllProgress.currentPromptId = prompt.id
        autoSyncAllProgress.currentPromptHeading = prompt.promptHeading ?? 'Untitled'

        const {expectedOptions, unexpectedAnswers} = await getUnexpectedAnswersSummary({
          promptId: prompt.id,
          promptType: prompt.type,
          projectScope,
        })

        if (expectedOptions.length === 0) {
          autoSyncAllProgress.processedPrompts += 1
          continue
        }

        let promptDeleted = 0
        for (const unexpectedAnswer of unexpectedAnswers) {
          const result = await deleteUnexpectedJudgments(projectId, prompt.id, unexpectedAnswer.value)
          promptDeleted += result.deleted
        }

        if (promptDeleted > 0) {
          autoSyncAllProgress.totalDeleted += promptDeleted
          autoSyncAllProgress.deletedByPrompt.push({
            promptId: prompt.id,
            promptHeading: prompt.promptHeading ?? 'Untitled',
            deleted: promptDeleted,
          })
          console.log(
            `[AutoSyncAll] Deleted ${promptDeleted} unexpected judgments for prompt "${prompt.promptHeading ?? prompt.id}"`,
          )
        }

        autoSyncAllProgress.processedPrompts += 1
      }

      autoSyncAllProgress.status = 'completed'
      autoSyncAllProgress.completedAt = new Date()
      autoSyncAllProgress.currentPromptId = null
      autoSyncAllProgress.currentPromptHeading = null
      console.log(
        `[AutoSyncAll] Completed! Processed ${autoSyncAllProgress.processedPrompts} prompts, deleted ${autoSyncAllProgress.totalDeleted} unexpected judgments`,
      )
    } catch (error) {
      autoSyncAllProgress.status = 'error'
      autoSyncAllProgress.error = error instanceof Error ? error.message : 'Unknown error'
      autoSyncAllProgress.completedAt = new Date()
      console.error('[AutoSyncAll] Error:', error)
    }
  }

  void runSync()

  return {started: true, message: 'Auto-sync all started'}
}

export const adminInvestigateRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/admin/duckdb-append-metrics', async () => {
    return appDatabaseService.getAppendMetrics()
  })
  .get('/api/admin/maintenance-runtime-diagnostics', async () => {
    const processMemory = process.memoryUsage()

    return {
      duckdb: await getDuckdbBackgroundRuntimeDiagnostics(),
      processMemory: {
        arrayBuffersBytes: processMemory.arrayBuffers,
        externalBytes: processMemory.external,
        heapTotalBytes: processMemory.heapTotal,
        heapUsedBytes: processMemory.heapUsed,
        rssBytes: processMemory.rss,
      },
      projectMartLargeRebuildHeartbeat: await getProjectMartLargeRebuildHeartbeatConfig(),
      projectMartLargeRebuildRuntimeMetrics: getProjectMartLargeRebuildRuntimeMetrics(),
      role: getCurrentServerRole(),
      serverRole: process.env.SERVER_ROLE ?? null,
      pid: process.pid,
    }
  })
  .get(workerRuntimeDiagnosticsPath, async () => {
    return getWorkerRuntimeDiagnostics()
  })
  .get(
    '/api/admin/project-mart-large-rebuild-status',
    async ({query}) => {
      return getProjectMartLargeRebuildOperatorStatus(query.projectId)
    },
    {query: t.Object({projectId: t.String()})},
  )
  .post(
    '/api/admin/project-mart-large-rebuild-run',
    async ({body}) => {
      return runProjectMartLargeRebuildCycles({
        batchSize: body.batchSize ?? 1,
        maxCycles: body.maxCycles,
        maxNoProgressBackoffs: body.maxNoProgressBackoffs,
        projectId: body.projectId,
        until: body.until ?? 'max-cycles',
        workerId: body.workerId ?? `admin-project-mart-large-rebuild:${process.pid}`,
      })
    },
    {
      body: t.Object({
        batchSize: t.Optional(t.Numeric()),
        maxCycles: t.Numeric(),
        maxNoProgressBackoffs: t.Optional(t.Numeric()),
        projectId: t.String(),
        until: t.Optional(
          t.Union([
            t.Literal('completed'),
            t.Literal('failed'),
            t.Literal('idle'),
            t.Literal('phase-change'),
            t.Literal('max-cycles'),
          ]),
        ),
        workerId: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/api/admin/project-mart-large-rebuild-pause',
    async ({body}) => {
      return projectMartLargeRebuildStateService.pauseLargeRebuild({projectId: body.projectId, reason: body.reason})
    },
    {body: t.Object({projectId: t.String(), reason: t.Optional(t.String())})},
  )
  .post(
    '/api/admin/project-mart-large-rebuild-resume',
    async ({body}) => {
      return projectMartLargeRebuildStateService.resumeLargeRebuild({projectId: body.projectId})
    },
    {body: t.Object({projectId: t.String()})},
  )
  .post(
    '/api/admin/project-mart-large-rebuild-note',
    async ({body}) => {
      return projectMartLargeRebuildStateService.setLargeRebuildOperatorNote({
        note: body.note,
        projectId: body.projectId,
      })
    },
    {body: t.Object({note: t.Union([t.String(), t.Null()]), projectId: t.String()})},
  )
  .get('/api/admin/list-prompts-with-types', async () => {
    const promptsList = await getTypedPrompts()
    const filtered = promptsList.filter((prompt) => {
      return !isOpenEndedType(prompt.type)
    })

    return {
      prompts: filtered.map((prompt) => {
        return {
          id: prompt.id,
          promptHeading: prompt.promptHeading || 'Untitled',
          type: prompt.type,
          originalText: prompt.originalText,
          createdAt: appQueryHelpers.getDateValue(prompt.createdAt),
          archived: prompt.archived,
        }
      }),
    }
  })
  .post(
    '/api/admin/delete-unexpected-answers',
    async ({body}) => {
      return deleteUnexpectedJudgments(body.projectId, body.promptId, body.unexpectedValue)
    },
    {
      body: t.Object({
        projectId: t.Union([t.String(), t.Null()]),
        promptId: t.String(),
        unexpectedValue: t.Union([t.String(), t.Null()]),
      }),
    },
  )
  .post(
    '/api/admin/auto-sync-all-unexpected-answers',
    async ({body}) => {
      return runAutoSyncAllAsync(body?.projectId ?? null)
    },
    {body: t.Optional(t.Object({projectId: t.Optional(t.Union([t.String(), t.Null()]))}))},
  )
  .get('/api/admin/auto-sync-all-progress', async () => {
    return getAutoSyncAllProgress()
  })
  .get(
    '/api/admin/investigate-unexpected-answers',
    async ({query}) => {
      const projectId = query.projectId
      const promptId = query.promptId

      console.log(
        `[Admin] Fetching prompts${projectId ? ` for project ${projectId}` : ''}${promptId ? ` for prompt ${promptId}` : ''}...`,
      )

      const projectName = projectId ? await getProjectName(projectId) : 'All Projects'
      if (projectId && !projectName) {
        throw new Error('Project not found')
      }

      const allPrompts = await getPromptSelection(projectId ?? null, promptId ?? null)
      console.log(`[Admin] Found ${allPrompts.length} prompts with defined types`)

      const projectScope = projectId ? await fetchProjectScope(projectId) : null
      if (projectId && !projectScope) {
        throw new Error('Project not found or has no configuration')
      }

      const results: Array<{
        promptId: string
        promptHeading: string
        expectedOptions: string[]
        unexpectedAnswers: Array<{value: string | null; count: number}>
        totalJudgments: number
        percentUnexpected: number
      }> = []

      for (const prompt of allPrompts) {
        if (isOpenEndedType(prompt.type)) {
          continue
        }

        const {expectedOptions, totalJudgments, unexpectedAnswers} = await getUnexpectedAnswersSummary({
          promptId: prompt.id,
          promptType: prompt.type,
          projectScope,
        })

        if (expectedOptions.length === 0 || unexpectedAnswers.length === 0) {
          continue
        }

        const unexpectedCount = unexpectedAnswers.reduce((sum, answer) => {
          return sum + answer.count
        }, 0)
        const percentUnexpected = totalJudgments > 0 ? (unexpectedCount / totalJudgments) * 100 : 0

        results.push({
          promptId: prompt.id,
          promptHeading: prompt.promptHeading || 'Untitled',
          expectedOptions,
          unexpectedAnswers,
          totalJudgments,
          percentUnexpected,
        })
      }

      console.log(`[Admin] Found ${results.length} prompts with unexpected answers`)

      return promptId
        ? {projectName, promptHeading: allPrompts[0]?.promptHeading || 'Untitled', result: results[0] ?? null}
        : {
            summary: {totalPromptsWithTypes: allPrompts.length, promptsWithUnexpectedAnswers: results.length},
            results: results.sort((left, right) => {
              return right.percentUnexpected - left.percentUnexpected
            }),
            projectName,
          }
    },
    {query: t.Object({projectId: t.Optional(t.String()), promptId: t.Optional(t.String())})},
  )

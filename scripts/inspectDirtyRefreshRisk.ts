import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {incrementalArticleThreshold: number; projectId: string}

type RefreshStateRow = {
  activeDirtyToken: number | string | null
  dirtyToken: number | string | null
  lastCompletedDirtyToken: number | string | null
  leaseExpiresAt: string | null
  refreshStatus: string | null
  workerId: string | null
}

type DirtyMaterializationRow = {
  cursorArticleCreatedAt: string | null
  cursorArticleId: string | null
  expectedRowCount: number | string | null
  insertedRowCount: number | string | null
  leaseExpiresAt: string | null
  materializationOwner: string | null
  materializationStatus: string
  sourceKind: string
  targetDirtyToken: number | string
}

type QuarantineBarrierRow = {
  articleId: string
  detectedBy: string | null
  dirtyToken: number | string
  error: string
  updatedAt: string
}

type LargeRebuildStateRow = {
  leaseExpiresAt: string | null
  rebuildPhase: string
  refreshStatus: string
  refreshToken: number | string
  sourceDirtyToken: number | string | null
  sourceHighWaterDirtyToken: number | string | null
  supersededAt: string | null
  targetGeneration: number | string | null
  workerId: string | null
}

type CountRow = {count: number | string}

const defaultDirtyRefreshIncrementalArticleThreshold = 3
const workloadContext = getMaintenanceDuckdbWorkloadContext('inspectDirtyRefreshRisk')

const quoteSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getDirtyRefreshExecutionMode = ({
  dirtyArticleCount,
  incrementalArticleThreshold,
}: {
  dirtyArticleCount: number
  incrementalArticleThreshold: number
}) => {
  return dirtyArticleCount === 0 ? 'idle' : dirtyArticleCount <= incrementalArticleThreshold ? 'incremental' : 'full'
}

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1)
}

const getNumberArgValue = (names: string[]) => {
  const rawValue = getArgValue(names)
  const parsed = Number(rawValue)

  return rawValue === undefined || Number.isNaN(parsed) ? undefined : parsed
}

const getCliOptions = (): CliOptions => {
  const projectId = getArgValue(['--projectId', '--project-id'])

  if (!projectId) {
    throw new Error('Missing --project-id=<project-id>')
  }

  return {
    incrementalArticleThreshold:
      getNumberArgValue(['--incrementalArticleThreshold', '--incremental-article-threshold'])
      ?? defaultDirtyRefreshIncrementalArticleThreshold,
    projectId,
  }
}

const toNumber = (value: number | string | null | undefined) => {
  return Number(value ?? 0)
}

const getRefreshState = async (projectId: string) => {
  const [row] = await getAppDatabaseService().queryJson<RefreshStateRow>(
    `
    SELECT
      dirty_token AS dirtyToken,
      active_dirty_token AS activeDirtyToken,
      last_completed_dirty_token AS lastCompletedDirtyToken,
      lease_expires_at AS leaseExpiresAt,
      refresh_status AS refreshStatus,
      worker_id AS workerId
    FROM app.project_mart_refresh_state
    WHERE project_id = ${quoteSqlString(projectId)}
    LIMIT 1
  `,
    workloadContext,
  )

  return row ?? null
}

const getDirtyMaterializations = async (projectId: string) => {
  return getAppDatabaseService().queryJson<DirtyMaterializationRow>(
    `
    SELECT
      source_kind AS sourceKind,
      target_dirty_token AS targetDirtyToken,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      inserted_row_count AS insertedRowCount,
      source_scope_expected_row_count AS expectedRowCount,
      materialization_status AS materializationStatus,
      materialization_owner AS materializationOwner,
      lease_expires_at AS leaseExpiresAt
    FROM app.project_mart_dirty_materialization_state
    WHERE project_id = ${quoteSqlString(projectId)}
    ORDER BY target_dirty_token ASC, source_kind ASC
  `,
    workloadContext,
  )
}

const getQuarantineBarriers = async (projectId: string) => {
  return getAppDatabaseService().queryJson<QuarantineBarrierRow>(
    `
    SELECT
      article_id AS articleId,
      dirty_token AS dirtyToken,
      error,
      detected_by AS detectedBy,
      updated_at AS updatedAt
    FROM app.project_mart_dirty_refresh_article_quarantine
    WHERE project_id = ${quoteSqlString(projectId)}
      AND resolved_at IS NULL
    ORDER BY dirty_token ASC, article_id ASC
  `,
    workloadContext,
  )
}

const getLargeRebuildState = async (projectId: string) => {
  const [row] = await getAppDatabaseService().queryJson<LargeRebuildStateRow>(
    `
    SELECT
      refresh_token AS refreshToken,
      rebuild_phase AS rebuildPhase,
      refresh_status AS refreshStatus,
      target_generation AS targetGeneration,
      source_dirty_token AS sourceDirtyToken,
      source_high_water_dirty_token AS sourceHighWaterDirtyToken,
      superseded_at AS supersededAt,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt
    FROM app.project_mart_large_rebuild_state
    WHERE project_id = ${quoteSqlString(projectId)}
    LIMIT 1
  `,
    workloadContext,
  )

  return row ?? null
}

const getCount = async (statement: string) => {
  const [row] = await getAppDatabaseService().queryJson<CountRow>(statement, workloadContext)

  return toNumber(row?.count)
}

const getScopeArticleCount = async (projectId: string) => {
  return getCount(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT article_id
      FROM app.project_article
      WHERE project_id = ${quoteSqlString(projectId)}
      UNION
      SELECT air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${quoteSqlString(projectId)}
      UNION
      SELECT article_id
      FROM mart.project_scope_article
      WHERE project_id = ${quoteSqlString(projectId)}
    ) scope
  `)
}

const getDirtyArticleCount = async (projectId: string) => {
  return getCount(`
    SELECT COUNT(*) AS count
    FROM app.project_mart_refresh_article_state
    WHERE project_id = ${quoteSqlString(projectId)}
  `)
}

const getHasTrackedJudgmentJobs = async (projectId: string) => {
  const count = await getCount(`
    SELECT COUNT(*) AS count
    FROM app.judgment_job
    WHERE project_id = ${quoteSqlString(projectId)}
  `)

  return count > 0
}

const getBlockingMaterializationCount = (dirtyToken: number, rows: DirtyMaterializationRow[]) => {
  return rows.filter((row) => {
    return toNumber(row.targetDirtyToken) <= dirtyToken && row.materializationStatus !== 'completed'
  }).length
}

const getHasBlockingLargeRebuild = (dirtyToken: number, row: LargeRebuildStateRow | null) => {
  return row !== null && toNumber(row.refreshToken) >= dirtyToken && row.supersededAt === null
}

const getPlannedWork = ({
  blockingMaterializationCount,
  dirtyArticleCount,
  dirtyToken,
  largeRebuildState,
}: {
  blockingMaterializationCount: number
  dirtyArticleCount: number
  dirtyToken: number
  largeRebuildState: LargeRebuildStateRow | null
}) => {
  return blockingMaterializationCount > 0
    ? 'dirty-materialization'
    : getHasBlockingLargeRebuild(dirtyToken, largeRebuildState)
      ? 'large-rebuild'
      : dirtyArticleCount > 0
        ? 'dirty-refresh'
        : 'idle'
}

const getRiskSnapshot = async ({incrementalArticleThreshold, projectId}: CliOptions) => {
  const [refreshState, dirtyMaterializations, quarantineBarriers, largeRebuildState] = await Promise.all([
    getRefreshState(projectId),
    getDirtyMaterializations(projectId),
    getQuarantineBarriers(projectId),
    getLargeRebuildState(projectId),
  ])
  const [dirtyArticleCount, scopeArticleCount, hasTrackedJudgmentJobs] = await Promise.all([
    getDirtyArticleCount(projectId),
    getScopeArticleCount(projectId),
    getHasTrackedJudgmentJobs(projectId),
  ])
  const dirtyToken = toNumber(refreshState?.dirtyToken)
  const blockingMaterializationCount = getBlockingMaterializationCount(dirtyToken, dirtyMaterializations)
  const plannedRefreshMode = getDirtyRefreshExecutionMode({dirtyArticleCount, incrementalArticleThreshold})

  return {
    dirtyArticleCount,
    dirtyMaterialization: {
      blockingCount: blockingMaterializationCount,
      rows: dirtyMaterializations,
      totalCount: dirtyMaterializations.length,
    },
    dirtyToken,
    hasTrackedJudgmentJobs,
    largeRebuild: largeRebuildState,
    lastCompletedDirtyToken: toNumber(refreshState?.lastCompletedDirtyToken),
    leaseExpiresAt: refreshState?.leaseExpiresAt ?? null,
    plannedRefreshMode,
    plannedWork: getPlannedWork({blockingMaterializationCount, dirtyArticleCount, dirtyToken, largeRebuildState}),
    projectId,
    quarantine: {rows: quarantineBarriers, unresolvedBarrierCount: quarantineBarriers.length},
    refreshStatus: refreshState?.refreshStatus ?? null,
    scope: {articleCount: scopeArticleCount, dirtyArticleCount},
    scopeArticleCount,
    workerId: refreshState?.workerId ?? null,
  }
}

export const inspectDirtyRefreshRisk = async () => {
  const options = getCliOptions()

  await withDuckdbMaintenanceAccess('inspect dirty refresh risk', async () => {
    console.log(JSON.stringify(await getRiskSnapshot(options)))
  })
}

if (import.meta.main) {
  await inspectDirtyRefreshRisk()
}

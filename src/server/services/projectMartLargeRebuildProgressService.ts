import {getProjectMartLargeRebuildRuntimeMetrics} from '../utils/projectMartLargeRebuildRuntimeMetrics.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'

type ProjectMartLargeRebuildProgressDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

type ProjectMartLargeRebuildProgressState = {
  cursorArticleCreatedAt: string | null
  cursorArticleId: string | null
  rebuildPhase: string | null
}

type ProjectMartLargeRebuildScopeProgress = {
  remainingCurrentPhaseArticleCount: number | null
  scopeArticleCount: number
}

type ProjectMartLargeRebuildCycleMetric = ReturnType<
  typeof getProjectMartLargeRebuildRuntimeMetrics
>['recentCycles'][number]

export const largeRebuildPhaseOrder = [
  'project_scope_article',
  'judgment_fact',
  'prompt_answer_fact',
  'review_answer_dictionary',
  'review_article_filter_member',
  'review_article_rollup',
  'review_article_serving',
] as const

export const articleScopedLargeRebuildPhases = new Set<string>(largeRebuildPhaseOrder)

export const isArticleScopedLargeRebuildPhase = (phase: string | null | undefined) => {
  return phase === null || phase === undefined ? false : articleScopedLargeRebuildPhases.has(phase)
}

export const getProjectMartLargeRebuildPhaseIndex = (phase: string | null) => {
  return phase === null ? -1 : largeRebuildPhaseOrder.indexOf(phase as (typeof largeRebuildPhaseOrder)[number])
}

const getRemainingCurrentPhaseArticleCountSql = ({
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
          WHEN ${getSqlLiteral(cursorArticleId)} IS NULL THEN 1
          WHEN COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') > COALESCE(${getSqlLiteral(cursorArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') THEN 1
          WHEN COALESCE(${articleCreatedAtColumn}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') = COALESCE(${getSqlLiteral(cursorArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
            AND ${articleIdColumn} > ${getSqlLiteral(cursorArticleId)} THEN 1
          ELSE 0
        END
      ),
      0
    ) AS INTEGER
  )`
}

const getLiveProjectScopeProgressSql = (projectId: string, state: ProjectMartLargeRebuildProgressState) => {
  const projectLiteral = getSqlLiteral(projectId)

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
      ${getRemainingCurrentPhaseArticleCountSql({
        articleCreatedAtColumn: 'article.article_created_at',
        articleIdColumn: 'aggregated_scope.articleId',
        cursorArticleCreatedAt: state.cursorArticleCreatedAt,
        cursorArticleId: state.cursorArticleId,
      })} AS remainingCurrentPhaseArticleCount
    FROM aggregated_scope
    INNER JOIN app.article article ON article.id = aggregated_scope.articleId
  `
}

const getFrozenProjectScopeProgressSql = (projectId: string, state: ProjectMartLargeRebuildProgressState) => {
  return `
    SELECT
      CAST(COUNT(*) AS INTEGER) AS scopeArticleCount,
      ${getRemainingCurrentPhaseArticleCountSql({
        articleCreatedAtColumn: 'scope_article.article_created_at',
        articleIdColumn: 'scope_article.article_id',
        cursorArticleCreatedAt: state.cursorArticleCreatedAt,
        cursorArticleId: state.cursorArticleId,
      })} AS remainingCurrentPhaseArticleCount
    FROM mart.project_scope_article scope_article
    WHERE scope_article.project_id = ${getSqlLiteral(projectId)}
  `
}

const getProjectScopeProgressSql = (projectId: string, state: ProjectMartLargeRebuildProgressState) => {
  return state.rebuildPhase === 'project_scope_article'
    ? getLiveProjectScopeProgressSql(projectId, state)
    : getFrozenProjectScopeProgressSql(projectId, state)
}

const getBoundedArticleCount = (count: number, scopeArticleCount: number) => {
  return Math.max(0, Math.min(scopeArticleCount, count))
}

const getCycleCommittedRowCount = (cycle: ProjectMartLargeRebuildCycleMetric) => {
  return cycle.committedRowCount
}

const isCurrentPhaseCommittedCycle = ({
  cycle,
  projectId,
  rebuildPhase,
}: {
  cycle: ProjectMartLargeRebuildCycleMetric
  projectId: string
  rebuildPhase: string | null
}) => {
  return (
    cycle.projectId === projectId
    && cycle.phase === rebuildPhase
    && cycle.status === 'progressed'
    && cycle.lastCommittedCursor !== null
    && getCycleCommittedRowCount(cycle) > 0
  )
}

export const getProjectMartLargeRebuildRowsPerMs = ({
  projectId,
  rebuildPhase,
}: {
  projectId: string
  rebuildPhase: string | null
}) => {
  const cycles = isArticleScopedLargeRebuildPhase(rebuildPhase)
    ? getProjectMartLargeRebuildRuntimeMetrics()
        .recentCycles.filter((cycle) => {
          return isCurrentPhaseCommittedCycle({cycle, projectId, rebuildPhase})
        })
        .slice(-12)
    : []

  const totalRows = cycles.reduce((sum, cycle) => {
    return sum + getCycleCommittedRowCount(cycle)
  }, 0)
  const firstStartedAt = new Date(cycles[0]?.startedAt ?? '').getTime()
  const lastEndedAt = new Date(cycles[cycles.length - 1]?.endedAt ?? '').getTime()
  const totalDurationMs = cycles.reduce((sum, cycle) => {
    return sum + cycle.durationMs
  }, 0)
  const elapsedMs =
    Number.isFinite(firstStartedAt) && Number.isFinite(lastEndedAt)
      ? Math.max(lastEndedAt - firstStartedAt, totalDurationMs, 1)
      : Math.max(totalDurationMs, 1)

  return cycles.length === 0 || totalRows <= 0 ? null : totalRows / elapsedMs
}

export const getProjectMartLargeRebuildScopeProgress = async ({
  db = getAppDatabaseService(),
  projectId,
  state,
}: {
  db?: ProjectMartLargeRebuildProgressDatabase
  projectId: string
  state: ProjectMartLargeRebuildProgressState
}): Promise<ProjectMartLargeRebuildScopeProgress> => {
  const [row] = await db.queryJson<{remainingCurrentPhaseArticleCount: number; scopeArticleCount: number}>(
    getProjectScopeProgressSql(projectId, state),
  )
  const scopeArticleCount = Number(row?.scopeArticleCount ?? 0)
  const remainingCurrentPhaseArticleCount = isArticleScopedLargeRebuildPhase(state.rebuildPhase)
    ? getBoundedArticleCount(Number(row?.remainingCurrentPhaseArticleCount ?? scopeArticleCount), scopeArticleCount)
    : null

  return {remainingCurrentPhaseArticleCount, scopeArticleCount}
}

export type {ProjectMartLargeRebuildProgressState, ProjectMartLargeRebuildScopeProgress}

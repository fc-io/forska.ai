import {Elysia} from 'elysia'

import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  type ComparisonJudgmentContextSummary,
  getComparisonJudgmentContextsByIds,
} from '../../services/comparisonJudgmentContext.ts'
import type {DuckdbWorkloadContext} from '../../utils/duckdbService.ts'
import {comparisonProjectConflictResolutionTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {queueComparisonProjectServingRebuild} from './comparisonProjectServingRebuildQueue.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'

const comparisonProjectMetadataWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  routeOrJobKey: 'comparisonProjects.detail.metadata',
  workloadClass: 'foreground-metadata',
}

const comparisonProjectRoutesLoadedAt = new Date()
const pendingComparisonProjectServingRecoveryIds = new Set<string>()

const queueUnavailableComparisonProjectServingRebuild = (
  comparisonProject: Pick<
    ComparisonProjectScope,
    'activeGeneration' | 'archived' | 'id' | 'servingProgress' | 'servingStatus'
  >,
) => {
  if (comparisonProject.archived) {
    return
  }

  const latestProgressedAt =
    comparisonProject.servingProgress.lastProgressedAt ?? comparisonProject.servingProgress.startedAt
  const isMissingWithoutStartedBuild =
    comparisonProject.servingStatus === 'refreshing'
    && comparisonProject.activeGeneration === null
    && comparisonProject.servingProgress.generation === null
    && comparisonProject.servingProgress.startedAt === null
    && comparisonProject.servingProgress.lastProgressedAt === null
  const isStaleWithoutStartedBuild =
    comparisonProject.servingStatus === 'stale'
    && comparisonProject.servingProgress.startedAt === null
    && comparisonProject.servingProgress.lastProgressedAt === null
  const isRefreshingFromPreviousRouteLoad =
    comparisonProject.servingStatus === 'refreshing'
    && comparisonProject.servingProgress.generation !== null
    && latestProgressedAt !== null
    && latestProgressedAt < comparisonProjectRoutesLoadedAt
  const isFailedFromPreviousRouteLoad =
    comparisonProject.servingStatus === 'failed'
    && comparisonProject.servingProgress.failedAt !== null
    && comparisonProject.servingProgress.failedAt < comparisonProjectRoutesLoadedAt

  if (
    !isMissingWithoutStartedBuild
    && !isStaleWithoutStartedBuild
    && !isRefreshingFromPreviousRouteLoad
    && !isFailedFromPreviousRouteLoad
  ) {
    return
  }

  if (pendingComparisonProjectServingRecoveryIds.has(comparisonProject.id)) {
    return
  }

  pendingComparisonProjectServingRecoveryIds.add(comparisonProject.id)
  void queueComparisonProjectServingRebuild(comparisonProject.id).finally(() => {
    pendingComparisonProjectServingRecoveryIds.delete(comparisonProject.id)
  })
}

const getComparisonProjectResolutionCount = async (
  comparisonProjectId: string,
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  const [row] = await queryRunner.queryJson<{resolutionCount: unknown}>(`
    SELECT COUNT(*) AS resolutionCount
    FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)

  return Number(row?.resolutionCount ?? 0)
}

export const comparisonProjectsRoutesGetDetail = new Elysia().get('/api/comparison-projects/:id', async (context) => {
  const {params, set} = context
  const detail: {
    data: ComparisonProjectScope
    judgmentContext: ComparisonJudgmentContextSummary | null
    resolutionCount: number
  } | null = await appDatabaseService.transaction(async (tx) => {
    const data = await getComparisonProjectScope(params.id, tx)

    if (!data) {
      return null
    }

    const resolutionCount = await getComparisonProjectResolutionCount(params.id, tx)
    const [judgmentContext = null] = data.judgmentContextId
      ? await getComparisonJudgmentContextsByIds(tx, [data.judgmentContextId])
      : []

    return {data, judgmentContext, resolutionCount}
  }, comparisonProjectMetadataWorkloadContext)

  if (!detail) {
    set.status = 404
    return {data: null, error: 'Comparison project not found'}
  }

  const {data, judgmentContext, resolutionCount} = detail

  queueUnavailableComparisonProjectServingRebuild(data)

  return {data: {...data, judgmentContext, resolutionCount}}
})

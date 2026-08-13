import {Elysia, t} from 'elysia'

import {
  getReviewServingDiagnostics,
  type ReviewServingDiagnostics,
} from '../../reviewServing/reviewServingDiagnosticsRepository.ts'
import {
  getActiveOrLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingSnapshotManifest,
} from '../../reviewServing/reviewServingManifestRepository.ts'
import {promoteReviewServingProjectorSnapshot} from '../../reviewServing/reviewServingProjectorWriter.ts'
import {readReviewServingRows} from '../../reviewServing/reviewServingReader.ts'
import {requestReviewServingV4Rebuild} from '../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {getActiveDuckdbExclusiveWorkSnapshot} from '../../utils/duckdbExclusiveWork.ts'
import type {DuckdbWorkloadContext} from '../../utils/duckdbService.ts'
import {isReviewServingProjectorPaused} from '../../utils/reviewServingProjectorPause.ts'
import {shouldDisableServerMutationWork} from '../../utils/serverMutationMode.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

type ReviewsIndexingBlockedReason =
  | 'duckdb_exclusive_work_active'
  | 'operator_intervention_required'
  | 'paused_by_policy'
  | 'quarantine_barrier'
  | 'waiting_for_maintenance_worker'
  | null
type ReviewsIndexingMaintenanceStatus = 'blocked' | 'failed' | 'idle' | 'processing'
type ReviewsIndexingProgressState = 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'
type ReviewsIndexingStatus = 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'

const recentReviewServingProgressWindowMs = 120_000
const reviewServingProgressClockSkewToleranceMs = 10_000
const foregroundReviewServingRepairPriority = 1_000
const stalledForegroundReviewServingRepairPriority = 10_000

const getReviewWarningsWorkloadContext = (projectId: string, operation: string): DuckdbWorkloadContext => {
  return {
    fallbackIntent: 'serveStale',
    maxResultRows: 64,
    projectId,
    routeOrJobKey: `review.warnings.${operation}`,
    workloadClass: 'foreground-diagnostic',
  }
}

const getReviewWarningsScopeState = async (projectId: string) => {
  const [martScope] = await getApiReadOnlyAppDatabaseService().queryJson<{totalArticleCount: number}>(
    `
    SELECT CAST(COUNT(DISTINCT scope.article_id) AS INTEGER) AS totalArticleCount
    FROM mart.project_scope_article scope
    WHERE scope.project_id = '${escapeSqlString(projectId)}'
      AND (scope.in_curated_scope OR scope.in_route_scope)
  `,
    getReviewWarningsWorkloadContext(projectId, 'scopeMartState'),
  )
  const martScopeArticleCount = Number(martScope?.totalArticleCount ?? 0)
  const [state] = await getApiReadOnlyAppDatabaseService().queryJson<{
    enabledPromptCount: number
    hasAnyArticlesInScope: boolean
    totalArticleCount?: number
  }>(
    martScopeArticleCount > 0
      ? `
    SELECT
      CAST((
        SELECT COUNT(*)
        FROM app.project_prompt project_prompt
        INNER JOIN app.prompt prompt
          ON prompt.id = project_prompt.prompt_id
        WHERE project_prompt.project_id = '${escapeSqlString(projectId)}'
          AND project_prompt.enabled = TRUE
          AND NOT project_prompt.archived
          AND COALESCE(prompt.archived, FALSE) = FALSE
      ) AS INTEGER) AS enabledPromptCount,
      TRUE AS hasAnyArticlesInScope
  `
      : `
    WITH enabled_prompt AS (
      SELECT COUNT(*) AS enabledPromptCount
      FROM app.project_prompt project_prompt
      INNER JOIN app.prompt prompt
        ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.project_id = '${escapeSqlString(projectId)}'
        AND project_prompt.enabled = TRUE
        AND NOT project_prompt.archived
        AND COALESCE(prompt.archived, FALSE) = FALSE
    ), scoped_article AS (
      SELECT pa.article_id AS articleId
      FROM app.project_article pa
      INNER JOIN app.project p ON p.id = pa.project_id
      INNER JOIN app.article a ON a.id = pa.article_id
      WHERE pa.project_id = '${escapeSqlString(projectId)}'
        AND (p.date_from IS NULL OR a.article_created_at >= p.date_from)
        AND (p.date_to IS NULL OR a.article_created_at <= p.date_to)
      UNION ALL
      SELECT air.article_id AS articleId
      FROM app.project_import_route pir
      INNER JOIN app.project p ON p.id = pir.project_id
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      INNER JOIN app.article a ON a.id = air.article_id
      WHERE pir.project_id = '${escapeSqlString(projectId)}'
        AND (p.date_from IS NULL OR a.article_created_at >= p.date_from)
        AND (p.date_to IS NULL OR a.article_created_at <= p.date_to)
    )
    SELECT
      CAST((SELECT enabledPromptCount FROM enabled_prompt) AS INTEGER) AS enabledPromptCount,
      EXISTS (SELECT 1 FROM scoped_article) AS hasAnyArticlesInScope,
      CAST((SELECT COUNT(DISTINCT articleId) FROM scoped_article) AS INTEGER) AS totalArticleCount
  `,
    getReviewWarningsWorkloadContext(projectId, 'scopeState'),
  )

  return {
    enabledPromptCount: Number(state?.enabledPromptCount ?? 0),
    hasAnyArticlesInScope: state?.hasAnyArticlesInScope ?? false,
    totalArticleCount: martScopeArticleCount > 0 ? martScopeArticleCount : Number(state?.totalArticleCount ?? 0),
  }
}

const getReviewWarningsComponentState = (
  manifest: ReviewServingSnapshotManifest | null,
  component: 'payload' | 'search',
) => {
  return [...(manifest?.componentState.required ?? []), ...(manifest?.componentState.optional ?? [])].find((state) => {
    return state.component === component
  })
}

const getReviewWarningsComponentCanMaterialize = (
  manifest: ReviewServingSnapshotManifest | null,
  component: 'payload' | 'search',
) => {
  return (
    manifest?.optionalComponents.includes(component) === true
    || getReviewWarningsComponentState(manifest, component) !== undefined
  )
}

const legacyRequiredBootstrapEnrichmentComponents = ['judgmentInputContent', 'payload', 'search'] as const

const getHasLegacyRequiredBootstrapEnrichmentCandidate = async (input: {
  projectId: string
  reviewConfigHash: string | null
}) => {
  const [row] = await getApiReadOnlyAppDatabaseService().queryJson<{count: number}>(
    `
    SELECT CAST(COUNT(*) AS INTEGER) AS count
    FROM app.review_serving_snapshot_manifest snapshot,
      json_each(snapshot.required_components_json) required_component
    WHERE snapshot.project_id = '${escapeSqlString(input.projectId)}'
      AND snapshot.review_config_hash IS NOT DISTINCT FROM ${
        input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
      }
      AND snapshot.snapshot_status = 'candidate'
      AND json_extract_string(required_component.value, '$') IN (${legacyRequiredBootstrapEnrichmentComponents
        .map((component) => {
          return `'${component}'`
        })
        .join(', ')})
    `,
    getReviewWarningsWorkloadContext(input.projectId, 'legacyCandidateEnrichmentState'),
  )

  return Number(row?.count ?? 0) > 0
}

const getLatestCandidateSnapshotId = async (input: {projectId: string; reviewConfigHash: string | null}) => {
  const [row] = await getApiReadOnlyAppDatabaseService().queryJson<{snapshotId: string}>(
    `
    SELECT snapshot_id AS snapshotId
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = '${escapeSqlString(input.projectId)}'
      AND review_config_hash IS NOT DISTINCT FROM ${
        input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
      }
      AND snapshot_status = 'candidate'
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    getReviewWarningsWorkloadContext(input.projectId, 'candidateSnapshot'),
  )

  return row?.snapshotId ?? null
}

const getReviewsWarningsCoverage = async (input: {
  manifest: ReviewServingSnapshotManifest | null
  projectId: string
  reviewConfigHash: string | null
  totalArticleCount: number
}) => {
  const snapshotId = input.manifest?.snapshotId ?? null

  if (snapshotId === null) {
    return {
      detailReadyArticleCount: null,
      reviewPageReadyArticleCount: 0,
      searchReadyArticleCount: null,
      totalArticleCount: input.totalArticleCount,
    }
  }

  const canMaterializePayload = getReviewWarningsComponentCanMaterialize(input.manifest, 'payload')
  const canMaterializeSearch = getReviewWarningsComponentCanMaterialize(input.manifest, 'search')
  const searchComponentState = getReviewWarningsComponentState(input.manifest, 'search')
  const [coverage] = await getApiReadOnlyAppDatabaseService().queryJson<{
    detailReadyArticleCount: number | null
    reviewPageReadyArticleCount: number
    searchReadyArticleCount: number | null
  }>(
    `
    SELECT
      CAST((
        SELECT COUNT(DISTINCT serving.article_id)
        FROM mart.review_article_serving_base_v4 serving
        WHERE serving.project_id = '${escapeSqlString(input.projectId)}'
          AND serving.review_config_hash IS NOT DISTINCT FROM ${
            input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
          }
          AND serving.snapshot_id = '${escapeSqlString(snapshotId)}'
      ) AS INTEGER) AS reviewPageReadyArticleCount,
      ${
        !canMaterializePayload
          ? 'NULL'
          : `CAST((
              SELECT COUNT(DISTINCT detail.article_id)
              FROM mart.review_article_judgment_detail_serving_v4 detail
              WHERE detail.project_id = '${escapeSqlString(input.projectId)}'
                AND detail.review_config_hash IS NOT DISTINCT FROM ${
                  input.reviewConfigHash === null ? 'NULL' : `'${escapeSqlString(input.reviewConfigHash)}'`
                }
                AND detail.snapshot_id = '${escapeSqlString(snapshotId)}'
            ) AS INTEGER)`
      } AS detailReadyArticleCount,
      ${
        !canMaterializeSearch
          ? 'NULL'
          : `CAST((
              WITH latest_search_request AS (
                SELECT request.request_id
                FROM app.review_rebuild_request request
                WHERE request.project_id = '${escapeSqlString(input.projectId)}'
                  AND request.admission_state = 'admitted'
                  AND request.status IN ('admitted', 'running')
                  AND EXISTS (
                    SELECT 1
                    FROM app.review_rebuild_chunk_manifest request_chunk
                    WHERE request_chunk.request_id IS NOT DISTINCT FROM request.request_id
                      AND request_chunk.project_id IS NOT DISTINCT FROM request.project_id
                      AND request_chunk.projection_component = 'search'
                  )
                ORDER BY request.priority DESC, request.updated_at DESC, request.request_id DESC
                LIMIT 1
              )
              SELECT COALESCE((
                WITH completed_search_range AS (
                  SELECT search_chunk.chunk_start_key, search_chunk.chunk_end_key
                  FROM app.review_rebuild_chunk_manifest search_chunk
                  INNER JOIN latest_search_request
                    ON latest_search_request.request_id IS NOT DISTINCT FROM search_chunk.request_id
                  WHERE search_chunk.project_id = '${escapeSqlString(input.projectId)}'
                    AND search_chunk.projection_component = 'search'
                    ${
                      searchComponentState?.projectionIdentity === undefined
                        ? ''
                        : `AND search_chunk.projection_identity = '${escapeSqlString(searchComponentState.projectionIdentity)}'`
                    }
                    AND search_chunk.status = 'completed'
                    AND NOT EXISTS (
                      SELECT 1
                      FROM app.review_rebuild_chunk_manifest child_chunk
                      WHERE child_chunk.parent_chunk_id IS NOT DISTINCT FROM search_chunk.chunk_id
                        AND child_chunk.project_id IS NOT DISTINCT FROM search_chunk.project_id
                    )
                )
                SELECT CASE
                  WHEN NOT EXISTS (SELECT 1 FROM latest_search_request) THEN ${input.totalArticleCount}
                  ELSE (
                    SELECT COUNT(DISTINCT scope.article_id)
                    FROM mart.project_scope_article scope
                    WHERE scope.project_id = '${escapeSqlString(input.projectId)}'
                      AND (scope.in_curated_scope OR scope.in_route_scope)
                      AND EXISTS (
                        SELECT 1
                        FROM completed_search_range search_range
                        WHERE scope.article_id >= search_range.chunk_start_key
                          AND scope.article_id <= search_range.chunk_end_key
                      )
                  )
                END
              ), ${input.totalArticleCount})
            ) AS INTEGER)`
      } AS searchReadyArticleCount
    `,
    getReviewWarningsWorkloadContext(input.projectId, 'coverage'),
  )

  return {
    detailReadyArticleCount:
      coverage?.detailReadyArticleCount === null || coverage?.detailReadyArticleCount === undefined
        ? null
        : Number(coverage.detailReadyArticleCount),
    reviewPageReadyArticleCount: Number(coverage?.reviewPageReadyArticleCount ?? 0),
    searchReadyArticleCount:
      coverage?.searchReadyArticleCount === null || coverage?.searchReadyArticleCount === undefined
        ? null
        : Number(coverage.searchReadyArticleCount),
    totalArticleCount: input.totalArticleCount,
  }
}

const getLatestTimestamp = (...values: Array<string | null>) => {
  const timestampValues = values.filter((value): value is string => {
    return typeof value === 'string' && value !== ''
  })

  return timestampValues.reduce<string | null>((latestValue, value) => {
    if (latestValue === null) {
      return value
    }

    return new Date(value).getTime() > new Date(latestValue).getTime() ? value : latestValue
  }, null)
}

const getOldestTimestamp = (...values: Array<string | null>) => {
  const timestampValues = values.filter((value): value is string => {
    return typeof value === 'string' && value !== ''
  })

  return timestampValues.reduce<string | null>((oldestValue, value) => {
    if (oldestValue === null) {
      return value
    }

    return new Date(value).getTime() < new Date(oldestValue).getTime() ? value : oldestValue
  }, null)
}

const getHasRecentReviewServingProgress = (value: string | null) => {
  const progressedAtMs = new Date(value ?? Number.NaN).getTime()
  const progressAgeMs = Date.now() - progressedAtMs

  return (
    Number.isFinite(progressedAtMs)
    && progressAgeMs >= -reviewServingProgressClockSkewToleranceMs
    && progressAgeMs <= recentReviewServingProgressWindowMs
  )
}

const getNonNegativeDifference = (total: number, claimed: number) => {
  return Math.max(0, total - claimed)
}

const getHasReviewServingStateThatCanProgress = (diagnostics: ReviewServingDiagnostics) => {
  return (
    diagnostics.dirtyWork.failedCount
      + diagnostics.dirtyWork.pendingCount
      + diagnostics.dirtyWork.runningCount
      + diagnostics.quarantine.unresolvedOutboxCount
      + diagnostics.rebuildChunks.blockedOverBudgetCount
      + diagnostics.rebuildChunks.failedCount
      + diagnostics.rebuildChunks.pendingCount
      + diagnostics.rebuildChunks.quarantinedCount
      + diagnostics.rebuildChunks.runningCount
      + diagnostics.snapshot.activeCount
    > 0
  )
}

const getHasPendingReviewServingWork = (diagnostics: ReviewServingDiagnostics) => {
  return (
    diagnostics.dirtyWork.pendingCount
      + diagnostics.dirtyWork.runningCount
      + diagnostics.rebuildChunks.pendingCount
      + diagnostics.rebuildChunks.runningCount
    > 0
  )
}

const getReviewsIndexingMaintenanceStatus = (params: {
  hasActionableFailures: boolean
  hasBlockedLiveWork: boolean
  hasLiveRefreshWork: boolean
}): ReviewsIndexingMaintenanceStatus => {
  return params.hasActionableFailures
    ? 'failed'
    : params.hasBlockedLiveWork
      ? 'blocked'
      : params.hasLiveRefreshWork
        ? 'processing'
        : 'idle'
}

const getReviewsIndexingStatus = (params: {
  enabledPromptCount: number
  hasActionableFailures: boolean
  hasAnyArticlesInScope: boolean
  hasBlockedCandidateSnapshot: boolean
  hasReviewServingRows: boolean
  isReviewServingProjectorPaused: boolean
  isServerMutationWorkDisabled: boolean
  pendingRefreshCount: number
  runningRefreshCount: number
}): ReviewsIndexingStatus => {
  const shouldIndexReviews = params.enabledPromptCount > 0 && params.hasAnyArticlesInScope

  if (!shouldIndexReviews) {
    return 'not-needed'
  }

  if (params.hasActionableFailures) {
    return 'failed'
  }

  if (
    (params.isReviewServingProjectorPaused
      && (!params.hasReviewServingRows || params.pendingRefreshCount > 0 || params.runningRefreshCount > 0))
    || params.hasBlockedCandidateSnapshot
    || (params.isServerMutationWorkDisabled && params.pendingRefreshCount > 0 && params.runningRefreshCount === 0)
  ) {
    return 'blocked'
  }

  if (params.pendingRefreshCount > 0) {
    return 'refreshing'
  }

  return params.hasReviewServingRows ? 'ready' : 'stale'
}

const getReviewsIndexingProgressState = (params: {
  claimableRefreshCount: number
  hasRecentProgress: boolean
  inFlightRefreshCount: number
  status: ReviewsIndexingStatus
}): ReviewsIndexingProgressState => {
  return params.status === 'ready' || params.status === 'not-needed'
    ? 'completed'
    : params.status === 'failed'
      ? 'failed'
      : params.status === 'blocked'
        ? 'blocked'
        : params.status === 'refreshing' && params.inFlightRefreshCount > 0
          ? 'processing'
          : params.status === 'refreshing' && params.hasRecentProgress
            ? 'processing'
            : params.status === 'refreshing' && params.claimableRefreshCount > 0
              ? 'queued'
              : 'stalled'
}

const isUsableReviewServingWarningSnapshot = (status: string) => {
  return status === 'active' || status === 'retired'
}

export const projectsRoutesGetReviewsWarnings = new Elysia().post(
  '/api/projectsreviewswarnings',
  async ({body}) => {
    const projectId = body.projectId
    await assertProjectIsActive(projectId, getReviewWarningsWorkloadContext(projectId, 'projectAccess'))
    const routeDiagnosticWorkloadContext = getReviewWarningsWorkloadContext(projectId, 'servingDiagnostics')
    const reviewConfigHash = await getCurrentReviewConfigHash(projectId, {
      database: getApiReadOnlyAppDatabaseService(),
      workloadContext: getReviewWarningsWorkloadContext(projectId, 'reviewConfigHash'),
    })
    const warningSnapshot = await readReviewServingRows({
      allowStale: true,
      contractKey: 'review.warning.snapshot',
      estimatedResultRows: 1,
      limit: 1,
      metadataOnly: true,
      projectId,
      routeDiagnosticWorkloadContext,
      reviewConfigHash,
    })
    const {enabledPromptCount, hasAnyArticlesInScope, totalArticleCount} = await getReviewWarningsScopeState(projectId)
    const coverageManifest = await getActiveOrLastKnownGoodReviewServingSnapshotManifest({
      projectId,
      reviewConfigHash,
      workloadContext: getReviewWarningsWorkloadContext(projectId, 'coverageManifest'),
    })
    const coverage = await getReviewsWarningsCoverage({
      manifest: coverageManifest,
      projectId,
      reviewConfigHash,
      totalArticleCount,
    })
    const servingDiagnostics =
      warningSnapshot.diagnostics.diagnostics
      ?? (await getReviewServingDiagnostics({
        projectId,
        reviewConfigHash,
        workloadContext: routeDiagnosticWorkloadContext,
      }))
    const hasReviewServingRows =
      warningSnapshot.status === 'accepted'
      && isUsableReviewServingWarningSnapshot(warningSnapshot.diagnostics.manifest.status)
    const hasReadableReviewServingRows = hasReviewServingRows
    const pendingCandidateSnapshotActivationCount = hasReadableReviewServingRows
      ? 0
      : getNonNegativeDifference(
          servingDiagnostics.snapshot.candidateCount,
          servingDiagnostics.snapshot.invalidCandidateCount,
        )
    const shouldPrioritizeMissingSnapshotRepair =
      !hasReadableReviewServingRows && enabledPromptCount > 0 && hasAnyArticlesInScope
    const expiredRebuildChunkLeaseCount = Math.min(
      servingDiagnostics.rebuildChunks.runningCount,
      servingDiagnostics.rebuildChunks.expiredLeaseCount,
    )
    const lastProgressedAt = getLatestTimestamp(
      servingDiagnostics.dirtyWork.updatedAt,
      servingDiagnostics.rebuildChunks.updatedAt,
      servingDiagnostics.snapshot.activeUpdatedAt,
    )
    const isServerMutationWorkDisabled = shouldDisableServerMutationWork()
    const reviewServingProjectorPaused = isReviewServingProjectorPaused()
    const activeDuckdbExclusiveWork = getActiveDuckdbExclusiveWorkSnapshot()
    const queuedRebuildChunkCount = servingDiagnostics.rebuildChunks.claimableCount
    const totalQueuedRebuildChunkCount = servingDiagnostics.rebuildChunks.pendingCount + expiredRebuildChunkLeaseCount
    const inFlightRebuildChunkCount = getNonNegativeDifference(
      servingDiagnostics.rebuildChunks.runningCount,
      expiredRebuildChunkLeaseCount,
    )

    const hasRecentProgress = getHasRecentReviewServingProgress(lastProgressedAt)
    const hasReviewServingStateThatCanProgress = getHasReviewServingStateThatCanProgress(servingDiagnostics)
    const hasPendingReviewServingWork = getHasPendingReviewServingWork(servingDiagnostics)
    const hasPendingCandidateSnapshotActivationWork =
      pendingCandidateSnapshotActivationCount > 0 && hasPendingReviewServingWork
    const shouldAttemptCandidatePromotion =
      !isServerMutationWorkDisabled
      && !reviewServingProjectorPaused
      && shouldPrioritizeMissingSnapshotRepair
      && servingDiagnostics.snapshot.candidateCount > 0
    if (shouldAttemptCandidatePromotion) {
      const candidateSnapshotId = await getLatestCandidateSnapshotId({projectId, reviewConfigHash})
      if (candidateSnapshotId !== null) {
        await promoteReviewServingProjectorSnapshot({
          projectId,
          reviewConfigHash,
          snapshotId: candidateSnapshotId,
        }).catch(() => {
          return undefined
        })
      }
    }
    const hasLegacyRequiredBootstrapEnrichmentCandidate = hasPendingCandidateSnapshotActivationWork
      ? await getHasLegacyRequiredBootstrapEnrichmentCandidate({projectId, reviewConfigHash})
      : false
    const hasStalePendingCandidateActivationWork =
      pendingCandidateSnapshotActivationCount > 0
      && !hasRecentProgress
      && servingDiagnostics.rebuildChunks.claimableCount > 0
    const shouldRequestForegroundRepair =
      !isServerMutationWorkDisabled
      && !reviewServingProjectorPaused
      && shouldPrioritizeMissingSnapshotRepair
      && (pendingCandidateSnapshotActivationCount === 0
        || hasStalePendingCandidateActivationWork
        || hasLegacyRequiredBootstrapEnrichmentCandidate)
      && (!hasRecentProgress || hasLegacyRequiredBootstrapEnrichmentCandidate)
      && (!hasReviewServingStateThatCanProgress || hasPendingReviewServingWork)

    if (shouldRequestForegroundRepair) {
      const priority = hasRecentProgress
        ? foregroundReviewServingRepairPriority
        : stalledForegroundReviewServingRepairPriority
      await requestReviewServingV4Rebuild({priority, projectId, reason: 'missingReviewServingSnapshot'}).catch(() => {
        return undefined
      })
    }

    const pendingRebuildChunkCount = totalQueuedRebuildChunkCount + inFlightRebuildChunkCount
    const terminalRebuildChunkCount =
      servingDiagnostics.rebuildChunks.blockedOverBudgetCount
      + servingDiagnostics.rebuildChunks.failedCount
      + servingDiagnostics.rebuildChunks.quarantinedCount
    const terminalDirtyWorkCount = servingDiagnostics.dirtyWork.failedCount
    const terminalQuarantineCount = servingDiagnostics.quarantine.quarantinedOutboxCount
    const pendingDirtyWorkCount =
      servingDiagnostics.dirtyWork.pendingCount
      + servingDiagnostics.dirtyWork.runningCount
      + servingDiagnostics.quarantine.retryableOutboxCount
    const queuedRefreshCount = queuedRebuildChunkCount + servingDiagnostics.dirtyWork.pendingCount
    const inFlightRefreshCount = inFlightRebuildChunkCount + servingDiagnostics.dirtyWork.runningCount
    const pendingRefreshCount =
      pendingRebuildChunkCount + pendingDirtyWorkCount + pendingCandidateSnapshotActivationCount
    const claimableRefreshCount = queuedRebuildChunkCount + servingDiagnostics.dirtyWork.pendingCount
    const eligibleConsumerCount =
      claimableRefreshCount > 0
      && !isServerMutationWorkDisabled
      && !reviewServingProjectorPaused
      && activeDuckdbExclusiveWork === null
        ? 1
        : 0
    const hasBlockedCandidateSnapshot =
      servingDiagnostics.snapshot.invalidCandidateCount > 0 && pendingRebuildChunkCount === 0
    const hasLiveRefreshWork = pendingRefreshCount > 0 || inFlightRefreshCount > 0 || claimableRefreshCount > 0
    const hasHistoricalMaintenanceFailures =
      terminalRebuildChunkCount + terminalDirtyWorkCount + terminalQuarantineCount > 0
    const hasActionableMaintenanceFailures =
      hasHistoricalMaintenanceFailures && (!hasReviewServingRows || (terminalQuarantineCount > 0 && hasLiveRefreshWork))
    const hasBlockedLiveMaintenanceWork =
      hasLiveRefreshWork
      && (reviewServingProjectorPaused
        || isServerMutationWorkDisabled
        || activeDuckdbExclusiveWork !== null
        || hasBlockedCandidateSnapshot
        || terminalQuarantineCount > 0)
    const maintenanceStatus = getReviewsIndexingMaintenanceStatus({
      hasActionableFailures: hasActionableMaintenanceFailures,
      hasBlockedLiveWork: hasBlockedLiveMaintenanceWork,
      hasLiveRefreshWork,
    })
    const baseIndexingStatus = getReviewsIndexingStatus({
      enabledPromptCount,
      hasActionableFailures: hasActionableMaintenanceFailures,
      hasAnyArticlesInScope,
      hasBlockedCandidateSnapshot,
      hasReviewServingRows,
      isReviewServingProjectorPaused: reviewServingProjectorPaused,
      isServerMutationWorkDisabled,
      pendingRefreshCount,
      runningRefreshCount: inFlightRefreshCount,
    })
    const shouldBlockForDuckdbExclusiveWork =
      activeDuckdbExclusiveWork !== null
      && enabledPromptCount > 0
      && hasAnyArticlesInScope
      && (pendingRefreshCount > 0 || !hasReviewServingRows)
    const indexingStatus = shouldBlockForDuckdbExclusiveWork ? 'blocked' : baseIndexingStatus
    const hasRecentVisibleProgress =
      pendingRefreshCount > 0 && inFlightRefreshCount === 0 && eligibleConsumerCount > 0 && hasRecentProgress
    const progressState = getReviewsIndexingProgressState({
      claimableRefreshCount,
      hasRecentProgress: hasRecentVisibleProgress,
      inFlightRefreshCount,
      status: indexingStatus,
    })
    const blockedReason: ReviewsIndexingBlockedReason = shouldBlockForDuckdbExclusiveWork
      ? 'duckdb_exclusive_work_active'
      : indexingStatus === 'failed' && servingDiagnostics.quarantine.quarantinedOutboxCount > 0
        ? 'quarantine_barrier'
        : indexingStatus === 'blocked' && hasBlockedCandidateSnapshot
          ? 'operator_intervention_required'
          : indexingStatus === 'blocked' && reviewServingProjectorPaused
            ? 'paused_by_policy'
            : indexingStatus === 'blocked' && isServerMutationWorkDisabled
              ? 'waiting_for_maintenance_worker'
              : null
    return {
      data: {
        projectId,
        enabledPromptCount,
        scope: {hasAnyArticlesInScope},
        indexing: {
          activeConsumerCount: inFlightRefreshCount > 0 || hasRecentVisibleProgress ? 1 : 0,
          activeWorkCount: inFlightRefreshCount,
          articleRefreshesPerMinute: null,
          blockedReason,
          cleanup: {inFlightGenerationCleanupCount: 0, lastProgressedAt: null},
          coverage,
          eligibleConsumerCount,
          eligibleConsumerPresent: eligibleConsumerCount > 0,
          inFlightArticleRefreshCount: 0,
          inFlightProjectRefreshCount: inFlightRefreshCount,
          inFlightRefreshCount,
          lastProgressedAt,
          lastProcessedAt: servingDiagnostics.snapshot.activeUpdatedAt,
          lastStartedAt: null,
          maintenance: {
            hasActionableFailures: hasActionableMaintenanceFailures,
            hasHistoricalFailures: hasHistoricalMaintenanceFailures,
            status: maintenanceStatus,
            terminalDirtyWorkCount,
            terminalQuarantineCount,
            terminalRebuildChunkCount,
          },
          oldestQueuedAt: getOldestTimestamp(
            servingDiagnostics.dirtyWork.oldestQueuedAt,
            servingDiagnostics.rebuildChunks.oldestQueuedAt,
          ),
          pendingArticleRefreshCount: 0,
          pendingProjectRefreshCount: pendingRefreshCount,
          pendingRefreshCount,
          projectRefreshesPerMinute: null,
          queuedArticleRefreshCount: 0,
          queuedProjectRefreshCount: queuedRefreshCount,
          queuedRefreshCount,
          quarantinedArticleRefreshCount: 0,
          quarantinedArticles: [],
          progressState,
          recoveryContext: null,
          recoveryMode: 'none',
          requiredConsumerRole: 'maintenance-worker',
          retryAfterAt: null,
          search: servingDiagnostics.search,
          serving: {
            diagnostics: servingDiagnostics,
            manifest: warningSnapshot.diagnostics.manifest,
            readable: hasReadableReviewServingRows,
            usable: hasReviewServingRows,
          },
          status: indexingStatus,
        },
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)

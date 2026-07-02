import {Elysia, t} from 'elysia'

import {
  getReviewServingDiagnostics,
  type ReviewServingDiagnostics,
} from '../../reviewServing/reviewServingDiagnosticsRepository.ts'
import {readReviewServingRows} from '../../reviewServing/reviewServingReader.ts'
import {boostActiveReviewServingRebuildRequestForProject} from '../../reviewServing/reviewServingRebuildRequestRepository.ts'
import {requestReviewServingV4Rebuild} from '../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {shouldDisableServerMutationWork} from '../../utils/serverMutationMode.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

type ReviewsIndexingBlockedReason = 'paused_by_policy' | 'quarantine_barrier' | 'waiting_for_maintenance_worker' | null
type ReviewsIndexingProgressState = 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'
type ReviewsIndexingStatus = 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'

const recentReviewServingProgressWindowMs = 120_000
const reviewServingProgressClockSkewToleranceMs = 10_000
const foregroundReviewServingRepairPriority = 1_000
const stalledForegroundReviewServingRepairPriority = 10_000

const getEnabledPromptCount = async (projectId: string): Promise<number> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = '${escapeSqlString(projectId)}'
      AND project_prompt.enabled = TRUE
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
  `)

  return Number(rows[0]?.count ?? 0)
}

const getHasArticlesInScope = async (projectId: string): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{articleId: string}>(`
    WITH scoped_article AS (
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
    SELECT articleId
    FROM scoped_article
    LIMIT 1
  `)

  return rows.length > 0
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
      + diagnostics.snapshot.candidateCount
    > 0
  )
}

const getReviewsIndexingStatus = (params: {
  enabledPromptCount: number
  hasAnyArticlesInScope: boolean
  hasQuarantineBarrier: boolean
  hasReviewServingRows: boolean
  hasTerminalV4Work: boolean
  isServerMutationWorkDisabled: boolean
  pendingRefreshCount: number
  runningRefreshCount: number
}): ReviewsIndexingStatus => {
  const shouldIndexReviews = params.enabledPromptCount > 0 && params.hasAnyArticlesInScope

  return !shouldIndexReviews
    ? 'not-needed'
    : params.hasQuarantineBarrier
      ? 'failed'
      : params.hasTerminalV4Work
        ? 'failed'
        : params.isServerMutationWorkDisabled && params.pendingRefreshCount > 0 && params.runningRefreshCount === 0
          ? 'blocked'
          : params.pendingRefreshCount > 0 && params.runningRefreshCount > 0
            ? 'refreshing'
            : params.pendingRefreshCount > 0
              ? 'refreshing'
              : params.hasReviewServingRows
                ? 'ready'
                : 'stale'
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

const getEmptyRuntimeDiagnostics = () => {
  return {
    duckdbQueues: {
      background: {
        lastDurationMs: null,
        lastWaitMs: null,
        maxQueueDepth: 0,
        queueDepth: 0,
        tasksCompleted: 0,
        tasksStarted: 0,
        totalDurationMs: 0,
        totalWaitMs: 0,
      },
      main: {
        lastDurationMs: null,
        lastWaitMs: null,
        maxQueueDepth: 0,
        queueDepth: 0,
        tasksCompleted: 0,
        tasksStarted: 0,
        totalDurationMs: 0,
        totalWaitMs: 0,
      },
    },
    largeRebuild: {currentPhase: null, lastCycle: null},
    processMemory: {rssBytes: process.memoryUsage().rss},
    tempSpill: {available: false, error: null, fileCount: null, tempDirectory: null, totalBytes: null},
  }
}

export const projectsRoutesGetReviewsWarnings = new Elysia().post(
  '/api/projectsreviewswarnings',
  async ({body}) => {
    const projectId = body.projectId
    await assertProjectIsActive(projectId)
    const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
    const [servingDiagnostics, warningSnapshot, enabledPromptCount, hasAnyArticlesInScope] = await Promise.all([
      getReviewServingDiagnostics({projectId, reviewConfigHash}),
      readReviewServingRows({
        allowStale: true,
        contractKey: 'review.warning.snapshot',
        estimatedResultRows: 1,
        limit: 1,
        projectId,
        reviewConfigHash,
      }),
      getEnabledPromptCount(projectId),
      getHasArticlesInScope(projectId),
    ])
    const hasReviewServingRows =
      warningSnapshot.status === 'accepted'
      && isUsableReviewServingWarningSnapshot(warningSnapshot.diagnostics.manifest.status)
    const hasReadableReviewServingRows = hasReviewServingRows
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
    const queuedRebuildChunkCount = servingDiagnostics.rebuildChunks.claimableCount
    const totalQueuedRebuildChunkCount = servingDiagnostics.rebuildChunks.pendingCount + expiredRebuildChunkLeaseCount
    const inFlightRebuildChunkCount = getNonNegativeDifference(
      servingDiagnostics.rebuildChunks.runningCount,
      expiredRebuildChunkLeaseCount,
    )

    const hasRecentProgress = getHasRecentReviewServingProgress(lastProgressedAt)
    const hasStaleQueuedRebuildWork =
      !hasRecentProgress && inFlightRebuildChunkCount === 0 && totalQueuedRebuildChunkCount > 0
    const shouldRequestForegroundRepair =
      !isServerMutationWorkDisabled
      && (shouldPrioritizeMissingSnapshotRepair || hasStaleQueuedRebuildWork)
      && (hasStaleQueuedRebuildWork
        || !hasRecentProgress
        || !getHasReviewServingStateThatCanProgress(servingDiagnostics))
      && (!getHasReviewServingStateThatCanProgress(servingDiagnostics)
        || servingDiagnostics.rebuildChunks.pendingCount > 0
        || expiredRebuildChunkLeaseCount > 0)

    if (shouldRequestForegroundRepair) {
      const priority = hasRecentProgress
        ? foregroundReviewServingRepairPriority
        : stalledForegroundReviewServingRepairPriority
      const boostedActiveRequest = await boostActiveReviewServingRebuildRequestForProject({
        priority,
        projectId,
        reason: 'missingReviewServingSnapshot',
      }).catch(() => {
        return false
      })

      if (!boostedActiveRequest) {
        await requestReviewServingV4Rebuild({priority, projectId, reason: 'missingReviewServingSnapshot'}).catch(() => {
          return undefined
        })
      }
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
      + servingDiagnostics.dirtyWork.failedCount
      + servingDiagnostics.dirtyWork.runningCount
      + servingDiagnostics.quarantine.retryableOutboxCount
    const queuedRefreshCount = queuedRebuildChunkCount + servingDiagnostics.dirtyWork.pendingCount
    const inFlightRefreshCount = inFlightRebuildChunkCount + servingDiagnostics.dirtyWork.runningCount
    const pendingRefreshCount = pendingRebuildChunkCount + pendingDirtyWorkCount
    const claimableRefreshCount = queuedRebuildChunkCount + servingDiagnostics.dirtyWork.pendingCount
    const eligibleConsumerCount = claimableRefreshCount > 0 && !isServerMutationWorkDisabled ? 1 : 0
    const indexingStatus = getReviewsIndexingStatus({
      enabledPromptCount,
      hasAnyArticlesInScope,
      hasQuarantineBarrier: terminalQuarantineCount > 0,
      hasReviewServingRows,
      hasTerminalV4Work:
        terminalRebuildChunkCount
          + terminalQuarantineCount
          + (isServerMutationWorkDisabled ? 0 : terminalDirtyWorkCount)
        > 0,
      isServerMutationWorkDisabled,
      pendingRefreshCount,
      runningRefreshCount: inFlightRefreshCount,
    })
    const hasRecentVisibleProgress =
      pendingRefreshCount > 0 && inFlightRefreshCount === 0 && eligibleConsumerCount > 0 && hasRecentProgress
    const progressState = getReviewsIndexingProgressState({
      claimableRefreshCount,
      hasRecentProgress: hasRecentVisibleProgress,
      inFlightRefreshCount,
      status: indexingStatus,
    })
    const blockedReason: ReviewsIndexingBlockedReason =
      indexingStatus === 'failed' && servingDiagnostics.quarantine.quarantinedOutboxCount > 0
        ? 'quarantine_barrier'
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
          diagnostics: getEmptyRuntimeDiagnostics(),
          dirtyMaterialization: {
            activeOwnerCount: 0,
            failedCount: 0,
            incompleteCount: 0,
            isActive: false,
            lastProgressedAt: null,
            oldestQueuedAt: null,
            pendingCount: 0,
            runningCount: 0,
            unreconciledCount: 0,
          },
          eligibleConsumerCount,
          eligibleConsumerPresent: eligibleConsumerCount > 0,
          freshness: {
            dirtyToken: null,
            hasIncompleteDirtyMaterialization: false,
            hasUnresolvedQuarantineBarrier: false,
            isFresh: hasReviewServingRows,
            lastCompletedDirtyToken: null,
            refreshStatus: null,
            status: hasReviewServingRows ? 'fresh' : pendingRefreshCount > 0 ? 'pending' : 'stale',
            unresolvedQuarantineBarrierCount: 0,
          },
          inFlightArticleRefreshCount: 0,
          inFlightProjectRefreshCount: inFlightRefreshCount,
          inFlightRefreshCount,
          largeRebuild: null,
          lastProgressedAt,
          lastProcessedAt: servingDiagnostics.snapshot.activeUpdatedAt,
          lastStartedAt: null,
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

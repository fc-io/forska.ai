import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

export type ReviewsWarningsData = {
  enabledPromptCount: number
  indexing: {
    activeConsumerCount: number
    activeWorkCount: number
    articleRefreshesPerMinute: number | null
    blockedReason: 'paused_by_policy' | 'quarantine_barrier' | 'waiting_for_maintenance_worker' | null
    cleanup?: {inFlightGenerationCleanupCount: number; lastProgressedAt: string | null}
    diagnostics: {
      duckdbQueues: {
        background: {
          lastDurationMs: number | null
          lastWaitMs: number | null
          maxQueueDepth: number
          queueDepth: number
          tasksCompleted: number
          tasksStarted: number
          totalDurationMs: number
          totalWaitMs: number
        }
        main: {
          lastDurationMs: number | null
          lastWaitMs: number | null
          maxQueueDepth: number
          queueDepth: number
          tasksCompleted: number
          tasksStarted: number
          totalDurationMs: number
          totalWaitMs: number
        }
      }
      largeRebuild: {
        currentPhase: null | {
          committedRowCount: number
          cycleCount: number
          durationMs: number
          lastEndedAt: string | null
          lastRssBytes: number | null
          lastTempSpill: ReviewsWarningsDuckdbTempSpill | null
          maxRssBytes: number | null
          maxTempSpillBytes: number | null
          phase: string | null
          queueWaitMs: number | null
          rowsPerSecond: number | null
        }
        lastCycle: null | {
          endedAt: string
          phase: string | null
          queueWaitMs: number | null
          rowsPerSecond: number | null
          rssBytes: number | null
          tempSpill: ReviewsWarningsDuckdbTempSpill | null
        }
      }
      processMemory: {rssBytes: number}
      tempSpill: ReviewsWarningsDuckdbTempSpill
    }
    eligibleConsumerCount: number
    eligibleConsumerPresent: boolean
    dirtyMaterialization?: {
      activeOwnerCount: number
      failedCount: number
      incompleteCount: number
      isActive: boolean
      lastProgressedAt: string | null
      oldestQueuedAt: string | null
      pendingCount: number
      runningCount: number
      unreconciledCount: number
    }
    freshness?: {
      dirtyToken: number | null
      hasIncompleteDirtyMaterialization: boolean
      hasUnresolvedQuarantineBarrier: boolean
      isFresh: boolean
      lastCompletedDirtyToken: number | null
      refreshStatus: 'blocked_by_quarantine' | 'failed' | 'idle' | 'paused' | 'running' | null
      status: 'fresh' | 'pending' | 'stale'
      unresolvedQuarantineBarrierCount: number
    }
    inFlightArticleRefreshCount: number
    inFlightProjectRefreshCount: number
    inFlightRefreshCount: number
    largeRebuild: null | {
      cursorArticleCreatedAt: string | null
      cursorArticleId: string | null
      lastProgressedAt: string | null
      lastError: string | null
      lastStartedAt: string | null
      operatorNote: string | null
      progress: null | {
        remainingCurrentPhaseArticleCount: number | null
        rowsPerMinute: number | null
        scopeArticleCount: number
      }
      rebuildPhase: string | null
      refreshStatus: 'failed' | 'idle' | 'paused' | 'running' | null
      refreshToken: number | null
    }
    lastProgressedAt: string | null
    lastProcessedAt: string | null
    lastStartedAt: string | null
    oldestQueuedAt: string | null
    pendingArticleRefreshCount: number
    pendingProjectRefreshCount: number
    pendingRefreshCount: number
    progressState: 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'
    projectRefreshesPerMinute: number | null
    queuedArticleRefreshCount: number
    queuedProjectRefreshCount: number
    queuedRefreshCount: number
    quarantinedArticleRefreshCount: number
    quarantinedArticles: Array<{
      articleId: string
      createdAt: string | null
      detectedBy: string | null
      error: string
      updatedAt: string | null
    }>
    recoveryContext: Record<string, unknown> | null
    recoveryMode: 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
    requiredConsumerRole: 'maintenance-worker'
    retryAfterAt: string | null
    serving: {readable: boolean; usable: boolean}
    status: 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'
  }
  projectId: string
  scope: {hasAnyArticlesInScope: boolean}
}

type ReviewsWarningsDuckdbTempSpill = {
  available: boolean
  error: string | null
  fileCount: number | null
  tempDirectory: string | null
  totalBytes: number | null
}

export const createReviewsWarningsQueryOptions = (projectId: string) => {
  return {
    queryKey: ['project-reviews-warnings', projectId],
    queryFn: async () => {
      const response = await apiClient.api.projectsreviewswarnings.post({projectId})
      const data = handleApiResponse(response, 'Failed to load project warnings')

      return data.data as unknown as ReviewsWarningsData
    },
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    staleTime: 5000,
  }
}

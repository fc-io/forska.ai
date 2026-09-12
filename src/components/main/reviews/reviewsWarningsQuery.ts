import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

export type ReviewsWarningsData = {
  enabledPromptCount: number
  indexing: {
    activeConsumerCount: number
    activeWorkCount: number
    articleRefreshesPerMinute: number | null
    blockedReason:
      | 'duckdb_exclusive_work_active'
      | 'operator_intervention_required'
      | 'paused_by_policy'
      | 'quarantine_barrier'
      | 'waiting_for_maintenance_worker'
      | null
    cleanup?: {inFlightGenerationCleanupCount: number; lastProgressedAt: string | null}
    coverage: {
      countReadyArticleCount: number | null
      detailReadyArticleCount: number | null
      filterReadyArticleCount: number | null
      reviewPageReadyArticleCount: number
      rowReadyArticleCount: number | null
      searchReadyArticleCount: number | null
      totalArticleCount: number
    }
    eligibleConsumerCount: number
    eligibleConsumerPresent: boolean
    inFlightArticleRefreshCount: number
    inFlightProjectRefreshCount: number
    inFlightRefreshCount: number
    lastProgressedAt: string | null
    lastProcessedAt: string | null
    lastStartedAt: string | null
    maintenance: {
      hasActionableFailures: boolean
      hasHistoricalFailures: boolean
      status: 'blocked' | 'failed' | 'idle' | 'processing'
      terminalDirtyWorkCount: number
      terminalQuarantineCount: number
      terminalRebuildChunkCount: number
    }
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
    search: {
      availability: 'ready' | 'indexing' | 'unavailable' | 'async'
      optionalComponent: boolean
      snapshotId: string | null
    }
    serving: {
      diagnostics: {
        dirtyWork?: {failedCount?: number; pendingCount?: number; runningCount?: number}
        rebuildChunks?: {
          claimableCount?: number
          expiredLeaseCount?: number
          pendingCount?: number
          runningCount?: number
        }
      } & Record<string, unknown>
      manifest: Record<string, unknown>
      readable: boolean
      usable: boolean
    }
    status: 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'
  }
  projectId: string
  scope: {hasAnyArticlesInScope: boolean}
}

export type ReviewServingStatusData = {
  owner: {proxyConfigured: boolean; readiness: 'not_probed'}
  pauseMarker: {createdAt: string | null; exists: boolean; updatedAt: string | null}
  queue: {exclusiveWorkActive: boolean}
  role: string
  snapshot: {lastProgressedAt: string | null; readable: boolean | null}
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

export const createReviewServingStatusQueryOptions = () => {
  return {
    queryKey: ['review-serving-status'],
    queryFn: async () => {
      const response = await fetch('/api/review-serving/status')
      if (!response.ok) throw new Error(`Failed to load review-serving status (${response.status})`)
      const body = (await response.json()) as {data: ReviewServingStatusData}
      return body.data
    },
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    staleTime: 5000,
  }
}

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
    eligibleConsumerCount: number
    eligibleConsumerPresent: boolean
    inFlightArticleRefreshCount: number
    inFlightProjectRefreshCount: number
    inFlightRefreshCount: number
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

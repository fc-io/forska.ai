import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

export type ReviewsWarningsData = {
  enabledPromptCount: number
  indexing: {
    activeConsumerCount: number
    activeWorkCount: number
    articleRefreshesPerMinute: number | null
    blockedReason: 'paused_by_policy' | 'waiting_for_maintenance_worker' | null
    eligibleConsumerCount: number
    eligibleConsumerPresent: boolean
    inFlightArticleRefreshCount: number
    inFlightProjectRefreshCount: number
    inFlightRefreshCount: number
    largeRebuild: null | {
      cursorArticleCreatedAt: string | null
      cursorArticleId: string | null
      lastError: string | null
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

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

export type ReviewsWarningsData = {
  enabledPromptCount: number
  indexing: {
    oldestQueuedAt: string | null
    pendingArticleRefreshCount: number
    pendingProjectRefreshCount: number
    pendingRefreshCount: number
    status: 'not-needed' | 'ready' | 'refreshing' | 'stale'
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

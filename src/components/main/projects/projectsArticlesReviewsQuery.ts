import {format} from 'date-fns'
import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

export const createArticlesReviewsQueryOptions = (
  projectId: string,
  promptFilters: Accessor<Record<string, string | null>>,
  currentPage: Accessor<number>,
  pageLimit: Accessor<number>,
  fromDate: Accessor<Date>,
  toDate: Accessor<Date>,
) => {
  return {
    queryKey: [
      'project-articles-reviews-filters',
      projectId,
      promptFilters(),
      currentPage(),
      pageLimit(),
      fromDate(),
      toDate(),
    ],
    queryFn: async () => {
      const body = {
        page: String(currentPage()),
        limit: String(pageLimit()),
        projectId,
        from: format(fromDate(), 'yyyy-MM-dd'),
        to: format(toDate(), 'yyyy-MM-dd'),
        prompts: Object.entries(promptFilters()).reduce(
          (acc, [promptId, value]) => {
            if (value !== null) {
              acc[promptId] = value
            }
            return acc
          },
          {} as Record<string, string>,
        ),
      }

      const response = await apiClient.api.articlesreviews.post(body)

      if (!response.data) {
        throw new Error('Failed to fetch articles')
      }

      return response.data
    },
  }
}

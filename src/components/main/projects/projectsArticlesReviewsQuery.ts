import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const createArticlesReviewsQueryOptions = (
  projectId: string,
  promptFilters: Accessor<Record<string, string | null>>,
  currentPage: Accessor<number>,
  pageLimit: Accessor<number>,
  fromDateStr: Accessor<string>,
  toDateStr: Accessor<string>,
) => {
  const fromStr = () => fromDateStr().trim()
  const toStr = () => toDateStr().trim()
  return {
    queryKey: [
      'project-articles-reviews-filters',
      projectId,
      promptFilters(),
      currentPage(),
      pageLimit(),
      fromStr(),
      toStr(),
    ],
    queryFn: async () => {
      const body: Record<string, unknown> = {
        page: String(currentPage()),
        limit: String(pageLimit()),
        projectId,
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
      if (isoDatePattern.test(fromStr())) {
        body.from = fromStr()
      }
      if (isoDatePattern.test(toStr())) {
        body.to = toStr()
      }

      const response = await apiClient.api.articlesreviews.post(body)

      if (!response.data) {
        throw new Error('Failed to fetch articles')
      }

      return response.data
    },
  }
}

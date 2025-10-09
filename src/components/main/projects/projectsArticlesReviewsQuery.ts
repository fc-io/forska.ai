import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const createArticlesReviewsQueryOptions = (
  projectId: string,
  promptFilters: Accessor<Record<string, string[] | null>>,
  currentPage: Accessor<number>,
  pageLimit: Accessor<number>,
  fromDateStr: Accessor<string>,
  toDateStr: Accessor<string>,
) => {
  const fromStr = () => fromDateStr().trim()
  const toStr = () => toDateStr().trim()
  const validFrom = () => {
    const s = fromStr()
    return isoDatePattern.test(s) ? s : null
  }
  const validTo = () => {
    const s = toStr()
    return isoDatePattern.test(s) ? s : null
  }
  return {
    // Only include dates when valid to prevent refetching on partial input
    queryKey: ['project-articles-reviews', projectId, promptFilters(), currentPage(), pageLimit(), validFrom(), validTo()],
    queryFn: async () => {
      const body: Record<string, unknown> = {
        page: String(currentPage()),
        limit: String(pageLimit()),
        projectId,
        prompts: Object.entries(promptFilters()).reduce((acc, [promptId, value]) => {
          if (Array.isArray(value) && value.length > 0) {
            acc[promptId] = value
          }
          return acc
        }, {} as Record<string, string[]>),
      }
      const from = validFrom()
      const to = validTo()
      if (from) body.from = from
      if (to) body.to = to

      const response = await apiClient.api.articlesreviews.post(body)

      if (!response.data) {
        throw new Error('Failed to fetch articles')
      }

      return response.data
    },
  }
}

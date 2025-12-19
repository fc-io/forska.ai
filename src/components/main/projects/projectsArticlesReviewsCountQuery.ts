import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const createArticlesReviewsCountQueryOptions = (
  projectId: string,
  promptFilters: Accessor<Record<string, string[] | null>>,
  pageLimit: Accessor<number>,
  fromDateStr: Accessor<string>,
  toDateStr: Accessor<string>,
  searchTitleApplied: Accessor<string>,
) => {
  const fromStr = () => {
    return fromDateStr().trim()
  }
  const toStr = () => {
    return toDateStr().trim()
  }
  const validFrom = () => {
    const s = fromStr()
    return isoDatePattern.test(s) ? s : null
  }
  const validTo = () => {
    const s = toStr()
    return isoDatePattern.test(s) ? s : null
  }
  return {
    // Query key matches filters (not page) since count doesn't depend on page
    queryKey: [
      'project-articles-reviews-count',
      projectId,
      promptFilters(),
      pageLimit(),
      validFrom(),
      validTo(),
      (searchTitleApplied() || '').trim() || null,
    ],
    queryFn: async () => {
      const prompts = Object.entries(promptFilters()).reduce(
        (acc, [promptId, value]) => {
          if (Array.isArray(value) && value.length > 0) {
            acc[promptId] = value
          }
          return acc
        },
        {} as Record<string, string[]>,
      )

      const from = validFrom()
      const to = validTo()
      const search = (searchTitleApplied() || '').trim()

      const body: {
        limit: string
        projectId: string
        prompts: Record<string, string[]>
        from?: string
        to?: string
        search?: string
      } = {limit: String(pageLimit()), projectId, prompts}

      if (from) body.from = from
      if (to) body.to = to
      if (search) body.search = search

      const response = await apiClient.api.articlesreviewscount.post(body)

      if (!response.data) {
        throw new Error('Failed to fetch articles count')
      }

      return response.data
    },
    // Cache count for longer since it's expensive to compute
    staleTime: 1000 * 60 * 5, // 5 minutes
  }
}

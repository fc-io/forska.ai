import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const createArticlesHumanReviewsQueryOptions = (
  projectId: string,
  promptFilters: Accessor<Record<string, string[] | null>>,
  currentPage: Accessor<number>,
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
    queryKey: [
      'project-articles-human-reviews',
      projectId,
      promptFilters(),
      currentPage(),
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

      const response = await apiClient.api.articlesreviewshuman.post({
        page: String(currentPage()),
        limit: String(pageLimit()),
        projectId,
        prompts,
        from: from ?? undefined,
        to: to ?? undefined,
        search: search || undefined,
      })

      if (!response.data) {
        throw new Error('Failed to fetch human-assessed articles')
      }

      return response.data
    },
    refetchOnWindowFocus: false,
  }
}

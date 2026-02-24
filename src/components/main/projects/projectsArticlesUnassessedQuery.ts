import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const createArticlesUnassessedQueryOptions = (
  projectId: string,
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
    // Only include dates when valid to prevent refetching on partial input
    queryKey: [
      'project-articles-unassessed',
      projectId,
      currentPage(),
      pageLimit(),
      validFrom(),
      validTo(),
      (searchTitleApplied() || '').trim() || null,
    ],
    queryFn: async () => {
      const from = validFrom()
      const to = validTo()
      const search = (searchTitleApplied() || '').trim()

      const response = await apiClient.api.articlesreviewsunassessed.post({
        page: String(currentPage()),
        limit: String(pageLimit()),
        projectId,
        from: from ?? undefined,
        to: to ?? undefined,
        search: search || undefined,
      })

      if (!response.data) {
        throw new Error('Failed to fetch unassessed articles')
      }

      return response.data
    },
    refetchOnWindowFocus: false,
  }
}

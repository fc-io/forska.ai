import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const createArticlesUnassessedQueryOptions = (
  projectId: string,
  currentPage: Accessor<number>,
  pageLimit: Accessor<number>,
  fromDateStr: Accessor<string>,
  toDateStr: Accessor<string>,
) => {
  const fromStr = () => {
    return fromDateStr().trim()
  }
  const toStr = () => {
    return toDateStr().trim()
  }
  const fromKey = () => (isoDatePattern.test(fromStr()) ? fromStr() : null)
  const toKey = () => (isoDatePattern.test(toStr()) ? toStr() : null)
  return {
    queryKey: ['project-articles-unassessed', projectId, currentPage(), pageLimit(), fromKey(), toKey()],
    queryFn: async () => {
      const body: Record<string, unknown> = {page: String(currentPage()), limit: String(pageLimit()), projectId}
      if (isoDatePattern.test(fromStr())) {
        body.from = fromStr()
      }
      if (isoDatePattern.test(toStr())) {
        body.to = toStr()
      }

      const response = await apiClient.api.articlesreviewsunassessed.post(body)

      if (!response.data) {
        throw new Error('Failed to fetch unassessed articles')
      }

      return response.data
    },
  }
}

import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const createArticlesUnassessedQueryOptions = (
  projectId: string,
  covidenceDuplicatesOnly: Accessor<boolean>,
  covidenceConflictsOnly: Accessor<boolean>,
  currentPage: Accessor<number>,
  currentCursor: Accessor<string | null | undefined>,
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
      covidenceDuplicatesOnly(),
      covidenceConflictsOnly(),
      currentPage(),
      currentCursor() ?? null,
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
        cursor: currentCursor() ?? undefined,
        limit: String(pageLimit()),
        projectId,
        hasDuplicateStudyRecords: covidenceDuplicatesOnly() ? true : undefined,
        hasStudyDecisionConflict: covidenceConflictsOnly() ? true : undefined,
        from: from ?? undefined,
        to: to ?? undefined,
        search: search || undefined,
      })

      if (!response.data) {
        throw new Error('Failed to fetch unassessed articles')
      }

      if (response.data.error) {
        throw new Error(response.data.error)
      }

      return response.data
    },
    refetchOnWindowFocus: false,
  }
}

import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import type {LlmStatus} from '../../../services/olap/olapTypes.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

export const createArticlesReviewsQueryOptions = (
  projectId: string,
  covidenceDuplicatesOnly: Accessor<boolean>,
  covidenceConflictsOnly: Accessor<boolean>,
  promptFilters: Accessor<Record<string, string[] | null>>,
  currentPage: Accessor<number>,
  currentCursor: Accessor<string | null | undefined>,
  pageLimit: Accessor<number>,
  fromDateStr: Accessor<string>,
  toDateStr: Accessor<string>,
  searchTitleApplied: Accessor<string>,
  llmStatus?: Accessor<LlmStatus | null | undefined>,
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
      'project-articles-reviews',
      projectId,
      covidenceDuplicatesOnly(),
      covidenceConflictsOnly(),
      promptFilters(),
      currentPage(),
      currentCursor() ?? null,
      pageLimit(),
      validFrom(),
      validTo(),
      (searchTitleApplied() || '').trim() || null,
      llmStatus?.() ?? null,
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
      const cursor = currentCursor()
      const currentLlmStatus = llmStatus?.()

      const body = {
        page: String(currentPage()),
        limit: String(pageLimit()),
        projectId,
        hasDuplicateStudyRecords: covidenceDuplicatesOnly() ? true : undefined,
        hasStudyDecisionConflict: covidenceConflictsOnly() ? true : undefined,
        prompts,
        cursor: cursor ?? undefined,
        from: from ?? undefined,
        to: to ?? undefined,
        search: search || undefined,
        ...(currentLlmStatus ? {llmStatus: currentLlmStatus} : {}),
      }

      const response = await apiClient.api.articlesreviews.post(body)

      if (!response.data) {
        throw new Error('Failed to fetch articles')
      }

      if (response.data.error) {
        throw new Error(response.data.error)
      }

      return response.data
    },
    refetchOnWindowFocus: false,
  }
}

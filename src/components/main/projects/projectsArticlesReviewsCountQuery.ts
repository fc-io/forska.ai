import type {Accessor} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import type {LlmStatus} from '../../../services/olap/olapTypes.ts'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const liveStateCountStaleMs = 15_000
const expensiveCountStaleMs = 1000 * 60 * 5

export const createArticlesReviewsCountQueryOptions = (
  projectId: string,
  covidenceDuplicatesOnly: Accessor<boolean>,
  covidenceConflictsOnly: Accessor<boolean>,
  promptFilters: Accessor<Record<string, string[] | null>>,
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
  const hasPromptFilters = () => {
    return Object.values(promptFilters()).some((value) => {
      return Array.isArray(value) && value.length > 0
    })
  }
  const isLiveStateCount = () => {
    return Boolean(llmStatus?.()) && !hasPromptFilters() && (searchTitleApplied() || '').trim() === ''
  }
  const countFreshnessOptions = () => {
    if (isLiveStateCount()) {
      return {
        refetchInterval: liveStateCountStaleMs,
        refetchOnMount: 'always' as const,
        refetchOnWindowFocus: 'always' as const,
        staleTime: liveStateCountStaleMs,
      }
    }

    return {refetchInterval: false, refetchOnWindowFocus: false, staleTime: expensiveCountStaleMs}
  }

  return {
    // Query key matches filters (not page) since count doesn't depend on page
    queryKey: [
      'project-articles-reviews-count',
      projectId,
      covidenceDuplicatesOnly(),
      covidenceConflictsOnly(),
      promptFilters(),
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

      const body: {
        limit: string
        projectId: string
        hasDuplicateStudyRecords?: true
        hasStudyDecisionConflict?: true
        prompts: Record<string, string[]>
        from?: string
        to?: string
        search?: string
        llmStatus?: LlmStatus
      } = {limit: String(pageLimit()), projectId, prompts}

      if (from) body.from = from
      if (to) body.to = to
      if (search) body.search = search
      if (llmStatus?.()) body.llmStatus = llmStatus()
      if (covidenceDuplicatesOnly()) body.hasDuplicateStudyRecords = true
      if (covidenceConflictsOnly()) body.hasStudyDecisionConflict = true

      const response = await apiClient.api.articlesreviewscount.post(body)

      if (!response.data) {
        throw new Error('Failed to fetch articles count')
      }

      return response.data
    },
    // Expensive prompt/search counts stay cached; simple status counts are now incremental serving-state reads.
    ...countFreshnessOptions(),
  }
}

import type {Setter} from 'solid-js'
import {createEffect, createSignal, on, onMount} from 'solid-js'

import type {LlmStatus} from '../services/olap/olapTypes.ts'

type UseUrlFiltersOptions = {routePath: string; routeParams: Record<string, string>; includeLlmStatus?: boolean}

type UseUrlFiltersResult = {
  fromDate: () => string
  setFromDate: Setter<string>
  toDate: () => string
  setToDate: Setter<string>
  covidenceDuplicatesOnly: () => boolean
  setCovidenceDuplicatesOnly: Setter<boolean>
  covidenceConflictsOnly: () => boolean
  setCovidenceConflictsOnly: Setter<boolean>
  promptFilters: () => Record<string, string[] | null>
  setPromptFilters: Setter<Record<string, string[] | null>>
  currentPage: () => number
  setCurrentPage: Setter<number>
  pageLimit: () => number
  setPageLimit: Setter<number>
  searchTitle: () => string
  setSearchTitle: Setter<string>
  appliedSearchTitle: () => string
  setAppliedSearchTitle: Setter<string>
  llmStatus: () => LlmStatus | undefined
  setLlmStatus: Setter<LlmStatus | undefined>
  onSubmitSearch: () => void
  initialized: () => boolean
}

/**
 * Hook to manage filter state synced with URL query parameters.
 * Parses URL params on mount and updates URL when filters change.
 */
export const useUrlFilters = (options: UseUrlFiltersOptions): UseUrlFiltersResult => {
  // State signals
  const [fromDate, setFromDate] = createSignal('')
  const [toDate, setToDate] = createSignal('')
  const [covidenceDuplicatesOnly, setCovidenceDuplicatesOnly] = createSignal(false)
  const [covidenceConflictsOnly, setCovidenceConflictsOnly] = createSignal(false)
  const [promptFilters, setPromptFilters] = createSignal<Record<string, string[] | null>>({})
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(100)
  const [searchTitle, setSearchTitle] = createSignal('')
  const [appliedSearchTitle, setAppliedSearchTitle] = createSignal('')
  const [llmStatus, setLlmStatus] = createSignal<LlmStatus | undefined>(
    options.includeLlmStatus ? 'complete' : undefined,
  )
  const [initialized, setInitialized] = createSignal(false)

  // Parse URL params on mount
  onMount(() => {
    const urlParams = new URLSearchParams(window.location.search)

    // Parse date filters
    const from = urlParams.get('from')
    const to = urlParams.get('to')
    if (from) setFromDate(from)
    if (to) setToDate(to)
    setCovidenceDuplicatesOnly(urlParams.get('covidenceDuplicates') === '1')
    setCovidenceConflictsOnly(urlParams.get('covidenceConflicts') === '1')

    // Parse page and limit
    const page = urlParams.get('page')
    const limit = urlParams.get('limit')
    if (page) setCurrentPage(parseInt(page, 10) || 1)
    if (limit) setPageLimit(parseInt(limit, 10) || 100)

    // Parse search
    const search = urlParams.get('search')
    if (search) {
      setSearchTitle(search)
      setAppliedSearchTitle(search)
    }

    if (options.includeLlmStatus) {
      const urlLlmStatus = urlParams.get('llmStatus')
      setLlmStatus(
        urlLlmStatus === 'both' || urlLlmStatus === 'partial' || urlLlmStatus === 'complete'
          ? urlLlmStatus
          : 'complete',
      )
    }

    const filters: Record<string, string[] | null> = {}
    urlParams.forEach((value, key) => {
      if (key.startsWith('pf_')) {
        const promptId = key.slice(3)
        const values = value.split(',').map((v) => {
          return decodeURIComponent(v)
        })
        filters[promptId] = values.length > 0 ? values : null
      }
    })
    if (Object.keys(filters).length > 0) {
      setPromptFilters(filters)
    }

    setInitialized(true)
  })

  // Build URL search params from current state
  const buildSearchParams = (): Record<string, string> => {
    const params: Record<string, string> = {}

    const from = fromDate()
    const to = toDate()
    const page = currentPage()
    const limit = pageLimit()
    const search = appliedSearchTitle()
    const duplicatesOnly = covidenceDuplicatesOnly()
    const conflictsOnly = covidenceConflictsOnly()
    const filters = promptFilters()
    const currentLlmStatus = llmStatus()

    if (from) params.from = from
    if (to) params.to = to
    if (page !== 1) params.page = String(page)
    if (limit !== 100) params.limit = String(limit)
    if (search) params.search = search
    if (duplicatesOnly) params.covidenceDuplicates = '1'
    if (conflictsOnly) params.covidenceConflicts = '1'
    if (options.includeLlmStatus && currentLlmStatus) params.llmStatus = currentLlmStatus

    for (const [promptId, values] of Object.entries(filters)) {
      if (values && values.length > 0) {
        params[`pf_${promptId}`] = values
          .map((v) => {
            return encodeURIComponent(v)
          })
          .join(',')
      }
    }

    return params
  }

  // Update URL when filters change (after initialization)
  createEffect(
    on(
      [
        fromDate,
        toDate,
        covidenceDuplicatesOnly,
        covidenceConflictsOnly,
        currentPage,
        pageLimit,
        appliedSearchTitle,
        llmStatus,
        promptFilters,
        initialized,
      ],
      () => {
        if (!initialized()) return

        const nextSearch = new URLSearchParams(buildSearchParams()).toString()
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}`

        window.history.replaceState(window.history.state, '', nextUrl)
      },
    ),
  )

  const onSubmitSearch = () => {
    setAppliedSearchTitle(searchTitle())
    setCurrentPage(1)
  }

  return {
    fromDate,
    setFromDate,
    toDate,
    setToDate,
    covidenceDuplicatesOnly,
    setCovidenceDuplicatesOnly,
    covidenceConflictsOnly,
    setCovidenceConflictsOnly,
    promptFilters,
    setPromptFilters,
    currentPage,
    setCurrentPage,
    pageLimit,
    setPageLimit,
    searchTitle,
    setSearchTitle,
    appliedSearchTitle,
    setAppliedSearchTitle,
    llmStatus,
    setLlmStatus,
    onSubmitSearch,
    initialized,
  }
}

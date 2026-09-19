import {useQuery} from '@tanstack/solid-query'
import type {Setter} from 'solid-js'
import {createEffect, createMemo, For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {MultiSelect} from '../../ui/multi-select.tsx'
import {
  getPromptFilterControls,
  getPromptFilterLabel,
  getPromptFilterTitle,
  reconcileSchemaEnumSelections,
} from './reviewPromptFilterControls.ts'

const getSelectedPromptValues = (value: string[] | null | undefined): string[] => {
  return Array.isArray(value) ? value : []
}

interface ReviewsHumanFilterControlsProps {
  projectId: string
  covidenceDuplicatesOnly: boolean
  setCovidenceDuplicatesOnly: Setter<boolean>
  covidenceConflictsOnly: boolean
  setCovidenceConflictsOnly: Setter<boolean>
  promptFilters: () => Record<string, string[] | null>
  setPromptFilters: Setter<Record<string, string[] | null>>
  pageLimit: () => number
  setPageLimit: Setter<number>
  setCurrentPage: Setter<number>
  fromDate: string
  toDate: string
  setFromDate: Setter<string>
  setToDate: Setter<string>
  hidePromptSelectors?: boolean
  searchTitle: string
  setSearchTitle: Setter<string>
  appliedSearchTitle: string
  onSubmitSearch: () => void
}

export const ReviewsHumanFilterControls = (props: ReviewsHumanFilterControlsProps) => {
  const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
  const validFrom = () => {
    const s = (props.fromDate || '').trim()
    return isoDatePattern.test(s) ? s : null
  }
  const validTo = () => {
    const s = (props.toDate || '').trim()
    return isoDatePattern.test(s) ? s : null
  }
  const handleLimitChange = (newLimit: number) => {
    props.setPageLimit(newLimit)
    props.setCurrentPage(1)
  }
  const filtersQuery = useQuery(() => {
    return {
      queryKey: [
        'project-articles-human-reviews-filters',
        props.projectId,
        props.covidenceDuplicatesOnly,
        props.covidenceConflictsOnly,
        validFrom(),
        validTo(),
        (props.appliedSearchTitle || '').trim() || null,
      ],
      queryFn: async () => {
        const from = validFrom()
        const to = validTo()
        const search = (props.appliedSearchTitle || '').trim()

        const response = await apiClient.api.articlesreviewshumanfilters.get({
          query: {
            projectId: props.projectId,
            covidenceConflicts: props.covidenceConflictsOnly ? '1' : undefined,
            covidenceDuplicates: props.covidenceDuplicatesOnly ? '1' : undefined,
            from: from ?? undefined,
            to: to ?? undefined,
            search: search || undefined,
          },
        })

        if (!response.data) {
          throw new Error('Failed to fetch filters')
        }

        return getPromptFilterControls(response.data)
      },
      enabled: !props.hidePromptSelectors,
    }
  })

  const setPromptMulti = (promptId: string, values: string[] | null) => {
    props.setPromptFilters((prev) => {
      return {...(prev ?? {}), [promptId]: values && values.length > 0 ? values : null}
    })
    props.setCurrentPage(1)
  }

  createEffect(() => {
    if (props.hidePromptSelectors) {
      return
    }
    const controls = filtersQuery.data?.controls
    if (!controls) {
      return
    }
    props.setPromptFilters((prev) => {
      return reconcileSchemaEnumSelections(prev ?? {}, controls)
    })
  })

  return (
    <Suspense>
      <div class="p-4 bg-white rounded-lg shadow mb-6">
        <form
          class="flex items-center gap-2 pb-4 border-b w-full mb-4"
          onSubmit={(e) => {
            e.preventDefault()
            props.onSubmitSearch()
            props.setCurrentPage(1)
          }}
        >
          <label class="flex flex-col text-sm font-medium gap-1 w-full max-w-xl">
            <span>Search title</span>
            <input
              type="text"
              value={props.searchTitle}
              onInput={(e) => {
                props.setSearchTitle(e.currentTarget.value)
              }}
              placeholder="Type a title and press Search"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
          </label>
          <button
            type="submit"
            class="self-end h-10 px-4 py-2 rounded-md border bg-blue-600 text-white hover:bg-blue-700"
          >
            Search
          </button>
        </form>
        <div class="flex items-center gap-4 pb-4 border-b w-full">
          <label class="flex flex-col text-sm font-medium gap-1 w-44">
            <span>Start Date</span>
            <input
              type="text"
              value={props.fromDate}
              onInput={(e) => {
                props.setFromDate(e.currentTarget.value)
                props.setCurrentPage(1)
              }}
              placeholder="YYYY-MM-DD"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
          </label>
          <label class="flex flex-col text-sm font-medium gap-1 w-44">
            <span>End Date</span>
            <input
              type="text"
              value={props.toDate}
              onInput={(e) => {
                props.setToDate(e.currentTarget.value)
                props.setCurrentPage(1)
              }}
              placeholder="YYYY-MM-DD"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
          </label>
          <div class="ml-auto flex items-center gap-2">
            <label class="font-medium">Items per page:</label>
            <select
              class="px-3 py-2 border rounded-md bg-white text-gray-900"
              value={String(props.pageLimit())}
              onChange={(e) => {
                return handleLimitChange(parseInt(e.target.value))
              }}
            >
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="500">500</option>
            </select>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-4 py-4 border-b w-full">
          <label class="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={props.covidenceDuplicatesOnly}
              onChange={(e) => {
                props.setCovidenceDuplicatesOnly(e.currentTarget.checked)
                props.setCurrentPage(1)
              }}
              class="h-4 w-4 rounded border-gray-300"
            />
            <span>Covidence duplicates only</span>
          </label>
          <label class="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={props.covidenceConflictsOnly}
              onChange={(e) => {
                props.setCovidenceConflictsOnly(e.currentTarget.checked)
                props.setCurrentPage(1)
              }}
              class="h-4 w-4 rounded border-gray-300"
            />
            <span>Covidence conflicts only</span>
          </label>
        </div>
        <Show when={!props.hidePromptSelectors}>
          <div class="pt-4 space-y-3">
            <div class="flex flex-wrap items-center gap-3">
              <div class="text-sm font-medium text-gray-700">Prompt answer filters</div>
            </div>
            <Show when={filtersQuery.data}>
              {(data) => {
                const filters = data().controls
                return (
                  <div class="mt-4 space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      <For each={filters}>
                        {(promptFilter) => {
                          const promptLabel = getPromptFilterLabel(promptFilter)
                          const promptTitle = getPromptFilterTitle(promptFilter)
                          const current = createMemo(() => {
                            return getSelectedPromptValues(props.promptFilters()[promptFilter.promptId])
                          })
                          const options = createMemo(() => {
                            return promptFilter.options
                          })
                          return (
                            <div class="flex flex-col gap-2">
                              <label class="font-medium text-sm truncate" title={promptTitle}>
                                {promptLabel}:
                              </label>
                              <MultiSelect
                                ariaLabel={promptLabel}
                                options={options()}
                                values={current()}
                                onChange={(values) => {
                                  setPromptMulti(promptFilter.promptId, values.length ? values : null)
                                }}
                              />
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                )
              }}
            </Show>
          </div>
        </Show>
        <Show when={!props.hidePromptSelectors && filtersQuery.isPending}>
          <div class="text-gray-500">Loading filters...</div>
        </Show>
        <Show when={!props.hidePromptSelectors && filtersQuery.error}>
          <div class="text-red-600">Error loading filters</div>
        </Show>
      </div>
    </Suspense>
  )
}

import {createSignal, For, onMount, Show} from 'solid-js'
import type {Setter} from 'solid-js'

import {useQuery} from '@tanstack/solid-query'

import {apiClient} from '../../../services/apiClient.ts'

interface ReviewsFilterControlsProps {
  projectId: string
  promptFilters: () => Record<string, string | null>
  setPromptFilters: Setter<Record<string, string | null>>
  pageLimit: () => number
  setPageLimit: Setter<number>
  setCurrentPage: Setter<number>
}

export const ReviewsFilterControls = (props: ReviewsFilterControlsProps) => {
  const handleLimitChange = (newLimit: number) => {
    props.setPageLimit(newLimit)
    props.setCurrentPage(1)
  }

  const filtersQuery = useQuery(() => {
    return {
      queryKey: ['project-articles-reviews-filters', props.projectId],
      queryFn: async () => {
        const response = await apiClient.api
          .projects({id: props.projectId})
          ['articles-reviews-filters'].get()

        if (response.error || !response.data) {
          throw new Error(
            response.error && typeof response.error === 'string'
              ? response.error
              : 'Failed to fetch filters',
          )
        }

        return response.data as {
          data: Array<{
            promptId: string
            promptName: string
            answeredOriginalValues: string[]
          }>
        }
      },
    }
  })

  const handlePromptFilterChange = (promptId: string, value: string) => {
    props.setPromptFilters((prev) => {
      return {...prev, [promptId]: value === 'all' ? null : value}
    })
    props.setCurrentPage(1)
  }

  return (
    <div class="p-4 bg-white rounded-lg shadow mb-6">
      <Show when={filtersQuery.data}>
        {(data) => {
          const filters = data().data
          return (
            <div class="space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <For each={filters}>
                  {(promptFilter) => {
                    return (
                      <div class="flex flex-col gap-2">
                        <label class="font-medium text-sm truncate" title={promptFilter.promptName || `Prompt ${promptFilter.promptId}`}>
                          {promptFilter.promptName || `Prompt ${promptFilter.promptId}`}:
                        </label>
                        <select
                          class="px-3 py-2 border rounded-md"
                          value={props.promptFilters()[promptFilter.promptId] || 'all'}
                          onChange={(e) => {
                            return handlePromptFilterChange(
                              promptFilter.promptId,
                              e.target.value,
                            )
                          }}
                        >
                          <option value="all">All</option>
                          <For each={promptFilter.answeredOriginalValues}>
                            {(value) => {
                              return <option value={value}>{value}</option>
                            }}
                          </For>
                        </select>
                      </div>
                    )
                  }}
                </For>
              </div>
              <div class="flex items-center gap-4 pt-4 border-t">

                <label class="font-medium">Items per page:</label>
                <select
                  class="px-3 py-2 border rounded-md"
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
          )
        }}
      </Show>
      <Show when={filtersQuery.isPending}>
        <div class="text-gray-500">Loading filters...</div>
      </Show>
      <Show when={filtersQuery.error}>
        <div class="text-red-600">Error loading filters</div>
      </Show>
    </div>
  )
}
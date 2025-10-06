import {useQuery} from '@tanstack/solid-query'
import type {Setter} from 'solid-js'
import {createEffect, For, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

interface ReviewsFilterControlsProps {
  projectId: string
  promptFilters: () => Record<string, string | null>
  setPromptFilters: Setter<Record<string, string | null>>
  pageLimit: () => number
  setPageLimit: Setter<number>
  setCurrentPage: Setter<number>
  fromDate: string
  toDate: string
  setFromDate: Setter<string>
  setToDate: Setter<string>
}

export const ReviewsFilterControls = (props: ReviewsFilterControlsProps) => {
  const handleLimitChange = (newLimit: number) => {
    props.setPageLimit(newLimit)
    props.setCurrentPage(1)
  }

  const filtersQuery = useQuery(() => {
    return {
      queryKey: [
        'project-articles-reviews-filters',
        props.projectId,
        props.fromDate || null,
        props.toDate || null,
      ],
      queryFn: async () => {
        const query: Record<string, string> = {projectId: props.projectId}
        if (props.fromDate) query.from = props.fromDate
        if (props.toDate) query.to = props.toDate

        const response = await apiClient.api.articlesreviewsfilters.get({query})

        if (!response.data) {
          throw new Error('Failed to fetch filters')
        }

        return response.data as Array<{promptId: string; promptName: string; answeredOriginalValues: string[]}>
      },
    }
  })

  const handlePromptFilterChange = (promptId: string, value: string) => {
    props.setPromptFilters((prev) => {
      return {...prev, [promptId]: value === 'all' ? null : value}
    })
    props.setCurrentPage(1)
  }

  createEffect(() => {
    const maybe = (filtersQuery as unknown as {data?: unknown}).data
    const filters = typeof maybe === 'function' ? (maybe as () => Array<{promptId: string; answeredOriginalValues: string[]}> )() : (maybe as Array<{promptId: string; answeredOriginalValues: string[]}> | undefined)
    if (!filters) {
      return
    }
    const allowedByPrompt: Record<string, Set<string>> = filters.reduce((acc, f) => {
      acc[f.promptId] = new Set(f.answeredOriginalValues)
      return acc
    }, {} as Record<string, Set<string>>)
    props.setPromptFilters((prev) => {
      const next: Record<string, string | null> = {}
      for (const [promptId, value] of Object.entries(prev)) {
        if (value === null) {
          next[promptId] = null
        } else if (allowedByPrompt[promptId]?.has(value)) {
          next[promptId] = value
        } else {
          next[promptId] = null
        }
      }
      return next
    })
  })

  return (
    <div class="p-4 bg-white rounded-lg shadow mb-6">
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
      <Show when={filtersQuery.data}>
        {(data) => {
          const filters = data()
          return (
            <div class="space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <For each={filters}>
                  {(promptFilter) => {
                    return (
                      <div class="flex flex-col gap-2">
                        <label
                          class="font-medium text-sm truncate"
                          title={promptFilter.promptName || `Prompt ${promptFilter.promptId}`}
                        >
                          {promptFilter.promptName || `Prompt ${promptFilter.promptId}`}:
                        </label>
                        <select
                          class="px-3 py-2 border rounded-md"
                          value={props.promptFilters()[promptFilter.promptId] || 'all'}
                          onChange={(e) => {
                            return handlePromptFilterChange(promptFilter.promptId, e.target.value)
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

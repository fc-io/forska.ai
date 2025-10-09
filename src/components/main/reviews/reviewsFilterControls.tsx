import {useQuery} from '@tanstack/solid-query'
import * as Select from '@kobalte/core/select'
import type {Setter} from 'solid-js'
import {createEffect, createMemo, For, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

interface ReviewsFilterControlsProps {
  projectId: string
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
      enabled: !props.hidePromptSelectors,
    }
  })

  const setPromptMulti = (promptId: string, values: string[] | null) => {
    props.setPromptFilters((prev) => {
      return {...prev, [promptId]: values && values.length > 0 ? values : null}
    })
    props.setCurrentPage(1)
  }

  createEffect(() => {
    if (props.hidePromptSelectors) {
      return
    }
    const maybe = (filtersQuery as unknown as {data?: unknown}).data
    const filters =
      typeof maybe === 'function'
        ? (maybe as () => Array<{promptId: string; answeredOriginalValues: string[]}>)()
        : ((maybe as Array<{promptId: string; answeredOriginalValues: string[]}> | undefined))
    if (!filters) {
      return
    }
    const allowedByPrompt: Record<string, Set<string>> = filters.reduce((acc, f) => {
      return {...acc, [f.promptId]: new Set(f.answeredOriginalValues)}
    }, {} as Record<string, Set<string>>)
    props.setPromptFilters((prev) => {
      const next: Record<string, string[] | null> = {}
      for (const [promptId, value] of Object.entries(prev)) {
        if (value === null) {
          next[promptId] = null
        } else {
          const allowed = allowedByPrompt[promptId]
          next[promptId] = allowed ? value.filter((v) => {
            return allowed.has(v)
          }) : null
          if (next[promptId] && next[promptId]!.length === 0) {
            next[promptId] = null
          }
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
      <Show when={!props.hidePromptSelectors && filtersQuery.data}>
        {(data) => {
          const filters = data()
          return (
            <div class="space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <For each={filters}>
                  {(promptFilter) => {
                    const current = createMemo(() => props.promptFilters()[promptFilter.promptId] ?? [])
                    const options = createMemo(() => promptFilter.answeredOriginalValues)
                    return (
                      <div class="flex flex-col gap-2">
                        <label
                          class="font-medium text-sm truncate"
                          title={promptFilter.promptName || `Prompt ${promptFilter.promptId}`}
                        >
                          {promptFilter.promptName || `Prompt ${promptFilter.promptId}`}:
                        </label>
                        <Select.Root
                          multiple
                          value={current()}
                          onChange={(vals) => setPromptMulti(promptFilter.promptId, vals.length ? vals : null)}
                          options={options()}
                          optionValue={(v) => v}
                          optionLabel={(v) => v}
                          optionTextValue={(v) => v}
                          itemComponent={(itemProps) => (
                            <Select.Item
                              item={itemProps.item}
                              class="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent/60"
                            >
                              <Select.ItemLabel class="text-sm">{itemProps.item.rawValue}</Select.ItemLabel>
                              <Select.ItemIndicator>
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="3"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  class="size-3"
                                >
                                  <path d="M5 12l5 5l10 -10" />
                                </svg>
                              </Select.ItemIndicator>
                            </Select.Item>
                          )}
                        >
                          <Select.Trigger
                            class="min-h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-[box-shadow,background-color] flex items-center gap-2 focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-ring"
                            aria-label={promptFilter.promptName || `Prompt ${promptFilter.promptId}`}
                          >
                            <div class="flex flex-wrap gap-2 grow">
                              <Select.Value<string[]>>
                                {(state) => (
                                  <Show
                                    when={state.selectedOptions().length > 0}
                                    fallback={<span class="text-muted-foreground">All</span>}
                                  >
                                    <For each={state.selectedOptions()}>
                                      {(opt) => (
                                        <Select.Tag
                                          option={opt}
                                          class="inline-flex items-center gap-1 rounded bg-accent/60 px-2 py-1 text-sm"
                                        >
                                          <Select.TagLabel>{opt.label}</Select.TagLabel>
                                          <Select.TagCloseButton class="opacity-70 hover:opacity-100" />
                                        </Select.Tag>
                                      )}
                                    </For>
                                  </Show>
                                )}
                              </Select.Value>
                            </div>
                            <div class="ml-auto flex items-center gap-2">
                              <button
                                type="button"
                                class="text-xs text-blue-600 hover:underline"
                                onClick={() => setPromptMulti(promptFilter.promptId, null)}
                              >
                                Clear
                              </button>
                              <Select.Icon>
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="2"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  class="size-4 opacity-60"
                                >
                                  <path d="M6 9l6 6l6 -6" />
                                </svg>
                              </Select.Icon>
                            </div>
                          </Select.Trigger>
                          <Select.Portal>
                            <Select.Content class="z-50 min-w-56 rounded-md border bg-popover p-2 text-popover-foreground shadow-md outline-none">
                              <Select.Listbox class="max-h-60 overflow-auto" />
                            </Select.Content>
                          </Select.Portal>
                        </Select.Root>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          )
        }}
      </Show>
      <Show when={!props.hidePromptSelectors && filtersQuery.isPending}>
        <div class="text-gray-500">Loading filters...</div>
      </Show>
      <Show when={!props.hidePromptSelectors && filtersQuery.error}>
        <div class="text-red-600">Error loading filters</div>
      </Show>
    </div>
  )
}

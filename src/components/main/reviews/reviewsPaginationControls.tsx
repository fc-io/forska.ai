import {Menu} from '@ark-ui/solid'
import {useQuery, useQueryClient} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createMemo, For, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

type ListType = 'llm' | 'human' | 'both' | 'unassessed'

interface ReviewsPaginationControlsProps {
  page: number
  totalPages: number | null // null when count is still loading
  setCurrentPage: Setter<number>
  currentPageRowIds?: string[]
  rowSelection?: Accessor<Record<string, boolean>>
  setRowSelection?: Setter<Record<string, boolean>>
  totalMatchingCount?: number | null // null when count is still loading
  selectAllMatching?: Accessor<boolean>
  setSelectAllMatching?: Setter<boolean>
  // Source context
  sourceProjectId?: string
  listType?: ListType
  // Provide filter payload for server-side selection when selecting across all matching
  buildAddAllFilterBody?: () => {prompts?: Record<string, string[]>; from?: string; to?: string; search?: string}
}

export const ReviewsPaginationControls = (props: ReviewsPaginationControlsProps) => {
  const queryClient = useQueryClient()

  const handlePageChange = (newPage: number) => {
    props.setCurrentPage(newPage)
  }

  const allSelected = createMemo(() => {
    if (!props.currentPageRowIds || !props.rowSelection) return false
    const sel = props.rowSelection()
    return (
      props.currentPageRowIds.length > 0
      && props.currentPageRowIds.every((id) => {
        return Boolean(sel[id])
      })
    )
  })

  const someSelected = createMemo(() => {
    if (!props.currentPageRowIds || !props.rowSelection) return false
    const sel = props.rowSelection()
    const hasAny = props.currentPageRowIds.some((id) => {
      return Boolean(sel[id])
    })
    return hasAny && !allSelected()
  })

  let selectAllEl: HTMLInputElement | undefined
  createEffect(() => {
    if (selectAllEl) {
      selectAllEl.indeterminate = someSelected()
    }
  })

  const selectedCount = createMemo(() => {
    if (!props.currentPageRowIds || !props.rowSelection) return 0
    const sel = props.rowSelection()
    return props.currentPageRowIds.reduce((acc, id) => {
      return acc + (sel[id] ? 1 : 0)
    }, 0)
  })

  const projectsWithoutJobsQuery = useQuery(() => {
    return {
      queryKey: ['projects-without-jobs'],
      queryFn: async () => {
        const response = await apiClient.api['projects-without-jobs'].get()
        if (!response.data) {
          throw new Error('Failed to fetch projects without jobs')
        }
        return response.data.data as Array<{id: string; name: string; description?: string | null}>
      },
    }
  })

  return (
    <>
      <div class="flex items-center justify-between gap-2 p-2 bg-white rounded-lg shadow">
        <div class="flex items-center gap-2">
          <Show when={props.currentPageRowIds && props.rowSelection && props.setRowSelection}>
            <div class="flex items-center gap-2">
              <input
                ref={selectAllEl}
                type="checkbox"
                class="w-[15px] h-[15px]"
                checked={allSelected()}
                onChange={(e) => {
                  const checked = Boolean(e.currentTarget.checked)
                  const setRowSelection = props.setRowSelection
                  const currentPageRowIds = props.currentPageRowIds
                  const setSelectAllMatching = props.setSelectAllMatching
                  if (!setRowSelection || !currentPageRowIds) return
                  setRowSelection((prev) => {
                    const next: Record<string, boolean> = {...(prev || {})}
                    if (checked) {
                      for (const id of currentPageRowIds) {
                        next[id] = true
                      }
                    } else {
                      for (const id of currentPageRowIds) {
                        if (id in next) delete next[id]
                      }
                      if (setSelectAllMatching) setSelectAllMatching(false)
                    }
                    return next
                  })
                }}
              />
              <label class="text-xs text-gray-700">Select all rows</label>
              <Show when={selectedCount() > 0}>
                <Menu.Root
                  positioning={{placement: 'bottom-start'}}
                  onOpenChange={(e) => {
                    const isOpen =
                      typeof e === 'object' && e !== null && 'open' in e
                        ? Boolean((e as {open?: unknown}).open)
                        : Boolean(e)
                    if (!isOpen) {
                      void queryClient.invalidateQueries({queryKey: ['projects-without-jobs']})
                    }
                  }}
                >
                  <Menu.Trigger class="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200">
                    Add to sub-project
                  </Menu.Trigger>
                  <Menu.Positioner>
                    <Menu.Content class="mt-2 w-72 rounded-md bg-white py-2 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
                      {(() => {
                        const maybe = (projectsWithoutJobsQuery as unknown as {data?: unknown}).data
                        const projects =
                          typeof maybe === 'function'
                            ? (maybe as () => Array<{id: string; name: string}>)()
                            : (maybe as Array<{id: string; name: string}> | undefined)

                        return (
                          <>
                            <Show
                              when={projects && projects.length > 0}
                              fallback={<div class="px-4 py-2 text-sm text-gray-500">No available projects</div>}
                            >
                              <For each={projects || []}>
                                {(p) => {
                                  return (
                                    <Menu.Item value={p.id} id={p.id} class="p-0">
                                      <a
                                        href="#"
                                        class="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                                        onClick={(e) => {
                                          e.preventDefault()
                                          void (async () => {
                                            const allAcross = props.selectAllMatching && props.selectAllMatching()
                                            if (allAcross) {
                                              const filter = props.buildAddAllFilterBody
                                                ? props.buildAddAllFilterBody()
                                                : {}
                                              await apiClient.api.projects['add_articles_by_filter'].post({
                                                targetProjectId: p.id,
                                                sourceProjectId: props.sourceProjectId || '',
                                                listType: (props.listType as ListType) || 'llm',
                                                ...filter,
                                              })
                                            } else {
                                              const sel = props.rowSelection ? props.rowSelection() : {}
                                              const ids = Object.entries(sel)
                                                .filter(([, v]) => {
                                                  return Boolean(v)
                                                })
                                                .map(([k]) => {
                                                  return k
                                                })
                                              if (ids.length > 0) {
                                                await apiClient.api.projects['add_artilces_by_ids'].post({
                                                  targetProjectId: p.id,
                                                  sourceProjectId: props.sourceProjectId || '',
                                                  articleIds: ids,
                                                })
                                              }
                                            }
                                          })()
                                        }}
                                      >
                                        {p.name}
                                      </a>
                                    </Menu.Item>
                                  )
                                }}
                              </For>
                            </Show>
                          </>
                        )
                      })()}
                    </Menu.Content>
                  </Menu.Positioner>
                </Menu.Root>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={props.totalPages === null || props.totalPages > 1}>
          <div class="flex items-center justify-center gap-1">
            <button
              class="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={props.page <= 1}
              onClick={() => {
                return handlePageChange(props.page - 1)
              }}
            >
              Previous
            </button>

            <span class="mx-2 text-xs text-gray-700">
              <Show
                when={props.totalPages !== null}
                fallback={<span class="text-gray-400 animate-pulse">Page {props.page} of ...</span>}
              >
                Page {props.page} of {props.totalPages}
              </Show>
            </span>

            <button
              class="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={props.totalPages !== null && props.page >= props.totalPages}
              onClick={() => {
                return handlePageChange(props.page + 1)
              }}
            >
              Next
            </button>
          </div>
        </Show>

        <Show when={props.totalPages !== null && props.totalPages > 1}>
          <div class="flex items-center gap-1">
            <label class="text-xs text-gray-700">Go to page:</label>
            <input
              type="number"
              min="1"
              max={props.totalPages ?? undefined}
              value={props.page}
              class="w-12 px-1 py-0.5 text-xs border rounded"
              onInput={(e) => {
                const newPage = parseInt(e.target.value)
                if (newPage >= 1 && (props.totalPages === null || newPage <= props.totalPages)) {
                  handlePageChange(newPage)
                }
              }}
            />
          </div>
        </Show>
      </div>
      <Show when={allSelected()}>
        {(() => {
          const allAcross = props.selectAllMatching && props.selectAllMatching()
          const total = props.totalMatchingCount ?? null
          return (
            <>
              {allAcross ? (
                <div class="mt-2 text-xs text-gray-700 p-2 bg-white rounded-lg shadow">
                  <Show
                    when={total !== null}
                    fallback={<span class="text-gray-400 animate-pulse">Counting selected articles...</span>}
                  >
                    All {total} articles matching filter is selected.
                  </Show>
                </div>
              ) : (
                <div class="mt-2 text-xs text-gray-700 p-2 bg-white rounded-lg shadow flex items-center gap-2">
                  <span>{selectedCount()} rows selected</span>
                  <Show when={total !== null && total > 0 && props.setSelectAllMatching}>
                    <button
                      class="text-blue-600 hover:underline"
                      onClick={() => {
                        if (props.setSelectAllMatching) props.setSelectAllMatching(true)
                      }}
                    >
                      Select all {total} articles
                    </button>
                  </Show>
                  <Show when={total === null}>
                    <span class="text-gray-400 animate-pulse">Counting...</span>
                  </Show>
                </div>
              )}
            </>
          )
        })()}
      </Show>
    </>
  )
}

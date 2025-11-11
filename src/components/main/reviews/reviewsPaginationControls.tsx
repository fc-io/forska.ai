import {Menu} from '@ark-ui/solid'
import {useQuery, useQueryClient} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createMemo, For, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'

interface ReviewsPaginationControlsProps {
  page: number
  totalPages: number
  setCurrentPage: Setter<number>
  currentPageRowIds?: string[]
  rowSelection?: Accessor<Record<string, boolean>>
  setRowSelection?: Setter<Record<string, boolean>>
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

  const toggleSelectAll = (checked: boolean) => {
    if (!props.setRowSelection || !props.currentPageRowIds) return
    props.setRowSelection((prev) => {
      const next: Record<string, boolean> = {...(prev || {})}
      if (checked) {
        for (const id of props.currentPageRowIds || []) {
          next[id] = true
        }
      } else {
        for (const id of props.currentPageRowIds || []) {
          if (id in next) delete next[id]
        }
      }
      return next
    })
  }

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
                  toggleSelectAll(Boolean(e.currentTarget.checked))
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
                                          const sel = props.rowSelection ? props.rowSelection() : {}
                                          const selectedIds = Object.entries(sel)
                                            .filter(([, v]) => {
                                              return Boolean(v)
                                            })
                                            .map(([k]) => {
                                              return k
                                            })
                                          console.log(
                                            'selectedArticleIds: ',
                                            selectedIds.length,
                                            `${selectedIds[0]}...`,
                                          )
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

        <Show when={props.totalPages > 1}>
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
              Page {props.page} of {props.totalPages}
            </span>

            <button
              class="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={props.page >= props.totalPages}
              onClick={() => {
                return handlePageChange(props.page + 1)
              }}
            >
              Next
            </button>
          </div>
        </Show>

        <Show when={props.totalPages > 1}>
          <div class="flex items-center gap-1">
            <label class="text-xs text-gray-700">Go to page:</label>
            <input
              type="number"
              min="1"
              max={props.totalPages}
              value={props.page}
              class="w-12 px-1 py-0.5 text-xs border rounded"
              onInput={(e) => {
                const newPage = parseInt(e.target.value)
                if (newPage >= 1 && newPage <= props.totalPages) {
                  handlePageChange(newPage)
                }
              }}
            />
          </div>
        </Show>
      </div>
      <Show when={allSelected()}>
        <div class="mt-2 text-xs text-gray-700 p-2 bg-white rounded-lg shadow">{selectedCount()} rows selected</div>
      </Show>
    </>
  )
}

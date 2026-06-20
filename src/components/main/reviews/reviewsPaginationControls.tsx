import {Menu} from '@ark-ui/solid'
import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import type {Accessor, Setter} from 'solid-js'
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

type ListType = 'llm' | 'human' | 'both' | 'unassessed'

type AddArticlesJobResponse = {
  job?: {jobId?: string; status?: string}
  providedTotal?: number
  targetProjectId?: string
}

type AddArticlesJobStatusResponse = {
  job?: {
    jobId?: string
    lastError?: string | null
    processedCount?: number
    status?: string
    totalEstimate?: number | null
  }
  targetProjectId?: string | null
}

type LastAddArticlesJob = {jobId: string; sourceProjectId: string; targetProjectId?: string; total?: number}

const terminalAddArticlesJobStatuses = new Set(['cancelled', 'completed', 'failed'])

const getAddArticlesJobId = (data: AddArticlesJobResponse) => {
  const jobId = data.job?.jobId

  return typeof jobId === 'string' ? jobId : null
}

const shouldPollAddArticlesJob = (data?: AddArticlesJobStatusResponse) => {
  const status = data?.job?.status

  return status === undefined || !terminalAddArticlesJobStatuses.has(status)
}

const isTerminalAddArticlesJobStatus = (status: string | undefined) => {
  return Boolean(status && terminalAddArticlesJobStatuses.has(status))
}

interface ReviewsPaginationControlsProps {
  page: number
  hasNextPage?: boolean
  isLoadingMore?: boolean
  totalPages: number | null // null when count is still loading
  setCurrentPage: Setter<number>
  useCursorPagination?: boolean
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
  buildAddAllFilterBody?: () => {
    prompts?: Record<string, string[]>
    from?: string
    to?: string
    search?: string
    llmStatus?: 'complete' | 'both' | 'partial'
    hasDuplicateStudyRecords?: true
    hasStudyDecisionConflict?: true
  }
}

export const ReviewsPaginationControls = (props: ReviewsPaginationControlsProps) => {
  const queryClient = useQueryClient()
  const [lastPdfJobId, setLastPdfJobId] = createSignal<string | null>(null)
  const [lastAddArticlesJob, setLastAddArticlesJob] = createSignal<LastAddArticlesJob | null>(null)

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

  const startPdfFetchJobMutation = createMutation(() => {
    return {
      mutationFn: async (args: {mode: 'ids'; articleIds: string[]} | {mode: 'filter'}) => {
        if (args.mode === 'filter') {
          const sourceProjectId = props.sourceProjectId
          const listType = props.listType
          if (!sourceProjectId || !listType) {
            throw new Error('Missing project context for PDF fetch')
          }
          const filter = props.buildAddAllFilterBody ? props.buildAddAllFilterBody() : {}
          const response =
            listType === 'unassessed'
              ? await apiClient.api.articles['pdf-fetch-by-project'].post({
                  projectId: sourceProjectId,
                  from: filter.from,
                  to: filter.to,
                  search: filter.search,
                })
              : await apiClient.api.articles['pdf-fetch-by-filter'].post({sourceProjectId, listType, ...filter})
          return handleApiResponse(response, 'Failed to start PDF fetch job')
        }

        const response = await apiClient.api.articles['pdf-fetch-bulk'].post({articleIds: args.articleIds})
        return handleApiResponse(response, 'Failed to start PDF fetch job')
      },
      onSuccess: (data) => {
        const jobIdCandidate =
          data
          && typeof data === 'object'
          && 'job' in data
          && data.job
          && typeof data.job === 'object'
          && 'jobId' in data.job
            ? (data.job as {jobId?: unknown}).jobId
            : null
        const jobId = typeof jobIdCandidate === 'string' ? jobIdCandidate : null
        setLastPdfJobId(jobId)
      },
    }
  })

  const addArticlesJobStatusQuery = useQuery(() => {
    const job = lastAddArticlesJob()

    return {
      enabled: job !== null,
      queryFn: async () => {
        const response = await apiClient.api.projects['add_articles_jobs'].get({
          query: {jobId: job?.jobId ?? '', sourceProjectId: job?.sourceProjectId ?? ''},
        })

        return handleApiResponse(response, 'Failed to load add-to-project job status')
      },
      queryKey: ['projects', 'add-articles-job', job?.sourceProjectId, job?.jobId],
      refetchInterval: (query: {state: {data?: AddArticlesJobStatusResponse}}) => {
        return shouldPollAddArticlesJob(query.state.data) ? 2_000 : false
      },
      suspense: false,
    }
  })

  const addArticlesToProjectMutation = createMutation(() => {
    return {
      mutationFn: async (
        args: {mode: 'ids'; articleIds: string[]; targetProjectId: string} | {mode: 'filter'; targetProjectId: string},
      ) => {
        const sourceProjectId = props.sourceProjectId || ''
        const listType = props.listType || 'llm'
        const response =
          args.mode === 'filter'
            ? await apiClient.api.projects['add_articles_by_filter'].post({
                targetProjectId: args.targetProjectId,
                sourceProjectId,
                listType,
                ...(props.buildAddAllFilterBody ? props.buildAddAllFilterBody() : {}),
              })
            : await apiClient.api.projects['add_articles_by_ids'].post({
                targetProjectId: args.targetProjectId,
                sourceProjectId,
                articleIds: args.articleIds,
              })

        return handleApiResponse(response, 'Failed to start add-to-project job') as AddArticlesJobResponse
      },
      onSuccess: (data, args) => {
        const jobId = getAddArticlesJobId(data)
        const sourceProjectId = props.sourceProjectId || ''

        if (jobId && sourceProjectId) {
          setLastAddArticlesJob({
            jobId,
            sourceProjectId,
            targetProjectId: data.targetProjectId ?? args.targetProjectId,
            total: data.providedTotal,
          })
        }
      },
    }
  })

  createEffect(() => {
    const status = addArticlesJobStatusQuery.data?.job?.status

    if (isTerminalAddArticlesJobStatus(status)) {
      void queryClient.invalidateQueries({queryKey: ['projects-without-jobs']})
      void queryClient.invalidateQueries({queryKey: ['project-curated-articles']})
    }
  })

  return (
    <>
      <div class="flex items-center justify-between gap-2 p-2 bg-white rounded-lg shadow">
        <div class="flex items-center gap-2">
          <Show when={props.currentPageRowIds && props.rowSelection && props.setRowSelection}>
            <div class="flex items-center gap-2">
              <input
                ref={(element) => {
                  selectAllEl = element
                }}
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
                <div class="flex items-center gap-2">
                  <Menu.Root
                    lazyMount
                    unmountOnExit
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
                                                addArticlesToProjectMutation.mutate({
                                                  mode: 'filter',
                                                  targetProjectId: p.id,
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
                                                  addArticlesToProjectMutation.mutate({
                                                    mode: 'ids',
                                                    targetProjectId: p.id,
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

                  <button
                    type="button"
                    disabled={startPdfFetchJobMutation.isPending}
                    class="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => {
                      const allAcross = props.selectAllMatching && props.selectAllMatching()
                      if (allAcross) {
                        return startPdfFetchJobMutation.mutate({mode: 'filter'})
                      }

                      const sel = props.rowSelection ? props.rowSelection() : {}
                      const ids = Object.entries(sel)
                        .filter(([, v]) => {
                          return Boolean(v)
                        })
                        .map(([k]) => {
                          return k
                        })
                      return ids.length > 0
                        ? startPdfFetchJobMutation.mutate({mode: 'ids', articleIds: ids})
                        : undefined
                    }}
                  >
                    Download PDFs for selected
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={props.useCursorPagination || props.totalPages === null || props.totalPages > 1}>
          <div class="flex items-center justify-center gap-1">
            <Show
              when={props.useCursorPagination}
              fallback={
                <>
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
                      fallback={<span class="text-gray-600">Page {props.page}</span>}
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
                </>
              }
            >
              <button
                class="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={props.hasNextPage === false || props.isLoadingMore}
                onClick={() => {
                  return handlePageChange(props.page + 1)
                }}
              >
                {props.isLoadingMore ? 'Loading...' : props.hasNextPage === false ? 'All Loaded' : 'Load More'}
              </button>
            </Show>
          </div>
        </Show>

        <Show when={!props.useCursorPagination && props.totalPages !== null && props.totalPages > 1}>
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
                    fallback={
                      <span class="inline-flex items-center gap-2">
                        <span class="text-gray-600">Counting selected articles</span>
                        <span class="h-3 w-16 animate-pulse rounded bg-gray-200" />
                      </span>
                    }
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
                    <span class="inline-flex items-center gap-2">
                      <span class="text-gray-600">Counting</span>
                      <span class="h-3 w-12 animate-pulse rounded bg-gray-200" />
                    </span>
                  </Show>
                </div>
              )}
            </>
          )
        })()}
      </Show>

      <Show when={startPdfFetchJobMutation.isSuccess && lastPdfJobId()}>
        <div class="mt-2 text-xs text-gray-700 p-2 bg-white rounded-lg shadow">
          PDF fetch job started: <span class="font-mono select-all">{lastPdfJobId()}</span>
        </div>
      </Show>

      <Show when={lastAddArticlesJob()}>
        {(job) => {
          const status = () => {
            return addArticlesJobStatusQuery.data?.job?.status ?? 'pending'
          }
          const processedCount = () => {
            return addArticlesJobStatusQuery.data?.job?.processedCount
          }
          const totalEstimate = () => {
            return addArticlesJobStatusQuery.data?.job?.totalEstimate ?? job().total
          }
          const progressText = () => {
            const processed = processedCount()
            const total = totalEstimate()

            return typeof processed === 'number' && typeof total === 'number' ? ` (${processed}/${total})` : ''
          }

          return (
            <div class="mt-2 text-xs text-gray-700 p-2 bg-white rounded-lg shadow">
              Add-to-project job {status()}
              {progressText()}: <span class="font-mono select-all">{job().jobId}</span>
              <Show when={addArticlesJobStatusQuery.data?.job?.lastError}>
                {(lastError) => {
                  return <span class="text-red-700"> {lastError()}</span>
                }}
              </Show>
            </div>
          )
        }}
      </Show>

      <Show when={addArticlesToProjectMutation.isError || addArticlesJobStatusQuery.isError}>
        <div class="mt-2 text-xs text-red-700 p-2 bg-red-50 border border-red-200 rounded-lg shadow">
          Failed to track add-to-project job:{' '}
          {String(addArticlesToProjectMutation.error ?? addArticlesJobStatusQuery.error)}
        </div>
      </Show>

      <Show when={startPdfFetchJobMutation.isError}>
        <div class="mt-2 text-xs text-red-700 p-2 bg-red-50 border border-red-200 rounded-lg shadow">
          Failed to start PDF fetch job: {String(startPdfFetchJobMutation.error)}
        </div>
      </Show>
    </>
  )
}

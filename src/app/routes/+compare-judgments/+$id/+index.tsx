import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, on, onMount, Show} from 'solid-js'

import {
  ComparisonProjectJudgmentsTable,
  type ComparisonProjectJudgmentsTableColumn,
} from '../../../../components/main/comparisonProjectJudgmentsTable/comparisonProjectJudgmentsTable.tsx'
import {Button} from '../../../../components/ui/button'
import {
  type ComparisonProjectJudgmentsColumn,
  type ComparisonProjectJudgmentsPage,
  fetchComparisonProjectJudgmentsCount,
  fetchComparisonProjectJudgmentsMetadata,
  fetchComparisonProjectJudgmentsPage,
  resetComparisonProjectConflictResolution,
  setComparisonProjectConflictResolution,
} from '../../../../services/comparisonProjectsService'
import {getOrderedComparisonProjectColumns} from '../../../../utils/comparisonProjectColumnOrder.ts'
import {
  type ComparisonProjectDifferenceFilter,
  getAvailableComparisonProjectDifferenceFilters,
  getComparisonProjectDifferenceFilterLabel,
} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  comparisonProjectRowFilters,
  getComparisonProjectRowFilterLabel,
  getNormalizedComparisonProjectRowFilter,
} from '../../../../utils/comparisonProjectRowFilter.ts'
import {
  compareProjectJudgmentsPageLimitOptions,
  getCanFetchCompareProjectJudgmentsPage,
  getCompareProjectJudgmentsConfirmedDifferenceFilter,
  getCompareProjectJudgmentsSearchParams,
  getInitialCompareProjectJudgmentsUrlState,
} from './+index/compareProjectJudgmentsUrlState.ts'

const getContentSettingsLabel = (contentVariants: Array<{label: string}>) => {
  return contentVariants.length > 0
    ? contentVariants
        .map((contentVariant) => {
          return contentVariant.label
        })
        .join(' · ')
    : 'none'
}

const getRangeLabel = (page: number, limit: number, rowCount: number, totalCount: number | null) => {
  if (totalCount === null) {
    const start = (page - 1) * limit + 1
    const end = start + rowCount - 1

    return rowCount === 0 ? 'Showing 0 results' : `Showing ${start}-${end}`
  }

  if (totalCount === 0) {
    return 'Showing 0 results'
  }

  const start = (page - 1) * limit + 1
  const end = Math.min(page * limit, totalCount)

  return `Showing ${start}-${end} of ${totalCount}`
}

const getHumanJudgmentModeLabel = (humanJudgmentMode: 'prompt' | 'summary') => {
  return humanJudgmentMode === 'summary' ? 'Summary overall decisions' : 'Prompt-by-prompt decisions'
}

const getConflictResolutionPromptLabel = (prompt: {
  criteriaDisposition: string | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
  promptLabel: string
}) => {
  const criteriaLabel = [prompt.criteriaDisposition, prompt.criteriaSectionLabel ?? prompt.criteriaSectionKey]
    .filter(Boolean)
    .join(' · ')

  return criteriaLabel ? `${prompt.promptLabel} (${criteriaLabel})` : prompt.promptLabel
}

const getPromptTypeOptions = (type: string | null) => {
  const matches = type?.match(/['"]([^'"]+)['"]/g) ?? []

  return matches.map((match) => {
    return match.slice(1, -1)
  })
}

const getUniqueConflictResolutionOptions = (options: Array<{label: string; value: string}>) => {
  return Array.from(
    options
      .reduce<Map<string, {label: string; value: string}>>((optionMap, option) => {
        if (!optionMap.has(option.value)) {
          optionMap.set(option.value, option)
        }

        return optionMap
      }, new Map<string, {label: string; value: string}>())
      .values(),
  )
}

const getHumanColumnSourceProjectId = (comparisonProject?: {
  humanJudgmentMode: 'prompt' | 'summary'
  summarySourceProjectId: string | null
  sourceProjects: Array<{id: string}>
}) => {
  return comparisonProject?.humanJudgmentMode === 'summary'
    ? comparisonProject.summarySourceProjectId
    : (comparisonProject?.sourceProjects[0]?.id ?? null)
}

const getSourceProjectName = (sourceProject: {name: string} | undefined) => {
  return sourceProject?.name ?? null
}

const getColumnSourceProjectId = (
  column: ComparisonProjectJudgmentsColumn,
  comparisonProject?: {
    humanJudgmentMode: 'prompt' | 'summary'
    summarySourceProjectId: string | null
    sourceProjects: Array<{id: string; modelId: string}>
  },
) => {
  return column.kind === 'human'
    ? getHumanColumnSourceProjectId(comparisonProject)
    : (comparisonProject?.sourceProjects.find((sourceProject) => {
        return sourceProject.modelId === column.modelId
      })?.id ?? null)
}

const getColumnSourceProjectName = (
  column: ComparisonProjectJudgmentsColumn,
  comparisonProject?: {
    humanJudgmentMode: 'prompt' | 'summary'
    summarySourceProjectId: string | null
    sourceProjects: Array<{id: string; modelId: string; name: string}>
  },
) => {
  if (column.sourceProjectName) {
    return column.sourceProjectName
  }

  if (column.kind === 'human') {
    const sourceProjectId = getHumanColumnSourceProjectId(comparisonProject)
    return getSourceProjectName(
      comparisonProject?.sourceProjects.find((sourceProject) => {
        return sourceProject.id === sourceProjectId
      }),
    )
  }

  return getSourceProjectName(
    comparisonProject?.sourceProjects.find((sourceProject) => {
      return sourceProject.id === column.sourceProjectId || sourceProject.modelId === column.modelId
    }),
  )
}

const CompareProjectJudgmentsPage = () => {
  const params = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const initialUrlState = getInitialCompareProjectJudgmentsUrlState(search() as Record<string, unknown>)
  const comparisonProjectId = () => {
    const routeParams = params()

    return 'id' in routeParams ? routeParams.id : ''
  }
  const [currentPage, setCurrentPage] = createSignal(initialUrlState.currentPage)
  const [pageLimit, setPageLimit] = createSignal(initialUrlState.pageLimit)
  const [rowFilter, setRowFilter] = createSignal<ComparisonProjectRowFilter>(initialUrlState.rowFilter)
  const [differenceFilter, setDifferenceFilter] = createSignal<ComparisonProjectDifferenceFilter>(
    initialUrlState.differenceFilter,
  )
  const [conflictResolutionPendingArticleId, setConflictResolutionPendingArticleId] = createSignal<string | null>(null)
  const [conflictResolutionError, setConflictResolutionError] = createSignal<string | null>(null)
  const [searchInitialized, setSearchInitialized] = createSignal(false)

  onMount(() => {
    setSearchInitialized(true)
  })

  const comparisonProjectQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-judgments-metadata', comparisonProjectId()],
      queryFn: () => {
        return fetchComparisonProjectJudgmentsMetadata(comparisonProjectId())
      },
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    }
  })
  const orderedColumns = createMemo<ComparisonProjectJudgmentsTableColumn[]>(() => {
    const comparisonProject = comparisonProjectQuery.data

    return getOrderedComparisonProjectColumns(comparisonProject?.columns ?? [], comparisonProject?.prompts ?? []).map(
      (column) => {
        return {
          ...column,
          sourceProjectId: column.sourceProjectId ?? getColumnSourceProjectId(column, comparisonProject),
          sourceProjectName: getColumnSourceProjectName(column, comparisonProject),
        }
      },
    )
  })
  const availableDifferenceFilters = createMemo(() => {
    return getAvailableComparisonProjectDifferenceFilters(orderedColumns())
  })
  const getCurrentJudgmentsPageQueryKey = () => {
    return [
      'comparison-project-judgments-page',
      comparisonProjectId(),
      currentPage(),
      pageLimit(),
      rowFilter(),
      differenceFilter(),
    ] as const
  }
  const getCurrentJudgmentsCountQueryKey = () => {
    return [
      'comparison-project-judgments-count',
      comparisonProjectId(),
      pageLimit(),
      rowFilter(),
      differenceFilter(),
    ] as const
  }
  const canFetchJudgmentsPage = createMemo(() => {
    return getCanFetchCompareProjectJudgmentsPage({
      availableDifferenceFilters: availableDifferenceFilters(),
      differenceFilter: differenceFilter(),
      hasLoadedMetadata: comparisonProjectQuery.isSuccess,
      searchInitialized: searchInitialized(),
    })
  })
  const judgmentsPageQuery = useQuery(() => {
    return {
      queryKey: getCurrentJudgmentsPageQueryKey(),
      queryFn: () => {
        return fetchComparisonProjectJudgmentsPage(
          comparisonProjectId(),
          currentPage(),
          pageLimit(),
          rowFilter(),
          differenceFilter(),
        )
      },
      enabled: canFetchJudgmentsPage(),
      refetchOnWindowFocus: false,
    }
  })
  const judgmentsCountQuery = useQuery(() => {
    return {
      queryKey: getCurrentJudgmentsCountQueryKey(),
      queryFn: () => {
        return fetchComparisonProjectJudgmentsCount(comparisonProjectId(), pageLimit(), rowFilter(), differenceFilter())
      },
      enabled: canFetchJudgmentsPage(),
      refetchOnWindowFocus: false,
    }
  })
  const exactTotalCount = createMemo(() => {
    return judgmentsCountQuery.data?.totalCount ?? null
  })
  const exactTotalPages = createMemo(() => {
    return judgmentsCountQuery.data?.totalPages ?? null
  })

  const canGoToPreviousPage = createMemo(() => {
    return currentPage() > 1
  })
  const canGoToNextPage = createMemo(() => {
    return Boolean(judgmentsPageQuery.data?.nextCursor)
  })
  const conflictResolutionOptions = createMemo(() => {
    const comparisonProject = comparisonProjectQuery.data

    return comparisonProject?.compareWithHumans && comparisonProject.humanJudgmentMode === 'summary'
      ? getUniqueConflictResolutionOptions(
          comparisonProject.prompts.flatMap((prompt) => {
            return getPromptTypeOptions(prompt.type).map((option) => {
              return {label: option, value: option}
            })
          }),
        )
      : (comparisonProject?.prompts ?? []).map((prompt) => {
          return {label: getConflictResolutionPromptLabel(prompt), value: prompt.id}
        })
  })
  const isSummaryMode = createMemo(() => {
    const comparisonProject = comparisonProjectQuery.data

    return Boolean(comparisonProject?.compareWithHumans && comparisonProject.humanJudgmentMode === 'summary')
  })
  const differenceFilterOptions = createMemo(() => {
    return availableDifferenceFilters().map((value) => {
      return {label: getComparisonProjectDifferenceFilterLabel(value), value}
    })
  })
  const compareSearchParams = createMemo(() => {
    return getCompareProjectJudgmentsSearchParams({
      currentPage: currentPage(),
      pageLimit: pageLimit(),
      rowFilter: rowFilter(),
      differenceFilter: differenceFilter(),
    })
  })

  createEffect(() => {
    const confirmedDifferenceFilter = getCompareProjectJudgmentsConfirmedDifferenceFilter({
      availableDifferenceFilters: availableDifferenceFilters(),
      differenceFilter: differenceFilter(),
      hasLoadedMetadata: comparisonProjectQuery.isSuccess,
    })

    if (confirmedDifferenceFilter !== differenceFilter()) {
      setDifferenceFilter(confirmedDifferenceFilter)
    }
  })

  createEffect(
    on([currentPage, pageLimit, rowFilter, differenceFilter, searchInitialized], () => {
      if (!searchInitialized()) {
        return
      }

      void navigate({
        to: '/compare-judgments/$id/' as '/',
        params: {id: comparisonProjectId()} as never,
        search: compareSearchParams() as never,
        replace: true,
      })
    }),
  )

  const serverFilteredRows = createMemo(() => {
    return judgmentsPageQuery.data?.data ?? []
  })
  const hasRowFilters = createMemo(() => {
    return rowFilter() !== 'all' || differenceFilter() !== 'all'
  })
  const updateCurrentJudgmentsPageConflictResolution = (
    articleId: string,
    conflictResolution: {articleId: string; label: string; value: string} | null,
  ) => {
    queryClient.setQueryData<ComparisonProjectJudgmentsPage>(getCurrentJudgmentsPageQueryKey(), (currentPageData) => {
      return currentPageData
        ? {
            ...currentPageData,
            data: currentPageData.data.map((row) => {
              return row.id === articleId ? {...row, conflictResolution} : row
            }),
          }
        : currentPageData
    })
  }
  const refetchCurrentJudgmentsPage = async () => {
    await queryClient.invalidateQueries({queryKey: ['comparison-project-judgments-page', comparisonProjectId()]})
  }
  const handleConflictResolutionSelect = async (articleId: string, value: string) => {
    setConflictResolutionPendingArticleId(articleId)
    setConflictResolutionError(null)

    try {
      const conflictResolution = await setComparisonProjectConflictResolution(comparisonProjectId(), {articleId, value})
      updateCurrentJudgmentsPageConflictResolution(articleId, conflictResolution)
      await refetchCurrentJudgmentsPage()
    } catch (error) {
      setConflictResolutionError(error instanceof Error ? error.message : 'Failed to save conflict resolution')
    } finally {
      setConflictResolutionPendingArticleId(null)
    }
  }
  const handleConflictResolutionReset = async (articleId: string) => {
    setConflictResolutionPendingArticleId(articleId)
    setConflictResolutionError(null)

    try {
      await resetComparisonProjectConflictResolution(comparisonProjectId(), {articleId})
      updateCurrentJudgmentsPageConflictResolution(articleId, null)
      await refetchCurrentJudgmentsPage()
    } catch (error) {
      setConflictResolutionError(error instanceof Error ? error.message : 'Failed to reset conflict resolution')
    } finally {
      setConflictResolutionPendingArticleId(null)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} to="/compare-judgments" variant="outline" size="sm">
            ← Back to Compare Judgments
          </Button>
          <div>
            <h1 class="text-2xl font-bold">Compare Project Judgments</h1>
            <p class="text-sm text-gray-500">{comparisonProjectQuery.data?.name ?? 'Loading comparison project...'}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button
            as={Link}
            to="/compare-judgments/$id/export"
            params={{id: comparisonProjectId()} as never}
            search={compareSearchParams() as never}
            variant="outline"
            size="sm"
          >
            Export data
          </Button>
          <Show when={comparisonProjectQuery.data?.archived}>
            <span class="inline-flex items-center rounded-full bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700">
              Archived
            </span>
          </Show>
        </div>
      </div>

      <Show when={comparisonProjectQuery.isError}>
        <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {comparisonProjectQuery.error instanceof Error
            ? comparisonProjectQuery.error.message
            : 'Failed to load comparison project'}
        </div>
      </Show>

      <Show when={!comparisonProjectQuery.isError && comparisonProjectQuery.data}>
        {(comparisonProject) => {
          return (
            <div class="space-y-6">
              <div class="rounded-lg bg-white p-6 shadow">
                <div class="grid gap-4 md:grid-cols-4">
                  <div>
                    <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Description</p>
                    <p class="mt-2 text-sm text-gray-700">
                      {comparisonProject().description?.trim() || 'No description provided.'}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Compare Content</p>
                    <p class="mt-2 text-sm text-gray-700">
                      {getContentSettingsLabel(comparisonProject().contentVariants)}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Prompts and Models</p>
                    <p class="mt-2 text-sm text-gray-700">
                      {comparisonProject().prompts.length} prompts · {comparisonProject().models.length} models
                    </p>
                    <Show when={comparisonProject().sourceProjects.length > 0}>
                      <p class="mt-1 text-xs text-gray-500">
                        Included projects:{' '}
                        {comparisonProject()
                          .sourceProjects.map((sourceProject) => {
                            return sourceProject.name
                          })
                          .join(' · ')}
                      </p>
                    </Show>
                  </div>
                  <div>
                    <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Human Comparison</p>
                    <p class="mt-2 text-sm text-gray-700">
                      {comparisonProject().compareWithHumans
                        ? getHumanJudgmentModeLabel(comparisonProject().humanJudgmentMode)
                        : 'Not included'}
                    </p>
                    <Show when={comparisonProject().summarySourceProject}>
                      {(summarySourceProject) => {
                        return <p class="mt-1 text-xs text-gray-500">Summary source: {summarySourceProject().name}</p>
                      }}
                    </Show>
                    <p class="mt-1 text-xs text-gray-500">
                      Conflict resolution: {comparisonProject().allowConflictResolution ? 'Enabled' : 'Disabled'}
                    </p>
                  </div>
                </div>
              </div>

              <div class="space-y-4">
                <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-4 shadow">
                  <div>
                    <h2 class="text-lg font-semibold">Article Judgments</h2>
                    <p class="text-sm text-gray-600">
                      {judgmentsPageQuery.data
                        ? getRangeLabel(
                            judgmentsPageQuery.data.page,
                            judgmentsPageQuery.data.limit,
                            judgmentsPageQuery.data.data.length,
                            exactTotalCount(),
                          )
                        : 'Loading results...'}
                    </p>
                  </div>
                  <div class="flex items-center gap-3">
                    <label class="flex items-center gap-2 text-sm text-gray-600">
                      <span>Row filter</span>
                      <select
                        value={rowFilter()}
                        class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
                        onChange={(event) => {
                          setRowFilter(getNormalizedComparisonProjectRowFilter(event.currentTarget.value))
                          setCurrentPage(1)
                        }}
                      >
                        <For each={comparisonProjectRowFilters}>
                          {(option) => {
                            return (
                              <option value={option}>
                                {getComparisonProjectRowFilterLabel(option, Boolean(isSummaryMode()))}
                              </option>
                            )
                          }}
                        </For>
                      </select>
                    </label>
                    <Show when={differenceFilterOptions().length > 1}>
                      <label class="flex items-center gap-2 text-sm text-gray-600">
                        <span>Difference filter</span>
                        <select
                          value={differenceFilter()}
                          class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
                          onChange={(event) => {
                            setDifferenceFilter(event.currentTarget.value as ComparisonProjectDifferenceFilter)
                            setCurrentPage(1)
                          }}
                        >
                          <For each={differenceFilterOptions()}>
                            {(option) => {
                              return <option value={option.value}>{option.label}</option>
                            }}
                          </For>
                        </select>
                      </label>
                    </Show>
                    <label class="flex items-center gap-2 text-sm text-gray-600">
                      <span>Rows</span>
                      <select
                        value={pageLimit()}
                        class="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
                        onChange={(event) => {
                          setPageLimit(Number(event.currentTarget.value))
                          setCurrentPage(1)
                        }}
                      >
                        <For each={compareProjectJudgmentsPageLimitOptions}>
                          {(option) => {
                            return <option value={option}>{option}</option>
                          }}
                        </For>
                      </select>
                    </label>
                    <div class="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canGoToPreviousPage()}
                        onClick={() => {
                          setCurrentPage((page) => {
                            return page - 1
                          })
                        }}
                      >
                        Previous
                      </Button>
                      <span class="text-sm text-gray-600">
                        {exactTotalPages() === null
                          ? `Page ${judgmentsPageQuery.data?.page ?? currentPage()}`
                          : `Page ${judgmentsPageQuery.data?.page ?? currentPage()} of ${exactTotalPages() ?? 0}`}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canGoToNextPage()}
                        onClick={() => {
                          setCurrentPage((page) => {
                            return page + 1
                          })
                        }}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </div>

                <Show when={judgmentsPageQuery.isPending}>
                  <div class="rounded-lg bg-white p-8 text-center text-gray-500 shadow">
                    Loading article judgments...
                  </div>
                </Show>

                <Show when={judgmentsPageQuery.isError}>
                  <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
                    {judgmentsPageQuery.error instanceof Error
                      ? judgmentsPageQuery.error.message
                      : 'Failed to load comparison project judgments'}
                  </div>
                </Show>

                <Show when={conflictResolutionError()}>
                  <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
                    {conflictResolutionError()}
                  </div>
                </Show>

                <Show
                  when={!judgmentsPageQuery.isPending && !judgmentsPageQuery.isError && orderedColumns().length === 0}
                >
                  <div class="rounded-lg bg-white p-8 text-center text-gray-500 shadow">
                    No comparison columns are available yet for this comparison project.
                  </div>
                </Show>

                <Show
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && orderedColumns().length > 0
                    && serverFilteredRows().length > 0
                  }
                >
                  <ComparisonProjectJudgmentsTable
                    columns={orderedColumns()}
                    conflictResolutionEnabled={comparisonProject().allowConflictResolution}
                    conflictResolutionPendingArticleId={conflictResolutionPendingArticleId()}
                    conflictResolutionOptions={conflictResolutionOptions()}
                    onConflictResolutionReset={handleConflictResolutionReset}
                    onConflictResolutionSelect={handleConflictResolutionSelect}
                    rows={serverFilteredRows()}
                  />
                </Show>

                <Show
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && orderedColumns().length > 0
                    && serverFilteredRows().length === 0
                  }
                >
                  <div class="rounded-lg bg-white p-8 text-center text-gray-500 shadow">
                    {hasRowFilters() ? 'No rows match the selected filters.' : 'No matching article judgments found.'}
                  </div>
                </Show>
              </div>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/compare-judgments/$id/')({component: CompareProjectJudgmentsPage})

import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, on, onMount, Show} from 'solid-js'

import {
  ComparisonProjectJudgmentsTable,
  type ComparisonProjectJudgmentsTableColumn,
} from '../../../../components/main/comparisonProjectJudgmentsTable/comparisonProjectJudgmentsTable.tsx'
import {Button} from '../../../../components/ui/button'
import {
  type ComparisonProjectJudgmentsColumn,
  fetchComparisonProjectJudgmentsMetadata,
  fetchComparisonProjectJudgmentsPage,
} from '../../../../services/comparisonProjectsService'
import {
  type ComparisonProjectDifferenceFilter,
  getAvailableComparisonProjectDifferenceFilters,
  getComparisonProjectDifferenceFilterLabel,
  getComparisonProjectHasDifferenceFilterMatch,
} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  comparisonProjectRowFilters,
  defaultComparisonProjectRowFilter,
  getComparisonProjectRowFilterLabel,
  getNormalizedComparisonProjectRowFilter,
} from '../../../../utils/comparisonProjectRowFilter.ts'

const pageLimitOptions = [25, 50, 100]

type CompareProjectJudgmentsUrlState = {
  currentPage: number
  pageLimit: number
  rowFilter: ComparisonProjectRowFilter
  differenceFilter: ComparisonProjectDifferenceFilter
}

const getDefaultCompareProjectJudgmentsUrlState = (): CompareProjectJudgmentsUrlState => {
  return {currentPage: 1, pageLimit: 50, rowFilter: defaultComparisonProjectRowFilter, differenceFilter: 'all'}
}

const getPositiveIntegerSearchParamValue = (value: unknown, fallback: number) => {
  const parsedValue = typeof value === 'number' ? value : Number.parseInt(typeof value === 'string' ? value : '', 10)

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

const getDifferenceFilterSearchParamValue = (value: unknown): ComparisonProjectDifferenceFilter => {
  return value === 'human-vs-llm' || value === 'llm-vs-llm' || value === 'any-disagreement' ? value : 'all'
}

const getInitialCompareProjectJudgmentsUrlState = (
  search: Record<string, unknown>,
): CompareProjectJudgmentsUrlState => {
  const defaultState = getDefaultCompareProjectJudgmentsUrlState()
  const parsedPageLimit = getPositiveIntegerSearchParamValue(search.limit, defaultState.pageLimit)

  return {
    currentPage: getPositiveIntegerSearchParamValue(search.page, defaultState.currentPage),
    pageLimit: pageLimitOptions.includes(parsedPageLimit) ? parsedPageLimit : defaultState.pageLimit,
    rowFilter: getNormalizedComparisonProjectRowFilter(search.rowFilter),
    differenceFilter: getDifferenceFilterSearchParamValue(search.differenceFilter),
  }
}

const getCompareProjectJudgmentsSearchParams = (state: CompareProjectJudgmentsUrlState): Record<string, string> => {
  const defaultState = getDefaultCompareProjectJudgmentsUrlState()
  const searchParams: Record<string, string> = {}

  if (state.currentPage !== defaultState.currentPage) {
    searchParams.page = String(state.currentPage)
  }

  if (state.pageLimit !== defaultState.pageLimit) {
    searchParams.limit = String(state.pageLimit)
  }

  if (state.rowFilter !== defaultState.rowFilter) {
    searchParams.rowFilter = state.rowFilter
  }

  if (state.differenceFilter !== defaultState.differenceFilter) {
    searchParams.differenceFilter = state.differenceFilter
  }

  return searchParams
}

const getContentSettingsLabel = (contentVariants: Array<{label: string}>) => {
  return contentVariants.length > 0
    ? contentVariants
        .map((contentVariant) => {
          return contentVariant.label
        })
        .join(' · ')
    : 'none'
}

const getRangeLabel = (page: number, limit: number, totalCount: number) => {
  if (totalCount === 0) {
    return 'Showing 0 results'
  }

  const start = (page - 1) * limit + 1
  const end = Math.min(page * limit, totalCount)

  return `Showing ${start}-${end} of ${totalCount}`
}

const getAnsweredPromptCount = (
  cells: Record<string, string | null>,
  columns: Array<{id: string; promptId: string}>,
) => {
  return new Set(
    columns
      .filter((column) => {
        return (cells[column.id]?.trim() ?? '') !== ''
      })
      .map((column) => {
        return column.promptId
      }),
  ).size
}

const getAnsweredColumnCount = (cells: Record<string, string | null>, columns: Array<{id: string}>) => {
  return columns.filter((column) => {
    return (cells[column.id]?.trim() ?? '') !== ''
  }).length
}

const getConfiguredPromptCount = (columns: Array<{promptId: string}>) => {
  return new Set(
    columns.map((column) => {
      return column.promptId
    }),
  ).size
}

const getConfiguredColumnCount = (columns: Array<{id: string}>) => {
  return columns.length
}

const getHumanJudgmentModeLabel = (humanJudgmentMode: 'prompt' | 'summary') => {
  return humanJudgmentMode === 'summary' ? 'Summary overall decisions' : 'Prompt-by-prompt decisions'
}

const getHasAllShownColumnsAnswered = (cells: Record<string, string | null>, columns: Array<{id: string}>) => {
  return columns.every((column) => {
    return (cells[column.id]?.trim() ?? '') !== ''
  })
}

const getOrderedJudgmentColumns = (
  columns: ComparisonProjectJudgmentsColumn[],
  prompts: Array<{id: string; order: number}>,
) => {
  const promptOrderMap = prompts.reduce<Record<string, number>>((orderMap, prompt) => {
    return {...orderMap, [prompt.id]: prompt.order}
  }, {})

  return columns
    .map((column, index) => {
      return {column, index}
    })
    .sort((left, right) => {
      const promptDiff =
        (promptOrderMap[left.column.promptId] ?? Number.MAX_SAFE_INTEGER)
        - (promptOrderMap[right.column.promptId] ?? Number.MAX_SAFE_INTEGER)

      if (promptDiff !== 0) {
        return promptDiff
      }

      if (left.column.kind !== right.column.kind) {
        return left.column.kind === 'llm' ? -1 : 1
      }

      return left.index - right.index
    })
    .map(({column}) => {
      return column
    })
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

const CompareProjectJudgmentsPage = () => {
  const params = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
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
  const judgmentsPageQuery = useQuery(() => {
    return {
      queryKey: [
        'comparison-project-judgments-page',
        comparisonProjectId(),
        currentPage(),
        pageLimit(),
        rowFilter(),
        differenceFilter(),
      ],
      queryFn: () => {
        return fetchComparisonProjectJudgmentsPage(
          comparisonProjectId(),
          currentPage(),
          pageLimit(),
          rowFilter(),
          differenceFilter(),
        )
      },
      enabled: searchInitialized(),
      refetchOnWindowFocus: false,
    }
  })

  const canGoToPreviousPage = createMemo(() => {
    return currentPage() > 1
  })
  const canGoToNextPage = createMemo(() => {
    return currentPage() < (judgmentsPageQuery.data?.totalPages ?? 0)
  })
  const orderedColumns = createMemo<ComparisonProjectJudgmentsTableColumn[]>(() => {
    const comparisonProject = comparisonProjectQuery.data

    return getOrderedJudgmentColumns(comparisonProject?.columns ?? [], comparisonProject?.prompts ?? []).map(
      (column) => {
        return {...column, sourceProjectId: getColumnSourceProjectId(column, comparisonProject)}
      },
    )
  })
  const isSummaryMode = createMemo(() => {
    const comparisonProject = comparisonProjectQuery.data

    return Boolean(comparisonProject?.compareWithHumans && comparisonProject.humanJudgmentMode === 'summary')
  })
  const differenceFilterOptions = createMemo(() => {
    return getAvailableComparisonProjectDifferenceFilters(orderedColumns()).map((value) => {
      return {label: getComparisonProjectDifferenceFilterLabel(value), value}
    })
  })

  createEffect(() => {
    const availableFilters = differenceFilterOptions().map((option) => {
      return option.value
    })

    if (!availableFilters.includes(differenceFilter())) {
      setDifferenceFilter('all')
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
        search: getCompareProjectJudgmentsSearchParams({
          currentPage: currentPage(),
          pageLimit: pageLimit(),
          rowFilter: rowFilter(),
          differenceFilter: differenceFilter(),
        }) as never,
        replace: true,
      })
    }),
  )

  const filteredRows = createMemo(() => {
    const rows = judgmentsPageQuery.data?.data ?? []
    const columns = orderedColumns()
    return rows.filter((row) => {
      const answeredComparableCount = isSummaryMode()
        ? getAnsweredColumnCount(row.cells, columns)
        : getAnsweredPromptCount(row.cells, columns)
      const configuredComparableCount = isSummaryMode()
        ? getConfiguredColumnCount(columns)
        : getConfiguredPromptCount(columns)
      const passesRowFilter =
        rowFilter() === 'all'
        || (rowFilter() === 'fully-answered'
          ? getHasAllShownColumnsAnswered(row.cells, columns)
          : answeredComparableCount >= 2)
      const passesDifferenceFilter = getComparisonProjectHasDifferenceFilterMatch(
        row.cells,
        columns,
        differenceFilter(),
      )

      return configuredComparableCount === 0 ? false : passesRowFilter && passesDifferenceFilter
    })
  })
  const hasRowFilters = createMemo(() => {
    return rowFilter() !== 'all' || differenceFilter() !== 'all'
  })

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
        <Show when={comparisonProjectQuery.data?.archived}>
          <span class="inline-flex items-center rounded-full bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700">
            Archived
          </span>
        </Show>
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
                  </div>
                </div>
              </div>

              <div class="space-y-4">
                <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-4 shadow">
                  <div>
                    <h2 class="text-lg font-semibold">Article Judgments</h2>
                    <p class="text-sm text-gray-600">
                      {judgmentsPageQuery.data
                        ? hasRowFilters()
                          ? `${filteredRows().length} visible on this page · ${getRangeLabel(
                              judgmentsPageQuery.data.page,
                              judgmentsPageQuery.data.limit,
                              judgmentsPageQuery.data.totalCount,
                            )}`
                          : getRangeLabel(
                              judgmentsPageQuery.data.page,
                              judgmentsPageQuery.data.limit,
                              judgmentsPageQuery.data.totalCount,
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
                        <For each={pageLimitOptions}>
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
                        Page {judgmentsPageQuery.data?.page ?? currentPage()} of{' '}
                        {judgmentsPageQuery.data?.totalPages ?? 0}
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
                    && filteredRows().length > 0
                  }
                >
                  <ComparisonProjectJudgmentsTable columns={orderedColumns()} rows={filteredRows()} />
                </Show>

                <Show
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && orderedColumns().length > 0
                    && filteredRows().length === 0
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

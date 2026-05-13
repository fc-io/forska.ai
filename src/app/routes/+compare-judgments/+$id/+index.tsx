import {type InfiniteData, useInfiniteQuery, useQuery, useQueryClient} from '@tanstack/solid-query'
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
  fetchComparisonProjectStats,
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
import {ComparisonProjectServingProgress} from './+index/comparisonProjectServingProgress.tsx'
import {ComparisonProjectStatsCard} from './+index/comparisonProjectStatsCard.tsx'

const getContentSettingsLabel = (contentVariants: Array<{label: string}>) => {
  return contentVariants.length > 0
    ? contentVariants
        .map((contentVariant) => {
          return contentVariant.label
        })
        .join(' · ')
    : 'none'
}

const getLoadedRangeLabel = (rowCount: number, totalCount: number) => {
  if (totalCount === 0) {
    return 'Showing 0 results'
  }

  const end = Math.min(rowCount, totalCount)

  return rowCount === 0 ? 'Showing 0 results' : `Showing 1-${end} of ${totalCount.toLocaleString()}`
}

const getPendingCountRangeLabel = (rowCount: number) => {
  return rowCount === 0 ? 'Counting results' : `Showing 1-${rowCount.toLocaleString()} of`
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

const comparisonProjectServingStatusBanners: Partial<
  Record<ComparisonProjectJudgmentsPage['servingStatus'], {body: string; className: string; title: string}>
> = {
  failed: {
    body: 'Rows may be stale or incomplete until the serving rebuild succeeds.',
    className: 'border-red-200 bg-red-50 text-red-800',
    title: 'Comparison serving failed',
  },
  missing: {
    body: 'Rows will appear after comparison serving data has been materialized.',
    className: 'border-blue-200 bg-blue-50 text-blue-800',
    title: 'Comparison data is materializing',
  },
  refreshing: {
    body: 'Rows remain readable while the comparison serving data is materializing.',
    className: 'border-blue-200 bg-blue-50 text-blue-800',
    title: 'Comparison data is materializing',
  },
  stale: {
    body: 'Rows may not include the latest project or judgment changes yet.',
    className: 'border-amber-200 bg-amber-50 text-amber-800',
    title: 'Comparison data is stale',
  },
}

const getComparisonProjectServingStatusBanner = (status: ComparisonProjectJudgmentsPage['servingStatus']) => {
  return comparisonProjectServingStatusBanners[status] ?? null
}

const comparisonProjectServingUnavailableStates: Partial<
  Record<ComparisonProjectJudgmentsPage['servingStatus'], {body: string; title: string}>
> = {
  failed: {
    body: 'The serving rebuild failed before a readable generation was promoted. Rows will appear after the rebuild succeeds.',
    title: 'Comparison serving is not available',
  },
  missing: {
    body: 'The comparison serving rows are being materialized. This page will show rows after the first generation is ready.',
    title: 'Comparison data is materializing',
  },
  refreshing: {
    body: 'The comparison serving rows are being materialized. This page will show rows after the first generation is ready.',
    title: 'Comparison data is materializing',
  },
  stale: {
    body: 'The current comparison configuration has no promoted serving generation. Rows will appear after serving data is rebuilt.',
    title: 'Comparison data is stale',
  },
}

const getComparisonProjectServingUnavailableState = (params: {
  activeGeneration: number | null
  isServingReady: boolean
  status: ComparisonProjectJudgmentsPage['servingStatus']
}) => {
  return !params.isServingReady && params.activeGeneration === null
    ? (comparisonProjectServingUnavailableStates[params.status] ?? comparisonProjectServingUnavailableStates.refreshing)
    : null
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
      refetchInterval: 5000,
      staleTime: 5000,
    }
  })
  const comparisonProjectStatsQuery = useQuery(() => {
    return {
      queryKey: [
        'comparison-project-stats',
        comparisonProjectId(),
        comparisonProjectQuery.data?.activeGeneration ?? null,
      ],
      queryFn: () => {
        return fetchComparisonProjectStats(comparisonProjectId())
      },
      enabled: comparisonProjectId().length > 0,
      refetchInterval: comparisonProjectQuery.data?.servingStatus === 'refreshing' ? 5000 : false,
      refetchOnWindowFocus: false,
      staleTime: 5000,
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
  const judgmentsPageQuery = useInfiniteQuery(() => {
    return {
      queryKey: getCurrentJudgmentsPageQueryKey(),
      queryFn: ({pageParam}) => {
        return fetchComparisonProjectJudgmentsPage(
          comparisonProjectId(),
          pageLimit(),
          rowFilter(),
          differenceFilter(),
          typeof pageParam === 'string' ? pageParam : null,
        )
      },
      enabled: canFetchJudgmentsPage(),
      getNextPageParam: (lastPage) => {
        return lastPage.nextCursor
      },
      initialPageParam: null as string | null,
      refetchInterval: comparisonProjectQuery.data?.servingStatus === 'refreshing' ? 5000 : false,
      refetchOnWindowFocus: false,
    }
  })
  const judgmentsCountQuery = useQuery(() => {
    return {
      queryKey: getCurrentJudgmentsCountQueryKey(),
      queryFn: () => {
        return fetchComparisonProjectJudgmentsCount(comparisonProjectId(), pageLimit(), rowFilter(), differenceFilter())
      },
      enabled: canFetchJudgmentsPage() && judgmentsPageQuery.isSuccess,
      refetchInterval: comparisonProjectQuery.data?.servingStatus === 'refreshing' ? 5000 : false,
      refetchOnWindowFocus: false,
    }
  })
  const exactTotalCount = createMemo(() => {
    return judgmentsCountQuery.isSuccess ? (judgmentsCountQuery.data?.totalCount ?? 0) : null
  })
  const servingUnavailableState = createMemo(() => {
    const comparisonProject = comparisonProjectQuery.data

    return comparisonProject
      ? getComparisonProjectServingUnavailableState({
          activeGeneration: comparisonProject.activeGeneration,
          isServingReady: comparisonProject.isServingReady,
          status: comparisonProject.servingStatus,
        })
      : null
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
    on([pageLimit, rowFilter, differenceFilter, searchInitialized], () => {
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
    return (
      judgmentsPageQuery.data?.pages.flatMap((page) => {
        return page.data
      }) ?? []
    )
  })
  const hasRowFilters = createMemo(() => {
    return rowFilter() !== 'all' || differenceFilter() !== 'all'
  })
  const updateCurrentJudgmentsPageConflictResolution = (
    articleId: string,
    conflictResolution: {articleId: string; label: string; value: string} | null,
  ) => {
    queryClient.setQueryData<InfiniteData<ComparisonProjectJudgmentsPage, string | null>>(
      getCurrentJudgmentsPageQueryKey(),
      (currentPageData) => {
        return currentPageData
          ? {
              ...currentPageData,
              pages: currentPageData.pages.map((page) => {
                return {
                  ...page,
                  data: page.data.map((row) => {
                    return row.id === articleId ? {...row, conflictResolution} : row
                  }),
                }
              }),
            }
          : currentPageData
      },
    )
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

              <ComparisonProjectStatsCard
                error={comparisonProjectStatsQuery.error}
                isError={comparisonProjectStatsQuery.isError}
                isLoading={comparisonProjectStatsQuery.isPending}
                stats={comparisonProjectStatsQuery.data}
              />

              <Show when={getComparisonProjectServingStatusBanner(comparisonProject().servingStatus)}>
                {(statusBanner) => {
                  return (
                    <div class={`rounded-lg border p-4 ${statusBanner().className}`}>
                      <p class="font-medium">{statusBanner().title}</p>
                      <p class="mt-1 text-sm opacity-90">{statusBanner().body}</p>
                      <ComparisonProjectServingProgress
                        progress={comparisonProject().servingProgress}
                        showWaiting={comparisonProject().servingStatus === 'refreshing'}
                      />
                    </div>
                  )
                }}
              </Show>

              <div class="space-y-4">
                <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-4 shadow">
                  <div>
                    <h2 class="text-lg font-semibold">Article Judgments</h2>
                    <p class="text-sm text-gray-600">
                      <Show
                        when={servingUnavailableState()}
                        fallback={
                          <Show when={judgmentsPageQuery.data} fallback="Loading results...">
                            <Show
                              when={exactTotalCount() !== null}
                              fallback={
                                <span class="inline-flex items-center gap-2">
                                  <span>{getPendingCountRangeLabel(serverFilteredRows().length)}</span>
                                  <span class="h-4 w-16 animate-pulse rounded bg-gray-200" />
                                </span>
                              }
                            >
                              {getLoadedRangeLabel(serverFilteredRows().length, exactTotalCount() ?? 0)}
                            </Show>
                          </Show>
                        }
                      >
                        {(state) => {
                          return state().title
                        }}
                      </Show>
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
                        }}
                      >
                        <For each={compareProjectJudgmentsPageLimitOptions}>
                          {(option) => {
                            return <option value={option}>{option}</option>
                          }}
                        </For>
                      </select>
                    </label>
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
                    && serverFilteredRows().length === 0
                    && servingUnavailableState()
                  }
                >
                  {(state) => {
                    return (
                      <div class="rounded-lg border border-blue-200 bg-blue-50 p-8 text-center text-blue-800 shadow">
                        <p class="font-medium">{state().title}</p>
                        <p class="mt-2 text-sm">{state().body}</p>
                      </div>
                    )
                  }}
                </Show>

                <Show
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && orderedColumns().length > 0
                    && serverFilteredRows().length > 0
                  }
                >
                  <>
                    <ComparisonProjectJudgmentsTable
                      columns={orderedColumns()}
                      conflictResolutionEnabled={comparisonProject().allowConflictResolution}
                      conflictResolutionPendingArticleId={conflictResolutionPendingArticleId()}
                      conflictResolutionOptions={conflictResolutionOptions()}
                      onConflictResolutionReset={handleConflictResolutionReset}
                      onConflictResolutionSelect={handleConflictResolutionSelect}
                      rows={serverFilteredRows()}
                    />
                    <div class="flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!judgmentsPageQuery.hasNextPage || judgmentsPageQuery.isFetchingNextPage}
                        onClick={() => {
                          void judgmentsPageQuery.fetchNextPage()
                        }}
                      >
                        <Show
                          when={judgmentsPageQuery.isFetchingNextPage}
                          fallback={
                            <Show when={judgmentsPageQuery.hasNextPage} fallback="All rows loaded">
                              Load more
                            </Show>
                          }
                        >
                          Loading...
                        </Show>
                      </Button>
                    </div>
                  </>
                </Show>

                <Show
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && orderedColumns().length > 0
                    && serverFilteredRows().length === 0
                    && !servingUnavailableState()
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

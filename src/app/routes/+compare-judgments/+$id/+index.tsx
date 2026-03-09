import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {ComparisonProjectJudgmentsTable} from '../../../../components/main/comparisonProjectJudgmentsTable/comparisonProjectJudgmentsTable.tsx'
import {Button} from '../../../../components/ui/button'
import {
  fetchComparisonProjectJudgmentsMetadata,
  fetchComparisonProjectJudgmentsPage,
} from '../../../../services/comparisonProjectsService'

const pageLimitOptions = [25, 50, 100]

const getContentSettingsLabel = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  const fulltextLabel = settings.useFulltextNoImages ? 'fulltext (no images)' : settings.useFulltext ? 'fulltext' : null
  const parts = [settings.useTitle ? 'title' : null, settings.useAbstract ? 'abstract' : null, fulltextLabel].filter(
    Boolean,
  )

  return parts.length > 0 ? parts.join(', ') : 'none'
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

const getConfiguredPromptCount = (columns: Array<{promptId: string}>) => {
  return new Set(
    columns.map((column) => {
      return column.promptId
    }),
  ).size
}

const getHasAllShownColumnsAnswered = (cells: Record<string, string | null>, columns: Array<{id: string}>) => {
  return columns.every((column) => {
    return (cells[column.id]?.trim() ?? '') !== ''
  })
}

const normalizeAnswerValue = (value: string | null) => {
  return value?.trim().toLowerCase() ?? ''
}

const getHasModelDifferences = (
  cells: Record<string, string | null>,
  columns: Array<{id: string; kind: 'llm' | 'human'; promptId: string}>,
) => {
  const llmAnswersByPrompt = columns.reduce<Record<string, string[]>>((answerMap, column) => {
    if (column.kind !== 'llm') {
      return answerMap
    }

    const normalizedAnswer = normalizeAnswerValue(cells[column.id] ?? null)

    if (!normalizedAnswer) {
      return answerMap
    }

    return {...answerMap, [column.promptId]: [...(answerMap[column.promptId] ?? []), normalizedAnswer]}
  }, {})

  return Object.values(llmAnswersByPrompt).some((answers) => {
    return new Set(answers).size > 1
  })
}

const CompareProjectJudgmentsPage = () => {
  const params = Route.useParams()
  const comparisonProjectId = () => {
    const routeParams = params()

    return 'id' in routeParams ? routeParams.id : ''
  }
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(50)
  const [hideSparseRows, setHideSparseRows] = createSignal(false)
  const [showOnlyFullyAnsweredPrompts, setShowOnlyFullyAnsweredPrompts] = createSignal(false)
  const [showOnlyModelDifferences, setShowOnlyModelDifferences] = createSignal(false)

  const comparisonProjectQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-judgments-metadata', comparisonProjectId()],
      queryFn: () => {
        return fetchComparisonProjectJudgmentsMetadata(comparisonProjectId())
      },
      refetchOnWindowFocus: true,
    }
  })
  const judgmentsPageQuery = useQuery(() => {
    return {
      queryKey: [
        'comparison-project-judgments-page',
        comparisonProjectId(),
        currentPage(),
        pageLimit(),
        hideSparseRows(),
        showOnlyFullyAnsweredPrompts(),
        showOnlyModelDifferences(),
      ],
      queryFn: () => {
        return fetchComparisonProjectJudgmentsPage(
          comparisonProjectId(),
          currentPage(),
          pageLimit(),
          hideSparseRows(),
          showOnlyFullyAnsweredPrompts(),
          showOnlyModelDifferences(),
        )
      },
      refetchOnWindowFocus: false,
    }
  })

  const canGoToPreviousPage = createMemo(() => {
    return currentPage() > 1
  })
  const canGoToNextPage = createMemo(() => {
    return currentPage() < (judgmentsPageQuery.data?.totalPages ?? 0)
  })
  const filteredRows = createMemo(() => {
    const rows = judgmentsPageQuery.data?.data ?? []
    const columns = comparisonProjectQuery.data?.columns ?? []
    return rows.filter((row) => {
      const answeredPromptCount = getAnsweredPromptCount(row.cells, columns)
      const configuredPromptCount = getConfiguredPromptCount(columns)
      const passesSparseRowsFilter = !hideSparseRows() || answeredPromptCount >= 2
      const passesFullyAnsweredFilter =
        !showOnlyFullyAnsweredPrompts() || getHasAllShownColumnsAnswered(row.cells, columns)
      const passesModelDifferenceFilter = !showOnlyModelDifferences() || getHasModelDifferences(row.cells, columns)

      return configuredPromptCount === 0
        ? false
        : passesSparseRowsFilter && passesFullyAnsweredFilter && passesModelDifferenceFilter
    })
  })
  const hasRowFilters = createMemo(() => {
    return hideSparseRows() || showOnlyFullyAnsweredPrompts() || showOnlyModelDifferences()
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
                    <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Content</p>
                    <p class="mt-2 text-sm text-gray-700">{getContentSettingsLabel(comparisonProject())}</p>
                  </div>
                  <div>
                    <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Prompts and Models</p>
                    <p class="mt-2 text-sm text-gray-700">
                      {comparisonProject().prompts.length} prompts · {comparisonProject().models.length} models
                    </p>
                  </div>
                  <div>
                    <p class="text-xs font-medium uppercase tracking-wide text-gray-500">Human Columns</p>
                    <p class="mt-2 text-sm text-gray-700">
                      {comparisonProject().compareWithHumans ? 'Shown on the right' : 'Not included'}
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
                      <input
                        type="checkbox"
                        checked={hideSparseRows()}
                        onChange={(event) => {
                          setHideSparseRows(event.currentTarget.checked)
                          setCurrentPage(1)
                        }}
                      />
                      <span>Hide rows with under 2 answered prompts</span>
                    </label>
                    <label class="flex items-center gap-2 text-sm text-gray-600">
                      <input
                        type="checkbox"
                        checked={showOnlyFullyAnsweredPrompts()}
                        onChange={(event) => {
                          setShowOnlyFullyAnsweredPrompts(event.currentTarget.checked)
                          setCurrentPage(1)
                        }}
                      />
                      <span>Show only rows where all prompts are answered</span>
                    </label>
                    <label class="flex items-center gap-2 text-sm text-gray-600">
                      <input
                        type="checkbox"
                        checked={showOnlyModelDifferences()}
                        onChange={(event) => {
                          setShowOnlyModelDifferences(event.currentTarget.checked)
                          setCurrentPage(1)
                        }}
                      />
                      <span>Show only rows with model differences</span>
                    </label>
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
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && comparisonProject().columns.length === 0
                  }
                >
                  <div class="rounded-lg bg-white p-8 text-center text-gray-500 shadow">
                    No comparison columns are available yet for this comparison project.
                  </div>
                </Show>

                <Show
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && comparisonProject().columns.length > 0
                    && filteredRows().length > 0
                  }
                >
                  <ComparisonProjectJudgmentsTable columns={comparisonProject().columns} rows={filteredRows()} />
                </Show>

                <Show
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && comparisonProject().columns.length > 0
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

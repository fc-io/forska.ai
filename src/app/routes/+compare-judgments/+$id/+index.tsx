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

const CompareProjectJudgmentsPage = () => {
  const params = Route.useParams()
  const comparisonProjectId = () => {
    return params().id
  }
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageLimit, setPageLimit] = createSignal(50)

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
      queryKey: ['comparison-project-judgments-page', comparisonProjectId(), currentPage(), pageLimit()],
      queryFn: () => {
        return fetchComparisonProjectJudgmentsPage(comparisonProjectId(), currentPage(), pageLimit())
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
                        ? getRangeLabel(
                            judgmentsPageQuery.data.page,
                            judgmentsPageQuery.data.limit,
                            judgmentsPageQuery.data.totalCount,
                          )
                        : 'Loading results...'}
                    </p>
                  </div>
                  <div class="flex items-center gap-3">
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
                    && (judgmentsPageQuery.data?.data.length ?? 0) > 0
                  }
                >
                  <ComparisonProjectJudgmentsTable
                    columns={comparisonProject().columns}
                    rows={judgmentsPageQuery.data?.data ?? []}
                  />
                </Show>

                <Show
                  when={
                    !judgmentsPageQuery.isPending
                    && !judgmentsPageQuery.isError
                    && comparisonProject().columns.length > 0
                    && (judgmentsPageQuery.data?.data.length ?? 0) === 0
                  }
                >
                  <div class="rounded-lg bg-white p-8 text-center text-gray-500 shadow">
                    No matching article judgments found.
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

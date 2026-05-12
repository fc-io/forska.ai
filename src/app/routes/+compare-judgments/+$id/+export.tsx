import {useMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, on, onMount, Show} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {
  type ComparisonProjectJudgmentsColumn,
  fetchComparisonProjectJudgmentsMetadata,
} from '../../../../services/comparisonProjectsService'
import {getOrderedComparisonProjectColumns} from '../../../../utils/comparisonProjectColumnOrder.ts'
import {
  type ComparisonProjectDifferenceFilter,
  getAvailableComparisonProjectDifferenceFilters,
  getComparisonProjectDifferenceFilterLabel,
  getNormalizedComparisonProjectDifferenceFilter,
} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectRowFilter} from '../../../../utils/comparisonProjectRowFilter.ts'
import {downloadCsvFromPost} from '../../../utils/downloadCsv.ts'
import {CompareProjectExportFilters} from './+export/compareProjectExportFilters.tsx'
import {CompareProjectExportMetadata} from './+export/compareProjectExportMetadata.tsx'
import {
  getCompareProjectExportRequestBody,
  getCompareProjectExportSearchParams,
  getInitialCompareProjectExportUrlState,
} from './+export/compareProjectExportUrlState.ts'

const getComparisonProjectId = (params: Record<string, string>) => {
  return 'id' in params ? params.id : ''
}

const getExportFallbackFilename = (comparisonProjectId: string) => {
  return `comparison-export-${comparisonProjectId}.csv`
}

const getExportPath = (comparisonProjectId: string) => {
  return `/api/comparison-projects/${encodeURIComponent(comparisonProjectId)}/export`
}

const CompareProjectExportPage = () => {
  const params = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const initialUrlState = getInitialCompareProjectExportUrlState(search() as Record<string, unknown>)
  const comparisonProjectId = () => {
    return getComparisonProjectId(params() as Record<string, string>)
  }
  const [pageLimit] = createSignal(initialUrlState.pageLimit)
  const [rowFilter, setRowFilter] = createSignal<ComparisonProjectRowFilter>(initialUrlState.rowFilter)
  const [differenceFilter, setDifferenceFilter] = createSignal<ComparisonProjectDifferenceFilter>(
    initialUrlState.differenceFilter,
  )
  const [searchInitialized, setSearchInitialized] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => {
    setSearchInitialized(true)
  })

  const comparisonProjectQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-export-metadata', comparisonProjectId()],
      queryFn: () => {
        return fetchComparisonProjectJudgmentsMetadata(comparisonProjectId())
      },
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    }
  })
  const orderedColumns = createMemo<ComparisonProjectJudgmentsColumn[]>(() => {
    const comparisonProject = comparisonProjectQuery.data

    return getOrderedComparisonProjectColumns(comparisonProject?.columns ?? [], comparisonProject?.prompts ?? [])
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
  const urlState = createMemo(() => {
    return {differenceFilter: differenceFilter(), pageLimit: pageLimit(), rowFilter: rowFilter()}
  })

  createEffect(() => {
    const normalizedDifferenceFilter = getNormalizedComparisonProjectDifferenceFilter(
      differenceFilter(),
      orderedColumns(),
    )

    if (normalizedDifferenceFilter !== differenceFilter()) {
      setDifferenceFilter(normalizedDifferenceFilter)
    }
  })

  createEffect(
    on([pageLimit, rowFilter, differenceFilter, searchInitialized], () => {
      if (!searchInitialized()) {
        return
      }

      void navigate({
        to: '/compare-judgments/$id/export',
        params: {id: comparisonProjectId()} as never,
        search: getCompareProjectExportSearchParams(urlState()) as never,
        replace: true,
      })
    }),
  )

  const exportMutation = useMutation(() => {
    return {
      mutationFn: async () => {
        await downloadCsvFromPost({
          body: getCompareProjectExportRequestBody(urlState()),
          errorMessage: 'Comparison export failed',
          fallbackFilename: getExportFallbackFilename(comparisonProjectId()),
          path: getExportPath(comparisonProjectId()),
        })

        return {success: true}
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred'
        setError(message)
      },
    }
  })
  const updateRowFilter = (value: ComparisonProjectRowFilter) => {
    setRowFilter(value)
  }
  const updateDifferenceFilter = (value: ComparisonProjectDifferenceFilter) => {
    setDifferenceFilter(value)
  }
  const handleExport = () => {
    setError(null)
    exportMutation.mutate()
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <Button
            as={Link}
            to="/compare-judgments/$id"
            params={{id: comparisonProjectId()} as never}
            search={getCompareProjectExportSearchParams(urlState()) as never}
            variant="outline"
            size="sm"
          >
            ← Back to Comparison
          </Button>
          <div>
            <h1 class="text-2xl font-bold">Export comparison data</h1>
            <p class="text-sm text-gray-500">{comparisonProjectQuery.data?.name ?? 'Loading comparison project...'}</p>
          </div>
        </div>
      </div>

      <Show when={comparisonProjectQuery.isError}>
        <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {comparisonProjectQuery.error instanceof Error
            ? comparisonProjectQuery.error.message
            : 'Failed to load comparison project'}
        </div>
      </Show>

      <Show when={comparisonProjectQuery.isPending}>
        <div class="rounded-lg bg-white p-8 text-center text-gray-500 shadow">Loading comparison project...</div>
      </Show>

      <Show when={!comparisonProjectQuery.isPending && !comparisonProjectQuery.isError && comparisonProjectQuery.data}>
        {(comparisonProject) => {
          return (
            <div class="space-y-6">
              <Show when={error()}>
                <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{error()}</div>
              </Show>
              <CompareProjectExportMetadata comparisonProject={comparisonProject()} />
              <CompareProjectExportFilters
                differenceFilter={differenceFilter()}
                differenceFilterOptions={differenceFilterOptions()}
                isExporting={exportMutation.isPending}
                isSummaryMode={isSummaryMode()}
                onDifferenceFilterChange={updateDifferenceFilter}
                onExport={handleExport}
                onRowFilterChange={updateRowFilter}
                rowFilter={rowFilter()}
              />
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/compare-judgments/$id/export')({component: CompareProjectExportPage})

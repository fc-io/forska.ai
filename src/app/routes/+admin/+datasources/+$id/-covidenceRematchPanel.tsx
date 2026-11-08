import {createMutation, useQuery} from '@tanstack/solid-query'
import {createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../../../services/apiClient.ts'

type CovidenceRematchRequest = {baseImportRoute: string; dataSourceId: string; dryRun: boolean}
type CovidenceBaseRouteOption = {importRoute: string; title: string}

const covidenceMatchTierLabels = {
  covidence_id: 'Covidence #',
  reference_id: 'Ref',
  strong_identifier: 'DOI/PMID',
  title_year_first_author: 'Title, year and first author',
} as const

const getCovidenceRematchErrorMessage = (error: {value?: unknown} | null) => {
  return typeof error?.value === 'string' && error.value.trim() !== '' ? error.value : 'Covidence rematch failed'
}

const runCovidenceRematchRequest = async (request: CovidenceRematchRequest) => {
  const response = await apiClient.api
    .datasources({id: request.dataSourceId})
    ['covidence-rematch'].post({baseImportRoute: request.baseImportRoute, dryRun: request.dryRun})

  if (response.error || !response.data) {
    throw new Error(getCovidenceRematchErrorMessage(response.error))
  }

  return response.data.data
}

type CovidenceRematchSummary = Awaited<ReturnType<typeof runCovidenceRematchRequest>>

const fetchCovidenceBaseRouteOptions = async (dataSourceId: string): Promise<CovidenceBaseRouteOption[]> => {
  const response = await apiClient.api.datasources.get()

  if (response.error) {
    throw new Error('Failed to load Covidence data sources')
  }

  return (response.data?.data ?? []).flatMap((entry) => {
    return entry.id !== dataSourceId && entry.covidencePackageConfig && entry.importRoute?.startsWith('covidence:')
      ? [{importRoute: entry.importRoute, title: entry.title}]
      : []
  })
}

export const CovidenceRematchPanel = (props: {
  dataSourceId: string
  initialBaseImportRoute: string | null
  onApplied: () => void
}) => {
  const [baseImportRoute, setBaseImportRoute] = createSignal(props.initialBaseImportRoute ?? '')
  const [summary, setSummary] = createSignal<CovidenceRematchSummary | null>(null)
  const baseRouteOptionsQuery = useQuery(() => {
    return {
      queryKey: ['datasource', props.dataSourceId, 'covidence-base-routes'],
      queryFn: () => {
        return fetchCovidenceBaseRouteOptions(props.dataSourceId)
      },
      staleTime: 60_000,
    }
  })
  const rematchMutation = createMutation(() => {
    return {
      mutationFn: runCovidenceRematchRequest,
      onSuccess: (nextSummary: CovidenceRematchSummary) => {
        setSummary(nextSummary)

        if (!nextSummary.dryRun) {
          props.onApplied()
        }
      },
    }
  })
  const canApply = () => {
    const currentSummary = summary()

    return Boolean(
      currentSummary
      && currentSummary.dryRun
      && currentSummary.baseImportRoute === baseImportRoute()
      && currentSummary.blockers.length === 0
      && (currentSummary.remappedArticleCount > 0 || currentSummary.pendingMergeCount > 0),
    )
  }
  const handlePreview = () => {
    rematchMutation.mutate({baseImportRoute: baseImportRoute(), dataSourceId: props.dataSourceId, dryRun: true})
  }
  const handleApply = () => {
    const currentSummary = summary()

    if (
      currentSummary
      && globalThis.confirm(
        `Merge ${currentSummary.remappedArticleCount.toLocaleString()} duplicate articles into the base import's articles? Human decisions move with them.`,
      )
    ) {
      rematchMutation.mutate({baseImportRoute: baseImportRoute(), dataSourceId: props.dataSourceId, dryRun: false})
    }
  }

  return (
    <div class="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4">
      <div>
        <h3 class="text-sm font-semibold text-gray-900">Same-review rematch</h3>
        <p class="text-xs text-gray-600">
          Re-match this package against an earlier export of the same Covidence review (DOI/PMID, Covidence #, Ref, then
          title + year + first author) and merge duplicate articles into the existing ones, keeping this import's human
          decisions.
        </p>
      </div>
      <select
        class="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
        value={baseImportRoute()}
        onChange={(event) => {
          setBaseImportRoute(event.currentTarget.value)
          setSummary(null)
        }}
      >
        <option value="">Choose the earlier import</option>
        <For each={baseRouteOptionsQuery.data ?? []}>
          {(option) => {
            return <option value={option.importRoute}>{option.title}</option>
          }}
        </For>
      </select>
      <div class="flex flex-wrap gap-3">
        <button
          type="button"
          class="rounded-md border border-amber-600 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
          disabled={!baseImportRoute() || rematchMutation.isPending}
          onClick={handlePreview}
        >
          {rematchMutation.isPending ? 'Working...' : 'Preview rematch'}
        </button>
        <button
          type="button"
          class="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          disabled={!canApply() || rematchMutation.isPending}
          onClick={handleApply}
        >
          Apply rematch
        </button>
      </div>
      <Show when={rematchMutation.error}>
        <p class="text-sm text-red-600">{rematchMutation.error?.message}</p>
      </Show>
      <Show when={summary()}>
        {(currentSummary) => {
          return (
            <div class="space-y-2 text-sm text-gray-800">
              <p class="font-medium">
                {currentSummary().applyStarted
                  ? `Started merging ${currentSummary().remappedArticleCount.toLocaleString()} duplicate articles in the background. Preview again to follow progress.`
                  : `${currentSummary().remappedArticleCount.toLocaleString()} duplicate articles would merge.`}
              </p>
              <Show when={currentSummary().applyRunning && !currentSummary().applyStarted}>
                <p class="text-xs text-amber-800">A rematch is running for this data source.</p>
              </Show>
              <Show when={currentSummary().pendingMergeCount > 0}>
                <p class="text-xs text-amber-800">
                  {currentSummary().pendingMergeCount.toLocaleString()} merged articles still wait for deletion.
                </p>
              </Show>
              <ul class="grid gap-1 text-xs sm:grid-cols-2">
                <For each={Object.entries(covidenceMatchTierLabels)}>
                  {([tier, label]) => {
                    return (
                      <li>
                        {label}:{' '}
                        {currentSummary().remappedByTier[
                          tier as keyof typeof covidenceMatchTierLabels
                        ].toLocaleString()}
                      </li>
                    )
                  }}
                </For>
                <li>Ambiguous (left alone): {currentSummary().ambiguousCount.toLocaleString()}</li>
                <li>No match (kept as new articles): {currentSummary().unmatchedRecordCount.toLocaleString()}</li>
                <li>Already shared records: {currentSummary().alreadySharedRecordCount.toLocaleString()}</li>
              </ul>
              <For each={currentSummary().projectsTouched}>
                {(project) => {
                  return (
                    <p class="text-xs text-gray-600">
                      Project {project.projectId}: {project.projectArticles.toLocaleString()} articles,{' '}
                      {project.humanSummaryRows.toLocaleString()} summary decisions ({project.humanSummaryConflicts}{' '}
                      both sides), {project.humanPromptRows.toLocaleString()} prompt decisions
                    </p>
                  )
                }}
              </For>
              <Show when={currentSummary().blockers.length > 0}>
                <p class="text-xs text-red-700">
                  Blocked by rows in:{' '}
                  {currentSummary()
                    .blockers.map((blocker) => {
                      return `${blocker.tableName} (${blocker.rowCount})`
                    })
                    .join(', ')}
                </p>
              </Show>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

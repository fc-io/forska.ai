import {keepPreviousData, useMutation, useQuery} from '@tanstack/solid-query'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../../../components/ui/button.tsx'
import {getIsSameMultiSelectOptionList, MultiSelect} from '../../../../../components/ui/multi-select.tsx'
import {
  type ComparisonProjectJudgmentsMetadata,
  fetchComparisonProjectCovidenceExportCount,
  getComparisonProjectCovidenceExportPath,
} from '../../../../../services/comparisonProjectsService.ts'
import {getOrderedComparisonProjectColumns} from '../../../../../utils/comparisonProjectColumnOrder.ts'
import {getComparisonProjectSummaryConflictResolutionOptions} from '../../../../../utils/comparisonProjectConflictResolutionFilter.ts'
import {
  comparisonProjectCovidenceExportAnswerOptions,
  getHasComparisonProjectCovidenceExportSelection,
} from '../../../../../utils/comparisonProjectCovidenceExportSelection.ts'
import {downloadFileFromPost} from '../../../../utils/downloadCsv.ts'
import {
  getCompareProjectCovidenceExportButtonLabel,
  getCompareProjectCovidenceExportColumnLabel,
  getCompareProjectCovidenceExportHint,
} from './compareProjectCovidenceExportLabels.ts'
import {
  type CompareProjectCovidenceExportUrlSelection,
  getCompareProjectCovidenceExportRequestBody,
  getCompareProjectCovidenceExportSelectionWithColumnValues,
  getCompareProjectCovidenceExportSelectionWithConflictResolutionValues,
} from './compareProjectCovidenceExportUrlState.ts'

type CompareProjectCovidenceExportProject = Pick<
  ComparisonProjectJudgmentsMetadata,
  'activeGeneration' | 'allowConflictResolution' | 'columns' | 'compareWithHumans' | 'humanJudgmentMode' | 'prompts'
>

type CompareProjectCovidenceExportSectionProps = {
  comparisonProject: CompareProjectCovidenceExportProject
  comparisonProjectId: string
  onSelectionChange: (selection: CompareProjectCovidenceExportUrlSelection) => void
  selection: CompareProjectCovidenceExportUrlSelection
}

const answerOptions = comparisonProjectCovidenceExportAnswerOptions.map((value) => {
  return {label: value, value}
})

const getIsCovidenceExportAvailable = (comparisonProject: CompareProjectCovidenceExportProject) => {
  return comparisonProject.compareWithHumans && comparisonProject.humanJudgmentMode === 'summary'
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : 'Covidence export failed'
}

const CompareProjectCovidenceExportPanel = (props: CompareProjectCovidenceExportSectionProps) => {
  const [exportError, setExportError] = createSignal<string | null>(null)
  const orderedColumns = createMemo(() => {
    return getOrderedComparisonProjectColumns(props.comparisonProject.columns, props.comparisonProject.prompts)
  })
  const conflictResolutionOptions = createMemo(
    () => {
      return getComparisonProjectSummaryConflictResolutionOptions(props.comparisonProject.prompts)
    },
    undefined,
    {equals: getIsSameMultiSelectOptionList},
  )
  const requestBody = createMemo(() => {
    return getCompareProjectCovidenceExportRequestBody(
      props.selection,
      orderedColumns(),
      props.comparisonProject.allowConflictResolution,
    )
  })
  const hasSelection = () => {
    return getHasComparisonProjectCovidenceExportSelection(requestBody())
  }
  const countQuery = useQuery(() => {
    const body = requestBody()

    return {
      queryKey: [
        'comparison-project-covidence-export-count',
        props.comparisonProjectId,
        props.comparisonProject.activeGeneration,
        body,
      ] as const,
      queryFn: () => {
        return fetchComparisonProjectCovidenceExportCount(props.comparisonProjectId, body)
      },
      enabled: getHasComparisonProjectCovidenceExportSelection(body),
      placeholderData: keepPreviousData,
      refetchOnWindowFocus: false,
    }
  })
  const loadedExportCount = () => {
    return countQuery.isSuccess && !countQuery.isPlaceholderData ? countQuery.data.totalCount : null
  }
  const exportCount = () => {
    return hasSelection() ? loadedExportCount() : 0
  }
  const exportMutation = useMutation(() => {
    return {
      mutationFn: () => {
        return downloadFileFromPost({
          body: requestBody(),
          errorMessage: 'Covidence export failed',
          fallbackFilename: `covidence-export-${props.comparisonProjectId}.ris`,
          path: getComparisonProjectCovidenceExportPath(props.comparisonProjectId),
        })
      },
      onError: (error: unknown) => {
        setExportError(getErrorMessage(error))
      },
    }
  })
  const hint = () => {
    return getCompareProjectCovidenceExportHint(hasSelection(), exportCount())
  }

  return (
    <section class="rounded-lg bg-white p-6 shadow">
      <div class="mb-4 max-w-3xl">
        <h2 class="text-lg font-semibold text-gray-900">Export to Covidence</h2>
        <p class="mt-2 text-sm text-gray-600">
          Downloads a Covidence RIS file (full-text review set) with every article that has a selected answer in at
          least one column, each article once. Import it in Covidence with 'Import into: Full text review'. This export
          ignores the filters above.
        </p>
      </div>
      <div class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <For each={orderedColumns()}>
            {(column) => {
              const label = getCompareProjectCovidenceExportColumnLabel(column)

              return (
                <div class="flex min-w-0 flex-col gap-2">
                  <label class="font-medium text-sm break-words">{label}:</label>
                  <MultiSelect
                    ariaLabel={label}
                    options={answerOptions}
                    placeholder="None"
                    values={props.selection.columnValues[column.id] ?? []}
                    onChange={(values) => {
                      props.onSelectionChange(
                        getCompareProjectCovidenceExportSelectionWithColumnValues(props.selection, column.id, values),
                      )
                    }}
                  />
                </div>
              )
            }}
          </For>
          <Show when={props.comparisonProject.allowConflictResolution}>
            <div class="flex min-w-0 flex-col gap-2">
              <label class="font-medium text-sm break-words">Conflict resolution:</label>
              <MultiSelect
                ariaLabel="Conflict resolution"
                options={conflictResolutionOptions()}
                placeholder="None"
                values={props.selection.conflictResolutionValues}
                onChange={(values) => {
                  props.onSelectionChange(
                    getCompareProjectCovidenceExportSelectionWithConflictResolutionValues(props.selection, values),
                  )
                }}
              />
            </div>
          </Show>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!hasSelection() || exportCount() === 0 || exportMutation.isPending}
            onClick={() => {
              setExportError(null)
              exportMutation.mutate()
            }}
          >
            {getCompareProjectCovidenceExportButtonLabel(exportCount(), exportMutation.isPending)}
          </Button>
          <Show when={hint()}>
            <span class="text-sm text-gray-500">{hint()}</span>
          </Show>
          <Show when={countQuery.isError}>
            <span class="text-sm text-red-700">{getErrorMessage(countQuery.error)}</span>
          </Show>
        </div>
        <Show when={exportError()}>
          <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{exportError()}</div>
        </Show>
      </div>
    </section>
  )
}

export const CompareProjectCovidenceExportSection = (props: CompareProjectCovidenceExportSectionProps) => {
  return (
    <Show when={getIsCovidenceExportAvailable(props.comparisonProject)}>
      <CompareProjectCovidenceExportPanel
        comparisonProject={props.comparisonProject}
        comparisonProjectId={props.comparisonProjectId}
        onSelectionChange={props.onSelectionChange}
        selection={props.selection}
      />
    </Show>
  )
}

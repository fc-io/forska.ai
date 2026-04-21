import {For} from 'solid-js'

import {Button} from '../../../../../components/ui/button'
import type {ComparisonProjectDifferenceFilter} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  comparisonProjectRowFilters,
  getComparisonProjectRowFilterLabel,
  getNormalizedComparisonProjectRowFilter,
} from '../../../../../utils/comparisonProjectRowFilter.ts'

type CompareProjectExportDifferenceFilterOption = {label: string; value: ComparisonProjectDifferenceFilter}

type CompareProjectExportFiltersProps = {
  differenceFilter: ComparisonProjectDifferenceFilter
  differenceFilterOptions: CompareProjectExportDifferenceFilterOption[]
  isExporting: boolean
  isSummaryMode: boolean
  onDifferenceFilterChange: (value: ComparisonProjectDifferenceFilter) => void
  onExport: () => void
  onRowFilterChange: (value: ComparisonProjectRowFilter) => void
  rowFilter: ComparisonProjectRowFilter
}

export const CompareProjectExportFilters = (props: CompareProjectExportFiltersProps) => {
  return (
    <div class="rounded-lg bg-white p-6 shadow">
      <div class="mb-4">
        <h2 class="text-lg font-semibold">Export Filters</h2>
      </div>
      <div class="flex flex-wrap items-end gap-4">
        <label class="flex flex-col gap-2 text-sm text-gray-700">
          <span class="font-medium">Row filter</span>
          <select
            value={props.rowFilter}
            class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            onChange={(event) => {
              props.onRowFilterChange(getNormalizedComparisonProjectRowFilter(event.currentTarget.value))
            }}
          >
            <For each={comparisonProjectRowFilters}>
              {(option) => {
                return <option value={option}>{getComparisonProjectRowFilterLabel(option, props.isSummaryMode)}</option>
              }}
            </For>
          </select>
        </label>
        <label class="flex flex-col gap-2 text-sm text-gray-700">
          <span class="font-medium">Difference filter</span>
          <select
            value={props.differenceFilter}
            class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            disabled={props.differenceFilterOptions.length <= 1}
            onChange={(event) => {
              props.onDifferenceFilterChange(event.currentTarget.value as ComparisonProjectDifferenceFilter)
            }}
          >
            <For each={props.differenceFilterOptions}>
              {(option) => {
                return <option value={option.value}>{option.label}</option>
              }}
            </For>
          </select>
        </label>
        <Button
          type="button"
          disabled={props.isExporting}
          onClick={() => {
            props.onExport()
          }}
        >
          {props.isExporting ? 'Exporting...' : 'Export to CSV'}
        </Button>
      </div>
    </div>
  )
}

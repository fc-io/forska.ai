import {For, Show} from 'solid-js'

import {Button} from '../../../../../components/ui/button'
import {
  type ComparisonProjectArticleCategoryFilter,
  comparisonProjectArticleCategoryFilters,
  getComparisonProjectArticleCategoryFilterLabel,
  getNormalizedComparisonProjectArticleCategoryFilter,
} from '../../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import type {ComparisonProjectDifferenceFilter} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  comparisonProjectRowFilters,
  getComparisonProjectRowFilterLabel,
  getNormalizedComparisonProjectRowFilter,
} from '../../../../../utils/comparisonProjectRowFilter.ts'

type CompareProjectExportDifferenceFilterOption = {label: string; value: ComparisonProjectDifferenceFilter}

type CompareProjectExportFiltersProps = {
  articleCategoryFilter: ComparisonProjectArticleCategoryFilter
  differenceFilter: ComparisonProjectDifferenceFilter
  differenceFilterDisabled: boolean
  differenceFilterOptions: CompareProjectExportDifferenceFilterOption[]
  isExportingCsv: boolean
  isExportingPdf: boolean
  isSummaryMode: boolean
  showArticleCategoryFilter: boolean
  onArticleCategoryFilterChange: (value: ComparisonProjectArticleCategoryFilter) => void
  onDifferenceFilterChange: (value: ComparisonProjectDifferenceFilter) => void
  onExportCsv: () => void
  onExportPdf: () => void
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
                return (
                  <option selected={option === props.rowFilter} value={option}>
                    {getComparisonProjectRowFilterLabel(option, props.isSummaryMode)}
                  </option>
                )
              }}
            </For>
          </select>
        </label>
        <label class="flex flex-col gap-2 text-sm text-gray-700">
          <span class="font-medium">Difference filter</span>
          <select
            value={props.differenceFilter}
            class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            disabled={props.differenceFilterDisabled}
            onChange={(event) => {
              props.onDifferenceFilterChange(event.currentTarget.value as ComparisonProjectDifferenceFilter)
            }}
          >
            <For each={props.differenceFilterOptions}>
              {(option) => {
                return (
                  <option selected={option.value === props.differenceFilter} value={option.value}>
                    {option.label}
                  </option>
                )
              }}
            </For>
          </select>
        </label>
        <Show when={props.showArticleCategoryFilter}>
          <label class="flex flex-col gap-2 text-sm text-gray-700">
            <span class="font-medium">Language</span>
            <select
              value={props.articleCategoryFilter}
              class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
              onChange={(event) => {
                props.onArticleCategoryFilterChange(
                  getNormalizedComparisonProjectArticleCategoryFilter(event.currentTarget.value),
                )
              }}
            >
              <For each={comparisonProjectArticleCategoryFilters}>
                {(option) => {
                  return (
                    <option selected={option === props.articleCategoryFilter} value={option}>
                      {getComparisonProjectArticleCategoryFilterLabel(option)}
                    </option>
                  )
                }}
              </For>
            </select>
          </label>
        </Show>
        <Button
          type="button"
          disabled={props.isExportingCsv || props.isExportingPdf}
          onClick={() => {
            props.onExportCsv()
          }}
        >
          {props.isExportingCsv ? 'Exporting CSV...' : 'Export to CSV'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={props.isExportingCsv || props.isExportingPdf}
          onClick={() => {
            props.onExportPdf()
          }}
        >
          {props.isExportingPdf ? 'Exporting PDF...' : 'Export to PDF'}
        </Button>
      </div>
    </div>
  )
}

import {Show} from 'solid-js'

import {Button} from '../../../../../components/ui/button'
import {MultiSelect, type MultiSelectOption} from '../../../../../components/ui/multi-select.tsx'
import {
  type ComparisonProjectArticleCategory,
  getComparisonProjectArticleCategoryFilterOptions,
  getNormalizedComparisonProjectArticleCategoryFilters,
} from '../../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import {
  type ComparisonProjectConflictResolutionFilter,
  type ComparisonProjectConflictResolutionFilterOption,
  getNormalizedComparisonProjectConflictResolutionFilters,
} from '../../../../../utils/comparisonProjectConflictResolutionFilter.ts'
import {
  type ComparisonProjectDifferenceFilter,
  getComparisonProjectDifferenceFilterSelection,
} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  getNormalizedComparisonProjectRowFilters,
} from '../../../../../utils/comparisonProjectRowFilter.ts'

type CompareProjectExportDifferenceFilterOption = {label: string; value: ComparisonProjectDifferenceFilter}

const articleCategoryFilterOptions = getComparisonProjectArticleCategoryFilterOptions()

type CompareProjectExportFiltersProps = {
  articleCategoryFilters: readonly ComparisonProjectArticleCategory[]
  conflictResolutionFilters: readonly ComparisonProjectConflictResolutionFilter[]
  conflictResolutionFilterOptions: ComparisonProjectConflictResolutionFilterOption[]
  differenceFilters: readonly ComparisonProjectDifferenceFilter[]
  differenceFilterDisabled: boolean
  differenceFilterOptions: CompareProjectExportDifferenceFilterOption[]
  isExportingCsv: boolean
  isExportingPdf: boolean
  rowFilterOptions: MultiSelectOption[]
  showArticleCategoryFilter: boolean
  showConflictResolutionFilter: boolean
  onArticleCategoryFiltersChange: (values: ComparisonProjectArticleCategory[]) => void
  onConflictResolutionFiltersChange: (values: ComparisonProjectConflictResolutionFilter[]) => void
  onDifferenceFiltersChange: (values: ComparisonProjectDifferenceFilter[]) => void
  onExportCsv: () => void
  onExportPdf: () => void
  onRowFiltersChange: (values: ComparisonProjectRowFilter[]) => void
  rowFilters: readonly ComparisonProjectRowFilter[]
}

export const CompareProjectExportFilters = (props: CompareProjectExportFiltersProps) => {
  return (
    <div class="rounded-lg bg-white p-6 shadow">
      <div class="mb-4">
        <h2 class="text-lg font-semibold">Export Filters</h2>
      </div>
      <div class="flex flex-col gap-4 min-[1430px]:flex-row min-[1430px]:items-end min-[1430px]:justify-between">
        <div class="flex flex-wrap items-end gap-4">
          <label class="flex w-72 flex-col gap-2 text-sm text-gray-700">
            <span class="font-medium">Row filter</span>
            <MultiSelect
              ariaLabel="Row filter"
              options={props.rowFilterOptions}
              placeholder="All rows"
              values={props.rowFilters}
              onChange={(values) => {
                props.onRowFiltersChange(getNormalizedComparisonProjectRowFilters(values))
              }}
            />
          </label>
          <label class="flex w-72 flex-col gap-2 text-sm text-gray-700">
            <span class="font-medium">Difference filter</span>
            <MultiSelect
              ariaLabel="Difference filter"
              disabled={props.differenceFilterDisabled}
              options={props.differenceFilterOptions}
              placeholder="All rows"
              values={props.differenceFilters}
              onChange={(values) => {
                props.onDifferenceFiltersChange(getComparisonProjectDifferenceFilterSelection(values))
              }}
            />
          </label>
          <Show when={props.showConflictResolutionFilter}>
            <label class="flex w-72 flex-col gap-2 text-sm text-gray-700">
              <span class="font-medium">Conflict resolutions</span>
              <MultiSelect
                ariaLabel="Conflict resolutions"
                options={props.conflictResolutionFilterOptions}
                placeholder="All"
                values={props.conflictResolutionFilters}
                onChange={(values) => {
                  props.onConflictResolutionFiltersChange(
                    getNormalizedComparisonProjectConflictResolutionFilters(values),
                  )
                }}
              />
            </label>
          </Show>
          <Show when={props.showArticleCategoryFilter}>
            <label class="flex w-72 flex-col gap-2 text-sm text-gray-700">
              <span class="font-medium">Language</span>
              <MultiSelect
                ariaLabel="Language"
                options={articleCategoryFilterOptions}
                placeholder="All"
                values={props.articleCategoryFilters}
                onChange={(values) => {
                  props.onArticleCategoryFiltersChange(getNormalizedComparisonProjectArticleCategoryFilters(values))
                }}
              />
            </label>
          </Show>
        </div>
        <div class="flex flex-wrap items-center gap-3">
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
    </div>
  )
}

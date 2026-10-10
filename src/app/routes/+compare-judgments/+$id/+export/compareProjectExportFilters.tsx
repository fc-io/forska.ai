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
  type ComparisonProjectConflictResolutionProvenanceFilter,
  getComparisonProjectConflictResolutionProvenanceFilterOptions,
  getNormalizedComparisonProjectConflictResolutionFilters,
  getNormalizedComparisonProjectConflictResolutionProvenanceFilters,
} from '../../../../../utils/comparisonProjectConflictResolutionFilter.ts'
import {
  type ComparisonProjectDifferenceFilter,
  getComparisonProjectDifferenceFilterSelection,
} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  getNormalizedComparisonProjectRowFilters,
} from '../../../../../utils/comparisonProjectRowFilter.ts'
import {comparisonProjectSearchTextMaxLength} from '../../../../../utils/comparisonProjectSearchText.ts'
import {compareProjectJudgmentsSearchPlaceholder} from '../+index/compareProjectJudgmentsSearchForm.tsx'

type CompareProjectExportDifferenceFilterOption = {label: string; value: ComparisonProjectDifferenceFilter}

const articleCategoryFilterOptions = getComparisonProjectArticleCategoryFilterOptions()
const conflictResolutionProvenanceFilterOptions = getComparisonProjectConflictResolutionProvenanceFilterOptions()

type CompareProjectExportFiltersProps = {
  articleCategoryFilters: readonly ComparisonProjectArticleCategory[]
  conflictResolutionFilters: readonly ComparisonProjectConflictResolutionFilter[]
  conflictResolutionFilterOptions: ComparisonProjectConflictResolutionFilterOption[]
  conflictResolutionProvenanceFilters: readonly ComparisonProjectConflictResolutionProvenanceFilter[]
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
  onConflictResolutionProvenanceFiltersChange: (values: ComparisonProjectConflictResolutionProvenanceFilter[]) => void
  onDifferenceFiltersChange: (values: ComparisonProjectDifferenceFilter[]) => void
  onExportCsv: () => void
  onExportPdf: () => void
  onRowFiltersChange: (values: ComparisonProjectRowFilter[]) => void
  onSearchTextChange: (value: string) => void
  rowFilters: readonly ComparisonProjectRowFilter[]
  searchText: string
}

export const CompareProjectExportFilters = (props: CompareProjectExportFiltersProps) => {
  return (
    <div class="rounded-lg bg-white p-6 shadow">
      <div class="mb-4">
        <h2 class="text-lg font-semibold">Export Filters</h2>
      </div>
      <div class="space-y-4">
        <label class="flex flex-col text-sm font-medium gap-1 w-full max-w-xl">
          <span>Search title</span>
          <input
            type="text"
            value={props.searchText}
            maxLength={comparisonProjectSearchTextMaxLength}
            onInput={(event) => {
              props.onSearchTextChange(event.currentTarget.value)
            }}
            placeholder={compareProjectJudgmentsSearchPlaceholder}
            class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </label>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div class="flex flex-col gap-2">
            <label class="font-medium text-sm truncate">Row filter:</label>
            <MultiSelect
              ariaLabel="Row filter"
              options={props.rowFilterOptions}
              placeholder="All rows"
              values={props.rowFilters}
              onChange={(values) => {
                props.onRowFiltersChange(getNormalizedComparisonProjectRowFilters(values))
              }}
            />
          </div>
          <div class="flex flex-col gap-2">
            <label class="font-medium text-sm truncate">Difference filter:</label>
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
          </div>
          <Show when={props.showConflictResolutionFilter}>
            <div class="flex flex-col gap-2">
              <label class="font-medium text-sm truncate">Conflict resolutions:</label>
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
            </div>
            <div class="flex flex-col gap-2">
              <label class="font-medium text-sm truncate">Resolution prompts:</label>
              <MultiSelect
                ariaLabel="Resolution prompts"
                options={conflictResolutionProvenanceFilterOptions}
                placeholder="All"
                values={props.conflictResolutionProvenanceFilters}
                onChange={(values) => {
                  props.onConflictResolutionProvenanceFiltersChange(
                    getNormalizedComparisonProjectConflictResolutionProvenanceFilters(values),
                  )
                }}
              />
            </div>
          </Show>
          <Show when={props.showArticleCategoryFilter}>
            <div class="flex flex-col gap-2">
              <label class="font-medium text-sm truncate">Language:</label>
              <MultiSelect
                ariaLabel="Language"
                options={articleCategoryFilterOptions}
                placeholder="All"
                values={props.articleCategoryFilters}
                onChange={(values) => {
                  props.onArticleCategoryFiltersChange(getNormalizedComparisonProjectArticleCategoryFilters(values))
                }}
              />
            </div>
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

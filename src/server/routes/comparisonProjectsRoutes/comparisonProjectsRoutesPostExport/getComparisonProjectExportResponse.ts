import {getComparisonProjectColumnHeader} from '../../../../utils/comparisonProjectColumnHeader.ts'
import {getOrderedComparisonProjectColumns} from '../../../../utils/comparisonProjectColumnOrder.ts'
import {getNormalizedComparisonProjectDifferenceFilters} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import {csvUtf8Bom, getCsvDownloadHeaders} from '../../../utils/csvResponse.ts'
import {
  type ComparisonProjectJudgmentFilters,
  getComparisonProjectDifferenceFilterAvailability,
} from '../comparisonProjectJudgmentFilters.ts'
import {forEachComparisonProjectServingJudgmentRowBatch} from '../comparisonProjectJudgmentRows.ts'
import {comparisonProjectJudgmentArticleBatchSize} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {ComparisonProjectJudgmentsColumn, ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {getComparisonProjectRowsWithConflictResolutions} from '../getComparisonProjectRowsWithConflictResolutions.ts'
import {getComparisonProjectCsvLine} from './comparisonProjectCsvLine.ts'
import {type ComparisonProjectExportRow, getComparisonProjectExportCellValue} from './comparisonProjectExportRow.ts'

const getComparisonProjectExportDateValue = (value: Date | string | null) => {
  return value ? new Date(value).toISOString() : ''
}

const getComparisonProjectExportHeaders = (
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  return [
    'Title',
    'Abstract/Summary',
    'Date added',
    ...(includeConflictResolution ? ['Conflict Handling', 'Conflict comment'] : []),
    ...columns.map((column) => {
      return getComparisonProjectColumnHeader(column)
    }),
  ]
}

const getComparisonProjectExportConflictResolutionValue = (row: ComparisonProjectExportRow) => {
  return row.conflictResolution?.label ?? (row.hasConflict ? '' : 'No conflict')
}

const getComparisonProjectExportRowValues = (
  row: ComparisonProjectExportRow,
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  return [
    row.articleTitle?.trim() || 'Untitled',
    row.articleSummary ?? '',
    getComparisonProjectExportDateValue(row.articleCreatedAt),
    ...(includeConflictResolution
      ? [getComparisonProjectExportConflictResolutionValue(row), row.conflictComment?.comment ?? '']
      : []),
    ...columns.map((column) => {
      return getComparisonProjectExportCellValue(row.cells[column.id])
    }),
  ]
}

const enqueueComparisonProjectExportRows = (
  controller: ReadableStreamDefaultController<string>,
  rows: ComparisonProjectExportRow[],
  columns: readonly ComparisonProjectJudgmentsColumn[],
  includeConflictResolution: boolean,
) => {
  rows.reduce((count, row) => {
    controller.enqueue(
      getComparisonProjectCsvLine(getComparisonProjectExportRowValues(row, columns, includeConflictResolution)),
    )
    return count + 1
  }, 0)
}

const getComparisonProjectExportFilename = (scope: ComparisonProjectScope) => {
  return `${scope.name.replace(/[^a-zA-Z0-9]/g, '_')}_comparison_export_${new Date().toISOString().slice(0, 10)}.csv`
}

export const getComparisonProjectExportResponse = (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
) => {
  const orderedColumns = getOrderedComparisonProjectColumns(scope.columns, scope.prompts)
  const normalizedDifferenceFilters = getNormalizedComparisonProjectDifferenceFilters(
    filters.differenceFilters,
    orderedColumns,
    getComparisonProjectDifferenceFilterAvailability(scope),
  )
  const includeConflictResolution = scope.allowConflictResolution
  const headers = getComparisonProjectExportHeaders(orderedColumns, includeConflictResolution)
  const filename = getComparisonProjectExportFilename(scope)
  const responseHeaders = getCsvDownloadHeaders(filename)
  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        controller.enqueue(csvUtf8Bom + getComparisonProjectCsvLine(headers))

        if (!scope.archived && scope.prompts.length > 0 && orderedColumns.length > 0) {
          await forEachComparisonProjectServingJudgmentRowBatch({
            comparisonProjectId: scope.id,
            articleCategoryFilter: filters.articleCategoryFilters,
            conflictResolutionFilter: filters.conflictResolutionFilters,
            conflictResolutionProvenanceFilter: filters.conflictResolutionProvenanceFilters,
            currentJudgmentContextId: scope.judgmentContextId,
            differenceFilter: normalizedDifferenceFilters,
            limit: comparisonProjectJudgmentArticleBatchSize,
            onRows: async (rows) => {
              const exportRows = includeConflictResolution
                ? await getComparisonProjectRowsWithConflictResolutions(scope, rows)
                : rows
              enqueueComparisonProjectExportRows(controller, exportRows, orderedColumns, includeConflictResolution)
            },
            queryRunner: appDatabaseService,
            rowFilter: filters.rowFilters,
            searchText: filters.searchText,
          })
        }

        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

  return new Response(stream, {headers: responseHeaders})
}

import {getOrderedComparisonProjectColumns} from '../../../../utils/comparisonProjectColumnOrder.ts'
import {getNormalizedComparisonProjectDifferenceFilters} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import {SimplePdfDocument} from '../../../utils/simplePdf.ts'
import {
  type ComparisonProjectJudgmentFilters,
  getComparisonProjectDifferenceFilterAvailability,
} from '../comparisonProjectJudgmentFilters.ts'
import {forEachComparisonProjectServingJudgmentRowBatch} from '../comparisonProjectJudgmentRows.ts'
import {comparisonProjectJudgmentArticleBatchSize} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {ComparisonProjectLlmRow} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {getComparisonProjectJudgmentsCount} from '../getComparisonProjectJudgmentsCount.ts'
import {getComparisonProjectLlmRows} from '../getComparisonProjectLlmRows.ts'
import {getComparisonProjectRowsWithConflictResolutions} from '../getComparisonProjectRowsWithConflictResolutions.ts'
import {getIsSummaryMode} from '../getIsSummaryMode.ts'
import {addComparisonProjectPdfExportRow} from './getComparisonProjectPdfExportResponse/addComparisonProjectPdfExportRow.ts'
import {addComparisonProjectPdfFrontPage} from './getComparisonProjectPdfExportResponse/addComparisonProjectPdfFrontPage.ts'
import {addComparisonProjectPdfPromptOverviewPage} from './getComparisonProjectPdfExportResponse/addComparisonProjectPdfPromptOverviewPage.ts'
import {getComparisonProjectPdfExportedAtLabel} from './getComparisonProjectPdfExportResponse/getComparisonProjectPdfExportedAtLabel.ts'
import {getComparisonProjectPdfHeaderFilters} from './getComparisonProjectPdfExportResponse/getComparisonProjectPdfHeaderFilters.ts'

const getComparisonProjectPdfExportFilename = (scope: ComparisonProjectScope) => {
  return `${scope.name.replace(/[^a-zA-Z0-9]/g, '_')}_comparison_export_${new Date().toISOString().slice(0, 10)}.pdf`
}

export const getComparisonProjectPdfExportResponse = async (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
) => {
  const orderedColumns = getOrderedComparisonProjectColumns(scope.columns, scope.prompts)
  const normalizedFilters: ComparisonProjectJudgmentFilters = {
    ...filters,
    differenceFilters: getNormalizedComparisonProjectDifferenceFilters(
      filters.differenceFilters,
      orderedColumns,
      getComparisonProjectDifferenceFilterAvailability(scope),
    ),
  }
  const filename = getComparisonProjectPdfExportFilename(scope)
  const pdf = new SimplePdfDocument()
  const totalCountResult = await getComparisonProjectJudgmentsCount(
    scope,
    comparisonProjectJudgmentArticleBatchSize,
    normalizedFilters,
  )
  const exportFilters = getComparisonProjectPdfHeaderFilters({filters: normalizedFilters, scope})
  const exportedAt = getComparisonProjectPdfExportedAtLabel()
  let rowIndex = 0

  addComparisonProjectPdfFrontPage({exportFilters, exportedAt, pdf, scope, totalCount: totalCountResult.totalCount})
  addComparisonProjectPdfPromptOverviewPage(pdf, scope)

  if (!scope.archived && scope.prompts.length > 0 && orderedColumns.length > 0) {
    await forEachComparisonProjectServingJudgmentRowBatch({
      comparisonProjectId: scope.id,
      articleCategoryFilter: normalizedFilters.articleCategoryFilters,
      conflictResolutionFilter: normalizedFilters.conflictResolutionFilters,
      conflictResolutionProvenanceFilter: normalizedFilters.conflictResolutionProvenanceFilters,
      currentJudgmentContextId: scope.judgmentContextId,
      differenceFilter: normalizedFilters.differenceFilters,
      limit: comparisonProjectJudgmentArticleBatchSize,
      onRows: async (rows) => {
        const exportRows = scope.allowConflictResolution
          ? await getComparisonProjectRowsWithConflictResolutions(scope, rows)
          : rows
        const componentRows =
          getIsSummaryMode(scope) && scope.sourceProjectSummaryPrompts.length > 0
            ? await getComparisonProjectLlmRows(
                scope,
                rows.map((row) => {
                  return row.canonicalArticleId
                }),
              )
            : []
        const componentRowsByArticle = componentRows.reduce<Map<string, ComparisonProjectLlmRow[]>>((rowMap, row) => {
          const articleRows = rowMap.get(row.articleId) ?? []
          rowMap.set(row.articleId, [...articleRows, row])
          return rowMap
        }, new Map<string, ComparisonProjectLlmRow[]>())

        exportRows.forEach((row) => {
          addComparisonProjectPdfExportRow({
            columns: orderedColumns,
            componentRows: componentRowsByArticle.get(row.canonicalArticleId) ?? [],
            exportFilters,
            index: rowIndex,
            pdf,
            row,
            scope,
            totalCount: totalCountResult.totalCount,
          })
          rowIndex += 1
        })
      },
      queryRunner: appDatabaseService,
      rowFilter: normalizedFilters.rowFilters,
      searchText: normalizedFilters.searchText,
    })
  }

  if (rowIndex === 0) {
    pdf.addPage()
    pdf.addText(`Project: ${scope.name}`, {fontSize: 8})
    pdf.addText(`Filters: ${exportFilters}`, {fontSize: 8, gapAfter: 12})
    pdf.addText('No rows matched the selected export filters.', {font: 'bold', fontSize: 12})
  }

  return new Response(pdf.toBuffer(), {
    headers: {'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Type': 'application/pdf'},
  })
}

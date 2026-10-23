import {SimplePdfDocument} from '../../../../utils/simplePdf.ts'
import type {ComparisonProjectLlmRow} from '../../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectJudgmentsColumn, ComparisonProjectScope} from '../../comparisonProjectScopeTypes.ts'
import type {ComparisonProjectExportRow} from '../comparisonProjectExportRow.ts'
import {addComparisonProjectPdfConflictResolution} from './addComparisonProjectPdfExportRow/addComparisonProjectPdfConflictResolution.ts'
import {addComparisonProjectPdfLlmAssessmentSection} from './addComparisonProjectPdfExportRow/addComparisonProjectPdfLlmAssessmentSection.ts'
import {addComparisonProjectPdfSummaryJudgmentSection} from './addComparisonProjectPdfExportRow/addComparisonProjectPdfSummaryJudgmentSection.ts'
import {getComparisonProjectPdfArticleFieldPrefix} from './addComparisonProjectPdfExportRow/getComparisonProjectPdfArticleFieldPrefix.ts'
import {getComparisonProjectPdfExportedComment} from './addComparisonProjectPdfExportRow/getComparisonProjectPdfExportedComment.ts'
import {addComparisonProjectPdfHiddenMetadata} from './addComparisonProjectPdfHiddenMetadata.ts'
import {getComparisonProjectPdfExportedAtLabel} from './getComparisonProjectPdfExportedAtLabel.ts'

const addComparisonProjectPdfRowImportMetadata = (
  pdf: SimplePdfDocument,
  scope: ComparisonProjectScope,
  row: ComparisonProjectExportRow,
) => {
  addComparisonProjectPdfHiddenMetadata(
    pdf,
    [getComparisonProjectPdfArticleFieldPrefix(scope, row), 'metadata'].join('.'),
    {
      articleExternalId: row.articleExternalId,
      articleTitle: row.articleTitle,
      canonicalArticleId: row.canonicalArticleId,
      comparisonProjectId: scope.id,
      currentResolutionValue: row.conflictResolution?.value ?? null,
      exportedComment: getComparisonProjectPdfExportedComment(row),
      hasConflict: row.hasConflict,
    },
  )
}

export const addComparisonProjectPdfExportRow = (params: {
  columns: readonly ComparisonProjectJudgmentsColumn[]
  componentRows: readonly ComparisonProjectLlmRow[]
  exportFilters: string
  index: number
  pdf: SimplePdfDocument
  row: ComparisonProjectExportRow
  scope: ComparisonProjectScope
  totalCount: number
}) => {
  const {columns, componentRows, exportFilters, index, pdf, row, scope, totalCount} = params

  pdf.addPage()
  addComparisonProjectPdfRowImportMetadata(pdf, scope, row)

  pdf.addText(`Project: ${scope.name}`, {fontSize: 8})
  pdf.addText(`Filters: ${exportFilters}`, {fontSize: 8})
  pdf.addText(`Exported: ${getComparisonProjectPdfExportedAtLabel()}`, {fontSize: 8, gapAfter: 12})
  pdf.addText(
    `Article ${index + 1} of ${totalCount} | Article ID: ${row.articleExternalId ?? row.canonicalArticleId}`,
    {fontSize: 8, gapAfter: 10},
  )
  pdf.addText(row.articleTitle?.trim() || 'Untitled', {font: 'bold', fontSize: 15, gapAfter: 10})
  pdf.addText('Abstract / Summary', {font: 'bold', fontSize: 11, gapAfter: 4})
  pdf.addText(row.articleSummary?.trim() || 'No abstract or summary available.', {fontSize: 10, gapAfter: 12})
  addComparisonProjectPdfConflictResolution(pdf, scope, row)
  addComparisonProjectPdfSummaryJudgmentSection(pdf, row, columns)
  addComparisonProjectPdfLlmAssessmentSection(pdf, row, columns, scope, componentRows)
}

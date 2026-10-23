import {comparisonProjectConflictResolutionCommentMaxLength} from '../../../../../../utils/comparisonProjectConflictResolutionComment.ts'
import {SimplePdfDocument} from '../../../../../utils/simplePdf.ts'
import {getComparisonProjectConflictResolutionOptions} from '../../../comparisonProjectConflictResolutionOptions.ts'
import {pdfConflictResolutionNotSetValue} from '../../../comparisonProjectConflictResolutionPdfImport.ts'
import type {ComparisonProjectScope} from '../../../comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from '../../../getIsSummaryMode.ts'
import type {ComparisonProjectExportRow} from '../../comparisonProjectExportRow.ts'
import {getComparisonProjectPdfArticleFieldPrefix} from './getComparisonProjectPdfArticleFieldPrefix.ts'
import {getComparisonProjectPdfExportedComment} from './getComparisonProjectPdfExportedComment.ts'

const getComparisonProjectPdfResolutionOptions = (scope: ComparisonProjectScope) => {
  const options = getComparisonProjectConflictResolutionOptions(scope)

  const resolutionOptions =
    options.length > 0
      ? options
      : [
          {label: 'Include / Yes', value: 'yes'},
          {label: 'Exclude / No', value: 'no'},
          {label: 'Maybe / Unsure', value: 'maybe'},
        ]

  return [{label: 'Undecided', value: pdfConflictResolutionNotSetValue}, ...resolutionOptions]
}

const addComparisonProjectPdfResolutionRadios = (
  pdf: SimplePdfDocument,
  scope: ComparisonProjectScope,
  row: ComparisonProjectExportRow,
) => {
  if (!row.hasConflict && !row.conflictResolution) {
    return
  }

  pdf.addText(getIsSummaryMode(scope) ? 'Include this study?' : 'Choose resolution', {fontSize: 10, gapAfter: 4})
  pdf.addRadioRow(
    [getComparisonProjectPdfArticleFieldPrefix(scope, row), 'resolution'].join('.'),
    null,
    getComparisonProjectPdfResolutionOptions(scope).map((option) => {
      return {label: option.label, value: option.value, fontSize: 10, gapAfter: 3}
    }),
  )
  pdf.addGap(6)
}

export const addComparisonProjectPdfConflictResolution = (
  pdf: SimplePdfDocument,
  scope: ComparisonProjectScope,
  row: ComparisonProjectExportRow,
) => {
  if (!scope.allowConflictResolution || (!row.hasConflict && !row.conflictResolution && !row.conflictComment)) {
    return
  }

  pdf.addPanel({title: 'Conflict resolution'}, () => {
    pdf.addInlineText(
      [
        {text: 'Current resolution: '},
        {font: 'bold', text: row.conflictResolution?.label ?? 'Not set'},
        ...(row.hasConflict ? [] : [{text: ' (no current conflict)'}]),
      ],
      {fontSize: 10, gapAfter: 6},
    )
    addComparisonProjectPdfResolutionRadios(pdf, scope, row)
    pdf.addTextField({
      fieldName: [getComparisonProjectPdfArticleFieldPrefix(scope, row), 'comment'].join('.'),
      fontSize: 10,
      gapAfter: 0,
      label: 'Comment (optional)',
      lines: 4,
      maxLength: comparisonProjectConflictResolutionCommentMaxLength,
      multiline: true,
      value: getComparisonProjectPdfExportedComment(row) ?? '',
    })
  })
}

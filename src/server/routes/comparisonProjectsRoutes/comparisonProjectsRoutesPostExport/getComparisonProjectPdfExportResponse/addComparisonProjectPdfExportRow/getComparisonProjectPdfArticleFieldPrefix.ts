import type {ComparisonProjectScope} from '../../../comparisonProjectScopeTypes.ts'
import type {ComparisonProjectExportRow} from '../../comparisonProjectExportRow.ts'

const getComparisonProjectPdfFieldNamePart = (value: string) => {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export const getComparisonProjectPdfArticleFieldPrefix = (
  scope: ComparisonProjectScope,
  row: ComparisonProjectExportRow,
) => {
  return [
    'comparison',
    getComparisonProjectPdfFieldNamePart(scope.id),
    'article',
    getComparisonProjectPdfFieldNamePart(row.canonicalArticleId),
  ].join('.')
}

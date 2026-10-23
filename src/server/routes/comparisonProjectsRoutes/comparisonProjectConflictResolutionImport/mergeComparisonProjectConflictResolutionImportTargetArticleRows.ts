import {getComparisonProjectConflictResolutionImportDoiKeys} from './comparisonProjectConflictResolutionImportIdentifierKeys.ts'
import type {ComparisonProjectConflictResolutionImportTargetArticle} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getUniqueStringValues} from './comparisonProjectConflictResolutionImportUtils.ts'
import {getNormalizedIdentifierKeys} from './getNormalizedIdentifierKeys.ts'

export type ComparisonProjectConflictResolutionImportTargetArticleQueryRow = Omit<
  ComparisonProjectConflictResolutionImportTargetArticle,
  'isConflictResolutionEligible'
>

const mergeComparisonProjectConflictResolutionImportTargetArticleRow = (
  currentRow: ComparisonProjectConflictResolutionImportTargetArticleQueryRow,
  nextRow: ComparisonProjectConflictResolutionImportTargetArticleQueryRow,
): ComparisonProjectConflictResolutionImportTargetArticleQueryRow => {
  return {
    articleId: currentRow.articleId,
    doi: currentRow.doi ?? nextRow.doi ?? null,
    doiKeys: getUniqueStringValues([
      ...getComparisonProjectConflictResolutionImportDoiKeys(currentRow),
      ...getComparisonProjectConflictResolutionImportDoiKeys(nextRow),
    ]),
    identifierKeys: getUniqueStringValues([
      ...getNormalizedIdentifierKeys(currentRow).map((identifierKey) => {
        return identifierKey.key
      }),
      ...getNormalizedIdentifierKeys(nextRow).map((identifierKey) => {
        return identifierKey.key
      }),
    ]),
    externalArticleId: currentRow.externalArticleId ?? nextRow.externalArticleId ?? null,
    legacyDoi: currentRow.legacyDoi ?? nextRow.legacyDoi ?? null,
    pubmedId: currentRow.pubmedId ?? nextRow.pubmedId ?? null,
    arxivId: currentRow.arxivId ?? nextRow.arxivId ?? null,
    title: currentRow.title ?? nextRow.title ?? null,
  }
}

export const mergeComparisonProjectConflictResolutionImportTargetArticleRows = (
  rows: readonly ComparisonProjectConflictResolutionImportTargetArticleQueryRow[],
) => {
  return Array.from(
    rows
      .reduce<Map<string, ComparisonProjectConflictResolutionImportTargetArticleQueryRow>>((rowMap, row) => {
        const currentRow = rowMap.get(row.articleId)

        rowMap.set(
          row.articleId,
          currentRow ? mergeComparisonProjectConflictResolutionImportTargetArticleRow(currentRow, row) : row,
        )
        return rowMap
      }, new Map<string, ComparisonProjectConflictResolutionImportTargetArticleQueryRow>())
      .values(),
  )
}

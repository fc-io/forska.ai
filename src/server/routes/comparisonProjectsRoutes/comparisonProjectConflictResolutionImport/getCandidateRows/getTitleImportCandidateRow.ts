import type {
  ImportCandidateRowResult,
  NormalizedSourceRow,
  NormalizedTargetArticle,
} from '../comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportOverwriteMode,
} from '../comparisonProjectConflictResolutionImportTypes.ts'
import {getImportRowMatchDetail} from '../getImportRowMatchDetail.ts'
import {getSkippedRow} from '../getSkippedRow.ts'
import {getTargetArticleMaps} from './getTargetArticleMaps.ts'
import {
  getAmbiguousMatchKey,
  getAmbiguousTargetMatchWarning,
  getCandidateRow,
  getEligibleTargetMatches,
  getExistingTargetResolutionResult,
  getImportRowMatchDetailFromMatch,
  getTargetArticlesFromMatches,
  getUniqueTargetArticleMatches,
} from './importCandidateRowMatches.ts'

const getCanUseTitleFallbackTargetArticle = (row: NormalizedSourceRow, targetArticle: NormalizedTargetArticle) => {
  return (
    row.titleKey === targetArticle.titleKey
    && (row.identifierKeys.length === 0 || targetArticle.identifierKeys.length === 0)
  )
}

export const getTitleImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult | null => {
  const targetMatches = getUniqueTargetArticleMatches(
    row.titleKey
      ? (targetArticleMaps.byTitleKey.get(row.titleKey) ?? [])
          .filter((targetArticle) => {
            return getCanUseTitleFallbackTargetArticle(row, targetArticle)
          })
          .map((targetArticle) => {
            return {matchKey: row.titleKey ?? '', matchKind: 'title' as const, targetArticle}
          })
      : [],
  )
  const eligibleMatches = getEligibleTargetMatches(targetMatches, importMode)
  const selectedMatch = eligibleMatches.length === 1 ? eligibleMatches[0] : null
  const existingResolutionResult = selectedMatch
    ? getExistingTargetResolutionResult(row, selectedMatch, overwriteMode)
    : null
  const skipReason =
    targetMatches.length === 0
      ? 'no-target-match'
      : eligibleMatches.length === 0
        ? 'not-conflicting'
        : selectedMatch
          ? null
          : 'ambiguous-target-match'

  return !row.titleKey
    ? null
    : existingResolutionResult
      ? existingResolutionResult
      : selectedMatch
        ? {
            candidate: getCandidateRow({
              matchKey: selectedMatch.matchKey,
              matchKind: 'title',
              row,
              targetArticle: selectedMatch.targetArticle,
            }),
            detail: getImportRowMatchDetailFromMatch(row, selectedMatch),
            skippedRow: null,
            warnings: [],
          }
        : {
            candidate: null,
            detail: getImportRowMatchDetail({
              matchKey: row.titleKey,
              matchKind: 'title',
              sourceRow: row,
              targetArticles: getTargetArticlesFromMatches(
                eligibleMatches.length > 0 ? eligibleMatches : targetMatches,
              ),
            }),
            skippedRow: getSkippedRow(row.sourceRowId, skipReason),
            warnings:
              skipReason === 'ambiguous-target-match'
                ? [
                    getAmbiguousTargetMatchWarning({
                      matchKey: getAmbiguousMatchKey(eligibleMatches),
                      matchKind: 'title',
                      sourceRow: row,
                      targetArticles: getTargetArticlesFromMatches(eligibleMatches),
                    }),
                  ]
                : [],
          }
}

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

const getCanUseIdTitleFallbackTargetArticle = (row: NormalizedSourceRow, targetArticle: NormalizedTargetArticle) => {
  return (
    row.idTitleKey === targetArticle.idTitleKey
    && (row.identifierKeys.length === 0 || targetArticle.identifierKeys.length === 0)
  )
}

export const getIdTitleImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult => {
  const targetMatches = getUniqueTargetArticleMatches(
    row.idTitleKey
      ? (targetArticleMaps.byIdTitleKey.get(row.idTitleKey) ?? [])
          .filter((targetArticle) => {
            return getCanUseIdTitleFallbackTargetArticle(row, targetArticle)
          })
          .map((targetArticle) => {
            return {matchKey: row.idTitleKey ?? '', matchKind: 'id-title' as const, targetArticle}
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

  return existingResolutionResult
    ? existingResolutionResult
    : selectedMatch
      ? {
          candidate: getCandidateRow({
            matchKey: selectedMatch.matchKey,
            matchKind: 'id-title',
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
            matchKey: row.idTitleKey,
            matchKind: row.idTitleKey ? 'id-title' : null,
            sourceRow: row,
            targetArticles: getTargetArticlesFromMatches(eligibleMatches.length > 0 ? eligibleMatches : targetMatches),
          }),
          skippedRow: getSkippedRow(row.sourceRowId, skipReason),
          warnings:
            skipReason === 'ambiguous-target-match'
              ? [
                  getAmbiguousTargetMatchWarning({
                    matchKey: getAmbiguousMatchKey(eligibleMatches),
                    matchKind: 'id-title',
                    sourceRow: row,
                    targetArticles: getTargetArticlesFromMatches(eligibleMatches),
                  }),
                ]
              : [],
        }
}

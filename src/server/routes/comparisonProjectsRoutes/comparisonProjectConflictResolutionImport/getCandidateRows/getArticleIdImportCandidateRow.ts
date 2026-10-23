import type {
  ImportCandidateRowResult,
  NormalizedSourceRow,
} from '../comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportOverwriteMode,
} from '../comparisonProjectConflictResolutionImportTypes.ts'
import {getSkippedRow} from '../getSkippedRow.ts'
import {getTargetArticleMaps} from './getTargetArticleMaps.ts'
import {
  getCandidateRow,
  getExistingTargetResolutionResult,
  getImportRowMatchDetailFromMatch,
  getIsTargetArticleImportEligible,
} from './importCandidateRowMatches.ts'

export const getArticleIdImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult | null => {
  const targetArticle = targetArticleMaps.byArticleId.get(row.sourceArticleId) ?? null
  const targetMatch = targetArticle
    ? {matchKey: row.sourceArticleId, matchKind: 'article-id' as const, targetArticle}
    : null
  const eligibleMatch =
    targetMatch && getIsTargetArticleImportEligible(importMode, targetMatch.targetArticle) ? targetMatch : null
  const existingResolutionResult = eligibleMatch
    ? getExistingTargetResolutionResult(row, eligibleMatch, overwriteMode)
    : null

  return existingResolutionResult
    ? existingResolutionResult
    : eligibleMatch
      ? {
          candidate: getCandidateRow({
            matchKey: eligibleMatch.matchKey,
            matchKind: eligibleMatch.matchKind,
            row,
            targetArticle: eligibleMatch.targetArticle,
          }),
          detail: getImportRowMatchDetailFromMatch(row, eligibleMatch),
          skippedRow: null,
          warnings: [],
        }
      : targetMatch
        ? {
            candidate: null,
            detail: getImportRowMatchDetailFromMatch(row, targetMatch),
            skippedRow: getSkippedRow(row.sourceRowId, 'not-conflicting'),
            warnings: [],
          }
        : null
}

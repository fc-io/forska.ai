import type {
  ImportCandidateRow,
  ImportCandidateRowResult,
  ImportRowMatchDetail,
  ImportTargetArticleMatch,
  NormalizedSourceRow,
  NormalizedTargetArticle,
} from '../comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportMatchKind,
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportOverwriteMode,
  ComparisonProjectConflictResolutionImportWarning,
} from '../comparisonProjectConflictResolutionImportTypes.ts'
import {getUniqueStringValues} from '../comparisonProjectConflictResolutionImportUtils.ts'
import {getImportRowMatchDetail} from '../getImportRowMatchDetail.ts'
import {getWarningSourceRow, getWarningTargetArticle} from '../getImportWarningRows.ts'
import {getSkippedRow} from '../getSkippedRow.ts'
import {getTargetArticleIds} from '../getTargetArticleIds.ts'

export const getUniqueTargetArticleMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  return Array.from(
    matches
      .reduce<Map<string, ImportTargetArticleMatch>>((matchMap, match) => {
        return matchMap.has(match.targetArticle.articleId)
          ? matchMap
          : matchMap.set(match.targetArticle.articleId, match)
      }, new Map<string, ImportTargetArticleMatch>())
      .values(),
  )
}

export const getAmbiguousTargetMatchWarning = (params: {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  sourceRow: NormalizedSourceRow
  targetArticles: readonly NormalizedTargetArticle[]
}): ComparisonProjectConflictResolutionImportWarning => {
  const targetArticleIds = getTargetArticleIds(params.targetArticles)

  return {
    code: 'ambiguous-target-match',
    matchKey: params.matchKey,
    matchKind: params.matchKind,
    message: `Source row ${params.sourceRow.sourceRowId} matched multiple eligible target articles: ${targetArticleIds.join(', ')}`,
    sourceRows: [getWarningSourceRow(params.sourceRow)],
    targetArticles: params.targetArticles.map(getWarningTargetArticle),
  }
}

export const getImportRowMatchDetailFromMatch = (
  row: NormalizedSourceRow,
  match: ImportTargetArticleMatch,
): ImportRowMatchDetail => {
  return getImportRowMatchDetail({
    matchKey: match.matchKey,
    matchKind: match.matchKind,
    sourceRow: row,
    targetArticles: [match.targetArticle],
  })
}

export const getIsTargetArticleImportEligible = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  targetArticle: NormalizedTargetArticle,
) => {
  return importMode === 'all-matched' || targetArticle.isConflictResolutionEligible
}

export const getEligibleTargetMatches = (
  matches: readonly ImportTargetArticleMatch[],
  importMode: ComparisonProjectConflictResolutionImportMode,
) => {
  return matches.filter((match) => {
    return getIsTargetArticleImportEligible(importMode, match.targetArticle)
  })
}

export const getTargetArticlesFromMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  return matches.map((match) => {
    return match.targetArticle
  })
}

export const getAmbiguousMatchKey = (matches: readonly ImportTargetArticleMatch[]) => {
  return getUniqueStringValues(
    matches.map((match) => {
      return match.matchKey
    }),
  ).join(', ')
}

export const getCandidateRow = (params: {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  row: NormalizedSourceRow
  targetArticle: NormalizedTargetArticle
}): ImportCandidateRow => {
  return {
    isOverwrite: params.row.resolutionValue !== null && params.targetArticle.hasExistingResolution === true,
    matchKey: params.matchKey,
    matchKind: params.matchKind,
    resolutionValue: params.row.resolutionValue,
    sourceRow: params.row,
    sourceRowId: params.row.sourceRowId,
    targetArticle: params.targetArticle,
    targetArticleId: params.targetArticle.articleId,
  }
}

export const getExistingTargetResolutionResult = (
  row: NormalizedSourceRow,
  selectedMatch: ImportTargetArticleMatch,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
): ImportCandidateRowResult | null => {
  if (row.resolutionValue === null || !selectedMatch.targetArticle.hasExistingResolution) {
    return null
  }

  if (selectedMatch.targetArticle.existingResolutionValue === row.resolutionValue) {
    return {
      candidate: null,
      detail: getImportRowMatchDetailFromMatch(row, selectedMatch),
      skippedRow: getSkippedRow(row.sourceRowId, 'same-value'),
      warnings: [],
    }
  }

  return overwriteMode === 'skip-existing'
    ? {
        candidate: null,
        detail: getImportRowMatchDetailFromMatch(row, selectedMatch),
        skippedRow: getSkippedRow(row.sourceRowId, 'existing-target-resolution'),
        warnings: [],
      }
    : null
}

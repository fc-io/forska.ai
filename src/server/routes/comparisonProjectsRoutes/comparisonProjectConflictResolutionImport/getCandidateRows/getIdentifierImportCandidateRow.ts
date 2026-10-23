import {sourceIdentifierTierOrder} from '../comparisonProjectConflictResolutionImportConstants.ts'
import type {
  ImportCandidateRowResult,
  ImportTargetArticleMatch,
  NormalizedIdentifierKey,
  NormalizedSourceRow,
  NormalizedTargetArticle,
  SourceIdentifierTier,
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

const getTargetArticlesForSourceIdentifierKeys = (
  identifierKeys: readonly NormalizedIdentifierKey[],
  targetArticlesByIdentifierKey: Map<string, NormalizedTargetArticle[]>,
) => {
  return identifierKeys.flatMap((identifierKey) => {
    return (targetArticlesByIdentifierKey.get(identifierKey.key) ?? []).map((targetArticle) => {
      return {identifierKey, matchKey: identifierKey.matchKey, matchKind: identifierKey.kind, targetArticle}
    })
  })
}

const getConflictingIdentifiersWarning = (params: {
  matches: readonly ImportTargetArticleMatch[]
  sourceRow: NormalizedSourceRow
}): ComparisonProjectConflictResolutionImportWarning => {
  const matchKeys = getUniqueStringValues(
    params.matches.map((match) => {
      return match.matchKey
    }),
  )
  const matchKinds = params.matches.reduce<ComparisonProjectConflictResolutionImportMatchKind[]>(
    (matchKinds, match) => {
      return matchKinds.includes(match.matchKind) ? matchKinds : [...matchKinds, match.matchKind]
    },
    [],
  )
  const targetArticleIds = getTargetArticleIds(getTargetArticlesFromMatches(params.matches))

  return {
    code: 'conflicting-identifiers',
    matchKey: matchKeys.join(', '),
    matchKeys,
    matchKind: matchKinds[0],
    matchKinds,
    message: `Source row ${params.sourceRow.sourceRowId} identifiers point to different target articles: ${targetArticleIds.join(', ')}`,
    sourceRows: [getWarningSourceRow(params.sourceRow)],
    targetArticles: getTargetArticlesFromMatches(params.matches).map(getWarningTargetArticle),
  }
}

const getAmbiguousMatchKind = (matches: readonly ImportTargetArticleMatch[]) => {
  return matches[0]?.matchKind ?? 'id-title'
}

const getIdentifierTieBreakerMatches = (row: NormalizedSourceRow, matches: readonly ImportTargetArticleMatch[]) => {
  return row.idTitleKey
    ? matches.filter((match) => {
        return match.targetArticle.idTitleKey === row.idTitleKey
      })
    : []
}

const getHasConflictingIdentifierMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  const targetArticleIds = getTargetArticleIds(getTargetArticlesFromMatches(matches))
  const matchKeys = getUniqueStringValues(
    matches.map((match) => {
      return match.matchKey
    }),
  )

  return targetArticleIds.length > 1 && matchKeys.length > 1
}

const getSelectedIdentifierMatch = (row: NormalizedSourceRow, matches: readonly ImportTargetArticleMatch[]) => {
  const tieBreakerMatches = getHasConflictingIdentifierMatches(matches)
    ? []
    : getIdentifierTieBreakerMatches(row, matches)

  return matches.length === 1 ? matches[0] : tieBreakerMatches.length === 1 ? tieBreakerMatches[0] : null
}

const getNotConflictingIdentifierDetailMatches = (
  row: NormalizedSourceRow,
  targetMatches: readonly ImportTargetArticleMatch[],
) => {
  const selectedMatch = getSelectedIdentifierMatch(row, targetMatches)

  return selectedMatch ? [selectedMatch] : targetMatches
}

const getIdentifierKeysForTier = (row: NormalizedSourceRow, tier: SourceIdentifierTier) => {
  return row.identifierKeys.filter((identifierKey) => {
    return identifierKey.tier === tier
  })
}

const getIdentifierImportCandidateRowForTier = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
  tier: SourceIdentifierTier,
): ImportCandidateRowResult | null => {
  const identifierKeys = getIdentifierKeysForTier(row, tier)
  const targetMatches = getUniqueTargetArticleMatches(
    getTargetArticlesForSourceIdentifierKeys(identifierKeys, targetArticleMaps.byIdentifierKey),
  )
  const eligibleMatches = getEligibleTargetMatches(targetMatches, importMode)
  const hasConflictingIdentifiers = getHasConflictingIdentifierMatches(eligibleMatches)
  const selectedMatch = getSelectedIdentifierMatch(row, eligibleMatches)
  const detailMatches =
    eligibleMatches.length > 0 ? eligibleMatches : getNotConflictingIdentifierDetailMatches(row, targetMatches)
  const skipReason =
    targetMatches.length === 0
      ? null
      : eligibleMatches.length === 0
        ? 'not-conflicting'
        : hasConflictingIdentifiers
          ? 'conflicting-identifiers'
          : selectedMatch
            ? null
            : 'ambiguous-target-match'
  const existingResolutionResult = selectedMatch
    ? getExistingTargetResolutionResult(row, selectedMatch, overwriteMode)
    : null

  return existingResolutionResult
    ? existingResolutionResult
    : selectedMatch
      ? {
          candidate: getCandidateRow({
            matchKey: selectedMatch.matchKey,
            matchKind: selectedMatch.matchKind,
            row,
            targetArticle: selectedMatch.targetArticle,
          }),
          detail: getImportRowMatchDetailFromMatch(row, selectedMatch),
          skippedRow: null,
          warnings: [],
        }
      : skipReason
        ? {
            candidate: null,
            detail: getImportRowMatchDetail({
              matchKey: getAmbiguousMatchKey(detailMatches),
              matchKind: getAmbiguousMatchKind(detailMatches),
              sourceRow: row,
              targetArticles: getTargetArticlesFromMatches(detailMatches),
            }),
            skippedRow: getSkippedRow(row.sourceRowId, skipReason),
            warnings:
              skipReason === 'ambiguous-target-match'
                ? [
                    getAmbiguousTargetMatchWarning({
                      matchKey: getAmbiguousMatchKey(eligibleMatches),
                      matchKind: getAmbiguousMatchKind(eligibleMatches),
                      sourceRow: row,
                      targetArticles: getTargetArticlesFromMatches(eligibleMatches),
                    }),
                  ]
                : skipReason === 'conflicting-identifiers'
                  ? [getConflictingIdentifiersWarning({matches: eligibleMatches, sourceRow: row})]
                  : [],
          }
        : null
}

export const getIdentifierImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
) => {
  return sourceIdentifierTierOrder.reduce<ImportCandidateRowResult | null>((result, tier) => {
    return result ?? getIdentifierImportCandidateRowForTier(importMode, overwriteMode, row, targetArticleMaps, tier)
  }, null)
}

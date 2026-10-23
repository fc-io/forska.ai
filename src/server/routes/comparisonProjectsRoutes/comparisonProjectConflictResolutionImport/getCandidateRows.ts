import {sourceIdentifierTierOrder} from './comparisonProjectConflictResolutionImportConstants.ts'
import type {
  ImportCandidateRowResult,
  ImportRowMatchDetail,
  NormalizedIdentifierKey,
  NormalizedSourceRow,
  NormalizedTargetArticle,
  SourceIdentifierTier,
} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportOverwriteMode,
} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getArticleIdImportCandidateRow} from './getCandidateRows/getArticleIdImportCandidateRow.ts'
import {getCovidenceIdTitleImportCandidateRow} from './getCandidateRows/getCovidenceIdTitleImportCandidateRow.ts'
import {getIdentifierImportCandidateRow} from './getCandidateRows/getIdentifierImportCandidateRow.ts'
import {getIdTitleImportCandidateRow} from './getCandidateRows/getIdTitleImportCandidateRow.ts'
import {getTargetArticleMaps} from './getCandidateRows/getTargetArticleMaps.ts'
import {getTitleImportCandidateRow} from './getCandidateRows/getTitleImportCandidateRow.ts'
import {getSkippedRow} from './getSkippedRow.ts'

const getFirstIdentifierKeyForTier = (row: NormalizedSourceRow, tier: SourceIdentifierTier) => {
  return row.identifierKeys.find((identifierKey) => {
    return identifierKey.tier === tier
  })
}

const getPreferredSourceRowMatchDetail = (row: NormalizedSourceRow): ImportRowMatchDetail => {
  const identifierKey =
    sourceIdentifierTierOrder.reduce<NormalizedIdentifierKey | null>((selectedIdentifierKey, tier) => {
      return selectedIdentifierKey ?? getFirstIdentifierKeyForTier(row, tier) ?? null
    }, null) ?? row.identifierKeys[0]

  return identifierKey
    ? {matchKey: identifierKey.matchKey, matchKind: identifierKey.kind, sourceRow: row, targetArticles: []}
    : row.idTitleKey
      ? {matchKey: row.idTitleKey, matchKind: 'id-title', sourceRow: row, targetArticles: []}
      : row.covidenceIdTitleKey
        ? {matchKey: row.covidenceIdTitleKey, matchKind: 'covidence-id-title', sourceRow: row, targetArticles: []}
        : row.titleKey
          ? {matchKey: row.titleKey, matchKind: 'title', sourceRow: row, targetArticles: []}
          : {matchKey: null, matchKind: null, sourceRow: row, targetArticles: []}
}

const getCanUseFallbackResultAfterResult = (
  previousResult: ImportCandidateRowResult | null,
  fallbackResult: ImportCandidateRowResult | null,
) => {
  return previousResult?.skippedRow?.reason === 'no-target-match' && fallbackResult !== null
}

const getNoTargetMatchImportCandidateRow = (row: NormalizedSourceRow): ImportCandidateRowResult => {
  return {
    candidate: null,
    detail: getPreferredSourceRowMatchDetail(row),
    skippedRow: getSkippedRow(row.sourceRowId, 'no-target-match'),
    warnings: [],
  }
}

const getImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult => {
  const hasUsableKey =
    row.identifierKeys.length > 0
    || Boolean(row.idTitleKey)
    || Boolean(row.covidenceIdTitleKey)
    || Boolean(row.titleKey)
  const articleIdResult = getArticleIdImportCandidateRow(importMode, overwriteMode, row, targetArticleMaps)
  const identifierResult =
    row.identifierKeys.length > 0
      ? getIdentifierImportCandidateRow(importMode, overwriteMode, row, targetArticleMaps)
      : null
  const idTitleResult = row.idTitleKey
    ? getIdTitleImportCandidateRow(importMode, overwriteMode, row, targetArticleMaps)
    : null
  const covidenceIdTitleResult = row.covidenceIdTitleKey
    ? getCovidenceIdTitleImportCandidateRow(importMode, overwriteMode, row, targetArticleMaps)
    : null
  const titleResult = row.titleKey
    ? getTitleImportCandidateRow(importMode, overwriteMode, row, targetArticleMaps)
    : null

  return row.resolutionValue !== null && row.resolutionMode !== 'summary'
    ? {
        candidate: null,
        detail: getPreferredSourceRowMatchDetail(row),
        skippedRow: getSkippedRow(row.sourceRowId, 'unsupported-mode'),
        warnings: [],
      }
    : articleIdResult
      ? articleIdResult
      : !hasUsableKey
        ? {
            candidate: null,
            detail: getPreferredSourceRowMatchDetail(row),
            skippedRow: getSkippedRow(row.sourceRowId, 'no-usable-key'),
            warnings: [],
          }
        : identifierResult
          ? identifierResult
          : idTitleResult && !getCanUseFallbackResultAfterResult(idTitleResult, covidenceIdTitleResult ?? titleResult)
            ? idTitleResult
            : covidenceIdTitleResult && !getCanUseFallbackResultAfterResult(covidenceIdTitleResult, titleResult)
              ? covidenceIdTitleResult
              : titleResult
                ? titleResult
                : getNoTargetMatchImportCandidateRow(row)
}

export const getCandidateRows = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
  sourceRows: readonly NormalizedSourceRow[],
  targetArticles: readonly NormalizedTargetArticle[],
) => {
  const targetArticleMaps = getTargetArticleMaps(targetArticles)

  return sourceRows.map((row) => {
    return getImportCandidateRow(importMode, overwriteMode, row, targetArticleMaps)
  })
}

import type {ComparisonProjectConflictResolutionImportAnalyzeResult} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportAnalyzeTypes.ts'
import type {ComparisonProjectConflictResolutionImportMode} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'
import {
  getParsedPdfConflictResolutionImportArticleCount,
  type ParsedPdfConflictResolutionImport,
} from './comparisonProjectConflictResolutionPdfImport.ts'
import type {
  AppQueryRunner,
  ComparisonProjectConflictResolutionPdfUndecidedMode,
} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getPdfUndecidedImportAnalysis} from './getPdfUndecidedImportAnalysis.ts'

const getPdfUndecidedAnalyzeRow = (
  row: ComparisonProjectConflictResolutionImportAnalyzeResult['importableRows'][number],
) => {
  return {...row, selectedResolution: 'Undecided'}
}

const addPdfUndecidedAnalyzeSummary = (
  left: ComparisonProjectConflictResolutionImportAnalyzeResult['summary'],
  right: ComparisonProjectConflictResolutionImportAnalyzeResult['summary'],
) => {
  return {
    scanned: left.scanned + right.scanned,
    matched: left.matched + right.matched,
    importable: left.importable + right.importable,
    deduped: left.deduped + right.deduped,
    skipped: left.skipped + right.skipped,
    skippedExisting: left.skippedExisting + right.skippedExisting,
    skippedUnsupportedMode: left.skippedUnsupportedMode + right.skippedUnsupportedMode,
    skippedNoUsableKey: left.skippedNoUsableKey + right.skippedNoUsableKey,
    skippedNoTargetMatch: left.skippedNoTargetMatch + right.skippedNoTargetMatch,
    skippedNotConflicting: left.skippedNotConflicting + right.skippedNotConflicting,
    skippedAmbiguousTarget: left.skippedAmbiguousTarget + right.skippedAmbiguousTarget,
    skippedConflicting: left.skippedConflicting + right.skippedConflicting,
    skippedInvalidValue: left.skippedInvalidValue + right.skippedInvalidValue,
    sameValue: left.sameValue + right.sameValue,
    overwriteCandidates: left.overwriteCandidates + right.overwriteCandidates,
    commentsAdded: left.commentsAdded + right.commentsAdded,
    commentsKept: left.commentsKept + right.commentsKept,
    commentsReplaced: left.commentsReplaced + right.commentsReplaced,
  }
}

export const getPdfImportAnalyzeResult = async (params: {
  analyzeResult: ComparisonProjectConflictResolutionImportAnalyzeResult
  importMode: ComparisonProjectConflictResolutionImportMode
  parsedImport: ParsedPdfConflictResolutionImport
  pdfUndecidedMode: ComparisonProjectConflictResolutionPdfUndecidedMode
  pdfWarnings: string[]
  reviewer: {displayName: string | null; instanceId: string | null}
  scope: ComparisonProjectScope
  tx: AppQueryRunner
}) => {
  const source = {
    ...params.analyzeResult.source,
    importKind: 'pdf' as const,
    pdfUndecidedMode: params.pdfUndecidedMode,
    pdfUndecidedRowCount: params.parsedImport.undecidedRows.length,
    pdfWarnings: params.pdfWarnings,
    reviewer: params.reviewer,
    rowCount: getParsedPdfConflictResolutionImportArticleCount(params.parsedImport),
  }

  if (params.pdfUndecidedMode === 'ignore' || params.parsedImport.undecidedRows.length === 0) {
    return {...params.analyzeResult, source}
  }

  const undecidedAnalysis = await getPdfUndecidedImportAnalysis({
    importMode: params.importMode,
    parsedImport: params.parsedImport,
    scope: params.scope,
    tx: params.tx,
  })

  return {
    ...params.analyzeResult,
    source,
    summary: addPdfUndecidedAnalyzeSummary(params.analyzeResult.summary, undecidedAnalysis.analyzeResult.summary),
    importableRows: [
      ...params.analyzeResult.importableRows,
      ...undecidedAnalysis.analyzeResult.importableRows.map(getPdfUndecidedAnalyzeRow),
    ],
    skippedRows: [
      ...params.analyzeResult.skippedRows,
      ...undecidedAnalysis.analyzeResult.skippedRows.map(getPdfUndecidedAnalyzeRow),
    ],
    warnings: [...params.analyzeResult.warnings, ...undecidedAnalysis.analyzeResult.warnings],
  }
}

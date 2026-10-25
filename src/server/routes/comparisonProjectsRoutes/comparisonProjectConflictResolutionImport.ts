import type {ComparisonProjectConflictResolutionTransferArtifact} from './comparisonProjectConflictResolutionFileTransfer.ts'
import {
  getConflictingAnalyzeSkippedRows,
  getInitialAnalyzeSkippedRows,
  getInvalidValueAnalyzeSkippedRows,
} from './comparisonProjectConflictResolutionImport/analyzeSkippedRows.ts'
import type {
  ComparisonProjectConflictResolutionImportAnalyzeResult,
  ComparisonProjectConflictResolutionImportCommitResult,
} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportAnalyzeTypes.ts'
import type {ImportCandidateRow} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportCommentChange,
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportOverwriteMode,
  ComparisonProjectConflictResolutionImportPlan,
  ComparisonProjectConflictResolutionImportPlanParams,
  ComparisonProjectConflictResolutionImportSkippedRow,
  ComparisonProjectConflictResolutionImportSourceRow,
  ComparisonProjectConflictResolutionImportTargetArticle,
} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'
import {getAnalyzeRowFromCandidateRow} from './comparisonProjectConflictResolutionImport/getAnalyzeRow.ts'
import {getAnalyzeSource} from './comparisonProjectConflictResolutionImport/getAnalyzeSource.ts'
import {getAnalyzeSummary} from './comparisonProjectConflictResolutionImport/getAnalyzeSummary.ts'
import {getCandidateRows} from './comparisonProjectConflictResolutionImport/getCandidateRows.ts'
import {getCandidateRowsForCandidates} from './comparisonProjectConflictResolutionImport/getCandidateRowsForCandidates.ts'
import {getCommentChangeBySourceRowId} from './comparisonProjectConflictResolutionImport/getCommentChangeBySourceRowId.ts'
import {getCommentSources} from './comparisonProjectConflictResolutionImport/getCommentSources.ts'
import {getDedupedCount} from './comparisonProjectConflictResolutionImport/getDedupedCount.ts'
import {getGroupedImportCandidates} from './comparisonProjectConflictResolutionImport/getGroupedImportCandidates.ts'
import {getNormalizedSourceRows} from './comparisonProjectConflictResolutionImport/getNormalizedSourceRows.ts'
import {getNormalizedTargetArticles} from './comparisonProjectConflictResolutionImport/getNormalizedTargetArticles.ts'
import {getSkipCounts} from './comparisonProjectConflictResolutionImport/getSkipCounts.ts'
import {getTargetResolvedCandidateRows} from './comparisonProjectConflictResolutionImport/getTargetResolvedCandidateRows.ts'

const getComparisonProjectConflictResolutionImportPlanState = ({
  importMode = 'conflicting-only',
  overwriteMode = 'skip-existing',
  sourceRows,
  targetArticles,
  targetSummaryOptionValues,
}: ComparisonProjectConflictResolutionImportPlanParams) => {
  const normalizedSourceRows = getNormalizedSourceRows(sourceRows)
  const normalizedTargetArticles = getNormalizedTargetArticles(targetArticles)
  const candidateRowResults = getCandidateRows(
    importMode,
    overwriteMode,
    normalizedSourceRows,
    normalizedTargetArticles,
  )
  const candidateRows = candidateRowResults
    .map((result) => {
      return result.candidate
    })
    .filter((candidate): candidate is ImportCandidateRow => {
      return candidate !== null
    })
  const skippedRows = candidateRowResults
    .map((result) => {
      return result.skippedRow
    })
    .filter((skippedRow): skippedRow is ComparisonProjectConflictResolutionImportSkippedRow => {
      return skippedRow !== null
    })
  const warnings = candidateRowResults.flatMap((result) => {
    return result.warnings
  })
  const targetResolvedCandidateRowResults = getTargetResolvedCandidateRows(candidateRows, targetSummaryOptionValues)
  const groupedImportCandidateResults = getGroupedImportCandidates(targetResolvedCandidateRowResults.candidateRows)
  const allSkippedRows = [
    ...skippedRows,
    ...targetResolvedCandidateRowResults.skippedRows,
    ...groupedImportCandidateResults.skippedRows,
  ]
  const allWarnings = [
    ...warnings,
    ...targetResolvedCandidateRowResults.warnings,
    ...groupedImportCandidateResults.warnings,
  ]

  return {
    allSkippedRows,
    allWarnings,
    candidateRowResults,
    candidateRows,
    groupedImportCandidateResults,
    normalizedSourceRows,
    normalizedTargetArticles,
    targetResolvedCandidateRowResults,
  }
}

export const getComparisonProjectConflictResolutionImportPlan = (
  params: ComparisonProjectConflictResolutionImportPlanParams,
): ComparisonProjectConflictResolutionImportPlan => {
  const planState = getComparisonProjectConflictResolutionImportPlanState(params)

  return {
    candidates: planState.groupedImportCandidateResults.candidates,
    commentSources: getCommentSources(planState.candidateRowResults),
    dedupedCount: getDedupedCount(planState.groupedImportCandidateResults.candidates),
    errors: [],
    skipCounts: getSkipCounts(planState.allSkippedRows),
    skippedRows: planState.allSkippedRows,
    warnings: planState.allWarnings,
  }
}

export const getComparisonProjectConflictResolutionImportAnalyzeResult = (params: {
  artifact: ComparisonProjectConflictResolutionTransferArtifact
  commentChanges?: readonly ComparisonProjectConflictResolutionImportCommentChange[]
  importMode?: ComparisonProjectConflictResolutionImportMode
  overwriteMode?: ComparisonProjectConflictResolutionImportOverwriteMode
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  targetArticles: readonly ComparisonProjectConflictResolutionImportTargetArticle[]
  targetSummaryOptionValues: readonly string[]
}): ComparisonProjectConflictResolutionImportAnalyzeResult => {
  const planState = getComparisonProjectConflictResolutionImportPlanState({
    importMode: params.importMode,
    overwriteMode: params.overwriteMode,
    sourceRows: params.sourceRows,
    targetArticles: params.targetArticles,
    targetSummaryOptionValues: params.targetSummaryOptionValues,
  })
  const plan = getComparisonProjectConflictResolutionImportPlan({
    importMode: params.importMode,
    overwriteMode: params.overwriteMode,
    sourceRows: params.sourceRows,
    targetArticles: params.targetArticles,
    targetSummaryOptionValues: params.targetSummaryOptionValues,
  })
  const commentChanges = params.commentChanges ?? []
  const commentChangeBySourceRowId = getCommentChangeBySourceRowId(commentChanges)
  const importableCandidateRows = getCandidateRowsForCandidates({
    candidates: plan.candidates,
    candidateRows: planState.targetResolvedCandidateRowResults.candidateRows,
  })
  const skippedRows = [
    ...getInitialAnalyzeSkippedRows(planState.candidateRowResults, commentChangeBySourceRowId),
    ...getInvalidValueAnalyzeSkippedRows(
      planState.candidateRows,
      planState.targetResolvedCandidateRowResults.skippedRows,
      commentChangeBySourceRowId,
    ),
    ...getConflictingAnalyzeSkippedRows(
      planState.targetResolvedCandidateRowResults.candidateRows,
      planState.groupedImportCandidateResults.skippedRows,
      commentChangeBySourceRowId,
    ),
  ]

  return {
    source: getAnalyzeSource(params.artifact),
    summary: {
      ...getAnalyzeSummary({
        commentChanges,
        importableCount: plan.candidates.length,
        plan,
        scannedCount: params.sourceRows.length,
      }),
      overwriteCandidates: importableCandidateRows.filter((candidateRow) => {
        return candidateRow.isOverwrite
      }).length,
    },
    importableRows: importableCandidateRows.map((candidateRow) => {
      return getAnalyzeRowFromCandidateRow(candidateRow, commentChangeBySourceRowId)
    }),
    skippedRows,
    warnings: plan.warnings,
  }
}

export const getComparisonProjectConflictResolutionImportCommitResult = (params: {
  analyzeResult: ComparisonProjectConflictResolutionImportAnalyzeResult
  cleared?: number
  inserted: number
}): ComparisonProjectConflictResolutionImportCommitResult => {
  return {
    ...params.analyzeResult,
    summary: {...params.analyzeResult.summary, cleared: params.cleared ?? 0, inserted: params.inserted},
  }
}

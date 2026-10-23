import {
  type ComparisonProjectConflictResolutionImportMode,
  getComparisonProjectConflictResolutionImportAnalyzeResult,
  getComparisonProjectConflictResolutionImportPlan,
  getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact,
} from './comparisonProjectConflictResolutionImport.ts'
import {
  getComparisonProjectConflictResolutionTransferArtifactFromPdfImport,
  type ParsedPdfConflictResolutionImport,
  pdfConflictResolutionNotSetValue,
} from './comparisonProjectConflictResolutionPdfImport.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getConflictResolutionImportTargetArticles} from './getConflictResolutionImportTargetArticles.ts'

const getPdfUndecidedTransferArtifact = (parsedImport: ParsedPdfConflictResolutionImport) => {
  return getComparisonProjectConflictResolutionTransferArtifactFromPdfImport({
    parsedImport: {
      ...parsedImport,
      commentOnlyRows: [],
      rows: parsedImport.undecidedRows.map((row) => {
        return {...row, comment: null}
      }),
    },
  })
}

export const getPdfUndecidedImportAnalysis = async (params: {
  importMode: ComparisonProjectConflictResolutionImportMode
  parsedImport: ParsedPdfConflictResolutionImport
  scope: ComparisonProjectScope
  tx: AppQueryRunner
}) => {
  const artifact = getPdfUndecidedTransferArtifact(params.parsedImport)
  const sourceRows = getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact(artifact)
  const targetArticles = await getConflictResolutionImportTargetArticles({
    sourceRows,
    scope: params.scope,
    tx: params.tx,
  })
  const plan = getComparisonProjectConflictResolutionImportPlan({
    importMode: params.importMode,
    overwriteMode: 'overwrite-different',
    sourceRows,
    targetArticles,
    targetSummaryOptionValues: [pdfConflictResolutionNotSetValue],
  })
  const analyzeResult = getComparisonProjectConflictResolutionImportAnalyzeResult({
    artifact,
    importMode: params.importMode,
    overwriteMode: 'overwrite-different',
    sourceRows,
    targetArticles,
    targetSummaryOptionValues: [pdfConflictResolutionNotSetValue],
  })

  return {analyzeResult, plan}
}

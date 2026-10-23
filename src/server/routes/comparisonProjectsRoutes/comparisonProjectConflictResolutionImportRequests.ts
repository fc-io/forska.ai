import {validateComparisonProjectConflictResolutionTransferArtifact} from './comparisonProjectConflictResolutionFileTransfer.ts'
import {
  getConflictResolutionImportRejectedError,
  getValidatedConflictResolutionImportMode,
  getValidatedConflictResolutionImportOverwriteMode,
} from './comparisonProjectConflictResolutionImportValidation.ts'
import {
  getComparisonProjectConflictResolutionTransferArtifactFromPdfImport,
  type ParsedPdfConflictResolutionImport,
  parsePdfConflictResolutionImport,
} from './comparisonProjectConflictResolutionPdfImport.ts'
import type {ComparisonProjectConflictResolutionPdfUndecidedMode} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

const getValidatedComparisonProjectConflictResolutionImportArtifact = (body: unknown) => {
  try {
    return validateComparisonProjectConflictResolutionTransferArtifact(body)
  } catch (error) {
    throw getConflictResolutionImportRejectedError(error instanceof Error ? error.message : 'Invalid import artifact')
  }
}

export const getComparisonProjectConflictResolutionArtifactImportRequest = (body: unknown) => {
  const bodyRecord = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  const artifact = bodyRecord && 'artifact' in bodyRecord ? bodyRecord.artifact : body
  const importMode = bodyRecord ? getValidatedConflictResolutionImportMode(bodyRecord.importMode) : 'conflicting-only'
  const overwriteMode = bodyRecord
    ? getValidatedConflictResolutionImportOverwriteMode(bodyRecord.overwriteMode)
    : 'skip-existing'

  return {artifact: getValidatedComparisonProjectConflictResolutionImportArtifact(artifact), importMode, overwriteMode}
}

type ComparisonProjectConflictResolutionArtifactImportRequest = ReturnType<
  typeof getComparisonProjectConflictResolutionArtifactImportRequest
>

export type ComparisonProjectConflictResolutionPdfImportBody = {
  file: File
  importMode?: unknown
  overwriteMode?: unknown
  pdfUndecidedMode?: unknown
}

const getValidatedPdfUndecidedMode = (value: unknown): ComparisonProjectConflictResolutionPdfUndecidedMode => {
  if (value === undefined || value === null || value === '') {
    return 'ignore'
  }

  if (value === 'ignore' || value === 'clear') {
    return value
  }

  throw getConflictResolutionImportRejectedError('PDF undecided import mode is invalid')
}

export const getComparisonProjectConflictResolutionPdfImportRequest = async (
  scope: ComparisonProjectScope,
  body: ComparisonProjectConflictResolutionPdfImportBody,
): Promise<
  ComparisonProjectConflictResolutionArtifactImportRequest & {
    parsedImport: ParsedPdfConflictResolutionImport
    pdfUndecidedMode: ComparisonProjectConflictResolutionPdfUndecidedMode
    pdfWarnings: string[]
    reviewer: {displayName: string | null; instanceId: string | null}
  }
> => {
  let parsedImport: ReturnType<typeof parsePdfConflictResolutionImport>
  let artifact: ReturnType<typeof getComparisonProjectConflictResolutionTransferArtifactFromPdfImport>

  try {
    parsedImport = parsePdfConflictResolutionImport(await body.file.arrayBuffer())
    artifact = getComparisonProjectConflictResolutionTransferArtifactFromPdfImport({
      parsedImport,
      targetComparisonProjectId: scope.id,
    })
  } catch (error) {
    throw getConflictResolutionImportRejectedError(
      error instanceof Error ? error.message : 'Invalid PDF conflict resolution import file',
    )
  }

  return {
    artifact: getValidatedComparisonProjectConflictResolutionImportArtifact(artifact),
    importMode: getValidatedConflictResolutionImportMode(body.importMode),
    overwriteMode: getValidatedConflictResolutionImportOverwriteMode(body.overwriteMode),
    parsedImport,
    pdfUndecidedMode: getValidatedPdfUndecidedMode(body.pdfUndecidedMode),
    pdfWarnings: parsedImport.warnings,
    reviewer: parsedImport.reviewer,
  }
}

export const validateConflictResolutionImportAnalyzeTarget = (scope: ComparisonProjectScope) => {
  if (!scope.allowConflictResolution || !getIsSummaryMode(scope)) {
    throw getConflictResolutionImportRejectedError(
      'Conflict resolution imports require summary mode and allow conflict resolution to be enabled',
    )
  }

  if (scope.activeGeneration === null) {
    throw getConflictResolutionImportRejectedError(
      'Conflict resolution imports require an active comparison serving generation',
    )
  }
}

import type {
  ComparisonProjectConflictResolutionTransferArtifact,
  ComparisonProjectConflictResolutionTransferRowV3,
} from '../comparisonProjectConflictResolutionFileTransfer.ts'
import {
  getImportedComparisonProjectConflictResolutionComment,
  getImportedReviewerDisplayName,
} from '../comparisonProjectConflictResolutionProvenance.ts'
import type {
  ComparisonProjectConflictResolutionImportSourceProvenance,
  ComparisonProjectConflictResolutionImportSourceRow,
} from './comparisonProjectConflictResolutionImportTypes.ts'

const comparisonProjectConflictResolutionImportContextIdPattern = /^[0-9a-f]{64}$/

const getComparisonProjectConflictResolutionImportContextId = (value: string | null | undefined) => {
  const contextId = value?.trim() ?? ''

  return comparisonProjectConflictResolutionImportContextIdPattern.test(contextId) ? contextId : null
}

const getComparisonProjectConflictResolutionImportTransferRowProvenance = (
  row: ComparisonProjectConflictResolutionTransferRowV3,
): ComparisonProjectConflictResolutionImportSourceProvenance | null => {
  return row.provenance
    ? {
        judgmentContextId: getComparisonProjectConflictResolutionImportContextId(row.provenance.contextId),
        reviewerDisplayName: getImportedReviewerDisplayName(row.provenance.reviewerDisplayName),
        reviewerUserId: null,
      }
    : null
}

export const getComparisonProjectConflictResolutionImportSourceRowsFromTransferRows = (params: {
  rows: readonly ComparisonProjectConflictResolutionTransferRowV3[]
  sourceComparisonProjectId: string
  sourceComparisonProjectName: string
}): ComparisonProjectConflictResolutionImportSourceRow[] => {
  return params.rows.map((row, rowIndex) => {
    const generatedSourceRowId = `${params.sourceComparisonProjectId}:transfer-row-${String(rowIndex + 1).padStart(6, '0')}`
    const sourceArticleId = row.sourceArticleRowId ?? `${generatedSourceRowId}:article`
    const sourceResolutionId =
      row.sourceResolutionId ?? `${generatedSourceRowId}:${row.resolution ? 'resolution' : 'comment'}`

    return {
      arxivId: row.arxivId ?? null,
      doi: row.doi ?? null,
      externalArticleId: row.externalArticleId,
      identifiers: row.identifiers.map((identifier) => {
        return {kind: identifier.kind, normalizedValue: identifier.normalizedValue}
      }),
      pubmedId: row.pubmedId ?? null,
      resolutionMode: row.resolution?.mode ?? null,
      resolutionValue: row.resolution?.value ?? null,
      sourceArticleId,
      sourceArticleTitle: row.title,
      ...(row.comment === undefined
        ? {}
        : {sourceComment: getImportedComparisonProjectConflictResolutionComment(row.comment)}),
      sourceComparisonProjectId: params.sourceComparisonProjectId,
      sourceComparisonProjectName: params.sourceComparisonProjectName,
      sourceExternalArticleId: row.externalArticleId,
      ...(row.resolution && row.provenance
        ? {sourceProvenance: getComparisonProjectConflictResolutionImportTransferRowProvenance(row)}
        : {}),
      sourceResolutionId,
      sourceRowId: sourceResolutionId,
      title: row.title,
    }
  })
}

export const getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact = (
  artifact: ComparisonProjectConflictResolutionTransferArtifact,
): ComparisonProjectConflictResolutionImportSourceRow[] => {
  return getComparisonProjectConflictResolutionImportSourceRowsFromTransferRows({
    rows: artifact.rows,
    sourceComparisonProjectId: artifact.source.comparisonProjectId,
    sourceComparisonProjectName: artifact.source.comparisonProjectName,
  })
}

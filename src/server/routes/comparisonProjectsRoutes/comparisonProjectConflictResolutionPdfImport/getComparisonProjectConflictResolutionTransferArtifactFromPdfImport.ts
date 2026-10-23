import {
  type ComparisonProjectConflictResolutionTransferArtifact,
  type ComparisonProjectConflictResolutionTransferRowV3,
  createComparisonProjectConflictResolutionTransferArtifact,
} from '../comparisonProjectConflictResolutionFileTransfer.ts'
import type {
  ParsedPdfConflictResolutionImport,
  ParsedPdfConflictResolutionImportArticle,
} from './parsedPdfConflictResolutionImport.ts'

const getResolutionLabel = (value: string) => {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const getPdfTransferRowBase = (
  row: ParsedPdfConflictResolutionImportArticle,
  sourceArticleRowId: string,
  sourceResolutionId: string,
) => {
  return {
    sourceResolutionId,
    sourceArticleRowId,
    externalArticleId: row.externalArticleId,
    title: row.title,
    identifiers: row.identifiers,
  }
}

const getPdfSourceArticleRowId = (row: ParsedPdfConflictResolutionImportArticle, fallback: string) => {
  return row.sourceArticleRowId ?? row.canonicalArticleId ?? fallback
}

export const getComparisonProjectConflictResolutionTransferArtifactFromPdfImport = (
  params:
    | ParsedPdfConflictResolutionImport
    | {
        parsedImport: ParsedPdfConflictResolutionImport
        sourceComparisonProjectDescription?: string | null
        targetComparisonProjectId?: string
      },
): ComparisonProjectConflictResolutionTransferArtifact => {
  const parsedImport = 'parsedImport' in params ? params.parsedImport : params
  const targetComparisonProjectId = 'parsedImport' in params ? params.targetComparisonProjectId : undefined
  const sourceComparisonProjectId = parsedImport.source.comparisonProjectId ?? 'pdf-conflict-resolution-import'
  const sourceComparisonProjectName = parsedImport.source.comparisonProjectName ?? 'PDF conflict-resolution import'
  const resolutionMode = parsedImport.source.humanJudgmentMode ?? 'summary'
  const hasHiddenRowMetadata = [...parsedImport.rows, ...parsedImport.commentOnlyRows].some((row) => {
    return Boolean(row.externalArticleId || row.title || row.identifiers.length > 0)
  })

  if (!hasHiddenRowMetadata && targetComparisonProjectId && sourceComparisonProjectId !== targetComparisonProjectId) {
    throw new Error('PDF has no hidden row metadata, so it can only be imported into the same comparison project.')
  }

  const resolutionRows: ComparisonProjectConflictResolutionTransferRowV3[] = parsedImport.rows.map((row, rowIndex) => {
    const sourceArticleRowId = getPdfSourceArticleRowId(row, `${sourceComparisonProjectId}:pdf-row-${rowIndex + 1}`)

    return {
      ...getPdfTransferRowBase(
        row,
        sourceArticleRowId,
        `${sourceComparisonProjectId}:${sourceArticleRowId}:pdf-resolution`,
      ),
      resolution: {mode: resolutionMode, value: row.resolutionValue, label: getResolutionLabel(row.resolutionValue)},
      comment: row.comment,
    }
  })
  const commentOnlyRows: ComparisonProjectConflictResolutionTransferRowV3[] = parsedImport.commentOnlyRows.map(
    (row, rowIndex) => {
      const sourceArticleRowId = getPdfSourceArticleRowId(
        row,
        `${sourceComparisonProjectId}:pdf-comment-row-${rowIndex + 1}`,
      )

      return {
        ...getPdfTransferRowBase(
          row,
          sourceArticleRowId,
          `${sourceComparisonProjectId}:${sourceArticleRowId}:pdf-comment`,
        ),
        resolution: null,
        comment: row.comment,
      }
    },
  )

  return createComparisonProjectConflictResolutionTransferArtifact({
    exportedAt: parsedImport.source.exportedAt ?? new Date().toISOString(),
    source: {
      comparisonProjectId: sourceComparisonProjectId,
      comparisonProjectName: sourceComparisonProjectName,
      comparisonProjectDescription:
        'parsedImport' in params && Object.prototype.hasOwnProperty.call(params, 'sourceComparisonProjectDescription')
          ? (params.sourceComparisonProjectDescription ?? null)
          : parsedImport.reviewer.displayName
            ? `PDF import reviewer: ${parsedImport.reviewer.displayName}`
            : null,
    },
    rows: [...resolutionRows, ...commentOnlyRows],
  })
}

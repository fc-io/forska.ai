import {getPdfFormFields} from './comparisonProjectConflictResolutionPdfImport/getPdfFormFields.ts'
import {getPdfImportArticle} from './comparisonProjectConflictResolutionPdfImport/getPdfImportArticle.ts'
import {
  type ParsedPdfConflictResolutionImport,
  pdfConflictResolutionNotSetValue,
} from './comparisonProjectConflictResolutionPdfImport/parsedPdfConflictResolutionImport.ts'
import {
  articleMetadataFieldPattern,
  getFilledPdfResolutionFields,
  getPdfFieldProjectWarnings,
  getPdfUnresolvedValueWarnings,
  getTouchedPdfCommentFields,
  isMalformedComparisonFieldName,
} from './comparisonProjectConflictResolutionPdfImport/pdfImportFields.ts'
import {
  getArticleMetadata,
  getDecodedJsonMetadata,
  getJudgmentContextIdMetadata,
  getMetadataBoolean,
  getMetadataNumber,
  getMetadataString,
  getResolutionMode,
  getTrimmedValue,
} from './comparisonProjectConflictResolutionPdfImport/pdfImportMetadata.ts'

export {getComparisonProjectConflictResolutionTransferArtifactFromPdfImport} from './comparisonProjectConflictResolutionPdfImport/getComparisonProjectConflictResolutionTransferArtifactFromPdfImport.ts'
export type {ParsedPdfConflictResolutionImport} from './comparisonProjectConflictResolutionPdfImport/parsedPdfConflictResolutionImport.ts'
export {pdfConflictResolutionNotSetValue} from './comparisonProjectConflictResolutionPdfImport/parsedPdfConflictResolutionImport.ts'

const supportedPdfImportFormat = 'forska.comparisonProject.pdfConflictResolutionImport'

const getPdfText = (input: Buffer | Uint8Array | ArrayBuffer | string) => {
  if (typeof input === 'string') {
    return input
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(input).toString('latin1')
  }

  return Buffer.from(input).toString('latin1')
}

export const parsePdfConflictResolutionImport = (
  input: Buffer | Uint8Array | ArrayBuffer | string,
): ParsedPdfConflictResolutionImport => {
  const source = getPdfText(input)
  const fields = getPdfFormFields(source)

  if (fields.length === 0) {
    throw new Error('The selected PDF has no fillable form fields. It may have been flattened or printed.')
  }

  const fieldMap = new Map(
    fields.map((field) => {
      return [field.name, field.value] as const
    }),
  )
  const formatMetadata = getDecodedJsonMetadata<Record<string, unknown>>(fieldMap.get('forska.import.format'))
  const projectMetadata = getDecodedJsonMetadata<Record<string, unknown>>(
    fieldMap.get('forska.import.comparisonProject'),
  )
  const metadataByArticleId = new Map<string, Record<string, unknown>>()
  const warnings: string[] = []

  fields.forEach((field) => {
    if (isMalformedComparisonFieldName(field.name)) {
      throw new Error(`Malformed PDF comparison field name: ${field.name}`)
    }

    const match = articleMetadataFieldPattern.exec(field.name)

    if (!match) {
      return
    }

    const decodedMetadata = getDecodedJsonMetadata<Record<string, unknown>>(field.value)

    if (decodedMetadata) {
      metadataByArticleId.set(match[2] ?? '', decodedMetadata)
    } else {
      warnings.push(`Ignored unreadable article metadata field: ${field.name}`)
    }
  })

  const commentFields = getTouchedPdfCommentFields(fields, metadataByArticleId)
  const touchedCommentByArticleId = new Map(
    commentFields.map((commentField) => {
      return [commentField.articleId, commentField.comment] as const
    }),
  )
  const resolutionFields = getFilledPdfResolutionFields(fields)
  const decidedResolutionFields = resolutionFields.filter((field) => {
    return field.resolutionValue !== pdfConflictResolutionNotSetValue
  })
  const decidedArticleIds = new Set(
    decidedResolutionFields.map((field) => {
      return field.articleId
    }),
  )
  const rows = decidedResolutionFields.map((field) => {
    return {
      ...getPdfImportArticle(
        field.fieldName,
        field.articleId,
        getArticleMetadata(metadataByArticleId, field.articleId),
      ),
      resolutionValue: field.resolutionValue,
      comment: touchedCommentByArticleId.get(field.articleId) ?? null,
    }
  })
  const undecidedRows = resolutionFields
    .filter((field) => {
      return field.resolutionValue === pdfConflictResolutionNotSetValue
    })
    .map((field): ParsedPdfConflictResolutionImport['undecidedRows'][number] => {
      return {
        ...getPdfImportArticle(
          field.fieldName,
          field.articleId,
          getArticleMetadata(metadataByArticleId, field.articleId),
        ),
        resolutionValue: pdfConflictResolutionNotSetValue,
      }
    })
  const commentOnlyFields = commentFields.filter((commentField) => {
    return !decidedArticleIds.has(commentField.articleId)
  })
  const commentOnlyRows = commentOnlyFields.map((commentField) => {
    return {
      ...getPdfImportArticle(
        commentField.fieldName,
        commentField.articleId,
        getArticleMetadata(metadataByArticleId, commentField.articleId),
      ),
      resolutionValue: null,
      comment: commentField.comment,
    }
  })
  const fieldProjectIds = new Set(
    [...resolutionFields, ...commentFields].map((field) => {
      return field.projectId
    }),
  )

  warnings.push(
    ...getPdfUnresolvedValueWarnings(fields),
    ...getPdfFieldProjectWarnings(resolutionFields, 'Resolution', projectMetadata),
    ...getPdfFieldProjectWarnings(commentFields, 'Comment', projectMetadata),
  )

  if (rows.length === 0 && undecidedRows.length === 0 && commentOnlyRows.length === 0) {
    throw new Error(
      [
        'The selected PDF has no filled conflict-resolution radio fields and no changed comments.',
        ...getPdfUnresolvedValueWarnings(fields),
      ].join(' '),
    )
  }

  if (!formatMetadata) {
    warnings.push('The selected PDF has no Forska import metadata; same-project article-id matching only is available.')
  } else if (getMetadataString(formatMetadata, 'format') !== supportedPdfImportFormat) {
    warnings.push('The selected PDF has an unrecognized Forska import metadata format.')
  }

  if (getMetadataBoolean(projectMetadata, 'allowConflictResolution') === false) {
    warnings.push('The selected PDF was exported from a project that did not allow conflict resolution.')
  }

  return {
    source: {
      comparisonProjectId:
        getMetadataString(projectMetadata, 'comparisonProjectId')
        ?? (fieldProjectIds.size === 1 ? (Array.from(fieldProjectIds)[0] ?? null) : null),
      comparisonProjectName: getMetadataString(projectMetadata, 'comparisonProjectName'),
      exportedAt: getMetadataString(projectMetadata, 'exportedAt'),
      formatVersion: getMetadataNumber(formatMetadata, 'version'),
      humanJudgmentMode: projectMetadata ? getResolutionMode(projectMetadata) : null,
      judgmentContextId: getJudgmentContextIdMetadata(projectMetadata),
    },
    reviewer: {displayName: getTrimmedValue(fieldMap.get('forska.reviewer.displayName')), instanceId: null},
    rows,
    undecidedRows,
    commentOnlyRows,
    warnings,
  }
}

export const getParsedPdfConflictResolutionImportArticleCount = (parsedImport: ParsedPdfConflictResolutionImport) => {
  return new Set(
    [...parsedImport.rows, ...parsedImport.undecidedRows, ...parsedImport.commentOnlyRows].map((row) => {
      return row.fieldName.replace(/\.(?:comment|resolution)$/, '')
    }),
  ).size
}

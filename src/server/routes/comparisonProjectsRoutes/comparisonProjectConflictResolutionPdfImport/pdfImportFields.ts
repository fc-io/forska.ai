import {getImportedComparisonProjectConflictResolutionComment} from '../comparisonProjectConflictResolutionProvenance.ts'
import type {PdfFormField} from './getPdfFormFields.ts'
import {getArticleMetadata, getMetadataString, getTrimmedValue} from './pdfImportMetadata.ts'
import {getLineFeedText} from './pdfTextDecoding.ts'

const conflictResolutionFieldPattern = /^comparison\.([^.]+)\.article\.([^.]+)\.resolution$/
const conflictCommentFieldPattern = /^comparison\.([^.]+)\.article\.([^.]+)\.comment$/
export const articleMetadataFieldPattern = /^comparison\.([^.]+)\.article\.([^.]+)\.metadata$/

export const isMalformedComparisonFieldName = (fieldName: string) => {
  return (
    fieldName.startsWith('comparison.')
    && !conflictResolutionFieldPattern.test(fieldName)
    && !conflictCommentFieldPattern.test(fieldName)
    && !articleMetadataFieldPattern.test(fieldName)
  )
}

const getPdfCommentText = (value: unknown) => {
  return typeof value === 'string'
    ? getImportedComparisonProjectConflictResolutionComment(getLineFeedText(value))
    : null
}

const getIsPdfCommentTouched = (comment: string | null, exportedComment: string | null) => {
  return (comment?.normalize('NFC') ?? null) !== (exportedComment?.normalize('NFC') ?? null)
}

const getTouchedPdfComment = (value: string | null, metadata: Record<string, unknown> | null) => {
  const comment = getPdfCommentText(value)

  return getIsPdfCommentTouched(comment, getPdfCommentText(metadata?.exportedComment)) ? comment : null
}

const getIsDifferentFromProjectMetadata = (
  projectId: string | null,
  projectMetadata: Record<string, unknown> | null,
) => {
  return Boolean(
    projectId
    && getMetadataString(projectMetadata, 'comparisonProjectId')
    && projectId !== projectMetadata?.comparisonProjectId,
  )
}

export const getTouchedPdfCommentFields = (
  fields: readonly PdfFormField[],
  metadataByArticleId: ReadonlyMap<string, Record<string, unknown>>,
) => {
  return fields.flatMap((field) => {
    const match = conflictCommentFieldPattern.exec(field.name)
    const articleId = match?.[2] ?? null
    const comment = match ? getTouchedPdfComment(field.value, getArticleMetadata(metadataByArticleId, articleId)) : null

    return match && comment ? [{articleId, comment, fieldName: field.name, projectId: match[1] ?? null}] : []
  })
}

export const getFilledPdfResolutionFields = (fields: readonly PdfFormField[]) => {
  return fields.flatMap((field) => {
    const match = conflictResolutionFieldPattern.exec(field.name)
    const resolutionValue = getTrimmedValue(field.value)

    return match && resolutionValue && resolutionValue !== 'Off'
      ? [{articleId: match[2] ?? null, fieldName: field.name, projectId: match[1] ?? null, resolutionValue}]
      : []
  })
}

export const getPdfUnresolvedValueWarnings = (fields: readonly PdfFormField[]) => {
  return fields
    .filter((field) => {
      return field.hasUnresolvedValueReference && /^(?:comparison|forska)\./.test(field.name)
    })
    .map((field) => {
      return `PDF field ${field.name} has an indirect value that is not a plain string object and was ignored.`
    })
}

export const getPdfFieldProjectWarnings = (
  fields: ReadonlyArray<{fieldName: string; projectId: string | null}>,
  fieldLabel: string,
  projectMetadata: Record<string, unknown> | null,
) => {
  return fields
    .filter((field) => {
      return getIsDifferentFromProjectMetadata(field.projectId, projectMetadata)
    })
    .map((field) => {
      return `${fieldLabel} field ${field.fieldName} did not match the PDF project metadata.`
    })
}

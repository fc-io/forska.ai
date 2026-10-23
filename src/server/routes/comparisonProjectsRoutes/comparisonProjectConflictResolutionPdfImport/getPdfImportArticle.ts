import type {ComparisonProjectConflictResolutionTransferIdentifierV1} from '../comparisonProjectConflictResolutionFileTransfer.ts'
import type {ParsedPdfConflictResolutionImportArticle} from './parsedPdfConflictResolutionImport.ts'
import {getMetadataString} from './pdfImportMetadata.ts'

const getValidIdentifiers = (metadata: Record<string, unknown> | null) => {
  const identifiers = metadata?.identifiers

  if (!Array.isArray(identifiers)) {
    return []
  }

  return identifiers.flatMap((identifier): ComparisonProjectConflictResolutionTransferIdentifierV1[] => {
    if (typeof identifier !== 'object' || identifier === null) {
      return []
    }

    const identifierRecord = identifier as Record<string, unknown>
    const kind = identifierRecord.kind
    const normalizedValue = identifierRecord.normalizedValue
    const source = identifierRecord.source
    const sourceIdentifierId = identifierRecord.sourceIdentifierId

    if (
      (kind !== 'doi' && kind !== 'pmid' && kind !== 'arxiv')
      || typeof normalizedValue !== 'string'
      || normalizedValue.trim().length === 0
      || typeof source !== 'string'
      || source.trim().length === 0
      || typeof sourceIdentifierId !== 'string'
      || sourceIdentifierId.trim().length === 0
    ) {
      return []
    }

    return [{kind, normalizedValue, source, sourceIdentifierId, isPrimary: identifierRecord.isPrimary === true}]
  })
}

export const getPdfImportArticle = (
  fieldName: string,
  articleId: string | null,
  metadata: Record<string, unknown> | null,
): ParsedPdfConflictResolutionImportArticle => {
  return {
    fieldName,
    sourceArticleRowId: getMetadataString(metadata, 'canonicalArticleId') ?? articleId,
    canonicalArticleId: getMetadataString(metadata, 'canonicalArticleId') ?? articleId,
    externalArticleId: getMetadataString(metadata, 'articleExternalId'),
    title: getMetadataString(metadata, 'articleTitle'),
    identifiers: getValidIdentifiers(metadata),
  }
}

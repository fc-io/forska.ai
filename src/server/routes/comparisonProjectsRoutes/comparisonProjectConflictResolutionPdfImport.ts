import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {
  type ComparisonProjectConflictResolutionTransferArtifactV1,
  type ComparisonProjectConflictResolutionTransferIdentifierV1,
  type ComparisonProjectConflictResolutionTransferRowV1,
  createComparisonProjectConflictResolutionTransferArtifact,
} from './comparisonProjectConflictResolutionFileTransfer.ts'

export type ParsedPdfConflictResolutionImport = {
  source: {
    comparisonProjectId: string | null
    comparisonProjectName: string | null
    exportedAt: string | null
    formatVersion: number | null
    humanJudgmentMode: HumanJudgmentMode | null
  }
  reviewer: {displayName: string | null; instanceId: string | null}
  rows: Array<{
    fieldName: string
    sourceArticleRowId: string | null
    canonicalArticleId: string | null
    externalArticleId: string | null
    title: string | null
    identifiers: ComparisonProjectConflictResolutionTransferIdentifierV1[]
    resolutionValue: string
  }>
  warnings: string[]
}

type PdfFormField = {name: string; value: string | null; fieldType: 'button' | 'text' | 'unknown'}

const conflictResolutionFieldPattern = /^comparison\.([^.]+)\.article\.([^.]+)\.resolution$/
const articleMetadataFieldPattern = /^comparison\.([^.]+)\.article\.([^.]+)\.metadata$/
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

const readBalancedPdfDictionary = (source: string, startIndex: number) => {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startIndex; index < source.length - 1; index += 1) {
    const character = source[index]
    const nextCharacter = source[index + 1]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (character === '\\') {
        escaped = true
        continue
      }

      if (character === ')') {
        inString = false
      }

      continue
    }

    if (character === '(') {
      inString = true
      continue
    }

    if (character === '<' && nextCharacter === '<') {
      depth += 1
      index += 1
      continue
    }

    if (character === '>' && nextCharacter === '>') {
      depth -= 1
      index += 1

      if (depth === 0) {
        return source.slice(startIndex, index + 1)
      }
    }
  }

  return null
}

const getPdfDictionaries = (source: string) => {
  const dictionaries: string[] = []
  let searchIndex = 0

  while (searchIndex < source.length) {
    const startIndex = source.indexOf('<<', searchIndex)

    if (startIndex === -1) {
      break
    }

    const dictionary = readBalancedPdfDictionary(source, startIndex)

    if (!dictionary) {
      searchIndex = startIndex + 2
      continue
    }

    dictionaries.push(dictionary)
    searchIndex = startIndex + dictionary.length
  }

  return dictionaries
}

const parsePdfLiteralStringAt = (source: string, startIndex: number) => {
  if (source[startIndex] !== '(') {
    return null
  }

  let value = ''
  let escaped = false
  let depth = 1

  for (let index = startIndex + 1; index < source.length; index += 1) {
    const character = source[index]

    if (escaped) {
      escaped = false

      if (character === 'n') {
        value += '\n'
      } else if (character === 'r') {
        value += '\r'
      } else if (character === 't') {
        value += '\t'
      } else if (character === 'b') {
        value += '\b'
      } else if (character === 'f') {
        value += '\f'
      } else {
        value += character
      }

      continue
    }

    if (character === '\\') {
      escaped = true
      continue
    }

    if (character === '(') {
      depth += 1
      value += character
      continue
    }

    if (character === ')') {
      depth -= 1

      if (depth === 0) {
        return {endIndex: index + 1, value}
      }

      value += character
      continue
    }

    value += character
  }

  return null
}

const getPdfLiteralStringValue = (dictionary: string, key: string) => {
  const keyIndex = dictionary.indexOf(`/${key} `)

  if (keyIndex === -1) {
    return null
  }

  const valueStartIndex = dictionary.indexOf('(', keyIndex)

  return valueStartIndex === -1 ? null : (parsePdfLiteralStringAt(dictionary, valueStartIndex)?.value ?? null)
}

const getPdfNameValue = (dictionary: string, key: string) => {
  const match = new RegExp(`/${key}\\s+/([^\\s<>/()[\\]]+)`).exec(dictionary)

  return match?.[1] ?? null
}

const getPdfFormFields = (source: string): PdfFormField[] => {
  return getPdfDictionaries(source)
    .filter((dictionary) => {
      return dictionary.includes('/FT ') && dictionary.includes('/T ')
    })
    .flatMap((dictionary) => {
      const name = getPdfLiteralStringValue(dictionary, 'T')

      if (!name) {
        return []
      }

      const fieldTypeName = getPdfNameValue(dictionary, 'FT')
      const value = getPdfLiteralStringValue(dictionary, 'V') ?? getPdfNameValue(dictionary, 'V')
      const fieldType = fieldTypeName === 'Btn' ? 'button' : fieldTypeName === 'Tx' ? 'text' : 'unknown'

      return [{name, value, fieldType}]
    })
}

const getTrimmedValue = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

const getDecodedJsonMetadata = <T>(encodedValue: string | null | undefined): T | null => {
  const value = getTrimmedValue(encodedValue)

  if (!value) {
    return null
  }

  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

const getMetadataString = (metadata: Record<string, unknown> | null, key: string) => {
  const value = metadata?.[key]

  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getMetadataBoolean = (metadata: Record<string, unknown> | null, key: string) => {
  const value = metadata?.[key]

  return typeof value === 'boolean' ? value : null
}

const getMetadataNumber = (metadata: Record<string, unknown> | null, key: string) => {
  const value = metadata?.[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getReviewerInstanceId = (params: {
  reviewerFieldValue: string | null | undefined
  reviewerMetadata: Record<string, unknown> | null
}) => {
  return getTrimmedValue(params.reviewerFieldValue) ?? getMetadataString(params.reviewerMetadata, 'reviewerInstanceId')
}

const getResolutionLabel = (value: string) => {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const getResolutionMode = (projectMetadata: Record<string, unknown> | null): HumanJudgmentMode => {
  return getMetadataString(projectMetadata, 'humanJudgmentMode') === 'prompt' ? 'prompt' : 'summary'
}

const isMalformedComparisonFieldName = (fieldName: string) => {
  return (
    fieldName.startsWith('comparison.')
    && !conflictResolutionFieldPattern.test(fieldName)
    && !articleMetadataFieldPattern.test(fieldName)
  )
}

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
  const reviewerMetadata = getDecodedJsonMetadata<Record<string, unknown>>(fieldMap.get('forska.reviewer.instance'))
  const metadataByArticleId = new Map<string, Record<string, unknown>>()
  const resolutionProjectIds = new Set<string>()
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

  const rows = fields.flatMap((field) => {
    if (isMalformedComparisonFieldName(field.name)) {
      throw new Error(`Malformed PDF comparison field name: ${field.name}`)
    }

    const match = conflictResolutionFieldPattern.exec(field.name)

    if (!match) {
      return []
    }

    const resolutionValue = getTrimmedValue(field.value)

    if (!resolutionValue || resolutionValue === 'Off') {
      return []
    }

    const projectId = match[1] ?? null
    const articleId = match[2] ?? null
    const metadata = articleId ? (metadataByArticleId.get(articleId) ?? null) : null

    if (projectId) {
      resolutionProjectIds.add(projectId)
    }

    if (
      projectId
      && getMetadataString(projectMetadata, 'comparisonProjectId')
      && projectId !== projectMetadata?.comparisonProjectId
    ) {
      warnings.push(`Resolution field ${field.name} did not match the PDF project metadata.`)
    }

    return [
      {
        fieldName: field.name,
        sourceArticleRowId: getMetadataString(metadata, 'canonicalArticleId') ?? articleId,
        canonicalArticleId: getMetadataString(metadata, 'canonicalArticleId') ?? articleId,
        externalArticleId: getMetadataString(metadata, 'articleExternalId'),
        title: getMetadataString(metadata, 'articleTitle'),
        identifiers: getValidIdentifiers(metadata),
        resolutionValue,
      },
    ]
  })

  if (rows.length === 0) {
    throw new Error('The selected PDF has no filled conflict-resolution radio fields.')
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
        ?? (resolutionProjectIds.size === 1 ? (Array.from(resolutionProjectIds)[0] ?? null) : null),
      comparisonProjectName: getMetadataString(projectMetadata, 'comparisonProjectName'),
      exportedAt: getMetadataString(projectMetadata, 'exportedAt'),
      formatVersion: getMetadataNumber(formatMetadata, 'version'),
      humanJudgmentMode: projectMetadata ? getResolutionMode(projectMetadata) : null,
    },
    reviewer: {
      displayName: getTrimmedValue(fieldMap.get('forska.reviewer.displayName')),
      instanceId: getReviewerInstanceId({
        reviewerFieldValue: fieldMap.get('forska.reviewer.instanceId'),
        reviewerMetadata,
      }),
    },
    rows,
    warnings,
  }
}

export const getComparisonProjectConflictResolutionTransferArtifactFromPdfImport = (
  params:
    | ParsedPdfConflictResolutionImport
    | {
        parsedImport: ParsedPdfConflictResolutionImport
        sourceComparisonProjectDescription?: string | null
        targetComparisonProjectId?: string
      },
): ComparisonProjectConflictResolutionTransferArtifactV1 => {
  const parsedImport = 'parsedImport' in params ? params.parsedImport : params
  const targetComparisonProjectId = 'parsedImport' in params ? params.targetComparisonProjectId : undefined
  const sourceComparisonProjectId = parsedImport.source.comparisonProjectId ?? 'pdf-conflict-resolution-import'
  const sourceComparisonProjectName = parsedImport.source.comparisonProjectName ?? 'PDF conflict-resolution import'
  const resolutionMode = parsedImport.source.humanJudgmentMode ?? 'summary'
  const hasHiddenRowMetadata = parsedImport.rows.some((row) => {
    return Boolean(row.externalArticleId || row.title || row.identifiers.length > 0)
  })

  if (!hasHiddenRowMetadata && targetComparisonProjectId && sourceComparisonProjectId !== targetComparisonProjectId) {
    throw new Error('PDF has no hidden row metadata, so it can only be imported into the same comparison project.')
  }

  const rows: ComparisonProjectConflictResolutionTransferRowV1[] = parsedImport.rows.map((row, rowIndex) => {
    const sourceArticleRowId =
      row.sourceArticleRowId ?? row.canonicalArticleId ?? `${sourceComparisonProjectId}:pdf-row-${rowIndex + 1}`
    const sourceResolutionId = `${sourceComparisonProjectId}:${sourceArticleRowId}:pdf-resolution`

    return {
      sourceResolutionId,
      sourceArticleRowId,
      externalArticleId: row.externalArticleId,
      title: row.title,
      identifiers: row.identifiers,
      resolution: {mode: resolutionMode, value: row.resolutionValue, label: getResolutionLabel(row.resolutionValue)},
    }
  })

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
    rows,
  })
}

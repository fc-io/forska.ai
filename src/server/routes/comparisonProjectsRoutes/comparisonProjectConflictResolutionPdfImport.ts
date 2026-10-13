import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {
  type ComparisonProjectConflictResolutionTransferArtifact,
  type ComparisonProjectConflictResolutionTransferIdentifierV1,
  type ComparisonProjectConflictResolutionTransferRowV3,
  createComparisonProjectConflictResolutionTransferArtifact,
} from './comparisonProjectConflictResolutionFileTransfer.ts'
import {getImportedComparisonProjectConflictResolutionComment} from './comparisonProjectConflictResolutionProvenance.ts'

type ParsedPdfConflictResolutionImportArticle = {
  fieldName: string
  sourceArticleRowId: string | null
  canonicalArticleId: string | null
  externalArticleId: string | null
  title: string | null
  identifiers: ComparisonProjectConflictResolutionTransferIdentifierV1[]
}

export type ParsedPdfConflictResolutionImport = {
  source: {
    comparisonProjectId: string | null
    comparisonProjectName: string | null
    exportedAt: string | null
    formatVersion: number | null
    humanJudgmentMode: HumanJudgmentMode | null
    judgmentContextId?: string | null
  }
  reviewer: {displayName: string | null; instanceId: null}
  rows: Array<ParsedPdfConflictResolutionImportArticle & {resolutionValue: string; comment: string | null}>
  undecidedRows: Array<
    ParsedPdfConflictResolutionImportArticle & {resolutionValue: typeof pdfConflictResolutionNotSetValue}
  >
  commentOnlyRows: Array<ParsedPdfConflictResolutionImportArticle & {resolutionValue: null; comment: string}>
  warnings: string[]
}

type PdfFormField = {name: string; value: string | null; fieldType: 'button' | 'text' | 'unknown'}

type PdfStringToken = {bytes: string; endIndex: number}

const conflictResolutionFieldPattern = /^comparison\.([^.]+)\.article\.([^.]+)\.resolution$/
const conflictCommentFieldPattern = /^comparison\.([^.]+)\.article\.([^.]+)\.comment$/
const articleMetadataFieldPattern = /^comparison\.([^.]+)\.article\.([^.]+)\.metadata$/
const supportedPdfImportFormat = 'forska.comparisonProject.pdfConflictResolutionImport'
export const pdfConflictResolutionNotSetValue = '__forska_conflict_resolution_not_set__'

const pdfWhitespaceCharacters = new Set(['\0', '\t', '\n', '\f', '\r', ' '])
const pdfLiteralStringEscapes = new Map([
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
])
const pdfLiteralStringDepthChanges = new Map([
  ['(', 1],
  [')', -1],
])
const pdfNamePattern = /\/[^\0\t\n\f\r ()<>[\]{}/%]*/y
const pdfRegularTokenPattern = /[^\0\t\n\f\r ()<>[\]{}/%]+/y
const pdfOctalEscapePattern = /[0-7]{1,3}/y
const pdfStreamPattern = /(>>\s*stream)(?:\r\n|\r|\n)[\s\S]*?endstream/g
const pdfUtf16BeBom = String.fromCharCode(0xfe, 0xff)
const pdfUtf8Bom = String.fromCharCode(0xef, 0xbb, 0xbf)

const getPdfText = (input: Buffer | Uint8Array | ArrayBuffer | string) => {
  if (typeof input === 'string') {
    return input
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(input).toString('latin1')
  }

  return Buffer.from(input).toString('latin1')
}

const getPdfTextWithoutStreams = (source: string) => {
  return source.replace(pdfStreamPattern, '$1\nendstream')
}

const getPdfPatternEndIndex = (pattern: RegExp, source: string, index: number) => {
  pattern.lastIndex = index

  return index + (pattern.exec(source)?.[0].length ?? 0)
}

const getPdfNonWhitespaceIndex = (source: string, startIndex: number) => {
  let index = startIndex

  while (index < source.length && pdfWhitespaceCharacters.has(source[index] ?? '')) {
    index += 1
  }

  return index
}

const readPdfLiteralStringEscape = (source: string, index: number): PdfStringToken => {
  const character = source[index] ?? ''
  const octalEndIndex = getPdfPatternEndIndex(pdfOctalEscapePattern, source, index)

  if (octalEndIndex > index) {
    return {bytes: String.fromCharCode(parseInt(source.slice(index, octalEndIndex), 8) & 0xff), endIndex: octalEndIndex}
  }

  if (character === '\r') {
    return {bytes: '', endIndex: source[index + 1] === '\n' ? index + 2 : index + 1}
  }

  if (character === '\n') {
    return {bytes: '', endIndex: index + 1}
  }

  return {bytes: pdfLiteralStringEscapes.get(character) ?? character, endIndex: index + 1}
}

const readPdfLiteralString = (source: string, startIndex: number): PdfStringToken | null => {
  let bytes = ''
  let depth = 1
  let index = startIndex + 1

  while (index < source.length) {
    const character = source[index] ?? ''

    if (character === '\\') {
      const escape = readPdfLiteralStringEscape(source, index + 1)

      bytes += escape.bytes
      index = escape.endIndex
      continue
    }

    depth += pdfLiteralStringDepthChanges.get(character) ?? 0

    if (depth === 0) {
      return {bytes, endIndex: index + 1}
    }

    bytes += character
    index += 1
  }

  return null
}

const readPdfHexString = (source: string, startIndex: number): PdfStringToken | null => {
  const endIndex = source.indexOf('>', startIndex + 1)
  const digits = endIndex === -1 ? null : source.slice(startIndex + 1, endIndex).replace(/[\0\t\n\f\r ]/g, '')

  return digits !== null && /^[0-9a-fA-F]*$/.test(digits)
    ? {
        bytes: Buffer.from(digits.length % 2 === 0 ? digits : `${digits}0`, 'hex').toString('latin1'),
        endIndex: endIndex + 1,
      }
    : null
}

const readPdfStringToken = (source: string, index: number) => {
  if (source[index] === '(') {
    return readPdfLiteralString(source, index)
  }

  return source[index] === '<' && source[index + 1] !== '<' ? readPdfHexString(source, index) : null
}

const readPdfDictionaryEndIndex = (source: string, startIndex: number) => {
  let depth = 0
  let index = startIndex

  while (index < source.length) {
    const character = source[index]
    const isDoubleBracket = source[index + 1] === character

    if (character === '(' || (character === '<' && !isDoubleBracket)) {
      const stringToken = readPdfStringToken(source, index)

      if (!stringToken) {
        return null
      }

      index = stringToken.endIndex
      continue
    }

    if ((character === '<' || character === '>') && isDoubleBracket) {
      depth += character === '<' ? 1 : -1
      index += 2

      if (depth === 0) {
        return index
      }

      continue
    }

    index += 1
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

    const endIndex = readPdfDictionaryEndIndex(source, startIndex)

    if (endIndex === null) {
      searchIndex = startIndex + 2
      continue
    }

    dictionaries.push(source.slice(startIndex, endIndex))
    searchIndex = endIndex
  }

  return dictionaries
}

const getPdfArrayEndIndex = (source: string, startIndex: number) => {
  let index = getPdfNonWhitespaceIndex(source, startIndex + 1)

  while (index < source.length && source[index] !== ']') {
    index = getPdfNonWhitespaceIndex(source, getPdfTokenEndIndex(source, index))
  }

  return Math.min(index + 1, source.length)
}

const getPdfTokenEndIndex = (source: string, index: number): number => {
  const character = source[index]

  if (character === '(' || (character === '<' && source[index + 1] !== '<')) {
    return readPdfStringToken(source, index)?.endIndex ?? source.length
  }

  if (character === '<') {
    return readPdfDictionaryEndIndex(source, index) ?? source.length
  }

  if (character === '[') {
    return getPdfArrayEndIndex(source, index)
  }

  return character === '/'
    ? getPdfPatternEndIndex(pdfNamePattern, source, index)
    : Math.max(getPdfPatternEndIndex(pdfRegularTokenPattern, source, index), index + 1)
}

const getPdfDictionaryEntries = (dictionary: string) => {
  const entries = new Map<string, number>()
  const contentEndIndex = dictionary.length - 2
  let index = getPdfNonWhitespaceIndex(dictionary, 2)
  let key: string | null = null

  while (index < contentEndIndex) {
    const endIndex = getPdfTokenEndIndex(dictionary, index)

    if (key !== null && !entries.has(key)) {
      entries.set(key, index)
    }

    key = key === null && dictionary[index] === '/' ? dictionary.slice(index + 1, endIndex) : null
    index = getPdfNonWhitespaceIndex(dictionary, endIndex)
  }

  return entries
}

const getUtf16BeText = (bytes: string) => {
  return Buffer.from(bytes.length % 2 === 0 ? bytes : bytes.slice(0, -1), 'latin1')
    .swap16()
    .toString('utf16le')
}

const getUnicodePdfText = (bytes: string) => {
  if (bytes.startsWith(pdfUtf16BeBom)) {
    return getUtf16BeText(bytes.slice(pdfUtf16BeBom.length))
  }

  return bytes.startsWith(pdfUtf8Bom) ? Buffer.from(bytes.slice(pdfUtf8Bom.length), 'latin1').toString('utf8') : bytes
}

const getLineFeedText = (value: string) => {
  return value.replace(/\r\n?/g, '\n')
}

const getPdfTextStringAt = (source: string, index: number) => {
  const stringToken = readPdfStringToken(source, index)

  return stringToken ? getLineFeedText(getUnicodePdfText(stringToken.bytes)) : null
}

const getPdfNameAt = (source: string, index: number) => {
  return source[index] === '/'
    ? source.slice(index + 1, getPdfPatternEndIndex(pdfNamePattern, source, index)) || null
    : null
}

const getPdfFormField = (dictionary: string): PdfFormField[] => {
  const entries = getPdfDictionaryEntries(dictionary)
  const fieldTypeIndex = entries.get('FT')
  const nameIndex = entries.get('T')
  const valueIndex = entries.get('V')
  const name =
    fieldTypeIndex === undefined || nameIndex === undefined ? null : getPdfTextStringAt(dictionary, nameIndex)

  if (!name || fieldTypeIndex === undefined) {
    return []
  }

  const fieldTypeName = getPdfNameAt(dictionary, fieldTypeIndex)
  const value =
    valueIndex === undefined
      ? null
      : (getPdfTextStringAt(dictionary, valueIndex) ?? getPdfNameAt(dictionary, valueIndex))
  const fieldType = fieldTypeName === 'Btn' ? 'button' : fieldTypeName === 'Tx' ? 'text' : 'unknown'

  return [{name, value, fieldType}]
}

const getLatestPdfFormFields = (fields: readonly PdfFormField[]) => {
  return Array.from(
    fields
      .reduce<Map<string, PdfFormField>>((fieldMap, field) => {
        return fieldMap.set(field.name, field)
      }, new Map<string, PdfFormField>())
      .values(),
  )
}

const getPdfFormFields = (source: string): PdfFormField[] => {
  return getLatestPdfFormFields(getPdfDictionaries(getPdfTextWithoutStreams(source)).flatMap(getPdfFormField))
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
    && !conflictCommentFieldPattern.test(fieldName)
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

const judgmentContextIdPattern = /^[0-9a-f]{64}$/

const getJudgmentContextIdMetadata = (metadata: Record<string, unknown> | null) => {
  const judgmentContextId = getMetadataString(metadata, 'judgmentContextId')

  return judgmentContextId && judgmentContextIdPattern.test(judgmentContextId) ? judgmentContextId : null
}

const getPdfImportArticle = (
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

const getArticleMetadata = (
  metadataByArticleId: ReadonlyMap<string, Record<string, unknown>>,
  articleId: string | null,
) => {
  return articleId ? (metadataByArticleId.get(articleId) ?? null) : null
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

const getTouchedPdfCommentFields = (
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

const getFilledPdfResolutionFields = (fields: readonly PdfFormField[]) => {
  return fields.flatMap((field) => {
    const match = conflictResolutionFieldPattern.exec(field.name)
    const resolutionValue = getTrimmedValue(field.value)

    return match && resolutionValue && resolutionValue !== 'Off'
      ? [{articleId: match[2] ?? null, fieldName: field.name, projectId: match[1] ?? null, resolutionValue}]
      : []
  })
}

const getPdfFieldProjectWarnings = (
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
    ...getPdfFieldProjectWarnings(resolutionFields, 'Resolution', projectMetadata),
    ...getPdfFieldProjectWarnings(commentFields, 'Comment', projectMetadata),
  )

  if (rows.length === 0 && undecidedRows.length === 0 && commentOnlyRows.length === 0) {
    throw new Error('The selected PDF has no filled conflict-resolution radio fields and no changed comments.')
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

import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import path from 'node:path'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidenceFileFormat = 'csv' | 'ris'
type CovidenceCsvParseErrorCode =
  | 'duplicate_header'
  | 'empty_file'
  | 'header_required'
  | 'malformed_csv'
  | 'row_length_mismatch'
  | 'unsupported_format'
type CovidencePackageFile = {
  assetPath: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}
type CovidenceReferenceRow = {
  citation: Record<string, string | null>
  exclusionReason: string | null
  fileRole: CovidenceFileRole
  notes: string | null
  rowNumber: number
  sourceFileName: string
  tags: string[]
}
type CovidenceCsvParseError = {
  code: CovidenceCsvParseErrorCode
  fileRole: CovidenceFileRole
  message: string
  rowNumber: number | null
  sourceFileName: string
}
type CovidenceCsvParseResult = {ok: true; rows: CovidenceReferenceRow[]} | {error: CovidenceCsvParseError; ok: false}
type CovidenceCsvHeaderResult = {normalizedHeaders: string[]; ok: true} | {error: CovidenceCsvParseError; ok: false}
type CovidencePackageConfig = {
  kind: 'covidence_import'
  version: 1
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}
type CovidencePackageUploadInput = Blob & {name?: string; type?: string}

const covidenceImportFolder = path.resolve(process.cwd(), 'assets/covidence_imports')
const covidenceImportPathPrefix = 'assets/covidence_imports'
const titleAbstractRoles: CovidenceFileRole[] = ['all', 'irrelevant', 'full_text']
const fullTextRoles: CovidenceFileRole[] = ['all', 'irrelevant', 'full_text', 'excluded', 'included']
const covidenceTagKeys = new Set(['tag', 'tags'])
const covidenceNoteKeys = new Set(['note', 'notes'])
const covidenceExclusionReasonKeys = new Set([
  'exclusion_reason',
  'exclusion_reasons',
  'reason_for_exclusion',
  'reason_for_exclusions',
])

const getCovidenceCsvParseError = (params: {
  code: CovidenceCsvParseErrorCode
  fileRole: CovidenceFileRole
  message: string
  rowNumber?: number | null
  sourceFileName: string
}): CovidenceCsvParseResult => {
  return {
    error: {
      code: params.code,
      fileRole: params.fileRole,
      message: params.message,
      rowNumber: params.rowNumber ?? null,
      sourceFileName: params.sourceFileName,
    },
    ok: false,
  }
}

const isCovidenceCsvParseFailure = <T extends {ok: boolean}>(value: T): value is Extract<T, {ok: false}> => {
  return value.ok === false
}

const getCovidenceCsvHeaderError = (params: {
  code: CovidenceCsvParseErrorCode
  fileRole: CovidenceFileRole
  message: string
  rowNumber?: number | null
  sourceFileName: string
}): CovidenceCsvHeaderResult => {
  const errorResult = getCovidenceCsvParseError(params)

  return isCovidenceCsvParseFailure(errorResult)
    ? {error: errorResult.error, ok: false}
    : {normalizedHeaders: [], ok: true}
}

const getSanitizedFileName = (fileName: string) => {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'upload'
}

const getNormalizedCovidenceHeader = (header: string) => {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

const getNormalizedCovidenceCellValue = (value: string) => {
  const trimmedValue = value.trim()
  return trimmedValue === '' ? null : trimmedValue
}

const getCovidenceTags = (value: string | null) => {
  return (value ?? '')
    .split(/[;|\n]/)
    .map((part) => {
      return part.trim()
    })
    .filter((part, index, parts) => {
      return part !== '' && parts.indexOf(part) === index
    })
}

const getParsedCovidenceCsvRows = (content: string) => {
  const state = Array.from(content).reduce(
    (currentState, character, index, characters) => {
      if (currentState.skipNext) {
        return {...currentState, skipNext: false}
      }

      if (character === '"') {
        return currentState.inQuotes && characters[index + 1] === '"'
          ? {...currentState, currentField: `${currentState.currentField}"`, skipNext: true}
          : {...currentState, inQuotes: !currentState.inQuotes}
      }

      if (character === '\r') {
        return currentState
      }

      if (character === ',' && !currentState.inQuotes) {
        return {...currentState, currentField: '', currentRow: [...currentState.currentRow, currentState.currentField]}
      }

      if (character === '\n' && !currentState.inQuotes) {
        return {
          ...currentState,
          currentField: '',
          currentRow: [],
          rows: [...currentState.rows, [...currentState.currentRow, currentState.currentField]],
        }
      }

      return {...currentState, currentField: `${currentState.currentField}${character}`}
    },
    {currentField: '', currentRow: [] as string[], inQuotes: false, rows: [] as string[][], skipNext: false},
  )
  const rows = [...state.rows, [...state.currentRow, state.currentField]].filter((row, index, allRows) => {
    return !(index === allRows.length - 1 && row.length === 1 && row[0] === '' && content.endsWith('\n'))
  })

  return state.inQuotes ? null : rows
}

const getCovidenceCsvHeaders = (params: {
  fileRole: CovidenceFileRole
  headers: string[]
  sourceFileName: string
}): CovidenceCsvHeaderResult => {
  const normalizedHeaders = params.headers.map((header) => {
    return getNormalizedCovidenceHeader(header)
  })
  const firstBlankHeaderIndex = normalizedHeaders.findIndex((header) => {
    return header === ''
  })

  if (firstBlankHeaderIndex !== -1) {
    return getCovidenceCsvHeaderError({
      code: 'header_required',
      fileRole: params.fileRole,
      message: `Covidence CSV header ${firstBlankHeaderIndex + 1} is empty`,
      rowNumber: 1,
      sourceFileName: params.sourceFileName,
    })
  }

  const duplicateHeader = normalizedHeaders.find((header, index) => {
    return normalizedHeaders.indexOf(header) !== index
  })

  return duplicateHeader
    ? getCovidenceCsvHeaderError({
        code: 'duplicate_header',
        fileRole: params.fileRole,
        message: `Covidence CSV contains duplicate header '${duplicateHeader}'`,
        rowNumber: 1,
        sourceFileName: params.sourceFileName,
      })
    : {normalizedHeaders, ok: true}
}

const getCovidenceCitationFields = (headers: string[], values: string[]) => {
  return headers.reduce<Record<string, string | null>>((citation, header, index) => {
    const value = getNormalizedCovidenceCellValue(values[index] ?? '')

    return covidenceTagKeys.has(header) || covidenceNoteKeys.has(header) || covidenceExclusionReasonKeys.has(header)
      ? citation
      : {...citation, [header]: value}
  }, {})
}

const getCovidenceReferenceRow = (params: {
  fileRole: CovidenceFileRole
  normalizedHeaders: string[]
  rowNumber: number
  sourceFileName: string
  values: string[]
}): CovidenceReferenceRow => {
  const normalizedValues = params.values.map((value) => {
    return getNormalizedCovidenceCellValue(value)
  })
  const rowEntries = params.normalizedHeaders.reduce<Record<string, string | null>>((row, header, index) => {
    return {...row, [header]: normalizedValues[index] ?? null}
  }, {})

  return {
    citation: getCovidenceCitationFields(params.normalizedHeaders, params.values),
    exclusionReason:
      params.normalizedHeaders
        .map((header) => {
          return (covidenceExclusionReasonKeys.has(header) ? rowEntries[header] : null) ?? null
        })
        .find((value) => {
          return value !== null
        }) ?? null,
    fileRole: params.fileRole,
    notes:
      params.normalizedHeaders
        .map((header) => {
          return (covidenceNoteKeys.has(header) ? rowEntries[header] : null) ?? null
        })
        .find((value) => {
          return value !== null
        }) ?? null,
    rowNumber: params.rowNumber,
    sourceFileName: params.sourceFileName,
    tags: params.normalizedHeaders.flatMap((header) => {
      return covidenceTagKeys.has(header) ? getCovidenceTags(rowEntries[header] ?? null) : []
    }),
  }
}

const getCovidenceFileFormatFromName = (fileName: string) => {
  const loweredName = fileName.toLowerCase()
  return loweredName.endsWith('.csv') ? ('csv' as const) : loweredName.endsWith('.ris') ? ('ris' as const) : null
}

const getAllowedRoles = (mode: CovidenceImportMode) => {
  return mode === 'title_abstract' ? titleAbstractRoles : fullTextRoles
}

const getSortedCovidencePackageFiles = (mode: CovidenceImportMode, files: CovidencePackageFile[]) => {
  const roleOrder = getAllowedRoles(mode)

  return [...files].sort((left, right) => {
    return roleOrder.indexOf(left.fileRole) - roleOrder.indexOf(right.fileRole)
  })
}

const getValidatedCovidencePackageFiles = (params: {
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}): CovidencePackageFile[] => {
  const allowedRoles = getAllowedRoles(params.mode)
  const fileRoles = params.files.map((file) => {
    return file.fileRole
  })
  const hasOnlyAllowedRoles = fileRoles.every((fileRole) => {
    return allowedRoles.includes(fileRole)
  })
  const uniqueRoles = new Set(fileRoles)
  const hasAllRequiredRoles = allowedRoles.every((fileRole) => {
    return uniqueRoles.has(fileRole)
  })

  if (!hasOnlyAllowedRoles || uniqueRoles.size !== params.files.length || !hasAllRequiredRoles) {
    throw new Error('Invalid Covidence package file roles for mode')
  }

  return getSortedCovidencePackageFiles(params.mode, params.files)
}

const getCovidencePackageConfigValue = (cursor: string | null): CovidencePackageConfig | null => {
  if (!cursor) {
    return null
  }

  try {
    const parsedValue = JSON.parse(cursor) as Partial<CovidencePackageConfig>
    const files = Array.isArray(parsedValue.files)
      ? parsedValue.files.filter((file): file is CovidencePackageFile => {
          return (
            typeof file === 'object'
            && file !== null
            && typeof file.assetPath === 'string'
            && typeof file.fileRole === 'string'
            && typeof file.format === 'string'
            && typeof file.sourceFileName === 'string'
          )
        })
      : []

    return parsedValue.kind === 'covidence_import'
      && parsedValue.version === 1
      && (parsedValue.mode === 'title_abstract' || parsedValue.mode === 'full_text')
      && files.length === parsedValue.files?.length
      ? {
          kind: 'covidence_import',
          version: 1,
          mode: parsedValue.mode,
          files: getValidatedCovidencePackageFiles({files, mode: parsedValue.mode}),
        }
      : null
  } catch {
    return null
  }
}

const getCovidencePackageConfigCursor = (config: CovidencePackageConfig) => {
  return JSON.stringify(config)
}

const getCovidencePackageFolder = (datasourceId: string) => {
  return path.join(covidenceImportFolder, datasourceId)
}

const ensureCovidencePackageFolder = (datasourceId: string) => {
  mkdirSync(getCovidencePackageFolder(datasourceId), {recursive: true})
}

const getCovidenceAssetPathParts = (assetPath: string) => {
  const normalizedAssetPath = assetPath.replace(/\\/g, '/')
  const pathSegments = normalizedAssetPath.split('/').filter((segment) => {
    return segment.length > 0
  })

  return pathSegments.length === 4
    && pathSegments[0] === 'assets'
    && pathSegments[1] === 'covidence_imports'
    && pathSegments[2]
    ? {datasourceId: pathSegments[2], fileName: pathSegments[3] ?? ''}
    : null
}

const getCovidencePackageAbsolutePath = (assetPath: string) => {
  const assetPathParts = getCovidenceAssetPathParts(assetPath)

  if (!assetPathParts) {
    return null
  }

  const datasourceFolder = getCovidencePackageFolder(assetPathParts.datasourceId)
  const absolutePath = path.resolve(process.cwd(), assetPath)
  const allowedPrefix = `${datasourceFolder}${path.sep}`

  return absolutePath.startsWith(allowedPrefix) ? absolutePath : null
}

export const buildCovidencePackageConfig = (params: {
  mode: CovidenceImportMode
  files: CovidencePackageFile[]
}): CovidencePackageConfig => {
  return {kind: 'covidence_import', version: 1, mode: params.mode, files: getValidatedCovidencePackageFiles(params)}
}

export const getCovidencePackageConfig = (cursor: string | null) => {
  return getCovidencePackageConfigValue(cursor)
}

export const getCovidencePackageCursor = (config: CovidencePackageConfig) => {
  return getCovidencePackageConfigCursor(config)
}

export const storeCovidencePackageFiles = async (params: {
  datasourceId: string
  files: Array<{file: CovidencePackageUploadInput; fileRole: CovidenceFileRole}>
}) => {
  ensureCovidencePackageFolder(params.datasourceId)

  return await Promise.all(
    params.files.map(async ({file, fileRole}) => {
      const sourceFileName = file.name?.trim() || `${fileRole}.upload`
      const format = getCovidenceFileFormatFromName(sourceFileName)

      if (!format) {
        throw new Error('Only Covidence CSV and RIS files are supported')
      }

      const sanitizedFileName = getSanitizedFileName(sourceFileName)
      const assetPath = `${covidenceImportPathPrefix}/${params.datasourceId}/${fileRole}-${sanitizedFileName}`
      const absolutePath = path.resolve(process.cwd(), assetPath)

      writeFileSync(absolutePath, await file.text())

      return {assetPath, fileRole, format, sourceFileName}
    }),
  )
}

export const getCovidencePackageFileContent = (assetPath: string) => {
  const absolutePath = getCovidencePackageAbsolutePath(assetPath)

  if (!absolutePath) {
    throw new Error('Invalid Covidence package asset path')
  }

  return readFileSync(absolutePath, 'utf8')
}

export const parseCovidenceCsvReferenceRows = (params: {
  content: string
  fileRole: CovidenceFileRole
  format: CovidenceFileFormat
  sourceFileName: string
}): CovidenceCsvParseResult => {
  if (params.format !== 'csv') {
    return getCovidenceCsvParseError({
      code: 'unsupported_format',
      fileRole: params.fileRole,
      message: `Covidence reference parsing only supports CSV inputs, got '${params.format}'`,
      sourceFileName: params.sourceFileName,
    })
  }

  const parsedRows = getParsedCovidenceCsvRows(params.content.replace(/^\uFEFF/, ''))

  if (!parsedRows) {
    return getCovidenceCsvParseError({
      code: 'malformed_csv',
      fileRole: params.fileRole,
      message: 'Covidence CSV has an unclosed quoted field',
      sourceFileName: params.sourceFileName,
    })
  }

  if (
    parsedRows.length === 0
    || parsedRows.every((row) => {
      return row.every((value) => {
        return value.trim() === ''
      })
    })
  ) {
    return getCovidenceCsvParseError({
      code: 'empty_file',
      fileRole: params.fileRole,
      message: 'Covidence CSV is empty',
      sourceFileName: params.sourceFileName,
    })
  }

  const headerRow = parsedRows[0]

  if (
    !headerRow
    || headerRow.every((value) => {
      return value.trim() === ''
    })
  ) {
    return getCovidenceCsvParseError({
      code: 'header_required',
      fileRole: params.fileRole,
      message: 'Covidence CSV requires a header row',
      rowNumber: 1,
      sourceFileName: params.sourceFileName,
    })
  }

  const headerResult = getCovidenceCsvHeaders({
    fileRole: params.fileRole,
    headers: headerRow,
    sourceFileName: params.sourceFileName,
  })

  if (isCovidenceCsvParseFailure(headerResult)) {
    return {error: headerResult.error, ok: false}
  }

  const rowLengthMismatch = parsedRows.slice(1).find((row) => {
    return row.length !== headerResult.normalizedHeaders.length
  })
  const rowLengthMismatchIndex = rowLengthMismatch ? parsedRows.indexOf(rowLengthMismatch) : -1

  if (rowLengthMismatch && rowLengthMismatchIndex !== -1) {
    return getCovidenceCsvParseError({
      code: 'row_length_mismatch',
      fileRole: params.fileRole,
      message: `Covidence CSV row ${rowLengthMismatchIndex + 1} has ${rowLengthMismatch.length} fields; expected ${headerResult.normalizedHeaders.length}`,
      rowNumber: rowLengthMismatchIndex + 1,
      sourceFileName: params.sourceFileName,
    })
  }

  return {
    ok: true,
    rows: parsedRows.slice(1).map((row, index) => {
      return getCovidenceReferenceRow({
        fileRole: params.fileRole,
        normalizedHeaders: headerResult.normalizedHeaders,
        rowNumber: index + 2,
        sourceFileName: params.sourceFileName,
        values: row,
      })
    }),
  }
}

export const deleteCovidencePackageFiles = (datasourceId: string) => {
  rmSync(getCovidencePackageFolder(datasourceId), {force: true, recursive: true})
}

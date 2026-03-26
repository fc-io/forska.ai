import {createHash, randomUUID} from 'node:crypto'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'

import {XMLParser} from 'fast-xml-parser'

import {
  type ArticleImportStoreRow,
  type ArticleImportStoreTx,
  storeImportedArticles,
  storeImportedArticlesWithTx,
} from './articleImportStoreService.ts'

type StructuredFileFormat = 'json' | 'xml'
type StructuredBoundaryCandidate = {
  pointer: string
  displayPath: string
  count: number
  sampleKeys: string[]
  samplePreview: string
}
type StructuredFileUpload = {assetPath: string; sourceFileName: string; format: StructuredFileFormat}
type StructuredFileAnalyzeResult = {upload: StructuredFileUpload; candidates: StructuredBoundaryCandidate[]}
type StructuredFileImportConfig = {
  kind: 'structured_file'
  version: 1
  assetPath: string
  sourceFileName: string
  format: StructuredFileFormat
  boundaryPointer: string
  boundaryDisplayPath: string
}
type StructuredFileImportResult = {
  config: StructuredFileImportConfig
  stats: {itemCount: number; importedCount: number}
  importRouteIds?: string[]
}
type StructuredFileItemContext = {
  index: number
  item: unknown
  dataSourceTitle: string
  importRoute: string
  config: StructuredFileImportConfig
  importedAt: Date
}

type StructuredFileUploadInput = Blob & {name?: string; type?: string}

const structuredFileImportFolder = path.resolve(process.cwd(), 'assets/structured_file_imports')
const structuredFilePathPrefix = 'assets/structured_file_imports/'
const xmlParser = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  parseTagValue: false,
  textNodeName: '#text',
  trimValues: true,
})
const titleKeySet = new Set(['title', 'name', 'label', 'headline', 'subject'])
const summaryKeySet = new Set(['summary', 'abstract', 'description', 'text', 'content', 'body', 'note'])
const authorKeySet = new Set(['authors', 'author', 'creator', 'byline', 'writer'])
const idKeySet = new Set(['id', 'identifier', 'uuid', 'guid', 'key', 'slug', 'code'])
const createdAtKeySet = new Set(['createdat', 'created', 'publishedat', 'published', 'date', 'datetime'])
const updatedAtKeySet = new Set(['updatedat', 'updated', 'modifiedat', 'modified', 'lastupdated', 'timestamp'])

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getNormalizedLookupKey = (value: string) => {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const getPointerSegment = (segment: string) => {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

const getPointer = (segments: string[]) => {
  return segments.length === 0
    ? ''
    : `/${segments
        .map((segment) => {
          return getPointerSegment(segment)
        })
        .join('/')}`
}

const getDisplaySegment = (segment: string) => {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`
}

const getDisplayPath = (segments: string[]) => {
  return `${segments.reduce((acc, segment) => {
    return `${acc}${getDisplaySegment(segment)}`
  }, '$')}[]`
}

const getShortText = (value: string, maxLength: number) => {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

const getScalarText = (value: unknown): string | null => {
  return typeof value === 'string'
    ? value.trim() || null
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : null
}

const getArrayScalarText = (value: unknown[]): string | null => {
  const parts = value
    .map((entry) => {
      return getScalarText(entry)
    })
    .filter((entry): entry is string => {
      return entry !== null
    })

  return parts.length > 0 ? parts.join(', ') : null
}

const getDirectScalarMatch = (value: Record<string, unknown>, lookupKeys: Set<string>): string | null => {
  const matchingEntry = Object.entries(value).find(([key]) => {
    return lookupKeys.has(getNormalizedLookupKey(key))
  })
  const matchingValue = matchingEntry?.[1]

  return Array.isArray(matchingValue)
    ? getArrayScalarText(matchingValue)
    : (getScalarText(matchingValue) ?? getNestedScalarMatch(matchingValue, lookupKeys))
}

const getNestedScalarMatch = (value: unknown, lookupKeys: Set<string>): string | null => {
  return Array.isArray(value)
    ? (value
        .map((entry) => {
          return getNestedScalarMatch(entry, lookupKeys)
        })
        .find((entry): entry is string => {
          return entry !== null
        }) ?? null)
    : isObjectRecord(value)
      ? (getDirectScalarMatch(value, lookupKeys)
        ?? Object.values(value)
          .map((entry) => {
            return getNestedScalarMatch(entry, lookupKeys)
          })
          .find((entry): entry is string => {
            return entry !== null
          })
        ?? null)
      : getScalarText(value)
}

const getAuthors = (value: unknown): string[] | null => {
  const authorValue = getNestedValueMatch(value, authorKeySet)
  const authors = Array.isArray(authorValue)
    ? authorValue.flatMap((entry) => {
        return getAuthorValues(entry)
      })
    : getAuthorValues(authorValue)

  return authors.length > 0 ? authors.slice(0, 12) : null
}

const getAuthorValues = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        return getAuthorValues(entry)
      })
    : isObjectRecord(value)
      ? [getDirectScalarMatch(value, titleKeySet) ?? getDirectScalarMatch(value, idKeySet)].filter(
          (entry): entry is string => {
            return Boolean(entry)
          },
        )
      : [getScalarText(value)].filter((entry): entry is string => {
          return entry !== null
        })
}

const getNestedValueMatch = (value: unknown, lookupKeys: Set<string>): unknown => {
  return Array.isArray(value)
    ? value
        .map((entry) => {
          return getNestedValueMatch(entry, lookupKeys)
        })
        .find((entry) => {
          return entry !== undefined
        })
    : isObjectRecord(value)
      ? (Object.entries(value).find(([key]) => {
          return lookupKeys.has(getNormalizedLookupKey(key))
        })?.[1]
        ?? Object.values(value)
          .map((entry) => {
            return getNestedValueMatch(entry, lookupKeys)
          })
          .find((entry) => {
            return entry !== undefined
          }))
      : undefined
}

const getDateValue = (value: string | null): Date | null => {
  if (!value) {
    return null
  }

  const parsedValue = new Date(value)
  return Number.isNaN(parsedValue.getTime()) ? null : parsedValue
}

const getStructuredValueDate = (value: unknown, lookupKeys: Set<string>, fallback: Date) => {
  return getDateValue(getNestedScalarMatch(value, lookupKeys)) ?? fallback
}

const getStructuredFileFormatFromName = (fileName: string) => {
  const loweredName = fileName.toLowerCase()
  return loweredName.endsWith('.json') ? ('json' as const) : loweredName.endsWith('.xml') ? ('xml' as const) : null
}

const getStructuredFileFormatFromContent = (content: string) => {
  const trimmedValue = content.trimStart()
  return trimmedValue.startsWith('<')
    ? ('xml' as const)
    : trimmedValue.startsWith('[') || trimmedValue.startsWith('{')
      ? ('json' as const)
      : null
}

const getStructuredFileFormat = (fileName: string, content: string) => {
  const explicitFormat = getStructuredFileFormatFromName(fileName)
  return explicitFormat ?? getStructuredFileFormatFromContent(content)
}

const getSanitizedFileName = (fileName: string) => {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'upload'
}

const ensureStructuredFileImportFolder = () => {
  mkdirSync(structuredFileImportFolder, {recursive: true})
}

const getStableJsonValue = (value: unknown): string => {
  return Array.isArray(value)
    ? `[${value
        .map((entry) => {
          return getStableJsonValue(entry)
        })
        .join(',')}]`
    : isObjectRecord(value)
      ? `{${Object.keys(value)
          .sort((left, right) => {
            return left.localeCompare(right)
          })
          .map((key) => {
            return `${JSON.stringify(key)}:${getStableJsonValue(value[key])}`
          })
          .join(',')}}`
      : (JSON.stringify(value) ?? 'null')
}

const getStructuredFileItemHash = (value: unknown) => {
  return createHash('sha256').update(getStableJsonValue(value)).digest('hex').slice(0, 24)
}

const getPrettyStructuredValue = (value: unknown) => {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

const getSummaryFallback = (value: unknown) => {
  return getShortText(getPrettyStructuredValue(value).replace(/\s+/g, ' ').trim(), 900)
}

const getItemIdentity = (value: unknown) => {
  return getNestedScalarMatch(value, idKeySet) ?? getStructuredFileItemHash(value)
}

const getSafeIdentityPart = (value: string) => {
  const encodedValue = encodeURIComponent(value)

  return encodedValue.length <= 160
    ? encodedValue
    : `${encodedValue.slice(0, 120)}-${createHash('sha256').update(encodedValue).digest('hex').slice(0, 24)}`
}

const getStructuredFileItemTitle = (context: StructuredFileItemContext) => {
  const directTitle = getNestedScalarMatch(context.item, titleKeySet)
  const explicitId = getNestedScalarMatch(context.item, idKeySet)
  const fallbackTitle = explicitId
    ? `${context.dataSourceTitle} ${explicitId}`
    : `${context.dataSourceTitle} item ${context.index + 1}`

  return getShortText(directTitle ?? fallbackTitle, 180)
}

const getStructuredFileItemSummary = (item: unknown) => {
  return getShortText(getNestedScalarMatch(item, summaryKeySet) ?? getSummaryFallback(item), 4000)
}

const getStructuredFileItemFullText = (title: string, item: unknown) => {
  return typeof item === 'string'
    ? `# ${title}\n\n${item.trim()}\n`
    : `# ${title}\n\n\`\`\`json\n${getPrettyStructuredValue(item)}\n\`\`\`\n`
}

const getStructuredFileImportRow = (context: StructuredFileItemContext): ArticleImportStoreRow => {
  const identity = getItemIdentity(context.item)
  const articleId = `${context.importRoute}:${getSafeIdentityPart(identity)}`
  const articleTitle = getStructuredFileItemTitle(context)
  const articleSummary = getStructuredFileItemSummary(context.item)
  const fullText = getStructuredFileItemFullText(articleTitle, context.item)

  return {
    articleId,
    articleTitle,
    articleSummary,
    articleAuthors: getAuthors(context.item),
    articleCreatedAt: getStructuredValueDate(context.item, createdAtKeySet, context.importedAt),
    articleUpdatedAt: getStructuredValueDate(context.item, updatedAtKeySet, context.importedAt),
    articleVersion: 1,
    importRoute: context.importRoute,
    originalData: context.item,
    sourceMetadata: {
      structuredFile: {
        assetPath: context.config.assetPath,
        boundaryDisplayPath: context.config.boundaryDisplayPath,
        boundaryPointer: context.config.boundaryPointer,
        format: context.config.format,
        sourceFileName: context.config.sourceFileName,
      },
    },
    fullText,
    fullTextOriginalFormat: context.config.format,
    fullTextSource: 'structured_file_import',
    fullTextFetchedAt: context.importedAt,
    fullTextConversionStatus: 'success',
    fullTextConversionAttempts: 1,
    fullTextCharCount: fullText.length,
  }
}

const getSampleKeys = (value: unknown): string[] => {
  return Array.isArray(value) ? [] : isObjectRecord(value) ? Object.keys(value).slice(0, 8) : []
}

const getBoundaryCandidate = (items: unknown[], segments: string[]): StructuredBoundaryCandidate => {
  const sampleItem = items[0] ?? null
  return {
    pointer: getPointer(segments),
    displayPath: getDisplayPath(segments),
    count: items.length,
    sampleKeys: getSampleKeys(sampleItem),
    samplePreview: getPrettyStructuredValue(sampleItem),
  }
}

const getBoundaryCandidates = (value: unknown, segments: string[] = []): StructuredBoundaryCandidate[] => {
  return Array.isArray(value)
    ? value.length > 1
      ? [getBoundaryCandidate(value, segments)]
      : []
    : isObjectRecord(value)
      ? Object.entries(value).flatMap(([key, entry]) => {
          return getBoundaryCandidates(entry, [...segments, key])
        })
      : []
}

const getUniqueBoundaryCandidates = (candidates: StructuredBoundaryCandidate[]) => {
  return Array.from(
    candidates
      .reduce((candidateMap, candidate) => {
        if (!candidateMap.has(candidate.pointer)) {
          candidateMap.set(candidate.pointer, candidate)
        }

        return candidateMap
      }, new Map<string, StructuredBoundaryCandidate>())
      .values(),
  )
}

const getParsedStructuredFile = (content: string, format: StructuredFileFormat): unknown => {
  return format === 'json' ? JSON.parse(content) : xmlParser.parse(content)
}

const getStoredStructuredFileUpload = async (
  file: StructuredFileUploadInput,
): Promise<StructuredFileUpload & {content: string}> => {
  const sourceFileName = file.name?.trim() || 'upload'
  const content = await file.text()
  const format = getStructuredFileFormat(sourceFileName, content)

  if (!format) {
    throw new Error('Only JSON and XML files are supported')
  }

  ensureStructuredFileImportFolder()

  const sanitizedFileName = getSanitizedFileName(sourceFileName)
  const targetFileName = `${randomUUID()}-${sanitizedFileName}`
  const assetPath = `${structuredFilePathPrefix}${targetFileName}`
  const absolutePath = path.resolve(process.cwd(), assetPath)

  writeFileSync(absolutePath, content)

  return {assetPath, content, format, sourceFileName}
}

const getStructuredFileAbsolutePath = (assetPath: string) => {
  const absolutePath = path.resolve(process.cwd(), assetPath)
  const allowedPrefix = `${structuredFileImportFolder}${path.sep}`
  return absolutePath === structuredFileImportFolder || absolutePath.startsWith(allowedPrefix) ? absolutePath : null
}

const getStructuredFileContentFromAssetPath = (assetPath: string) => {
  const absolutePath = getStructuredFileAbsolutePath(assetPath)

  if (!absolutePath) {
    throw new Error('Invalid structured file asset path')
  }

  return readFileSync(absolutePath, 'utf8')
}

const getPointerSegments = (pointer: string) => {
  return pointer === ''
    ? []
    : pointer
        .split('/')
        .slice(1)
        .map((segment) => {
          return segment.replaceAll('~1', '/').replaceAll('~0', '~')
        })
}

const getValueAtPointer = (value: unknown, pointer: string): unknown => {
  return getPointerSegments(pointer).reduce<unknown>((acc, segment) => {
    return isObjectRecord(acc) || Array.isArray(acc) ? (acc as Record<string, unknown>)[segment] : undefined
  }, value)
}

const getBoundaryItems = (parsedValue: unknown, pointer: string): unknown[] => {
  const boundaryValue = getValueAtPointer(parsedValue, pointer)

  if (!Array.isArray(boundaryValue) || boundaryValue.length === 0) {
    throw new Error('Selected boundary is empty or invalid')
  }

  return boundaryValue as unknown[]
}

const getStructuredFileImportConfigValue = (cursor: string | null): StructuredFileImportConfig | null => {
  if (!cursor) {
    return null
  }

  try {
    const parsedValue = JSON.parse(cursor) as Partial<StructuredFileImportConfig>
    return parsedValue.kind === 'structured_file'
      && parsedValue.version === 1
      && typeof parsedValue.assetPath === 'string'
      && typeof parsedValue.sourceFileName === 'string'
      && (parsedValue.format === 'json' || parsedValue.format === 'xml')
      && typeof parsedValue.boundaryPointer === 'string'
      && typeof parsedValue.boundaryDisplayPath === 'string'
      ? {
          kind: 'structured_file',
          version: 1,
          assetPath: parsedValue.assetPath,
          sourceFileName: parsedValue.sourceFileName,
          format: parsedValue.format,
          boundaryPointer: parsedValue.boundaryPointer,
          boundaryDisplayPath: parsedValue.boundaryDisplayPath,
        }
      : null
  } catch {
    return null
  }
}

const getStructuredFileConfigCursor = (config: StructuredFileImportConfig) => {
  return JSON.stringify(config)
}

const getImportResultFromConfig = async (params: {
  config: StructuredFileImportConfig
  dataSourceTitle: string
  importRoute: string
  tx?: ArticleImportStoreTx
}): Promise<StructuredFileImportResult> => {
  const content = getStructuredFileContentFromAssetPath(params.config.assetPath)
  const parsedValue = getParsedStructuredFile(content, params.config.format)
  const items = getBoundaryItems(parsedValue, params.config.boundaryPointer)
  const importedAt = new Date()
  const rows = items.map((item, index) => {
    return getStructuredFileImportRow({
      config: params.config,
      dataSourceTitle: params.dataSourceTitle,
      importRoute: params.importRoute,
      importedAt,
      index,
      item,
    })
  })

  if (params.tx) {
    const importRefreshState = await storeImportedArticlesWithTx(params.tx, rows)

    return {
      config: params.config,
      importRouteIds: importRefreshState.importRouteIds,
      stats: {itemCount: rows.length, importedCount: rows.length},
    }
  }

  await storeImportedArticles(rows)

  return {config: params.config, stats: {itemCount: rows.length, importedCount: rows.length}}
}

export const analyzeStructuredFileUpload = async (
  file: StructuredFileUploadInput,
): Promise<StructuredFileAnalyzeResult> => {
  const storedUpload = await getStoredStructuredFileUpload(file)
  const parsedValue = getParsedStructuredFile(storedUpload.content, storedUpload.format)
  const candidates = getUniqueBoundaryCandidates(getBoundaryCandidates(parsedValue))
    .sort((left, right) => {
      return right.count - left.count || left.displayPath.localeCompare(right.displayPath)
    })
    .slice(0, 50)

  if (candidates.length === 0) {
    throw new Error('No repeating boundary found in file')
  }

  return {
    candidates,
    upload: {
      assetPath: storedUpload.assetPath,
      format: storedUpload.format,
      sourceFileName: storedUpload.sourceFileName,
    },
  }
}

export const buildStructuredFileImportConfig = (params: {
  assetPath: string
  boundaryPointer: string
  boundaryDisplayPath: string
  format: StructuredFileFormat
  sourceFileName: string
}): StructuredFileImportConfig => {
  return {
    kind: 'structured_file',
    version: 1,
    assetPath: params.assetPath,
    boundaryDisplayPath: params.boundaryDisplayPath,
    boundaryPointer: params.boundaryPointer,
    format: params.format,
    sourceFileName: params.sourceFileName,
  }
}

export const getStructuredFileImportConfig = (cursor: string | null) => {
  return getStructuredFileImportConfigValue(cursor)
}

export const getStructuredFileImportCursor = (config: StructuredFileImportConfig) => {
  return getStructuredFileConfigCursor(config)
}

export const importStructuredFileFromConfig = async (params: {
  config: StructuredFileImportConfig
  dataSourceTitle: string
  importRoute: string
  tx?: ArticleImportStoreTx
}): Promise<StructuredFileImportResult> => {
  return await getImportResultFromConfig(params)
}

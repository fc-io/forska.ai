import {lstat} from 'node:fs/promises'
import {posix, win32} from 'node:path'

import {getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'
import {
  resolveProjectTransferPersistedRuntimeAssetPath,
  validateProjectTransferArchiveMemberPath,
  validateProjectTransferRuntimeAssetPath,
} from './projectTransferPaths.ts'
import {
  type ProjectTransferArticlePayloadRecord,
  type ProjectTransferAssetManifestEntry,
  type ProjectTransferAssetManifestPayload,
  type ProjectTransferAssetReference,
  type ProjectTransferAssetReferenceKind,
} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'

type JsonRecord = Record<string, unknown>

export type ProjectTransferExportAssetArticle = ProjectTransferArticlePayloadRecord & {
  fullTextAssets?: unknown
  fullTextHtml?: unknown
  fullTextPdf?: unknown
}

export type ProjectTransferExportAssetEntry = {bytes: Uint8Array; path: string}

type ProjectTransferExportAssetCollection = {
  assetEntries: ProjectTransferExportAssetEntry[]
  assetManifest: ProjectTransferAssetManifestPayload
}

type ProjectTransferExportArticleAssetCollection = ProjectTransferExportAssetCollection & {
  articles: ProjectTransferExportAssetArticle[]
}

type AssetReferenceInput = {
  assetPath: string
  fieldPath: string
  jsonPointer: string
  kind: ProjectTransferAssetReferenceKind
  sourceArticleId: string
}

type AssetPathResult = {kind: 'asset'; path: string} | {kind: 'none'} | {kind: 'unsafe'; message: string}

type HtmlAttributeAssetReference = {
  assetPath: string
  fieldPath: string
  jsonPointer: string
  kind: 'fullTextHtml'
  sourceArticleId: string
}

type FullTextAssetRewriteResult = {references: AssetReferenceInput[]; value: unknown}

type HtmlRewriteResult = {references: HtmlAttributeAssetReference[]; value: string}

const htmlAssetAttributePattern = /\b(src|href)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
const runtimeAssetUrlPath = '/api/runtime-asset'
const localPathPattern = /^(\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)/

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getSourceRef = (sourceArticleId: string) => {
  return `article:${sourceArticleId}`
}

const pointerSegment = (segment: string | number) => {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
}

const childPointer = (parent: string, segment: string | number) => {
  return `${parent}/${pointerSegment(segment)}`
}

const childFieldPath = (parent: string, segment: string | number) => {
  return typeof segment === 'number' ? `${parent}[${segment}]` : `${parent}.${segment}`
}

const getProjectTransferExportAssetError = (message: string): never => {
  throw new Error(`Project transfer export asset: ${message}`)
}

const getUrlValue = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const getRuntimeAssetUrlValue = (value: string) => {
  try {
    return new URL(value, 'http://project-transfer.local')
  } catch {
    return null
  }
}

const assertRuntimeAssetPath = (pathValue: string) => {
  const runtimePath = validateProjectTransferRuntimeAssetPath(pathValue)
  const archivePath = validateProjectTransferArchiveMemberPath({pathValue})

  if (!runtimePath.ok) {
    return getProjectTransferExportAssetError(runtimePath.error.message)
  }

  if (!archivePath.ok) {
    return getProjectTransferExportAssetError(archivePath.error.message)
  }

  return runtimePath.value.path
}

const getRuntimeAssetPathFromUrl = (value: string): AssetPathResult => {
  const url = getRuntimeAssetUrlValue(value.replaceAll('&amp;', '&'))

  if (url?.pathname !== runtimeAssetUrlPath) {
    return {kind: 'none'}
  }

  const pathValue = url.searchParams.get('path')

  return pathValue
    ? {kind: 'asset', path: assertRuntimeAssetPath(pathValue)}
    : {kind: 'unsafe', message: 'runtime asset URL is missing a path parameter'}
}

const isUnsafeSourcePath = (value: string) => {
  const trimmed = value.trim()
  const parsedUrl = getUrlValue(trimmed)
  const hasUnsafeProtocol =
    parsedUrl !== null
    && parsedUrl.protocol !== 'data:'
    && parsedUrl.protocol !== 'mailto:'
    && parsedUrl.protocol !== 'tel:'

  return (
    hasUnsafeProtocol
    || localPathPattern.test(trimmed)
    || posix.isAbsolute(trimmed)
    || win32.isAbsolute(trimmed)
    || trimmed.startsWith('tmp/')
    || trimmed.includes('\\')
  )
}

const getCanonicalAssetPath = (value: string): AssetPathResult => {
  const trimmed = value.trim()
  const runtimeAssetPath = getRuntimeAssetPathFromUrl(trimmed)

  if (runtimeAssetPath.kind !== 'none') {
    return runtimeAssetPath
  }

  return trimmed.startsWith('assets/')
    ? {kind: 'asset', path: assertRuntimeAssetPath(trimmed)}
    : isUnsafeSourcePath(trimmed)
      ? {kind: 'unsafe', message: `unsafe asset reference ${trimmed}`}
      : {kind: 'none'}
}

const assertRequiredAssetPath = (value: string, fieldPath: string) => {
  const assetPath = getCanonicalAssetPath(value)

  if (assetPath.kind === 'asset') {
    return assetPath.path
  }

  return getProjectTransferExportAssetError(
    assetPath.kind === 'unsafe'
      ? `${fieldPath} ${assetPath.message}`
      : `${fieldPath} must reference a runtime-relative assets path`,
  )
}

const getAssetReference = ({
  fieldPath,
  jsonPointer,
  kind,
  sourceArticleId,
}: AssetReferenceInput): ProjectTransferAssetReference => {
  return {
    fieldPath,
    jsonPointer,
    kind,
    payloadFile: projectTransferPayloadPathByKey.articles,
    sourceArticleId,
    sourceRef: getSourceRef(sourceArticleId),
  }
}

const rewriteFullTextPdf = (
  value: unknown,
  sourceArticleId: string,
  articleIndex: number,
): FullTextAssetRewriteResult => {
  if (value === null || value === undefined) {
    return {references: [], value: value ?? null}
  }

  if (typeof value !== 'string') {
    return getProjectTransferExportAssetError(`articles[${articleIndex}].fullTextPdf must be a string or null`)
  }

  const assetPath = assertRequiredAssetPath(value, `articles[${articleIndex}].fullTextPdf`)

  return {
    references: [
      {
        assetPath,
        fieldPath: `articles[${articleIndex}].fullTextPdf`,
        jsonPointer: `/${articleIndex}/fullTextPdf`,
        kind: 'fullTextPdf',
        sourceArticleId,
      },
    ],
    value: assetPath,
  }
}

const rewriteFullTextAssetsString = ({
  articleIndex,
  fieldPath,
  jsonPointer,
  sourceArticleId,
  value,
}: {
  articleIndex: number
  fieldPath: string
  jsonPointer: string
  sourceArticleId: string
  value: string
}): FullTextAssetRewriteResult => {
  const assetPath = getCanonicalAssetPath(value)

  if (assetPath.kind === 'unsafe') {
    return getProjectTransferExportAssetError(`articles[${articleIndex}].fullTextAssets ${assetPath.message}`)
  }

  return assetPath.kind === 'asset'
    ? {
        references: [{assetPath: assetPath.path, fieldPath, jsonPointer, kind: 'fullTextAssets', sourceArticleId}],
        value: assetPath.path,
      }
    : {references: [], value}
}

const rewriteFullTextAssetsValue = ({
  articleIndex,
  fieldPath,
  jsonPointer,
  sourceArticleId,
  value,
}: {
  articleIndex: number
  fieldPath: string
  jsonPointer: string
  sourceArticleId: string
  value: unknown
}): FullTextAssetRewriteResult => {
  if (typeof value === 'string') {
    return rewriteFullTextAssetsString({articleIndex, fieldPath, jsonPointer, sourceArticleId, value})
  }

  if (Array.isArray(value)) {
    const entries = value.map((entry, index) => {
      return rewriteFullTextAssetsValue({
        articleIndex,
        fieldPath: childFieldPath(fieldPath, index),
        jsonPointer: childPointer(jsonPointer, index),
        sourceArticleId,
        value: entry,
      })
    })

    return {
      references: entries.flatMap((entry) => {
        return entry.references
      }),
      value: entries.map((entry) => {
        return entry.value
      }),
    }
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).map(([field, entry]) => {
      return {
        field,
        result: rewriteFullTextAssetsValue({
          articleIndex,
          fieldPath: childFieldPath(fieldPath, field),
          jsonPointer: childPointer(jsonPointer, field),
          sourceArticleId,
          value: entry,
        }),
      }
    })

    return {
      references: entries.flatMap(({result}) => {
        return result.references
      }),
      value: entries.reduce<JsonRecord>((record, {field, result}) => {
        return {...record, [field]: result.value}
      }, {}),
    }
  }

  return {references: [], value: value ?? null}
}

const rewriteHtmlAttributeValue = ({
  articleIndex,
  fieldPath,
  jsonPointer,
  sourceArticleId,
  value,
}: {
  articleIndex: number
  fieldPath: string
  jsonPointer: string
  sourceArticleId: string
  value: string
}) => {
  const trimmed = value.trim()
  const runtimeAssetPath = getRuntimeAssetPathFromUrl(trimmed)
  const assetPath =
    runtimeAssetPath.kind !== 'none'
      ? runtimeAssetPath
      : trimmed.startsWith('assets/')
        ? {kind: 'asset' as const, path: assertRuntimeAssetPath(trimmed)}
        : {kind: 'none' as const}

  if (assetPath.kind === 'unsafe') {
    return getProjectTransferExportAssetError(`articles[${articleIndex}].fullTextHtml ${assetPath.message}`)
  }

  return assetPath.kind === 'asset'
    ? {
        reference: {assetPath: assetPath.path, fieldPath, jsonPointer, kind: 'fullTextHtml', sourceArticleId},
        value: assetPath.path,
      }
    : {reference: null, value}
}

const getHtmlAttributeValueParts = (
  doubleValue: string | undefined,
  singleValue: string | undefined,
  bareValue: string | undefined,
) => {
  return doubleValue !== undefined
    ? {quote: '"', value: doubleValue}
    : singleValue !== undefined
      ? {quote: "'", value: singleValue}
      : {quote: '', value: bareValue ?? ''}
}

const rewriteFullTextHtml = (value: unknown, sourceArticleId: string, articleIndex: number): HtmlRewriteResult => {
  if (value === null || value === undefined) {
    return {references: [], value: ''}
  }

  if (typeof value !== 'string') {
    return getProjectTransferExportAssetError(`articles[${articleIndex}].fullTextHtml must be a string or null`)
  }

  const references: HtmlAttributeAssetReference[] = []
  const rewritten = value.replace(
    htmlAssetAttributePattern,
    (
      match,
      attribute: string,
      separator: string,
      _rawValue: string,
      quotedDouble: string | undefined,
      quotedSingle: string | undefined,
      bareValue: string | undefined,
    ) => {
      const parts = getHtmlAttributeValueParts(quotedDouble, quotedSingle, bareValue)
      const rewrittenValue = rewriteHtmlAttributeValue({
        articleIndex,
        fieldPath: `articles[${articleIndex}].fullTextHtml`,
        jsonPointer: `/${articleIndex}/fullTextHtml`,
        sourceArticleId,
        value: parts.value,
      })

      if (rewrittenValue.reference) {
        references.push(rewrittenValue.reference)
      }

      return rewrittenValue.value === parts.value
        ? match
        : `${attribute}${separator}${parts.quote}${rewrittenValue.value}${parts.quote}`
    },
  )

  return {references, value: rewritten}
}

const getArticleAssetReferences = (article: ProjectTransferExportAssetArticle, articleIndex: number) => {
  const fullTextPdf = rewriteFullTextPdf(article.fullTextPdf, article.sourceArticleId, articleIndex)
  const fullTextAssets = rewriteFullTextAssetsValue({
    articleIndex,
    fieldPath: `articles[${articleIndex}].fullTextAssets`,
    jsonPointer: `/${articleIndex}/fullTextAssets`,
    sourceArticleId: article.sourceArticleId,
    value: article.fullTextAssets,
  })
  const fullTextHtml = rewriteFullTextHtml(article.fullTextHtml, article.sourceArticleId, articleIndex)
  const references = [...fullTextPdf.references, ...fullTextAssets.references, ...fullTextHtml.references]

  return {
    article: {
      ...article,
      fullTextAssets: fullTextAssets.value,
      fullTextHtml: article.fullTextHtml === null || article.fullTextHtml === undefined ? null : fullTextHtml.value,
      fullTextPdf: fullTextPdf.value,
    },
    references,
  }
}

export const getProjectTransferExportAssetByteEstimateForArticles = async (
  articles: ProjectTransferExportAssetArticle[],
) => {
  const articleReferences = articles.map((article, articleIndex) => {
    return getArticleAssetReferences(article, articleIndex)
  })
  const packagePaths = [
    ...new Set(
      articleReferences.flatMap((entry) => {
        return entry.references.map((reference) => {
          return reference.assetPath
        })
      }),
    ),
  ].sort()
  const sizes = await Promise.all(
    packagePaths.map(async (packagePath) => {
      const absolutePath = resolveProjectTransferPersistedRuntimeAssetPath({pathValue: packagePath})
      const stats = await lstat(absolutePath)

      return stats.isFile()
        ? stats.size
        : getProjectTransferExportAssetError(`runtime asset is not a file ${packagePath}`)
    }),
  )

  return sizes.reduce((total, size) => {
    return total + size
  }, 0)
}

const readAssetFile = async (pathValue: string) => {
  const absolutePath = resolveProjectTransferPersistedRuntimeAssetPath({pathValue})
  const assetFile = globalThis.Bun.file(absolutePath)
  const exists = await assetFile.exists()

  if (!exists) {
    return getProjectTransferExportAssetError(`missing runtime asset ${pathValue}`)
  }

  const before = await lstat(absolutePath)

  if (before.isSymbolicLink()) {
    return getProjectTransferExportAssetError(`runtime asset is a symlink ${pathValue}`)
  }

  if (!before.isFile()) {
    return getProjectTransferExportAssetError(`runtime asset is not a regular file ${pathValue}`)
  }

  const firstBytes = new Uint8Array(await assetFile.arrayBuffer())
  const secondFile = globalThis.Bun.file(absolutePath)
  const secondBytes = new Uint8Array(await secondFile.arrayBuffer())
  const after = await lstat(absolutePath)
  const checksumSha256 = getProjectTransferSha256Checksum(secondBytes)
  const firstChecksumSha256 = getProjectTransferSha256Checksum(firstBytes)

  if (before.size !== after.size || before.size !== secondBytes.byteLength || firstChecksumSha256 !== checksumSha256) {
    return getProjectTransferExportAssetError(`runtime asset changed while being copied ${pathValue}`)
  }

  return {
    byteLength: secondBytes.byteLength,
    bytes: secondBytes,
    checksumSha256,
    contentType: secondFile.type || null,
    packagePath: pathValue,
  }
}

const getReferencesByAssetPath = (references: AssetReferenceInput[]) => {
  return references.reduce<Map<string, ProjectTransferAssetReference[]>>((referencesByAssetPath, reference) => {
    const existingReferences = referencesByAssetPath.get(reference.assetPath) ?? []

    referencesByAssetPath.set(reference.assetPath, [...existingReferences, getAssetReference(reference)])

    return referencesByAssetPath
  }, new Map())
}

const getAssetManifestEntry = async (
  packagePath: string,
  references: ProjectTransferAssetReference[],
): Promise<{assetEntry: ProjectTransferExportAssetEntry; manifestEntry: ProjectTransferAssetManifestEntry}> => {
  const file = await readAssetFile(packagePath)
  const baseManifestEntry = {
    byteLength: file.byteLength,
    checksumSha256: file.checksumSha256,
    packagePath: file.packagePath,
    references,
  }

  return {
    assetEntry: {bytes: file.bytes, path: file.packagePath},
    manifestEntry: file.contentType ? {...baseManifestEntry, contentType: file.contentType} : baseManifestEntry,
  }
}

const getAssetManifestEntries = async (references: AssetReferenceInput[]) => {
  const referencesByAssetPath = getReferencesByAssetPath(references)
  const packagePaths = [...referencesByAssetPath.keys()].sort()
  const entries = await Promise.all(
    packagePaths.map((packagePath) => {
      return getAssetManifestEntry(packagePath, referencesByAssetPath.get(packagePath) ?? [])
    }),
  )

  return {
    assetEntries: entries.map((entry) => {
      return entry.assetEntry
    }),
    assetManifest: {
      entries: entries.map((entry) => {
        return entry.manifestEntry
      }),
    },
  }
}

export const getEmptyProjectTransferAssetManifestPayload = (): ProjectTransferAssetManifestPayload => {
  return {entries: []}
}

export const getProjectTransferExportAssetCollectionForArticles = async (
  articles: ProjectTransferArticlePayloadRecord[],
): Promise<ProjectTransferExportArticleAssetCollection> => {
  const articleReferences = articles.map((article, articleIndex) => {
    return getArticleAssetReferences(article as ProjectTransferExportAssetArticle, articleIndex)
  })
  const assetCollection = await getAssetManifestEntries(
    articleReferences.flatMap((entry) => {
      return entry.references
    }),
  )

  return {
    ...assetCollection,
    articles: articleReferences.map((entry) => {
      return entry.article
    }),
  }
}

export const filterProjectTransferExportAssetCollectionByArticles = ({
  articles,
  assetEntries,
  assetManifest,
}: ProjectTransferExportAssetCollection & {
  articles: ProjectTransferArticlePayloadRecord[]
}): ProjectTransferExportAssetCollection => {
  const sourceArticleIds = new Set(
    articles.map((article) => {
      return article.sourceArticleId
    }),
  )
  const entries = assetManifest.entries
    .map((entry) => {
      return {
        ...entry,
        references: entry.references.filter((reference) => {
          return reference.sourceArticleId === undefined || sourceArticleIds.has(reference.sourceArticleId)
        }),
      }
    })
    .filter((entry) => {
      return entry.references.length > 0
    })
  const packagePaths = new Set(
    entries.map((entry) => {
      return entry.packagePath
    }),
  )

  return {
    assetEntries: assetEntries.filter((entry) => {
      return packagePaths.has(entry.path)
    }),
    assetManifest: {entries},
  }
}

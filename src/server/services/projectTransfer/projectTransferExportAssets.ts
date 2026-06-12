import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {createReadStream, createWriteStream, type WriteStream} from 'node:fs'
import {lstat, mkdir, rm} from 'node:fs/promises'
import {dirname, join, posix, win32} from 'node:path'

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
type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

export type ProjectTransferExportAssetArticle = ProjectTransferArticlePayloadRecord & {
  fullTextAssets?: unknown
  fullTextHtml?: unknown
  fullTextPdf?: unknown
}

export type ProjectTransferExportAssetEntry = {byteLength: number; bytes?: Uint8Array; filePath?: string; path: string}
export type ProjectTransferExportAssetReferenceInput = AssetReferenceInput

type ProjectTransferExportAssetCollection = {
  assetEntries: ProjectTransferExportAssetEntry[]
  assetManifest: ProjectTransferAssetManifestPayload
}

type ProjectTransferExportArticleAssetCollection = ProjectTransferExportAssetCollection & {
  articles: ProjectTransferExportAssetArticle[]
}

type ProjectTransferExportArticleAssetReferenceCollection = {
  articles: ProjectTransferExportAssetArticle[]
  references: ProjectTransferExportAssetReferenceInput[]
}

type ProjectTransferExportAssetCollectionOptions = RuntimePathOptions & {
  maxConcurrency?: number
  readBytes?: boolean
  stagingRootPath?: string
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

type AssetUrlPolicy = {
  collectRuntimeAssetPath: boolean
  collectRuntimeAssetUrl: boolean
  preserveNonLocalUrl: boolean
  rejectUnsafeLocalPath: boolean
}

type RuntimeAssetFileSnapshot = {ctimeMs: number; dev: number; ino: number; mtimeMs: number; size: number}

const htmlAssetAttributePattern = /\b(src|href)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
const runtimeAssetUrlPath = '/api/runtime-asset'
const localPathPattern = /^(\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)/
const textEncoder = new TextEncoder()
const defaultAssetCopyConcurrency = 4
const sourceRuntimeAssetOrigin = 'http://project-transfer.local'
const assetUrlPolicyByField = {
  fullTextAssets: {
    collectRuntimeAssetPath: true,
    collectRuntimeAssetUrl: true,
    preserveNonLocalUrl: true,
    rejectUnsafeLocalPath: true,
  },
  fullTextHtml: {
    collectRuntimeAssetPath: true,
    collectRuntimeAssetUrl: true,
    preserveNonLocalUrl: true,
    rejectUnsafeLocalPath: false,
  },
  fullTextPdf: {
    collectRuntimeAssetPath: true,
    collectRuntimeAssetUrl: true,
    preserveNonLocalUrl: true,
    rejectUnsafeLocalPath: true,
  },
} as const satisfies Record<ProjectTransferAssetReferenceKind, AssetUrlPolicy>

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
    return new URL(value, sourceRuntimeAssetOrigin)
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
  const normalizedValue = value.replaceAll('&amp;', '&')
  const absoluteUrl = getUrlValue(normalizedValue)

  if (absoluteUrl !== null && absoluteUrl.origin !== sourceRuntimeAssetOrigin) {
    return {kind: 'none'}
  }

  const url = absoluteUrl ?? getRuntimeAssetUrlValue(normalizedValue)

  if (url?.origin !== sourceRuntimeAssetOrigin || url.pathname !== runtimeAssetUrlPath) {
    return {kind: 'none'}
  }

  const pathValue = url.searchParams.get('path')

  return pathValue
    ? {kind: 'asset', path: assertRuntimeAssetPath(pathValue)}
    : {kind: 'unsafe', message: 'runtime asset URL is missing a path parameter'}
}

const isPreservedNonLocalUrl = (value: string, policy: AssetUrlPolicy) => {
  const parsedUrl = getUrlValue(value.trim())

  return parsedUrl !== null && parsedUrl.protocol !== 'file:' && policy.preserveNonLocalUrl
}

const isUnsafeSourcePath = (value: string, policy: AssetUrlPolicy) => {
  const trimmed = value.trim()
  const parsedUrl = getUrlValue(trimmed)
  const hasUnsafeProtocol =
    parsedUrl !== null
    && !isPreservedNonLocalUrl(trimmed, policy)
    && parsedUrl.protocol !== 'data:'
    && parsedUrl.protocol !== 'mailto:'
    && parsedUrl.protocol !== 'tel:'
  const hasUnsafeLocalPath =
    localPathPattern.test(trimmed)
    || posix.isAbsolute(trimmed)
    || win32.isAbsolute(trimmed)
    || trimmed.startsWith('tmp/')
    || trimmed.includes('\\')

  return hasUnsafeProtocol || (policy.rejectUnsafeLocalPath && hasUnsafeLocalPath)
}

const getCanonicalAssetPath = (value: string, policy: AssetUrlPolicy): AssetPathResult => {
  const trimmed = value.trim()
  const runtimeAssetPath = getRuntimeAssetPathFromUrl(trimmed)

  if (policy.collectRuntimeAssetUrl && runtimeAssetPath.kind !== 'none') {
    return runtimeAssetPath
  }

  return policy.collectRuntimeAssetPath && trimmed.startsWith('assets/')
    ? {kind: 'asset', path: assertRuntimeAssetPath(trimmed)}
    : isUnsafeSourcePath(trimmed, policy)
      ? {kind: 'unsafe', message: `unsafe asset reference ${trimmed}`}
      : {kind: 'none'}
}

const assertRequiredAssetPath = (value: string, fieldPath: string) => {
  const policy = assetUrlPolicyByField.fullTextPdf
  const assetPath = getCanonicalAssetPath(value, policy)

  if (assetPath.kind === 'asset') {
    return assetPath.path
  }

  if (assetPath.kind === 'none' && isPreservedNonLocalUrl(value, policy)) {
    return null
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

  return assetPath === null
    ? {references: [], value}
    : {
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
  const assetPath = getCanonicalAssetPath(value, assetUrlPolicyByField.fullTextAssets)

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
  const assetPath = getCanonicalAssetPath(trimmed, assetUrlPolicyByField.fullTextHtml)

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
  runtimeOptions: RuntimePathOptions = {},
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
      const absolutePath = resolveProjectTransferPersistedRuntimeAssetPath({...runtimeOptions, pathValue: packagePath})
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

const getRuntimeAssetFileSnapshot = (stats: Awaited<ReturnType<typeof lstat>>): RuntimeAssetFileSnapshot => {
  return {ctimeMs: stats.ctimeMs, dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size}
}

const getValidatedRuntimeAssetFile = async (pathValue: string, runtimeOptions: RuntimePathOptions) => {
  const absolutePath = resolveProjectTransferPersistedRuntimeAssetPath({...runtimeOptions, pathValue})
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

  return {absolutePath, contentType: assetFile.type || null, snapshot: getRuntimeAssetFileSnapshot(before)}
}

const getStreamChunkBytes = (chunk: unknown) => {
  return chunk instanceof Uint8Array ? chunk : textEncoder.encode(String(chunk))
}

const writeStreamBytes = async (stream: WriteStream, bytes: Uint8Array) => {
  if (bytes.byteLength === 0) {
    return undefined
  }

  if (!stream.write(bytes)) {
    await once(stream, 'drain')
  }

  return undefined
}

const closeAssetWriteStream = async (stream: WriteStream) => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error)
    }

    stream.once('error', onError)
    stream.end(() => {
      stream.off('error', onError)
      resolve()
    })
  })
}

const getStagedAssetFilePath = (stagingRootPath: string, packagePath: string) => {
  return join(stagingRootPath, packagePath)
}

const streamRuntimeAssetFile = async ({absolutePath, targetPath}: {absolutePath: string; targetPath?: string}) => {
  const hash = createHash('sha256')
  const state = {byteLength: 0}
  const writeStream = targetPath ? createWriteStream(targetPath) : null

  try {
    for await (const chunk of createReadStream(absolutePath)) {
      const bytes = getStreamChunkBytes(chunk)

      hash.update(bytes)
      state.byteLength += bytes.byteLength
      await (writeStream ? writeStreamBytes(writeStream, bytes) : Promise.resolve())
    }

    await (writeStream ? closeAssetWriteStream(writeStream) : Promise.resolve())

    return {byteLength: state.byteLength, checksumSha256: hash.digest('hex')}
  } catch (error) {
    writeStream?.destroy()
    await (targetPath ? rm(targetPath, {force: true}) : Promise.resolve())
    throw error
  }
}

const isRuntimeAssetFileSnapshotStable = (left: RuntimeAssetFileSnapshot, right: RuntimeAssetFileSnapshot) => {
  return (
    left.size === right.size
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  )
}

const assertRuntimeAssetFileStayedStable = ({
  after,
  before,
  byteLength,
  pathValue,
}: {
  after: RuntimeAssetFileSnapshot
  before: RuntimeAssetFileSnapshot
  byteLength: number
  pathValue: string
}) => {
  if (before.size !== byteLength || !isRuntimeAssetFileSnapshotStable(before, after)) {
    return getProjectTransferExportAssetError(`runtime asset changed while being copied ${pathValue}`)
  }

  return undefined
}

const getCopiedAssetFile = async ({
  pathValue,
  runtimeOptions,
  stagingRootPath,
}: {
  pathValue: string
  runtimeOptions: RuntimePathOptions
  stagingRootPath?: string
}) => {
  const sourceFile = await getValidatedRuntimeAssetFile(pathValue, runtimeOptions)
  const targetPath = stagingRootPath ? getStagedAssetFilePath(stagingRootPath, pathValue) : sourceFile.absolutePath

  await (stagingRootPath ? mkdir(dirname(targetPath), {recursive: true}) : Promise.resolve())

  const copied = await streamRuntimeAssetFile({
    absolutePath: sourceFile.absolutePath,
    targetPath: stagingRootPath ? targetPath : undefined,
  })
  const afterStats = await lstat(sourceFile.absolutePath)
  const afterSnapshot = getRuntimeAssetFileSnapshot(afterStats)

  if (afterStats.isSymbolicLink()) {
    return getProjectTransferExportAssetError(`runtime asset is a symlink ${pathValue}`)
  }

  if (!afterStats.isFile()) {
    return getProjectTransferExportAssetError(`runtime asset is not a regular file ${pathValue}`)
  }

  assertRuntimeAssetFileStayedStable({
    after: afterSnapshot,
    before: sourceFile.snapshot,
    byteLength: copied.byteLength,
    pathValue,
  })

  return {
    byteLength: copied.byteLength,
    checksumSha256: copied.checksumSha256,
    contentType: sourceFile.contentType,
    filePath: targetPath,
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
  options: ProjectTransferExportAssetCollectionOptions,
): Promise<{assetEntry: ProjectTransferExportAssetEntry; manifestEntry: ProjectTransferAssetManifestEntry}> => {
  const file = await getCopiedAssetFile({
    pathValue: packagePath,
    runtimeOptions: {cwd: options.cwd, envValues: options.envValues},
    stagingRootPath: options.stagingRootPath,
  })
  const baseManifestEntry = {
    byteLength: file.byteLength,
    checksumSha256: file.checksumSha256,
    packagePath: file.packagePath,
    references,
  }

  return {
    assetEntry: {byteLength: file.byteLength, filePath: file.filePath, path: file.packagePath},
    manifestEntry: file.contentType ? {...baseManifestEntry, contentType: file.contentType} : baseManifestEntry,
  }
}

const getAssetCopyConcurrency = (value: number | undefined) => {
  const normalized = Math.floor(value ?? defaultAssetCopyConcurrency)

  return Number.isFinite(normalized) && normalized > 0 ? normalized : defaultAssetCopyConcurrency
}

const runBoundedAssetTasks = async <TValue>(
  tasks: Array<() => Promise<TValue>>,
  maxConcurrency: number | undefined,
) => {
  const workerCount = Math.min(getAssetCopyConcurrency(maxConcurrency), tasks.length)
  const runWorker = async (workerIndex: number): Promise<Array<{index: number; value: TValue}>> => {
    const task = tasks[workerIndex]

    if (!task) {
      return []
    }

    const value = await task()
    const rest = await runWorker(workerIndex + workerCount)

    return [{index: workerIndex, value}, ...rest]
  }
  const results = await Promise.all(
    Array.from({length: workerCount}, (_entry, workerIndex) => {
      return runWorker(workerIndex)
    }),
  )

  return results
    .flat()
    .sort((left, right) => {
      return left.index - right.index
    })
    .map((entry) => {
      return entry.value
    })
}

const getAssetManifestEntries = async (
  references: AssetReferenceInput[],
  options: ProjectTransferExportAssetCollectionOptions = {},
) => {
  const referencesByAssetPath = getReferencesByAssetPath(references)
  const packagePaths = [...referencesByAssetPath.keys()].sort()
  const entries = await runBoundedAssetTasks(
    packagePaths.map((packagePath) => {
      return () => {
        return getAssetManifestEntry(packagePath, referencesByAssetPath.get(packagePath) ?? [], options)
      }
    }),
    options.maxConcurrency,
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

export const getProjectTransferExportAssetReferenceCollectionForArticles = (
  articles: ProjectTransferArticlePayloadRecord[],
): ProjectTransferExportArticleAssetReferenceCollection => {
  const articleReferences = articles.map((article, articleIndex) => {
    return getArticleAssetReferences(article as ProjectTransferExportAssetArticle, articleIndex)
  })

  return {
    articles: articleReferences.map((entry) => {
      return entry.article
    }),
    references: articleReferences.flatMap((entry) => {
      return entry.references
    }),
  }
}

export const getProjectTransferExportAssetCollectionForReferences = async (
  references: ProjectTransferExportAssetReferenceInput[],
  options: ProjectTransferExportAssetCollectionOptions = {},
): Promise<ProjectTransferExportAssetCollection> => {
  return getAssetManifestEntries(references, options)
}

export const getProjectTransferExportAssetCollectionForArticles = async (
  articles: ProjectTransferArticlePayloadRecord[],
  options: ProjectTransferExportAssetCollectionOptions = {},
): Promise<ProjectTransferExportArticleAssetCollection> => {
  const articleReferences = getProjectTransferExportAssetReferenceCollectionForArticles(articles)
  const assetCollection = await getAssetManifestEntries(articleReferences.references, options)

  return {...assetCollection, articles: articleReferences.articles}
}

import {lstat, mkdir, open, readFile, rm} from 'node:fs/promises'
import {dirname, posix, win32} from 'node:path'

import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import {getProjectTransferCanonicalJson, getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'
import {
  resolveProjectTransferArchiveMemberWritablePath,
  resolveProjectTransferPromotionWritablePath,
  resolveProjectTransferTempWritablePath,
  validateProjectTransferArchiveMemberPath,
  validateProjectTransferPromotionWritablePath,
  validateProjectTransferRuntimeAssetPath,
} from './projectTransferPaths.ts'
import {parseProjectTransferPayload, type ProjectTransferArticlePayloadRecord} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout, type ProjectTransferImportTempLayout} from './projectTransferSession.ts'

type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

type JsonRecord = Record<string, unknown>

type ProjectTransferCommitAssetPromotionPlanEntry = ProjectTransferTargetPlan['assetPromotionPlan'][number]

type ProjectTransferCommitPromotionPlanRecord = {entry: ProjectTransferCommitAssetPromotionPlanEntry; planIndex: number}

export type ProjectTransferCommitPromotionManifestEntry = {
  byteLength: number
  checksumSha256: string
  contentType?: string | null
  copied: boolean
  copiedAt: string | null
  copiedByteLength: number | null
  copiedChecksumSha256: string | null
  packagePath: string
  planIndex: number
  promotedPath: string
  sessionId: string
}

export type ProjectTransferCommitPromotionManifest = {
  createdAt: string
  promotions: ProjectTransferCommitPromotionManifestEntry[]
  sessionId: string
  updatedAt: string
}

export type ProjectTransferCommitArticleCreate = {article: ProjectTransferArticlePayloadRecord; sourceArticleId: string}

export type ProjectTransferCommitArticleFieldFill = {
  field: string
  sourceArticleId: string
  targetArticleId: string
  value: unknown
}

export type ProjectTransferCommitPromotionResult = {
  articleCreates: ProjectTransferCommitArticleCreate[]
  articleFieldFills: ProjectTransferCommitArticleFieldFill[]
  manifest: ProjectTransferCommitPromotionManifest
  promotionPathByPackagePath: Record<string, string>
}

export type ProjectTransferCommitRollbackResult = {deletedPromotedAssetCount: number; skippedPromotedAssetCount: number}

type PromoteProjectTransferCommitAssetsParams = RuntimePathOptions & {now?: Date; sessionId: string}

type RollbackProjectTransferCommitPromotionParams = RuntimePathOptions & {
  copiedOnly?: boolean
  manifest?: ProjectTransferCommitPromotionManifest
  sessionId: string
}

type RunProjectTransferCommitWithPromotionRollbackParams<TResult> = PromoteProjectTransferCommitAssetsParams & {
  work: (promotion: ProjectTransferCommitPromotionResult) => Promise<TResult>
}

const runtimeAssetUrlPath = '/api/runtime-asset'
const htmlAssetAttributePattern = /\b(src|href)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
const localPathPattern = /^(\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)/
const projectTransferSha256Pattern = /^[a-f0-9]{64}$/

const contentTypeExtensions: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'text/html': '.html',
  'text/plain': '.txt',
}

const getCommitPromotionError = (message: string): never => {
  throw new Error(`Project transfer commit promotion: ${message}`)
}

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const assertRecord = (value: unknown, label: string): JsonRecord => {
  return isRecord(value) ? value : getCommitPromotionError(`${label} must be an object`)
}

const assertArray = (value: unknown, label: string): unknown[] => {
  return Array.isArray(value) ? value : getCommitPromotionError(`${label} must be an array`)
}

const assertString = (value: unknown, label: string): string => {
  return typeof value === 'string' ? value : getCommitPromotionError(`${label} must be a string`)
}

const assertNullableString = (value: unknown, label: string): string | null | undefined => {
  return value === undefined || value === null ? value : assertString(value, label)
}

const assertNonNegativeInteger = (value: unknown, label: string): number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : getCommitPromotionError(`${label} must be a non-negative integer`)
}

const assertSha256Checksum = (value: unknown, label: string): string => {
  const checksum = assertString(value, label)

  return projectTransferSha256Pattern.test(checksum)
    ? checksum
    : getCommitPromotionError(`${label} must be a lowercase sha256 checksum`)
}

const getPathValidationErrorMessage = (message: string, pathValue: string) => {
  return `${message}: ${pathValue}`
}

const assertPackageAssetPath = (pathValue: string) => {
  const archivePath = validateProjectTransferArchiveMemberPath({pathValue})
  const runtimeAssetPath = validateProjectTransferRuntimeAssetPath(pathValue)

  if (!archivePath.ok) {
    return getCommitPromotionError(getPathValidationErrorMessage(archivePath.error.message, pathValue))
  }

  if (!runtimeAssetPath.ok) {
    return getCommitPromotionError(getPathValidationErrorMessage(runtimeAssetPath.error.message, pathValue))
  }

  return pathValue
}

const assertPromotionPlanEntry = (value: unknown, index: number): ProjectTransferCommitAssetPromotionPlanEntry => {
  const label = `plan.targetPlan.assetPromotionPlan[${index}]`
  const record = assertRecord(value, label)
  const packagePath = assertPackageAssetPath(assertString(record.packagePath, `${label}.packagePath`))

  assertNonNegativeInteger(record.byteLength, `${label}.byteLength`)
  assertSha256Checksum(record.checksumSha256, `${label}.checksumSha256`)
  assertNullableString(record.contentType, `${label}.contentType`)

  return {...record, packagePath} as ProjectTransferCommitAssetPromotionPlanEntry
}

const assertPlanArtifact = (value: unknown): ProjectTransferImportPlanArtifact => {
  const plan = assertRecord(value, 'plan.json')
  const targetPlan = assertRecord(plan.targetPlan, 'plan.targetPlan')
  const assetPromotionPlan = assertArray(targetPlan.assetPromotionPlan, 'plan.targetPlan.assetPromotionPlan').map(
    assertPromotionPlanEntry,
  )

  assertArray(targetPlan.articleMatches, 'plan.targetPlan.articleMatches')
  assertArray(targetPlan.articleUpdatePlan, 'plan.targetPlan.articleUpdatePlan')

  return {...plan, targetPlan: {...targetPlan, assetPromotionPlan}} as ProjectTransferImportPlanArtifact
}

const getPayloadPath = (layout: ProjectTransferImportTempLayout, key: 'articles') => {
  return `${layout.extractedPath}/${projectTransferPayloadPathByKey[key]}`
}

const readTextArtifact = async (input: RuntimePathOptions & {pathValue: string}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath(input)
  const file = globalThis.Bun.file(resolvedPath)

  return (await file.exists()) ? file.text() : getCommitPromotionError(`missing artifact ${input.pathValue}`)
}

const readJsonArtifact = async <TValue>(input: RuntimePathOptions & {pathValue: string}) => {
  const text = await readTextArtifact(input)

  return JSON.parse(text) as TValue
}

const readPlanArtifact = async (input: RuntimePathOptions & {layout: ProjectTransferImportTempLayout}) => {
  return assertPlanArtifact(await readJsonArtifact({...input, pathValue: input.layout.planPath}))
}

const readArticlesPayload = async (input: RuntimePathOptions & {layout: ProjectTransferImportTempLayout}) => {
  const text = await readTextArtifact({...input, pathValue: getPayloadPath(input.layout, 'articles')})

  return parseProjectTransferPayload('articles', text)
}

const hasMatchingPromotionMetadata = (
  left: ProjectTransferCommitAssetPromotionPlanEntry,
  right: ProjectTransferCommitAssetPromotionPlanEntry,
) => {
  return (
    left.byteLength === right.byteLength
    && left.checksumSha256 === right.checksumSha256
    && (left.contentType ?? null) === (right.contentType ?? null)
  )
}

const getPromotionPlanRecords = (
  entries: readonly ProjectTransferCommitAssetPromotionPlanEntry[],
): ProjectTransferCommitPromotionPlanRecord[] => {
  const state = entries.reduce<{
    entriesByPackagePath: Map<string, ProjectTransferCommitPromotionPlanRecord>
    records: ProjectTransferCommitPromotionPlanRecord[]
  }>(
    (current, entry, planIndex) => {
      const existing = current.entriesByPackagePath.get(entry.packagePath)

      if (existing !== undefined) {
        if (!hasMatchingPromotionMetadata(existing.entry, entry)) {
          return getCommitPromotionError(`conflicting promotion metadata for ${entry.packagePath}`)
        }

        return current
      }

      const record = {entry, planIndex}
      current.entriesByPackagePath.set(entry.packagePath, record)
      current.records.push(record)

      return current
    },
    {entriesByPackagePath: new Map(), records: []},
  )

  return state.records
}

const getSafePromotionExtension = (contentType: string | null | undefined) => {
  return contentType ? (contentTypeExtensions[contentType.toLowerCase()] ?? '') : ''
}

const getPromotionDestinationPath = ({
  contentType,
  planIndex,
  sessionId,
  checksumSha256,
}: {
  checksumSha256: string
  contentType?: string | null
  planIndex: number
  sessionId: string
}) => {
  const paddedIndex = String(planIndex + 1).padStart(6, '0')
  const extension = getSafePromotionExtension(contentType)

  return `assets/project-transfer/${sessionId}/asset-${paddedIndex}-${checksumSha256.slice(0, 16)}${extension}`
}

const getInitialManifestEntry = ({
  record,
  sessionId,
}: {
  record: ProjectTransferCommitPromotionPlanRecord
  sessionId: string
}): ProjectTransferCommitPromotionManifestEntry => {
  const promotedPath = getPromotionDestinationPath({
    checksumSha256: record.entry.checksumSha256,
    contentType: record.entry.contentType,
    planIndex: record.planIndex,
    sessionId,
  })

  resolveProjectTransferPromotionWritablePath({pathValue: promotedPath})

  return {
    byteLength: record.entry.byteLength,
    checksumSha256: record.entry.checksumSha256,
    ...(record.entry.contentType === undefined ? {} : {contentType: record.entry.contentType}),
    copied: false,
    copiedAt: null,
    copiedByteLength: null,
    copiedChecksumSha256: null,
    packagePath: record.entry.packagePath,
    planIndex: record.planIndex,
    promotedPath,
    sessionId,
  }
}

const getInitialPromotionManifest = ({
  now,
  planRecords,
  sessionId,
}: {
  now: Date
  planRecords: readonly ProjectTransferCommitPromotionPlanRecord[]
  sessionId: string
}): ProjectTransferCommitPromotionManifest => {
  return {
    createdAt: now.toISOString(),
    promotions: planRecords.map((record) => {
      return getInitialManifestEntry({record, sessionId})
    }),
    sessionId,
    updatedAt: now.toISOString(),
  }
}

const writePromotionManifest = async ({
  layout,
  manifest,
  runtimeOptions,
}: {
  layout: ProjectTransferImportTempLayout
  manifest: ProjectTransferCommitPromotionManifest
  runtimeOptions: RuntimePathOptions
}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath({
    ...runtimeOptions,
    pathValue: layout.promotionManifestPath,
  })
  await mkdir(dirname(resolvedPath), {recursive: true})
  await globalThis.Bun.write(resolvedPath, getProjectTransferCanonicalJson(manifest))
}

const getManifestWithPendingEntry = (
  manifest: ProjectTransferCommitPromotionManifest,
  entry: ProjectTransferCommitPromotionManifestEntry,
  now: Date,
) => {
  return {...manifest, promotions: [...manifest.promotions, entry], updatedAt: now.toISOString()}
}

const getManifestWithCopiedEntry = ({
  byteLength,
  checksumSha256,
  entry,
  manifest,
  now,
}: {
  byteLength: number
  checksumSha256: string
  entry: ProjectTransferCommitPromotionManifestEntry
  manifest: ProjectTransferCommitPromotionManifest
  now: Date
}) => {
  return {
    ...manifest,
    promotions: manifest.promotions.map((promotion) => {
      return promotion.packagePath === entry.packagePath
        ? {
            ...promotion,
            copied: true,
            copiedAt: now.toISOString(),
            copiedByteLength: byteLength,
            copiedChecksumSha256: checksumSha256,
          }
        : promotion
    }),
    updatedAt: now.toISOString(),
  }
}

const isMissingFileError = (error: unknown) => {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && ((error as {code: unknown}).code === 'ENOENT' || (error as {code: unknown}).code === 'ENOTDIR')
  )
}

const isExistingFileError = (error: unknown) => {
  return typeof error === 'object' && error !== null && 'code' in error && (error as {code: unknown}).code === 'EEXIST'
}

const getExtractedAssetPath = ({
  entry,
  layout,
  runtimeOptions,
}: {
  entry: ProjectTransferCommitPromotionManifestEntry
  layout: ProjectTransferImportTempLayout
  runtimeOptions: RuntimePathOptions
}) => {
  return resolveProjectTransferArchiveMemberWritablePath({
    ...runtimeOptions,
    archiveMemberPath: entry.packagePath,
    extractionRootPath: layout.extractedPath,
  })
}

const readValidatedExtractedAssetBytes = async ({
  entry,
  layout,
  runtimeOptions,
}: {
  entry: ProjectTransferCommitPromotionManifestEntry
  layout: ProjectTransferImportTempLayout
  runtimeOptions: RuntimePathOptions
}) => {
  const resolvedPath = getExtractedAssetPath({entry, layout, runtimeOptions})
  const stats = await lstat(resolvedPath).catch((error: unknown) => {
    return isMissingFileError(error)
      ? getCommitPromotionError(`missing extracted asset ${entry.packagePath}`)
      : Promise.reject(error)
  })

  if (stats.isSymbolicLink()) {
    return getCommitPromotionError(`extracted asset is a symlink ${entry.packagePath}`)
  }

  if (!stats.isFile()) {
    return getCommitPromotionError(`extracted asset is not a regular file ${entry.packagePath}`)
  }

  const bytes = new Uint8Array(await readFile(resolvedPath))
  const checksumSha256 = getProjectTransferSha256Checksum(bytes)

  if (bytes.byteLength !== entry.byteLength) {
    return getCommitPromotionError(`extracted asset byte length mismatch ${entry.packagePath}`)
  }

  return checksumSha256 === entry.checksumSha256
    ? bytes
    : getCommitPromotionError(`extracted asset checksum mismatch ${entry.packagePath}`)
}

const writeNewRuntimeAsset = async ({
  bytes,
  entry,
  runtimeOptions,
}: {
  bytes: Uint8Array
  entry: ProjectTransferCommitPromotionManifestEntry
  runtimeOptions: RuntimePathOptions
}) => {
  const resolvedPath = resolveProjectTransferPromotionWritablePath({...runtimeOptions, pathValue: entry.promotedPath})
  await mkdir(dirname(resolvedPath), {recursive: true})
  const handle = await open(resolvedPath, 'wx').catch((error: unknown) => {
    return isExistingFileError(error)
      ? getCommitPromotionError(`promotion destination already exists ${entry.promotedPath}`)
      : Promise.reject(error)
  })

  try {
    await handle.writeFile(bytes)
  } catch (error) {
    await handle.close().catch(() => {
      return undefined
    })
    await rm(resolvedPath, {force: true, recursive: false}).catch(() => {
      return undefined
    })
    throw error
  }

  await handle.close()
}

const readCopiedRuntimeAsset = async (
  input: RuntimePathOptions & {entry: ProjectTransferCommitPromotionManifestEntry},
) => {
  const resolvedPath = resolveProjectTransferPromotionWritablePath({...input, pathValue: input.entry.promotedPath})
  const stats = await lstat(resolvedPath)

  if (stats.isSymbolicLink()) {
    return getCommitPromotionError(`promoted asset is a symlink ${input.entry.promotedPath}`)
  }

  if (!stats.isFile()) {
    return getCommitPromotionError(`promoted asset is not a regular file ${input.entry.promotedPath}`)
  }

  const bytes = new Uint8Array(await readFile(resolvedPath))
  const checksumSha256 = getProjectTransferSha256Checksum(bytes)

  if (bytes.byteLength !== input.entry.byteLength) {
    return getCommitPromotionError(`promoted asset byte length mismatch ${input.entry.promotedPath}`)
  }

  return checksumSha256 === input.entry.checksumSha256
    ? {byteLength: bytes.byteLength, checksumSha256}
    : getCommitPromotionError(`promoted asset checksum mismatch ${input.entry.promotedPath}`)
}

const promoteManifestEntry = async ({
  entry,
  layout,
  manifest,
  now,
  runtimeOptions,
}: {
  entry: ProjectTransferCommitPromotionManifestEntry
  layout: ProjectTransferImportTempLayout
  manifest: ProjectTransferCommitPromotionManifest
  now: Date
  runtimeOptions: RuntimePathOptions
}) => {
  const pendingManifest = getManifestWithPendingEntry(manifest, entry, now)
  await writePromotionManifest({layout, manifest: pendingManifest, runtimeOptions})
  const bytes = await readValidatedExtractedAssetBytes({entry, layout, runtimeOptions})
  await writeNewRuntimeAsset({bytes, entry, runtimeOptions})
  const copied = await readCopiedRuntimeAsset({...runtimeOptions, entry})
  const copiedManifest = getManifestWithCopiedEntry({
    byteLength: copied.byteLength,
    checksumSha256: copied.checksumSha256,
    entry,
    manifest: pendingManifest,
    now,
  })
  await writePromotionManifest({layout, manifest: copiedManifest, runtimeOptions})

  return copiedManifest
}

const promoteManifestEntries = async ({
  layout,
  manifest,
  now,
  runtimeOptions,
}: {
  layout: ProjectTransferImportTempLayout
  manifest: ProjectTransferCommitPromotionManifest
  now: Date
  runtimeOptions: RuntimePathOptions
}) => {
  const emptyManifest = {...manifest, promotions: []}
  await writePromotionManifest({layout, manifest: emptyManifest, runtimeOptions})

  return manifest.promotions.reduce<Promise<ProjectTransferCommitPromotionManifest>>(async (previous, entry) => {
    const current = await previous

    return promoteManifestEntry({entry, layout, manifest: current, now, runtimeOptions})
  }, Promise.resolve(emptyManifest))
}

const getPromotionPathByPackagePath = (manifest: ProjectTransferCommitPromotionManifest) => {
  return manifest.promotions.reduce<Record<string, string>>((pathMap, promotion) => {
    return {...pathMap, [promotion.packagePath]: promotion.promotedPath}
  }, {})
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
    return new URL(value.replaceAll('&amp;', '&'), 'http://project-transfer.local')
  } catch {
    return null
  }
}

const isRuntimeAssetUrl = (value: string) => {
  return getRuntimeAssetUrlValue(value)?.pathname === runtimeAssetUrlPath
}

const hasUnsafeLocalPathShape = (value: string) => {
  const trimmed = value.trim()

  return (
    localPathPattern.test(trimmed)
    || posix.isAbsolute(trimmed)
    || win32.isAbsolute(trimmed)
    || trimmed.startsWith('tmp/')
    || trimmed.includes('\\')
  )
}

const isUnsafeAssetString = (value: string) => {
  const trimmed = value.trim()
  const parsedUrl = getUrlValue(trimmed)
  const hasUnsafeProtocol =
    parsedUrl !== null
    && parsedUrl.protocol !== 'data:'
    && parsedUrl.protocol !== 'mailto:'
    && parsedUrl.protocol !== 'tel:'

  return hasUnsafeProtocol || hasUnsafeLocalPathShape(trimmed) || isRuntimeAssetUrl(trimmed)
}

const getPromotedAssetPath = ({
  fieldPath,
  packagePath,
  promotionPathByPackagePath,
}: {
  fieldPath: string
  packagePath: string
  promotionPathByPackagePath: Record<string, string>
}) => {
  const promotedPath = promotionPathByPackagePath[packagePath]

  return promotedPath === undefined
    ? getCommitPromotionError(`${fieldPath} references undeclared asset ${packagePath}`)
    : promotedPath
}

const rewriteRequiredAssetPath = ({
  fieldPath,
  promotionPathByPackagePath,
  value,
}: {
  fieldPath: string
  promotionPathByPackagePath: Record<string, string>
  value: unknown
}) => {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'string') {
    return getCommitPromotionError(`${fieldPath} must be a string or null`)
  }

  const trimmed = value.trim()

  if (isRuntimeAssetUrl(trimmed)) {
    return getCommitPromotionError(`${fieldPath} must not contain a source runtime asset URL`)
  }

  if (!trimmed.startsWith('assets/')) {
    return getCommitPromotionError(
      isUnsafeAssetString(trimmed)
        ? `${fieldPath} contains unsafe source asset reference ${trimmed}`
        : `${fieldPath} must reference a declared package asset`,
    )
  }

  assertPackageAssetPath(trimmed)

  return getPromotedAssetPath({fieldPath, packagePath: trimmed, promotionPathByPackagePath})
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

const rewriteFullTextAssetsString = ({
  fieldPath,
  promotionPathByPackagePath,
  value,
}: {
  fieldPath: string
  promotionPathByPackagePath: Record<string, string>
  value: string
}) => {
  const trimmed = value.trim()

  if (isRuntimeAssetUrl(trimmed)) {
    return getCommitPromotionError(`${fieldPath} must not contain a source runtime asset URL`)
  }

  if (trimmed.startsWith('assets/')) {
    assertPackageAssetPath(trimmed)

    return getPromotedAssetPath({fieldPath, packagePath: trimmed, promotionPathByPackagePath})
  }

  return isUnsafeAssetString(trimmed)
    ? getCommitPromotionError(`${fieldPath} contains unsafe source asset reference ${trimmed}`)
    : value
}

const rewriteFullTextAssetsValue = ({
  fieldPath,
  jsonPointer,
  promotionPathByPackagePath,
  value,
}: {
  fieldPath: string
  jsonPointer: string
  promotionPathByPackagePath: Record<string, string>
  value: unknown
}): unknown => {
  if (typeof value === 'string') {
    return rewriteFullTextAssetsString({fieldPath, promotionPathByPackagePath, value})
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      return rewriteFullTextAssetsValue({
        fieldPath: childFieldPath(fieldPath, index),
        jsonPointer: childPointer(jsonPointer, index),
        promotionPathByPackagePath,
        value: entry,
      })
    })
  }

  if (isRecord(value)) {
    return Object.entries(value).reduce<JsonRecord>((record, [field, entry]) => {
      return {
        ...record,
        [field]: rewriteFullTextAssetsValue({
          fieldPath: childFieldPath(fieldPath, field),
          jsonPointer: childPointer(jsonPointer, field),
          promotionPathByPackagePath,
          value: entry,
        }),
      }
    }, {})
  }

  return value ?? null
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

const rewriteHtmlAttributeValue = ({
  fieldPath,
  promotionPathByPackagePath,
  value,
}: {
  fieldPath: string
  promotionPathByPackagePath: Record<string, string>
  value: string
}) => {
  const trimmed = value.trim()

  if (isRuntimeAssetUrl(trimmed)) {
    return getCommitPromotionError(`${fieldPath} must not contain a source runtime asset URL`)
  }

  if (trimmed.startsWith('assets/')) {
    assertPackageAssetPath(trimmed)

    return getPromotedAssetPath({fieldPath, packagePath: trimmed, promotionPathByPackagePath})
  }

  return hasUnsafeLocalPathShape(trimmed)
    ? getCommitPromotionError(`${fieldPath} contains unsafe source asset reference ${trimmed}`)
    : value
}

const rewriteFullTextHtml = ({
  fieldPath,
  promotionPathByPackagePath,
  value,
}: {
  fieldPath: string
  promotionPathByPackagePath: Record<string, string>
  value: unknown
}) => {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'string') {
    return getCommitPromotionError(`${fieldPath} must be a string or null`)
  }

  return value.replace(
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
      const rewrittenValue = rewriteHtmlAttributeValue({fieldPath, promotionPathByPackagePath, value: parts.value})

      return rewrittenValue === parts.value
        ? match
        : `${attribute}${separator}${parts.quote}${rewrittenValue}${parts.quote}`
    },
  )
}

const rewriteArticleFullTextAssetField = ({
  field,
  fieldPath,
  promotionPathByPackagePath,
  value,
}: {
  field: string
  fieldPath: string
  promotionPathByPackagePath: Record<string, string>
  value: unknown
}) => {
  return field === 'fullTextPdf'
    ? rewriteRequiredAssetPath({fieldPath, promotionPathByPackagePath, value})
    : field === 'fullTextAssets'
      ? rewriteFullTextAssetsValue({fieldPath, jsonPointer: '', promotionPathByPackagePath, value})
      : field === 'fullTextHtml'
        ? rewriteFullTextHtml({fieldPath, promotionPathByPackagePath, value})
        : value
}

const rewriteArticleAssetFields = ({
  article,
  articleIndex,
  promotionPathByPackagePath,
}: {
  article: ProjectTransferArticlePayloadRecord
  articleIndex: number
  promotionPathByPackagePath: Record<string, string>
}) => {
  return {
    ...article,
    fullTextAssets: rewriteArticleFullTextAssetField({
      field: 'fullTextAssets',
      fieldPath: `articles[${articleIndex}].fullTextAssets`,
      promotionPathByPackagePath,
      value: article.fullTextAssets,
    }),
    fullTextHtml: rewriteArticleFullTextAssetField({
      field: 'fullTextHtml',
      fieldPath: `articles[${articleIndex}].fullTextHtml`,
      promotionPathByPackagePath,
      value: article.fullTextHtml,
    }),
    fullTextPdf: rewriteArticleFullTextAssetField({
      field: 'fullTextPdf',
      fieldPath: `articles[${articleIndex}].fullTextPdf`,
      promotionPathByPackagePath,
      value: article.fullTextPdf,
    }),
  }
}

const getArticlesBySource = (articles: readonly ProjectTransferArticlePayloadRecord[]) => {
  return articles.reduce<Map<string, {article: ProjectTransferArticlePayloadRecord; index: number}>>(
    (articleMap, article, index) => {
      articleMap.set(article.sourceArticleId, {article, index})

      return articleMap
    },
    new Map(),
  )
}

const getArticleCreates = ({
  articles,
  plan,
  promotionPathByPackagePath,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  plan: ProjectTransferImportPlanArtifact
  promotionPathByPackagePath: Record<string, string>
}) => {
  const articlesBySource = getArticlesBySource(articles)

  return plan.targetPlan.articleMatches
    .filter((match) => {
      return match.action === 'create'
    })
    .map((match): ProjectTransferCommitArticleCreate => {
      const entry = articlesBySource.get(match.sourceArticleId)

      return entry === undefined
        ? getCommitPromotionError(`missing article payload for ${match.sourceArticleId}`)
        : {
            article: rewriteArticleAssetFields({
              article: entry.article,
              articleIndex: entry.index,
              promotionPathByPackagePath,
            }),
            sourceArticleId: match.sourceArticleId,
          }
    })
}

const getArticleFieldFills = ({
  plan,
  promotionPathByPackagePath,
}: {
  plan: ProjectTransferImportPlanArtifact
  promotionPathByPackagePath: Record<string, string>
}) => {
  return plan.targetPlan.articleUpdatePlan.flatMap((articlePlan) => {
    return articlePlan.fieldFills.map((fieldFill): ProjectTransferCommitArticleFieldFill => {
      return {
        field: fieldFill.field,
        sourceArticleId: articlePlan.sourceArticleId,
        targetArticleId: articlePlan.targetArticleId,
        value: rewriteArticleFullTextAssetField({
          field: fieldFill.field,
          fieldPath: `articles.${articlePlan.sourceArticleId}.${fieldFill.field}`,
          promotionPathByPackagePath,
          value: fieldFill.value,
        }),
      }
    })
  })
}

const getRollbackManifestEntry = (value: unknown): ProjectTransferCommitPromotionManifestEntry | null => {
  if (!isRecord(value) || typeof value.promotedPath !== 'string' || typeof value.sessionId !== 'string') {
    return null
  }

  return value as ProjectTransferCommitPromotionManifestEntry
}

const getPromotionManifestEntries = (value: unknown) => {
  const manifest = isRecord(value) ? value : {}
  const candidates = [manifest.promotions, manifest.promotedAssets, manifest.assets].find((entry) => {
    return Array.isArray(entry)
  })

  return Array.isArray(candidates)
    ? candidates.map(getRollbackManifestEntry).filter((entry): entry is ProjectTransferCommitPromotionManifestEntry => {
        return entry !== null
      })
    : []
}

const readPromotionManifest = async ({
  layout,
  runtimeOptions,
}: {
  layout: ProjectTransferImportTempLayout
  runtimeOptions: RuntimePathOptions
}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath({
    ...runtimeOptions,
    pathValue: layout.promotionManifestPath,
  })
  const file = globalThis.Bun.file(resolvedPath)

  return (await file.exists())
    ? (JSON.parse(await file.text()) as ProjectTransferCommitPromotionManifest)
    : {createdAt: new Date(0).toISOString(), promotions: [], sessionId: '', updatedAt: new Date(0).toISOString()}
}

const isSessionOwnedPromotion = ({
  entry,
  sessionId,
}: {
  entry: ProjectTransferCommitPromotionManifestEntry
  sessionId: string
}) => {
  return entry.sessionId === sessionId && entry.promotedPath.startsWith(`assets/project-transfer/${sessionId}/`)
}

const rollbackPromotionEntry = async ({
  entry,
  runtimeOptions,
  sessionId,
}: {
  entry: ProjectTransferCommitPromotionManifestEntry
  runtimeOptions: RuntimePathOptions
  sessionId: string
}): Promise<ProjectTransferCommitRollbackResult> => {
  if (!isSessionOwnedPromotion({entry, sessionId})) {
    return {deletedPromotedAssetCount: 0, skippedPromotedAssetCount: 1}
  }

  const validation = validateProjectTransferPromotionWritablePath(entry.promotedPath)

  if (!validation.ok) {
    return {deletedPromotedAssetCount: 0, skippedPromotedAssetCount: 1}
  }

  const resolvedPath = resolveProjectTransferPromotionWritablePath({...runtimeOptions, pathValue: entry.promotedPath})
  const exists = await lstat(resolvedPath).then(
    () => {
      return true
    },
    (error: unknown) => {
      return isMissingFileError(error) ? false : Promise.reject(error)
    },
  )

  if (!exists) {
    return {deletedPromotedAssetCount: 0, skippedPromotedAssetCount: 0}
  }

  await rm(resolvedPath, {force: true, recursive: false})

  return {deletedPromotedAssetCount: 1, skippedPromotedAssetCount: 0}
}

const mergeRollbackResult = (
  left: ProjectTransferCommitRollbackResult,
  right: ProjectTransferCommitRollbackResult,
): ProjectTransferCommitRollbackResult => {
  return {
    deletedPromotedAssetCount: left.deletedPromotedAssetCount + right.deletedPromotedAssetCount,
    skippedPromotedAssetCount: left.skippedPromotedAssetCount + right.skippedPromotedAssetCount,
  }
}

export const promoteProjectTransferCommitAssets = async ({
  now: inputNow,
  sessionId,
  ...runtimeOptions
}: PromoteProjectTransferCommitAssetsParams): Promise<ProjectTransferCommitPromotionResult> => {
  const layout = getProjectTransferImportTempLayout(sessionId)
  const now = inputNow ?? new Date()
  const plan = await readPlanArtifact({...runtimeOptions, layout})
  const articles = await readArticlesPayload({...runtimeOptions, layout})
  const planRecords = getPromotionPlanRecords(plan.targetPlan.assetPromotionPlan)
  const initialManifest = getInitialPromotionManifest({now, planRecords, sessionId})
  const manifest = await promoteManifestEntries({layout, manifest: initialManifest, now, runtimeOptions})
  const promotionPathByPackagePath = getPromotionPathByPackagePath(manifest)

  return {
    articleCreates: getArticleCreates({articles, plan, promotionPathByPackagePath}),
    articleFieldFills: getArticleFieldFills({plan, promotionPathByPackagePath}),
    manifest,
    promotionPathByPackagePath,
  }
}

export const rollbackProjectTransferCommitPromotion = async ({
  copiedOnly = false,
  manifest: inputManifest,
  sessionId,
  ...runtimeOptions
}: RollbackProjectTransferCommitPromotionParams): Promise<ProjectTransferCommitRollbackResult> => {
  const layout = getProjectTransferImportTempLayout(sessionId)
  const manifest = inputManifest ?? (await readPromotionManifest({layout, runtimeOptions}))
  const entries = getPromotionManifestEntries(manifest).filter((entry) => {
    return !copiedOnly || entry.copied
  })

  return entries.reduce<Promise<ProjectTransferCommitRollbackResult>>(
    async (previous, entry) => {
      const current = await previous
      const next = await rollbackPromotionEntry({entry, runtimeOptions, sessionId})

      return mergeRollbackResult(current, next)
    },
    Promise.resolve({deletedPromotedAssetCount: 0, skippedPromotedAssetCount: 0}),
  )
}

export const runProjectTransferCommitWithPromotionRollback = async <TResult>({
  work,
  ...promotionParams
}: RunProjectTransferCommitWithPromotionRollbackParams<TResult>): Promise<TResult> => {
  const promotion = await promoteProjectTransferCommitAssets(promotionParams)

  try {
    return await work(promotion)
  } catch (error) {
    await rollbackProjectTransferCommitPromotion({
      cwd: promotionParams.cwd,
      envValues: promotionParams.envValues,
      manifest: promotion.manifest,
      sessionId: promotionParams.sessionId,
    }).catch(() => {
      return undefined
    })
    throw error
  }
}

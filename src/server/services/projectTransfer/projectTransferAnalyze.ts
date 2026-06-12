import {createHash} from 'node:crypto'
import {createWriteStream, type WriteStream} from 'node:fs'
import {mkdir, readFile, rm, statfs} from 'node:fs/promises'
import {dirname} from 'node:path'

import {
  getProjectTransferAnalyzeTargetPlan,
  getProjectTransferAnalyzeTargetPlanWithOperationTables,
  getProjectTransferInitialConflictCounts,
  getProjectTransferInitialOverlapCounts,
  type ProjectTransferAnalyzeTargetRunner,
  type ProjectTransferTargetPlan,
} from './projectTransferAnalyzeTarget.ts'
import {
  type ProjectTransferDependencyStatus,
  type ProjectTransferPlanBlocker,
  type ProjectTransferPlanSummary,
  type ProjectTransferStagedPackageMetadata,
  type ProjectTransferStagedPayloadMetadata,
  type ProjectTransferStagingProgressPayload,
  type ProjectTransferUploadMetadataPayload,
  validateProjectTransferPlanReadyToCommit,
  validateProjectTransferResourceGates,
} from './projectTransferContracts.ts'
import {
  getProjectTransferCanonicalJson,
  getProjectTransferCanonicalNdjson,
  getProjectTransferLegacyPackageFingerprint,
  getProjectTransferLogicalFingerprintValue,
  getProjectTransferLogicalPackageFingerprintPayload,
  getProjectTransferPackageFingerprint,
  getProjectTransferSha256Checksum,
} from './projectTransferFingerprint.ts'
import {parseProjectTransferManifestJson} from './projectTransferManifest.ts'
import {
  resolveProjectTransferArchiveMemberWritablePath,
  resolveProjectTransferTempWritablePath,
} from './projectTransferPaths.ts'
import {
  assertProjectTransferPayload,
  parseProjectTransferPayload,
  type ProjectTransferAssetManifestEntry,
  type ProjectTransferAssetReference,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  type ProjectTransferPayloadRecord,
  serializeProjectTransferPayload,
  serializeProjectTransferPayloadNdjsonRow,
  validateProjectTransferPayloadRow,
} from './projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPerformanceMetrics,
  getProjectTransferPerformanceRowCounters,
  measureProjectTransferPhase,
  projectTransferMetricUnavailable,
  type ProjectTransferMetricValue,
  type ProjectTransferPerformanceMetrics,
  type ProjectTransferPerformancePhaseTiming,
} from './projectTransferPerformanceMetrics.ts'
import {
  projectTransferCurrentManifestSchemaVersion,
  type ProjectTransferManifest,
  type ProjectTransferManifestPayload,
  type ProjectTransferPackageWarning,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
  projectTransferSchemaVNextManifestSchemaVersion,
} from './projectTransferSchemas.ts'
import type {ProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {
  getProjectTransferImportStagingLayout,
  mirrorProjectTransferStagingRevisionToLegacyLayout,
  verifyProjectTransferStagingRevision,
} from './projectTransferStaging.ts'
import {
  type ProjectTransferZipJsEntry,
  type ProjectTransferZipJsModule,
  type ProjectTransferZipReadEntry,
  readProjectTransferZipPackage,
} from './projectTransferZip.ts'

type ProjectTransferAnalyzeRuntimeOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

type ProjectTransferPayloadAnalysis = ProjectTransferManifestPayload & {
  actualByteLength: number | null
  actualChecksumSha256: string | null
  actualRecordCount: number | null
  key: ProjectTransferPayloadKey
}

export type ProjectTransferImportAnalysisArtifact = {
  analyzedAt: string
  archive: {expandedBytes: number; memberCount: number; packageChecksumSha256: string; packageSizeBytes: number}
  assetSummary: {
    actualByteLength: number
    actualEntryCount: number
    manifestByteLength: number | null
    manifestEntryCount: number | null
  }
  computedPackageFingerprint: string | null
  manifest: ProjectTransferManifest
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  packageWarnings: ProjectTransferPackageWarning[]
  performanceMetrics?: ProjectTransferPerformanceMetrics
  payloads: Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>
  planRevision: number
  stagedPackage?: ProjectTransferStagedPackageMetadata
  stagingRevision?: number
}

export type ProjectTransferImportPlanArtifact = {
  blockers: ProjectTransferPlanBlocker[]
  canCommit: boolean
  dependencyResolution?: unknown
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  packageWarnings: ProjectTransferPackageWarning[]
  planRevision: number
  resolutionKinds: Record<string, ProjectTransferPlanBlocker['resolutionKind']>
  stagingRevision?: number
  summary: ProjectTransferPlanSummary
  targetPlan: ProjectTransferTargetPlan
}

export type ProjectTransferImportAnalyzeResult = {
  analysis: ProjectTransferImportAnalysisArtifact
  packageFingerprint: string | null
  plan: ProjectTransferImportPlanArtifact
  planSummary: ProjectTransferPlanSummary
  staging: ProjectTransferStagingProgressPayload
  stagingRevision: number
}

type ProjectTransferImportAnalyzeInput = ProjectTransferAnalyzeRuntimeOptions & {
  availableDiskBytes?: number
  layout: ProjectTransferImportTempLayout
  planRevision: number
  runner?: ProjectTransferAnalyzeTargetRunner
  uploadMetadata?: ProjectTransferUploadMetadataPayload | null
  zipModule?: ProjectTransferZipJsModule
}

type JsonMetrics = {depth: number; memberCount: number}

type ProjectTransferStagedPayloadParse = {
  blockers: ProjectTransferPlanBlocker[]
  metadata: ProjectTransferStagedPayloadMetadata
  payload: ProjectTransferPayload
  warnings: ProjectTransferPackageWarning[]
}

type ProjectTransferNdjsonStreamState = {
  blockers: ProjectTransferPlanBlocker[]
  canonicalByteLength: number
  carry: string
  invalidRecordCount: number
  lineNumber: number
  records: unknown[]
  validRecordCount: number
  warnings: ProjectTransferPackageWarning[]
}

const textEncoder = new TextEncoder()
const newlineByte = '\n'.charCodeAt(0)
const ndjsonDecodeChunkBytes = 64 * 1024

const failProjectTransferAnalyze = (code: string, message: string): never => {
  throw new Error(`Project transfer analyze ${code}: ${message}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const hasOwn = (record: Record<string, unknown>, field: string) => {
  return Object.prototype.hasOwnProperty.call(record, field)
}

const getAvailableDiskBytes = async (pathValue: string) => {
  const stats = await statfs(pathValue)

  return Number(stats.bavail) * Number(stats.bsize)
}

const assertResourceGate = (input: Parameters<typeof validateProjectTransferResourceGates>[0], phase: string) => {
  const validation = validateProjectTransferResourceGates(input)

  return validation.ok ? undefined : failProjectTransferAnalyze(`${phase}_resource_gate`, validation.error)
}

const assertUploadChecksum = ({
  bytes,
  uploadMetadata,
}: {
  bytes: Uint8Array
  uploadMetadata?: ProjectTransferUploadMetadataPayload | null
}) => {
  if (uploadMetadata === null || uploadMetadata === undefined) {
    return undefined
  }

  const checksumSha256 = getProjectTransferSha256Checksum(bytes)

  if (uploadMetadata.byteLength !== bytes.byteLength) {
    return failProjectTransferAnalyze(
      'upload_size',
      `uploaded package size changed from ${uploadMetadata.byteLength} to ${bytes.byteLength}`,
    )
  }

  return uploadMetadata.checksumSha256 === checksumSha256
    ? undefined
    : failProjectTransferAnalyze('upload_checksum', 'uploaded package checksum does not match upload metadata')
}

const getEntryMap = (entries: readonly ProjectTransferZipReadEntry[]) => {
  return entries.reduce<Map<string, ProjectTransferZipReadEntry>>((entryMap, entry) => {
    entryMap.set(entry.path, entry)

    return entryMap
  }, new Map())
}

const isUnsafeLegacyArticleRoute = (value: string | null) => {
  return (
    value !== null
    && (value.includes('/api/runtime-asset')
      || value.includes('tmp/project-transfer')
      || /^\/(?!\/)/.test(value)
      || /^[A-Za-z]:[\\/]/.test(value)
      || value.startsWith('file://'))
  )
}

const getSanitizedLegacyArticleRoute = (value: unknown) => {
  return typeof value === 'string' && isUnsafeLegacyArticleRoute(value) ? null : value
}

const sanitizeLegacyArticlePayload = (article: ProjectTransferPayloadRecord) => {
  const importRoute = getSanitizedLegacyArticleRoute(article.importRoute)
  const selectedImportRoute = getSanitizedLegacyArticleRoute(article.selectedImportRoute)

  return importRoute === article.importRoute && selectedImportRoute === article.selectedImportRoute
    ? article
    : {...article, importRoute, selectedImportRoute}
}

const sanitizeLegacyArticlePayloads = (articles: ProjectTransferPayloadRecord[]) => {
  return articles.map((article) => {
    return sanitizeLegacyArticlePayload(article)
  })
}

const sanitizeLegacyPayloads = (
  payloads: Partial<ProjectTransferPayloadByKey>,
): Partial<ProjectTransferPayloadByKey> => {
  return payloads.articles === undefined
    ? payloads
    : {...payloads, articles: sanitizeLegacyArticlePayloads(payloads.articles)}
}

const sumNumbers = (values: readonly number[]) => {
  return values.reduce((total, value) => {
    return total + value
  }, 0)
}

const getMaximumNumber = (values: readonly number[]) => {
  return values.reduce((maximum, value) => {
    return Math.max(maximum, value)
  }, 0)
}

const getNdjsonLineSize = (bytes: Uint8Array) => {
  const state = bytes.reduce(
    (lineState, byte) => {
      return byte === newlineByte
        ? {current: 0, maximum: Math.max(lineState.maximum, lineState.current)}
        : {...lineState, current: lineState.current + 1}
    },
    {current: 0, maximum: 0},
  )

  return Math.max(state.maximum, state.current)
}

const getArchiveNdjsonLineSize = (entries: readonly ProjectTransferZipReadEntry[]) => {
  const ndjsonPayloadPaths = new Set(
    projectTransferPayloadKeys
      .filter((key) => {
        return projectTransferPayloadFormatByKey[key] === 'ndjson'
      })
      .map((key) => {
        return projectTransferPayloadPathByKey[key]
      }),
  )

  return getMaximumNumber(
    entries
      .filter((entry) => {
        return ndjsonPayloadPaths.has(entry.path)
      })
      .map((entry) => {
        return getNdjsonLineSize(entry.bytes)
      }),
  )
}

const getZipEntryRequiredSize = (entry: ProjectTransferZipJsEntry) => {
  const size = entry.uncompressedSize

  return typeof size === 'number' && Number.isInteger(size) && size >= 0
    ? size
    : failProjectTransferAnalyze('zip_metadata', `${entry.filename} is missing required uncompressed size metadata`)
}

const assertArchiveMetadataResourceGate = ({
  availableDiskBytes,
  entries,
  tempRootPath,
  zipBytes,
}: {
  availableDiskBytes: number
  entries: readonly ProjectTransferZipJsEntry[]
  tempRootPath: string
  zipBytes: number
}) => {
  const uncompressedSizes = entries.map(getZipEntryRequiredSize)

  return assertResourceGate(
    {
      archiveInodeCount: entries.length,
      archiveMemberCount: entries.length,
      availableDiskBytes,
      expandedBytes: sumNumbers(uncompressedSizes),
      fileBytes: getMaximumNumber(uncompressedSizes),
      resourcePaths: entries.map((entry) => {
        return {kind: 'archive_member' as const, pathValue: entry.filename}
      }),
      targetWriteBytes: sumNumbers(uncompressedSizes),
      tempRootPath,
      usesStreamingParser: false,
      zipBytes,
    },
    'archive_metadata',
  )
}

const getJsonMetrics = (value: unknown, depth = 0): JsonMetrics => {
  if (Array.isArray(value)) {
    const childMetrics = value.map((entry) => {
      return getJsonMetrics(entry, depth + 1)
    })

    return {
      depth: getMaximumNumber([
        depth,
        ...childMetrics.map((entry) => {
          return entry.depth
        }),
      ]),
      memberCount:
        value.length
        + sumNumbers(
          childMetrics.map((entry) => {
            return entry.memberCount
          }),
        ),
    }
  }

  if (isRecord(value)) {
    const values = Object.values(value)
    const childMetrics = values.map((entry) => {
      return getJsonMetrics(entry, depth + 1)
    })

    return {
      depth: getMaximumNumber([
        depth,
        ...childMetrics.map((entry) => {
          return entry.depth
        }),
      ]),
      memberCount:
        values.length
        + sumNumbers(
          childMetrics.map((entry) => {
            return entry.memberCount
          }),
        ),
    }
  }

  return {depth, memberCount: 0}
}

const getAssetManifestRecordCount = (payload: ProjectTransferPayload) => {
  return (payload as ProjectTransferPayloadByKey['assetManifest']).entries.length
}

const getPayloadRecordCount = (key: ProjectTransferPayloadKey, payload: ProjectTransferPayload | null) => {
  return payload === null
    ? null
    : key === 'project'
      ? 1
      : key === 'assetManifest'
        ? getAssetManifestRecordCount(payload)
        : Array.isArray(payload)
          ? payload.length
          : 0
}

const getCompletePayloadCounts = (
  payloads: Partial<ProjectTransferPayloadByKey>,
  manifest: ProjectTransferManifest,
) => {
  return projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, number>>(
    (counts, key) => {
      const payload: ProjectTransferPayload | null = payloads[key] ?? null
      const count = getPayloadRecordCount(key, payload)

      return {...counts, [key]: count ?? manifest.payloads[key].recordCount}
    },
    {} as Record<ProjectTransferPayloadKey, number>,
  )
}

const getPlanBlocker = ({
  code,
  message,
  scope,
}: {
  code: string
  message: string
  scope: string
}): ProjectTransferPlanBlocker => {
  return {code, message, resolutionKind: 'requires_new_package_or_target_changes', scope}
}

const getPackageWarningsFromRecord = (value: unknown): ProjectTransferPackageWarning[] => {
  return isRecord(value) && Array.isArray(value.warnings) ? (value.warnings as ProjectTransferPackageWarning[]) : []
}

const getPackageWarningsFromPayload = (payload: ProjectTransferPayload): ProjectTransferPackageWarning[] => {
  return Array.isArray(payload)
    ? payload.flatMap((record) => {
        return getPackageWarningsFromRecord(record)
      })
    : getPackageWarningsFromRecord(payload)
}

const getInternalAnnotationBlockersForRecord = ({label, record}: {label: string; record: unknown}) => {
  if (!isRecord(record)) {
    return []
  }

  return ['omissions', 'redactions']
    .filter((field) => {
      return hasOwn(record, field)
    })
    .map((field) => {
      return getPlanBlocker({
        code: 'internal_annotation_in_package',
        message: `${label}.${field} must be collapsed into warnings before package write`,
        scope: label,
      })
    })
}

const getInternalAnnotationBlockers = (key: ProjectTransferPayloadKey, payload: ProjectTransferPayload) => {
  return Array.isArray(payload)
    ? payload.flatMap((record, index) => {
        return getInternalAnnotationBlockersForRecord({label: `${key}[${index}]`, record})
      })
    : getInternalAnnotationBlockersForRecord({label: key, record: payload})
}

const getJsonParseResult = (line: string): {ok: true; value: unknown} | {error: string; ok: false} => {
  try {
    return {ok: true, value: JSON.parse(line) as unknown}
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error), ok: false}
  }
}

const getResolvedPayloadArtifactPath = ({
  extractionRootPath,
  key,
  runtimeOptions,
}: {
  extractionRootPath: string
  key: ProjectTransferPayloadKey
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}) => {
  return resolveProjectTransferArchiveMemberWritablePath({
    ...runtimeOptions,
    archiveMemberPath: projectTransferPayloadPathByKey[key],
    extractionRootPath,
  })
}

const writeTextToStream = async (stream: WriteStream, text: string) => {
  if (stream.write(text)) {
    return undefined
  }

  return new Promise<void>((resolve, reject) => {
    stream.once('drain', resolve)
    stream.once('error', reject)
  })
}

const closeWriteStream = async (stream: WriteStream) => {
  return new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

const getByteChunks = (bytes: Uint8Array) => {
  return Array.from({length: Math.ceil(bytes.byteLength / ndjsonDecodeChunkBytes)}, (_value, index) => {
    const start = index * ndjsonDecodeChunkBytes

    return bytes.subarray(start, Math.min(bytes.byteLength, start + ndjsonDecodeChunkBytes))
  })
}

const getStagedNdjsonBlocker = ({
  code,
  key,
  lineNumber,
  message,
}: {
  code: string
  key: ProjectTransferPayloadKey
  lineNumber: number
  message: string
}) => {
  return getPlanBlocker({code, message: `${key}[${lineNumber}] ${message}`, scope: `${key}[${lineNumber}]`})
}

const sanitizeStreamedNdjsonRecord = (key: ProjectTransferPayloadKey, record: ProjectTransferPayloadRecord) => {
  return key === 'articles' ? sanitizeLegacyArticlePayload(record) : record
}

const getStreamedNdjsonLineValue = ({
  key,
  line,
  lineNumber,
}: {
  key: ProjectTransferPayloadKey
  line: string
  lineNumber: number
}): {blocker: ProjectTransferPlanBlocker; ok: false} | {ok: true; value: ProjectTransferPayloadRecord} | null => {
  if (line.trim() === '') {
    return null
  }

  const parsed = getJsonParseResult(line)

  if (!parsed.ok) {
    return {
      blocker: getStagedNdjsonBlocker({
        code: 'payload_row_invalid_json',
        key,
        lineNumber,
        message: `must be valid JSON: ${parsed.error}`,
      }),
      ok: false,
    }
  }

  const validated = validateProjectTransferPayloadRow(key, parsed.value, lineNumber)

  return validated.ok
    ? {ok: true, value: sanitizeStreamedNdjsonRecord(key, validated.value)}
    : {
        blocker: getStagedNdjsonBlocker({
          code: 'payload_row_contract_invalid',
          key,
          lineNumber,
          message: validated.error.message,
        }),
        ok: false,
      }
}

const appendStagedNdjsonLine = async ({
  hash,
  key,
  lineNumber,
  state,
  stream,
  value,
}: {
  hash: ReturnType<typeof createHash>
  key: ProjectTransferPayloadKey
  lineNumber: number
  state: ProjectTransferNdjsonStreamState
  stream: WriteStream
  value: ProjectTransferPayloadRecord
}) => {
  const serializedLine = `${serializeProjectTransferPayloadNdjsonRow(key, value, lineNumber)}\n`
  const lineBytes = textEncoder.encode(serializedLine)

  await writeTextToStream(stream, serializedLine)
  hash.update(lineBytes)
  state.records.push(value)
  state.warnings.push(...getPackageWarningsFromRecord(value))
  state.blockers.push(...getInternalAnnotationBlockersForRecord({label: `${key}[${lineNumber}]`, record: value}))
  state.validRecordCount += 1
  state.canonicalByteLength += lineBytes.byteLength

  return state
}

const processStagedNdjsonLine = async ({
  hash,
  key,
  line,
  state,
  stream,
}: {
  hash: ReturnType<typeof createHash>
  key: ProjectTransferPayloadKey
  line: string
  state: ProjectTransferNdjsonStreamState
  stream: WriteStream
}) => {
  const lineValue = getStreamedNdjsonLineValue({key, line, lineNumber: state.lineNumber})

  if (lineValue === null) {
    return state
  }

  const lineNumber = state.lineNumber
  state.lineNumber += 1

  if (!lineValue.ok) {
    state.blockers.push(lineValue.blocker)
    state.invalidRecordCount += 1

    return state
  }

  return appendStagedNdjsonLine({hash, key, lineNumber, state, stream, value: lineValue.value})
}

const processStagedNdjsonText = async ({
  hash,
  key,
  state,
  stream,
  text,
}: {
  hash: ReturnType<typeof createHash>
  key: ProjectTransferPayloadKey
  state: ProjectTransferNdjsonStreamState
  stream: WriteStream
  text: string
}) => {
  let nextState = state
  let remaining = `${state.carry}${text}`
  let newlineIndex = remaining.indexOf('\n')

  while (newlineIndex !== -1) {
    nextState.carry = ''
    nextState = await processStagedNdjsonLine({
      hash,
      key,
      line: remaining.slice(0, newlineIndex),
      state: nextState,
      stream,
    })
    remaining = remaining.slice(newlineIndex + 1)
    newlineIndex = remaining.indexOf('\n')
  }

  nextState.carry = remaining

  return nextState
}

const parseAndStageNdjsonPayloadEntry = async ({
  entry,
  extractionRootPath,
  key,
  runtimeOptions,
}: {
  entry: ProjectTransferZipReadEntry
  extractionRootPath: string
  key: ProjectTransferPayloadKey
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}): Promise<ProjectTransferStagedPayloadParse> => {
  const resolvedPath = getResolvedPayloadArtifactPath({extractionRootPath, key, runtimeOptions})
  await mkdir(dirname(resolvedPath), {recursive: true})

  const stream = createWriteStream(resolvedPath)
  const hash = createHash('sha256')
  const decoder = new TextDecoder()
  const initialState: ProjectTransferNdjsonStreamState = {
    blockers: [],
    canonicalByteLength: 0,
    carry: '',
    invalidRecordCount: 0,
    lineNumber: 0,
    records: [],
    validRecordCount: 0,
    warnings: [],
  }
  const afterChunks = await getByteChunks(entry.bytes).reduce<Promise<ProjectTransferNdjsonStreamState>>(
    async (statePromise, chunk) => {
      const state = await statePromise

      return processStagedNdjsonText({hash, key, state, stream, text: decoder.decode(chunk, {stream: true})})
    },
    Promise.resolve(initialState),
  )
  const afterFinalDecode = await processStagedNdjsonText({
    hash,
    key,
    state: afterChunks,
    stream,
    text: decoder.decode(),
  })
  const completedState =
    afterFinalDecode.carry === ''
      ? afterFinalDecode
      : await processStagedNdjsonLine({
          hash,
          key,
          line: afterFinalDecode.carry,
          state: {...afterFinalDecode, carry: ''},
          stream,
        })

  await closeWriteStream(stream)

  const payload = assertProjectTransferPayload(key, completedState.records)

  return {
    blockers: completedState.blockers,
    metadata: {
      archiveByteLength: entry.uncompressedSize,
      archiveChecksumSha256: entry.checksumSha256,
      canonicalByteLength: completedState.canonicalByteLength,
      canonicalChecksumSha256: hash.digest('hex'),
      invalidRecordCount: completedState.invalidRecordCount,
      logicalDigestSha256: null,
      recordCount: completedState.validRecordCount,
    },
    payload,
    warnings: completedState.warnings,
  }
}

const parseAndStageJsonPayloadEntry = async ({
  entry,
  extractionRootPath,
  key,
  runtimeOptions,
}: {
  entry: ProjectTransferZipReadEntry
  extractionRootPath: string
  key: ProjectTransferPayloadKey
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}): Promise<ProjectTransferStagedPayloadParse> => {
  const payload = sanitizeLegacyPayloads({[key]: parseProjectTransferPayload(key, entry.bytes)})[
    key
  ] as ProjectTransferPayload
  const serializedPayload = serializeProjectTransferPayload(key, payload as never)
  const serializedBytes = textEncoder.encode(serializedPayload)
  const resolvedPath = getResolvedPayloadArtifactPath({extractionRootPath, key, runtimeOptions})

  await mkdir(dirname(resolvedPath), {recursive: true})
  await globalThis.Bun.write(resolvedPath, serializedPayload)

  return {
    blockers: getInternalAnnotationBlockers(key, payload),
    metadata: {
      archiveByteLength: entry.uncompressedSize,
      archiveChecksumSha256: entry.checksumSha256,
      canonicalByteLength: serializedBytes.byteLength,
      canonicalChecksumSha256: getProjectTransferSha256Checksum(serializedBytes),
      invalidRecordCount: 0,
      logicalDigestSha256: null,
      recordCount: getPayloadRecordCount(key, payload),
    },
    payload,
    warnings: getPackageWarningsFromPayload(payload),
  }
}

const parseAndStagePayloadEntry = (input: {
  entry: ProjectTransferZipReadEntry
  extractionRootPath: string
  key: ProjectTransferPayloadKey
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}) => {
  return projectTransferPayloadFormatByKey[input.key] === 'ndjson'
    ? parseAndStageNdjsonPayloadEntry(input)
    : parseAndStageJsonPayloadEntry(input)
}

const assertPayloadChecksum = ({
  entry,
  manifestPayload,
  scope,
}: {
  entry: ProjectTransferZipReadEntry
  manifestPayload: ProjectTransferManifestPayload
  scope: string
}) => {
  if (entry.checksumSha256 !== manifestPayload.checksumSha256) {
    return failProjectTransferAnalyze('payload_checksum', `${scope} checksum does not match manifest payload checksum`)
  }

  return undefined
}

const parsePayloads = ({
  entriesByPath,
  extractionRootPath,
  manifest,
  runtimeOptions,
}: {
  entriesByPath: Map<string, ProjectTransferZipReadEntry>
  extractionRootPath: string
  manifest: ProjectTransferManifest
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}) => {
  return projectTransferPayloadKeys.reduce<
    Promise<{
      blockers: ProjectTransferPlanBlocker[]
      payloadAnalysis: Partial<Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>>
      payloads: Partial<ProjectTransferPayloadByKey>
      stagedPayloads: Partial<Record<ProjectTransferPayloadKey, ProjectTransferStagedPayloadMetadata>>
      warnings: ProjectTransferPackageWarning[]
    }>
  >(
    async (statePromise, key) => {
      const state = await statePromise
      const manifestPayload = manifest.payloads[key]
      const entry = entriesByPath.get(manifestPayload.path) ?? null

      if (entry === null) {
        return {
          ...state,
          blockers: [
            ...state.blockers,
            getPlanBlocker({
              code: 'missing_payload_file',
              message: `${manifestPayload.path} is missing from the package archive`,
              scope: key,
            }),
          ],
          payloadAnalysis: {
            ...state.payloadAnalysis,
            [key]: {
              ...manifestPayload,
              actualByteLength: null,
              actualChecksumSha256: null,
              actualRecordCount: null,
              key,
            },
          },
          stagedPayloads: {
            ...state.stagedPayloads,
            [key]: {
              archiveByteLength: null,
              archiveChecksumSha256: null,
              canonicalByteLength: null,
              canonicalChecksumSha256: null,
              invalidRecordCount: 0,
              logicalDigestSha256: null,
              recordCount: null,
            },
          },
        }
      }

      assertPayloadChecksum({entry, manifestPayload, scope: key})

      const stagedPayload = await parseAndStagePayloadEntry({entry, extractionRootPath, key, runtimeOptions})
      const payload = stagedPayload.payload
      const recordCount = stagedPayload.metadata.recordCount
      const byteLengthBlocker =
        entry.uncompressedSize === manifestPayload.byteLength
          ? []
          : [
              getPlanBlocker({
                code: 'payload_byte_length_mismatch',
                message: `${key} byteLength is ${entry.uncompressedSize}, expected ${manifestPayload.byteLength}`,
                scope: key,
              }),
            ]
      const recordCountBlocker =
        recordCount === manifestPayload.recordCount
          ? []
          : [
              getPlanBlocker({
                code: 'payload_record_count_mismatch',
                message: `${key} recordCount is ${recordCount}, expected ${manifestPayload.recordCount}`,
                scope: key,
              }),
            ]

      return {
        blockers: [...state.blockers, ...stagedPayload.blockers, ...byteLengthBlocker, ...recordCountBlocker],
        payloadAnalysis: {
          ...state.payloadAnalysis,
          [key]: {
            ...manifestPayload,
            actualByteLength: entry.uncompressedSize,
            actualChecksumSha256: entry.checksumSha256,
            actualRecordCount: recordCount,
            key,
          },
        },
        payloads: {...state.payloads, [key]: payload},
        stagedPayloads: {...state.stagedPayloads, [key]: stagedPayload.metadata},
        warnings: [...state.warnings, ...stagedPayload.warnings],
      }
    },
    Promise.resolve({
      blockers: [],
      payloadAnalysis: {},
      payloads: {},
      stagedPayloads: {},
      warnings: manifest.warnings ?? [],
    }),
  )
}

const getPayloadAnalysisRecord = (
  payloadAnalysis: Partial<Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>>,
  manifest: ProjectTransferManifest,
) => {
  return projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>>(
    (analysis, key) => {
      const entry = payloadAnalysis[key]
      const manifestPayload = manifest.payloads[key]

      return {
        ...analysis,
        [key]: entry ?? {
          ...manifestPayload,
          actualByteLength: null,
          actualChecksumSha256: null,
          actualRecordCount: null,
          key,
        },
      }
    },
    {} as Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>,
  )
}

const getProjectSummaryBlockers = ({
  manifest,
  payloads,
}: {
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const project = payloads.project ?? null
  const counts = getCompletePayloadCounts(payloads, manifest)
  const countBlockers = projectTransferPayloadKeys
    .filter((key) => {
      return manifest.project.counts[key] !== counts[key]
    })
    .map((key) => {
      return getPlanBlocker({
        code: 'project_summary_count_mismatch',
        message: `manifest project count ${key} is ${manifest.project.counts[key]}, actual count is ${counts[key]}`,
        scope: `manifest.project.counts.${key}`,
      })
    })

  if (project === null) {
    return [
      ...countBlockers,
      getPlanBlocker({
        code: 'project_payload_missing',
        message: 'project.json is required to validate the manifest project summary',
        scope: 'project',
      }),
    ]
  }

  const projectFieldBlockers = [
    ['name', manifest.project.name, project.name],
    ['sourceProjectId', manifest.project.sourceProjectId, project.sourceProjectId],
    ['humanJudgmentMode', manifest.project.humanJudgmentMode, project.settings.humanJudgmentMode],
  ]
    .filter(([_field, manifestValue, projectValue]) => {
      return manifestValue !== projectValue
    })
    .map(([field, manifestValue, projectValue]) => {
      return getPlanBlocker({
        code: 'project_summary_field_mismatch',
        message: `manifest project ${field} is ${String(manifestValue)}, project payload has ${String(projectValue)}`,
        scope: `manifest.project.${field}`,
      })
    })

  return [...countBlockers, ...projectFieldBlockers]
}

const getCurrentModelSummary = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  const project = payloads.project ?? null
  const models = payloads.models ?? []
  const projectModelSignature = project === null ? null : getProjectTransferCanonicalJson(project.modelSignature)
  const model =
    projectModelSignature === null
      ? null
      : (models.find((entry) => {
          return getProjectTransferCanonicalJson(entry.signature) === projectModelSignature
        }) ?? null)

  return {
    modelName: typeof model?.modelName === 'string' ? model.modelName : null,
    remoteModelId: typeof model?.remoteModelId === 'string' ? model.remoteModelId : null,
    sourceModelId: typeof model?.sourceModelId === 'string' ? model.sourceModelId : null,
  }
}

const getCurrentModelBlockers = ({
  manifest,
  payloads,
}: {
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const currentModel = getCurrentModelSummary(payloads)

  return (['modelName', 'remoteModelId', 'sourceModelId'] as const)
    .filter((field) => {
      return manifest.project.currentModel[field] !== currentModel[field]
    })
    .map((field) => {
      return getPlanBlocker({
        code: 'project_current_model_mismatch',
        message:
          `manifest project currentModel.${field} is ${String(manifest.project.currentModel[field])}, `
          + `payload model has ${String(currentModel[field])}`,
        scope: `manifest.project.currentModel.${field}`,
      })
    })
}

const getPayloadPathSet = () => {
  return new Set(
    projectTransferPayloadKeys.map((key) => {
      return projectTransferPayloadPathByKey[key]
    }),
  )
}

const getAssetManifest = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  return payloads.assetManifest ?? {entries: []}
}

const getAssetEntryMap = (assetEntries: readonly ProjectTransferAssetManifestEntry[]) => {
  return assetEntries.reduce<Map<string, ProjectTransferAssetManifestEntry>>((entryMap, entry) => {
    entryMap.set(entry.packagePath, entry)

    return entryMap
  }, new Map())
}

const getArchiveAssetEntries = (entries: readonly ProjectTransferZipReadEntry[]) => {
  const payloadPaths = getPayloadPathSet()

  return entries.filter((entry) => {
    return entry.path !== 'manifest.json' && !payloadPaths.has(entry.path)
  })
}

const getAssetReferenceBlockers = (assetEntry: ProjectTransferAssetManifestEntry) => {
  const payloadPaths = getPayloadPathSet()

  return assetEntry.references
    .filter((reference: ProjectTransferAssetReference) => {
      return !payloadPaths.has(reference.payloadFile)
    })
    .map((reference) => {
      return getPlanBlocker({
        code: 'asset_reference_payload_missing',
        message: `${assetEntry.packagePath} references unknown payload file ${reference.payloadFile}`,
        scope: `assetManifest.${assetEntry.packagePath}`,
      })
    })
}

const assertAssetChecksum = ({
  assetEntry,
  zipEntry,
}: {
  assetEntry: ProjectTransferAssetManifestEntry
  zipEntry: ProjectTransferZipReadEntry
}) => {
  return zipEntry.checksumSha256 === assetEntry.checksumSha256
    ? undefined
    : failProjectTransferAnalyze(
        'asset_checksum',
        `${assetEntry.packagePath} checksum does not match assetManifest checksum`,
      )
}

const getAssetBlockers = ({
  archiveEntries,
  manifest,
  payloads,
}: {
  archiveEntries: readonly ProjectTransferZipReadEntry[]
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const assetManifest = getAssetManifest(payloads)
  const archiveAssetEntries = getArchiveAssetEntries(archiveEntries)
  const archiveAssetPathSet = new Set(
    archiveAssetEntries.map((entry) => {
      return entry.path
    }),
  )
  const assetEntryMap = getAssetEntryMap(assetManifest.entries)
  const assetManifestBytes = sumNumbers(
    assetManifest.entries.map((entry) => {
      return entry.byteLength
    }),
  )
  const assetZipBytes = sumNumbers(
    archiveAssetEntries.map((entry) => {
      return entry.uncompressedSize
    }),
  )
  const missingAssetBlockers = assetManifest.entries
    .filter((entry) => {
      return !archiveAssetPathSet.has(entry.packagePath)
    })
    .map((entry) => {
      return getPlanBlocker({
        code: 'asset_file_missing',
        message: `${entry.packagePath} is declared in assetManifest but missing from the archive`,
        scope: `assetManifest.${entry.packagePath}`,
      })
    })
  const extraAssetBlockers = archiveAssetEntries
    .filter((entry) => {
      return !assetEntryMap.has(entry.path)
    })
    .map((entry) => {
      return getPlanBlocker({
        code: 'asset_file_undeclared',
        message: `${entry.path} exists in the archive but is not declared in assetManifest`,
        scope: entry.path,
      })
    })
  const assetByteBlockers = assetManifest.entries.flatMap((assetEntry) => {
    const zipEntry = archiveAssetEntries.find((entry) => {
      return entry.path === assetEntry.packagePath
    })

    if (zipEntry === undefined) {
      return []
    }

    assertAssetChecksum({assetEntry, zipEntry})

    return zipEntry.uncompressedSize === assetEntry.byteLength
      ? []
      : [
          getPlanBlocker({
            code: 'asset_byte_length_mismatch',
            message:
              `${assetEntry.packagePath} byteLength is ${zipEntry.uncompressedSize}, `
              + `expected ${assetEntry.byteLength}`,
            scope: `assetManifest.${assetEntry.packagePath}`,
          }),
        ]
  })
  const assetSummary = manifest.assetSummary ?? null
  const assetSummaryBlockers =
    assetSummary === null
      ? [
          getPlanBlocker({
            code: 'asset_summary_missing',
            message: 'manifest assetSummary is required',
            scope: 'manifest.assetSummary',
          }),
        ]
      : [
          ...(assetSummary.entryCount === assetManifest.entries.length
            ? []
            : [
                getPlanBlocker({
                  code: 'asset_summary_count_mismatch',
                  message:
                    `manifest assetSummary.entryCount is ${assetSummary.entryCount}, `
                    + `actual count is ${assetManifest.entries.length}`,
                  scope: 'manifest.assetSummary.entryCount',
                }),
              ]),
          ...(assetSummary.byteLength === assetManifestBytes && assetManifestBytes === assetZipBytes
            ? []
            : [
                getPlanBlocker({
                  code: 'asset_summary_byte_length_mismatch',
                  message:
                    `manifest assetSummary.byteLength is ${assetSummary.byteLength}, `
                    + `assetManifest has ${assetManifestBytes}, archive has ${assetZipBytes}`,
                  scope: 'manifest.assetSummary.byteLength',
                }),
              ]),
        ]

  return [
    ...missingAssetBlockers,
    ...extraAssetBlockers,
    ...assetByteBlockers,
    ...assetManifest.entries.flatMap(getAssetReferenceBlockers),
    ...assetSummaryBlockers,
  ]
}

const getPackageFingerprintBlockers = ({
  computedPackageFingerprint,
  legacyPackageFingerprint,
  manifest,
}: {
  computedPackageFingerprint: string | null
  legacyPackageFingerprint: string | null
  manifest: ProjectTransferManifest
}) => {
  if (manifest.packageFingerprint === undefined || manifest.packageFingerprint === null) {
    return [
      getPlanBlocker({
        code: 'package_fingerprint_missing',
        message: 'manifest packageFingerprint is required for duplicate detection',
        scope: 'manifest.packageFingerprint',
      }),
    ]
  }

  return computedPackageFingerprint === manifest.packageFingerprint
    || legacyPackageFingerprint === manifest.packageFingerprint
    ? []
    : [
        getPlanBlocker({
          code: 'package_fingerprint_mismatch',
          message: 'manifest packageFingerprint does not match the analyzed package fingerprint',
          scope: 'manifest.packageFingerprint',
        }),
      ]
}

const getComputedPackageFingerprint = ({
  manifest,
  payloads,
}: {
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const hasEveryPayload = projectTransferPayloadKeys.every((key) => {
    return payloads[key] !== undefined
  })

  return hasEveryPayload ? getProjectTransferPackageFingerprint({manifest, payloads}) : null
}

const getSemanticBlockers = ({
  archiveEntries,
  computedPackageFingerprint,
  legacyPackageFingerprint,
  manifest,
  payloads,
}: {
  archiveEntries: readonly ProjectTransferZipReadEntry[]
  computedPackageFingerprint: string | null
  legacyPackageFingerprint: string | null
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  return [
    ...getProjectSummaryBlockers({manifest, payloads}),
    ...getCurrentModelBlockers({manifest, payloads}),
    ...getAssetBlockers({archiveEntries, manifest, payloads}),
    ...getPackageFingerprintBlockers({computedPackageFingerprint, legacyPackageFingerprint, manifest}),
  ]
}

const getInitialDependencyStatuses = (
  payloads: Partial<ProjectTransferPayloadByKey>,
): Record<string, ProjectTransferDependencyStatus> => {
  const providerStatuses = (payloads.providerConnections ?? []).reduce<Record<string, ProjectTransferDependencyStatus>>(
    (statuses, provider) => {
      const sourceProviderConnectionId =
        typeof provider.sourceProviderConnectionId === 'string' ? provider.sourceProviderConnectionId : ''

      return sourceProviderConnectionId
        ? {...statuses, [`provider:${sourceProviderConnectionId}`]: 'missing'}
        : statuses
    },
    {},
  )

  return (payloads.models ?? []).reduce<Record<string, ProjectTransferDependencyStatus>>((statuses, model) => {
    const sourceModelId = typeof model.sourceModelId === 'string' ? model.sourceModelId : ''

    return sourceModelId ? {...statuses, [`model:${sourceModelId}`]: 'missing'} : statuses
  }, providerStatuses)
}

const getPlanSummary = ({
  blockers,
  conflictCounts,
  dependencyStatuses,
  judgmentConflictStatus,
  overlapCounts,
  packageCounts,
  packageFingerprint,
  packageWarnings,
}: {
  blockers: ProjectTransferPlanBlocker[]
  conflictCounts: ProjectTransferPlanSummary['conflictCounts']
  dependencyStatuses: Record<string, ProjectTransferDependencyStatus>
  judgmentConflictStatus: ProjectTransferPlanSummary['judgmentConflictStatus']
  overlapCounts: ProjectTransferPlanSummary['overlapCounts']
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  packageWarnings: ProjectTransferPackageWarning[]
}): ProjectTransferPlanSummary => {
  return {
    blockerCount: blockers.length,
    blockers,
    conflictCounts,
    dependencyStatuses,
    judgmentConflictStatus,
    overlapCounts,
    packageCounts,
    packageFingerprint,
    packageWarnings,
    warningCount: packageWarnings.length,
  }
}

const getPlanArtifact = ({
  blockers,
  packageCounts,
  packageFingerprint,
  packageWarnings,
  planRevision,
  planSummary,
  stagingRevision,
  targetPlan,
}: {
  blockers: ProjectTransferPlanBlocker[]
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  packageWarnings: ProjectTransferPackageWarning[]
  planRevision: number
  planSummary: ProjectTransferPlanSummary
  stagingRevision: number
  targetPlan: ProjectTransferTargetPlan
}): ProjectTransferImportPlanArtifact => {
  return {
    blockers,
    canCommit: validateProjectTransferPlanReadyToCommit(planSummary).ok,
    packageCounts,
    packageFingerprint,
    packageWarnings,
    planRevision,
    resolutionKinds: blockers.reduce<Record<string, ProjectTransferPlanBlocker['resolutionKind']>>((kinds, blocker) => {
      return {...kinds, [blocker.code]: blocker.resolutionKind}
    }, {}),
    stagingRevision,
    summary: planSummary,
    targetPlan,
  }
}

const writeJsonArtifact = async ({
  pathValue,
  runtimeOptions,
  value,
}: {
  pathValue: string
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
  value: unknown
}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue})
  await mkdir(dirname(resolvedPath), {recursive: true})
  await globalThis.Bun.write(resolvedPath, getProjectTransferCanonicalJson(value))
}

const writeExtractedEntry = async ({
  entry,
  extractionRootPath,
  runtimeOptions,
}: {
  entry: ProjectTransferZipReadEntry
  extractionRootPath: string
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}) => {
  const resolvedPath = resolveProjectTransferArchiveMemberWritablePath({
    ...runtimeOptions,
    archiveMemberPath: entry.path,
    extractionRootPath,
  })
  await mkdir(dirname(resolvedPath), {recursive: true})

  return globalThis.Bun.write(resolvedPath, entry.bytes)
}

const writeExtractedEntries = async ({
  entries,
  extractionRootPath,
  runtimeOptions,
}: {
  entries: readonly ProjectTransferZipReadEntry[]
  extractionRootPath: string
  runtimeOptions: ProjectTransferAnalyzeRuntimeOptions
}) => {
  const resolvedExtractedPath = resolveProjectTransferTempWritablePath({
    ...runtimeOptions,
    pathValue: extractionRootPath,
  })
  await rm(resolvedExtractedPath, {force: true, recursive: true})

  return entries
    .filter((entry) => {
      return entry.path !== 'manifest.json' && !getPayloadPathSet().has(entry.path)
    })
    .reduce<Promise<unknown>>(async (previous, entry) => {
      await previous

      return writeExtractedEntry({entry, extractionRootPath, runtimeOptions})
    }, Promise.resolve())
}

const assertJsonMetricsResourceGate = ({
  availableDiskBytes,
  archiveMemberCount,
  expandedBytes,
  jsonMetrics,
  maxFileBytes,
  maxNdjsonLineBytes,
  resourcePaths,
  tempRootPath,
  zipBytes,
}: {
  archiveMemberCount: number
  availableDiskBytes: number
  expandedBytes: number
  jsonMetrics: JsonMetrics
  maxFileBytes: number
  maxNdjsonLineBytes: number
  resourcePaths: Parameters<typeof validateProjectTransferResourceGates>[0]['resourcePaths']
  tempRootPath: string
  zipBytes: number
}) => {
  return assertResourceGate(
    {
      archiveInodeCount: archiveMemberCount,
      archiveMemberCount,
      availableDiskBytes,
      expandedBytes,
      fileBytes: maxFileBytes,
      jsonDepth: jsonMetrics.depth,
      jsonMemberCount: jsonMetrics.memberCount,
      ndjsonLineBytes: maxNdjsonLineBytes,
      resourcePaths,
      targetWriteBytes: expandedBytes,
      tempRootPath,
      usesStreamingParser: false,
      zipBytes,
    },
    'json',
  )
}

const getManifestPayloadByteTotal = (manifest: ProjectTransferManifest) => {
  return projectTransferPayloadKeys.reduce((total, key) => {
    return total + (manifest.payloads[key]?.byteLength ?? 0)
  }, 0)
}

const getStagingResourceBudgetBytes = ({
  archiveMemberCount,
  expandedBytes,
  manifest,
}: {
  archiveMemberCount: number
  expandedBytes: number
  manifest: ProjectTransferManifest
}) => {
  const payloadBytes = getManifestPayloadByteTotal(manifest)
  const metadataBytes = projectTransferPayloadKeys.length * 256 + archiveMemberCount * 128

  return expandedBytes + payloadBytes + metadataBytes
}

const assertStagingResourceGate = ({
  archiveMemberCount,
  availableDiskBytes,
  expandedBytes,
  manifest,
  maxFileBytes,
  maxNdjsonLineBytes,
  resourcePaths,
  tempRootPath,
  zipBytes,
}: {
  archiveMemberCount: number
  availableDiskBytes: number
  expandedBytes: number
  manifest: ProjectTransferManifest
  maxFileBytes: number
  maxNdjsonLineBytes: number
  resourcePaths: Parameters<typeof validateProjectTransferResourceGates>[0]['resourcePaths']
  tempRootPath: string
  zipBytes: number
}) => {
  return assertResourceGate(
    {
      archiveInodeCount: archiveMemberCount,
      archiveMemberCount,
      availableDiskBytes,
      expandedBytes,
      fileBytes: maxFileBytes,
      ndjsonLineBytes: maxNdjsonLineBytes,
      resourcePaths,
      targetWriteBytes: getStagingResourceBudgetBytes({archiveMemberCount, expandedBytes, manifest}),
      tempRootPath,
      usesStreamingParser: true,
      zipBytes,
    },
    'staging',
  )
}

const assertActiveImportSchema = (manifest: ProjectTransferManifest) => {
  return manifest.schemaVersion === projectTransferCurrentManifestSchemaVersion
    ? undefined
    : failProjectTransferAnalyze(
        'unsupported_schema_version',
        `schema ${projectTransferSchemaVNextManifestSchemaVersion} import is disabled until exporter/importer cutover`,
      )
}

const getArchiveEntryByteCounts = (entries: readonly ProjectTransferZipReadEntry[]) => {
  return entries.reduce<Record<string, number>>((counts, entry) => {
    return {...counts, [entry.path]: entry.uncompressedSize}
  }, {})
}

const getArchiveEntryChecksums = (entries: readonly ProjectTransferZipReadEntry[]) => {
  return entries.reduce<Record<string, string>>((checksums, entry) => {
    return {...checksums, [entry.path]: entry.checksumSha256}
  }, {})
}

const getMetadataNumberRecord = (
  stagedPayloads: Partial<Record<ProjectTransferPayloadKey, ProjectTransferStagedPayloadMetadata>>,
  field: keyof Pick<ProjectTransferStagedPayloadMetadata, 'canonicalByteLength' | 'recordCount'>,
) => {
  return projectTransferPayloadKeys.reduce<Record<string, number>>((counts, key) => {
    const value = stagedPayloads[key]?.[field]

    return typeof value === 'number' ? {...counts, [key]: value} : counts
  }, {})
}

const getMetadataStringRecord = (
  stagedPayloads: Partial<Record<ProjectTransferPayloadKey, ProjectTransferStagedPayloadMetadata>>,
  field: keyof Pick<ProjectTransferStagedPayloadMetadata, 'canonicalChecksumSha256' | 'logicalDigestSha256'>,
) => {
  return projectTransferPayloadKeys.reduce<Record<string, string>>((checksums, key) => {
    const value = stagedPayloads[key]?.[field]

    return typeof value === 'string' ? {...checksums, [key]: value} : checksums
  }, {})
}

const getLogicalPayloadDigest = ({
  key,
  manifest,
  payload,
}: {
  key: ProjectTransferPayloadKey
  manifest: ProjectTransferManifest
  payload: ProjectTransferPayload
}) => {
  const logicalPayload = getProjectTransferLogicalFingerprintValue(payload)

  return manifest.payloads[key]?.format === 'ndjson' && Array.isArray(logicalPayload)
    ? getProjectTransferSha256Checksum(getProjectTransferCanonicalNdjson(logicalPayload))
    : getProjectTransferSha256Checksum(getProjectTransferCanonicalJson(logicalPayload))
}

const getStagedPayloadsWithLogicalDigests = ({
  manifest,
  payloads,
  stagedPayloads,
}: {
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
  stagedPayloads: Partial<Record<ProjectTransferPayloadKey, ProjectTransferStagedPayloadMetadata>>
}) => {
  return projectTransferPayloadKeys.reduce<
    Partial<Record<ProjectTransferPayloadKey, ProjectTransferStagedPayloadMetadata>>
  >((metadata, key) => {
    const stagedPayload = stagedPayloads[key]
    const payload = payloads[key]

    return stagedPayload === undefined || payload === undefined
      ? metadata
      : {...metadata, [key]: {...stagedPayload, logicalDigestSha256: getLogicalPayloadDigest({key, manifest, payload})}}
  }, {})
}

const getPackageFingerprintInputMetadata = ({
  manifest,
  payloadDigests,
  payloads,
}: {
  manifest: ProjectTransferManifest
  payloadDigests: Record<string, string>
  payloads: Partial<ProjectTransferPayloadByKey>
}): ProjectTransferStagedPackageMetadata['packageFingerprintInputs'] => {
  const fingerprintInputs = getProjectTransferLogicalPackageFingerprintPayload({manifest, payloads})

  return {
    checksumSha256: getProjectTransferSha256Checksum(getProjectTransferCanonicalJson(fingerprintInputs)),
    fingerprintMode: 'logicalPayloads',
    payloadDigests,
    schemaVersion: manifest.schemaVersion,
  }
}

const getStagedPackageMetadata = ({
  archiveEntries,
  assetManifest,
  manifest,
  payloads,
  stagedPayloads,
}: {
  archiveEntries: readonly ProjectTransferZipReadEntry[]
  assetManifest: ProjectTransferPayloadByKey['assetManifest']
  manifest: ProjectTransferManifest
  payloads: Partial<ProjectTransferPayloadByKey>
  stagedPayloads: Partial<Record<ProjectTransferPayloadKey, ProjectTransferStagedPayloadMetadata>>
}): ProjectTransferStagedPackageMetadata => {
  const stagedPayloadsWithDigests = getStagedPayloadsWithLogicalDigests({manifest, payloads, stagedPayloads})
  const payloadDigests = getMetadataStringRecord(stagedPayloadsWithDigests, 'logicalDigestSha256')
  const archiveAssetEntries = getArchiveAssetEntries(archiveEntries)

  return {
    archiveAssetBytes: sumNumbers(
      archiveAssetEntries.map((entry) => {
        return entry.uncompressedSize
      }),
    ),
    archiveEntryByteCounts: getArchiveEntryByteCounts(archiveEntries),
    archiveEntryChecksums: getArchiveEntryChecksums(archiveEntries),
    canonicalPayloadByteCounts: getMetadataNumberRecord(stagedPayloadsWithDigests, 'canonicalByteLength'),
    canonicalPayloadChecksums: getMetadataStringRecord(stagedPayloadsWithDigests, 'canonicalChecksumSha256'),
    declaredAssetBytes: sumNumbers(
      assetManifest.entries.map((entry) => {
        return entry.byteLength
      }),
    ),
    logicalPayloadDigests: payloadDigests,
    packageFingerprintInputs: getPackageFingerprintInputMetadata({manifest, payloadDigests, payloads}),
    payloads: stagedPayloadsWithDigests as Record<string, ProjectTransferStagedPayloadMetadata>,
    rowCounts: getMetadataNumberRecord(stagedPayloadsWithDigests, 'recordCount'),
    sourceProject: {
      exportedAt: manifest.exportedAt,
      humanJudgmentMode: manifest.project.humanJudgmentMode,
      name: manifest.project.name,
      schemaVersion: manifest.schemaVersion,
      sourceAppVersion: manifest.sourceAppVersion,
      sourceProjectId: manifest.project.sourceProjectId,
    },
  }
}

const getAssetReferenceCount = (assetManifest: ProjectTransferPayloadByKey['assetManifest']) => {
  return assetManifest.entries.reduce((total, entry) => {
    return total + entry.references.length
  }, 0)
}

const getPayloadByteCounters = (payloadAnalysis: Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>) => {
  return projectTransferPayloadKeys.reduce<Record<string, ProjectTransferMetricValue>>((counters, key) => {
    return {...counters, [`payload.${key}`]: payloadAnalysis[key].actualByteLength ?? projectTransferMetricUnavailable}
  }, {})
}

const getImportAnalysisPerformanceMetrics = ({
  assetManifest,
  assetSummaryBytes,
  conflictShape,
  expandedBytes,
  packageBytes,
  packageCounts,
  packageFingerprint,
  payloadAnalysis,
  phases,
  schemaVersion,
  warnings,
}: {
  assetManifest: ProjectTransferPayloadByKey['assetManifest']
  assetSummaryBytes: number
  conflictShape: unknown
  expandedBytes: number
  packageBytes: number
  packageCounts: Record<ProjectTransferPayloadKey, number>
  packageFingerprint: string | null
  payloadAnalysis: Record<ProjectTransferPayloadKey, ProjectTransferPayloadAnalysis>
  phases: Partial<
    Record<'payloadParse' | 'stagingLoad' | 'targetAnalysis' | 'zipScan', ProjectTransferPerformancePhaseTiming>
  >
  schemaVersion: number
  warnings: ProjectTransferPackageWarning[]
}) => {
  const rowCounts = getProjectTransferPerformanceRowCounters({
    assetEntryCount: assetManifest.entries.length,
    assetReferenceCount: getAssetReferenceCount(assetManifest),
    payloadCounts: packageCounts,
  })

  return getProjectTransferPerformanceMetrics({
    benchmark: {
      conflictShape,
      finalAssetBytes: assetSummaryBytes,
      packageFingerprint: packageFingerprint ?? undefined,
      schemaVersion,
    },
    bytes: {
      assetBytes: assetSummaryBytes,
      expandedArchiveBytes: expandedBytes,
      packageBytes,
      ...getPayloadByteCounters(payloadAnalysis),
    },
    operation: 'import',
    phases,
    rows: rowCounts,
    usesStreamingParser: true,
    warnings,
  })
}

export const analyzeProjectTransferImportPackage = async (
  input: ProjectTransferImportAnalyzeInput,
): Promise<ProjectTransferImportAnalyzeResult> => {
  const runtimeOptions = {cwd: input.cwd, envValues: input.envValues}
  const rootPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: input.layout.rootPath})
  await mkdir(rootPath, {recursive: true})
  const stagingRevision = input.planRevision
  const stagingLayout = getProjectTransferImportStagingLayout({layout: input.layout, stagingRevision})
  const availableDiskBytes = input.availableDiskBytes ?? (await getAvailableDiskBytes(rootPath))
  const uploadPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: input.layout.uploadPath})
  const packageBytes = await readFile(uploadPath)
  const packageChecksumSha256 = getProjectTransferSha256Checksum(packageBytes)

  assertUploadChecksum({bytes: packageBytes, uploadMetadata: input.uploadMetadata})
  assertResourceGate(
    {
      availableDiskBytes,
      fileBytes: packageBytes.byteLength,
      targetWriteBytes: packageBytes.byteLength,
      tempRootPath: input.layout.rootPath,
      usesStreamingParser: false,
      zipBytes: packageBytes.byteLength,
    },
    'pre_extract',
  )

  const zipScan = await measureProjectTransferPhase('zipScan', () => {
    return readProjectTransferZipPackage({
      beforeReadEntries: (entries) => {
        assertArchiveMetadataResourceGate({
          availableDiskBytes,
          entries,
          tempRootPath: input.layout.rootPath,
          zipBytes: packageBytes.byteLength,
        })
      },
      bytes: packageBytes,
      zipModule: input.zipModule,
    })
  })
  const zipPackage = zipScan.value
  const expandedBytes = sumNumbers(
    zipPackage.entries.map((entry) => {
      return entry.uncompressedSize
    }),
  )
  const maxFileBytes = getMaximumNumber(
    zipPackage.entries.map((entry) => {
      return entry.uncompressedSize
    }),
  )
  const maxNdjsonLineBytes = getArchiveNdjsonLineSize(zipPackage.entries)
  const resourcePaths = zipPackage.entries.map((entry) => {
    return {kind: 'archive_member' as const, pathValue: entry.path}
  })

  assertResourceGate(
    {
      archiveInodeCount: zipPackage.entries.length,
      archiveMemberCount: zipPackage.entries.length,
      availableDiskBytes,
      expandedBytes,
      fileBytes: maxFileBytes,
      ndjsonLineBytes: maxNdjsonLineBytes,
      resourcePaths,
      targetWriteBytes: expandedBytes,
      tempRootPath: input.layout.rootPath,
      usesStreamingParser: false,
      zipBytes: packageBytes.byteLength,
    },
    'extract',
  )

  const manifest = parseProjectTransferManifestJson(zipPackage.manifest.bytes)
  assertActiveImportSchema(manifest)
  assertStagingResourceGate({
    archiveMemberCount: zipPackage.entries.length,
    availableDiskBytes,
    expandedBytes,
    manifest,
    maxFileBytes,
    maxNdjsonLineBytes,
    resourcePaths,
    tempRootPath: input.layout.rootPath,
    zipBytes: packageBytes.byteLength,
  })

  const stagingLoad = await measureProjectTransferPhase('stagingLoad', async () => {
    return writeExtractedEntries({
      entries: zipPackage.entries,
      extractionRootPath: stagingLayout.extractedPath,
      runtimeOptions,
    })
  })
  const entriesByPath = getEntryMap(zipPackage.entries)
  const parsedMeasurement = await measureProjectTransferPhase('payloadParse', async () => {
    return parsePayloads({entriesByPath, extractionRootPath: stagingLayout.extractedPath, manifest, runtimeOptions})
  })
  const parsed = parsedMeasurement.value
  const computedPackageFingerprint = getComputedPackageFingerprint({manifest, payloads: parsed.payloads})
  const legacyPackageFingerprint = getProjectTransferLegacyPackageFingerprint(manifest)
  const packageFingerprint = computedPackageFingerprint ?? manifest.packageFingerprint ?? null
  const packageCounts = getCompletePayloadCounts(parsed.payloads, manifest)
  const semanticBlockers = getSemanticBlockers({
    archiveEntries: zipPackage.entries,
    computedPackageFingerprint,
    legacyPackageFingerprint,
    manifest,
    payloads: parsed.payloads,
  })
  const packageContractBlockers = [...parsed.blockers, ...semanticBlockers]
  const targetAnalysisMeasurement = await measureProjectTransferPhase('targetAnalysis', () => {
    return input.runner === undefined
      ? getProjectTransferAnalyzeTargetPlanWithOperationTables({
          cwd: input.cwd,
          envValues: input.envValues,
          layout: stagingLayout,
          packageFingerprint,
          payloads: parsed.payloads,
        })
      : getProjectTransferAnalyzeTargetPlan({packageFingerprint, payloads: parsed.payloads, runner: input.runner})
  })
  const targetAnalysis = targetAnalysisMeasurement.value
  const blockers = [...packageContractBlockers, ...targetAnalysis.blockers]
  const packageWarnings = [...parsed.warnings, ...targetAnalysis.packageWarnings]
  const payloadValues = Object.values(parsed.payloads)
  const jsonMetrics = getJsonMetrics([manifest, ...payloadValues])

  assertJsonMetricsResourceGate({
    archiveMemberCount: zipPackage.entries.length,
    availableDiskBytes,
    expandedBytes,
    jsonMetrics,
    maxFileBytes,
    maxNdjsonLineBytes,
    resourcePaths,
    tempRootPath: input.layout.rootPath,
    zipBytes: packageBytes.byteLength,
  })

  const planSummary = getPlanSummary({
    blockers,
    conflictCounts: {
      ...getProjectTransferInitialConflictCounts(packageContractBlockers.length),
      ...targetAnalysis.conflictCounts,
    },
    dependencyStatuses: getInitialDependencyStatuses(parsed.payloads),
    judgmentConflictStatus: targetAnalysis.judgmentConflictStatus,
    overlapCounts: {...getProjectTransferInitialOverlapCounts(), ...targetAnalysis.overlapCounts},
    packageCounts,
    packageFingerprint,
    packageWarnings,
  })
  const plan = getPlanArtifact({
    blockers,
    packageCounts,
    packageFingerprint,
    packageWarnings,
    planRevision: input.planRevision,
    planSummary,
    stagingRevision,
    targetPlan: targetAnalysis.targetPlan,
  })
  const assetManifest = getAssetManifest(parsed.payloads)
  const assetSummaryBytes = sumNumbers(
    assetManifest.entries.map((entry) => {
      return entry.byteLength
    }),
  )
  const payloadAnalysis = getPayloadAnalysisRecord(parsed.payloadAnalysis, manifest)
  const stagedPackage = getStagedPackageMetadata({
    archiveEntries: zipPackage.entries,
    assetManifest,
    manifest,
    payloads: parsed.payloads,
    stagedPayloads: parsed.stagedPayloads,
  })
  const performanceMetrics = getImportAnalysisPerformanceMetrics({
    assetManifest,
    assetSummaryBytes,
    conflictShape: planSummary.conflictCounts,
    expandedBytes,
    packageBytes: packageBytes.byteLength,
    packageCounts,
    packageFingerprint,
    payloadAnalysis,
    phases: {
      payloadParse: parsedMeasurement.timing,
      stagingLoad: stagingLoad.timing,
      targetAnalysis: targetAnalysisMeasurement.timing,
      zipScan: zipScan.timing,
    },
    schemaVersion: manifest.schemaVersion,
    warnings: packageWarnings,
  })
  const analysis = {
    analyzedAt: new Date().toISOString(),
    archive: {
      expandedBytes,
      memberCount: zipPackage.entries.length,
      packageChecksumSha256,
      packageSizeBytes: packageBytes.byteLength,
    },
    assetSummary: {
      actualByteLength: assetSummaryBytes,
      actualEntryCount: assetManifest.entries.length,
      manifestByteLength: manifest.assetSummary?.byteLength ?? null,
      manifestEntryCount: manifest.assetSummary?.entryCount ?? null,
    },
    computedPackageFingerprint,
    manifest,
    packageCounts,
    packageFingerprint,
    packageWarnings,
    performanceMetrics,
    payloads: payloadAnalysis,
    planRevision: input.planRevision,
    stagedPackage,
    stagingRevision,
  } satisfies ProjectTransferImportAnalysisArtifact

  const completedPerformanceMetrics = getImportAnalysisPerformanceMetrics({
    assetManifest,
    assetSummaryBytes,
    conflictShape: planSummary.conflictCounts,
    expandedBytes,
    packageBytes: packageBytes.byteLength,
    packageCounts,
    packageFingerprint,
    payloadAnalysis,
    phases: {
      payloadParse: parsedMeasurement.timing,
      stagingLoad: stagingLoad.timing,
      targetAnalysis: targetAnalysisMeasurement.timing,
      zipScan: zipScan.timing,
    },
    schemaVersion: manifest.schemaVersion,
    warnings: packageWarnings,
  })
  await writeJsonArtifact({pathValue: stagingLayout.manifestPath, runtimeOptions, value: manifest})
  await writeJsonArtifact({pathValue: stagingLayout.planPath, runtimeOptions, value: plan})
  await writeJsonArtifact({
    pathValue: stagingLayout.analysisPath,
    runtimeOptions,
    value: {...analysis, performanceMetrics: completedPerformanceMetrics},
  })
  const completedAnalysis = {...analysis, performanceMetrics: completedPerformanceMetrics}
  const staging = await verifyProjectTransferStagingRevision({
    analysis: completedAnalysis,
    layout: stagingLayout,
    plan,
    runtimeOptions,
  })
  await mirrorProjectTransferStagingRevisionToLegacyLayout({layout: input.layout, runtimeOptions, stagingLayout})

  return {analysis: completedAnalysis, packageFingerprint, plan, planSummary, staging, stagingRevision}
}

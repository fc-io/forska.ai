import {randomUUID} from 'node:crypto'
import {mkdir, readFile, rm, statfs} from 'node:fs/promises'
import {dirname, join} from 'node:path'

import {Effect} from 'effect'

import packageJson from '../../../../package.json' with {type: 'json'}
import type {ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import {writeRuntimeLogEvent} from '../../utils/runtimeLogger.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {
  getProjectTransferExportExecutionMode,
  type ProjectTransferExecutionMode,
  type ProjectTransferExportReadyPayload,
  type ProjectTransferProgressPayload,
  type ProjectTransferRawArticleProvenanceMode,
  projectTransferResourceGateLimits,
  type ProjectTransferRuntimeEvent,
  validateProjectTransferResourceGates,
} from './projectTransferContracts.ts'
import {
  completeProjectTransferExportStagedPayloads,
  getProjectTransferExportPreflightEstimate,
  type ProjectTransferExportSerializedPayloads,
  type ProjectTransferExportStagedPayloadAssembly,
  serializeProjectTransferExportPayloads,
  stageProjectTransferExportPayloadRows,
} from './projectTransferExport.ts'
import {
  getProjectTransferCanonicalJson,
  getProjectTransferPackageFingerprint,
  getProjectTransferSha256Checksum,
} from './projectTransferFingerprint.ts'
import {buildProjectTransferManifest} from './projectTransferManifest.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import {
  parseProjectTransferPayloadForSchemaVersion,
  type ProjectTransferPackagePayloadByKey,
  type ProjectTransferPayloadByKey,
} from './projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPerformanceMetrics,
  getProjectTransferPerformanceRowCountersFromPayloads,
  measureProjectTransferPhase,
  type ProjectTransferPerformanceMetrics,
} from './projectTransferPerformanceMetrics.ts'
import {
  getProjectTransferPayloadPathForSchemaVersion,
  type ProjectTransferManifest,
  type ProjectTransferManifestPayload,
  projectTransferManifestSchemaVersion,
  type ProjectTransferPackagePayloadKey,
  projectTransferPayloadKeys,
  projectTransferSchemaVNextPayloadKeys,
} from './projectTransferSchemas.ts'
import {
  getProjectTransferExportTempLayout,
  projectTransferExportArtifacts,
  type ProjectTransferExportTempLayout,
} from './projectTransferSession.ts'
import {getProjectTransferSessionRepository} from './projectTransferSessionRepository.ts'
import {
  getProjectTransferZipCrc32Digest,
  type ProjectTransferZipEntryInput,
  type ProjectTransferZipEntryMetadata,
  type ProjectTransferZipJsModule,
  type ProjectTransferZipWrittenFilePackage,
  writeProjectTransferZipPackageToFile,
} from './projectTransferZip.ts'

type ProjectTransferExportRuntimeOptions = {
  availableDiskBytes?: number
  cwd?: string
  envValues?: Record<string, string | undefined>
}

type ProjectTransferExportPackageBuildInput = ProjectTransferExportRuntimeOptions & {
  database?: ReturnType<typeof getAppDatabaseService>
  expiresAt?: Date
  exportedAt?: Date
  heartbeat?: () => Promise<unknown>
  layout: ProjectTransferExportTempLayout
  onProgress?: (progress: ProjectTransferProgressPayload) => Promise<void> | void
  packageOutputPath?: string
  projectId: string
  rawArticleProvenanceMode?: ProjectTransferRawArticleProvenanceMode
  sessionId: string
  zipModule?: ProjectTransferZipJsModule
}

type CreateProjectTransferExportInput = ProjectTransferExportRuntimeOptions & {
  database?: ReturnType<typeof getAppDatabaseService>
  expiresAt?: Date
  exportedAt?: Date
  projectId: string
  rawArticleProvenanceMode?: ProjectTransferRawArticleProvenanceMode
  sessionId?: string
  zipModule?: ProjectTransferZipJsModule
}

type RunProjectTransferExportSessionInput = ProjectTransferExportRuntimeOptions & {
  database?: ReturnType<typeof getAppDatabaseService>
  expiresAt?: Date
  exportedAt?: Date
  ownerToken?: string
  projectId: string
  rawArticleProvenanceMode?: ProjectTransferRawArticleProvenanceMode
  sessionId: string
  zipModule?: ProjectTransferZipJsModule
}
type ProjectTransferExportWrittenPackage = ProjectTransferZipWrittenFilePackage & {bytes: Uint8Array | null}

export type ProjectTransferExportPackageMetadata = {
  byteLength: number
  checksumSha256: string
  downloadUrl: string
  expiresAt: string
  filename: string
  packageFingerprint: string
}

export type ProjectTransferExportQueuedMetadata = Pick<
  ProjectTransferExportPackageMetadata,
  'downloadUrl' | 'expiresAt' | 'filename'
>

export type ProjectTransferExportPackageBuild = {
  assetBytes: number
  executionMode: ProjectTransferExecutionMode
  manifest: ProjectTransferManifest
  metadata: ProjectTransferExportPackageMetadata
  packageBytes: Uint8Array | null
  packagePayloads: ProjectTransferPackagePayloadByKey
  packagePath: string | null
  payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles']
  performanceMetrics: ProjectTransferPerformanceMetrics
  payloads: ProjectTransferPayloadByKey
  serializedPayloads: ProjectTransferExportSerializedPayloads
}

export type ProjectTransferExportCreationResult =
  | {
      executionMode: 'background'
      metadata: ProjectTransferExportQueuedMetadata
      sessionId: string
      session: ProjectTransferSessionRecord | null
    }
  | {
      executionMode: 'inline'
      manifest: ProjectTransferManifest
      metadata: ProjectTransferExportPackageMetadata
      packageBytes: Uint8Array
    }

const manifestPath = 'manifest.json'
const defaultExportSessionTtlMs = 24 * 60 * 60 * 1000
const exportWorkerHeartbeatIntervalMs = 60_000

const getProjectTransferExportPayloadKeys = (): ProjectTransferPackagePayloadKey[] => {
  return projectTransferSchemaVNextPayloadKeys
}

const getNow = (now?: Date) => {
  return now ?? new Date()
}

const getDefaultExpiresAt = (now: Date) => {
  return new Date(now.getTime() + defaultExportSessionTtlMs)
}

const getExportSessionId = (sessionId?: string) => {
  return sessionId ?? `export-${randomUUID()}`
}

const getExportOwnerToken = (ownerToken?: string) => {
  return ownerToken ?? `export-owner-${randomUUID()}`
}

const getExportFilename = (projectId: string, packageFingerprint: string) => {
  return `project-transfer-${projectId}-${packageFingerprint.slice(0, 12)}.zip`
}

const getQueuedExportFilename = (projectId: string, sessionId: string) => {
  return `project-transfer-${projectId}-${sessionId.slice(0, 18)}.zip`
}

const getDownloadUrl = (sessionId: string) => {
  return `/api/projects/export/${encodeURIComponent(sessionId)}/download`
}

const getAvailableDiskBytes = async (pathValue: string) => {
  const stats = await statfs(pathValue)

  return Number(stats.bavail) * Number(stats.bsize)
}

const getExportDiskGateTargetWriteBytes = ({
  assetBytes,
  packageBytes,
  stagedPayloadBytes,
}: {
  assetBytes: number
  packageBytes: number
  stagedPayloadBytes: number
}) => {
  return assetBytes + packageBytes + stagedPayloadBytes
}

const getExportResourcePaths = () => {
  return [
    {kind: 'archive_member' as const, pathValue: manifestPath},
    ...getProjectTransferExportPayloadKeys().map((key) => {
      const pathValue = getProjectTransferPayloadPathForSchemaVersion({
        key,
        schemaVersion: projectTransferManifestSchemaVersion,
      })

      if (pathValue === undefined) {
        throw new Error(`Project transfer export schema ${projectTransferManifestSchemaVersion} does not allow ${key}`)
      }

      return {kind: 'archive_member' as const, pathValue}
    }),
  ]
}

const assertProjectTransferExportDiskGate = ({
  availableDiskBytes,
  estimate,
  phase,
  tempRootPath,
}: {
  availableDiskBytes: number
  estimate: {assetBytes: number; packageBytes: number; stagedPayloadBytes?: number}
  phase: 'export_preflight' | 'export_start'
  tempRootPath: string
}) => {
  const targetWriteBytes = getExportDiskGateTargetWriteBytes({
    assetBytes: estimate.assetBytes,
    packageBytes: estimate.packageBytes,
    stagedPayloadBytes: estimate.stagedPayloadBytes ?? estimate.packageBytes,
  })
  const validation = validateProjectTransferResourceGates({
    archiveInodeCount: getProjectTransferExportPayloadKeys().length + 1,
    archiveMemberCount: getProjectTransferExportPayloadKeys().length + 1,
    availableDiskBytes,
    expandedBytes: estimate.stagedPayloadBytes ?? estimate.packageBytes,
    fileBytes: Math.max(estimate.packageBytes, estimate.assetBytes, estimate.stagedPayloadBytes ?? 0),
    ndjsonLineBytes: projectTransferResourceGateLimits.maxNdjsonLineBytes,
    resourcePaths: getExportResourcePaths(),
    targetWriteBytes,
    tempRootPath,
    usesStreamingParser: true,
    zipBytes: estimate.packageBytes,
  })

  if (!validation.ok) {
    throw new Error(`Project transfer ${phase} resource gate: ${validation.error}`)
  }
}

const assertProjectTransferExportDiskGateForPath = async ({
  estimate,
  input,
  phase,
  resolvedPath,
  tempRootPath,
}: {
  estimate: {assetBytes: number; packageBytes: number; stagedPayloadBytes?: number}
  input: ProjectTransferExportRuntimeOptions
  phase: 'export_preflight' | 'export_start'
  resolvedPath: string
  tempRootPath: string
}) => {
  const availableDiskBytes = input.availableDiskBytes ?? (await getAvailableDiskBytes(resolvedPath))

  return assertProjectTransferExportDiskGate({availableDiskBytes, estimate, phase, tempRootPath})
}

const getPayloadRecordCount = <TKey extends ProjectTransferPackagePayloadKey>(
  key: TKey,
  payload: ProjectTransferPackagePayloadByKey[TKey],
) => {
  return key === 'project'
    ? 1
    : key === 'assetManifest'
      ? (payload as ProjectTransferPayloadByKey['assetManifest']).entries.length
      : Array.isArray(payload)
        ? payload.length
        : 0
}

const getPayloadManifestEntries = (payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles']) => {
  return getProjectTransferExportPayloadKeys().reduce<
    Record<ProjectTransferPackagePayloadKey, ProjectTransferManifest['payloads'][ProjectTransferPackagePayloadKey]>
  >(
    (entries, key) => {
      const file = payloadFiles[key]

      return {
        ...entries,
        [key]: {
          byteLength: file.byteLength,
          checksumSha256: file.checksumSha256,
          format: file.format,
          path: file.path,
          recordCount: file.recordCount,
        } satisfies ProjectTransferManifestPayload,
      }
    },
    {} as Record<
      ProjectTransferPackagePayloadKey,
      ProjectTransferManifest['payloads'][ProjectTransferPackagePayloadKey]
    >,
  )
}

const getPayloadCounts = (payloads: ProjectTransferPackagePayloadByKey) => {
  return getProjectTransferExportPayloadKeys().reduce<Record<ProjectTransferPackagePayloadKey, number>>(
    (counts, key) => {
      return {...counts, [key]: getPayloadRecordCount(key, payloads[key])}
    },
    {} as Record<ProjectTransferPackagePayloadKey, number>,
  )
}

const getStagedPayloadByteCounters = (payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles']) => {
  return getProjectTransferExportPayloadKeys().reduce<Record<string, number>>((counters, key) => {
    return {...counters, [`payload.${key}`]: payloadFiles[key].byteLength}
  }, {})
}

const getEmptySerializedPayloads = () => {
  return projectTransferPayloadKeys.reduce<ProjectTransferExportSerializedPayloads>((payloads, key) => {
    return {...payloads, [key]: ''}
  }, {} as ProjectTransferExportSerializedPayloads)
}

const readPayloadsFromStagedFiles = async (
  payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles'],
) => {
  return getProjectTransferExportPayloadKeys().reduce<Promise<Partial<ProjectTransferPackagePayloadByKey>>>(
    async (previousPayloads, key) => {
      const payloads = await previousPayloads
      const bytes = await readFile(payloadFiles[key].filePath)

      return {
        ...payloads,
        [key]: parseProjectTransferPayloadForSchemaVersion(projectTransferManifestSchemaVersion, key, bytes),
      }
    },
    Promise.resolve({}),
  )
}

const getPayloadsFromStagedFiles = async (
  payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles'],
): Promise<ProjectTransferPackagePayloadByKey> => {
  return (await readPayloadsFromStagedFiles(payloadFiles)) as ProjectTransferPackagePayloadByKey
}

const getCurrentModelSummary = (payloads: ProjectTransferPayloadByKey) => {
  const projectModelSignature = getProjectTransferCanonicalJson(payloads.project.modelSignature)
  const model = payloads.models.find((entry) => {
    return getProjectTransferCanonicalJson(entry.signature) === projectModelSignature
  })

  return {
    modelName: typeof model?.modelName === 'string' ? model.modelName : null,
    remoteModelId: typeof model?.remoteModelId === 'string' ? model.remoteModelId : null,
    sourceModelId: typeof model?.sourceModelId === 'string' ? model.sourceModelId : null,
  }
}

const buildManifest = ({
  assetBytes,
  assembly,
  exportedAt,
  packageFingerprint = null,
  payloadFiles,
}: {
  assetBytes: number
  assembly: ProjectTransferExportStagedPayloadAssembly
  exportedAt: Date
  packageFingerprint?: string | null
  payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles']
}) => {
  return buildProjectTransferManifest({
    assetSummary: {byteLength: assetBytes, entryCount: assembly.assetEntries.length},
    exportedAt: exportedAt.toISOString(),
    packageFingerprint,
    payloads: getPayloadManifestEntries(payloadFiles),
    project: {
      counts: getPayloadCounts(assembly.packagePayloads),
      currentModel: getCurrentModelSummary(assembly.payloads),
      humanJudgmentMode: assembly.payloads.project.settings.humanJudgmentMode,
      name: assembly.payloads.project.name,
      sourceProjectId: assembly.payloads.project.sourceProjectId,
    },
    sourceAppVersion: packageJson.version,
    warnings: assembly.warnings,
  })
}

const getManifestWithFingerprint = async ({
  assetBytes,
  assembly,
  exportedAt,
  payloadFiles,
}: {
  assetBytes: number
  assembly: ProjectTransferExportStagedPayloadAssembly
  exportedAt: Date
  payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles']
}) => {
  const unsignedManifest = buildManifest({assetBytes, assembly, exportedAt, payloadFiles})
  const stagedPayloads = await getPayloadsFromStagedFiles(payloadFiles)
  const packageFingerprint = getProjectTransferPackageFingerprint({
    manifest: unsignedManifest,
    payloads: stagedPayloads,
  })

  return buildManifest({assetBytes, assembly, exportedAt, packageFingerprint, payloadFiles})
}

const getZipEntryMetadata = ({
  byteLength,
  checksumSha256,
  crc32,
}: {
  byteLength: number
  checksumSha256: string
  crc32: number
}): ProjectTransferZipEntryMetadata => {
  return {checksumSha256, crc32, uncompressedSize: byteLength}
}

const getBytesZipEntryMetadata = (bytes: Uint8Array): ProjectTransferZipEntryMetadata => {
  return {
    checksumSha256: getProjectTransferSha256Checksum(bytes),
    crc32: getProjectTransferZipCrc32Digest(bytes),
    uncompressedSize: bytes.byteLength,
  }
}

const getAssetPackageEntry = (entry: ProjectTransferExportStagedPayloadAssembly['assetEntries'][number]) => {
  const metadata = getZipEntryMetadata(entry)

  if (entry.bytes) {
    return {bytes: entry.bytes, metadata, path: entry.path} satisfies ProjectTransferZipEntryInput
  }

  if (entry.filePath) {
    return {filePath: entry.filePath, metadata, path: entry.path} satisfies ProjectTransferZipEntryInput
  }

  throw new Error(`Project transfer export asset entry is missing bytes and file path: ${entry.path}`)
}

const getPackageEntries = ({
  manifest,
  assembly,
}: {
  assembly: ProjectTransferExportStagedPayloadAssembly
  manifest: ProjectTransferManifest
}): ProjectTransferZipEntryInput[] => {
  const manifestBytes = new TextEncoder().encode(getProjectTransferCanonicalJson(manifest))

  return [
    {bytes: manifestBytes, metadata: getBytesZipEntryMetadata(manifestBytes), path: manifestPath},
    ...getProjectTransferExportPayloadKeys().map((key) => {
      const payloadFile = assembly.payloadFiles[key]

      return {filePath: payloadFile.filePath, metadata: getZipEntryMetadata(payloadFile), path: payloadFile.path}
    }),
    ...assembly.assetEntries.map((entry) => {
      return getAssetPackageEntry(entry)
    }),
  ]
}

const writeProjectTransferExportZipPackage = async ({
  entries,
  outputPath,
  readBytes,
}: {
  entries: ReturnType<typeof getPackageEntries>
  outputPath: string
  readBytes: boolean
}): Promise<ProjectTransferExportWrittenPackage> => {
  const writtenPackage = await writeProjectTransferZipPackageToFile({entries, outputPath})

  return {...writtenPackage, bytes: readBytes ? new Uint8Array(await readFile(outputPath)) : null}
}

const getWrittenPackageEntryByPath = (packageArchive: ProjectTransferExportWrittenPackage) => {
  return packageArchive.entries.reduce<Map<string, ProjectTransferExportWrittenPackage['entries'][number]>>(
    (entryMap, entry) => {
      entryMap.set(entry.path, entry)

      return entryMap
    },
    new Map(),
  )
}

const assertWrittenPackageEntry = ({
  byteLength,
  checksumSha256,
  entryByPath,
  path,
}: {
  byteLength: number
  checksumSha256: string
  entryByPath: Map<string, ProjectTransferExportWrittenPackage['entries'][number]>
  path: string
}) => {
  const entry = entryByPath.get(path)

  if (!entry) {
    throw new Error(`Project transfer export package is missing staged entry ${path}`)
  }

  if (entry.uncompressedSize !== byteLength || entry.checksumSha256 !== checksumSha256) {
    throw new Error(`Project transfer export package staged entry changed while writing ${path}`)
  }
}

const assertWrittenProjectTransferExportPackage = ({
  assembly,
  manifest,
  packageArchive,
}: {
  assembly: ProjectTransferExportStagedPayloadAssembly
  manifest: ProjectTransferManifest
  packageArchive: ProjectTransferExportWrittenPackage
}) => {
  const entryByPath = getWrittenPackageEntryByPath(packageArchive)

  getProjectTransferExportPayloadKeys().map((key) => {
    const payload = manifest.payloads[key]

    return assertWrittenPackageEntry({
      byteLength: payload.byteLength,
      checksumSha256: payload.checksumSha256,
      entryByPath,
      path: payload.path,
    })
  })
  assembly.payloads.assetManifest.entries.map((entry) => {
    return assertWrittenPackageEntry({
      byteLength: entry.byteLength,
      checksumSha256: entry.checksumSha256,
      entryByPath,
      path: entry.packagePath,
    })
  })
}

const getErrorLogAttrs = (error: unknown) => {
  return error instanceof Error
    ? {errorMessage: error.message, errorName: error.name}
    : {errorMessage: String(error), errorName: 'Error'}
}

const logProjectTransferExportDetachedWorkerError = (sessionId: string, error: unknown) => {
  writeRuntimeLogEvent({
    attrs: {sessionId, ...getErrorLogAttrs(error)},
    event: 'project_transfer.export_worker.detached_error',
    message: 'Detached project transfer export worker failed',
    severity: 'ERROR',
  })
}

const logProjectTransferExportHeartbeatError = (sessionId: string, error: unknown) => {
  writeRuntimeLogEvent({
    attrs: {sessionId, ...getErrorLogAttrs(error)},
    event: 'project_transfer.export_worker.heartbeat_error',
    message: 'Project transfer export heartbeat failed',
    severity: 'WARN',
  })
}

const runProjectTransferExportHeartbeatOperation = async <TValue>({
  heartbeat,
  operation,
  sessionId,
}: {
  heartbeat: (() => Promise<unknown>) | undefined
  operation: () => Promise<TValue>
  sessionId: string
}) => {
  if (!heartbeat) {
    return operation()
  }

  await heartbeat()

  const interval = setInterval(() => {
    void heartbeat().catch((error) => {
      logProjectTransferExportHeartbeatError(sessionId, error)
    })
  }, exportWorkerHeartbeatIntervalMs)

  return operation().finally(() => {
    clearInterval(interval)
  })
}

const writeExportProgressFile = async ({
  layout,
  progress,
  runtimeOptions,
}: {
  layout: ProjectTransferExportTempLayout
  progress: ProjectTransferProgressPayload
  runtimeOptions: ProjectTransferExportRuntimeOptions
}) => {
  const progressPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.progressPath})
  await mkdir(dirname(progressPath), {recursive: true})
  await globalThis.Bun.write(progressPath, JSON.stringify(progress))
}

const writeExportCompletionFile = async ({
  layout,
  metadata,
  runtimeOptions,
}: {
  layout: ProjectTransferExportTempLayout
  metadata: ProjectTransferExportReadyPayload
  runtimeOptions: ProjectTransferExportRuntimeOptions
}) => {
  const completionPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.completionPath})
  await mkdir(dirname(completionPath), {recursive: true})
  await globalThis.Bun.write(completionPath, JSON.stringify(metadata))
}

const writeManifestArtifact = async ({
  layout,
  manifest,
  runtimeOptions,
}: {
  layout: ProjectTransferExportTempLayout
  manifest: ProjectTransferManifest
  runtimeOptions: ProjectTransferExportRuntimeOptions
}) => {
  const pathValue = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.manifestPath})
  await mkdir(dirname(pathValue), {recursive: true})
  await globalThis.Bun.write(pathValue, getProjectTransferCanonicalJson(manifest))
}

const writePackageArtifact = async ({
  layout,
  packageBytes,
  runtimeOptions,
}: {
  layout: ProjectTransferExportTempLayout
  packageBytes: Uint8Array
  runtimeOptions: ProjectTransferExportRuntimeOptions
}) => {
  const packagePath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.packagePath})
  await mkdir(dirname(packagePath), {recursive: true})
  await globalThis.Bun.write(packagePath, packageBytes)
}

const getRequiredProjectTransferExportPackageBytes = (build: ProjectTransferExportPackageBuild) => {
  if (build.packageBytes === null) {
    throw new Error('Project transfer export package bytes are unavailable')
  }

  return build.packageBytes
}

const writeProjectTransferExportPackageArtifact = async ({
  build,
  layout,
  runtimeOptions,
}: {
  build: ProjectTransferExportPackageBuild
  layout: ProjectTransferExportTempLayout
  runtimeOptions: ProjectTransferExportRuntimeOptions
}) => {
  if (build.packageBytes !== null) {
    await writePackageArtifact({layout, packageBytes: build.packageBytes, runtimeOptions})
  }
}

const getQueuedExportMetadata = ({
  expiresAt,
  projectId,
  sessionId,
}: {
  expiresAt: Date
  projectId: string
  sessionId: string
}): ProjectTransferExportQueuedMetadata => {
  return {
    downloadUrl: getDownloadUrl(sessionId),
    expiresAt: expiresAt.toISOString(),
    filename: getQueuedExportFilename(projectId, sessionId),
  }
}

const getReadyExportPayload = (build: ProjectTransferExportPackageBuild): ProjectTransferExportReadyPayload => {
  return {status: 'ready', ...build.metadata}
}

const getProjectTransferExportManifestRowCount = (manifest: ProjectTransferManifest) => {
  return Object.values(manifest.project.counts).reduce((total, count) => {
    return total + count
  }, 0)
}

const getProjectTransferExportBuildRowCount = (build: ProjectTransferExportPackageBuild) => {
  return getProjectTransferExportManifestRowCount(build.manifest)
}

const getReadyProgress = ({
  build,
  expiresAt,
  startedAt,
}: {
  build: ProjectTransferExportPackageBuild
  expiresAt: Date
  startedAt: Date
}) => {
  const bytesTotal = build.metadata.byteLength
  const rowCount = getProjectTransferExportBuildRowCount(build)

  return getProgress({
    bytesProcessed: bytesTotal,
    bytesTotal,
    expiresAt,
    phase: 'export_package_write',
    performanceMetrics: build.performanceMetrics,
    rowCountProcessed: rowCount,
    rowCountTotal: rowCount,
    startedAt,
    status: 'completed',
    warningCount: build.manifest.warnings?.length ?? 0,
  })
}

const persistCompletedProjectTransferExportBuild = async ({
  build,
  expiresAt,
  input,
  layout,
  sessionId,
  startedAt,
}: {
  build: ProjectTransferExportPackageBuild
  expiresAt: Date
  input: ProjectTransferExportRuntimeOptions
  layout: ProjectTransferExportTempLayout
  sessionId: string
  startedAt: Date
}) => {
  const repository = getProjectTransferSessionRepository()
  const readyPayload = getReadyExportPayload(build)
  const readyProgress = getReadyProgress({build, expiresAt, startedAt})

  await writeProjectTransferExportPackageArtifact({build, layout, runtimeOptions: input})
  await writeManifestArtifact({layout, manifest: build.manifest, runtimeOptions: input})
  await writeExportCompletionFile({layout, metadata: readyPayload, runtimeOptions: input})
  await writeExportProgressFile({layout, progress: readyProgress, runtimeOptions: input})
  writeProjectTransferExportRuntimeEvent({progress: readyProgress, sessionId, state: 'ready'})

  return repository.createProjectTransferSession({
    completionPayload: readyPayload,
    direction: 'export',
    expiresAt,
    id: sessionId,
    packageFingerprint: build.metadata.packageFingerprint,
    progress: readyProgress,
    state: 'ready',
  })
}

const startDetachedProjectTransferExportSession = (input: RunProjectTransferExportSessionInput) => {
  void runProjectTransferExportSession(input).catch((error) => {
    logProjectTransferExportDetachedWorkerError(input.sessionId, error)
  })
}

const getProgress = ({
  bytesProcessed = null,
  bytesTotal = null,
  expiresAt,
  phase,
  performanceMetrics,
  rowCountProcessed = null,
  rowCountTotal = null,
  startedAt,
  status,
  warningCount,
}: {
  bytesProcessed?: number | null
  bytesTotal?: number | null
  expiresAt: Date
  phase: ProjectTransferProgressPayload['phase']
  performanceMetrics?: ProjectTransferPerformanceMetrics
  rowCountProcessed?: number | null
  rowCountTotal?: number | null
  startedAt: Date
  status: 'completed' | 'failed' | 'pending' | 'running'
  warningCount: number
}): ProjectTransferProgressPayload => {
  const percent =
    bytesProcessed !== null && bytesTotal !== null && bytesTotal > 0
      ? Math.min(100, Math.floor((bytesProcessed / bytesTotal) * 100))
      : null
  const updatedAt = new Date().toISOString()

  return {
    ...(bytesProcessed === null ? {} : {bytesProcessed, completedBytes: bytesProcessed}),
    ...(bytesTotal === null ? {} : {bytesTotal, totalBytes: bytesTotal}),
    expiresAt: expiresAt.toISOString(),
    performanceMetrics,
    ...(percent === null ? {} : {percent}),
    phase,
    ...(rowCountProcessed === null ? {} : {completedRows: rowCountProcessed, rowCountProcessed}),
    ...(rowCountTotal === null ? {} : {rowCountTotal, totalRows: rowCountTotal}),
    startedAt: startedAt.toISOString(),
    status,
    updatedAt,
    warningCount,
  }
}

const publishExportBuildProgress = async ({
  bytesProcessed,
  bytesTotal,
  expiresAt,
  input,
  phase,
  rowCountProcessed,
  rowCountTotal,
  startedAt,
  status,
  warningCount = 0,
}: {
  bytesProcessed?: number | null
  bytesTotal?: number | null
  expiresAt: Date
  input: ProjectTransferExportPackageBuildInput
  phase: ProjectTransferProgressPayload['phase']
  rowCountProcessed?: number | null
  rowCountTotal?: number | null
  startedAt: Date
  status: ProjectTransferProgressPayload['status']
  warningCount?: number
}) => {
  await input.onProgress?.(
    getProgress({
      bytesProcessed,
      bytesTotal,
      expiresAt,
      phase,
      rowCountProcessed,
      rowCountTotal,
      startedAt,
      status,
      warningCount,
    }),
  )
}

export const writeProjectTransferExportRuntimeEvent = ({
  eventType = 'export_progress',
  progress,
  sessionId,
  state,
}: {
  eventType?: 'export_progress'
  progress: ProjectTransferProgressPayload
  sessionId: string
  state: ProjectTransferRuntimeEvent['state']
}): ProjectTransferRuntimeEvent => {
  const timestamp = progress.updatedAt ?? new Date().toISOString()
  const event = {
    bytesProcessed: progress.bytesProcessed ?? null,
    bytesTotal: progress.bytesTotal ?? null,
    direction: 'export' as const,
    eventId: randomUUID(),
    eventType,
    phase: progress.phase,
    planRevision: progress.planRevision ?? 0,
    percent: progress.percent ?? null,
    rowCountProcessed: progress.rowCountProcessed ?? null,
    rowCountTotal: progress.rowCountTotal ?? null,
    sessionId,
    state,
    status: progress.status,
    timestamp,
    warningCount: progress.warningCount ?? null,
  }

  writeRuntimeLogEvent({
    attrs: event,
    event: 'project_transfer.export_progress',
    message: 'Project transfer export progress',
    severity: progress.status === 'failed' ? 'ERROR' : 'INFO',
    timestamp,
  })

  return event
}

export const buildProjectTransferExportPackage = async (
  input: ProjectTransferExportPackageBuildInput,
): Promise<ProjectTransferExportPackageBuild> => {
  const exportedAt = getNow(input.exportedAt)
  const expiresAt = input.expiresAt ?? getDefaultExpiresAt(exportedAt)

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const buildPath = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const resolved = resolveProjectTransferTempWritablePath({
              cwd: input.cwd,
              envValues: input.envValues,
              pathValue: input.layout.buildPath,
            })
            await mkdir(resolved, {recursive: true})
            return resolved
          }),
          (resolved) => {
            return Effect.promise(() => {
              return rm(resolved, {force: true, recursive: true})
            })
          },
        )
        const assemblyMeasurement = yield* Effect.promise(() => {
          return measureProjectTransferPhase('exportAssembly', () => {
            return runProjectTransferExportHeartbeatOperation({
              heartbeat: input.heartbeat,
              operation: async () => {
                const database = input.database ?? getAppDatabaseService()
                const estimate = await getProjectTransferExportPreflightEstimate(input.projectId, {
                  cwd: input.cwd,
                  database,
                  envValues: input.envValues,
                  rawArticleProvenanceMode: input.rawArticleProvenanceMode,
                })

                await assertProjectTransferExportDiskGateForPath({
                  estimate,
                  input,
                  phase: 'export_start',
                  resolvedPath: buildPath,
                  tempRootPath: input.layout.rootPath,
                })
                const stagedRows = (await database.transaction((runner) => {
                  return stageProjectTransferExportPayloadRows({
                    database: runner,
                    projectId: input.projectId,
                    rawArticleProvenanceMode: input.rawArticleProvenanceMode,
                    rootPath: buildPath,
                  })
                })) as Awaited<ReturnType<typeof stageProjectTransferExportPayloadRows>>
                await publishExportBuildProgress({
                  expiresAt,
                  input,
                  phase: 'export_asset_staging',
                  startedAt: exportedAt,
                  status: 'running',
                  warningCount: stagedRows.warnings.length,
                })

                return completeProjectTransferExportStagedPayloads({
                  cwd: input.cwd,
                  envValues: input.envValues,
                  rootPath: buildPath,
                  stagedRows,
                })
              },
              sessionId: input.sessionId,
            })
          })
        })
        const assembly = assemblyMeasurement.value
        const assetBytes = assembly.assetEntries.reduce((total, entry) => {
          return total + entry.byteLength
        }, 0)
        yield* Effect.promise(() => {
          return publishExportBuildProgress({
            bytesProcessed: assetBytes,
            bytesTotal: assetBytes,
            expiresAt,
            input,
            phase: 'export_asset_staging',
            startedAt: exportedAt,
            status: 'completed',
            warningCount: assembly.warnings.length,
          })
        })
        const manifest = yield* Effect.promise(() => {
          return getManifestWithFingerprint({assetBytes, assembly, exportedAt, payloadFiles: assembly.payloadFiles})
        })
        const entries = getPackageEntries({assembly, manifest})
        const packageOutputPath = input.packageOutputPath ?? join(buildPath, projectTransferExportArtifacts.package)
        yield* Effect.promise(() => {
          return publishExportBuildProgress({
            expiresAt,
            input,
            phase: 'export_package_write',
            startedAt: exportedAt,
            status: 'running',
            warningCount: assembly.warnings.length,
          })
        })
        const packageWriteMeasurement = yield* Effect.promise(() => {
          return measureProjectTransferPhase('exportPackageWrite', () => {
            return runProjectTransferExportHeartbeatOperation({
              heartbeat: input.heartbeat,
              operation: async () => {
                return writeProjectTransferExportZipPackage({
                  entries,
                  outputPath: packageOutputPath,
                  readBytes: input.packageOutputPath === undefined,
                })
              },
              sessionId: input.sessionId,
            })
          })
        })
        const packageArchive = packageWriteMeasurement.value
        const packageFingerprint = manifest.packageFingerprint ?? ''
        const rowCount = getProjectTransferExportManifestRowCount(manifest)

        yield* Effect.promise(() => {
          return publishExportBuildProgress({
            bytesProcessed: packageArchive.byteLength,
            bytesTotal: packageArchive.byteLength,
            expiresAt,
            input,
            phase: 'export_package_write',
            rowCountProcessed: rowCount,
            rowCountTotal: rowCount,
            startedAt: exportedAt,
            status: 'completed',
            warningCount: assembly.warnings.length,
          })
        })

        assertWrittenProjectTransferExportPackage({assembly, manifest, packageArchive})

        const serializedPayloads = yield* Effect.promise(() => {
          return input.packageOutputPath === undefined
            ? Promise.resolve(serializeProjectTransferExportPayloads(assembly.payloads))
            : Promise.resolve(getEmptySerializedPayloads())
        })
        const metadata = {
          byteLength: packageArchive.byteLength,
          checksumSha256: packageArchive.checksumSha256,
          downloadUrl: getDownloadUrl(input.sessionId),
          expiresAt: expiresAt.toISOString(),
          filename: getExportFilename(input.projectId, packageFingerprint),
          packageFingerprint,
        }
        const executionMode = getProjectTransferExportExecutionMode({assetBytes, packageBytes: metadata.byteLength})
        const performanceMetrics = getProjectTransferPerformanceMetrics({
          benchmark: {
            finalAssetBytes: assetBytes,
            packageFingerprint,
            rawArticleProvenanceMode: input.rawArticleProvenanceMode ?? 'omit',
            schemaVersion: manifest.schemaVersion,
          },
          bytes: {
            assetBytes,
            packageBytes: metadata.byteLength,
            ...getStagedPayloadByteCounters(assembly.payloadFiles),
          },
          operation: 'export',
          phases: {exportAssembly: assemblyMeasurement.timing, exportPackageWrite: packageWriteMeasurement.timing},
          rows: getProjectTransferPerformanceRowCountersFromPayloads(assembly.payloads),
          usesStreamingParser: true,
          warnings: assembly.warnings,
        })

        return {
          assetBytes,
          executionMode,
          manifest,
          metadata,
          packageBytes: packageArchive.bytes,
          packagePayloads: assembly.packagePayloads,
          packagePath: input.packageOutputPath ?? null,
          payloadFiles: assembly.payloadFiles,
          performanceMetrics,
          payloads: assembly.payloads,
          serializedPayloads,
        }
      }),
    ),
  )
}

export const runProjectTransferExportSession = async (input: RunProjectTransferExportSessionInput) => {
  const ownerToken = getExportOwnerToken(input.ownerToken)
  const layout = getProjectTransferExportTempLayout(input.sessionId)
  const startedAt = getNow(input.exportedAt)
  const repository = getProjectTransferSessionRepository()
  const expiresAt = input.expiresAt ?? getDefaultExpiresAt(startedAt)
  const pendingProgress = getProgress({
    expiresAt,
    phase: 'export_assembly',
    startedAt,
    status: 'running',
    warningCount: 0,
  })
  const claim = await repository.claimProjectTransferExportSessionOwner({
    expectedState: 'queued',
    nextState: 'assembling',
    ownerToken,
    progress: pendingProgress,
    sessionId: input.sessionId,
  })

  if (claim === null) {
    return null
  }

  writeProjectTransferExportRuntimeEvent({progress: pendingProgress, sessionId: input.sessionId, state: 'assembling'})

  try {
    const publishSessionProgress = async (progress: ProjectTransferProgressPayload) => {
      const session = await repository.heartbeatProjectTransferExportSessionOwner({
        ownerToken,
        progress,
        sessionId: input.sessionId,
      })

      if (session === null) {
        throw new Error(`Project transfer export session ownership was lost: ${input.sessionId}`)
      }

      writeProjectTransferExportRuntimeEvent({progress, sessionId: input.sessionId, state: session.state})
    }
    const heartbeat = async () => {
      const session = await repository.heartbeatProjectTransferExportSessionOwner({
        ownerToken,
        sessionId: input.sessionId,
      })

      if (session === null) {
        throw new Error(`Project transfer export session ownership was lost: ${input.sessionId}`)
      }

      return session
    }
    const build = await buildProjectTransferExportPackage({
      ...input,
      expiresAt,
      heartbeat,
      layout,
      onProgress: publishSessionProgress,
      packageOutputPath: resolveProjectTransferTempWritablePath({...input, pathValue: layout.packagePath}),
      sessionId: input.sessionId,
    })
    const packagingProgress = getProgress({
      bytesProcessed: build.metadata.byteLength,
      bytesTotal: build.metadata.byteLength,
      expiresAt,
      phase: 'export_package_write',
      performanceMetrics: build.performanceMetrics,
      rowCountProcessed: getProjectTransferExportBuildRowCount(build),
      rowCountTotal: getProjectTransferExportBuildRowCount(build),
      startedAt,
      status: 'completed',
      warningCount: build.manifest.warnings?.length ?? 0,
    })
    const packageClaim = await repository.claimProjectTransferExportSessionOwner({
      expectedState: 'assembling',
      nextState: 'packaging',
      ownerToken,
      progress: packagingProgress,
      sessionId: input.sessionId,
    })

    if (packageClaim === null) {
      return null
    }

    writeProjectTransferExportRuntimeEvent({
      progress: packagingProgress,
      sessionId: input.sessionId,
      state: 'packaging',
    })
    await writeProjectTransferExportPackageArtifact({build, layout, runtimeOptions: input})
    await writeManifestArtifact({layout, manifest: build.manifest, runtimeOptions: input})

    const readyPayload = getReadyExportPayload(build)
    await writeExportCompletionFile({layout, metadata: readyPayload, runtimeOptions: input})
    const readyProgress = getReadyProgress({build, expiresAt, startedAt})

    await writeExportProgressFile({layout, progress: readyProgress, runtimeOptions: input})
    writeProjectTransferExportRuntimeEvent({progress: readyProgress, sessionId: input.sessionId, state: 'ready'})

    return repository.persistProjectTransferSessionExportReady({
      completionPayload: readyPayload,
      ownerToken,
      progress: readyProgress,
      sessionId: input.sessionId,
    })
  } catch (error) {
    const failedProgress = {...pendingProgress, status: 'failed' as const, updatedAt: new Date().toISOString()}
    writeProjectTransferExportRuntimeEvent({progress: failedProgress, sessionId: input.sessionId, state: 'failed'})
    await rm(resolveProjectTransferTempWritablePath({...input, pathValue: layout.rootPath}), {
      force: true,
      recursive: true,
    })
    await repository.failProjectTransferSessionExport({
      error: error instanceof Error ? {message: error.message, name: error.name} : {message: String(error)},
      ownerToken,
      progress: failedProgress,
      sessionId: input.sessionId,
    })
    throw error
  }
}

export const createProjectTransferExport = async (
  input: CreateProjectTransferExportInput,
): Promise<ProjectTransferExportCreationResult> => {
  const exportedAt = getNow(input.exportedAt)
  const expiresAt = input.expiresAt ?? getDefaultExpiresAt(exportedAt)
  const sessionId = getExportSessionId(input.sessionId)
  const layout = getProjectTransferExportTempLayout(sessionId)
  const repository = getProjectTransferSessionRepository()
  const queueExport = async (metadata: ProjectTransferExportQueuedMetadata) => {
    const session = await repository.createProjectTransferSession({
      direction: 'export',
      expiresAt,
      id: sessionId,
      state: 'queued',
    })

    startDetachedProjectTransferExportSession({...input, expiresAt, exportedAt, sessionId})

    return {
      executionMode: 'background' as const,
      metadata: {...metadata, expiresAt: expiresAt.toISOString()},
      session,
      sessionId,
    }
  }
  const preflight = await getProjectTransferExportPreflightEstimate(input.projectId, {
    cwd: input.cwd,
    database: input.database,
    envValues: input.envValues,
    rawArticleProvenanceMode: input.rawArticleProvenanceMode,
  })
  const resolvedRootPath = resolveProjectTransferTempWritablePath({...input, pathValue: layout.rootPath})
  const resolvedRootParentPath = dirname(resolvedRootPath)

  await mkdir(resolvedRootParentPath, {recursive: true})
  await assertProjectTransferExportDiskGateForPath({
    estimate: preflight,
    input,
    phase: 'export_preflight',
    resolvedPath: resolvedRootParentPath,
    tempRootPath: layout.rootPath,
  })

  const preflightExecutionMode = getProjectTransferExportExecutionMode(preflight)

  if (preflightExecutionMode === 'background') {
    return queueExport(getQueuedExportMetadata({expiresAt, projectId: input.projectId, sessionId}))
  }

  const build = await buildProjectTransferExportPackage({...input, expiresAt, exportedAt, layout, sessionId})

  return build.executionMode === 'inline'
    ? {
        executionMode: 'inline',
        manifest: build.manifest,
        metadata: {...build.metadata, expiresAt: expiresAt.toISOString()},
        packageBytes: getRequiredProjectTransferExportPackageBytes(build),
      }
    : {
        executionMode: 'background',
        metadata: {
          downloadUrl: build.metadata.downloadUrl,
          expiresAt: build.metadata.expiresAt,
          filename: build.metadata.filename,
        },
        session: await persistCompletedProjectTransferExportBuild({
          build,
          expiresAt,
          input,
          layout,
          sessionId,
          startedAt: exportedAt,
        }),
        sessionId,
      }
}

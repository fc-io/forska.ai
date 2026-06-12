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
  stageProjectTransferExportPayloadRows,
} from './projectTransferExport.ts'
import {getProjectTransferCanonicalJson, getProjectTransferPackageFingerprint} from './projectTransferFingerprint.ts'
import {buildProjectTransferManifest} from './projectTransferManifest.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import type {ProjectTransferPayloadByKey} from './projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPerformanceMetrics,
  getProjectTransferPerformanceRowCountersFromPayloads,
  measureProjectTransferPhase,
  type ProjectTransferPerformanceMetrics,
} from './projectTransferPerformanceMetrics.ts'
import {
  type ProjectTransferManifest,
  type ProjectTransferManifestPayload,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
} from './projectTransferSchemas.ts'
import {
  getProjectTransferExportTempLayout,
  projectTransferExportArtifacts,
  type ProjectTransferExportTempLayout,
} from './projectTransferSession.ts'
import {getProjectTransferSessionRepository} from './projectTransferSessionRepository.ts'
import {
  type ProjectTransferZipEntryInput,
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
    ...projectTransferPayloadKeys.map((key) => {
      return {kind: 'archive_member' as const, pathValue: projectTransferPayloadPathByKey[key]}
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
    archiveInodeCount: projectTransferPayloadKeys.length + 1,
    archiveMemberCount: projectTransferPayloadKeys.length + 1,
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

const getPayloadRecordCount = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  payload: ProjectTransferPayloadByKey[TKey],
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
  return projectTransferPayloadKeys.reduce<
    Record<ProjectTransferPayloadKey, ProjectTransferManifest['payloads'][ProjectTransferPayloadKey]>
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
    {} as Record<ProjectTransferPayloadKey, ProjectTransferManifest['payloads'][ProjectTransferPayloadKey]>,
  )
}

const getPayloadCounts = (payloads: ProjectTransferPayloadByKey) => {
  return projectTransferPayloadKeys.reduce<Record<ProjectTransferPayloadKey, number>>(
    (counts, key) => {
      return {...counts, [key]: getPayloadRecordCount(key, payloads[key])}
    },
    {} as Record<ProjectTransferPayloadKey, number>,
  )
}

const getStagedPayloadByteCounters = (payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles']) => {
  return projectTransferPayloadKeys.reduce<Record<string, number>>((counters, key) => {
    return {...counters, [`payload.${key}`]: payloadFiles[key].byteLength}
  }, {})
}

const getEmptySerializedPayloads = () => {
  return projectTransferPayloadKeys.reduce<ProjectTransferExportSerializedPayloads>((payloads, key) => {
    return {...payloads, [key]: ''}
  }, {} as ProjectTransferExportSerializedPayloads)
}

const readSerializedPayloadsFromStagedFiles = async (
  payloadFiles: ProjectTransferExportStagedPayloadAssembly['payloadFiles'],
) => {
  return projectTransferPayloadKeys.reduce<Promise<ProjectTransferExportSerializedPayloads>>(
    async (previousPayloads, key) => {
      const payloads = await previousPayloads
      const value = await readFile(payloadFiles[key].filePath, 'utf8')

      return {...payloads, [key]: value}
    },
    Promise.resolve({} as ProjectTransferExportSerializedPayloads),
  )
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
      counts: getPayloadCounts(assembly.payloads),
      currentModel: getCurrentModelSummary(assembly.payloads),
      humanJudgmentMode: assembly.payloads.project.settings.humanJudgmentMode,
      name: assembly.payloads.project.name,
      sourceProjectId: assembly.payloads.project.sourceProjectId,
    },
    sourceAppVersion: packageJson.version,
    warnings: assembly.warnings,
  })
}

const getManifestWithFingerprint = ({
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
  const packageFingerprint = getProjectTransferPackageFingerprint({
    manifest: unsignedManifest,
    payloads: assembly.payloads,
  })

  return buildManifest({assetBytes, assembly, exportedAt, packageFingerprint, payloadFiles})
}

const getAssetPackageEntry = (entry: ProjectTransferExportStagedPayloadAssembly['assetEntries'][number]) => {
  if (entry.bytes) {
    return {bytes: entry.bytes, path: entry.path} satisfies ProjectTransferZipEntryInput
  }

  if (entry.filePath) {
    return {filePath: entry.filePath, path: entry.path} satisfies ProjectTransferZipEntryInput
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
  return [
    {bytes: getProjectTransferCanonicalJson(manifest), path: manifestPath},
    ...projectTransferPayloadKeys.map((key) => {
      return {filePath: assembly.payloadFiles[key].filePath, path: projectTransferPayloadPathByKey[key]}
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

  projectTransferPayloadKeys.map((key) => {
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

const getProjectTransferExportBuildRowCount = (build: ProjectTransferExportPackageBuild) => {
  return Object.values(build.manifest.project.counts).reduce((total, count) => {
    return total + count
  }, 0)
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
  const bytesTotal = build.metadata.byteLength + build.assetBytes
  const rowCount = getProjectTransferExportBuildRowCount(build)

  return getProgress({
    bytesProcessed: bytesTotal,
    bytesTotal,
    expiresAt,
    phase: 'export_package',
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
  bytesProcessed,
  bytesTotal,
  expiresAt,
  phase,
  performanceMetrics,
  rowCountProcessed,
  rowCountTotal,
  startedAt,
  status,
  warningCount,
}: {
  bytesProcessed: number
  bytesTotal: number
  expiresAt: Date
  phase: 'export_assembly' | 'export_package'
  performanceMetrics?: ProjectTransferPerformanceMetrics
  rowCountProcessed: number
  rowCountTotal: number
  startedAt: Date
  status: 'completed' | 'failed' | 'pending' | 'running'
  warningCount: number
}): ProjectTransferProgressPayload => {
  const percent = bytesTotal === 0 ? 100 : Math.min(100, Math.floor((bytesProcessed / bytesTotal) * 100))
  const updatedAt = new Date().toISOString()

  return {
    bytesProcessed,
    bytesTotal,
    completedBytes: bytesProcessed,
    completedRows: rowCountProcessed,
    expiresAt: expiresAt.toISOString(),
    performanceMetrics,
    percent,
    phase,
    rowCountProcessed,
    rowCountTotal,
    startedAt: startedAt.toISOString(),
    status,
    totalBytes: bytesTotal,
    totalRows: rowCountTotal,
    updatedAt,
    warningCount,
  }
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
        const manifest = getManifestWithFingerprint({
          assetBytes,
          assembly,
          exportedAt,
          payloadFiles: assembly.payloadFiles,
        })
        const entries = getPackageEntries({assembly, manifest})
        const packageOutputPath = input.packageOutputPath ?? join(buildPath, projectTransferExportArtifacts.package)
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

        assertWrittenProjectTransferExportPackage({assembly, manifest, packageArchive})

        const serializedPayloads = yield* Effect.promise(() => {
          return input.packageOutputPath === undefined
            ? readSerializedPayloadsFromStagedFiles(assembly.payloadFiles)
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
    bytesProcessed: 0,
    bytesTotal: 0,
    expiresAt,
    phase: 'export_assembly',
    rowCountProcessed: 0,
    rowCountTotal: 0,
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
      packageOutputPath: resolveProjectTransferTempWritablePath({...input, pathValue: layout.packagePath}),
      sessionId: input.sessionId,
    })
    const packagingProgress = getProgress({
      bytesProcessed: build.assetBytes,
      bytesTotal: build.metadata.byteLength + build.assetBytes,
      expiresAt,
      phase: 'export_package',
      performanceMetrics: build.performanceMetrics,
      rowCountProcessed: 0,
      rowCountTotal: 0,
      startedAt,
      status: 'running',
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

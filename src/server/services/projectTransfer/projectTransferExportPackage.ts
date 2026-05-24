import {randomUUID} from 'node:crypto'
import {mkdir, rm} from 'node:fs/promises'
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
  type ProjectTransferRuntimeEvent,
} from './projectTransferContracts.ts'
import {
  getProjectTransferExportPayloads,
  getProjectTransferExportPreflightEstimate,
  type ProjectTransferExportPayloadAssembly,
  type ProjectTransferExportSerializedPayloads,
  serializeProjectTransferExportPayloads,
} from './projectTransferExport.ts'
import {
  getProjectTransferCanonicalJson,
  getProjectTransferPackageFingerprint,
  getProjectTransferSha256Checksum,
} from './projectTransferFingerprint.ts'
import {buildProjectTransferManifest, getProjectTransferManifestPayloadEntry} from './projectTransferManifest.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import type {ProjectTransferPayloadByKey} from './projectTransferPayloadSchemas.ts'
import {
  type ProjectTransferManifest,
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
} from './projectTransferSchemas.ts'
import {getProjectTransferExportTempLayout, type ProjectTransferExportTempLayout} from './projectTransferSession.ts'
import {getProjectTransferSessionRepository} from './projectTransferSessionRepository.ts'
import {type ProjectTransferZipJsModule, writeProjectTransferZipPackage} from './projectTransferZip.ts'

type ProjectTransferExportRuntimeOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

type ProjectTransferExportPackageBuildInput = ProjectTransferExportRuntimeOptions & {
  database?: ReturnType<typeof getAppDatabaseService>
  expiresAt?: Date
  exportedAt?: Date
  heartbeat?: () => Promise<unknown>
  layout: ProjectTransferExportTempLayout
  projectId: string
  sessionId: string
  zipModule?: ProjectTransferZipJsModule
}

type CreateProjectTransferExportInput = ProjectTransferExportRuntimeOptions & {
  database?: ReturnType<typeof getAppDatabaseService>
  expiresAt?: Date
  exportedAt?: Date
  projectId: string
  sessionId?: string
}

type RunProjectTransferExportSessionInput = ProjectTransferExportRuntimeOptions & {
  database?: ReturnType<typeof getAppDatabaseService>
  expiresAt?: Date
  exportedAt?: Date
  ownerToken?: string
  projectId: string
  sessionId: string
}

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
  packageBytes: Uint8Array
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

const getPayloadManifestEntries = (
  serializedPayloads: ProjectTransferExportSerializedPayloads,
  payloads: ProjectTransferPayloadByKey,
) => {
  return projectTransferPayloadKeys.reduce<
    Record<ProjectTransferPayloadKey, ProjectTransferManifest['payloads'][ProjectTransferPayloadKey]>
  >(
    (entries, key) => {
      return {
        ...entries,
        [key]: getProjectTransferManifestPayloadEntry({
          bytes: serializedPayloads[key],
          format: projectTransferPayloadFormatByKey[key],
          path: projectTransferPayloadPathByKey[key],
          recordCount: getPayloadRecordCount(key, payloads[key]),
        }),
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
  serializedPayloads,
}: {
  assetBytes: number
  assembly: ProjectTransferExportPayloadAssembly
  exportedAt: Date
  packageFingerprint?: string | null
  serializedPayloads: ProjectTransferExportSerializedPayloads
}) => {
  return buildProjectTransferManifest({
    assetSummary: {byteLength: assetBytes, entryCount: assembly.assetEntries.length},
    exportedAt: exportedAt.toISOString(),
    packageFingerprint,
    payloads: getPayloadManifestEntries(serializedPayloads, assembly.payloads),
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
  serializedPayloads,
}: {
  assetBytes: number
  assembly: ProjectTransferExportPayloadAssembly
  exportedAt: Date
  serializedPayloads: ProjectTransferExportSerializedPayloads
}) => {
  const unsignedManifest = buildManifest({assetBytes, assembly, exportedAt, serializedPayloads})
  const packageFingerprint = getProjectTransferPackageFingerprint({
    manifest: unsignedManifest,
    payloads: assembly.payloads,
  })

  return buildManifest({assetBytes, assembly, exportedAt, packageFingerprint, serializedPayloads})
}

const getPackageEntries = ({
  manifest,
  serializedPayloads,
  assembly,
}: {
  assembly: ProjectTransferExportPayloadAssembly
  manifest: ProjectTransferManifest
  serializedPayloads: ProjectTransferExportSerializedPayloads
}) => {
  return [
    {bytes: getProjectTransferCanonicalJson(manifest), path: manifestPath},
    ...projectTransferPayloadKeys.map((key) => {
      return {bytes: serializedPayloads[key], path: projectTransferPayloadPathByKey[key]}
    }),
    ...assembly.assetEntries.map((entry) => {
      return {bytes: entry.bytes, path: entry.path}
    }),
  ]
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

const writeBuildEntry = async (rootPath: string, pathValue: string, bytes: string | Uint8Array) => {
  const filePath = join(rootPath, pathValue)
  await mkdir(dirname(filePath), {recursive: true})
  await globalThis.Bun.write(filePath, bytes)
}

const writeBuildEntries = async ({
  entries,
  rootPath,
}: {
  entries: Array<{bytes: string | Uint8Array; path: string}>
  rootPath: string
}) => {
  await entries.reduce<Promise<void>>(async (previous, entry) => {
    await previous
    await writeBuildEntry(rootPath, entry.path, entry.bytes)
  }, Promise.resolve())
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
        const assembly = yield* Effect.promise(async () => {
          return runProjectTransferExportHeartbeatOperation({
            heartbeat: input.heartbeat,
            operation: async () => {
              const database = input.database ?? getAppDatabaseService()

              return database.transaction((runner) => {
                return getProjectTransferExportPayloads(input.projectId, {database: runner})
              }) as Promise<ProjectTransferExportPayloadAssembly>
            },
            sessionId: input.sessionId,
          })
        })
        const serializedPayloads = serializeProjectTransferExportPayloads(assembly.payloads)
        const assetBytes = assembly.assetEntries.reduce((total, entry) => {
          return total + entry.bytes.byteLength
        }, 0)
        const manifest = getManifestWithFingerprint({assetBytes, assembly, exportedAt, serializedPayloads})
        const entries = getPackageEntries({assembly, manifest, serializedPayloads})
        yield* Effect.promise(() => {
          return runProjectTransferExportHeartbeatOperation({
            heartbeat: input.heartbeat,
            operation: () => {
              return writeBuildEntries({entries, rootPath: buildPath})
            },
            sessionId: input.sessionId,
          })
        })

        const packageArchive = yield* Effect.promise(() => {
          return runProjectTransferExportHeartbeatOperation({
            heartbeat: input.heartbeat,
            operation: () => {
              return writeProjectTransferZipPackage({entries, zipModule: input.zipModule})
            },
            sessionId: input.sessionId,
          })
        })
        const packageFingerprint = manifest.packageFingerprint ?? ''
        const metadata = {
          byteLength: packageArchive.bytes.byteLength,
          checksumSha256: getProjectTransferSha256Checksum(packageArchive.bytes),
          downloadUrl: getDownloadUrl(input.sessionId),
          expiresAt: expiresAt.toISOString(),
          filename: getExportFilename(input.projectId, packageFingerprint),
          packageFingerprint,
        }
        const executionMode = getProjectTransferExportExecutionMode({
          assetBytes,
          packageBytes: packageArchive.bytes.byteLength,
        })

        return {
          assetBytes,
          executionMode,
          manifest,
          metadata,
          packageBytes: packageArchive.bytes,
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
      sessionId: input.sessionId,
    })
    const packagingProgress = getProgress({
      bytesProcessed: build.assetBytes,
      bytesTotal: build.metadata.byteLength + build.assetBytes,
      expiresAt,
      phase: 'export_package',
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
    await writePackageArtifact({layout, packageBytes: build.packageBytes, runtimeOptions: input})
    await writeManifestArtifact({layout, manifest: build.manifest, runtimeOptions: input})

    const readyPayload = {status: 'ready' as const, ...build.metadata}
    await writeExportCompletionFile({layout, metadata: readyPayload, runtimeOptions: input})

    const readyProgress = getProgress({
      bytesProcessed: build.metadata.byteLength + build.assetBytes,
      bytesTotal: build.metadata.byteLength + build.assetBytes,
      expiresAt,
      phase: 'export_package',
      rowCountProcessed: Object.values(build.manifest.project.counts).reduce((total, count) => {
        return total + count
      }, 0),
      rowCountTotal: Object.values(build.manifest.project.counts).reduce((total, count) => {
        return total + count
      }, 0),
      startedAt,
      status: 'completed',
      warningCount: build.manifest.warnings?.length ?? 0,
    })

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
  const preflight = await getProjectTransferExportPreflightEstimate(input.projectId, {database: input.database})
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
        packageBytes: build.packageBytes,
      }
    : queueExport({
        downloadUrl: build.metadata.downloadUrl,
        expiresAt: build.metadata.expiresAt,
        filename: build.metadata.filename,
      })
}

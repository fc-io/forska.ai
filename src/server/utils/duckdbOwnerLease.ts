import {randomUUID} from 'node:crypto'
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {hostname} from 'node:os'
import {dirname} from 'node:path'

import {Effect} from 'effect'

import {getLocalMachineFingerprint, isLockOwnedByCurrentMachine} from './localMachineIdentity.ts'
import {
  getRuntimeCutoverVersion,
  getRuntimeCutoverVersionMismatchMessage,
  isRuntimeCutoverVersionCompatible,
  normalizeRuntimeCutoverVersion,
  probeDuckdbOwnerCutoverCompatibility,
} from './runtimeCutover.ts'
import type {ServerRole} from './serverRole.ts'
import {canServerRoleOwnDuckdb} from './serverRole.ts'

export const duckdbOwnerLeaseHeartbeatStaleMs = 30_000

export type DuckdbOwnerLeaseMetadata = {
  acquiredAt: string
  apiServerPort: number
  databasePath: string
  heartbeatAt: string
  hostname: string
  machineFingerprint?: string
  leaseId: string
  pid: number
  runtimeVersion?: string
  serverRole: ServerRole
}

export type DuckdbOwnerLease = {leasePath: string; metadata: DuckdbOwnerLeaseMetadata}

type DuckdbOwnerLeaseRecord = {leasePath: string; metadata: DuckdbOwnerLeaseMetadata}

export type DuckdbOwnerLeaseHistoryEntry = {
  apiServerPort: number
  at: string
  duckdbOwnerUrl: string
  event: 'acquired' | 'released'
  hostname: string
  leaseId: string
  pid: number
  runtimeVersion?: string
  serverRole: ServerRole
}

const duckdbOwnerLeaseHistoryLimit = 50

const getDuckdbOwnerLeasePath = (databasePath: string) => {
  return databasePath === ':memory:' ? null : `${databasePath}.duckdb-owner.lock`
}

const getDuckdbOwnerLeaseHistoryPath = (databasePath: string) => {
  return databasePath === ':memory:' ? null : `${databasePath}.duckdb-owner.history.json`
}

const getLegacyDuckdbOwnerLeasePath = (databasePath: string) => {
  return databasePath === ':memory:' ? null : `${databasePath}.writer.lock`
}

const getLegacyDuckdbOwnerLeaseHistoryPath = (databasePath: string) => {
  return databasePath === ':memory:' ? null : `${databasePath}.writer.history.json`
}

const getDuckdbOwnerLeaseUrl = (metadata: DuckdbOwnerLeaseMetadata) => {
  return `http://127.0.0.1:${metadata.apiServerPort}`
}

const getLeaseOwnerText = (metadata: DuckdbOwnerLeaseMetadata) => {
  return `${metadata.serverRole}@${metadata.hostname}:${metadata.apiServerPort} pid=${metadata.pid}`
}

const getLeaseRuntimeVersionMismatchMessage = (metadata: DuckdbOwnerLeaseMetadata) => {
  return getRuntimeCutoverVersionMismatchMessage({
    context: `DuckDB owner lease held by ${getLeaseOwnerText(metadata)}`,
    runtimeVersion: metadata.runtimeVersion,
  })
}

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isExistingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const isJsonSyntaxError = (error: unknown) => {
  return error instanceof SyntaxError || (error instanceof Error && error.name === 'SyntaxError')
}

const getErrorText = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

const normalizeDuckdbOwnerLeaseMetadata = (
  databasePath: string,
  value: Partial<DuckdbOwnerLeaseMetadata>,
): DuckdbOwnerLeaseMetadata => {
  const acquiredAt = typeof value.acquiredAt === 'string' ? value.acquiredAt : new Date().toISOString()
  const hostnameValue = typeof value.hostname === 'string' ? value.hostname : hostname()
  const machineFingerprintValue =
    typeof value.machineFingerprint === 'string' && value.machineFingerprint.length > 0
      ? value.machineFingerprint
      : undefined
  const pidValue = typeof value.pid === 'number' ? value.pid : 0

  return {
    acquiredAt,
    apiServerPort: typeof value.apiServerPort === 'number' ? value.apiServerPort : 0,
    databasePath,
    heartbeatAt: typeof value.heartbeatAt === 'string' ? value.heartbeatAt : acquiredAt,
    hostname: hostnameValue,
    machineFingerprint: machineFingerprintValue,
    leaseId:
      typeof value.leaseId === 'string' && value.leaseId.length > 0
        ? value.leaseId
        : `${hostnameValue}:${pidValue}:${acquiredAt}`,
    pid: pidValue,
    runtimeVersion: normalizeRuntimeCutoverVersion(value.runtimeVersion) ?? undefined,
    serverRole: value.serverRole ?? 'maintenance-worker',
  }
}

const normalizeDuckdbOwnerLeaseHistoryEntry = (value: Partial<DuckdbOwnerLeaseHistoryEntry>) => {
  const at = typeof value.at === 'string' ? value.at : new Date().toISOString()
  const hostnameValue = typeof value.hostname === 'string' ? value.hostname : hostname()
  const portValue = typeof value.apiServerPort === 'number' ? value.apiServerPort : 0

  return {
    apiServerPort: portValue,
    at,
    event: value.event === 'released' ? 'released' : 'acquired',
    hostname: hostnameValue,
    leaseId:
      typeof value.leaseId === 'string' && value.leaseId.length > 0
        ? value.leaseId
        : `${hostnameValue}:${portValue}:${at}`,
    pid: typeof value.pid === 'number' ? value.pid : 0,
    runtimeVersion: normalizeRuntimeCutoverVersion(value.runtimeVersion) ?? undefined,
    serverRole: value.serverRole ?? 'maintenance-worker',
    duckdbOwnerUrl: typeof value.duckdbOwnerUrl === 'string' ? value.duckdbOwnerUrl : `http://127.0.0.1:${portValue}`,
  } satisfies DuckdbOwnerLeaseHistoryEntry
}

const writeDuckdbOwnerLeaseMetadata = (leasePath: string, metadata: DuckdbOwnerLeaseMetadata) => {
  return Effect.tryPromise(() => {
    return writeFile(leasePath, JSON.stringify(metadata, null, 2))
  })
}

const readDuckdbOwnerLeaseRecord = (
  databasePath: string,
  leasePath: string,
): Effect.Effect<DuckdbOwnerLeaseRecord | null, unknown> => {
  return Effect.tryPromise(async () => {
    try {
      const raw = await readFile(leasePath, 'utf8')
      const trimmed = raw.trim()

      if (trimmed === '') {
        console.warn(`[duckdb] ignoring empty DuckDB owner lease file at ${leasePath}`)
        return null
      }

      const parsed = JSON.parse(raw) as Partial<DuckdbOwnerLeaseMetadata>
      return {leasePath, metadata: normalizeDuckdbOwnerLeaseMetadata(databasePath, parsed)}
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }

      if (isJsonSyntaxError(error)) {
        console.warn(`[duckdb] ignoring malformed DuckDB owner lease file at ${leasePath}: ${getErrorText(error)}`)
        return null
      }

      throw error
    }
  })
}

const getCurrentLeaseRecord = (databasePath: string): Effect.Effect<DuckdbOwnerLeaseRecord | null, unknown> => {
  const leasePath = getDuckdbOwnerLeasePath(databasePath)
  const legacyLeasePath = getLegacyDuckdbOwnerLeasePath(databasePath)

  return leasePath === null
    ? Effect.succeed(null)
    : readDuckdbOwnerLeaseRecord(databasePath, leasePath).pipe(
        Effect.flatMap((record) => {
          return record !== null || legacyLeasePath === null
            ? Effect.succeed(record)
            : readDuckdbOwnerLeaseRecord(databasePath, legacyLeasePath)
        }),
      )
}

const getCurrentLeaseMetadata = (databasePath: string): Effect.Effect<DuckdbOwnerLeaseMetadata | null, unknown> => {
  return getCurrentLeaseRecord(databasePath).pipe(
    Effect.map((record) => {
      return record?.metadata ?? null
    }),
  )
}

const readDuckdbOwnerLeaseHistoryFile = (
  historyPath: string,
): Effect.Effect<DuckdbOwnerLeaseHistoryEntry[] | null, unknown> => {
  return Effect.tryPromise(async () => {
    try {
      const raw = await readFile(historyPath, 'utf8')
      const trimmed = raw.trim()

      if (trimmed === '') {
        console.warn(`[duckdb] ignoring empty DuckDB owner history file at ${historyPath}`)
        return []
      }

      const parsed = JSON.parse(raw) as Partial<DuckdbOwnerLeaseHistoryEntry>[]
      return Array.isArray(parsed) ? parsed.map(normalizeDuckdbOwnerLeaseHistoryEntry) : []
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }

      if (isJsonSyntaxError(error)) {
        console.warn(`[duckdb] ignoring malformed DuckDB owner history file at ${historyPath}: ${getErrorText(error)}`)
        return []
      }

      throw error
    }
  })
}

const getCurrentLeaseHistory = (databasePath: string): Effect.Effect<DuckdbOwnerLeaseHistoryEntry[], unknown> => {
  const historyPath = getDuckdbOwnerLeaseHistoryPath(databasePath)
  const legacyHistoryPath = getLegacyDuckdbOwnerLeaseHistoryPath(databasePath)

  return historyPath === null
    ? Effect.succeed([])
    : readDuckdbOwnerLeaseHistoryFile(historyPath).pipe(
        Effect.flatMap((entries) => {
          return entries !== null || legacyHistoryPath === null
            ? Effect.succeed(entries ?? [])
            : readDuckdbOwnerLeaseHistoryFile(legacyHistoryPath).pipe(
                Effect.map((legacyEntries) => {
                  return legacyEntries ?? []
                }),
              )
        }),
      )
}

const writeDuckdbOwnerLeaseHistory = (databasePath: string, entries: DuckdbOwnerLeaseHistoryEntry[]) => {
  const historyPath = getDuckdbOwnerLeaseHistoryPath(databasePath)

  return historyPath === null
    ? Effect.void
    : Effect.tryPromise(async () => {
        await mkdir(dirname(historyPath), {recursive: true})
        await writeFile(historyPath, JSON.stringify(entries.slice(0, duckdbOwnerLeaseHistoryLimit), null, 2))
      }).pipe(Effect.asVoid)
}

const appendDuckdbOwnerLeaseHistory = (databasePath: string, entry: DuckdbOwnerLeaseHistoryEntry) => {
  return getCurrentLeaseHistory(databasePath).pipe(
    Effect.flatMap((entries) => {
      return writeDuckdbOwnerLeaseHistory(databasePath, [entry, ...entries])
    }),
  )
}

const removeLeasePath = (leasePath: string) => {
  return Effect.tryPromise(() => {
    return unlink(leasePath).catch((error) => {
      if (!isMissingFileError(error)) {
        throw error
      }
    })
  }).pipe(Effect.asVoid)
}

export const isDuckdbOwnerLeaseOwnedByCurrentProcess = (metadata: DuckdbOwnerLeaseMetadata) => {
  return isLockOwnedByCurrentMachine(metadata) && metadata.pid === process.pid
}

const canRemoveStaleLease = (metadata: DuckdbOwnerLeaseMetadata) => {
  return isLockOwnedByCurrentMachine(metadata) && (!isProcessAlive(metadata.pid) || isDuckdbOwnerLeaseStale(metadata))
}

const canTakeOverStaleLease = (metadata: DuckdbOwnerLeaseMetadata, takeoverLeaseId: string | undefined) => {
  return takeoverLeaseId !== undefined && metadata.leaseId === takeoverLeaseId && isDuckdbOwnerLeaseStale(metadata)
}

const appendUnexpectedLeaseReleaseHistory = (metadata: DuckdbOwnerLeaseMetadata) => {
  return appendDuckdbOwnerLeaseHistory(metadata.databasePath, {
    apiServerPort: metadata.apiServerPort,
    at: new Date().toISOString(),
    event: 'released',
    hostname: metadata.hostname,
    leaseId: metadata.leaseId,
    pid: metadata.pid,
    runtimeVersion: metadata.runtimeVersion,
    serverRole: metadata.serverRole,
    duckdbOwnerUrl: getDuckdbOwnerLeaseUrl(metadata),
  })
}

const acquireLeaseFile = (leasePath: string, metadata: DuckdbOwnerLeaseMetadata) => {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(leasePath), {recursive: true})
      await writeFile(leasePath, JSON.stringify(metadata, null, 2), {flag: 'wx'})
      return {leasePath, metadata} satisfies DuckdbOwnerLease
    },
    catch: (error) => {
      return error
    },
  })
}

const appendAcquiredDuckdbOwnerLeaseHistory = (databasePath: string, metadata: DuckdbOwnerLeaseMetadata) => {
  return appendDuckdbOwnerLeaseHistory(databasePath, {
    apiServerPort: metadata.apiServerPort,
    at: metadata.acquiredAt,
    event: 'acquired',
    hostname: metadata.hostname,
    leaseId: metadata.leaseId,
    pid: metadata.pid,
    runtimeVersion: metadata.runtimeVersion,
    serverRole: metadata.serverRole,
    duckdbOwnerUrl: getDuckdbOwnerLeaseUrl(metadata),
  })
}

const failForNonOwnerRole = (serverRole: ServerRole) => {
  return Effect.fail(new Error(`SERVER_ROLE=${serverRole} cannot open the local DuckDB owner`))
}

const failForActiveLease = (metadata: DuckdbOwnerLeaseMetadata) => {
  return Effect.fail(
    new Error(
      `DuckDB owner lease is held by ${getLeaseOwnerText(metadata)} since ${metadata.acquiredAt}. Stop that process or use SERVER_ROLE=maintenance-worker/dev-single there only.`,
    ),
  )
}

const failForIncompatibleLease = (metadata: DuckdbOwnerLeaseMetadata) => {
  return Effect.fail(new Error(getLeaseRuntimeVersionMismatchMessage(metadata)))
}

const failForUnsafeIncompatibleLease = (metadata: DuckdbOwnerLeaseMetadata) => {
  return isDuckdbOwnerLeaseStale(metadata)
    ? failForIncompatibleLease(metadata)
    : Effect.fail(new Error(`${getLeaseRuntimeVersionMismatchMessage(metadata)} The incompatible lease is fresh.`))
}

const assertIncompatibleLeaseCanBeReplaced = (metadata: DuckdbOwnerLeaseMetadata): Effect.Effect<void, unknown> => {
  if (isRuntimeCutoverVersionCompatible(metadata.runtimeVersion)) {
    return Effect.void
  }

  if (!isDuckdbOwnerLeaseStale(metadata)) {
    return Effect.fail(new Error(`${getLeaseRuntimeVersionMismatchMessage(metadata)} The incompatible lease is fresh.`))
  }

  return Effect.tryPromise({
    try: async () => {
      const duckdbOwnerUrl = getDuckdbOwnerLeaseUrl(metadata)
      const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, 'legacy DuckDB owner lease replacement')

      if (result.status !== 'unreachable') {
        throw new Error(
          `${getLeaseRuntimeVersionMismatchMessage(metadata)} The incompatible peer is still reachable at ${duckdbOwnerUrl}.`,
        )
      }
    },
    catch: (error) => {
      return error
    },
  })
}

export const isDuckdbOwnerLeaseProcessAlive = (metadata: DuckdbOwnerLeaseMetadata) => {
  return isLockOwnedByCurrentMachine(metadata) ? isProcessAlive(metadata.pid) : true
}

export const isDuckdbOwnerLeaseStale = (metadata: DuckdbOwnerLeaseMetadata, nowMs = Date.now()) => {
  return nowMs - new Date(metadata.heartbeatAt).getTime() > duckdbOwnerLeaseHeartbeatStaleMs
}

export const acquireDuckdbOwnerLease = (params: {
  apiServerPort: number
  databasePath: string
  serverRole: ServerRole
  takeoverLeaseId?: string
}): Effect.Effect<DuckdbOwnerLease | null, unknown> => {
  const leasePath = getDuckdbOwnerLeasePath(params.databasePath)

  if (leasePath === null) {
    return Effect.succeed(null)
  }

  if (!canServerRoleOwnDuckdb(params.serverRole)) {
    return failForNonOwnerRole(params.serverRole)
  }

  const acquiredAt = new Date().toISOString()
  const metadata: DuckdbOwnerLeaseMetadata = {
    acquiredAt,
    apiServerPort: params.apiServerPort,
    databasePath: params.databasePath,
    heartbeatAt: acquiredAt,
    hostname: hostname(),
    machineFingerprint: getLocalMachineFingerprint(),
    leaseId: randomUUID(),
    pid: process.pid,
    runtimeVersion: getRuntimeCutoverVersion(),
    serverRole: params.serverRole,
  }

  const acquireCurrentLeaseFile = (): Effect.Effect<DuckdbOwnerLease | null, unknown> => {
    return acquireLeaseFile(leasePath, metadata).pipe(
      Effect.flatMap((lease) => {
        return appendAcquiredDuckdbOwnerLeaseHistory(params.databasePath, metadata).pipe(Effect.as(lease))
      }),
      Effect.catchAll((error) => {
        return isExistingFileError(error)
          ? getCurrentLeaseRecord(params.databasePath).pipe(
              Effect.flatMap((currentRecord) => {
                return handleCurrentLeaseRecord(currentRecord)
              }),
            )
          : Effect.fail(error)
      }),
    )
  }

  const handleCurrentLeaseRecord = (
    currentRecord: DuckdbOwnerLeaseRecord | null,
  ): Effect.Effect<DuckdbOwnerLease | null, unknown> => {
    if (currentRecord === null) {
      return removeLeasePath(leasePath).pipe(
        Effect.flatMap(() => {
          return acquireCurrentLeaseFile()
        }),
      )
    }

    const currentLease = currentRecord.metadata
    const replaceCurrentLease = () => {
      return assertIncompatibleLeaseCanBeReplaced(currentLease).pipe(
        Effect.flatMap(() => {
          return appendUnexpectedLeaseReleaseHistory(currentLease)
        }),
        Effect.flatMap(() => {
          return removeLeasePath(currentRecord.leasePath)
        }),
        Effect.flatMap(() => {
          return acquireCurrentLeaseFile()
        }),
      )
    }

    return isDuckdbOwnerLeaseOwnedByCurrentProcess(currentLease)
      ? currentRecord.leasePath === leasePath
        ? writeDuckdbOwnerLeaseMetadata(leasePath, {
            ...currentLease,
            machineFingerprint: getLocalMachineFingerprint(),
            runtimeVersion: getRuntimeCutoverVersion(),
          }).pipe(
            Effect.as({
              leasePath,
              metadata: {
                ...currentLease,
                machineFingerprint: getLocalMachineFingerprint(),
                runtimeVersion: getRuntimeCutoverVersion(),
              },
            }),
          )
        : removeLeasePath(currentRecord.leasePath).pipe(
            Effect.flatMap(() => {
              return acquireCurrentLeaseFile()
            }),
          )
      : canRemoveStaleLease(currentLease) || canTakeOverStaleLease(currentLease, params.takeoverLeaseId)
        ? replaceCurrentLease()
        : isRuntimeCutoverVersionCompatible(currentLease.runtimeVersion)
          ? failForActiveLease(currentLease)
          : failForUnsafeIncompatibleLease(currentLease)
  }

  return getCurrentLeaseRecord(params.databasePath).pipe(
    Effect.flatMap((currentRecord) => {
      return currentRecord === null ? acquireCurrentLeaseFile() : handleCurrentLeaseRecord(currentRecord)
    }),
  )
}

export const updateDuckdbOwnerLeaseHeartbeat = (
  lease: DuckdbOwnerLease | null,
): Effect.Effect<DuckdbOwnerLease | null, unknown> => {
  if (lease === null) {
    return Effect.succeed(null)
  }

  return getCurrentLeaseMetadata(lease.metadata.databasePath).pipe(
    Effect.flatMap((currentLease) => {
      return currentLease === null || currentLease.leaseId !== lease.metadata.leaseId
        ? Effect.fail(new Error('DuckDB owner lease is no longer owned by this process'))
        : !isRuntimeCutoverVersionCompatible(currentLease.runtimeVersion)
          ? failForIncompatibleLease(currentLease)
          : Effect.sync(() => {
              return {
                ...lease,
                metadata: {
                  ...lease.metadata,
                  heartbeatAt: new Date().toISOString(),
                  runtimeVersion: getRuntimeCutoverVersion(),
                },
              } satisfies DuckdbOwnerLease
            }).pipe(
              Effect.flatMap((nextLease) => {
                return writeDuckdbOwnerLeaseMetadata(lease.leasePath, nextLease.metadata).pipe(Effect.as(nextLease))
              }),
            )
    }),
  )
}

export const releaseDuckdbOwnerLease = (lease: DuckdbOwnerLease | null): Effect.Effect<void, unknown> => {
  if (lease === null) {
    return Effect.void
  }

  return getCurrentLeaseMetadata(lease.metadata.databasePath).pipe(
    Effect.flatMap((currentLease) => {
      return currentLease !== null && currentLease.leaseId === lease.metadata.leaseId
        ? appendDuckdbOwnerLeaseHistory(lease.metadata.databasePath, {
            apiServerPort: lease.metadata.apiServerPort,
            at: new Date().toISOString(),
            event: 'released',
            hostname: lease.metadata.hostname,
            leaseId: lease.metadata.leaseId,
            pid: lease.metadata.pid,
            runtimeVersion: lease.metadata.runtimeVersion,
            serverRole: lease.metadata.serverRole,
            duckdbOwnerUrl: getDuckdbOwnerLeaseUrl(lease.metadata),
          }).pipe(
            Effect.flatMap(() => {
              return removeLeasePath(lease.leasePath)
            }),
          )
        : Effect.void
    }),
  )
}

export const readDuckdbOwnerLease = (databasePath: string): Effect.Effect<DuckdbOwnerLeaseMetadata | null, unknown> => {
  return getCurrentLeaseMetadata(databasePath)
}

export const readDuckdbOwnerLeaseHistory = (
  databasePath: string,
): Effect.Effect<DuckdbOwnerLeaseHistoryEntry[], unknown> => {
  return getCurrentLeaseHistory(databasePath)
}

export {getDuckdbOwnerLeaseUrl}

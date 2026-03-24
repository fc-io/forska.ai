import {spawnSync} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {hostname, networkInterfaces} from 'node:os'
import {dirname} from 'node:path'

import {Effect} from 'effect'

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
  serverRole: ServerRole
}

export type DuckdbOwnerLease = {leasePath: string; metadata: DuckdbOwnerLeaseMetadata}

export type DuckdbOwnerLeaseHistoryEntry = {
  apiServerPort: number
  at: string
  event: 'acquired' | 'released'
  hostname: string
  leaseId: string
  pid: number
  serverRole: ServerRole
  writerUrl: string
}

const duckdbOwnerLeaseHistoryLimit = 50

const normalizeHostname = (value: string | null | undefined) => {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

const isNonEmptyString = (value: string | null | undefined): value is string => {
  return value !== null && value !== undefined && value !== ''
}

const getCommandOutput = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {encoding: 'utf8'})
  const output = normalizeHostname(result.stdout)

  return result.status === 0 && output !== '' ? output : null
}

const getDarwinLocalHostname = () => {
  return process.platform === 'darwin' ? getCommandOutput('scutil', ['--get', 'LocalHostName']) : null
}

const getDarwinPlatformUuid = () => {
  if (process.platform !== 'darwin') {
    return null
  }

  const result = spawnSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {encoding: 'utf8'})
  const platformUuid = /"IOPlatformUUID" = "([^"]+)"/.exec(result.stdout)?.[1]

  return result.status === 0 && platformUuid !== undefined ? normalizeHostname(platformUuid) : null
}

const getShellHostname = () => {
  return getCommandOutput('hostname', [])
}

const getCurrentHostnameAliases = () => {
  const currentHostname = normalizeHostname(hostname())
  const darwinLocalHostname = getDarwinLocalHostname()
  const shellHostname = getShellHostname()
  const aliases = [
    currentHostname,
    currentHostname.split('.')[0],
    shellHostname,
    shellHostname === null ? null : shellHostname.split('.')[0],
    darwinLocalHostname,
    darwinLocalHostname === null ? null : `${darwinLocalHostname}.local`,
  ].filter(isNonEmptyString)

  return Array.from(new Set(aliases))
}

const getCurrentMachineFingerprintSource = () => {
  const darwinPlatformUuid = getDarwinPlatformUuid()

  if (darwinPlatformUuid !== null) {
    return darwinPlatformUuid
  }

  const macAddresses = Array.from(
    new Set(
      Object.values(networkInterfaces())
        .flatMap((addresses) => {
          return (addresses ?? []).map((address) => {
            return address.mac.trim().toLowerCase()
          })
        })
        .filter((macAddress) => {
          return macAddress !== '' && macAddress !== '00:00:00:00:00:00'
        }),
    ),
  ).sort()

  return macAddresses.length > 0 ? macAddresses.join('|') : normalizeHostname(hostname())
}

const currentMachineFingerprint = createHash('sha256').update(getCurrentMachineFingerprintSource()).digest('hex')
const currentHostnameAliases = getCurrentHostnameAliases()

const isLeaseOwnedByCurrentMachine = (metadata: DuckdbOwnerLeaseMetadata) => {
  const matchesCurrentHostname = currentHostnameAliases.includes(normalizeHostname(metadata.hostname))

  return matchesCurrentHostname || metadata.machineFingerprint === currentMachineFingerprint
}

const getDuckdbOwnerLeasePath = (databasePath: string) => {
  return databasePath === ':memory:' ? null : `${databasePath}.writer.lock`
}

const getDuckdbOwnerLeaseHistoryPath = (databasePath: string) => {
  return databasePath === ':memory:' ? null : `${databasePath}.writer.history.json`
}

const getDuckdbOwnerLeaseWriterUrl = (metadata: DuckdbOwnerLeaseMetadata) => {
  return `http://127.0.0.1:${metadata.apiServerPort}`
}

const getLeaseOwnerText = (metadata: DuckdbOwnerLeaseMetadata) => {
  return `${metadata.serverRole}@${metadata.hostname}:${metadata.apiServerPort} pid=${metadata.pid}`
}

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isExistingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
    serverRole: value.serverRole ?? 'writer',
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
    serverRole: value.serverRole ?? 'writer',
    writerUrl: typeof value.writerUrl === 'string' ? value.writerUrl : `http://127.0.0.1:${portValue}`,
  } satisfies DuckdbOwnerLeaseHistoryEntry
}

const writeDuckdbOwnerLeaseMetadata = (leasePath: string, metadata: DuckdbOwnerLeaseMetadata) => {
  return Effect.tryPromise(() => {
    return writeFile(leasePath, JSON.stringify(metadata, null, 2))
  })
}

const getCurrentLeaseMetadata = (databasePath: string): Effect.Effect<DuckdbOwnerLeaseMetadata | null, unknown> => {
  const leasePath = getDuckdbOwnerLeasePath(databasePath)

  return leasePath === null
    ? Effect.succeed(null)
    : Effect.tryPromise(async () => {
        try {
          const raw = await readFile(leasePath, 'utf8')
          const parsed = JSON.parse(raw) as Partial<DuckdbOwnerLeaseMetadata>
          return normalizeDuckdbOwnerLeaseMetadata(databasePath, parsed)
        } catch (error) {
          if (isMissingFileError(error)) {
            return null
          }

          throw error
        }
      })
}

const getCurrentLeaseHistory = (databasePath: string): Effect.Effect<DuckdbOwnerLeaseHistoryEntry[], unknown> => {
  const historyPath = getDuckdbOwnerLeaseHistoryPath(databasePath)

  return historyPath === null
    ? Effect.succeed([])
    : Effect.tryPromise(async () => {
        try {
          const raw = await readFile(historyPath, 'utf8')
          const parsed = JSON.parse(raw) as Partial<DuckdbOwnerLeaseHistoryEntry>[]
          return Array.isArray(parsed) ? parsed.map(normalizeDuckdbOwnerLeaseHistoryEntry) : []
        } catch (error) {
          if (isMissingFileError(error)) {
            return []
          }

          throw error
        }
      })
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

const isDuckdbOwnerLeaseOwnedByCurrentProcess = (metadata: DuckdbOwnerLeaseMetadata) => {
  return isLeaseOwnedByCurrentMachine(metadata) && metadata.pid === process.pid
}

const canRemoveStaleLease = (metadata: DuckdbOwnerLeaseMetadata) => {
  return isLeaseOwnedByCurrentMachine(metadata) && (!isProcessAlive(metadata.pid) || isDuckdbOwnerLeaseStale(metadata))
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
    serverRole: metadata.serverRole,
    writerUrl: getDuckdbOwnerLeaseWriterUrl(metadata),
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

const failForNonOwnerRole = (serverRole: ServerRole) => {
  return Effect.fail(new Error(`SERVER_ROLE=${serverRole} cannot open the local DuckDB writer`))
}

const failForActiveLease = (metadata: DuckdbOwnerLeaseMetadata) => {
  return Effect.fail(
    new Error(
      `DuckDB writer lease is held by ${getLeaseOwnerText(metadata)} since ${metadata.acquiredAt}. Stop that process or use SERVER_ROLE=writer/dev-single there only.`,
    ),
  )
}

export const isDuckdbOwnerLeaseProcessAlive = (metadata: DuckdbOwnerLeaseMetadata) => {
  return isLeaseOwnedByCurrentMachine(metadata) ? isProcessAlive(metadata.pid) : true
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
    machineFingerprint: currentMachineFingerprint,
    leaseId: randomUUID(),
    pid: process.pid,
    serverRole: params.serverRole,
  }

  return acquireLeaseFile(leasePath, metadata).pipe(
    Effect.flatMap((lease) => {
      return appendDuckdbOwnerLeaseHistory(params.databasePath, {
        apiServerPort: metadata.apiServerPort,
        at: metadata.acquiredAt,
        event: 'acquired',
        hostname: metadata.hostname,
        leaseId: metadata.leaseId,
        pid: metadata.pid,
        serverRole: metadata.serverRole,
        writerUrl: getDuckdbOwnerLeaseWriterUrl(metadata),
      }).pipe(Effect.as(lease))
    }),
    Effect.catchAll((error) => {
      return isExistingFileError(error)
        ? getCurrentLeaseMetadata(params.databasePath).pipe(
            Effect.flatMap((currentLease) => {
              return currentLease === null
                ? acquireDuckdbOwnerLease(params)
                : isDuckdbOwnerLeaseOwnedByCurrentProcess(currentLease)
                  ? Effect.succeed({
                      leasePath,
                      metadata: {...currentLease, machineFingerprint: currentMachineFingerprint},
                    })
                  : canRemoveStaleLease(currentLease) || canTakeOverStaleLease(currentLease, params.takeoverLeaseId)
                    ? appendUnexpectedLeaseReleaseHistory(currentLease).pipe(
                        Effect.flatMap(() => {
                          return removeLeasePath(leasePath)
                        }),
                        Effect.flatMap(() => {
                          return acquireDuckdbOwnerLease(params)
                        }),
                      )
                    : failForActiveLease(currentLease)
            }),
          )
        : Effect.fail(error)
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
        ? Effect.fail(new Error('DuckDB writer lease is no longer owned by this process'))
        : Effect.sync(() => {
            return {
              ...lease,
              metadata: {...lease.metadata, heartbeatAt: new Date().toISOString()},
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
            serverRole: lease.metadata.serverRole,
            writerUrl: getDuckdbOwnerLeaseWriterUrl(lease.metadata),
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

export {getDuckdbOwnerLeaseWriterUrl}

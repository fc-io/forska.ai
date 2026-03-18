import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {hostname} from 'node:os'
import {dirname} from 'node:path'

import {Effect} from 'effect'

import type {ServerRole} from './serverRole.ts'
import {canServerRoleOwnDuckdb} from './serverRole.ts'

export type DuckdbOwnerLeaseMetadata = {
  acquiredAt: string
  apiServerPort: number
  databasePath: string
  hostname: string
  pid: number
  serverRole: ServerRole
}

export type DuckdbOwnerLease = {leasePath: string; metadata: DuckdbOwnerLeaseMetadata}

const getLeaseOwnerText = (metadata: DuckdbOwnerLeaseMetadata) => {
  return `${metadata.serverRole}@${metadata.hostname}:${metadata.apiServerPort} pid=${metadata.pid}`
}

const getDuckdbOwnerLeasePath = (databasePath: string) => {
  return databasePath === ':memory:' ? null : `${databasePath}.writer.lock`
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

const getCurrentLeaseMetadata = (databasePath: string): Effect.Effect<DuckdbOwnerLeaseMetadata | null, unknown> => {
  const leasePath = getDuckdbOwnerLeasePath(databasePath)

  return leasePath === null
    ? Effect.succeed(null)
    : Effect.tryPromise({
        try: async () => {
          const raw = await readFile(leasePath, 'utf8')
          return JSON.parse(raw) as DuckdbOwnerLeaseMetadata
        },
        catch: (error) => {
          return isMissingFileError(error) ? null : error
        },
      }).pipe(
        Effect.flatMap((value) => {
          return value === null ? Effect.succeed(null) : Effect.succeed(value)
        }),
      )
}

const removeLeasePath = (leasePath: string) => {
  return Effect.tryPromise({
    try: () => {
      return unlink(leasePath)
    },
    catch: (error) => {
      return isMissingFileError(error) ? null : error
    },
  }).pipe(Effect.asVoid)
}

const canRemoveStaleLease = (metadata: DuckdbOwnerLeaseMetadata) => {
  return metadata.hostname === hostname() && !isProcessAlive(metadata.pid)
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

export const acquireDuckdbOwnerLease = (params: {
  apiServerPort: number
  databasePath: string
  serverRole: ServerRole
}): Effect.Effect<DuckdbOwnerLease | null, unknown> => {
  const leasePath = getDuckdbOwnerLeasePath(params.databasePath)

  if (leasePath === null) {
    return Effect.succeed(null)
  }

  if (!canServerRoleOwnDuckdb(params.serverRole)) {
    return failForNonOwnerRole(params.serverRole)
  }

  const metadata: DuckdbOwnerLeaseMetadata = {
    acquiredAt: new Date().toISOString(),
    apiServerPort: params.apiServerPort,
    databasePath: params.databasePath,
    hostname: hostname(),
    pid: process.pid,
    serverRole: params.serverRole,
  }

  return acquireLeaseFile(leasePath, metadata).pipe(
    Effect.catchAll((error) => {
      return isExistingFileError(error)
        ? getCurrentLeaseMetadata(params.databasePath).pipe(
            Effect.flatMap((currentLease) => {
              return currentLease === null
                ? acquireDuckdbOwnerLease(params)
                : canRemoveStaleLease(currentLease)
                  ? removeLeasePath(leasePath).pipe(
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

export const releaseDuckdbOwnerLease = (lease: DuckdbOwnerLease | null): Effect.Effect<void, unknown> => {
  if (lease === null) {
    return Effect.void
  }

  return getCurrentLeaseMetadata(lease.metadata.databasePath).pipe(
    Effect.flatMap((currentLease) => {
      return currentLease
        && currentLease.pid === lease.metadata.pid
        && currentLease.hostname === lease.metadata.hostname
        && currentLease.acquiredAt === lease.metadata.acquiredAt
        ? removeLeasePath(lease.leasePath)
        : Effect.void
    }),
  )
}

export const readDuckdbOwnerLease = (databasePath: string): Effect.Effect<DuckdbOwnerLeaseMetadata | null, unknown> => {
  return getCurrentLeaseMetadata(databasePath)
}

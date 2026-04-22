import {spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import {
  acquireDuckdbOwnerLease,
  type DuckdbOwnerLeaseMetadata,
  isDuckdbOwnerLeaseProcessAlive,
} from './duckdbOwnerLease.ts'
import {getRuntimeCutoverVersion} from './runtimeCutover.ts'

const createLeasePaths = () => {
  const tempDirectory = mkdtempSync('/tmp/f1-duckdb-owner-lease-')
  const duckdbPath = join(tempDirectory, 'test.duckdb')

  return {
    duckdbPath,
    legacyLeasePath: `${duckdbPath}.writer.lock`,
    leasePath: `${duckdbPath}.duckdb-owner.lock`,
    tempDirectory,
  }
}

const readLeaseMetadata = (leasePath: string): DuckdbOwnerLeaseMetadata => {
  return JSON.parse(readFileSync(leasePath, 'utf8')) as DuckdbOwnerLeaseMetadata
}

const writeLeaseMetadata = (leasePath: string, metadata: DuckdbOwnerLeaseMetadata) => {
  writeFileSync(leasePath, `${JSON.stringify({...metadata, runtimeVersion: getRuntimeCutoverVersion()}, null, 2)}\n`)
}

const writePreCutoverLeaseMetadata = (leasePath: string, metadata: DuckdbOwnerLeaseMetadata) => {
  const {runtimeVersion: _runtimeVersion, ...preCutoverMetadata} = metadata

  writeFileSync(leasePath, `${JSON.stringify(preCutoverMetadata, null, 2)}\n`)
}

const getNormalizedCommandOutput = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {encoding: 'utf8'})
  const output = typeof result.stdout === 'string' ? result.stdout.trim() : ''

  return result.status === 0 && output !== '' ? output : null
}

const getDarwinLocalHostname = () => {
  if (process.platform !== 'darwin') {
    return null
  }

  return getNormalizedCommandOutput('/usr/sbin/scutil', ['--get', 'LocalHostName'])
}

const getShellHostname = () => {
  return getNormalizedCommandOutput('hostname', [])
}

test('maintenance-worker reclaims stale local lease for shell hostname alias', async () => {
  const shellHostname = getShellHostname()

  if (shellHostname === null || shellHostname === hostname()) {
    return
  }

  const {duckdbPath, leasePath, tempDirectory} = createLeasePaths()

  try {
    writeLeaseMetadata(leasePath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      apiServerPort: 3999,
      databasePath: duckdbPath,
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: shellHostname,
      machineFingerprint: 'outdated-machine-fingerprint',
      leaseId: 'shell-hostname-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )

    if (nextLease === null) {
      throw new Error('Expected reclaimed shell hostname lease')
    }

    expect(nextLease.metadata.hostname).toBe(hostname())
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker replaces an empty lease file left behind by a crashed owner', async () => {
  const {duckdbPath, leasePath, tempDirectory} = createLeasePaths()

  try {
    writeFileSync(leasePath, '')

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )

    if (nextLease === null) {
      throw new Error('Expected replacement lease')
    }

    expect(nextLease.metadata.hostname).toBe(hostname())
    expect(readLeaseMetadata(leasePath).leaseId).toBe(nextLease.metadata.leaseId)
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker reclaims stale legacy local lease for macOS local hostname alias', async () => {
  const darwinLocalHostname = getDarwinLocalHostname()

  if (darwinLocalHostname === null) {
    return
  }

  const {duckdbPath, leasePath, tempDirectory} = createLeasePaths()

  try {
    writeLeaseMetadata(leasePath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      apiServerPort: 3999,
      databasePath: duckdbPath,
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: `${darwinLocalHostname}.local`,
      leaseId: 'legacy-local-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )

    if (nextLease === null) {
      throw new Error('Expected reclaimed legacy lease')
    }

    expect(nextLease.metadata.hostname).toBe(hostname())
    expect(nextLease.metadata.machineFingerprint).toBeDefined()
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker reclaims stale local lease after hostname change when machine fingerprint matches', async () => {
  const {duckdbPath, leasePath, tempDirectory} = createLeasePaths()

  try {
    const initialLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )

    if (initialLease === null) {
      throw new Error('Expected initial lease')
    }

    writeLeaseMetadata(leasePath, {
      ...readLeaseMetadata(leasePath),
      acquiredAt: '2026-03-01T00:00:00.000Z',
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: 'Renamed-MacBook-Pro.local',
      pid: 999_999,
    })

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )

    if (nextLease === null) {
      throw new Error('Expected reclaimed lease')
    }

    expect(nextLease.metadata.hostname).toBe(hostname())
    expect(nextLease.metadata.leaseId).not.toBe(initialLease.metadata.leaseId)
    expect(readLeaseMetadata(leasePath).machineFingerprint).toBe(initialLease.metadata.machineFingerprint)
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker reclaims stale macOS local-hostname lease in a reduced PATH environment', () => {
  const darwinLocalHostname = getDarwinLocalHostname()

  if (darwinLocalHostname === null) {
    return
  }

  const {duckdbPath, leasePath, tempDirectory} = createLeasePaths()

  try {
    writeLeaseMetadata(leasePath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      apiServerPort: 3999,
      databasePath: duckdbPath,
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: `${darwinLocalHostname}.local`,
      leaseId: 'legacy-local-reduced-path-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    const result = globalThis.Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
          import {Effect} from 'effect'
          import {acquireDuckdbOwnerLease} from './src/server/utils/duckdbOwnerLease.ts'

          const nextLease = await Effect.runPromise(
            acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: ${JSON.stringify(duckdbPath)}, serverRole: 'maintenance-worker'}),
          )

          console.log(JSON.stringify(nextLease))
        `,
      ],
      {cwd: process.cwd(), env: {...process.env, PATH: '/usr/bin:/bin'}, stderr: 'pipe', stdout: 'pipe'},
    )

    const stdout = Buffer.from(result.stdout ?? [])
      .toString()
      .trim()
    const stderr = Buffer.from(result.stderr ?? [])
      .toString()
      .trim()

    if (result.exitCode !== 0) {
      throw new Error(stderr || stdout || 'Expected reduced-PATH lease reclaim subprocess to succeed')
    }

    const nextLease = JSON.parse(stdout) as {metadata: DuckdbOwnerLeaseMetadata} | null

    expect(nextLease).not.toBeNull()
    expect(nextLease?.metadata.hostname).toBe(hostname())
    expect(nextLease?.metadata.machineFingerprint).toBeDefined()
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker does not reclaim stale foreign lease without matching machine fingerprint', async () => {
  const {duckdbPath, leasePath, tempDirectory} = createLeasePaths()

  try {
    writeLeaseMetadata(leasePath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      apiServerPort: 3999,
      databasePath: duckdbPath,
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: 'foreign-machine.local',
      machineFingerprint: 'foreign-machine-fingerprint',
      leaseId: 'foreign-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    const acquireLeaseError = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )
      .then(() => {
        return null
      })
      .catch((error: unknown) => {
        return error
      })

    expect(acquireLeaseError).toBeInstanceOf(Error)
    expect((acquireLeaseError as Error).message).toContain('DuckDB owner lease is held by')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('api and judge-worker cannot acquire DuckDB owner lease', async () => {
  const {duckdbPath, tempDirectory} = createLeasePaths()

  try {
    const apiAcquireError = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'api'}),
    )
      .then(() => {
        return null
      })
      .catch((error: unknown) => {
        return error
      })
    const judgeAcquireError = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'judge-worker'}),
    )
      .then(() => {
        return null
      })
      .catch((error: unknown) => {
        return error
      })

    expect(apiAcquireError).toBeInstanceOf(Error)
    expect(judgeAcquireError).toBeInstanceOf(Error)
    expect((apiAcquireError as Error).message).toContain('SERVER_ROLE=api cannot open the local DuckDB owner')
    expect((judgeAcquireError as Error).message).toContain(
      'SERVER_ROLE=judge-worker cannot open the local DuckDB owner',
    )
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker treats EPERM pid checks as an active process', () => {
  const originalKill = process.kill.bind(process)
  const seenCalls: Array<[number, number | undefined]> = []

  process.kill = ((pid: number, signal?: number) => {
    seenCalls.push([pid, signal])
    const error = new Error('Operation not permitted') as Error & {code?: string}
    error.code = 'EPERM'
    throw error
  }) as typeof process.kill

  try {
    const isAlive = isDuckdbOwnerLeaseProcessAlive({
      acquiredAt: '2026-03-01T00:00:00.000Z',
      apiServerPort: 3999,
      databasePath: '/tmp/eprem-test.duckdb',
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: hostname(),
      leaseId: 'foreign-eperm-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    expect(isAlive).toBe(true)
    expect(seenCalls).toContainEqual([999_999, 0])
  } finally {
    process.kill = originalKill
  }
})

test('maintenance-worker can take over a stale foreign lease when auto mode already selected that lease', async () => {
  const {duckdbPath, leasePath, tempDirectory} = createLeasePaths()

  try {
    writeLeaseMetadata(leasePath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      apiServerPort: 3999,
      databasePath: duckdbPath,
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: 'foreign-machine.local',
      machineFingerprint: 'foreign-machine-fingerprint',
      leaseId: 'stale-foreign-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({
        apiServerPort: 3999,
        databasePath: duckdbPath,
        serverRole: 'maintenance-worker',
        takeoverLeaseId: 'stale-foreign-lease-id',
      }),
    )

    if (nextLease === null) {
      throw new Error('Expected lease takeover')
    }

    expect(nextLease.metadata.leaseId).not.toBe('stale-foreign-lease-id')
    expect(nextLease.metadata.machineFingerprint).toBeDefined()
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker refuses a fresh pre-cutover legacy writer lease', async () => {
  const {duckdbPath, legacyLeasePath, tempDirectory} = createLeasePaths()
  const now = new Date().toISOString()

  try {
    writePreCutoverLeaseMetadata(legacyLeasePath, {
      acquiredAt: now,
      apiServerPort: 3999,
      databasePath: duckdbPath,
      heartbeatAt: now,
      hostname: 'legacy-writer-host.local',
      machineFingerprint: 'legacy-writer-fingerprint',
      leaseId: 'fresh-legacy-writer-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    const acquireLeaseError = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )
      .then(() => {
        return null
      })
      .catch((error: unknown) => {
        return error
      })

    expect(acquireLeaseError).toBeInstanceOf(Error)
    expect((acquireLeaseError as Error).message).toContain('Incompatible Forska split runtime version')
    expect((acquireLeaseError as Error).message).toContain('fresh')
    expect(existsSync(legacyLeasePath)).toBe(true)
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker refuses a stale reachable pre-cutover legacy writer lease', async () => {
  const {duckdbPath, legacyLeasePath, tempDirectory} = createLeasePaths()
  const legacyWriterServer = globalThis.Bun.serve({
    port: 0,
    fetch: () => {
      return Response.json({data: null, error: 'legacy writer'})
    },
  })

  try {
    writePreCutoverLeaseMetadata(legacyLeasePath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      apiServerPort: legacyWriterServer.port,
      databasePath: duckdbPath,
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: hostname(),
      leaseId: 'reachable-legacy-writer-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    const acquireLeaseError = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )
      .then(() => {
        return null
      })
      .catch((error: unknown) => {
        return error
      })

    expect(acquireLeaseError).toBeInstanceOf(Error)
    expect((acquireLeaseError as Error).message).toContain('Incompatible Forska split runtime version')
    expect((acquireLeaseError as Error).message).toContain('still reachable')
    expect(existsSync(legacyLeasePath)).toBe(true)
  } finally {
    await legacyWriterServer.stop(true)
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('maintenance-worker replaces a stale unreachable pre-cutover legacy writer lease', async () => {
  const {duckdbPath, legacyLeasePath, leasePath, tempDirectory} = createLeasePaths()
  const stoppedLegacyWriterServer = globalThis.Bun.serve({
    port: 0,
    fetch: () => {
      return Response.json({data: null, error: 'legacy writer'})
    },
  })
  const legacyWriterPort = stoppedLegacyWriterServer.port

  await stoppedLegacyWriterServer.stop(true)

  try {
    writePreCutoverLeaseMetadata(legacyLeasePath, {
      acquiredAt: '2026-03-01T00:00:00.000Z',
      apiServerPort: legacyWriterPort,
      databasePath: duckdbPath,
      heartbeatAt: '2026-03-01T00:00:00.000Z',
      hostname: hostname(),
      leaseId: 'unreachable-legacy-writer-lease-id',
      pid: 999_999,
      serverRole: 'maintenance-worker',
    })

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'maintenance-worker'}),
    )

    if (nextLease === null) {
      throw new Error('Expected legacy writer lease replacement')
    }

    expect(existsSync(legacyLeasePath)).toBe(false)
    expect(readLeaseMetadata(leasePath).runtimeVersion).toBe(getRuntimeCutoverVersion())
    expect(nextLease.metadata.runtimeVersion).toBe(getRuntimeCutoverVersion())
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

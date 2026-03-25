import {spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import {acquireDuckdbOwnerLease, isDuckdbOwnerLeaseProcessAlive, type DuckdbOwnerLeaseMetadata} from './duckdbOwnerLease.ts'

const createLeasePaths = () => {
  const tempDirectory = mkdtempSync('/tmp/f1-duckdb-owner-lease-')
  const duckdbPath = join(tempDirectory, 'test.duckdb')

  return {duckdbPath, leasePath: `${duckdbPath}.writer.lock`, tempDirectory}
}

const readLeaseMetadata = (leasePath: string): DuckdbOwnerLeaseMetadata => {
  return JSON.parse(readFileSync(leasePath, 'utf8')) as DuckdbOwnerLeaseMetadata
}

const writeLeaseMetadata = (leasePath: string, metadata: DuckdbOwnerLeaseMetadata) => {
  writeFileSync(leasePath, `${JSON.stringify(metadata, null, 2)}\n`)
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

test('writer reclaims stale local lease for shell hostname alias', async () => {
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
      serverRole: 'writer',
    })

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'writer'}),
    )

    if (nextLease === null) {
      throw new Error('Expected reclaimed shell hostname lease')
    }

    expect(nextLease.metadata.hostname).toBe(hostname())
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('writer reclaims stale legacy local lease for macOS local hostname alias', async () => {
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
      serverRole: 'writer',
    })

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'writer'}),
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

test('writer reclaims stale local lease after hostname change when machine fingerprint matches', async () => {
  const {duckdbPath, leasePath, tempDirectory} = createLeasePaths()

  try {
    const initialLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'writer'}),
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
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'writer'}),
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

test('writer reclaims stale macOS local-hostname lease in a reduced PATH environment', () => {
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
      serverRole: 'writer',
    })

    const result = globalThis.Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
          import {Effect} from 'effect'
          import {acquireDuckdbOwnerLease} from './src/server/utils/duckdbOwnerLease.ts'

          const nextLease = await Effect.runPromise(
            acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: ${JSON.stringify(duckdbPath)}, serverRole: 'writer'}),
          )

          console.log(JSON.stringify(nextLease))
        `,
      ],
      {
        cwd: process.cwd(),
        env: {...process.env, PATH: '/usr/bin:/bin'},
        stderr: 'pipe',
        stdout: 'pipe',
      },
    )

    const stdout = Buffer.from(result.stdout ?? []).toString().trim()
    const stderr = Buffer.from(result.stderr ?? []).toString().trim()

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

test('writer does not reclaim stale foreign lease without matching machine fingerprint', async () => {
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
      serverRole: 'writer',
    })

    const acquireLeaseError = await Effect.runPromise(
      acquireDuckdbOwnerLease({apiServerPort: 3999, databasePath: duckdbPath, serverRole: 'writer'}),
    )
      .then(() => {
        return null
      })
      .catch((error: unknown) => {
        return error
      })

    expect(acquireLeaseError).toBeInstanceOf(Error)
    expect((acquireLeaseError as Error).message).toContain('DuckDB writer lease is held by')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('writer treats EPERM pid checks as an active process', () => {
  const originalKill = process.kill
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
      serverRole: 'writer',
    })

    expect(isAlive).toBe(true)
    expect(seenCalls).toContainEqual([999_999, 0])
  } finally {
    process.kill = originalKill
  }
})

test('writer can take over a stale foreign lease when auto mode already selected that lease', async () => {
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
      serverRole: 'writer',
    })

    const nextLease = await Effect.runPromise(
      acquireDuckdbOwnerLease({
        apiServerPort: 3999,
        databasePath: duckdbPath,
        serverRole: 'writer',
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

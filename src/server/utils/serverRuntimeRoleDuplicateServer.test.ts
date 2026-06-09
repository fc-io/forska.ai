import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {getRuntimeCutoverVersion} from './runtimeCutover.ts'

test('auto follower exits when another local process already owns the same writer port', () => {
  const tempDirectory = mkdtempSync('/tmp/f1-server-runtime-role-')
  const duckdbPath = join(tempDirectory, 'test.duckdb')
  const leasePath = `${duckdbPath}.duckdb-owner.lock`
  const now = new Date().toISOString()

  writeFileSync(
    leasePath,
    `${JSON.stringify(
      {
        acquiredAt: now,
        apiServerPort: 3999,
        databasePath: duckdbPath,
        heartbeatAt: now,
        hostname: hostname(),
        leaseId: 'lease-id',
        pid: process.pid,
        runtimeVersion: getRuntimeCutoverVersion(),
        serverRole: 'maintenance-worker',
      },
      null,
      2,
    )}\n`,
  )

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {initializeServerRuntimeRole} = await import('./src/server/utils/serverRuntimeRole.ts')
          await initializeServerRuntimeRole()
          console.log('alive')
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: '3999',
          DUCKDB_MEMORY_LIMIT: '1GB',
          DUCKDB_PATH: duckdbPath,
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          SERVER_ROLE: 'auto',
          SERVER_DUCKDB_OWNER_URL: '',
          VITE_PORT: '3000',
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).not.toContain('alive')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('auto role resumes writer when the existing lease belongs to the current process', () => {
  const tempDirectory = mkdtempSync('/tmp/f1-server-runtime-role-')
  const duckdbPath = join(tempDirectory, 'test.duckdb')

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {writeFileSync} = await import('node:fs')
          const {hostname} = await import('node:os')
          const {getRuntimeCutoverVersion} = await import('./src/server/utils/runtimeCutover.ts')
          const now = new Date().toISOString()
          const duckdbPath = process.env.DUCKDB_PATH
          const leasePath = duckdbPath + '.duckdb-owner.lock'
          const lease = {
            acquiredAt: now,
            apiServerPort: 3999,
            databasePath: duckdbPath,
            heartbeatAt: now,
            hostname: hostname(),
            leaseId: 'lease-id',
            pid: process.pid,
            runtimeVersion: getRuntimeCutoverVersion(),
            serverRole: 'maintenance-worker',
          }

          writeFileSync(leasePath, JSON.stringify(lease, null, 2) + '\\n')

          const {getCurrentServerRole, initializeServerRuntimeRole} = await import('./src/server/utils/serverRuntimeRole.ts')
          await initializeServerRuntimeRole()
          console.log('role=' + getCurrentServerRole())
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: '3999',
          DUCKDB_MEMORY_LIMIT: '1GB',
          DUCKDB_PATH: duckdbPath,
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          SERVER_ROLE: 'auto',
          SERVER_DUCKDB_OWNER_URL: '',
          VITE_PORT: '3000',
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('role=maintenance-worker')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('explicit owner role refreshes its DuckDB owner lease heartbeat after acquisition', {timeout: 15_000}, () => {
  const tempDirectory = mkdtempSync('/tmp/f1-server-runtime-role-')
  const duckdbPath = join(tempDirectory, 'test.duckdb')

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {readFileSync} = await import('node:fs')
          const {
            ensureCurrentDuckdbOwnerLease,
            releaseCurrentDuckdbOwnerLease,
          } = await import('./src/server/utils/serverRuntimeRole.ts')

          const leasePath = process.env.DUCKDB_PATH + '.duckdb-owner.lock'
          const readHeartbeatAt = () => {
            return JSON.parse(readFileSync(leasePath, 'utf8')).heartbeatAt
          }

          await ensureCurrentDuckdbOwnerLease()
          const initialHeartbeatAt = readHeartbeatAt()
          await new Promise((resolve) => setTimeout(resolve, 5_500))
          const refreshedHeartbeatAt = readHeartbeatAt()
          await releaseCurrentDuckdbOwnerLease()

          console.log(JSON.stringify({initialHeartbeatAt, refreshedHeartbeatAt}))
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: '3999',
          DUCKDB_MEMORY_LIMIT: '1GB',
          DUCKDB_PATH: duckdbPath,
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          SERVER_ROLE: 'maintenance-worker',
          SERVER_DUCKDB_OWNER_URL: '',
          VITE_PORT: '3000',
        },
      },
    )

    expect(result.exitCode).toBe(0)

    const output = result.stdout.toString().trim()
    const parsed = JSON.parse(output) as {initialHeartbeatAt: string; refreshedHeartbeatAt: string}

    expect(parsed.refreshedHeartbeatAt).not.toBe(parsed.initialHeartbeatAt)
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

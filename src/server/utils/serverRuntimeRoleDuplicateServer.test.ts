import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

test('auto follower exits when another local process already owns the same writer port', () => {
  const tempDirectory = mkdtempSync('/tmp/f1-server-runtime-role-')
  const duckdbPath = join(tempDirectory, 'test.duckdb')
  const leasePath = `${duckdbPath}.writer.lock`
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
        serverRole: 'writer',
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
          SERVER_WRITER_URL: '',
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
          const now = new Date().toISOString()
          const duckdbPath = process.env.DUCKDB_PATH
          const leasePath = duckdbPath + '.writer.lock'
          const lease = {
            acquiredAt: now,
            apiServerPort: 3999,
            databasePath: duckdbPath,
            heartbeatAt: now,
            hostname: hostname(),
            leaseId: 'lease-id',
            pid: process.pid,
            serverRole: 'writer',
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
          SERVER_WRITER_URL: '',
          VITE_PORT: '3000',
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('role=writer')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

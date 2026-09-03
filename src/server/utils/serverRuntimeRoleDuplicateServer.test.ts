import {spawnSync} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {hostname, tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {expect, test} from 'bun:test'

const getChildRuntimeEnv = (overrides: Record<string, string>) => {
  return {
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    USER: process.env.USER ?? '',
    ...overrides,
  }
}

const repoRoot = resolve(import.meta.dir, '../../..')

const getLastJsonLine = (output: string) => {
  return (
    output
      .trim()
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim()
        return trimmed.startsWith('{') && trimmed.endsWith('}')
      })
      .at(-1) ?? ''
  )
}

test('auto follower exits when another local process already owns the same writer port', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'f1-server-runtime-role-'))
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
        runtimeVersion: 'split-runtime-v1',
        serverRole: 'maintenance-worker',
      },
      null,
      2,
    )}\n`,
  )

  try {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
          const {initializeServerRuntimeRole} = await import('./src/server/utils/serverRuntimeRole.ts')
          await initializeServerRuntimeRole()
          console.log('alive')
        `,
      ],
      {
        cwd: repoRoot,
        env: getChildRuntimeEnv({
          API_SERVER_PORT: '3999',
          DUCKDB_MEMORY_LIMIT: '1GB',
          DUCKDB_PATH: duckdbPath,
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          SERVER_ROLE: 'auto',
          SERVER_DUCKDB_OWNER_URL: '',
          VITE_PORT: '3000',
        }),
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout.toString()).not.toContain('alive')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('auto role resumes writer when the existing lease belongs to the current process', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'f1-server-runtime-role-'))
  const duckdbPath = join(tempDirectory, 'test.duckdb')

  try {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
          const {writeFileSync} = await import('node:fs')
          const {hostname} = await import('node:os')
          const {getLocalMachineFingerprint} = await import('./src/server/utils/localMachineIdentity.ts')
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
            machineFingerprint: getLocalMachineFingerprint(),
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
        cwd: repoRoot,
        env: getChildRuntimeEnv({
          API_SERVER_PORT: '3999',
          DUCKDB_MEMORY_LIMIT: '1GB',
          DUCKDB_PATH: duckdbPath,
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          SERVER_ROLE: 'auto',
          SERVER_DUCKDB_OWNER_URL: '',
          VITE_PORT: '3000',
        }),
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout.toString()).toContain('role=maintenance-worker')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('auto role keeps ownership when a promotion handler fails', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'f1-server-runtime-role-'))
  const duckdbPath = join(tempDirectory, 'test.duckdb')

  try {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
          const {
            getCurrentServerRole,
            initializeServerRuntimeRole,
            registerDuckdbOwnerPromotionHandler,
            releaseCurrentDuckdbOwnerLease,
          } = await import('./src/server/utils/serverRuntimeRole.ts')

          registerDuckdbOwnerPromotionHandler(() => {
            throw new Error('promotion hook failed')
          })

          await initializeServerRuntimeRole()
          const role = getCurrentServerRole()
          await releaseCurrentDuckdbOwnerLease()
          console.log(JSON.stringify({role}))
        `,
      ],
      {
        cwd: repoRoot,
        env: getChildRuntimeEnv({
          API_SERVER_PORT: '3999',
          DUCKDB_MEMORY_LIMIT: '1GB',
          DUCKDB_PATH: duckdbPath,
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          SERVER_ROLE: 'auto',
          SERVER_DUCKDB_OWNER_URL: '',
          VITE_PORT: '3000',
        }),
      },
    )

    expect(result.status).toBe(0)
    expect(JSON.parse(getLastJsonLine(result.stdout.toString()))).toEqual({role: 'maintenance-worker'})
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('explicit owner role refreshes its DuckDB owner lease heartbeat after acquisition', {timeout: 15_000}, () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'f1-server-runtime-role-'))
  const duckdbPath = join(tempDirectory, 'test.duckdb')

  try {
    const result = spawnSync(
      process.execPath,
      [
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
        cwd: repoRoot,
        env: getChildRuntimeEnv({
          API_SERVER_PORT: '3999',
          DUCKDB_MEMORY_LIMIT: '1GB',
          DUCKDB_PATH: duckdbPath,
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          SERVER_ROLE: 'maintenance-worker',
          SERVER_DUCKDB_OWNER_URL: '',
          VITE_PORT: '3000',
        }),
      },
    )

    expect(result.status).toBe(0)

    const output = result.stdout.toString().trim()
    const parsed = JSON.parse(output) as {initialHeartbeatAt: string; refreshedHeartbeatAt: string}

    expect(parsed.refreshedHeartbeatAt).not.toBe(parsed.initialHeartbeatAt)
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

test('explicit owner role demotes after DuckDB owner lease loss', {timeout: 15_000}, () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'f1-server-runtime-role-'))
  const duckdbPath = join(tempDirectory, 'test.duckdb')

  try {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
          const {writeFileSync} = await import('node:fs')
          const {hostname} = await import('node:os')
          const {getLocalMachineFingerprint} = await import('./src/server/utils/localMachineIdentity.ts')
          const {getRuntimeCutoverVersion} = await import('./src/server/utils/runtimeCutover.ts')
          const {
            ensureCurrentDuckdbOwnerLease,
            getCurrentServerRole,
            releaseCurrentDuckdbOwnerLease,
          } = await import('./src/server/utils/serverRuntimeRole.ts')

          const leasePath = process.env.DUCKDB_PATH + '.duckdb-owner.lock'
          const writeReplacementLease = () => {
            const now = new Date().toISOString()
            writeFileSync(
              leasePath,
              JSON.stringify(
                {
                  acquiredAt: now,
                  apiServerPort: 4001,
                  databasePath: process.env.DUCKDB_PATH,
                  heartbeatAt: now,
                  hostname: hostname(),
                  leaseId: 'replacement-lease-id',
                  machineFingerprint: getLocalMachineFingerprint(),
                  pid: process.pid,
                  runtimeVersion: getRuntimeCutoverVersion(),
                  serverRole: 'maintenance-worker',
                },
                null,
                2,
              ) + '\\n',
            )
          }

          await ensureCurrentDuckdbOwnerLease()
          writeReplacementLease()
          await new Promise((resolve) => setTimeout(resolve, 5_500))
          const roleAfterLoss = getCurrentServerRole()
          await releaseCurrentDuckdbOwnerLease()

          console.log(JSON.stringify({roleAfterLoss}))
        `,
      ],
      {
        cwd: repoRoot,
        env: getChildRuntimeEnv({
          API_SERVER_PORT: '3999',
          DUCKDB_MEMORY_LIMIT: '1GB',
          DUCKDB_PATH: duckdbPath,
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          SERVER_ROLE: 'maintenance-worker',
          SERVER_DUCKDB_OWNER_URL: '',
          VITE_PORT: '3000',
        }),
      },
    )

    if (result.status !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB explicit lease loss test failed')
    }

    const parsed = JSON.parse(getLastJsonLine(result.stdout.toString())) as {roleAfterLoss: string}

    expect(parsed.roleAfterLoss).toBe('api')
  } finally {
    rmSync(tempDirectory, {force: true, recursive: true})
  }
})

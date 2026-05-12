import {mkdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

const removePathIfExists = (path: string) => {
  rmSync(path, {force: true, recursive: true})
}

const getLastJsonLine = (output: string) => {
  return output
    .trim()
    .split('\n')
    .filter((line) => {
      return line.trim().startsWith('[')
    })
    .at(-1)
}

test('DuckDB owner roles skip live read-only backend validation before migrations', () => {
  const dataRoot = join(tmpdir(), `forska-ownerless-readable-backends-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'forska.duckdb')
  const runValidation = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {initializeServerRuntimeRole} = await import('./src/server/utils/serverRuntimeRole.ts')
        const {validateOwnerlessRouteBackends} = await import('./src/server/utils/ownerlessReadableBackends.ts')

        await migrateDuckdb()
        await getAppDatabaseService().close()
        await initializeServerRuntimeRole()
        const selections = await validateOwnerlessRouteBackends()
        await migrateDuckdb()
        await getAppDatabaseService().close()
        console.log(JSON.stringify(selections))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39201',
        DUCKDB_MEMORY_LIMIT: '1GB',
        DUCKDB_PATH: duckdbPath,
        FORSKA_DISABLE_LIVE_READ_ONLY_DUCKDB: '',
        FORSKA_OWNERLESS_READ_ONLY_DUCKDB: '',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39200',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )

  try {
    if (runValidation.exitCode !== 0) {
      throw new Error(runValidation.stderr.toString() || runValidation.stdout.toString() || 'validation failed')
    }

    const jsonLine = getLastJsonLine(runValidation.stdout.toString())
    const selections = JSON.parse(jsonLine ?? '[]') as Array<{backend: string; method: string; pathname: string}>
    const connectionsBackend = selections.find((selection) => {
      return selection.method === 'GET' && selection.pathname === '/api/duckdb_owner_connections'
    })

    expect(connectionsBackend).toMatchObject({backend: 'ownerless-control-state'})
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('API ownerless validation releases live read-only DuckDB lock', () => {
  const dataRoot = join(tmpdir(), `forska-ownerless-readable-api-lock-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'forska.duckdb')
  mkdirSync(dataRoot, {recursive: true})
  const runValidation = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {DuckDBInstance} = await import('@duckdb/node-api')
        const {validateOwnerlessRouteBackends} = await import('./src/server/utils/ownerlessReadableBackends.ts')

        const createWriter = async () => {
          const duckdbInstance = await DuckDBInstance.create(process.env.DUCKDB_PATH)
          const connection = await duckdbInstance.connect()

          return {connection, duckdbInstance}
        }

        const closeWriter = (writer) => {
          writer.connection.closeSync()
          writer.duckdbInstance.closeSync()
        }

        const initialWriter = await createWriter()
        await initialWriter.connection.runAndReadAll('CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)')
        closeWriter(initialWriter)

        const selections = await validateOwnerlessRouteBackends()
        const nextWriter = await createWriter()
        await nextWriter.connection.runAndReadAll('CREATE TABLE IF NOT EXISTS lock_probe_after_validation (id INTEGER)')
        closeWriter(nextWriter)

        console.log(JSON.stringify([{selections, writeSucceeded: true}]))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39211',
        DUCKDB_MEMORY_LIMIT: '1GB',
        DUCKDB_PATH: duckdbPath,
        FORSKA_DISABLE_LIVE_READ_ONLY_DUCKDB: '',
        FORSKA_OWNERLESS_READ_ONLY_DUCKDB: '',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'api',
        VITE_PORT: '39210',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )

  try {
    if (runValidation.exitCode !== 0) {
      throw new Error(runValidation.stderr.toString() || runValidation.stdout.toString() || 'validation failed')
    }

    const jsonLine = getLastJsonLine(runValidation.stdout.toString())
    const [result = {selections: [], writeSucceeded: false}] = JSON.parse(jsonLine ?? '[]') as Array<{
      selections: Array<{backend: string; method: string; pathname: string}>
      writeSucceeded: boolean
    }>
    const connectionsBackend = result.selections.find((selection) => {
      return selection.method === 'GET' && selection.pathname === '/api/duckdb_owner_connections'
    })

    expect(connectionsBackend).toMatchObject({backend: 'live-read-only-duckdb'})
    expect(result.writeSucceeded).toBe(true)
  } finally {
    removePathIfExists(dataRoot)
  }
})

test('API owner proxy skips live read-only DuckDB validation', () => {
  const dataRoot = join(tmpdir(), `forska-ownerless-readable-api-owner-proxy-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'forska.duckdb')
  mkdirSync(dataRoot, {recursive: true})
  const runValidation = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {DuckDBInstance} = await import('@duckdb/node-api')
        const {validateOwnerlessRouteBackends} = await import('./src/server/utils/ownerlessReadableBackends.ts')

        const duckdbInstance = await DuckDBInstance.create(process.env.DUCKDB_PATH)
        const connection = await duckdbInstance.connect()
        await connection.runAndReadAll('CREATE TABLE IF NOT EXISTS owner_proxy_probe (id INTEGER)')
        connection.closeSync()
        duckdbInstance.closeSync()

        const selections = await validateOwnerlessRouteBackends()

        console.log(JSON.stringify(selections))
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39221',
        DUCKDB_MEMORY_LIMIT: '1GB',
        DUCKDB_PATH: duckdbPath,
        FORSKA_DISABLE_LIVE_READ_ONLY_DUCKDB: '',
        FORSKA_OWNERLESS_READ_ONLY_DUCKDB: '',
        SERVER_DUCKDB_OWNER_URL: 'http://127.0.0.1:39222',
        SERVER_ROLE: 'api',
        VITE_PORT: '39220',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )

  try {
    if (runValidation.exitCode !== 0) {
      throw new Error(runValidation.stderr.toString() || runValidation.stdout.toString() || 'validation failed')
    }

    const jsonLine = getLastJsonLine(runValidation.stdout.toString())
    const selections = JSON.parse(jsonLine ?? '[]') as Array<{backend: string; method: string; pathname: string}>
    const connectionsBackend = selections.find((selection) => {
      return selection.method === 'GET' && selection.pathname === '/api/duckdb_owner_connections'
    })

    expect(connectionsBackend).toMatchObject({backend: 'ownerless-control-state'})
  } finally {
    removePathIfExists(dataRoot)
  }
})

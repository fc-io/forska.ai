import {rmSync} from 'node:fs'
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

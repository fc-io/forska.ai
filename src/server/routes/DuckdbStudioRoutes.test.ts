import {existsSync, rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

test('duckdb studio route creates a readable snapshot', () => {
  const duckdbPath = `/tmp/f1-duckdb-studio-route-${Date.now()}.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {duckdbStudioRoutes, duckdbStudioSnapshotPath} = await import('./src/server/routes/DuckdbStudioRoutes.ts')
        const {runDuckdbStatement, closeDuckdbService} = await import('./src/server/utils/duckdbService.ts')
        await runDuckdbStatement('CREATE SCHEMA IF NOT EXISTS app')
        await runDuckdbStatement('CREATE TABLE IF NOT EXISTS app.sample (value INTEGER NOT NULL)')
        await runDuckdbStatement('DELETE FROM app.sample')
        await runDuckdbStatement('INSERT INTO app.sample (value) VALUES (42)')
        const app = new Elysia().use(duckdbStudioRoutes)
        const response = await app.handle(new Request('http://localhost' + duckdbStudioSnapshotPath, {method: 'POST'}))
        console.log(await response.text())
        await closeDuckdbService()
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'dev-single'}},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'DuckDB studio route test failed')
  }

  const responseBody = JSON.parse(runRoute.stdout.toString()) as {data: {snapshotPath: string; createdAt: string}}
  const snapshotPath = responseBody.data.snapshotPath
  const query = globalThis.Bun.spawnSync([
    'duckdb',
    '-readonly',
    '-json',
    snapshotPath,
    'SELECT value FROM app.sample LIMIT 1',
  ])

  try {
    if (query.exitCode !== 0) {
      throw new Error(query.stderr.toString() || query.stdout.toString() || 'Failed to read DuckDB snapshot')
    }

    expect(responseBody.data.createdAt).toContain('T')
    expect(existsSync(snapshotPath)).toBe(true)
    expect(JSON.parse(query.stdout.toString())).toEqual([{value: 42}])
  } finally {
    removeFileIfExists(snapshotPath)
    removeFileIfExists(`${snapshotPath}.wal`)
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
  }
})

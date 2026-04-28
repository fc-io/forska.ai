import {existsSync, rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const getLastJsonLine = (stdout: string) => {
  const [lastLine = ''] = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })
    .slice(-1)

  return lastLine
}

test('duckdb transaction keeps the original error when rollback fails', () => {
  const duckdbPath = `/tmp/f1-duckdb-transaction-rollback-test-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const duckdbServiceModule = await import('./src/server/utils/duckdbService.ts?transaction-rollback-test=' + Date.now())
        await duckdbServiceModule.runDuckdbJsonQuery('SELECT 1 AS value')

        try {
          await duckdbServiceModule.runDuckdbTransaction(async () => {
            const duckdbServiceState = globalThis.__forskaDuckdbServiceState
            duckdbServiceState.controlConnection?.closeSync()
            duckdbServiceState.duckdbInstance?.closeSync()
            duckdbServiceState.controlConnection = null
            duckdbServiceState.duckdbInstance = null
            throw new Error('original failure')
          })
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error))
        }
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: '/tmp/f1-duckdb-transaction-rollback-test-temp',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB rollback subprocess failed')
    }

    expect(result.stdout.toString().trim()).toBe('original failure -- rollback failed: DuckDB connection not started')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('duckdb background statement rolls back a failed explicit transaction before the next read', () => {
  const duckdbPath = `/tmp/f1-duckdb-background-rollback-test-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const duckdbServiceModule = await import('./src/server/utils/duckdbService.ts?background-rollback-test=' + Date.now())
        await duckdbServiceModule.runDuckdbStatement('CREATE SCHEMA app; CREATE TABLE app.sample (id VARCHAR PRIMARY KEY)')

        let failureText = null

        try {
          await duckdbServiceModule.runDuckdbBackgroundStatement(\`
            BEGIN TRANSACTION;
            INSERT INTO app.sample (id) VALUES ('duplicate-id');
            INSERT INTO app.sample (id) VALUES ('duplicate-id');
            COMMIT;
          \`)
        } catch (error) {
          failureText = error instanceof Error ? error.message : String(error)
        }

        const [row] = await duckdbServiceModule.runDuckdbBackgroundJsonQuery('SELECT COUNT(*) AS total FROM app.sample')
        console.log(JSON.stringify({failureText, row}))
        await duckdbServiceModule.closeDuckdbService()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3999',
        DUCKDB_MEMORY_LIMIT: '20GB',
        DUCKDB_PATH: duckdbPath,
        DUCKDB_TEMP_DIRECTORY: '/tmp/f1-duckdb-background-rollback-test-temp',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB background rollback failed')
    }

    const parsed = JSON.parse(getLastJsonLine(result.stdout.toString())) as {
      failureText: string | null
      row: {total: string}
    }

    expect(typeof parsed.failureText).toBe('string')
    expect(parsed.failureText).not.toContain('Current transaction is aborted')
    expect(parsed.row).toEqual({total: '0'})
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

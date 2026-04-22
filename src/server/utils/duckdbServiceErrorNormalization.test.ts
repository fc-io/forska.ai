import {expect, test} from 'bun:test'

test('duckdb service keeps the underlying Effect error detail', () => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')

        try {
          await runDuckdbJsonQuery('SELECT 1 AS value')
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
        DUCKDB_PATH: ':memory:',
        SERVER_ROLE: 'api',
        SERVER_WRITER_URL: '',
      },
    },
  )

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB error normalization',
    )
  }

  expect(result.stdout.toString().trim()).toContain('Current server role api cannot own DuckDB')
})

test('duckdb service includes statement context in query failures', () => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')

        try {
          await runDuckdbJsonQuery('SELECT * FROM definitely_missing_table')
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
        DUCKDB_PATH: ':memory:',
        SERVER_ROLE: 'writer',
        SERVER_WRITER_URL: '',
      },
    },
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB statement context')
  }

  expect(result.stdout.toString().trim()).toContain('duckdb main query: SELECT * FROM definitely_missing_table')
})

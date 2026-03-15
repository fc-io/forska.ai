import {expect, test} from 'bun:test'
import {existsSync, unlinkSync} from 'fs'

import {runDuckdbJsonQuery} from './duckdbRunner.ts'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

test('runDuckdbJsonQuery reads native duckdb tables', async () => {
  const duckdbPath = `/tmp/f1-duckdb-runner-${Date.now()}.duckdb`
  const init = globalThis.Bun.spawnSync([
    'duckdb',
    '-json',
    duckdbPath,
    "CREATE SCHEMA IF NOT EXISTS app; CREATE TABLE app.sample (id VARCHAR PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO app.sample (id, value) VALUES ('a', 2), ('b', 5);",
  ])

  if (init.exitCode !== 0) {
    throw new Error(init.stderr.toString() || init.stdout.toString() || 'Failed to initialize DuckDB test database')
  }

  try {
    const rows = await runDuckdbJsonQuery<{total: number}>(`SELECT SUM(value) AS total FROM app.sample`, duckdbPath)

    expect(rows[0]?.total).toBe(7)
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

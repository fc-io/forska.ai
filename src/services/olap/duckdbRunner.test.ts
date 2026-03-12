import {Database} from 'bun:sqlite'
import {expect, test} from 'bun:test'
import {existsSync, unlinkSync} from 'fs'

import {runDuckdbJsonQuery} from './duckdbRunner.ts'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

test('runDuckdbJsonQuery reads attached sqlite tables', async () => {
  const sqlitePath = `/tmp/f1-duckdb-runner-${Date.now()}.sqlite`
  const sqlite = new Database(sqlitePath, {create: true})

  sqlite.exec('CREATE TABLE sample (id TEXT PRIMARY KEY, value INTEGER NOT NULL);')
  sqlite.exec("INSERT INTO sample (id, value) VALUES ('a', 2), ('b', 5);")
  sqlite.close()

  const rows = await runDuckdbJsonQuery<{total: number}>(`SELECT SUM(value) AS total FROM app.sample`, sqlitePath)

  expect(rows[0]?.total).toBe(7)

  removeFileIfExists(sqlitePath)
})

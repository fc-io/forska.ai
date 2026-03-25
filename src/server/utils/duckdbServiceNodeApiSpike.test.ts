import {existsSync, rmSync} from 'node:fs'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

test('duckdb node-api opens cached instance with multiple connections', async () => {
  const duckdbPath = `/tmp/f1-duckdb-node-api-spike-${Date.now()}.duckdb`

  try {
    const duckdbInstance = await DuckDBInstance.fromCache(duckdbPath, {memory_limit: '128MiB'})
    const firstConnection = await duckdbInstance.connect()
    const secondConnection = await duckdbInstance.connect()

    await firstConnection.run('CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (1), (2)')
    await secondConnection.run('CHECKPOINT')

    const countReader = await firstConnection.runAndReadAll('SELECT COUNT(*) AS total FROM sample')
    const settingReader = await secondConnection.runAndReadAll("SELECT current_setting('memory_limit') AS memoryLimit")

    expect(countReader.getRowObjectsJson()).toEqual([{total: '2'}])
    expect(settingReader.getRowObjectsJson()).toEqual([{memoryLimit: '128.0 MiB'}])

    secondConnection.closeSync()
    firstConnection.closeSync()
    duckdbInstance.closeSync()
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

import assert from 'node:assert/strict'
import {join} from 'node:path'

import {duckdbEngineCompatibilityOptions} from '../../src/server/utils/duckdbEngineContract.ts'
import manifest from '../../vendor/duckdb/manifest.json'
import {getInstalledDuckdbDistribution} from './getInstalledDuckdbDistribution.ts'

export const verifyDuckdbWal = async (packageRoot: string, phase: string, directory: string) => {
  assert.ok(phase === 'seed' || phase === 'reopen', 'Unsupported distribution verification phase')
  const {DuckDBInstance} = getInstalledDuckdbDistribution(packageRoot)
  const instance = await DuckDBInstance.create(join(directory, 'new-wal.duckdb'), {
    ...duckdbEngineCompatibilityOptions,
    memory_limit: '128MiB',
    threads: '1',
    checkpoint_threshold: '1TB',
  })
  const connection = await instance.connect()
  try {
    await connection.run('PRAGMA disable_checkpoint_on_shutdown')
    const version = (await connection.runAndReadAll('PRAGMA version')).getRowObjectsJS()[0]
    assert.equal(version?.library_version, manifest.engine.version)
    assert.equal(version?.source_id, manifest.engine.sourceId)
    const nulls = (
      await connection.runAndReadAll("SELECT NULL AS scalar_null, [NULL] AS list_null, {'value': NULL} AS struct_null")
    ).getRowObjectsJS()
    assert.deepEqual(nulls, [{scalar_null: null, list_null: [null], struct_null: {value: null}}])
    if (phase === 'seed') {
      await connection.run('CREATE TABLE distribution_probe(id INTEGER PRIMARY KEY, value VARCHAR)')
      await connection.run('BEGIN TRANSACTION')
      await connection.run("INSERT INTO distribution_probe VALUES (1, 'committed'), (2, 'retained')")
      await connection.run('COMMIT')
      await connection.run('BEGIN TRANSACTION')
      await connection.run("UPDATE distribution_probe SET value = 'rolled-back' WHERE id = 1")
      await connection.run('ROLLBACK')
    }
    const rows = (await connection.runAndReadAll('SELECT * FROM distribution_probe ORDER BY id')).getRowObjectsJS()
    assert.deepEqual(rows, [
      {id: 1, value: 'committed'},
      {id: 2, value: 'retained'},
    ])
    console.log(`duckdb-distribution:${phase}:pass`, {rows, nulls})
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

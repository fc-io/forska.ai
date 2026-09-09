import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'

import type {DuckDBInstance} from '@duckdb/node-api'

import {createDuckdbInstance} from '../../src/server/utils/createDuckdbInstance.ts'
import fixture from '../../src/server/utils/duckdbEngineCompatibility/fixtures/duckdb151StringStatsAlphaWal.json'
import {
  duckdbEngineCompatibilityOptions,
  type DuckdbEngineIdentity,
  duckdbExpectedEngineIdentity,
} from '../../src/server/utils/duckdbEngineContract.ts'
import {getInstalledDuckdbDistribution} from './getInstalledDuckdbDistribution.ts'

const insertedRow = {id: 'projection:10000000000000000000000000000000', n: 408}
const expectedRows = [
  ...Array.from({length: 406}, (_, index) => {
    const n = index + 1

    return {id: `projection:${createHash('sha256').update(String(n)).digest('hex').slice(0, 32)}`, n}
  }),
  insertedRow,
]

export const verifyDuckdbStringStatisticsRuntime = async (
  runtime: {DuckDBInstance: typeof DuckDBInstance},
  phase: string,
  directory: string,
  expectedEngine: DuckdbEngineIdentity,
) => {
  assert.ok(['statistics-replay', 'statistics-checkpoint', 'statistics-reopen'].includes(phase))
  const databasePath = join(directory, 'string-statistics.duckdb')

  if (phase === 'statistics-replay') {
    assert.ok(!existsSync(databasePath), 'String statistics fixture must start from its preserved bytes')
    ;[
      {path: databasePath, bytes: fixture.files.database},
      {path: `${databasePath}.wal`, bytes: fixture.files.wal},
    ].map(({path, bytes}) => {
      const decoded = gunzipSync(Buffer.from(bytes.gzipBase64, 'base64'))
      assert.equal(createHash('sha256').update(decoded).digest('hex'), bytes.sha256)
      writeFileSync(path, decoded)

      return path
    })
  }

  const {DuckDBInstance} = runtime
  const before = phase === 'statistics-replay' ? [readFileSync(databasePath), readFileSync(`${databasePath}.wal`)] : []
  const instance = await createDuckdbInstance({
    create: DuckDBInstance.create.bind(DuckDBInstance),
    databasePath,
    expectedEngine,
    options: {
      ...duckdbEngineCompatibilityOptions,
      disabled_optimizers: 'cte_inlining',
      memory_limit: '128MiB',
      threads: '1',
      access_mode: phase === 'statistics-checkpoint' ? 'READ_WRITE' : 'READ_ONLY',
      autoinstall_known_extensions: 'false',
    },
  })
  const connection = await instance.connect()

  try {
    const all = (await connection.runAndReadAll('SELECT id, n FROM stats_fixture ORDER BY n')).getRowObjectsJson()
    assert.deepEqual(all, expectedRows)
    const chosenRows = [expectedRows[122], insertedRow]
    const selectedIds = chosenRows.map(({id}) => {
      return `'${id}'`
    })
    const exact = (
      await connection.runAndReadAll(
        `SELECT id, n FROM stats_fixture WHERE id IN (${selectedIds.join(',')}) ORDER BY n`,
      )
    ).getRowObjectsJson()
    assert.deepEqual(exact, chosenRows)
    const range = (
      await connection.runAndReadAll("SELECT id, n FROM stats_fixture WHERE id >= 'projection:8' ORDER BY n")
    ).getRowObjectsJson()
    assert.deepEqual(
      range,
      expectedRows.filter(({id}) => {
        return id >= 'projection:8'
      }),
    )
    const joined = (
      await connection.runAndReadAll(`
        SELECT fixture.id, n FROM stats_fixture fixture
        JOIN (VALUES (${selectedIds[0]}), (${selectedIds[1]})) probe(id) ON fixture.id = probe.id ORDER BY n
      `)
    ).getRowObjectsJson()
    assert.deepEqual(joined, chosenRows)

    if (phase === 'statistics-checkpoint') {
      await connection.run('CHECKPOINT')
    }
  } finally {
    connection.closeSync()
    instance.closeSync()
  }

  if (phase === 'statistics-replay') {
    assert.deepEqual([readFileSync(databasePath), readFileSync(`${databasePath}.wal`)], before)
  }

  console.log(`duckdb-distribution:${phase}:pass`, {rows: expectedRows.length, exactIds: 2, range: true, join: true})
}

export const verifyDuckdbStringStatistics = async (packageRoot: string, phase: string, directory: string) => {
  return verifyDuckdbStringStatisticsRuntime(
    getInstalledDuckdbDistribution(packageRoot),
    phase,
    directory,
    duckdbExpectedEngineIdentity,
  )
}

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'

import type {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'

import {createDuckdbInstance} from '../../src/server/utils/createDuckdbInstance.ts'
import fixture from '../../src/server/utils/duckdbEngineCompatibility/fixtures/duckdb151StringStatsUpdateAlphaWal.json'
import {
  duckdbEngineCompatibilityOptions,
  type DuckdbEngineIdentity,
  duckdbExpectedEngineIdentity,
} from '../../src/server/utils/duckdbEngineContract.ts'
import {getInstalledDuckdbDistribution} from './getInstalledDuckdbDistribution.ts'

const writeFixture = (databasePath: string, includeWal: boolean) => {
  assert.ok(!existsSync(databasePath), 'Updated string statistics fixture must start from preserved bytes')
  const files = includeWal ? (['database', 'wal'] as const) : (['database'] as const)

  for (const name of files) {
    const bytes = gunzipSync(Buffer.from(fixture.files[name].gzipBase64, 'base64'))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.files[name].sha256)
    writeFileSync(name === 'database' ? databasePath : `${databasePath}.wal`, bytes)
  }
}

const assertUpdatedRows = async (connection: DuckDBConnection) => {
  const read = async (statement: string) => {
    return (await connection.runAndReadAll(statement)).getRowObjectsJson()
  }
  const target = fixture.originalRequestId
  const updated = fixture.updatedRequestId
  const expectedCounts = [
    {request_id: updated, n: 1},
    {request_id: target, n: fixture.rowCount - 1},
  ]
  assert.deepEqual(await read('SELECT count(*)::INTEGER n FROM request_chunks'), [{n: fixture.rowCount}])
  assert.deepEqual(
    await read('SELECT request_id, count(*)::INTEGER n FROM request_chunks GROUP BY request_id ORDER BY request_id'),
    expectedCounts,
  )
  assert.deepEqual(
    await read(
      `SELECT count(*)::INTEGER n FROM request_chunks WHERE request_id = '${target}' AND status != 'completed'`,
    ),
    [{n: fixture.rowCount - 1}],
    'A live/replayed legacy-string UPDATE must not prune the other matching rows in its row group',
  )
  assert.deepEqual(
    await read(
      `SELECT chunk_id FROM request_chunks WHERE request_id = '${target}' AND chunk_id IN (1, 2047, 2048) ORDER BY chunk_id`,
    ),
    [{chunk_id: 1}, {chunk_id: 2047}, {chunk_id: 2048}],
  )
  assert.deepEqual(
    await read(
      `SELECT chunk_id FROM request_chunks WHERE request_id >= '${target}' AND chunk_id < 3 ORDER BY chunk_id`,
    ),
    [{chunk_id: 1}, {chunk_id: 2}],
  )
  assert.deepEqual(
    await read(`SELECT chunk_id FROM request_chunks WHERE request_id = '${updated}' ORDER BY chunk_id`),
    [{chunk_id: 0}],
  )
  assert.deepEqual(
    await read(
      `SELECT chunks.request_id, count(*)::INTEGER n FROM request_chunks chunks JOIN (VALUES ('${target}'), ('${updated}')) requests(id) ON chunks.request_id = requests.id GROUP BY chunks.request_id ORDER BY chunks.request_id`,
    ),
    expectedCounts,
  )
}

export const verifyDuckdbUpdatedStringStatisticsRuntime = async (
  runtime: {DuckDBInstance: typeof DuckDBInstance},
  phase: string,
  directory: string,
  expectedEngine: DuckdbEngineIdentity,
) => {
  const liveUpdate = phase === 'updated-statistics-live'
  const replay = phase === 'updated-statistics-replay'
  const checkpoint = phase === 'updated-statistics-checkpoint'
  assert.ok(
    [
      'updated-statistics-live',
      'updated-statistics-live-reopen',
      'updated-statistics-replay',
      'updated-statistics-checkpoint',
      'updated-statistics-reopen',
    ].includes(phase),
  )
  const databasePath = join(
    directory,
    phase.startsWith('updated-statistics-live') ? 'updated-statistics-live.duckdb' : 'updated-statistics.duckdb',
  )

  if (liveUpdate || replay) {
    writeFixture(databasePath, replay)
  }

  const before = replay ? [readFileSync(databasePath), readFileSync(`${databasePath}.wal`)] : []
  const {DuckDBInstance} = runtime
  const instance = await createDuckdbInstance({
    create: DuckDBInstance.create.bind(DuckDBInstance),
    databasePath,
    expectedEngine,
    options: {
      ...duckdbEngineCompatibilityOptions,
      // Exercise the native statistics fix without masking optimizer or scan pruning.
      disabled_optimizers: 'cte_inlining',
      memory_limit: '64MiB',
      threads: '1',
      access_mode: liveUpdate || checkpoint ? 'READ_WRITE' : 'READ_ONLY',
      autoinstall_known_extensions: 'false',
    },
  })
  const connection = await instance.connect()

  try {
    if (liveUpdate) {
      await connection.run(fixture.updateSql)
    }

    await assertUpdatedRows(connection)
    const second = await instance.connect()

    try {
      await assertUpdatedRows(second)
    } finally {
      second.closeSync()
    }

    if (liveUpdate || checkpoint) {
      await connection.run('CHECKPOINT')
      await assertUpdatedRows(connection)
    }
  } finally {
    connection.closeSync()
    instance.closeSync()
  }

  if (replay) {
    assert.deepEqual([readFileSync(databasePath), readFileSync(`${databasePath}.wal`)], before)
  }

  console.log(`duckdb-distribution:${phase}:pass`, {
    rows: fixture.rowCount,
    retained: fixture.rowCount - 1,
    rowGroups: 2,
    exact: true,
    range: true,
    join: true,
  })
}

export const verifyDuckdbUpdatedStringStatistics = async (packageRoot: string, phase: string, directory: string) => {
  return verifyDuckdbUpdatedStringStatisticsRuntime(
    getInstalledDuckdbDistribution(packageRoot),
    phase,
    directory,
    duckdbExpectedEngineIdentity,
  )
}

import assert from 'node:assert/strict'
import {mkdtempSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {type DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'
import {spawnSync} from 'bun'

const rowCount = 524288
const memoryLimits: Record<string, string> = {
  seed: '512MiB',
  checkpoint: '32MiB',
  reopen: '32MiB',
  'compat-reopen': '128MiB',
}
const seedFragmentedRows = async (connection: DuckDBConnection) => {
  await connection.run('CREATE TABLE sample(id BIGINT PRIMARY KEY)')
  await connection.run(`INSERT INTO sample SELECT i FROM range(${rowCount}) t(i)`)
  await connection.run('CHECKPOINT')
  await connection.run('DELETE FROM sample WHERE id % 2 = 0')
  await connection.run('CHECKPOINT')
  const groups = await connection.runAndReadAll(
    "SELECT count(DISTINCT row_group_id) AS groups FROM pragma_storage_info('sample')",
  )
  assert.equal(groups.getRowObjects()[0]?.groups, 256n)
  await connection.run('CREATE TABLE checkpoint_marker AS SELECT 1 AS id')
  console.log('seed:complete', {rowGroups: 256, rowsBeforeDelete: rowCount})
}

const verifyConstrainedCheckpoint = async (connection: DuckDBConnection, phase: string) => {
  console.log(`${phase}:start`, {memoryLimit: memoryLimits[phase], rssBytes: process.memoryUsage().rss})
  if (phase === 'checkpoint') {
    await connection.run('CHECKPOINT')
    console.log('checkpoint:complete', {rssBytes: process.memoryUsage().rss})
  }
  const rows = await connection.runAndReadAll('SELECT count(*) AS rows, sum(id) AS total FROM sample')
  assert.equal(rows.getRowObjects()[0]?.rows, BigInt(rowCount / 2))
  assert.equal(rows.getRowObjects()[0]?.total, BigInt(rowCount / 2) ** 2n)
  const marker = await connection.runAndReadAll('SELECT id FROM checkpoint_marker')
  assert.equal(marker.getRowObjects()[0]?.id, 1)
  const memory = await connection.runAndReadAll('SELECT * FROM duckdb_memory() WHERE memory_usage_bytes > 0')
  console.log('memory', memory.getRowObjects())
  console.log(`${phase}:pass`, {remainingRows: rowCount / 2})
}

const runPhase = async (phase: string, directory: string) => {
  assert.ok(phase === 'seed' || phase === 'checkpoint' || phase === 'reopen' || phase === 'compat-reopen')
  const memoryLimit = memoryLimits[phase]
  const instance = await DuckDBInstance.create(':memory:', {
    checkpoint_threshold: '1TB',
    max_vacuum_tasks: '0',
    memory_limit: memoryLimit,
    preserve_insertion_order: 'false',
    threads: '1',
  })
  const connection = await instance.connect()
  try {
    await connection.run('PRAGMA disable_checkpoint_on_shutdown')
    const path = join(directory, 'fixture.duckdb').replaceAll("'", "''")
    const access = phase === 'compat-reopen' ? ', READ_ONLY' : ''
    await connection.run(`ATTACH '${path}' AS fixture (ROW_GROUP_SIZE 2048, STORAGE_VERSION 'v1.2.0'${access})`)
    await connection.run('USE fixture')
    console.log('engine', (await connection.runAndReadAll('SELECT version() AS version')).getRowObjects())
    if (phase === 'seed') {
      await seedFragmentedRows(connection)
    } else {
      await verifyConstrainedCheckpoint(connection, phase)
    }
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

const runChild = (phase: string, directory: string) => {
  const result = spawnSync([process.execPath, import.meta.path, phase, directory], {
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 60000,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  writeFileSync(join(directory, `${phase}.log`), output)
  console.log(output)
  assert.equal(result.exitCode, 0, `${phase} failed; preserved fixture and logs: ${directory}`)
}

const runRegression = () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-checkpoint-memory-regression-'))
  console.log('artifacts', directory)
  runChild('seed', directory)
  assert.ok(statSync(join(directory, 'fixture.duckdb.wal')).size > 0, 'Fixture must require a real WAL checkpoint')
  runChild('checkpoint', directory)
  runChild('reopen', directory)
}

if (process.argv[2] && process.argv[3]) {
  await runPhase(process.argv[2], process.argv[3])
} else {
  runRegression()
}

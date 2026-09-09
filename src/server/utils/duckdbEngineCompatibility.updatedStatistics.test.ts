import {createHash} from 'node:crypto'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'

import {expect, test} from 'bun:test'

import fixture from './duckdbEngineCompatibility/fixtures/duckdb151StringStatsUpdateAlphaWal.json'

const target = fixture.originalRequestId
const updated = fixture.updatedRequestId
const queries = {
  all: 'SELECT count(*)::INTEGER n FROM request_chunks',
  grouped: 'SELECT request_id, count(*)::INTEGER n FROM request_chunks GROUP BY request_id ORDER BY request_id',
  pending: `SELECT count(*)::INTEGER n FROM request_chunks WHERE request_id = '${target}' AND status != 'completed'`,
  exact: `SELECT chunk_id FROM request_chunks WHERE request_id = '${target}' AND chunk_id IN (1, 2047, 2048) ORDER BY chunk_id`,
  range: `SELECT chunk_id FROM request_chunks WHERE request_id >= '${target}' AND chunk_id < 3 ORDER BY chunk_id`,
  updated: `SELECT chunk_id FROM request_chunks WHERE request_id = '${updated}' ORDER BY chunk_id`,
  joined: `SELECT chunks.request_id, count(*)::INTEGER n FROM request_chunks chunks JOIN (VALUES ('${target}'), ('${updated}')) requests(id) ON chunks.request_id = requests.id GROUP BY chunks.request_id ORDER BY chunks.request_id`,
}
const expected = {
  all: [{n: fixture.rowCount}],
  grouped: [
    {request_id: updated, n: 1},
    {request_id: target, n: fixture.rowCount - 1},
  ],
  pending: [{n: fixture.rowCount - 1}],
  exact: [{chunk_id: 1}, {chunk_id: 2047}, {chunk_id: 2048}],
  range: [{chunk_id: 1}, {chunk_id: 2}],
  updated: [{chunk_id: 0}],
  joined: [
    {request_id: updated, n: 1},
    {request_id: target, n: fixture.rowCount - 1},
  ],
}

const writeFixture = (databasePath: string, includeWal: boolean) => {
  const files = includeWal ? (['database', 'wal'] as const) : (['database'] as const)

  for (const name of files) {
    const bytes = gunzipSync(Buffer.from(fixture.files[name].gzipBase64, 'base64'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.files[name].sha256)
    writeFileSync(name === 'database' ? databasePath : `${databasePath}.wal`, bytes)
  }
}

const runProbe = (databasePath: string, mode: 'native-update' | 'managed-update' | 'readonly' | 'raw-readonly') => {
  const script = `
    const {DuckDBInstance} = await import('@duckdb/node-api')
    const {createDuckdbInstance} = await import('./src/server/utils/createDuckdbInstance.ts')
    const {duckdbEngineCompatibilityOptions} = await import('./src/server/utils/duckdbEngineContract.ts')
    const mode = ${JSON.stringify(mode)}
    const queries = ${JSON.stringify(queries)}
    const options = {...duckdbEngineCompatibilityOptions, memory_limit:'64MiB', threads:'1'}
    if (mode === 'raw-readonly') options.disabled_optimizers = 'cte_inlining'
    const collect = async read => {
      const result = {}
      for (const [name, sql] of Object.entries(queries)) result[name] = await read(sql)
      return result
    }
    const results = []
    if (mode === 'managed-update') {
      const service = await import('./src/server/utils/duckdbService.ts')
      try {
        await service.runDuckdbStatement(${JSON.stringify(fixture.updateSql)})
        results.push(await collect(sql => service.runDuckdbJsonQuery(sql)))
        await service.runDuckdbStatement('CHECKPOINT')
        results.push(await collect(sql => service.runDuckdbJsonQuery(sql)))
      } finally { await service.closeDuckdbService() }
    } else {
      if (mode.endsWith('readonly')) options.access_mode = 'READ_ONLY'
      const instance = await createDuckdbInstance({create:DuckDBInstance.create.bind(DuckDBInstance), databasePath:process.env.DUCKDB_PATH, options})
      const connection = await instance.connect()
      try {
        if (mode === 'native-update') await connection.run(${JSON.stringify(fixture.updateSql)})
        results.push(await collect(async sql => (await connection.runAndReadAll(sql)).getRowObjectsJson()))
        const second = await instance.connect()
        try { results.push(await collect(async sql => (await second.runAndReadAll(sql)).getRowObjectsJson())) }
        finally { second.closeSync() }
        if (mode === 'native-update') {
          await connection.run('CHECKPOINT')
          results.push(await collect(async sql => (await connection.runAndReadAll(sql)).getRowObjectsJson()))
        }
      } finally { connection.closeSync(); instance.closeSync() }
    }
    console.log(JSON.stringify(results))
  `
  const result = globalThis.Bun.spawnSync([process.execPath, '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3999',
      DUCKDB_MEMORY_LIMIT: '64MiB',
      DUCKDB_PATH: databasePath,
      SERVER_DUCKDB_OWNER_URL: '',
      SERVER_ROLE: 'maintenance-worker',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60000,
  })
  expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)
  const stages = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '[]') as (typeof expected)[]
  expect(stages).toHaveLength(mode === 'native-update' ? 3 : 2)

  for (const stage of stages) {
    expect(stage).toEqual(expected)
  }
}

test.each(['native-update', 'managed-update'] as const)(
  '%s retains all matching rows before checkpoint and after a fresh reopen of live legacy-string updates',
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'forska-alpha-updated-stats-'))
    const databasePath = join(root, 'test.duckdb')

    try {
      writeFixture(databasePath, false)
      runProbe(databasePath, mode)
      runProbe(databasePath, 'raw-readonly')
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  },
)

test.each(['readonly', 'raw-readonly'] as const)(
  '%s replay preserves updated multi-rowgroup string matches without changing the database or WAL',
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'forska-alpha-updated-stats-replay-'))
    const databasePath = join(root, 'test.duckdb')

    try {
      writeFixture(databasePath, true)
      const before = [readFileSync(databasePath), readFileSync(`${databasePath}.wal`)]
      runProbe(databasePath, mode)
      expect([readFileSync(databasePath), readFileSync(`${databasePath}.wal`)]).toEqual(before)
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  },
)

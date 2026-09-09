import {createHash} from 'node:crypto'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'

import {expect, test} from 'bun:test'

import stringStatsFixture from './duckdbEngineCompatibility/fixtures/duckdb151StringStatsAlphaWal.json'

const getSeedId = (n: number) => {
  return `projection:${createHash('sha256').update(String(n)).digest('hex').slice(0, 32)}`
}

const retainedRows = Array.from({length: 406}, (_, index) => {
  const n = index + 1

  return {id: getSeedId(n), n}
})
const insertedRow = {id: 'projection:10000000000000000000000000000000', n: 408}
const expectedRows = [...retainedRows, insertedRow]
const expectedResults = {
  all: expectedRows,
  exact: [expectedRows[122], insertedRow],
  range: expectedRows.filter(({id}) => {
    return id >= 'projection:8'
  }),
  joined: [expectedRows[122], insertedRow],
  deleted: [],
}
const queries = {
  all: 'SELECT id, n FROM stats_fixture ORDER BY n',
  exact: `SELECT id, n FROM stats_fixture WHERE id IN ('${getSeedId(123)}', '${insertedRow.id}') ORDER BY n`,
  range: "SELECT id, n FROM stats_fixture WHERE id >= 'projection:8' ORDER BY n",
  joined: `SELECT fixture.id, n FROM stats_fixture fixture JOIN (VALUES ('${getSeedId(123)}'), ('${insertedRow.id}')) probe(id) ON fixture.id = probe.id ORDER BY n`,
  deleted: `SELECT id, n FROM stats_fixture WHERE id = '${getSeedId(0)}' OR n = 0 ORDER BY n`,
}

const writeFixture = (databasePath: string) => {
  const database = gunzipSync(Buffer.from(stringStatsFixture.files.database.gzipBase64, 'base64'))
  const wal = gunzipSync(Buffer.from(stringStatsFixture.files.wal.gzipBase64, 'base64'))
  expect(createHash('sha256').update(database).digest('hex')).toBe(stringStatsFixture.files.database.sha256)
  expect(createHash('sha256').update(wal).digest('hex')).toBe(stringStatsFixture.files.wal.sha256)
  writeFileSync(databasePath, database)
  writeFileSync(`${databasePath}.wal`, wal)

  return {database, wal}
}

const runReader = (databasePath: string, mode: 'native' | 'rawAlpha' | 'managed' | 'ephemeral' | 'ownerless') => {
  const script = `
    const {DuckDBInstance} = await import('@duckdb/node-api')
    const {createDuckdbInstance} = await import('./src/server/utils/createDuckdbInstance.ts')
    const service = await import('./src/server/utils/duckdbService.ts')
    const mode = ${JSON.stringify(mode)}
    const queries = ${JSON.stringify(queries)}
    let instance, connection
    let read, close
    if (mode === 'managed') {
      read = statement => service.runDuckdbJsonQuery(statement)
      close = async () => { await service.runDuckdbStatement('CHECKPOINT'); await service.closeDuckdbService() }
    } else if (mode === 'ephemeral') {
      const {runEphemeralReadOnlyDuckdbFileJsonQuery} = await import('./src/server/utils/duckdbEphemeralReadOnly.ts')
      read = statement => runEphemeralReadOnlyDuckdbFileJsonQuery({
        databasePath: process.env.DUCKDB_PATH, memoryLimit: '128MiB', statement,
        workloadContext: service.getMaintenanceDuckdbWorkloadContext('stringStatsCompatibility'),
      })
      close = async () => {}
    } else if (mode === 'ownerless') {
      const {runReadOnlyDuckdbJsonQuery, closeReadOnlyDuckdbService} = await import('./src/server/services/readOnlyDuckdbService.ts')
      const {withCurrentServerRoleOverride} = await import('./src/server/utils/serverRuntimeRole.ts')
      read = statement => withCurrentServerRoleOverride('api', () => runReadOnlyDuckdbJsonQuery('api-read-only', statement))
      close = closeReadOnlyDuckdbService
    } else {
      const options = service.getReadOnlyDuckdbRuntimeOptions()
      if (mode === 'rawAlpha') options.disabled_optimizers = 'cte_inlining'
      instance = await createDuckdbInstance({create: DuckDBInstance.create.bind(DuckDBInstance), databasePath: process.env.DUCKDB_PATH, options})
      connection = await instance.connect()
      read = async statement => (await connection.runAndReadAll(statement)).getRowObjectsJson()
      close = async () => { connection.closeSync(); instance.closeSync() }
    }
    const result = {}
    try {
      for (const [name, sql] of Object.entries(queries)) result[name] = await read(sql)
    } finally { await close() }
    console.log(JSON.stringify(result))
  `
  const result = globalThis.Bun.spawnSync([process.execPath, '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3999',
      DUCKDB_MEMORY_LIMIT: '128MiB',
      DUCKDB_PATH: databasePath,
      SERVER_DUCKDB_OWNER_URL: '',
      SERVER_ROLE: 'maintenance-worker',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60000,
  })
  expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)

  return JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as typeof expectedResults
}

test('patched alpha preserves retained string IDs without disabling statistics propagation after mixed-version WAL replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-alpha-string-stats-control-'))
  const databasePath = join(root, 'test.duckdb')

  try {
    const bytes = writeFixture(databasePath)
    const result = runReader(databasePath, 'rawAlpha')
    expect(result).toEqual(expectedResults)
    expect(readFileSync(databasePath)).toEqual(bytes.database)
    expect(readFileSync(`${databasePath}.wal`)).toEqual(bytes.wal)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test.each(['native', 'managed', 'ephemeral', 'ownerless'] as const)(
  '%s readers preserve exact IDs, ranges, joins and committed deletes after mixed-version WAL replay',
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'forska-alpha-string-stats-'))
    const databasePath = join(root, 'test.duckdb')

    try {
      const bytes = writeFixture(databasePath)
      expect(runReader(databasePath, mode)).toEqual(expectedResults)
      expect(runReader(databasePath, 'native')).toEqual(expectedResults)

      if (mode !== 'managed') {
        expect(readFileSync(databasePath)).toEqual(bytes.database)
        expect(readFileSync(`${databasePath}.wal`)).toEqual(bytes.wal)
      }
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  },
)

import {createHash} from 'node:crypto'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'

import {expect, test} from 'bun:test'

import duckdbDistributionManifest from '../../../vendor/duckdb/manifest.json'
import legacyWalFixture from './duckdbEngineCompatibility/fixtures/duckdb151PendingWal.json'
import {assertDuckdbEngineVersion} from './duckdbEngineContract.ts'

const runIsolated = <T = unknown>(script: string, databasePath: string, env: Record<string, string> = {}) => {
  const result = globalThis.Bun.spawnSync([process.execPath, '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3999',
      DUCKDB_MEMORY_LIMIT: '128MiB',
      DUCKDB_PATH: databasePath,
      SERVER_DUCKDB_OWNER_URL: '',
      SERVER_ROLE: 'maintenance-worker',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60000,
  })

  expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)

  return JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as T
}

test('DuckDB rejects old or unpinned engines with install guidance', () => {
  expect(() => {
    return assertDuckdbEngineVersion(duckdbDistributionManifest.engine.version)
  }).not.toThrow()
  expect(() => {
    return assertDuckdbEngineVersion('v1.5.1')
  }).toThrow('bun install --frozen-lockfile')
  expect(() => {
    return assertDuckdbEngineVersion('v2.0.0-alpha40882')
  }).toThrow('The database was not opened')
})

test('managed writable, direct read-only, ephemeral and ownerless readers decode scalar and nested NULL', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-alpha-null-'))

  try {
    const result = runIsolated(
      `
      const {DuckDBInstance} = await import('@duckdb/node-api')
      const service = await import('./src/server/utils/duckdbService.ts')
      const {runEphemeralReadOnlyDuckdbFileJsonQuery} = await import('./src/server/utils/duckdbEphemeralReadOnly.ts')
      const {runReadOnlyDuckdbJsonQuery, closeReadOnlyDuckdbService} = await import('./src/server/services/readOnlyDuckdbService.ts')
      const query = 'SELECT NULL AS scalar, [NULL] AS nested, {value: NULL} AS structured'
      const writable = await service.runDuckdbJsonQuery(query)
      await service.runDuckdbStatement('CREATE TABLE retained(id INTEGER)')
      await service.closeDuckdbService()
      const instance = await DuckDBInstance.create(process.env.DUCKDB_PATH, service.getReadOnlyDuckdbRuntimeOptions())
      const connection = await instance.connect()
      const directReadOnly = (await connection.runAndReadAll(query)).getRowObjectsJson()
      connection.closeSync()
      instance.closeSync()
      const ephemeral = await runEphemeralReadOnlyDuckdbFileJsonQuery({
        databasePath: process.env.DUCKDB_PATH,
        memoryLimit: '128MiB',
        statement: query,
        workloadContext: service.getMaintenanceDuckdbWorkloadContext('alphaNullCompatibility'),
      })
      const {withCurrentServerRoleOverride} = await import('./src/server/utils/serverRuntimeRole.ts')
      const ownerless = await withCurrentServerRoleOverride('api', () => runReadOnlyDuckdbJsonQuery('api-read-only', query))
      await closeReadOnlyDuckdbService()
      console.log(JSON.stringify({writable, directReadOnly, ephemeral, ownerless}))
    `,
      join(root, 'test.duckdb'),
    )
    const expected = [{scalar: null, nested: [null], structured: {value: null}}]

    expect(result).toEqual({writable: expected, directReadOnly: expected, ephemeral: expected, ownerless: expected})
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test.each(['Llm', 'Human'])('pinned engine avoids invalid CTE vector references in %s status projection', (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'forska-alpha-cte-'))
  const runProjection = (configured: boolean) => {
    return runIsolated<{error: string | null; rows?: Array<Record<string, unknown>>}>(
      `
      const {readFileSync} = await import('node:fs')
      const {DuckDBInstance} = await import('@duckdb/node-api')
      const {getDuckdbEngineOptions} = await import('./src/server/utils/duckdbEngineCompatibility.ts')
      const fixtureRoot = './src/server/utils/duckdbEngineCompatibility/fixtures/'
      const options = getDuckdbEngineOptions()
      ${configured ? '' : "options.disabled_optimizers = ''"}
      const instance = await DuckDBInstance.create(':memory:', options)
      const connection = await instance.connect()
      try {
        await connection.run(readFileSync(fixtureRoot + 'cteInliningSetup.sql', 'utf8'))
        await connection.run(readFileSync(fixtureRoot + 'cteInlining${kind}Status.sql', 'utf8'))
        const rows = (await connection.runAndReadAll(\`
          SELECT llm_status, human_status, llm_has_judgment,
            CAST(llm_patch_watermark AS INTEGER) AS llm_patch_watermark,
            CAST(human_patch_watermark AS INTEGER) AS human_patch_watermark,
            CAST(both_patch_watermark AS INTEGER) AS both_patch_watermark
          FROM mart.review_article_serving_list_mode_state_v4
        \`)).getRowObjectsJson()
        console.log(JSON.stringify({error: null, rows}))
      } catch (error) {
        console.log(JSON.stringify({error: error.message}))
      } finally {
        connection.closeSync()
        instance.closeSync()
      }
      `,
      join(root, 'unused.duckdb'),
    )
  }

  try {
    expect(runProjection(false).error).toContain('Vector::Reference used on vector of different type')
    expect(runProjection(true)).toEqual({
      error: null,
      rows: [
        {
          llm_status: 'unanswered',
          human_status: kind === 'Human' ? 'unanswered' : null,
          llm_has_judgment: false,
          llm_patch_watermark: 0,
          human_patch_watermark: 0,
          both_patch_watermark: 0,
        },
      ],
    })
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test.each(['preflight', 'checkpoint', 'open'])(
  'legacy WAL incompatibility never retries or quarantines data (%s)',
  (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'forska-alpha-legacy-wal-'))
    const databasePath = join(root, 'test.duckdb')
    const walPath = `${databasePath}.wal`
    writeFileSync(databasePath, 'unchanged-database-evidence')
    writeFileSync(walPath, 'unchanged-legacy-wal-evidence')

    try {
      const result = runIsolated<{failure: string; opens: number; probes: number; recoveryFiles: string[]}>(
        `
      const {mock} = await import('bun:test')
      const {existsSync, readdirSync} = await import('node:fs')
      const errorMessage = 'Data Corruption Error: Failure while replaying WAL file "' + process.env.DUCKDB_PATH + '.wal": WAL cannot contain more than one checkpoint marker'
      let opens = 0
      let probes = 0
      const expectedVersion = ${JSON.stringify(duckdbDistributionManifest.engine.version)}
      mock.module('@duckdb/node-api', () => ({
        DuckDBConnection: class {},
        DuckDBInstance: class {
          static async create() { opens++; throw new Error(errorMessage) }
        },
        version: () => expectedVersion,
      }))
      mock.module(new URL('./src/server/utils/serverRuntimeRole.ts', import.meta.url).href, () => ({
        canCurrentServerOwnDuckdb: () => true,
        ensureCurrentDuckdbOwnerLease: async () => {},
        registerDuckdbOwnerDemotionHandler: () => {},
        releaseCurrentDuckdbOwnerLease: async () => {},
      }))
      const originalSpawnSync = Bun.spawnSync
      Bun.spawnSync = (command, options) => {
        const isDuckdbChild = command[1] === '-e' || (command[1] === 'run' && command[2] === '-')
        if (!isDuckdbChild) return originalSpawnSync(command, options)
        probes++
        return {exitCode: ${phase === 'open' ? '0' : '1'}, signalCode: null, stdout: Buffer.from(''), stderr: Buffer.from(errorMessage)}
      }
      const service = await import('./src/server/utils/duckdbService.ts')
      let failure = null
      try { await service.runDuckdbJsonQuery('SELECT 1 AS value') }
      catch (error) { failure = error.message }
      const recoveryDirectory = process.env.DUCKDB_PATH + '.startup-recovery'
      console.log(JSON.stringify({
        failure, opens, probes,
        recoveryFiles: existsSync(recoveryDirectory) ? readdirSync(recoveryDirectory) : [],
      }))
    `,
        databasePath,
        {FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT: phase === 'preflight' ? 'true' : 'false'},
      )

      expect(result.failure).toContain('automatic WAL quarantine is disabled')
      expect(result.failure).toContain('checkpoint with the previous compatible engine')
      expect(result.failure).toContain('Do not delete the WAL')
      expect(result.opens).toBe(phase === 'open' ? 1 : 0)
      expect(result.probes).toBe(1)
      expect(result.recoveryFiles).toEqual([])
      expect(readFileSync(databasePath, 'utf8')).toBe('unchanged-database-evidence')
      expect(readFileSync(walPath, 'utf8')).toBe('unchanged-legacy-wal-evidence')
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  },
)

test('ordinary pending DuckDB 1.5.1 WAL replays committed changes before the alpha checkpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-alpha-ordinary-wal-'))
  const databasePath = join(root, 'test.duckdb')
  const database = gunzipSync(Buffer.from(legacyWalFixture.files.database.gzipBase64, 'base64'))
  const wal = gunzipSync(Buffer.from(legacyWalFixture.files.wal.gzipBase64, 'base64'))

  try {
    expect(createHash('sha256').update(database).digest('hex')).toBe(legacyWalFixture.files.database.sha256)
    expect(createHash('sha256').update(wal).digest('hex')).toBe(legacyWalFixture.files.wal.sha256)
    writeFileSync(databasePath, database)
    writeFileSync(`${databasePath}.wal`, wal)
    const result = runIsolated(
      `
      const service = await import('./src/server/utils/duckdbService.ts')
      const rows = await service.runDuckdbJsonQuery('SELECT id, value FROM preserved_judgments')
      await service.closeDuckdbService()
      console.log(JSON.stringify(rows))
    `,
      databasePath,
    )

    expect(result).toEqual([{id: 1, value: 'accepted'}])
    const reopened = runIsolated(
      `
      const service = await import('./src/server/utils/duckdbService.ts')
      const rows = await service.runDuckdbJsonQuery('SELECT id, value FROM preserved_judgments')
      await service.closeDuckdbService()
      console.log(JSON.stringify(rows))
    `,
      databasePath,
    )

    expect(reopened).toEqual(result)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

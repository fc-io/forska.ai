import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import duckdbDistributionManifest from '../../../vendor/duckdb/manifest.json'

const runIsolated = <T>(databasePath: string, script: string) => {
  const result = globalThis.Bun.spawnSync([process.execPath, '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3999',
      DUCKDB_MEMORY_LIMIT: '128MiB',
      DUCKDB_PATH: databasePath,
      SERVER_DUCKDB_OWNER_URL: '',
      SERVER_ROLE: 'maintenance-worker',
      FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT: 'true',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60000,
  })
  expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)
  return JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as T
}

test.each([
  'INTERNAL Error: Vector::Reference used on vector of different type (source BIGINT referenced VARCHAR)',
  'Extension Autoloading Error: Failure while replaying WAL file: extension download unavailable',
  'Out of Memory Error: failed to allocate block while replaying WAL file',
  'native WAL replay crash signal=SIGTRAP',
])('fatal query recovery preserves committed WAL when reopen fails: %s', (preflightFailure) => {
  const root = mkdtempSync(join(tmpdir(), 'forska-wal-recovery-safety-'))
  const databasePath = join(root, 'test.duckdb')

  try {
    runIsolated(
      databasePath,
      `
      const {DuckDBInstance} = await import('@duckdb/node-api')
      const {getDuckdbEngineOptions} = await import('./src/server/utils/duckdbEngineCompatibility.ts')
      const instance = await DuckDBInstance.create(process.env.DUCKDB_PATH, {memory_limit: '128MiB', ...getDuckdbEngineOptions()})
      const connection = await instance.connect()
      await connection.run('PRAGMA disable_checkpoint_on_shutdown')
      await connection.run('CREATE TABLE retained(id INTEGER, value VARCHAR)')
      await connection.run("INSERT INTO retained VALUES (1, 'committed before fatal query')")
      connection.closeSync()
      instance.closeSync()
      console.log(JSON.stringify({seeded: true}))
    `,
    )
    const originalDatabase = readFileSync(databasePath)
    const originalWal = readFileSync(`${databasePath}.wal`)
    expect(originalWal.byteLength).toBeGreaterThan(0)

    const result = runIsolated<{failure: string; opens: number; probes: number; recoveryFiles: string[]}>(
      databasePath,
      `
      const {mock} = await import('bun:test')
      const {existsSync, readdirSync} = await import('node:fs')
      const {Buffer} = await import('node:buffer')
      let opens = 0
      let probes = 0
      mock.module('@duckdb/node-api', () => ({
        DuckDBConnection: class {},
        DuckDBInstance: class MockInstance {
          static async create() { opens++; return new MockInstance() }
          async connect() {
            return {
              async run() {},
              async runAndReadAll(statement) {
                if (statement === 'PRAGMA version') {
                  return {getRowObjectsJson: () => ${JSON.stringify([{library_version: duckdbDistributionManifest.engine.version, source_id: duckdbDistributionManifest.engine.sourceId}])}}
                }

                if (statement.startsWith('SELECT database_name FROM duckdb_databases()')) {
                  return {getRowObjectsJson: () => [{database_name: 'test'}]}
                }
                throw new Error('FATAL Error: database has been invalidated because of a previous fatal error. INTERNAL Error: Vector::Reference BIGINT referenced VARCHAR')
              },
              closeSync() {},
              interrupt() {},
            }
          }
          closeSync() {}
        },
        version: () => ${JSON.stringify(duckdbDistributionManifest.engine.version)},
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
        if (opens === 0) return {exitCode: 0, signalCode: null, stdout: Buffer.from(''), stderr: Buffer.from('')}
        probes++
        return {exitCode: 1, signalCode: null, stdout: Buffer.from(''), stderr: Buffer.from(${JSON.stringify(preflightFailure)})}
      }
      process.env.FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT = 'false'
      const service = await import('./src/server/utils/duckdbService.ts')
      await service.runDuckdbStatement('SELECT 1')
      process.env.FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT = 'true'
      let failure = null
      try { await service.runDuckdbJsonQuery('SELECT id, value FROM retained') }
      catch (error) { failure = error.message }
      const recoveryDirectory = process.env.DUCKDB_PATH + '.startup-recovery'
      console.log(JSON.stringify({failure, opens, probes, recoveryFiles: existsSync(recoveryDirectory) ? readdirSync(recoveryDirectory) : []}))
    `,
    )

    expect(result.failure).toContain('does not establish WAL corruption')
    expect(result.failure).toContain(preflightFailure)
    expect(result.opens).toBe(1)
    expect(result.probes).toBeGreaterThan(0)
    expect(result.recoveryFiles).toEqual([])
    expect(readFileSync(databasePath)).toEqual(originalDatabase)
    expect(readFileSync(`${databasePath}.wal`)).toEqual(originalWal)

    const retained = runIsolated(
      databasePath,
      `
      const {DuckDBInstance} = await import('@duckdb/node-api')
      const {getDuckdbEngineOptions} = await import('./src/server/utils/duckdbEngineCompatibility.ts')
      const instance = await DuckDBInstance.create(process.env.DUCKDB_PATH, {memory_limit: '128MiB', ...getDuckdbEngineOptions()})
      const connection = await instance.connect()
      const rows = (await connection.runAndReadAll('SELECT id, value FROM retained')).getRowObjectsJson()
      connection.closeSync()
      instance.closeSync()
      console.log(JSON.stringify(rows))
    `,
    )
    expect(retained).toEqual([{id: 1, value: 'committed before fatal query'}])
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

import {copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {createDuckdbInstance} from './createDuckdbInstance.ts'
import {duckdbEngineCompatibilityOptions} from './duckdbEngineContract.ts'
import {getDuckdbStartupChildProcessInput} from './duckdbStartupChildProcess.ts'

const runChild = (databasePath: string, script: string) => {
  return globalThis.Bun.spawnSync([process.execPath, '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DUCKDB_MEMORY_LIMIT: '512MiB',
      DUCKDB_PATH: databasePath,
      FORSKA_DUCKDB_STARTUP_WAL_PREFLIGHT: 'true',
      SERVER_DUCKDB_OWNER_URL: '',
      SERVER_ROLE: 'maintenance-worker',
    },
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 120_000,
  })
}

const getChildOutput = (result: ReturnType<typeof runChild>) => {
  expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)

  return JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as unknown
}

test('full application WAL from a killed writer replays offline through read-only, generated child and owner startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-application-wal-'))
  const databasePath = join(root, 'source.duckdb')
  const readyPath = join(root, 'committed.json')

  try {
    const seed = runChild(
      databasePath,
      `
      const {writeFileSync} = await import('node:fs')
      const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
      const service = await import('./src/server/utils/duckdbService.ts')
      await service.runDuckdbStatement('PRAGMA disable_checkpoint_on_shutdown')
      await migrateDuckdb()
      await service.runDuckdbStatement("INSERT INTO app.provider_connection (id, provider_kind, label) VALUES ('wal-provider', 'openai', 'WAL provider')")
      await service.runDuckdbStatement("INSERT INTO app.model (id, name, provider_connection_id) VALUES ('wal-model', 'WAL model', 'wal-provider')")
      await service.runDuckdbStatement("INSERT INTO app.project (id, name, model_id) VALUES ('wal-project', 'Committed project', 'wal-model')")
      await service.runDuckdbStatement(\`CREATE VIEW app.wal_replay_probe AS
        SELECT id, upper(name) AS name, json_extract_string('{"value":"retained"}', '$.value') AS json_value
        FROM app.project WHERE id = 'wal-project'\`)
      const rows = await service.runDuckdbJsonQuery('SELECT * FROM app.wal_replay_probe')
      const migrations = await service.runDuckdbJsonQuery('SELECT name FROM app_schema_migration ORDER BY name')
      writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({rows, migrations}))
      process.kill(process.pid, 'SIGKILL')
    `,
    )
    expect(seed.exitCode).not.toBe(0)
    expect(existsSync(readyPath), seed.stderr.toString() || seed.stdout.toString()).toBe(true)
    const committed = JSON.parse(readFileSync(readyPath, 'utf8')) as {rows: unknown[]; migrations: unknown[]}
    expect(committed.rows).toEqual([{id: 'wal-project', name: 'COMMITTED PROJECT', json_value: 'retained'}])
    expect(committed.migrations.length).toBeGreaterThan(100)
    expect(statSync(`${databasePath}.wal`).size).toBeGreaterThan(0)
    const originalDatabase = readFileSync(databasePath)
    const originalWal = readFileSync(`${databasePath}.wal`)
    const options = {
      ...duckdbEngineCompatibilityOptions,
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      memory_limit: '512MiB',
    }

    const directPath = join(root, 'direct.duckdb')
    copyFileSync(databasePath, directPath)
    copyFileSync(`${databasePath}.wal`, `${directPath}.wal`)
    const direct = runChild(
      directPath,
      `
      const {DuckDBInstance} = await import('@duckdb/node-api')
      try {
        const instance = await DuckDBInstance.create(process.env.DUCKDB_PATH, ${JSON.stringify(options)})
        instance.closeSync()
        console.log(JSON.stringify({error: null}))
      } catch (error) { console.log(JSON.stringify({error: error.message})) }
    `,
    )
    const directOutput = getChildOutput(direct) as {error: string | null}
    expect(directOutput.error).toContain('core_functions')
    expect(readFileSync(directPath)).toEqual(originalDatabase)
    expect(readFileSync(`${directPath}.wal`)).toEqual(originalWal)

    const readOnly = runChild(
      databasePath,
      `
      const {DuckDBInstance} = await import('@duckdb/node-api')
      const {createDuckdbInstance} = await import('./src/server/utils/createDuckdbInstance.ts')
      const instance = await createDuckdbInstance({create: DuckDBInstance.create.bind(DuckDBInstance), databasePath: process.env.DUCKDB_PATH,
        options: {...${JSON.stringify(options)}, access_mode: 'READ_ONLY'}})
      const connection = await instance.connect()
      const rows = (await connection.runAndReadAll('SELECT * FROM app.wal_replay_probe')).getRowObjectsJson()
      const migrations = (await connection.runAndReadAll('SELECT name FROM app_schema_migration ORDER BY name')).getRowObjectsJson()
      connection.closeSync()
      instance.closeSync()
      console.log(JSON.stringify({rows, migrations}))
    `,
    )
    expect(getChildOutput(readOnly)).toEqual(committed)
    expect(readFileSync(databasePath)).toEqual(originalDatabase)
    expect(readFileSync(`${databasePath}.wal`)).toEqual(originalWal)

    const generatedPath = join(root, "memory's startup.duckdb")
    copyFileSync(databasePath, generatedPath)
    copyFileSync(`${databasePath}.wal`, `${generatedPath}.wal`)
    const generated = getDuckdbStartupChildProcessInput({
      executablePath: process.execPath,
      platform: 'win32',
      script: `
        const {DuckDBInstance} = await import('@duckdb/node-api')
        const createDuckdbInstance = ${createDuckdbInstance.toString()}
        const instance = await createDuckdbInstance({create: DuckDBInstance.create.bind(DuckDBInstance),
          databasePath: JSON.parse(process.argv[1]), options: JSON.parse(process.argv[2])})
        const connection = await instance.connect()
        const rows = (await connection.runAndReadAll('SELECT * FROM app.wal_replay_probe')).getRowObjectsJson()
        const migrations = (await connection.runAndReadAll('SELECT name FROM app_schema_migration ORDER BY name')).getRowObjectsJson()
        await connection.run('CHECKPOINT')
        connection.closeSync()
        instance.closeSync()
        console.log(JSON.stringify({rows, migrations}))
      `,
      serializedArguments: [JSON.stringify(generatedPath), JSON.stringify(options)],
    })
    const generatedResult = globalThis.Bun.spawnSync(generated.command, {
      cwd: process.cwd(),
      stdin: generated.stdin,
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 60_000,
    })
    expect(getChildOutput(generatedResult)).toEqual(committed)

    const managedPath = join(root, 'managed.duckdb')
    copyFileSync(databasePath, managedPath)
    copyFileSync(`${databasePath}.wal`, `${managedPath}.wal`)
    const managed = runChild(
      managedPath,
      `
      const service = await import('./src/server/utils/duckdbService.ts')
      const rows = await service.runDuckdbJsonQuery('SELECT * FROM app.wal_replay_probe')
      const migrations = await service.runDuckdbJsonQuery('SELECT name FROM app_schema_migration ORDER BY name')
      await service.closeDuckdbService()
      console.log(JSON.stringify({rows, migrations}))
    `,
    )
    expect(getChildOutput(managed)).toEqual(committed)
    expect(readFileSync(databasePath)).toEqual(originalDatabase)
    expect(readFileSync(`${databasePath}.wal`)).toEqual(originalWal)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}, 180_000)

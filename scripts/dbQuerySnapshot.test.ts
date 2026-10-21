import {existsSync, mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, setDefaultTimeout, test} from 'bun:test'

import {getDuckdbMigrationFileNames} from '../src/db/duckdbSchemaMigrationStatus.ts'

setDefaultTimeout(60_000)

const projectRoot = process.cwd()
const bunExecutablePath = realpathSync(process.execPath)
const repoMigrationNames = getDuckdbMigrationFileNames()

const createDuckdbWithAppliedMigrations = async (duckdbPath: string, appliedMigrationNames: string[] | null) => {
  const duckdbInstance = await DuckDBInstance.create(duckdbPath, {memory_limit: '1GB'})
  const connection = await duckdbInstance.connect()

  try {
    await connection.run('CREATE TABLE probe (value INTEGER)')
    await connection.run('INSERT INTO probe VALUES (1)')

    if (appliedMigrationNames !== null) {
      await connection.run(
        'CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
      )
      await connection.run(
        `INSERT INTO app_schema_migration (name) SELECT unnest(${JSON.stringify(appliedMigrationNames).replaceAll('"', "'")})`,
      )
    }
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
}

const runSnapshotQuery = (duckdbPath: string, extraArgs: string[] = []) => {
  const result = globalThis.Bun.spawnSync(
    [bunExecutablePath, 'scripts/dbQuerySnapshot.ts', '--sql=SELECT value FROM probe', ...extraArgs],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        API_SERVER_PORT: '36108',
        DUCKDB_PATH: duckdbPath,
        FORSKA_RUNTIME_PROFILE: 'local',
        SERVER_DUCKDB_OWNER_URL: '',
      },
    },
  )

  return {exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString()}
}

const getQueryOutput = (stdout: string) => {
  return stdout.trim().split('\n').at(-1)
}

const getLeftoverSnapshots = (duckdbPath: string) => {
  const snapshotDirectory = join(tmpdir(), 'forska-duckdb-studio')

  return existsSync(snapshotDirectory)
    ? readdirSync(snapshotDirectory).filter((fileName) => {
        return fileName.startsWith(`${basename(duckdbPath)}.`)
      })
    : []
}

const withTempDuckdb = async (
  name: string,
  appliedMigrationNames: string[] | null,
  run: (duckdbPath: string) => void,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'f1-db-query-snapshot-schema-'))
  const duckdbPath = join(directory, `${name}-${Date.now()}.duckdb`)

  try {
    await createDuckdbWithAppliedMigrations(duckdbPath, appliedMigrationNames)
    run(duckdbPath)
  } finally {
    rmSync(directory, {force: true, recursive: true})
  }
}

test('db:query:snapshot answers when the DB has every repo migration applied', async () => {
  await withTempDuckdb('current', repoMigrationNames, (duckdbPath) => {
    const result = runSnapshotQuery(duckdbPath)

    expect(result.exitCode).toBe(0)
    expect(getQueryOutput(result.stdout)).toBe('[{"value":1}]')
    expect(result.stderr.split('\n')[0]).toBe(`[dbQuerySnapshot] duckdb path: ${duckdbPath} profile: local`)
    expect(result.stderr).not.toContain('[db:query:snapshot]')
  })
})

test('db:query:snapshot refuses a DB that is behind the repo migrations and lists the missing ids', async () => {
  const missingMigrationNames = repoMigrationNames.slice(-2)

  await withTempDuckdb('behind', repoMigrationNames.slice(0, -2), (duckdbPath) => {
    const result = runSnapshotQuery(duckdbPath)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).not.toContain('"value"')
    expect(result.stderr).toContain(
      `[db:query:snapshot] refusing to query ${duckdbPath}: its schema is behind this checkout by 2 migration(s) it has not applied:\n  ${missingMigrationNames[0]}\n  ${missingMigrationNames[1]}\n`,
    )
    expect(result.stderr).toContain('--allow-schema-behind')
    expect(getLeftoverSnapshots(duckdbPath)).toEqual([])
  })
})

test('db:query:snapshot --allow-schema-behind queries a DB that is behind with a warning', async () => {
  await withTempDuckdb('behind-allowed', repoMigrationNames.slice(0, -1), (duckdbPath) => {
    const result = runSnapshotQuery(duckdbPath, ['--allow-schema-behind'])

    expect(result.exitCode).toBe(0)
    expect(getQueryOutput(result.stdout)).toBe('[{"value":1}]')
    expect(result.stderr).toContain(
      `[db:query:snapshot] warning: querying ${duckdbPath} with --allow-schema-behind; it lacks 1 migration(s):\n  ${repoMigrationNames.at(-1)}`,
    )
  })
})

test('db:query:snapshot only warns when the DB has migrations this checkout does not know', async () => {
  await withTempDuckdb('ahead', [...repoMigrationNames, '9999_newerCheckout.sql'], (duckdbPath) => {
    const result = runSnapshotQuery(duckdbPath)

    expect(result.exitCode).toBe(0)
    expect(getQueryOutput(result.stdout)).toBe('[{"value":1}]')
    expect(result.stderr).toContain(
      `[db:query:snapshot] warning: ${duckdbPath} has 1 applied migration(s) this checkout does not have (newer code elsewhere?):\n  9999_newerCheckout.sql`,
    )
  })
})

test('db:query:snapshot treats a DB without the migration table as behind on every migration', async () => {
  await withTempDuckdb('untracked', null, (duckdbPath) => {
    const result = runSnapshotQuery(duckdbPath)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`behind this checkout by ${repoMigrationNames.length} migration(s)`)
    expect(result.stderr).toContain(`  ... and ${repoMigrationNames.length - 20} more`)
  })
})

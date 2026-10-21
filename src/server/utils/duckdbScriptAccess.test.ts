import {existsSync, mkdtempSync, realpathSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {createRemoteSnapshotFromUrls} from './duckdbScriptAccess.ts'
import {getDuckdbPath} from './getDuckdbPath.ts'

const bunExecutablePath = realpathSync(process.execPath)
const maintenanceAccessScript = `
  const {withDuckdbMaintenanceAccess} = await import('./src/server/utils/duckdbScriptAccess.ts')
  const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
  await withDuckdbMaintenanceAccess('runtime profile guard test', async () => {
    await getAppDatabaseService().queryJson('SELECT 1 AS value')
    console.log('maintenance work ran')
  })
`

const getIsolatedOperatorScriptEnv = (dataRoot: string, overrides: Record<string, string>) => {
  const {
    DUCKDB_PATH: _duckdbPath,
    DUCKDB_PATH_FILE: _duckdbPathFile,
    FORSKA_RUNTIME_PROFILE: _runtimeProfile,
    ...inheritedEnv
  } = process.env

  return {
    ...inheritedEnv,
    API_SERVER_PORT: '36107',
    HOME: dataRoot,
    LOCALAPPDATA: join(dataRoot, 'AppData', 'Local'),
    SERVER_DUCKDB_OWNER_URL: '',
    USERPROFILE: dataRoot,
    XDG_DATA_HOME: join(dataRoot, '.local', 'share'),
    ...overrides,
  }
}

const runMaintenanceAccessScript = (envValues: Record<string, string | undefined>) => {
  const result = globalThis.Bun.spawnSync([bunExecutablePath, '-e', maintenanceAccessScript], {
    cwd: process.cwd(),
    env: envValues,
  })

  return {exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString()}
}

test('operator DuckDB access refuses to run without an explicit runtime profile or DuckDB path', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'f1-operator-profile-guard-'))
  const envValues = getIsolatedOperatorScriptEnv(dataRoot, {})
  const localDefaultPath = getDuckdbPath({envValues, homeDir: dataRoot})

  try {
    const result = runMaintenanceAccessScript(envValues)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      '[duckdb-script] refusing to open DuckDB: FORSKA_RUNTIME_PROFILE is not set, so DUCKDB_PATH resolves to the local default',
    )
    expect(result.stderr).toContain(`  ${localDefaultPath}\n`)
    expect(result.stdout).not.toContain('maintenance work ran')
    expect(existsSync(localDefaultPath)).toBe(false)
  } finally {
    rmSync(dataRoot, {force: true, recursive: true})
  }
})

test('operator DuckDB access with an explicit local profile prints the DuckDB path banner first', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'f1-operator-profile-local-'))
  const envValues = getIsolatedOperatorScriptEnv(dataRoot, {FORSKA_RUNTIME_PROFILE: 'local'})
  const localDefaultPath = getDuckdbPath({envValues, homeDir: dataRoot})

  try {
    const result = runMaintenanceAccessScript(envValues)

    expect(result.exitCode).toBe(0)
    expect(result.stderr.split('\n')[0]).toBe(`[duckdb-script] duckdb path: ${localDefaultPath} profile: local`)
    expect(result.stdout).toContain('maintenance work ran')
  } finally {
    rmSync(dataRoot, {force: true, recursive: true})
  }
})

test('operator DuckDB access with FORSKA_RUNTIME_PROFILE=primary alone opens the primary profile file', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'f1-operator-profile-primary-'))
  const envValues = getIsolatedOperatorScriptEnv(dataRoot, {FORSKA_RUNTIME_PROFILE: 'primary'})
  const primaryPath = getDuckdbPath({envValues, homeDir: dataRoot})

  try {
    const result = runMaintenanceAccessScript(envValues)

    expect(primaryPath).toContain(join('runtime', 'primary', 'forska.duckdb'))
    expect(result.exitCode).toBe(0)
    expect(result.stderr.split('\n')[0]).toBe(`[duckdb-script] duckdb path: ${primaryPath} profile: primary`)
    expect(existsSync(primaryPath)).toBe(true)
  } finally {
    rmSync(dataRoot, {force: true, recursive: true})
  }
})

test('operator DuckDB access accepts an explicit DuckDB path without a profile', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'f1-operator-profile-path-'))
  const duckdbPath = join(dataRoot, 'copy.duckdb')
  const result = runMaintenanceAccessScript(getIsolatedOperatorScriptEnv(dataRoot, {DUCKDB_PATH: duckdbPath}))

  try {
    expect(result.exitCode).toBe(0)
    expect(result.stderr.split('\n')[0]).toBe(
      `[duckdb-script] duckdb path: ${duckdbPath} profile: unset (DUCKDB_PATH set explicitly)`,
    )
  } finally {
    rmSync(dataRoot, {force: true, recursive: true})
  }
})

test('the migration script path skips the operator profile guard', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'f1-operator-profile-migration-'))
  const result = globalThis.Bun.spawnSync(
    [
      bunExecutablePath,
      '-e',
      `
        const {withDuckdbMaintenanceAccess} = await import('./src/server/utils/duckdbScriptAccess.ts')
        await withDuckdbMaintenanceAccess('migration guard test', async () => {
          console.log('migration work ran')
        }, {requireExplicitDuckdbTarget: false})
      `,
    ],
    {cwd: process.cwd(), env: getIsolatedOperatorScriptEnv(dataRoot, {})},
  )

  try {
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).not.toContain('duckdb path:')
    expect(result.stdout.toString()).toContain('migration work ran')
  } finally {
    rmSync(dataRoot, {force: true, recursive: true})
  }
})

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const waitForFile = async (filePath: string, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now()

  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (existsSync(filePath)) {
        resolve()
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${filePath}`))
        return
      }

      setTimeout(check, 50)
    }

    check()
  })
}

test('snapshot creation never asks a server on API_SERVER_PORT that does not own the target DuckDB file', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'f1-operator-snapshot-owner-'))
  const duckdbPath = join(dataRoot, 'target.duckdb')
  const foreignSnapshotPath = join(dataRoot, 'foreign-owner-snapshot.duckdb')
  const requestedPaths: string[] = []
  const foreignOwner = globalThis.Bun.serve({
    fetch: (request) => {
      requestedPaths.push(new URL(request.url).pathname)
      return Response.json({data: {createdAt: new Date().toISOString(), snapshotPath: foreignSnapshotPath}})
    },
    port: 36109,
  })

  try {
    const snapshotProcess = globalThis.Bun.spawn(
      [
        bunExecutablePath,
        '-e',
        `
          const {createDuckdbSnapshotForCli} = await import('./src/server/utils/duckdbScriptAccess.ts')
          const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
          const snapshot = await createDuckdbSnapshotForCli()
          await getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
          console.log(JSON.stringify({snapshotPath: snapshot.snapshotPath}))
        `,
      ],
      {
        cwd: process.cwd(),
        env: getIsolatedOperatorScriptEnv(dataRoot, {API_SERVER_PORT: '36109', DUCKDB_PATH: duckdbPath}),
        stderr: 'pipe',
        stdout: 'pipe',
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      snapshotProcess.exited,
      new Response(snapshotProcess.stdout).text(),
      new Response(snapshotProcess.stderr).text(),
    ])
    const lastStdoutLine = stdout.trim().split('\n').at(-1) ?? ''

    expect(exitCode, stderr).toBe(0)
    expect((JSON.parse(lastStdoutLine) as {snapshotPath: string}).snapshotPath).not.toBe(foreignSnapshotPath)
    expect(requestedPaths).toEqual([])
  } finally {
    await foreignOwner.stop(true)
    rmSync(dataRoot, {force: true, recursive: true})
  }
})

test('maintenance scripts fail while a live writer holds DuckDB', async () => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-maintenance-guard-${Date.now()}.duckdb`)
  const leasePath = `${duckdbPath}.duckdb-owner.lock`
  const holder = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
        await runDuckdbJsonQuery('SELECT 1 AS value')
        setInterval(() => {}, 1000)
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, API_SERVER_PORT: '36101', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    await waitForFile(leasePath, 5_000)

    const contender = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {withDuckdbMaintenanceAccess} = await import('./src/server/utils/duckdbScriptAccess.ts')
          await withDuckdbMaintenanceAccess('maintenance test', async () => {
            return Promise.resolve()
          })
        `,
      ],
      {cwd: process.cwd(), env: {...process.env, API_SERVER_PORT: '36102', DUCKDB_PATH: duckdbPath}},
    )

    const stderr = contender.stderr.toString() || contender.stdout.toString()

    expect(contender.exitCode).not.toBe(0)
    expect(stderr).toContain('requires exclusive DuckDB maintenance access')
  } finally {
    holder.kill('SIGTERM')
    await holder.exited
    removeFileIfExists(duckdbPath)
    removeFileIfExists(leasePath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('snapshot query script reads from a safe DuckDB snapshot', () => {
  const duckdbPath = join(tmpdir(), `f1-duckdb-query-snapshot-${Date.now()}.duckdb`)
  const result = globalThis.Bun.spawnSync(
    ['bun', 'scripts/dbQuerySnapshot.ts', '--sql=SELECT 1 AS value', '--allow-schema-behind'],
    {cwd: process.cwd(), env: {...process.env, API_SERVER_PORT: '36103', DUCKDB_PATH: duckdbPath}},
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB snapshot query script failed')
    }

    expect(result.stdout.toString()).toContain('"value":1')
    expect(result.stderr.toString()).toContain('with --allow-schema-behind')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('snapshot creation falls back when the first owner URL has no snapshot route', async () => {
  const snapshotPath = join(tmpdir(), `f1-duckdb-query-snapshot-fallback-${Date.now()}.duckdb`)
  const staleOwner = globalThis.Bun.serve({
    fetch: () => {
      return new Response('NOT_FOUND', {status: 404})
    },
    port: 36104,
  })
  const snapshotOwner = globalThis.Bun.serve({
    fetch: () => {
      return Response.json({data: {createdAt: new Date().toISOString(), snapshotPath}})
    },
    port: 36105,
  })

  try {
    const snapshot = await createRemoteSnapshotFromUrls([
      'http://127.0.0.1:36104/__duckdb-owner-rpc/api/duckdbStudioSnapshots',
      'http://127.0.0.1:36105/__duckdb-owner-rpc/api/duckdbStudioSnapshots',
    ])

    expect(snapshot.snapshotPath).toBe(snapshotPath)
  } finally {
    await staleOwner.stop(true)
    await snapshotOwner.stop(true)
    removeFileIfExists(snapshotPath)
  }
})

test('snapshot creation preserves a non-JSON owner failure response', async () => {
  const failedOwner = globalThis.Bun.serve({
    fetch: () => {
      return new Response('An owner-side failure occurred', {status: 500})
    },
    port: 36106,
  })

  try {
    expect(
      createRemoteSnapshotFromUrls(['http://127.0.0.1:36106/__duckdb-owner-rpc/api/duckdbStudioSnapshots']),
    ).rejects.toThrow('DuckDB snapshot request failed with status 500: An owner-side failure occurred')
  } finally {
    await failedOwner.stop(true)
  }
})

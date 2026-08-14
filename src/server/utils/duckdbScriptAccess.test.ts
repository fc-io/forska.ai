import {existsSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {createRemoteSnapshotFromUrls} from './duckdbScriptAccess.ts'

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
  const result = globalThis.Bun.spawnSync(['bun', 'scripts/dbQuerySnapshot.ts', '--sql=SELECT 1 AS value'], {
    cwd: process.cwd(),
    env: {...process.env, API_SERVER_PORT: '36103', DUCKDB_PATH: duckdbPath},
  })

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'DuckDB snapshot query script failed')
    }

    expect(result.stdout.toString()).toContain('"value":1')
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

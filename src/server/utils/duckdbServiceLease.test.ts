import {existsSync, rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const waitForFile = async (filePath: string, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now()

  if (existsSync(filePath)) {
    return
  }

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

test('second process cannot acquire DuckDB writer lease', async () => {
  const duckdbPath = `/tmp/f1-duckdb-lease-${Date.now()}.duckdb`
  const leasePath = `${duckdbPath}.writer.lock`
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
      env: {...process.env, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'writer'},
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
          const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
          await runDuckdbJsonQuery('SELECT 1 AS value')
        `,
      ],
      {cwd: process.cwd(), env: {...process.env, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'writer'}},
    )

    const stderr = contender.stderr.toString() || contender.stdout.toString()

    expect(contender.exitCode).not.toBe(0)
    expect(stderr).toContain('DuckDB writer lease is held by')
  } finally {
    holder.kill('SIGTERM')
    await holder.exited
    removeFileIfExists(duckdbPath)
    removeFileIfExists(leasePath)
  }
})

import {existsSync, rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const removeDuckdbFiles = (duckdbPath: string) => {
  ;[duckdbPath, `${duckdbPath}.duckdb-owner.lock`, `${duckdbPath}.duckdb-owner.history.json`].map(removeFileIfExists)
}

const waitForTimeout = (timeoutMs: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs)
  })
}

const waitForProcessExit = async (childProcess: ReturnType<typeof globalThis.Bun.spawn>, timeoutMs: number) => {
  return Promise.race([
    childProcess.exited.then(() => {
      return true
    }),
    waitForTimeout(timeoutMs).then(() => {
      return false
    }),
  ])
}

test('duckdb shutdown hook bypasses a stuck queue on SIGTERM', async () => {
  const duckdbPath = `/tmp/f1-duckdb-shutdown-${Date.now()}.duckdb`
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
        await runDuckdbJsonQuery('SELECT 1 AS value')
        globalThis.__forskaDuckdbServiceState.duckdbQueue = new Promise(() => {})
        process.kill(process.pid, 'SIGTERM')
        setTimeout(() => {
          console.log('still alive')
        }, 3_000)
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '1GB', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    expect(await waitForProcessExit(childProcess, 5_000)).toBe(true)
    expect(childProcess.exitCode).toBe(0)
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }

    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb shutdown hook bypasses a stuck append queue on SIGTERM', async () => {
  const duckdbPath = `/tmp/f1-duckdb-append-shutdown-${Date.now()}.duckdb`
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
        await runDuckdbJsonQuery('SELECT 1 AS value')
        globalThis.__forskaDuckdbServiceState.appendQueues[0] = new Promise(() => {})
        process.kill(process.pid, 'SIGTERM')
        setTimeout(() => {
          console.log('still alive')
        }, 3_000)
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKDB_APPEND_LANE_COUNT: '2',
        DUCKDB_MEMORY_LIMIT: '1GB',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'maintenance-worker',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    expect(await waitForProcessExit(childProcess, 5_000)).toBe(true)
    expect(childProcess.exitCode).toBe(0)
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }

    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb shutdown hook skips checkpoint while control transaction is active', async () => {
  const duckdbPath = `/tmp/f1-duckdb-active-transaction-shutdown-${Date.now()}.duckdb`
  const childProcess = globalThis.Bun.spawn(
    [
      'bun',
      '-e',
      `
        const {runDuckdbTransaction} = await import('./src/server/utils/duckdbService.ts')

        await runDuckdbTransaction(async (tx) => {
          await tx.run('CREATE TABLE sample (id INTEGER)')
          process.kill(process.pid, 'SIGTERM')
          await new Promise(() => {})
        })
      `,
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, DUCKDB_MEMORY_LIMIT: '1GB', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    expect(await waitForProcessExit(childProcess, 5_000)).toBe(true)
    const stderr = await new Response(childProcess.stderr).text()

    expect(childProcess.exitCode).toBe(0)
    expect(stderr).not.toContain('failed to checkpoint before shutdown')
    expect(stderr).not.toContain('Cannot CHECKPOINT')
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL')
      await childProcess.exited
    }

    removeDuckdbFiles(duckdbPath)
  }
})

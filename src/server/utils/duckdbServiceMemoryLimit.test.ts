import {expect, test} from 'bun:test'
import {existsSync, rmSync} from 'node:fs'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const removeDuckdbFiles = (duckdbPath: string) => {
  ;[duckdbPath, `${duckdbPath}.writer.lock`, `${duckdbPath}.writer.history.json`].map(removeFileIfExists)
}

const getSpawnOutput = (result: ReturnType<typeof globalThis.Bun.spawnSync>) => {
  const stdout = Buffer.from(result.stdout ?? [])
    .toString()
    .trim()
  const stderr = Buffer.from(result.stderr ?? [])
    .toString()
    .trim()

  if (result.exitCode !== 0) {
    throw new Error(stderr || stdout || 'DuckDB subprocess failed')
  }

  return stdout
}

test('duckdb service defaults the runtime memory limit to 20GB', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-default-memory-limit-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {getDuckdbRuntimeConfig} = await import('./src/server/utils/duckdbService.ts')
            console.log(JSON.stringify(getDuckdbRuntimeConfig()))
          `,
        ],
        {
          cwd: process.cwd(),
          env: {...process.env, DUCKDB_PATH: duckdbPath, DUCKDB_MEMORY_LIMIT: '', SERVER_ROLE: 'writer'},
        },
      ),
    )

    const runtimeConfig = JSON.parse(stdout) as {memoryLimit: string}

    expect(runtimeConfig.memoryLimit).toBe('20GB')
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb service applies the configured memory limit on startup', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-memory-limit-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {closeDuckdbService, runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
            const [row] = await runDuckdbJsonQuery("SELECT current_setting('memory_limit') AS memoryLimit")
            console.log(JSON.stringify(row))
            await closeDuckdbService()
          `,
        ],
        {
          cwd: process.cwd(),
          env: {...process.env, DUCKDB_PATH: duckdbPath, DUCKDB_MEMORY_LIMIT: '256MiB', SERVER_ROLE: 'writer'},
        },
      ),
    )

    const row = JSON.parse(stdout) as {memoryLimit: string}

    expect(row.memoryLimit).toBe('256.0 MiB')
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

type SpawnedServer = ReturnType<typeof globalThis.Bun.spawn>

const projectRoot = process.cwd()

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const waitForServer = async (port: number, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now()

  await new Promise<void>((resolve, reject) => {
    const check = async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/__healthcheck__`)
        resolve()
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error)
          return
        }

        setTimeout(() => {
          void check()
        }, 50)
      }
    }

    void check()
  })
}

const stopServer = async (server: SpawnedServer) => {
  server.kill('SIGTERM')
  await server.exited
}

const startServer = (envValues: Record<string, string>) => {
  return globalThis.Bun.spawn(['bun', 'run', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {...process.env, ...envValues},
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

const getBasePort = () => {
  return 38000 + Number(String(Date.now()).slice(-3))
}

test('db backup script creates a DuckDB backup while the writer server is running', async () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'f1-db-backup-'))
  const duckdbPath = join(workingDirectory, 'live.duckdb')
  const writerPort = getBasePort()
  const backupPort = writerPort + 1
  const seedResult = globalThis.Bun.spawnSync([
    'duckdb',
    duckdbPath,
    'CREATE TABLE backup_check(value INTEGER); INSERT INTO backup_check VALUES (42);',
  ])
  const writerServer = startServer({
    API_SERVER_PORT: String(writerPort),
    DUCKDB_PATH: duckdbPath,
    RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
    RUN_SERVER_FULL_TEXT_FETCHING: 'false',
    SERVER_ROLE: 'writer',
    VITE_PORT: String(writerPort + 1000),
  })

  try {
    expect(seedResult.exitCode).toBe(0)

    await waitForServer(writerPort, 10_000)

    const result = globalThis.Bun.spawnSync(['bun', join(projectRoot, 'scripts/dbBackup.ts')], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        API_SERVER_PORT: String(backupPort),
        DUCKDB_PATH: duckdbPath,
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        VITE_PORT: String(backupPort + 1000),
      },
    })

    const backupDirectoryPath = join(workingDirectory, 'backups')
    const backupDirectoryEntries = existsSync(backupDirectoryPath) ? readdirSync(backupDirectoryPath) : []
    const backupName = backupDirectoryEntries.find((entry) => {
      return entry.endsWith('.duckdb')
    })
    const backupPath = backupName ? join(backupDirectoryPath, backupName) : null
    const queryResult =
      backupPath === null
        ? null
        : globalThis.Bun.spawnSync(['duckdb', '-readonly', '-json', backupPath, 'SELECT value FROM backup_check'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('[dbBackup] Backup created:')
    expect(backupPath).not.toBe(null)
    expect(queryResult?.exitCode ?? null).toBe(0)
    expect(queryResult?.stdout.toString() ?? '').toContain('"value":42')
  } finally {
    await stopServer(writerServer)
    rmSync(workingDirectory, {force: true, recursive: true})
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

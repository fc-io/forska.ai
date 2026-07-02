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
          env: {...process.env, DUCKDB_PATH: duckdbPath, DUCKDB_MEMORY_LIMIT: '', SERVER_ROLE: 'maintenance-worker'},
        },
      ),
    )

    const runtimeConfig = JSON.parse(stdout) as {memoryLimit: string}

    expect(runtimeConfig.memoryLimit).toBe('20GB')
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb service applies the configured startup tuning', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-memory-limit-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {closeDuckdbService, runDuckdbJsonQuery} = await import('./src/server/utils/duckdbService.ts')
            const [row] = await runDuckdbJsonQuery("SELECT current_setting('checkpoint_threshold') AS checkpointThreshold, current_setting('memory_limit') AS memoryLimit, current_setting('threads') AS threads, current_setting('preserve_insertion_order') AS preserveInsertionOrder")
            console.log(JSON.stringify(row))
            await closeDuckdbService()
          `,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DUCKDB_PATH: duckdbPath,
            DUCKDB_MEMORY_LIMIT: '256MiB',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const row = JSON.parse(stdout) as {
      checkpointThreshold: string
      memoryLimit: string
      preserveInsertionOrder: boolean
      threads: string
    }

    expect(row.checkpointThreshold).toBe('64.0 MiB')
    expect(row.memoryLimit).toBe('256.0 MiB')
    expect(row.threads).toBe('1')
    expect(row.preserveInsertionOrder).toBe(false)
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb service uses one thread and deferred checkpoints for the 6400MiB worker profile', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-6400mib-threads-${Date.now()}.duckdb`

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
          env: {
            ...process.env,
            DUCKDB_PATH: duckdbPath,
            DUCKDB_MEMORY_LIMIT: '6400MiB',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const runtimeConfig = JSON.parse(stdout) as {
      checkpointThreshold: string
      serializeConcurrentWork: boolean
      threads: string
    }

    expect(runtimeConfig.checkpointThreshold).toBe('8192MiB')
    expect(runtimeConfig.threads).toBe('1')
    expect(runtimeConfig.serializeConcurrentWork).toBe(true)
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb service serializes background work with the main queue on low-memory workers', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-serialized-background-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {mock} = await import('bun:test')

            const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

            let activeReads = 0
            const overlaps = []

            void mock.module(serverRuntimeRoleModulePath, () => {
              return {
                canCurrentServerOwnDuckdb: () => true,
                ensureCurrentDuckdbOwnerLease: async () => {},
                registerDuckdbOwnerDemotionHandler: () => {},
                releaseCurrentDuckdbOwnerLease: async () => {},
              }
            })

            void mock.module('@duckdb/node-api', () => {
              class MockConnection {
                async run() {}

                async runAndReadAll(statement) {
                  const label = statement.includes('background') ? 'background' : 'main'

                  activeReads += 1
                  overlaps.push({activeReads, label})
                  await new Promise((resolve) => setTimeout(resolve, label === 'main' ? 50 : 0))
                  activeReads -= 1

                  return {
                    getRowObjectsJson() {
                      return [{label}]
                    },
                  }
                }

                interrupt() {}
                closeSync() {}
              }

              class MockInstance {
                static async create() {
                  return new MockInstance()
                }

                async connect() {
                  return new MockConnection()
                }

                closeSync() {}
              }

              return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
            })

            const duckdbService = await import('./src/server/utils/duckdbService.ts?serialize-background=' + Date.now())
            const mainPromise = duckdbService.runDuckdbJsonQuery("SELECT 'main' AS label")

            await new Promise((resolve) => setTimeout(resolve, 10))

            const backgroundPromise = duckdbService.runDuckdbBackgroundJsonQuery("SELECT 'background' AS label")

            await Promise.all([mainPromise, backgroundPromise])
            console.log(JSON.stringify({overlaps}))
            await duckdbService.closeDuckdbService()
          `,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DUCKDB_PATH: duckdbPath,
            DUCKDB_MEMORY_LIMIT: '6400MiB',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const result = JSON.parse(stdout) as {overlaps: Array<{activeReads: number; label: string}>}

    expect(result.overlaps).toEqual([
      {activeReads: 1, label: 'main'},
      {activeReads: 1, label: 'background'},
    ])
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb service serializes append work with the main queue on low-memory workers', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-serialized-append-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {mock} = await import('bun:test')

            const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

            let activeReads = 0
            const overlaps = []

            void mock.module(serverRuntimeRoleModulePath, () => {
              return {
                canCurrentServerOwnDuckdb: () => true,
                ensureCurrentDuckdbOwnerLease: async () => {},
                registerDuckdbOwnerDemotionHandler: () => {},
                releaseCurrentDuckdbOwnerLease: async () => {},
              }
            })

            void mock.module('@duckdb/node-api', () => {
              class MockConnection {
                async run() {}

                async runAndReadAll(statement) {
                  const label = statement.includes('append') ? 'append' : 'main'

                  activeReads += 1
                  overlaps.push({activeReads, label})
                  await new Promise((resolve) => setTimeout(resolve, label === 'main' ? 50 : 0))
                  activeReads -= 1

                  return {
                    getRowObjectsJson() {
                      return [{label}]
                    },
                  }
                }

                interrupt() {}
                closeSync() {}
              }

              class MockInstance {
                static async create() {
                  return new MockInstance()
                }

                async connect() {
                  return new MockConnection()
                }

                closeSync() {}
              }

              return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
            })

            const duckdbService = await import('./src/server/utils/duckdbService.ts?serialize-append=' + Date.now())
            const mainPromise = duckdbService.runDuckdbJsonQuery("SELECT 'main' AS label")

            await new Promise((resolve) => setTimeout(resolve, 10))

            const appendPromise = duckdbService.runDuckdbAppendJsonQuery("SELECT 'append' AS label")

            await Promise.all([mainPromise, appendPromise])
            console.log(JSON.stringify({overlaps}))
            await duckdbService.closeDuckdbService()
          `,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DUCKDB_PATH: duckdbPath,
            DUCKDB_MEMORY_LIMIT: '6400MiB',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const result = JSON.parse(stdout) as {overlaps: Array<{activeReads: number; label: string}>}

    expect(result.overlaps).toEqual([
      {activeReads: 1, label: 'main'},
      {activeReads: 1, label: 'append'},
    ])
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb service treats empty interactive json output as an empty row set', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-empty-result-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {closeDuckdbService, runDuckdbJsonQuery, runDuckdbStatement} = await import('./src/server/utils/duckdbService.ts')
            await runDuckdbStatement('CREATE TABLE sample(value INTEGER)')
            const rows = await runDuckdbJsonQuery('SELECT value FROM sample ORDER BY value')
            console.log(JSON.stringify(rows))
            await closeDuckdbService()
          `,
        ],
        {cwd: process.cwd(), env: {...process.env, DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'}},
      ),
    )

    const rows = JSON.parse(stdout) as unknown[]

    expect(rows).toEqual([])
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

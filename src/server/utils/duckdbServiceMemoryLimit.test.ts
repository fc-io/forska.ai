import {existsSync, readFileSync, rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {getDefaultMaintenanceDuckdbMemoryLimit} from './duckdbMemoryDefaults.ts'

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

test('duckdb service defaults maintenance owners to the bounded maintenance memory profile', () => {
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

    expect(runtimeConfig.memoryLimit).toBe(getDefaultMaintenanceDuckdbMemoryLimit())
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb service keeps the 20GB default for non-owner API processes', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-api-default-memory-limit-${Date.now()}.duckdb`

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
          env: {...process.env, DUCKDB_PATH: duckdbPath, DUCKDB_MEMORY_LIMIT: '', SERVER_ROLE: 'api'},
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

test('duckdb service serializes owner route reads with maintenance work regardless of memory limit', () => {
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

            let activeOperations = 0
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
                async run() {
                  activeOperations += 1
                  overlaps.push({activeOperations, label: 'maintenance-write'})
                  activeOperations -= 1
                }

                async runAndReadAll(statement) {
                  activeOperations += 1
                  overlaps.push({activeOperations, label: 'route-read'})
                  await new Promise((resolve) => setTimeout(resolve, statement.includes('route-read') ? 50 : 0))
                  activeOperations -= 1

                  return {
                    getRowObjectsJson() {
                      return [{label: 'route-read'}]
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
            const mainPromise = duckdbService.runDuckdbJsonQuery("SELECT 'route-read' AS label")

            await new Promise((resolve) => setTimeout(resolve, 10))

            const backgroundPromise = duckdbService.runDuckdbBackgroundStatement("INSERT INTO maintenance-write")

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
            DUCKDB_MEMORY_LIMIT: '20GB',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const result = JSON.parse(stdout) as {overlaps: Array<{activeOperations: number; label: string}>}

    expect(result.overlaps).toEqual([
      {activeOperations: 1, label: 'route-read'},
      {activeOperations: 1, label: 'maintenance-write'},
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

test('duckdb recycle barrier blocks foreground work until background work drains', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-recycle-foreground-barrier-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {mock} = await import('bun:test')

            const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

            let releaseBackground = () => {}
            const events = []

            const waitFor = async (predicate, remainingAttempts = 100) => {
              if (predicate()) {
                return true
              }

              if (remainingAttempts <= 0) {
                return false
              }

              await new Promise((resolve) => setTimeout(resolve, 1))
              return waitFor(predicate, remainingAttempts - 1)
            }

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
                  events.push(['read', label])

                  if (label === 'background') {
                    await new Promise((resolve) => {
                      releaseBackground = resolve
                    })
                  }

                  return {getRowObjectsJson: () => [{label}]}
                }

                interrupt() {
                  events.push(['interrupt'])
                }

                closeSync() {
                  events.push(['close'])
                }
              }

              class MockInstance {
                static async create() {
                  return new MockInstance()
                }

                async connect() {
                  return new MockConnection()
                }

                closeSync() {
                  events.push(['instance-close'])
                }
              }

              return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
            })

            const duckdbService = await import('./src/server/utils/duckdbService.ts?recycle-foreground-barrier=' + Date.now())
            const backgroundPromise = duckdbService.runDuckdbBackgroundJsonQuery("SELECT 'background' AS label")

            const backgroundStarted = await waitFor(() => events.some((event) => event[0] === 'read' && event[1] === 'background'))

            const closePromise = duckdbService.closeDuckdbService({checkpointBeforeClose: false, releaseOwnerLease: false})

            const barrierActive = await waitFor(() => globalThis.__forskaDuckdbServiceState.appendBarrier !== null)

            const mainPromise = duckdbService.runDuckdbJsonQuery("SELECT 'main' AS label")

            await new Promise((resolve) => setTimeout(resolve, 10))

            const pendingWhileBarrier = globalThis.__forskaDuckdbServiceState.duckdbPendingCount

            releaseBackground()
            await Promise.all([backgroundPromise, closePromise, mainPromise])

            console.log(JSON.stringify({backgroundStarted, barrierActive, events, pendingWhileBarrier}))
            await duckdbService.closeDuckdbService({checkpointBeforeClose: false, releaseOwnerLease: false})
          `,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DUCKDB_PATH: duckdbPath,
            DUCKDB_MEMORY_LIMIT: '20GB',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const result = JSON.parse(stdout) as {
      backgroundStarted: boolean
      barrierActive: boolean
      events: Array<Array<string>>
      pendingWhileBarrier: number
    }
    const mainReadIndex = result.events.findIndex((event) => {
      return event[0] === 'read' && event[1] === 'main'
    })
    const firstCloseIndex = result.events.findIndex((event) => {
      return event[0] === 'close'
    })

    expect(result.backgroundStarted).toBe(true)
    expect(result.barrierActive).toBe(true)
    expect(result.pendingWhileBarrier).toBe(2)
    expect(firstCloseIndex).toBeGreaterThan(-1)
    expect(mainReadIndex).toBeGreaterThan(firstCloseIndex)
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb recycle barrier survives nested barriers in queued main work', () => {
  const source = readFileSync('src/server/utils/duckdbService.ts', 'utf8')
  const barrierSource = source.slice(
    source.indexOf('const withDuckdbAppendBarrier'),
    source.indexOf('const getCloseSyncError'),
  )

  expect(barrierSource).toContain('const previousAppendBarrier = duckdbServiceState.appendBarrier')
  expect(barrierSource).toContain('appendBarrier.active = false')
  expect(barrierSource).toContain('getActiveDuckdbAppendBarrier(previousAppendBarrier)')
})

test('duckdb main transaction blocks append-lane work until commit finishes', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-transaction-append-barrier-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {mock} = await import('bun:test')

            const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

            let connectCount = 0
            let releaseTransactionBody = () => {}
            const events = []

            const waitFor = async (predicate, remainingAttempts = 100) => {
              if (predicate()) {
                return true
              }

              if (remainingAttempts <= 0) {
                return false
              }

              await new Promise((resolve) => setTimeout(resolve, 1))
              return waitFor(predicate, remainingAttempts - 1)
            }

            void mock.module(serverRuntimeRoleModulePath, () => {
              return {
                canCurrentServerOwnDuckdb: () => false,
                ensureCurrentDuckdbOwnerLease: async () => {},
                registerDuckdbOwnerDemotionHandler: () => {},
                releaseCurrentDuckdbOwnerLease: async () => {},
              }
            })

            void mock.module('@duckdb/node-api', () => {
              class MockConnection {
                constructor(kind) {
                  this.kind = kind
                }

                async run(statement) {
                  events.push(['run:start', this.kind, statement])

                  if (statement.includes('main-block')) {
                    await new Promise((resolve) => {
                      releaseTransactionBody = resolve
                    })
                  }

                  events.push(['run:end', this.kind, statement])
                }

                async runAndReadAll(statement) {
                  events.push(['read:start', this.kind, statement])
                  events.push(['read:end', this.kind, statement])
                  return {getRowObjectsJson: () => [{label: this.kind}]}
                }

                interrupt() {}
                closeSync() {}
              }

              class MockInstance {
                static async create() {
                  return new MockInstance()
                }

                async connect() {
                  connectCount += 1
                  return new MockConnection(connectCount === 1 ? 'main' : 'append')
                }

                closeSync() {}
              }

              return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
            })

            const workloadContext = {
              allowsTempSpill: true,
              fallbackIntent: 'reject',
              routeOrJobKey: 'test.transactionAppendBarrier',
              workloadClass: 'test',
            }
            const duckdbService = await import('./src/server/utils/duckdbService.ts?transaction-append-barrier=' + Date.now())
            const transactionPromise = duckdbService.runDuckdbTransaction(async (tx) => {
              await tx.run("SELECT 'main-block'")
            }, workloadContext)

            const transactionBodyStarted = await waitFor(() => {
              return events.some((event) => event[0] === 'run:start' && event[2].includes('main-block'))
            })
            const appendPromise = duckdbService.runDuckdbAppendJsonQuery(
              "SELECT 'append-after-begin' AS label",
              undefined,
              undefined,
              workloadContext,
            )

            await new Promise((resolve) => setTimeout(resolve, 10))
            const appendStartedBeforeCommit = events.some((event) => {
              return event[0] === 'read:start' && event[2].includes('append-after-begin')
            })

            releaseTransactionBody()
            await Promise.all([transactionPromise, appendPromise])

            console.log(JSON.stringify({appendStartedBeforeCommit, events, transactionBodyStarted}))
            await duckdbService.closeDuckdbService()
          `,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DUCKDB_APPEND_LANE_COUNT: '1',
            DUCKDB_PATH: duckdbPath,
            DUCKDB_MEMORY_LIMIT: '20GB',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const result = JSON.parse(stdout) as {
      appendStartedBeforeCommit: boolean
      events: Array<Array<string>>
      transactionBodyStarted: boolean
    }
    const commitEndIndex = result.events.findIndex((event) => {
      return event[0] === 'run:end' && event[2] === 'COMMIT'
    })
    const appendStartIndex = result.events.findIndex((event) => {
      return event[0] === 'read:start' && event[2].includes('append-after-begin')
    })

    expect(result.transactionBodyStarted).toBe(true)
    expect(result.appendStartedBeforeCommit).toBe(false)
    expect(commitEndIndex).toBeGreaterThan(-1)
    expect(appendStartIndex).toBeGreaterThan(commitEndIndex)
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb append transactions are opt-in and stay serialized with main transactions on low-memory workers', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-serialized-append-transaction-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {mock} = await import('bun:test')

            const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

            let activeStatements = 0
            let connectCount = 0
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
                constructor(kind) {
                  this.kind = kind
                }

                async run(statement) {
                  const label = statement.includes('main-block') ? 'main' : this.kind
                  activeStatements += 1
                  overlaps.push({activeStatements, label, statement})
                  await new Promise((resolve) => setTimeout(resolve, label === 'main' ? 50 : 0))
                  activeStatements -= 1
                }

                async runAndReadAll() {
                  return {getRowObjectsJson: () => []}
                }

                interrupt() {}
                closeSync() {}
              }

              class MockInstance {
                static async create() {
                  return new MockInstance()
                }

                async connect() {
                  connectCount += 1
                  return new MockConnection(connectCount === 1 ? 'main' : 'append')
                }

                closeSync() {}
              }

              return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
            })

            const duckdbService = await import('./src/server/utils/duckdbService.ts?append-transaction-low-memory=' + Date.now())
            const disabledError = await duckdbService.runDuckdbAppendTransaction(async () => {})
              .then(() => null, (error) => error)
            const mainPromise = duckdbService.runDuckdbTransaction(async (tx) => {
              await tx.run("SELECT 'main-block'")
            })

            await new Promise((resolve) => setTimeout(resolve, 10))

            process.env.FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED = 'true'
            const workloadContext = {
              allowsTempSpill: true,
              fallbackIntent: 'reject',
              routeOrJobKey: 'test.appendTransaction',
              workloadClass: 'test',
            }
            const appendPromise = duckdbService.runDuckdbAppendTransaction(async (tx) => {
              await tx.run("SELECT 'append-block'")
            }, workloadContext)

            await Promise.all([mainPromise, appendPromise])
            const diagnostics = await duckdbService.getDuckdbBackgroundRuntimeDiagnostics()
            console.log(JSON.stringify({disabledError: disabledError?.message ?? null, overlaps, diagnostics}))
            await duckdbService.closeDuckdbService()
          `,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DUCKDB_APPEND_LANE_COUNT: '2',
            DUCKDB_PATH: duckdbPath,
            DUCKDB_MEMORY_LIMIT: '6400MiB',
            FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED: 'false',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const result = JSON.parse(stdout) as {
      diagnostics: {workloads: Array<{operation: string; queue: string}>}
      disabledError: string | null
      overlaps: Array<{activeStatements: number; label: string; statement: string}>
    }

    expect(result.disabledError).toContain('FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED=true')
    expect(
      result.overlaps.every((overlap) => {
        return overlap.activeStatements === 1
      }),
    ).toBe(true)
    expect(
      result.diagnostics.workloads.some((workload) => {
        return workload.operation === 'appendTransaction' && workload.queue === 'main'
      }),
    ).toBe(true)
  } finally {
    removeDuckdbFiles(duckdbPath)
  }
})

test('duckdb append transactions roll back failed append-lane work before the next append transaction', () => {
  const duckdbPath = `/tmp/f1-duckdb-service-append-transaction-rollback-${Date.now()}.duckdb`

  try {
    const stdout = getSpawnOutput(
      globalThis.Bun.spawnSync(
        [
          'bun',
          '-e',
          `
            const {mock} = await import('bun:test')

            const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname

            let connectCount = 0
            const statements = []

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
                constructor(kind) {
                  this.kind = kind
                }

                async run(statement) {
                  statements.push({kind: this.kind, statement})
                }

                async runAndReadAll() {
                  return {getRowObjectsJson: () => []}
                }

                interrupt() {}
                closeSync() {}
              }

              class MockInstance {
                static async create() {
                  return new MockInstance()
                }

                async connect() {
                  connectCount += 1
                  return new MockConnection(connectCount === 1 ? 'main' : 'append')
                }

                closeSync() {}
              }

              return {DuckDBConnection: MockConnection, DuckDBInstance: MockInstance}
            })

            const duckdbService = await import('./src/server/utils/duckdbService.ts?append-transaction-rollback=' + Date.now())
            const firstError = await duckdbService.runDuckdbAppendTransaction(async (tx) => {
              await tx.run("SELECT 'failed-append'")
              throw new Error('append transaction failed')
            }).then(() => null, (error) => error)

            await duckdbService.runDuckdbAppendTransaction(async (tx) => {
              await tx.run("SELECT 'next-append'")
            })

            console.log(JSON.stringify({firstError: firstError?.message ?? null, statements}))
            await duckdbService.closeDuckdbService()
          `,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DUCKDB_APPEND_LANE_COUNT: '1',
            DUCKDB_PATH: duckdbPath,
            DUCKDB_MEMORY_LIMIT: '20GB',
            FORSKA_DUCKDB_APPEND_TRANSACTION_ENABLED: 'true',
            SERVER_ROLE: 'maintenance-worker',
          },
        },
      ),
    )

    const result = JSON.parse(stdout) as {
      firstError: string | null
      statements: Array<{kind: string; statement: string}>
    }
    const appendStatements = result.statements
      .filter((entry) => {
        return entry.kind === 'append'
      })
      .map((entry) => {
        return entry.statement
      })

    expect(result.firstError).toBe('append transaction failed')
    expect(appendStatements).toEqual([
      'BEGIN TRANSACTION',
      "SELECT 'failed-append'",
      'ROLLBACK',
      'BEGIN TRANSACTION',
      "SELECT 'next-append'",
      'COMMIT',
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

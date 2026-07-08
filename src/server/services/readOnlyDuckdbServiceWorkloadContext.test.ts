import {rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, mock, test} from 'bun:test'

type DuckdbServiceModule = typeof import('../utils/duckdbService.ts')
type ReadOnlyDuckdbServiceModule = typeof import('./readOnlyDuckdbService.ts')

const restoreEnvValue = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}

test('read-only DuckDB workload context records metrics without using the owner queue', async () => {
  const duckdbServiceModulePath = new URL('../utils/duckdbService.ts', import.meta.url).pathname
  const readOnlyDuckdbServiceModulePath = new URL('./readOnlyDuckdbService.ts', import.meta.url).pathname
  const serverRuntimeRoleModulePath = new URL('../utils/serverRuntimeRole.ts', import.meta.url).pathname
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT
  const previousDuckdbPath = process.env.DUCKDB_PATH
  const previousServerDuckdbOwnerUrl = process.env.SERVER_DUCKDB_OWNER_URL
  const previousServerRole = process.env.SERVER_ROLE
  const duckdbPath = join(tmpdir(), `forska-read-only-workload-${Date.now()}-${Math.random()}.duckdb`)

  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      canCurrentServerOwnDuckdb: () => {
        return false
      },
      ensureCurrentDuckdbOwnerLease: async () => {},
      registerDuckdbOwnerDemotionHandler: () => {},
      releaseCurrentDuckdbOwnerLease: async () => {},
    }
  })

  void mock.module('@duckdb/node-api', () => {
    class MockConnection {
      async runAndReadAll() {
        return {
          getRowObjectsJson() {
            return [{value: 'a'}, {value: 'b'}]
          },
        }
      }

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

  process.env.DUCKDB_MEMORY_LIMIT = '20GB'
  process.env.DUCKDB_PATH = duckdbPath
  process.env.SERVER_DUCKDB_OWNER_URL = ''
  process.env.SERVER_ROLE = 'api'
  writeFileSync(duckdbPath, '')

  try {
    const duckdbService = (await import(duckdbServiceModulePath)) as DuckdbServiceModule
    const readOnlyDuckdbService = (await import(
      `${readOnlyDuckdbServiceModulePath}?read-only-workload=${Date.now()}`
    )) as ReadOnlyDuckdbServiceModule
    const workloadContext = {
      maxResultRows: 10,
      projectId: 'project-a',
      routeOrJobKey: 'review.search.tokenPrefix',
      searchMode: 'tokenPrefix',
      workloadClass: 'foregroundReviewSearch',
    }
    const rows = await readOnlyDuckdbService.runReadOnlyDuckdbJsonQuery<{value: string}>(
      'api-read-only',
      'SELECT value FROM sample',
      workloadContext,
    )
    const metric = duckdbService.getDuckdbWorkloadRuntimeMetricsSnapshot().at(-1)

    expect(rows).toEqual([{value: 'a'}, {value: 'b'}])
    expect(metric).toMatchObject({
      operation: 'readOnlyQuery',
      projectId: 'project-a',
      queue: 'readOnly',
      resultRows: 2,
      routeOrJobKey: 'review.search.tokenPrefix',
      searchMode: 'tokenPrefix',
      workloadClass: 'foregroundReviewSearch',
    })
    readOnlyDuckdbService.resetReadOnlyDuckdbServiceForTests()
  } finally {
    restoreEnvValue('DUCKDB_MEMORY_LIMIT', previousDuckdbMemoryLimit)
    restoreEnvValue('DUCKDB_PATH', previousDuckdbPath)
    restoreEnvValue('SERVER_DUCKDB_OWNER_URL', previousServerDuckdbOwnerUrl)
    restoreEnvValue('SERVER_ROLE', previousServerRole)
    rmSync(duckdbPath, {force: true})
    mock.restore()
  }
})

test('api read-only DuckDB uses owner queue when this process owns DuckDB', async () => {
  const duckdbServiceModulePath = new URL('../utils/duckdbService.ts', import.meta.url).pathname
  const readOnlyDuckdbServiceModulePath = new URL('./readOnlyDuckdbService.ts', import.meta.url).pathname
  const serverRuntimeRoleModulePath = new URL('../utils/serverRuntimeRole.ts', import.meta.url).pathname
  const calls: Array<{statement: string; workloadContext: unknown}> = []

  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      canCurrentServerOwnDuckdb: () => {
        return true
      },
      ensureCurrentDuckdbOwnerLease: async () => {},
      registerDuckdbOwnerDemotionHandler: () => {},
      releaseCurrentDuckdbOwnerLease: async () => {},
    }
  })

  void mock.module(duckdbServiceModulePath, () => {
    return {
      getReadOnlyDuckdbRuntimeOptions: () => {
        return {}
      },
      runDuckdbJsonQuery: async <T>(statement: string, workloadContext?: unknown): Promise<T[]> => {
        calls.push({statement, workloadContext})
        return [{value: 'owner'}] as T[]
      },
      runMeasuredDuckdbJsonWorkload: async <T>(input: {work: () => Promise<T>}) => {
        return input.work()
      },
    }
  })

  try {
    const readOnlyDuckdbService = (await import(
      `${readOnlyDuckdbServiceModulePath}?api-owner-read-only=${Date.now()}`
    )) as ReadOnlyDuckdbServiceModule
    const workloadContext = {routeOrJobKey: 'review.warnings', workloadClass: 'foregroundReviewSearch'} as const
    const rows = await readOnlyDuckdbService.runReadOnlyDuckdbJsonQuery<{value: string}>(
      'api-read-only',
      'SELECT value FROM sample',
      workloadContext,
    )

    expect(rows).toEqual([{value: 'owner'}])
    expect(calls).toEqual([{statement: 'SELECT value FROM sample', workloadContext}])
  } finally {
    mock.restore()
  }
})

test('app read-only database service forwards workload context', async () => {
  const appReadOnlyDatabaseServiceModulePath = new URL('./appReadOnlyDatabaseService.ts', import.meta.url).pathname
  const readOnlyDuckdbServiceModulePath = new URL('./readOnlyDuckdbService.ts', import.meta.url).pathname
  const calls: Array<{context: string; statement: string; workloadContext: unknown}> = []

  void mock.module(readOnlyDuckdbServiceModulePath, () => {
    return {
      closeReadOnlyDuckdbService: async () => {},
      runReadOnlyDuckdbJsonQuery: async <T>(
        context: string,
        statement: string,
        workloadContext?: unknown,
      ): Promise<T[]> => {
        calls.push({context, statement, workloadContext})
        return []
      },
      validateReadOnlyDuckdbService: async () => {},
    }
  })

  try {
    const appReadOnlyDatabaseService = (await import(
      `${appReadOnlyDatabaseServiceModulePath}?workload-forward=${Date.now()}`
    )) as typeof import('./appReadOnlyDatabaseService.ts')
    const workloadContext = {
      routeOrJobKey: 'review.llm.rows',
      searchMode: 'none',
      workloadClass: 'foregroundReviewRows',
    }

    await appReadOnlyDatabaseService.getApiReadOnlyAppDatabaseService().queryJson('SELECT 1 AS value', workloadContext)

    expect(calls).toEqual([{context: 'api-read-only', statement: 'SELECT 1 AS value', workloadContext}])
  } finally {
    mock.restore()
  }
})

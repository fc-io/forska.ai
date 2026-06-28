import {expect, mock, test} from 'bun:test'

type DuckdbServiceModule = typeof import('./duckdbService.ts')

const getImportedDuckdbService = async (label: string) => {
  const duckdbServiceModulePath = new URL('./duckdbService.ts', import.meta.url).pathname

  return (await import(`${duckdbServiceModulePath}?${label}=${Date.now()}`)) as DuckdbServiceModule
}

const restoreEnvValue = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}

test('duckdb workload context rejects over-budget query results and records metrics', async () => {
  const serverRuntimeRoleModulePath = new URL('./serverRuntimeRole.ts', import.meta.url).pathname
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT
  const previousDuckdbPath = process.env.DUCKDB_PATH
  const previousServerRole = process.env.SERVER_ROLE

  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      canCurrentServerOwnDuckdb: () => {
        return true
      },
      ensureCurrentDuckdbOwnerLease: async () => {},
      getCurrentServerDuckdbOwnerUrl: async () => {
        return null
      },
      getCurrentServerRole: () => {
        return 'maintenance-worker'
      },
      getKnownDuckdbOwnerUrl: () => {
        return null
      },
      isCurrentServerDuckdbOwnerProxyDisabled: () => {
        return false
      },
      registerDuckdbOwnerDemotionHandler: () => {},
      releaseCurrentDuckdbOwnerLease: async () => {},
      shouldCurrentServerProxyApiToDuckdbOwner: () => {
        return false
      },
      shouldCurrentServerProxyApiToOwner: () => {
        return false
      },
    }
  })

  void mock.module('@duckdb/node-api', () => {
    class MockConnection {
      async run() {}

      async runAndReadAll() {
        return {
          getRowObjectsJson() {
            return [{value: 'a'}, {value: 'b'}]
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

  process.env.DUCKDB_MEMORY_LIMIT = '20GB'
  process.env.DUCKDB_PATH = ':memory:'
  process.env.SERVER_ROLE = 'maintenance-worker'

  try {
    const duckdbService = await getImportedDuckdbService('workload-context-budget')
    const error = await duckdbService
      .runDuckdbJsonQuery('SELECT value FROM sample', {
        allowsTempSpill: false,
        fallbackIntent: 'reject',
        maxResultBytes: 1_000,
        maxResultRows: 1,
        projectId: 'project-a',
        routeOrJobKey: 'review.llm.rows',
        searchMode: 'tokenPrefix',
        workloadClass: 'foregroundReviewRows',
      })
      .then(
        () => {
          return null
        },
        (caughtError: unknown) => {
          return caughtError instanceof Error ? caughtError : new Error(String(caughtError))
        },
      )
    const [metric] = duckdbService.getDuckdbWorkloadRuntimeMetricsSnapshot()

    expect(error?.message).toContain('result rows 2 exceeded budget 1')
    expect(error?.message).toContain('duckdb main query: SELECT value FROM sample')
    expect(metric).toMatchObject({
      error: null,
      operation: 'mainQuery',
      projectId: 'project-a',
      resultRows: 2,
      routeOrJobKey: 'review.llm.rows',
      searchMode: 'tokenPrefix',
      workloadClass: 'foregroundReviewRows',
    })
    await duckdbService.closeDuckdbService()
  } finally {
    restoreEnvValue('DUCKDB_MEMORY_LIMIT', previousDuckdbMemoryLimit)
    restoreEnvValue('DUCKDB_PATH', previousDuckdbPath)
    restoreEnvValue('SERVER_ROLE', previousServerRole)
    mock.restore()
  }
})

test('api-role foreground DuckDB work can require workload context before connection acquisition', async () => {
  const serverRuntimeRoleModulePath = new URL('./serverRuntimeRole.ts', import.meta.url).pathname
  const previousEnforceWorkloadContext = process.env.FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT
  const previousDuckdbPath = process.env.DUCKDB_PATH
  const previousServerRole = process.env.SERVER_ROLE
  let createCount = 0

  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      canCurrentServerOwnDuckdb: () => {
        return false
      },
      ensureCurrentDuckdbOwnerLease: async () => {},
      getCurrentServerDuckdbOwnerUrl: async () => {
        return null
      },
      getCurrentServerRole: () => {
        return 'api'
      },
      getKnownDuckdbOwnerUrl: () => {
        return null
      },
      isCurrentServerDuckdbOwnerProxyDisabled: () => {
        return false
      },
      registerDuckdbOwnerDemotionHandler: () => {},
      releaseCurrentDuckdbOwnerLease: async () => {},
      shouldCurrentServerProxyApiToDuckdbOwner: () => {
        return true
      },
      shouldCurrentServerProxyApiToOwner: () => {
        return true
      },
    }
  })

  void mock.module('@duckdb/node-api', () => {
    class MockConnection {
      async run() {}

      async runAndReadAll() {
        return {
          getRowObjectsJson() {
            return [{value: 'a'}]
          },
        }
      }

      interrupt() {}

      closeSync() {}
    }

    class MockInstance {
      static async create() {
        createCount += 1
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
  process.env.DUCKDB_PATH = ':memory:'
  process.env.FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT = 'true'
  process.env.SERVER_ROLE = 'api'

  try {
    const duckdbService = await getImportedDuckdbService('workload-context-api-guard')
    const error = await duckdbService.runDuckdbJsonQuery('SELECT value FROM sample').then(
      () => {
        return null
      },
      (caughtError: unknown) => {
        return caughtError instanceof Error ? caughtError : new Error(String(caughtError))
      },
    )

    expect(error?.message).toContain('requires DuckdbWorkloadContext before connection acquisition')
    expect(createCount).toBe(0)
  } finally {
    restoreEnvValue('DUCKDB_MEMORY_LIMIT', previousDuckdbMemoryLimit)
    restoreEnvValue('DUCKDB_PATH', previousDuckdbPath)
    restoreEnvValue('FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT', previousEnforceWorkloadContext)
    restoreEnvValue('SERVER_ROLE', previousServerRole)
    mock.restore()
  }
})

test('owner and background DuckDB scopes remain allowed without foreground workload enforcement', async () => {
  const serverRuntimeRoleModulePath = new URL('./serverRuntimeRole.ts', import.meta.url).pathname
  const previousEnforceWorkloadContext = process.env.FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT
  const previousDuckdbPath = process.env.DUCKDB_PATH
  const previousServerRole = process.env.SERVER_ROLE

  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      canCurrentServerOwnDuckdb: () => {
        return true
      },
      ensureCurrentDuckdbOwnerLease: async () => {},
      getCurrentServerDuckdbOwnerUrl: async () => {
        return null
      },
      getCurrentServerRole: () => {
        return 'maintenance-worker'
      },
      getKnownDuckdbOwnerUrl: () => {
        return null
      },
      isCurrentServerDuckdbOwnerProxyDisabled: () => {
        return false
      },
      registerDuckdbOwnerDemotionHandler: () => {},
      releaseCurrentDuckdbOwnerLease: async () => {},
      shouldCurrentServerProxyApiToDuckdbOwner: () => {
        return false
      },
      shouldCurrentServerProxyApiToOwner: () => {
        return false
      },
    }
  })

  void mock.module('@duckdb/node-api', () => {
    class MockConnection {
      async run() {}

      async runAndReadAll() {
        return {
          getRowObjectsJson() {
            return [{value: 'a'}]
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

  process.env.DUCKDB_MEMORY_LIMIT = '20GB'
  process.env.DUCKDB_PATH = ':memory:'
  process.env.FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT = 'true'
  process.env.SERVER_ROLE = 'maintenance-worker'

  try {
    const duckdbService = await getImportedDuckdbService('workload-context-owner-guard')

    await expect(duckdbService.runDuckdbJsonQuery('SELECT value FROM sample')).resolves.toEqual([{value: 'a'}])
    await expect(duckdbService.runDuckdbBackgroundJsonQuery('SELECT value FROM sample')).resolves.toEqual([{value: 'a'}])
    await expect(duckdbService.runDuckdbMaintenance('checkpoint')).resolves.toBeUndefined()
    await duckdbService.closeDuckdbService()
  } finally {
    restoreEnvValue('DUCKDB_MEMORY_LIMIT', previousDuckdbMemoryLimit)
    restoreEnvValue('DUCKDB_PATH', previousDuckdbPath)
    restoreEnvValue('FORSKA_ENFORCE_DUCKDB_WORKLOAD_CONTEXT', previousEnforceWorkloadContext)
    restoreEnvValue('SERVER_ROLE', previousServerRole)
    mock.restore()
  }
})

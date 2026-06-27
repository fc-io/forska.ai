import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const serverRuntimeRoleModulePath = new URL('../../utils/serverRuntimeRole.ts', import.meta.url).pathname

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}
const canOwnDuckdbRef = {current: true}
const ownerUrlRef = {
  current: async (): Promise<string | null> => {
    return null
  },
}

const registerModuleMocks = () => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: (statement: string) => {
            return queryJsonRef.current(statement)
          },
        }
      },
    }
  })

  void mock.module(serverRuntimeRoleModulePath, () => {
    return {
      canCurrentServerOwnDuckdb: () => {
        return canOwnDuckdbRef.current
      },
      getCurrentServerDuckdbOwnerUrl: () => {
        return ownerUrlRef.current()
      },
    }
  })
}

const loadProjectAccessGuard = async (): Promise<typeof import('./projectAccessGuard.ts')> => {
  registerModuleMocks()

  return import(`./projectAccessGuard.ts?test=${Date.now()}-${Math.random()}`) as Promise<
    typeof import('./projectAccessGuard.ts')
  >
}

afterEach(() => {
  canOwnDuckdbRef.current = true
  ownerUrlRef.current = async () => {
    return null
  }
  mock.restore()
})

test('getProjectAccess returns archived project rows', async () => {
  queryJsonRef.current = async () => {
    return [{archived: true, humanJudgmentMode: 'summary', id: 'project-1', name: 'Archived Project'}]
  }

  const {getProjectAccess} = await loadProjectAccessGuard()

  expect(await getProjectAccess('project-1')).toEqual({
    archived: true,
    humanJudgmentMode: 'summary',
    id: 'project-1',
    name: 'Archived Project',
  })
})

test('assertProjectIsActive rejects archived projects', async () => {
  queryJsonRef.current = async () => {
    return [{archived: true, humanJudgmentMode: 'summary', id: 'project-1', name: 'Archived Project'}]
  }

  const {archivedProjectAccessErrorMessage, assertProjectIsActive} = await loadProjectAccessGuard()
  let error: unknown = null

  await assertProjectIsActive('project-1').catch((caught: unknown) => {
    error = caught
  })

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(archivedProjectAccessErrorMessage)
})

test('assertProjectIsActive allows active projects', async () => {
  queryJsonRef.current = async () => {
    return [{archived: false, humanJudgmentMode: 'prompt', id: 'project-2', name: 'Active Project'}]
  }

  const {assertProjectIsActive} = await loadProjectAccessGuard()

  expect(await assertProjectIsActive('project-2')).toEqual({
    archived: false,
    humanJudgmentMode: 'prompt',
    id: 'project-2',
    name: 'Active Project',
  })
})

test('getProjectAccess uses owner-backed API when current role cannot own DuckDB', async () => {
  const ownerServer = globalThis.Bun.serve({
    port: 0,
    fetch: (request) => {
      const requestUrl = new URL(request.url)

      return requestUrl.pathname === '/__duckdb-owner-rpc/api/projects/project-api/access'
        ? Response.json({data: {archived: false, humanJudgmentMode: 'prompt', id: 'project-api', name: 'API Project'}})
        : Response.json({data: null, error: 'unexpected path'}, {status: 404})
    },
  })
  let localDuckdbReadCount = 0

  canOwnDuckdbRef.current = false
  ownerUrlRef.current = async () => {
    return `http://127.0.0.1:${ownerServer.port}`
  }
  queryJsonRef.current = async () => {
    localDuckdbReadCount += 1
    throw new Error('API role must not query DuckDB for project access')
  }

  try {
    const {getProjectAccess} = await loadProjectAccessGuard()

    expect(await getProjectAccess('project-api')).toEqual({
      archived: false,
      humanJudgmentMode: 'prompt',
      id: 'project-api',
      name: 'API Project',
    })
    expect(localDuckdbReadCount).toBe(0)
  } finally {
    await ownerServer.stop(true)
  }
})

test('getProjectAccess maps owner-backed project not found to null', async () => {
  const ownerServer = globalThis.Bun.serve({
    port: 0,
    fetch: () => {
      return Response.json({data: null, error: 'Project not found'}, {status: 404})
    },
  })

  canOwnDuckdbRef.current = false
  ownerUrlRef.current = async () => {
    return `http://127.0.0.1:${ownerServer.port}`
  }

  try {
    const {getProjectAccess} = await loadProjectAccessGuard()

    expect(await getProjectAccess('missing-project')).toBe(null)
  } finally {
    await ownerServer.stop(true)
  }
})

test('getProjectAccess reports unavailable instead of owning DuckDB when API has no owner URL', async () => {
  let localDuckdbReadCount = 0

  canOwnDuckdbRef.current = false
  queryJsonRef.current = async () => {
    localDuckdbReadCount += 1
    return []
  }

  const {getProjectAccess} = await loadProjectAccessGuard()
  let error: unknown = null

  await getProjectAccess('project-api').catch((caught: unknown) => {
    error = caught
  })

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('Project access read model is unavailable')
  expect(localDuckdbReadCount).toBe(0)
})

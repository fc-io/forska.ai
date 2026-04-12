import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
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
}

const loadProjectAccessGuard = async (): Promise<typeof import('./projectAccessGuard.ts')> => {
  registerModuleMocks()

  return import(`./projectAccessGuard.ts?test=${Date.now()}-${Math.random()}`) as Promise<
    typeof import('./projectAccessGuard.ts')
  >
}

afterEach(() => {
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

import {expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

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

test('getProjectAccess returns archived project rows', async () => {
  queryJsonRef.current = async () => {
    return [{id: 'project-1', name: 'Archived Project', archived: true}]
  }

  const {getProjectAccess} = await import('./projectAccessGuard.ts')

  expect(await getProjectAccess('project-1')).toEqual({id: 'project-1', name: 'Archived Project', archived: true})
})

test('assertProjectIsActive rejects archived projects', async () => {
  queryJsonRef.current = async () => {
    return [{id: 'project-1', name: 'Archived Project', archived: true}]
  }

  const {archivedProjectAccessErrorMessage, assertProjectIsActive} = await import('./projectAccessGuard.ts')
  let error: unknown = null

  await assertProjectIsActive('project-1').catch((caught: unknown) => {
    error = caught
  })

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(archivedProjectAccessErrorMessage)
})

test('assertProjectIsActive allows active projects', async () => {
  queryJsonRef.current = async () => {
    return [{id: 'project-2', name: 'Active Project', archived: false}]
  }

  const {assertProjectIsActive} = await import('./projectAccessGuard.ts')

  expect(await assertProjectIsActive('project-2')).toEqual({id: 'project-2', name: 'Active Project', archived: false})
})

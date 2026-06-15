import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../server/services/appDatabaseService.ts', import.meta.url).pathname

const appDatabaseServiceMockRef = {contexts: [] as unknown[], queries: [] as string[]}

const registerModuleMocks = () => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(query: string, workloadContext?: unknown): Promise<T[]> => {
            appDatabaseServiceMockRef.contexts = [...appDatabaseServiceMockRef.contexts, workloadContext]
            appDatabaseServiceMockRef.queries = [...appDatabaseServiceMockRef.queries, query]
            return [{total: 7}] as T[]
          },
        }
      },
    }
  })
}

afterEach(() => {
  mock.restore()
})

test('runDuckdbJsonQuery uses the app database service for the default database path', async () => {
  const workloadContext = {routeOrJobKey: 'review.llm.rows', searchMode: 'none', workloadClass: 'foregroundReviewRows'}
  appDatabaseServiceMockRef.queries = []
  appDatabaseServiceMockRef.contexts = []

  registerModuleMocks()
  const {runDuckdbJsonQuery} = (await import(
    `./duckdbRunner.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./duckdbRunner.ts')
  const rows = await runDuckdbJsonQuery<{total: number}>('SELECT 7 AS total', undefined, workloadContext)

  expect(rows).toEqual([{total: 7}])
  expect(appDatabaseServiceMockRef.queries).toEqual(['SELECT 7 AS total'])
  expect(appDatabaseServiceMockRef.contexts).toEqual([workloadContext])
})

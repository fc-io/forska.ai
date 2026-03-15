import {expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../server/services/appDatabaseService.ts', import.meta.url).pathname

const appDatabaseServiceMockRef = {queries: [] as string[]}

void mock.module(appDatabaseServiceModulePath, () => {
  return {
    getAppDatabaseService: () => {
      return {
        queryJson: async <T>(query: string): Promise<T[]> => {
          appDatabaseServiceMockRef.queries = [...appDatabaseServiceMockRef.queries, query]
          return [{total: 7}] as T[]
        },
      }
    },
  }
})

test('runDuckdbJsonQuery uses the app database service for the default database path', async () => {
  appDatabaseServiceMockRef.queries = []

  const {runDuckdbJsonQuery} = require('./duckdbRunner.ts') as typeof import('./duckdbRunner.ts')
  const rows = await runDuckdbJsonQuery<{total: number}>('SELECT 7 AS total')

  expect(rows).toEqual([{total: 7}])
  expect(appDatabaseServiceMockRef.queries).toEqual(['SELECT 7 AS total'])
})

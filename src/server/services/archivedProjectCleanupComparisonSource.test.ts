import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('./appDatabaseService.ts', import.meta.url).href

type TestRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

const state = {appQueries: [] as string[], appRuns: [] as string[], txQueries: [] as string[], txRuns: [] as string[]}

const resetState = () => {
  state.appQueries = []
  state.appRuns = []
  state.txQueries = []
  state.txRuns = []
}

const queryAppRows = <T>(statement: string): T[] => {
  if (statement.includes('FROM app.archived_project_delete_tombstone')) {
    return [{id: 'archived-source-project'}] as T[]
  }

  if (statement.includes('FROM app.comparison_project') && statement.includes('summary_source_project_id')) {
    return [{id: 'comparison-project-with-resolutions'}] as T[]
  }

  return []
}

const queryTxRows = <T>(statement: string): T[] => {
  if (statement.includes('information_schema.tables')) {
    return [{rowCount: 0}] as T[]
  }

  return []
}

const registerModuleMocks = () => {
  void mock.module(appDatabaseServiceModulePath, () => {
    const tx: TestRunner = {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        state.txQueries = [...state.txQueries, statement]

        return queryTxRows<T>(statement)
      },
      run: async (statement: string) => {
        state.txRuns = [...state.txRuns, statement]
      },
    }

    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string): Promise<T[]> => {
            state.appQueries = [...state.appQueries, statement]

            return queryAppRows<T>(statement)
          },
          run: async (statement: string) => {
            state.appRuns = [...state.appRuns, statement]
          },
          transaction: async <T>(callback: (runner: TestRunner) => Promise<T>): Promise<T> => {
            return callback(tx)
          },
        }
      },
    }
  })
}

afterEach(() => {
  mock.restore()
  resetState()
})

test('archived source cleanup detaches comparison summary references without deleting comparison child rows', async () => {
  registerModuleMocks()

  const {cleanupNextArchivedProjectBatch} = (await import(
    `./archivedProjectCleanupService.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./archivedProjectCleanupService.ts')

  const result = await cleanupNextArchivedProjectBatch({batchSize: 100})
  const mutationStatements = [...state.appRuns, ...state.txRuns].join('\n')

  expect(result).toEqual({
    deletedRowCount: 1,
    phase: 'source_cleanup',
    projectId: 'archived-source-project',
    tableName: 'app.comparison_project',
  })
  expect(mutationStatements).toContain('UPDATE app.comparison_project')
  expect(mutationStatements).not.toContain('CREATE TEMP TABLE')
  expect(mutationStatements).not.toMatch(/DELETE\s+FROM\s+app\.comparison_project_conflict_resolution/i)
  expect(mutationStatements).not.toMatch(/DELETE\s+FROM\s+app\.comparison_project_prompt/i)
  expect(mutationStatements).not.toMatch(/DELETE\s+FROM\s+app\.comparison_project_import_route/i)
  expect(mutationStatements).not.toMatch(/DELETE\s+FROM\s+app\.comparison_project_source_project/i)
  expect(mutationStatements).not.toMatch(/INSERT\s+INTO\s+app\.comparison_project_conflict_resolution/i)
})

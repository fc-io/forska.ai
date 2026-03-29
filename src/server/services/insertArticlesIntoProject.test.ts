import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('./appDatabaseService.ts', import.meta.url).pathname
const duckdbMartRefreshServiceModulePath = new URL('./getDuckdbMartRefreshService.ts', import.meta.url).pathname

type MockDatabaseState = {
  committedProjectArticleStatements: string[]
  committedProjectPromptStatements: string[]
  failProjectPromptInsert: boolean
  queryJson: (statement: string) => Promise<unknown[]>
  queueProjectRefreshCalls: Array<{projectId: string; reason: string}>
  rootRunStatements: string[]
  transactionCalls: number
}

const mockDatabaseStateRef: {current: MockDatabaseState | null} = {current: null}

const getMockDatabaseState = () => {
  const state = mockDatabaseStateRef.current

  if (!state) {
    throw new Error('Mock database state not initialized')
  }

  return state
}

void mock.module(appDatabaseServiceModulePath, () => {
  return {
    getAppDatabaseService: () => {
      return {
        queryJson: async <T>(statement: string) => {
          return (await getMockDatabaseState().queryJson(statement)) as T[]
        },
        run: async (statement: string) => {
          getMockDatabaseState().rootRunStatements.push(statement)
        },
        transaction: async <T>(work: (runner: {run: (statement: string) => Promise<void>}) => Promise<T>) => {
          const state = getMockDatabaseState()
          const pendingProjectArticleStatements: string[] = []
          const pendingProjectPromptStatements: string[] = []

          state.transactionCalls += 1

          const result = await work({
            run: async (statement: string) => {
              if (statement.includes('INSERT INTO app.project_article')) {
                pendingProjectArticleStatements.push(statement)
              }

              if (statement.includes('INSERT INTO app.project_prompt')) {
                if (state.failProjectPromptInsert) {
                  throw new Error('project prompt insert failed')
                }

                pendingProjectPromptStatements.push(statement)
              }
            },
          })

          state.committedProjectArticleStatements.push(...pendingProjectArticleStatements)
          state.committedProjectPromptStatements.push(...pendingProjectPromptStatements)

          return result
        },
      }
    },
  }
})

void mock.module(duckdbMartRefreshServiceModulePath, () => {
  return {
    getDuckdbMartRefreshService: () => {
      return {
        queueProjectRefresh: async (projectId: string, reason: string) => {
          getMockDatabaseState().queueProjectRefreshCalls.push({projectId, reason})
        },
      }
    },
  }
})

const createMockDatabaseState = (options?: {failProjectPromptInsert?: boolean}): MockDatabaseState => {
  return {
    committedProjectArticleStatements: [],
    committedProjectPromptStatements: [],
    failProjectPromptInsert: options?.failProjectPromptInsert ?? false,
    queryJson: async (statement: string) => {
      if (statement.includes('FROM app.article')) {
        return [{id: 'article-1'}]
      }

      if (statement.includes('FROM app.project_article')) {
        return []
      }

      if (statement.includes('FROM app.judgment')) {
        return [{pid: 'prompt-1'}]
      }

      if (statement.includes('FROM app.judgment_human')) {
        return []
      }

      if (statement.includes('FROM app.project_prompt')) {
        return []
      }

      if (statement.includes('FROM app.prompt')) {
        return [{id: 'prompt-1'}]
      }

      throw new Error(`Unhandled query: ${statement}`)
    },
    queueProjectRefreshCalls: [],
    rootRunStatements: [],
    transactionCalls: 0,
  }
}

const loadInsertArticlesIntoProject = async () => {
  const moduleUnknown: unknown = await import(`./insertArticlesIntoProject.ts?test=${Date.now()}-${Math.random()}`)
  return moduleUnknown as typeof import('./insertArticlesIntoProject.ts')
}

afterEach(() => {
  mockDatabaseStateRef.current = null
})

test('insertArticlesIntoProject writes article and prompt links in one transaction on success', async () => {
  mockDatabaseStateRef.current = createMockDatabaseState()

  const {insertArticlesIntoProject} = await loadInsertArticlesIntoProject()
  const result = await insertArticlesIntoProject('project-1', ['article-1'], 'source-project-1')
  const state = getMockDatabaseState()

  expect(result).toEqual({
    existingAssociations: 0,
    insertedCount: 1,
    invalidIds: [],
    linkedPrompts: 1,
    projectId: 'project-1',
    totalProvided: 1,
    totalValid: 1,
  })
  expect(state.transactionCalls).toBe(1)
  expect(state.rootRunStatements).toHaveLength(0)
  expect(state.committedProjectArticleStatements).toHaveLength(1)
  expect(state.committedProjectArticleStatements[0]).toContain('INSERT INTO app.project_article')
  expect(state.committedProjectPromptStatements).toHaveLength(1)
  expect(state.committedProjectPromptStatements[0]).toContain('INSERT INTO app.project_prompt')
  expect(state.queueProjectRefreshCalls).toEqual([{projectId: 'project-1', reason: 'insertArticlesIntoProject'}])
})

test('insertArticlesIntoProject rolls back project_article writes when prompt linking fails', async () => {
  mockDatabaseStateRef.current = createMockDatabaseState({failProjectPromptInsert: true})

  const {insertArticlesIntoProject} = await loadInsertArticlesIntoProject()
  const insertPromise = insertArticlesIntoProject('project-1', ['article-1'], 'source-project-1')
  const error = await insertPromise.then(
    () => {
      return new Error('Expected insertArticlesIntoProject to fail')
    },
    (caughtError) => {
      return caughtError instanceof Error ? caughtError : new Error(String(caughtError))
    },
  )

  expect(error.message).toBe('project prompt insert failed')

  const state = getMockDatabaseState()

  expect(state.transactionCalls).toBe(1)
  expect(state.rootRunStatements).toHaveLength(0)
  expect(state.committedProjectArticleStatements).toHaveLength(0)
  expect(state.committedProjectPromptStatements).toHaveLength(0)
  expect(state.queueProjectRefreshCalls).toHaveLength(0)
})

import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const projectMartDirtyRefreshStateServiceModulePath = new URL(
  '../services/projectMartDirtyRefreshStateService.ts',
  import.meta.url,
).pathname
const providerModelRepositoryModulePath = new URL('../providers/providerModelRepository.ts', import.meta.url).pathname

type MockDatabaseState = {
  committedProjectArticleStatements: string[]
  committedProjectPromptStatements: string[]
  committedProjectStatements: string[]
  committedPromptStatements: string[]
  markProjectsDirtyCalls: Array<{projects: Array<{articleIds?: string[]; projectId: string}>; reason: string | null}>
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

const getCreatedProjectRow = () => {
  return {
    dateFrom: null,
    dateTo: null,
    description: 'rollback check',
    id: 'subproject-1',
    modelId: 'model-1',
    name: 'Rollback-safe subproject',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const queryJson = async (statement: string) => {
  if (statement.includes('FROM app.prompt')) {
    return [
      {
        archived: false,
        id: 'source-prompt-1',
        originalText: 'Is this relevant?',
        promptHeading: 'ai',
        transformedText: null,
        type: 'string',
      },
    ]
  }

  if (statement.includes('FROM app.project_import_route')) {
    return [{importRouteId: 'import-route-1', projectId: 'source-project-1'}]
  }

  if (statement.includes('FROM app.project') && statement.includes("WHERE id IN ('source-project-1')")) {
    return [
      {
        dateFrom: null,
        dateTo: null,
        id: 'source-project-1',
        modelId: 'model-1',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
    ]
  }

  if (statement.includes('FROM app.article a')) {
    return [{id: 'article-1'}]
  }

  throw new Error(`Unhandled query: ${statement}`)
}

const registerModuleMocks = () => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string) => {
            return (await queryJson(statement)) as T[]
          },
          run: async (statement: string) => {
            getMockDatabaseState().rootRunStatements.push(statement)
          },
          transaction: async <T>(
            work: (runner: {
              queryJson: <R>(statement: string) => Promise<R[]>
              run: (statement: string) => Promise<void>
            }) => Promise<T>,
          ) => {
            const state = getMockDatabaseState()
            const pendingProjectArticleStatements: string[] = []
            const pendingProjectPromptStatements: string[] = []
            const pendingProjectStatements: string[] = []
            const pendingPromptStatements: string[] = []

            state.transactionCalls += 1

            const result = await work({
              queryJson: async <R>(statement: string) => {
                if (statement.includes('INSERT INTO app.project')) {
                  pendingProjectStatements.push(statement)
                  return [getCreatedProjectRow()] as R[]
                }

                if (statement.includes('INSERT INTO app.prompt')) {
                  pendingPromptStatements.push(statement)
                  return [{id: `detached-prompt-${pendingPromptStatements.length}`}] as R[]
                }

                return (await queryJson(statement)) as R[]
              },
              run: async (statement: string) => {
                if (statement.includes('INSERT INTO app.project_prompt')) {
                  pendingProjectPromptStatements.push(statement)
                  return
                }

                if (statement.includes('INSERT INTO app.project_article')) {
                  throw new Error('project article insert failed')
                }

                pendingProjectArticleStatements.push(statement)
              },
            })

            state.committedProjectStatements.push(...pendingProjectStatements)
            state.committedPromptStatements.push(...pendingPromptStatements)
            state.committedProjectPromptStatements.push(...pendingProjectPromptStatements)
            state.committedProjectArticleStatements.push(...pendingProjectArticleStatements)

            return result
          },
        }
      },
    }
  })

  void mock.module(projectMartDirtyRefreshStateServiceModulePath, () => {
    return {
      getProjectMartDirtyRefreshStateService: () => {
        return {
          markProjectsDirtyAtomically: async (params: {
            projects: Array<{articleIds?: string[]; projectId: string}>
            reason?: string | null
          }) => {
            getMockDatabaseState().markProjectsDirtyCalls.push({
              projects: params.projects,
              reason: params.reason ?? null,
            })
          },
        }
      },
    }
  })

  void mock.module(providerModelRepositoryModulePath, () => {
    return {assertSelectableProviderModelId: async () => {}}
  })
}

const createMockDatabaseState = (): MockDatabaseState => {
  return {
    committedProjectArticleStatements: [],
    committedProjectPromptStatements: [],
    committedProjectStatements: [],
    committedPromptStatements: [],
    markProjectsDirtyCalls: [],
    rootRunStatements: [],
    transactionCalls: 0,
  }
}

const loadSubprojectsRoutes = async () => {
  registerModuleMocks()

  const moduleUnknown: unknown = await import(`./SubprojectsRoutes.ts?rollback=${Date.now()}-${Math.random()}`)
  return moduleUnknown as typeof import('./SubprojectsRoutes.ts')
}

afterEach(() => {
  mockDatabaseStateRef.current = null
  mock.restore()
})

test('subproject route rolls back project and detached prompts when article linking fails', async () => {
  mockDatabaseStateRef.current = createMockDatabaseState()

  const {subprojectsRoutes} = await loadSubprojectsRoutes()
  const app = new Elysia().use(subprojectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/subprojects', {
      body: JSON.stringify({
        description: 'rollback check',
        modelId: 'model-1',
        name: 'Rollback-safe subproject',
        promptSelections: [{promptId: 'source-prompt-1', types: []}],
        sourceProjectIds: ['source-project-1'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()
  const state = getMockDatabaseState()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('project article insert failed')
  expect(state.transactionCalls).toBe(1)
  expect(state.rootRunStatements).toHaveLength(0)
  expect(state.committedProjectStatements).toHaveLength(0)
  expect(state.committedPromptStatements).toHaveLength(0)
  expect(state.committedProjectPromptStatements).toHaveLength(0)
  expect(state.committedProjectArticleStatements).toHaveLength(0)
  expect(state.markProjectsDirtyCalls).toHaveLength(0)
})

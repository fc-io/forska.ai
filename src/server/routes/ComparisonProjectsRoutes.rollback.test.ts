import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const providerModelRepositoryModulePath = new URL('../providers/providerModelRepository.ts', import.meta.url).pathname

type MockDatabaseState = {
  comparisonProject: {id: string; modelIds: string[]}
  failPromptInsert: boolean
  promptLinks: Array<{id: string; promptId: string; order: number}>
  routeLinks: Array<{id: string; importRouteId: string}>
  rootRunStatements: string[]
  transactionCalls: number
}

const mockDatabaseStateRef: {current: MockDatabaseState | null} = {current: null}

const promptRows = {
  'prompt-1': {
    archived: false,
    createdAt: new Date('2026-03-29T00:00:00.000Z'),
    id: 'prompt-1',
    originalText: 'Original prompt',
    promptHeading: 'Prompt 1',
    type: 'string',
  },
  'prompt-2': {
    archived: false,
    createdAt: new Date('2026-03-29T00:00:00.000Z'),
    id: 'prompt-2',
    originalText: 'Replacement prompt',
    promptHeading: 'Prompt 2',
    type: 'string',
  },
} as const

const modelRows = {
  'model-1': {id: 'model-1', modelName: 'Model 1', provider: 'openrouter', version: null},
  'model-2': {id: 'model-2', modelName: 'Model 2', provider: 'openrouter', version: null},
} as const

const getMockDatabaseState = () => {
  const state = mockDatabaseStateRef.current

  if (!state) {
    throw new Error('Mock database state not initialized')
  }

  return state
}

const getComparisonProjectRow = (modelIds: string[]) => {
  return {
    compareWithHumans: false,
    createdAt: new Date('2026-03-29T00:00:00.000Z'),
    description: 'Rollback test project',
    id: 'comparison-project-1',
    modelIds,
    name: 'Rollback test project',
    updatedAt: new Date('2026-03-29T00:00:00.000Z'),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const getPromptRows = (links: Array<{id: string; promptId: string; order: number}>) => {
  return links.map((link) => {
    const promptRow = promptRows[link.promptId as keyof typeof promptRows]

    return {
      archived: promptRow.archived,
      createdAt: promptRow.createdAt,
      id: promptRow.id,
      order: link.order,
      originalText: promptRow.originalText,
      promptHeading: promptRow.promptHeading,
      type: promptRow.type,
    }
  })
}

const getAvailablePromptRows = () => {
  return Object.values(promptRows)
}

const getConfiguredModelRows = (selectedModelIds: string[]) => {
  return selectedModelIds.map((modelId) => {
    const modelRow = modelRows[modelId as keyof typeof modelRows]

    return {id: modelRow.id, modelName: modelRow.modelName, provider: modelRow.provider, version: modelRow.version}
  })
}

const getValidatedPromptRows = (statement: string) => {
  return Object.keys(promptRows)
    .filter((promptId) => {
      return statement.includes(`'${promptId}'`)
    })
    .map((promptId) => {
      return {id: promptId}
    })
}

const queryJson = async (
  statement: string,
  state: {
    comparisonProject: {id: string; modelIds: string[]}
    promptLinks: Array<{id: string; promptId: string; order: number}>
    routeLinks: Array<{id: string; importRouteId: string}>
  },
) => {
  if (statement.includes('FROM app.comparison_project') && statement.includes('updated_at AS updatedAt')) {
    return [getComparisonProjectRow(state.comparisonProject.modelIds)]
  }

  if (statement.includes('FROM app.comparison_project') && statement.includes('model_ids AS modelIds')) {
    return [{modelIds: state.comparisonProject.modelIds}]
  }

  if (statement.includes('FROM app.model')) {
    return getConfiguredModelRows(state.comparisonProject.modelIds)
  }

  if (statement.includes('FROM app.comparison_project_prompt') && statement.includes('INNER JOIN app.prompt')) {
    return getPromptRows(state.promptLinks)
  }

  if (statement.includes('FROM app.prompt') && statement.includes('archived = FALSE')) {
    return getAvailablePromptRows()
  }

  if (statement.includes('FROM app.prompt') && statement.includes('WHERE id IN')) {
    return getValidatedPromptRows(statement)
  }

  if (statement.includes('FROM app.comparison_project_import_route')) {
    return state.routeLinks.map((routeLink) => {
      return {id: routeLink.id, importRouteId: routeLink.importRouteId}
    })
  }

  throw new Error(`Unhandled query: ${statement}`)
}

void mock.module(providerModelRepositoryModulePath, () => {
  return {
    assertSelectableProviderModelIds: async (_db: unknown, params: {modelIds: string[]}) => {
      return params.modelIds
    },
  }
})

void mock.module(appDatabaseServiceModulePath, () => {
  return {
    getAppDatabaseService: () => {
      return {
        queryJson: async <T>(statement: string) => {
          return (await queryJson(statement, getMockDatabaseState())) as T[]
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
          const pendingComparisonProject = {...state.comparisonProject}
          const pendingPromptLinks = state.promptLinks.map((link) => {
            return {...link}
          })
          const pendingRouteLinks = state.routeLinks.map((link) => {
            return {...link}
          })

          state.transactionCalls += 1

          const result = await work({
            queryJson: async <R>(statement: string) => {
              return (await queryJson(statement, {
                comparisonProject: pendingComparisonProject,
                promptLinks: pendingPromptLinks,
                routeLinks: pendingRouteLinks,
              })) as R[]
            },
            run: async (statement: string) => {
              if (statement.includes('UPDATE app.comparison_project')) {
                pendingComparisonProject.modelIds = ['model-2']
                return
              }

              if (statement.includes('DELETE FROM app.comparison_project_prompt')) {
                pendingPromptLinks.splice(0, pendingPromptLinks.length)
                return
              }

              if (statement.includes('DELETE FROM app.comparison_project_import_route')) {
                pendingRouteLinks.splice(0, pendingRouteLinks.length)
                return
              }

              if (statement.includes('INSERT INTO app.comparison_project_import_route')) {
                const matchingRouteLink = state.routeLinks.find((routeLink) => {
                  return statement.includes(`'${routeLink.id}'`) && statement.includes(`'${routeLink.importRouteId}'`)
                })

                if (!matchingRouteLink) {
                  throw new Error(`Unhandled route relink insert: ${statement}`)
                }

                pendingRouteLinks.push(matchingRouteLink)
                return
              }

              if (statement.includes('INSERT INTO app.comparison_project_prompt')) {
                if (state.failPromptInsert) {
                  throw new Error('comparison project prompt insert failed')
                }

                pendingPromptLinks.push({id: 'comparison-project-prompt-2', order: 0, promptId: 'prompt-2'})
                return
              }

              throw new Error(`Unhandled run: ${statement}`)
            },
          })

          state.comparisonProject = pendingComparisonProject
          state.promptLinks = pendingPromptLinks
          state.routeLinks = pendingRouteLinks

          return result
        },
      }
    },
  }
})

const createMockDatabaseState = (): MockDatabaseState => {
  return {
    comparisonProject: {id: 'comparison-project-1', modelIds: ['model-1']},
    failPromptInsert: true,
    promptLinks: [{id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'}],
    rootRunStatements: [],
    routeLinks: [{id: 'comparison-project-route-1', importRouteId: 'import-route-1'}],
    transactionCalls: 0,
  }
}

const loadComparisonProjectsRoutes = async () => {
  const moduleUnknown: unknown = await import(`./ComparisonProjectsRoutes.ts?rollback=${Date.now()}-${Math.random()}`)
  return moduleUnknown as typeof import('./ComparisonProjectsRoutes.ts')
}

afterEach(() => {
  mockDatabaseStateRef.current = null
})

test('comparison project model relink failure keeps original links intact', async () => {
  mockDatabaseStateRef.current = createMockDatabaseState()

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1', {
      body: JSON.stringify({
        compareWithHumans: false,
        description: 'Rollback test project',
        modelIds: ['model-2'],
        name: 'Rollback test project',
        promptSelections: [{promptId: 'prompt-2', order: 0}],
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const bodyText = await response.text()
  const state = getMockDatabaseState()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('comparison project prompt insert failed')
  expect(state.transactionCalls).toBe(1)
  expect(state.rootRunStatements).toHaveLength(0)
  expect(state.comparisonProject.modelIds).toEqual(['model-1'])
  expect(state.routeLinks).toEqual([{id: 'comparison-project-route-1', importRouteId: 'import-route-1'}])
  expect(state.promptLinks).toEqual([{id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'}])
})

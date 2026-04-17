import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const providerModelRepositoryModulePath = new URL('../providers/providerModelRepository.ts', import.meta.url).pathname

type MockDatabaseState = {
  comparisonProject: {
    humanJudgmentMode: 'prompt' | 'summary' | null
    id: string
    modelIds: string[]
    summarySourceProjectId: string | null
  }
  failPromptInsert: boolean
  lastUpdateStatement: string | null
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

const getComparisonProjectRow = (comparisonProject: MockDatabaseState['comparisonProject']) => {
  return {
    compareWithHumans: false,
    createdAt: new Date('2026-03-29T00:00:00.000Z'),
    description: 'Rollback test project',
    humanJudgmentMode: comparisonProject.humanJudgmentMode,
    id: 'comparison-project-1',
    modelIds: comparisonProject.modelIds,
    name: 'Rollback test project',
    summarySourceProjectId: comparisonProject.summarySourceProjectId,
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
    comparisonProject: MockDatabaseState['comparisonProject']
    promptLinks: Array<{id: string; promptId: string; order: number}>
    routeLinks: Array<{id: string; importRouteId: string}>
  },
) => {
  if (statement.includes('FROM app.comparison_project') && statement.includes('updated_at AS updatedAt')) {
    return [getComparisonProjectRow(state.comparisonProject)]
  }

  if (statement.includes('FROM app.project p') && statement.includes('WHERE p.archived = FALSE')) {
    return [
      {
        dateFrom: new Date('2026-01-01T00:00:00.000Z'),
        dateTo: new Date('2026-02-01T00:00:00.000Z'),
        description: 'Summary source project',
        humanJudgmentMode: 'summary',
        id: 'source-project-1',
        modelId: 'model-1',
        modelMetadataJson: {},
        modelName: 'Model 1',
        name: 'Summary Source',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
    ]
  }

  if (statement.includes('FROM app.comparison_project') && statement.includes('model_ids AS modelIds')) {
    return [{modelIds: state.comparisonProject.modelIds}]
  }

  if (statement.includes('FROM app.project_prompt') && statement.includes("pp.project_id IN ('source-project-1')")) {
    return [
      {
        criteriaDisposition: 'include',
        criteriaSectionKey: 'population',
        criteriaSectionLabel: 'Population',
        order: 0,
        projectId: 'source-project-1',
        promptHeading: 'Prompt 1',
        promptId: 'prompt-1',
      },
    ]
  }

  if (
    statement.includes('FROM app.project_import_route')
    && statement.includes("pir.project_id IN ('source-project-1')")
  ) {
    return [{name: 'Import Route 1', projectId: 'source-project-1', route: 'import-route-1'}]
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

const registerModuleMocks = () => {
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
                  state.lastUpdateStatement = statement
                  if (statement.includes("human_judgment_mode = 'summary'")) {
                    pendingComparisonProject.humanJudgmentMode = 'summary'
                  }

                  if (statement.includes("human_judgment_mode = 'prompt'")) {
                    pendingComparisonProject.humanJudgmentMode = 'prompt'
                  }

                  if (statement.includes("summary_source_project_id = 'source-project-1'")) {
                    pendingComparisonProject.summarySourceProjectId = 'source-project-1'
                  }

                  if (statement.includes('summary_source_project_id = NULL')) {
                    pendingComparisonProject.summarySourceProjectId = null
                  }

                  if (statement.includes('model-2')) {
                    pendingComparisonProject.modelIds = ['model-2']
                  }

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
}

const createMockDatabaseState = (): MockDatabaseState => {
  return {
    comparisonProject: {
      humanJudgmentMode: 'prompt',
      id: 'comparison-project-1',
      modelIds: ['model-1'],
      summarySourceProjectId: null,
    },
    failPromptInsert: true,
    lastUpdateStatement: null,
    promptLinks: [{id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'}],
    rootRunStatements: [],
    routeLinks: [{id: 'comparison-project-route-1', importRouteId: 'import-route-1'}],
    transactionCalls: 0,
  }
}

const loadComparisonProjectsRoutes = async () => {
  registerModuleMocks()

  const moduleUnknown: unknown = await import(`./ComparisonProjectsRoutes.ts?rollback=${Date.now()}-${Math.random()}`)
  return moduleUnknown as typeof import('./ComparisonProjectsRoutes.ts')
}

afterEach(() => {
  mockDatabaseStateRef.current = null
  mock.restore()
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

test('comparison project update persists summary mode contract fields', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1', {
      body: JSON.stringify({
        compareWithHumans: false,
        description: 'Rollback test project',
        humanJudgmentMode: 'summary',
        modelIds: ['model-1'],
        name: 'Rollback test project',
        promptSelections: [{promptId: 'prompt-2', order: 0}],
        summarySourceProjectId: 'source-project-1',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {humanJudgmentMode: string; summarySourceProjectId: string | null}}
  const state = getMockDatabaseState()

  expect(response.status).toBe(200)
  expect(body.data.humanJudgmentMode).toBe('summary')
  expect(body.data.summarySourceProjectId).toBe('source-project-1')
  expect(state.comparisonProject.humanJudgmentMode).toBe('summary')
  expect(state.comparisonProject.summarySourceProjectId).toBe('source-project-1')
  expect(state.lastUpdateStatement).toContain("human_judgment_mode = 'summary'")
  expect(state.lastUpdateStatement).toContain("summary_source_project_id = 'source-project-1'")
})

test('comparison project sources expose summary capability metadata', async () => {
  mockDatabaseStateRef.current = createMockDatabaseState()

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(new Request('http://localhost/api/comparison-projects/sources'))
  const body = (await response.json()) as {
    data: Array<{
      humanJudgmentMode: string
      isSummaryCapable: boolean
      prompts: Array<{criteriaDisposition: string | null; criteriaSectionKey: string | null}>
      summarySourceProjectId: string | null
    }>
  }
  const [sourceProject] = body.data

  expect(response.status).toBe(200)
  expect(sourceProject?.humanJudgmentMode).toBe('summary')
  expect(sourceProject?.isSummaryCapable).toBe(true)
  expect(sourceProject?.summarySourceProjectId).toBe('source-project-1')
  expect(sourceProject?.prompts[0]?.criteriaDisposition).toBe('include')
  expect(sourceProject?.prompts[0]?.criteriaSectionKey).toBe('population')
})

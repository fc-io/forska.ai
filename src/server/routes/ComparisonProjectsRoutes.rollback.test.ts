import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const providerModelRepositoryModulePath = new URL('../providers/providerModelRepository.ts', import.meta.url).pathname

type MockDatabaseState = {
  comparisonProject: {
    archived?: boolean
    compareWithHumans: boolean
    humanJudgmentMode: 'prompt' | 'summary' | null
    id: string
    modelIds: string[]
    summarySourceProjectId: string | null
  }
  extraLlmRows: MockLlmJudgmentRow[]
  failPromptInsert: boolean
  includeSingleAnswerArticle: boolean
  lastPromptInsertStatement: string | null
  lastUpdateStatement: string | null
  promptLinks: Array<{
    criteriaDisposition?: string | null
    criteriaSectionKey?: string | null
    criteriaSectionLabel?: string | null
    id: string
    promptId: string
    order: number
  }>
  queryStatements: string[]
  routeLinks: Array<{id: string; importRouteId: string}>
  sourceProjectLinks: Array<{id: string; sourceProjectId: string}>
  rootRunStatements: string[]
  transactionCalls: number
}

const mockDatabaseStateRef: {current: MockDatabaseState | null} = {current: null}

type MockLlmJudgmentRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
  articleId: string
  createdAt: Date
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

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

const sourceProjects = {
  'source-project-1': {
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
  'source-project-2': {
    description: 'Additional summary source project',
    humanJudgmentMode: 'summary',
    id: 'source-project-2',
    modelId: 'model-2',
    modelMetadataJson: {},
    modelName: 'Model 2',
    name: 'Summary Peer',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  },
  'source-project-mismatch': {
    description: 'Mismatched summary source project',
    humanJudgmentMode: 'summary',
    id: 'source-project-mismatch',
    modelId: 'model-2',
    modelMetadataJson: {},
    modelName: 'Model 2',
    name: 'Summary Mismatch',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  },
  'prompt-project-1': {
    description: 'Prompt source project',
    humanJudgmentMode: 'prompt',
    id: 'prompt-project-1',
    modelId: 'model-1',
    modelMetadataJson: {},
    modelName: 'Model 1',
    name: 'Prompt Source',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  },
} as const

const sourceProjectPromptRows = [
  {
    criteriaDisposition: 'include',
    criteriaSectionKey: 'population',
    criteriaSectionLabel: 'Population',
    order: 0,
    projectId: 'source-project-1',
    promptHeading: 'Prompt 1',
    promptId: 'prompt-1',
  },
  {
    criteriaDisposition: 'exclude',
    criteriaSectionKey: 'outcome',
    criteriaSectionLabel: 'Outcome',
    order: 1,
    projectId: 'source-project-1',
    promptHeading: 'Prompt 2',
    promptId: 'prompt-2',
  },
  {
    criteriaDisposition: 'include',
    criteriaSectionKey: 'population',
    criteriaSectionLabel: 'Population',
    order: 0,
    projectId: 'source-project-2',
    promptHeading: 'Prompt 1',
    promptId: 'prompt-1',
  },
  {
    criteriaDisposition: 'exclude',
    criteriaSectionKey: 'outcome',
    criteriaSectionLabel: 'Outcome',
    order: 1,
    projectId: 'source-project-2',
    promptHeading: 'Prompt 2',
    promptId: 'prompt-2',
  },
  {
    criteriaDisposition: 'include',
    criteriaSectionKey: 'intervention',
    criteriaSectionLabel: 'Intervention',
    order: 0,
    projectId: 'source-project-mismatch',
    promptHeading: 'Prompt 1',
    promptId: 'prompt-1',
  },
  {
    criteriaDisposition: null,
    criteriaSectionKey: null,
    criteriaSectionLabel: null,
    order: 0,
    projectId: 'prompt-project-1',
    promptHeading: 'Prompt 1',
    promptId: 'prompt-1',
  },
] as const

const sourceProjectRouteRows = [
  {name: 'Import Route 1', projectId: 'source-project-1', route: 'import-route-1'},
  {name: 'Import Route 2', projectId: 'source-project-2', route: 'import-route-2'},
  {name: 'Import Route 3', projectId: 'source-project-mismatch', route: 'import-route-3'},
  {name: 'Import Route 1', projectId: 'prompt-project-1', route: 'import-route-1'},
] as const

const getMockDatabaseState = () => {
  const state = mockDatabaseStateRef.current

  if (!state) {
    throw new Error('Mock database state not initialized')
  }

  return state
}

const getComparisonProjectRow = (comparisonProject: MockDatabaseState['comparisonProject']) => {
  return {
    archived: comparisonProject.archived ?? false,
    compareWithHumans: comparisonProject.compareWithHumans,
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

const getPromptRows = (
  links: Array<{
    criteriaDisposition?: string | null
    criteriaSectionKey?: string | null
    criteriaSectionLabel?: string | null
    id: string
    promptId: string
    order: number
  }>,
) => {
  return links.map((link) => {
    const promptRow = promptRows[link.promptId as keyof typeof promptRows]

    return {
      archived: promptRow.archived,
      createdAt: promptRow.createdAt,
      criteriaDisposition: link.criteriaDisposition ?? null,
      criteriaSectionKey: link.criteriaSectionKey ?? null,
      criteriaSectionLabel: link.criteriaSectionLabel ?? null,
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

    return {
      id: modelRow.id,
      metadataJson: {},
      modelName: modelRow.modelName,
      name: modelRow.modelName,
      provider: modelRow.provider,
      version: modelRow.version,
    }
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

const getMockLlmJudgmentRow = (params: {answer: string; articleId: string; modelId: string; promptId: string}) => {
  return {
    answeredOriginal: params.answer,
    answeredOriginalAsArray: null,
    articleId: params.articleId,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    modelId: params.modelId,
    promptId: params.promptId,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const postComparisonProjectJudgments = (
  app: {handle: (request: Request) => Promise<Response>},
  body: Record<string, unknown>,
) => {
  return app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/judgments', {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

const postComparisonProjectExport = (
  app: {handle: (request: Request) => Promise<Response>},
  body: Record<string, unknown>,
) => {
  return app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/export', {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

const getComparisonProjectJudgmentsTotalCount = async (response: Response) => {
  const body = (await response.json()) as {data: {totalCount: number}}

  return body.data.totalCount
}

const getComparisonProjectJudgmentRowTitles = async (response: Response) => {
  const body = (await response.json()) as {data: {data: Array<{articleTitle: string | null}>}}

  return body.data.data.map((row) => {
    return row.articleTitle ?? 'Untitled'
  })
}

const getComparisonProjectCsvDataTitles = (csv: string) => {
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      return line.split(',')[0] ?? ''
    })
    .filter((title) => {
      return title !== ''
    })
}

const getComparisonProjectExportAndJudgmentTitles = async (
  app: {handle: (request: Request) => Promise<Response>},
  body: Record<string, unknown>,
) => {
  const judgmentsResponse = await postComparisonProjectJudgments(app, {...body, limit: '50', page: '1'})
  const exportResponse = await postComparisonProjectExport(app, body)
  const judgmentTitles = await getComparisonProjectJudgmentRowTitles(judgmentsResponse)
  const exportTitles = getComparisonProjectCsvDataTitles(await exportResponse.text())

  expect(judgmentsResponse.status).toBe(200)
  expect(exportResponse.status).toBe(200)
  expect(exportTitles).toEqual(judgmentTitles)

  return exportTitles
}

const queryJson = async (
  statement: string,
  state: {
    comparisonProject: MockDatabaseState['comparisonProject']
    extraLlmRows: MockDatabaseState['extraLlmRows']
    promptLinks: MockDatabaseState['promptLinks']
    routeLinks: Array<{id: string; importRouteId: string}>
    sourceProjectLinks: Array<{id: string; sourceProjectId: string}>
    includeSingleAnswerArticle: boolean
  },
) => {
  if (statement.includes('FROM app.comparison_project') && statement.includes('updated_at AS updatedAt')) {
    return [getComparisonProjectRow(state.comparisonProject)]
  }

  if (
    statement.includes('FROM app.comparison_project')
    && statement.includes('created_at AS createdAt')
    && statement.includes('WHERE id =')
  ) {
    return [getComparisonProjectRow(state.comparisonProject)]
  }

  if (statement.includes('INSERT INTO app.comparison_project') && statement.includes('RETURNING')) {
    return [
      {
        ...getComparisonProjectRow({
          compareWithHumans: statement.includes('TRUE'),
          humanJudgmentMode: statement.includes("'summary'") ? 'summary' : 'prompt',
          id: 'comparison-project-created',
          modelIds: Object.keys(modelRows).filter((modelId) => {
            return statement.includes(`'${modelId}'`)
          }),
          summarySourceProjectId: statement.includes("'source-project-2'")
            ? 'source-project-2'
            : statement.includes("'source-project-1'")
              ? 'source-project-1'
              : null,
        }),
        id: 'comparison-project-created',
      },
    ]
  }

  if (statement.includes('FROM app.project p') && statement.includes('WHERE p.archived = FALSE')) {
    return Object.values(sourceProjects)
  }

  if (statement.includes('FROM app.project p') && statement.includes('WHERE p.id IN')) {
    return Object.values(sourceProjects)
      .filter((sourceProject) => {
        return statement.includes(`'${sourceProject.id}'`)
      })
      .map((sourceProject) => {
        const {modelMetadataJson: _modelMetadataJson, ...sourceProjectRow} = sourceProject
        return sourceProjectRow
      })
  }

  if (statement.includes('FROM app.project p') && statement.includes('WHERE p.id =')) {
    return Object.values(sourceProjects)
      .filter((sourceProject) => {
        return statement.includes(`'${sourceProject.id}'`)
      })
      .map((sourceProject) => {
        const {modelMetadataJson: _modelMetadataJson, ...sourceProjectRow} = sourceProject
        return sourceProjectRow
      })
  }

  if (statement.includes('FROM app.project') && statement.includes('WHERE id IN')) {
    return Object.values(sourceProjects)
      .filter((sourceProject) => {
        return statement.includes(`'${sourceProject.id}'`)
      })
      .map((sourceProject) => {
        return {id: sourceProject.id}
      })
  }

  if (statement.includes('FROM app.project') && statement.includes('WHERE id =')) {
    return Object.values(sourceProjects)
      .filter((sourceProject) => {
        return statement.includes(`'${sourceProject.id}'`)
      })
      .map((sourceProject) => {
        return {humanJudgmentMode: sourceProject.humanJudgmentMode, id: sourceProject.id}
      })
  }

  if (statement.includes('FROM app.project') && statement.includes('WHERE use_title =')) {
    return []
  }

  if (statement.includes('FROM app.comparison_project') && statement.includes('model_ids AS modelIds')) {
    return [{modelIds: state.comparisonProject.modelIds}]
  }

  if (statement.includes('FROM app.project_prompt') && statement.includes('project_id =')) {
    const sourcePromptRows = sourceProjectPromptRows
      .filter((promptRow) => {
        return statement.includes(`'${promptRow.projectId}'`)
      })
      .map((promptRow) => {
        return {
          criteriaDisposition: promptRow.criteriaDisposition,
          criteriaSectionKey: promptRow.criteriaSectionKey,
          criteriaSectionLabel: promptRow.criteriaSectionLabel,
          order: promptRow.order,
          promptId: promptRow.promptId,
        }
      })

    return statement.includes('prompt_id IN')
      ? sourcePromptRows.filter((promptRow) => {
          return statement.includes(`'${promptRow.promptId}'`)
        })
      : sourcePromptRows
  }

  if (statement.includes('FROM app.project_prompt') && statement.includes('pp.project_id IN')) {
    const promptRowsForSelectedProjects = sourceProjectPromptRows.filter((promptRow) => {
      return statement.includes(`'${promptRow.projectId}'`)
    })

    return statement.includes('AS sourceProjectId')
      ? promptRowsForSelectedProjects.map((promptRow) => {
          return {...promptRow, id: promptRow.promptId, sourceProjectId: promptRow.projectId}
        })
      : promptRowsForSelectedProjects
  }

  if (statement.includes('FROM app.project_import_route') && statement.includes('pir.project_id IN')) {
    return sourceProjectRouteRows.filter((routeRow) => {
      return statement.includes(`'${routeRow.projectId}'`)
    })
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

  if (statement.includes('FROM app.comparison_project_source_project')) {
    return state.sourceProjectLinks.map((sourceProjectLink) => {
      return {id: sourceProjectLink.id, sourceProjectId: sourceProjectLink.sourceProjectId}
    })
  }

  if (statement.includes('FROM app.article a')) {
    return [
      {
        articleCreatedAt: new Date('2026-03-30T00:00:00.000Z'),
        articleSummary: 'Article 1 summary',
        articleTitle: 'Article 1',
        id: 'article-1',
      },
      {
        articleCreatedAt: new Date('2026-03-29T00:00:00.000Z'),
        articleSummary: 'Article 2 summary',
        articleTitle: 'Article 2',
        id: 'article-2',
      },
    ]
  }

  if (statement.includes('FROM app.judgment j')) {
    return [
      {
        answeredOriginal: 'yes',
        answeredOriginalAsArray: null,
        articleId: 'article-1',
        createdAt: new Date('2026-03-31T00:00:00.000Z'),
        modelId: 'model-1',
        promptId: 'prompt-1',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
      {
        answeredOriginal: 'yes',
        answeredOriginalAsArray: null,
        articleId: 'article-1',
        createdAt: new Date('2026-03-31T00:00:00.000Z'),
        modelId: 'model-1',
        promptId: 'prompt-2',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
      {
        answeredOriginal: 'yes',
        answeredOriginalAsArray: null,
        articleId: 'article-1',
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        modelId: 'model-2',
        promptId: 'prompt-1',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
      {
        answeredOriginal: 'no',
        answeredOriginalAsArray: null,
        articleId: 'article-1',
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        modelId: 'model-2',
        promptId: 'prompt-2',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
      {
        answeredOriginal: 'no',
        answeredOriginalAsArray: null,
        articleId: 'article-1',
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
        modelId: 'model-2',
        promptId: 'prompt-2',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      },
      ...(state.includeSingleAnswerArticle
        ? [
            {
              answeredOriginal: 'yes',
              answeredOriginalAsArray: null,
              articleId: 'article-2',
              createdAt: new Date('2026-04-01T00:00:00.000Z'),
              modelId: 'model-1',
              promptId: 'prompt-1',
              useAbstract: true,
              useFulltext: false,
              useFulltextNoImages: false,
              useTitle: true,
            },
          ]
        : []),
      ...state.extraLlmRows,
    ]
  }

  if (statement.includes('FROM app.judgment_human_summary')) {
    return [{answer: 'maybe', articleId: 'article-1', updatedAt: new Date('2026-04-02T00:00:00.000Z')}]
  }

  if (statement.includes('FROM app.judgment_human\n')) {
    return [
      {answer: 'yes', articleId: 'article-1', promptId: 'prompt-1', updatedAt: new Date('2026-04-02T00:00:00.000Z')},
      {answer: 'no', articleId: 'article-1', promptId: 'prompt-2', updatedAt: new Date('2026-04-02T00:00:00.000Z')},
    ]
  }

  if (statement.includes('FROM app.import_route')) {
    return Array.from(
      new Map(
        sourceProjectRouteRows
          .filter((routeRow) => {
            return statement.includes(`'${routeRow.route}'`)
          })
          .map((routeRow) => {
            return [routeRow.route, {id: routeRow.route, route: routeRow.route}] as const
          }),
      ).values(),
    )
  }

  throw new Error(`Unhandled query: ${statement}`)
}

const registerModuleMocks = () => {
  let detachedComparisonProjectLinks: {
    promptLinks: MockDatabaseState['promptLinks']
    routeLinks: MockDatabaseState['routeLinks']
    sourceProjectLinks: MockDatabaseState['sourceProjectLinks']
  } | null = null

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
            getMockDatabaseState().queryStatements.push(statement)
            return (await queryJson(statement, getMockDatabaseState())) as T[]
          },
          run: async (statement: string) => {
            const state = getMockDatabaseState()
            state.rootRunStatements.push(statement)

            if (statement.includes('CREATE TEMP TABLE')) {
              detachedComparisonProjectLinks = {
                promptLinks: state.promptLinks.map((link) => {
                  return {...link}
                }),
                routeLinks: state.routeLinks.map((link) => {
                  return {...link}
                }),
                sourceProjectLinks: state.sourceProjectLinks.map((link) => {
                  return {...link}
                }),
              }
              return
            }

            if (statement.includes('INSERT INTO app.comparison_project_prompt') && detachedComparisonProjectLinks) {
              state.promptLinks = detachedComparisonProjectLinks.promptLinks
              state.routeLinks = detachedComparisonProjectLinks.routeLinks
              state.sourceProjectLinks = detachedComparisonProjectLinks.sourceProjectLinks
              detachedComparisonProjectLinks = null
              return
            }

            if (statement.includes('DELETE FROM app.comparison_project_prompt')) {
              state.promptLinks.splice(0, state.promptLinks.length)
            }

            if (statement.includes('DELETE FROM app.comparison_project_import_route')) {
              state.routeLinks.splice(0, state.routeLinks.length)
            }

            if (statement.includes('DELETE FROM app.comparison_project_source_project')) {
              state.sourceProjectLinks.splice(0, state.sourceProjectLinks.length)
            }
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
            const pendingSourceProjectLinks = state.sourceProjectLinks.map((link) => {
              return {...link}
            })

            state.transactionCalls += 1

            const result = await work({
              queryJson: async <R>(statement: string) => {
                getMockDatabaseState().queryStatements.push(statement)
                return (await queryJson(statement, {
                  comparisonProject: pendingComparisonProject,
                  extraLlmRows: state.extraLlmRows,
                  includeSingleAnswerArticle: state.includeSingleAnswerArticle,
                  promptLinks: pendingPromptLinks,
                  routeLinks: pendingRouteLinks,
                  sourceProjectLinks: pendingSourceProjectLinks,
                })) as R[]
              },
              run: async (statement: string) => {
                if (statement.includes('UPDATE app.comparison_project')) {
                  if (
                    pendingPromptLinks.length > 0
                    || pendingRouteLinks.length > 0
                    || pendingSourceProjectLinks.length > 0
                  ) {
                    throw new Error('comparison project FK detach violation')
                  }

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

                if (statement.includes('DELETE FROM app.comparison_project_source_project')) {
                  pendingSourceProjectLinks.splice(0, pendingSourceProjectLinks.length)
                  return
                }

                if (statement.includes('INSERT INTO app.comparison_project_import_route')) {
                  const importRouteId = ['import-route-1', 'import-route-2', 'import-route-3'].find((routeId) => {
                    return statement.includes(`'${routeId}'`)
                  })

                  if (!importRouteId) {
                    throw new Error(`Unhandled route relink insert: ${statement}`)
                  }

                  const matchingRouteLink = state.routeLinks.find((routeLink) => {
                    return routeLink.importRouteId === importRouteId
                  })

                  pendingRouteLinks.push({
                    id:
                      matchingRouteLink && statement.includes(`'${matchingRouteLink.id}'`)
                        ? matchingRouteLink.id
                        : 'comparison-project-route-created',
                    importRouteId,
                  })
                  return
                }

                if (statement.includes('INSERT INTO app.comparison_project_prompt')) {
                  if (state.failPromptInsert) {
                    throw new Error('comparison project prompt insert failed')
                  }

                  state.lastPromptInsertStatement = statement
                  const promptId = statement.includes("'prompt-1'") ? 'prompt-1' : 'prompt-2'
                  pendingPromptLinks.push({
                    criteriaDisposition: statement.includes("'exclude'")
                      ? 'exclude'
                      : statement.includes("'include'")
                        ? 'include'
                        : null,
                    criteriaSectionKey: statement.includes("'outcome'")
                      ? 'outcome'
                      : statement.includes("'population'")
                        ? 'population'
                        : null,
                    criteriaSectionLabel: statement.includes("'Outcome'")
                      ? 'Outcome'
                      : statement.includes("'Population'")
                        ? 'Population'
                        : null,
                    id: `comparison-project-prompt-${pendingPromptLinks.length + 1}`,
                    order: statement.includes("'prompt-2'") ? 1 : 0,
                    promptId,
                  })
                  return
                }

                if (statement.includes('INSERT INTO app.comparison_project_source_project')) {
                  const sourceProjectId = statement.includes("'source-project-2'")
                    ? 'source-project-2'
                    : statement.includes("'source-project-mismatch'")
                      ? 'source-project-mismatch'
                      : statement.includes("'prompt-project-1'")
                        ? 'prompt-project-1'
                        : 'source-project-1'

                  pendingSourceProjectLinks.push({
                    id: `comparison-project-source-${pendingSourceProjectLinks.length + 1}`,
                    sourceProjectId,
                  })
                  return
                }

                if (statement.includes('DROP TABLE temp_comparison_project_update_')) {
                  detachedComparisonProjectLinks = null
                  return
                }

                throw new Error(`Unhandled run: ${statement}`)
              },
            })

            state.comparisonProject = pendingComparisonProject
            state.promptLinks = pendingPromptLinks
            state.routeLinks = pendingRouteLinks
            state.sourceProjectLinks = pendingSourceProjectLinks

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
      compareWithHumans: false,
      humanJudgmentMode: 'prompt',
      id: 'comparison-project-1',
      modelIds: ['model-1'],
      summarySourceProjectId: null,
    },
    extraLlmRows: [],
    failPromptInsert: true,
    includeSingleAnswerArticle: false,
    lastPromptInsertStatement: null,
    lastUpdateStatement: null,
    promptLinks: [{id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'}],
    queryStatements: [],
    rootRunStatements: [],
    routeLinks: [{id: 'comparison-project-route-1', importRouteId: 'import-route-1'}],
    sourceProjectLinks: [],
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
  expect(state.rootRunStatements.length).toBeGreaterThan(0)
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
        compareWithHumans: true,
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
  expect(state.lastPromptInsertStatement).toContain("'exclude'")
  expect(state.lastPromptInsertStatement).toContain("'outcome'")
  expect(state.lastPromptInsertStatement).toContain("'Outcome'")
  expect(state.promptLinks[0]?.criteriaDisposition).toBe('exclude')
  expect(state.promptLinks[0]?.criteriaSectionKey).toBe('outcome')
})

test('comparison project create copies summary source prompt criteria metadata', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false, promptLinks: []}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Manual summary comparison',
        humanJudgmentMode: 'summary',
        modelIds: ['model-1'],
        name: 'Manual summary comparison',
        promptSelections: [{promptId: 'prompt-2', order: 0}],
        summarySourceProjectId: 'source-project-1',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {humanJudgmentMode: string; summarySourceProjectId: string | null}}
  const state = getMockDatabaseState()

  expect(response.status).toBe(200)
  expect(body.data.humanJudgmentMode).toBe('summary')
  expect(body.data.summarySourceProjectId).toBe('source-project-1')
  expect(state.lastPromptInsertStatement).toContain("'exclude'")
  expect(state.lastPromptInsertStatement).toContain("'outcome'")
  expect(state.promptLinks[0]?.criteriaDisposition).toBe('exclude')
  expect(state.promptLinks[0]?.criteriaSectionKey).toBe('outcome')
})

test('comparison project create derives summary prompts from the source project when none are provided', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false, promptLinks: []}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Manual summary comparison',
        humanJudgmentMode: 'summary',
        modelIds: ['model-1'],
        name: 'Manual summary comparison',
        summarySourceProjectId: 'source-project-1',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {humanJudgmentMode: string; summarySourceProjectId: string | null}}
  const state = getMockDatabaseState()

  expect(response.status).toBe(200)
  expect(body.data.humanJudgmentMode).toBe('summary')
  expect(body.data.summarySourceProjectId).toBe('source-project-1')
  expect(state.promptLinks).toEqual([
    {
      criteriaDisposition: 'include',
      criteriaSectionKey: 'population',
      criteriaSectionLabel: 'Population',
      id: 'comparison-project-prompt-1',
      order: 0,
      promptId: 'prompt-1',
    },
    {
      criteriaDisposition: 'exclude',
      criteriaSectionKey: 'outcome',
      criteriaSectionLabel: 'Outcome',
      id: 'comparison-project-prompt-2',
      order: 1,
      promptId: 'prompt-2',
    },
  ])
})

test('comparison project create-from-project defaults summary-capable sources to summary mode', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false, promptLinks: []}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/from-project', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Covevidence summary comparison',
        name: 'Covevidence summary comparison',
        sourceProjectId: 'source-project-1',
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {humanJudgmentMode: string; summarySourceProjectId: string | null}}
  const state = getMockDatabaseState()

  expect(response.status).toBe(200)
  expect(body.data.humanJudgmentMode).toBe('summary')
  expect(body.data.summarySourceProjectId).toBe('source-project-1')
  expect(state.promptLinks).toEqual([
    {
      criteriaDisposition: 'include',
      criteriaSectionKey: 'population',
      criteriaSectionLabel: 'Population',
      id: 'comparison-project-prompt-1',
      order: 0,
      promptId: 'prompt-1',
    },
    {
      criteriaDisposition: 'exclude',
      criteriaSectionKey: 'outcome',
      criteriaSectionLabel: 'Outcome',
      id: 'comparison-project-prompt-2',
      order: 1,
      promptId: 'prompt-2',
    },
  ])
  expect(state.routeLinks[0]?.importRouteId).toBe('import-route-1')
  expect(state.sourceProjectLinks).toEqual([{id: 'comparison-project-source-1', sourceProjectId: 'source-project-1'}])
})

test('comparison project create-from-project includes compatible additional summary projects', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    failPromptInsert: false,
    promptLinks: [],
    routeLinks: [],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/from-project', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Multi-project summary comparison',
        name: 'Multi-project summary comparison',
        sourceProjectId: 'source-project-1',
        sourceProjectIds: ['source-project-2'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {
    data: {humanJudgmentMode: string; modelIds: string[] | null; summarySourceProjectId: string | null}
  }
  const state = getMockDatabaseState()

  expect(response.status).toBe(200)
  expect(body.data.humanJudgmentMode).toBe('summary')
  expect(body.data.summarySourceProjectId).toBe('source-project-1')
  expect(body.data.modelIds).toEqual(['model-1', 'model-2'])
  expect(state.routeLinks).toEqual([
    {id: 'comparison-project-route-created', importRouteId: 'import-route-1'},
    {id: 'comparison-project-route-created', importRouteId: 'import-route-2'},
  ])
  expect(state.sourceProjectLinks).toEqual([
    {id: 'comparison-project-source-1', sourceProjectId: 'source-project-1'},
    {id: 'comparison-project-source-2', sourceProjectId: 'source-project-2'},
  ])
})

test('comparison project create-from-project keeps prompt sources in prompt mode', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false, promptLinks: []}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/from-project', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Prompt comparison',
        name: 'Prompt comparison',
        sourceProjectId: 'prompt-project-1',
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {humanJudgmentMode: string; summarySourceProjectId: string | null}}
  const state = getMockDatabaseState()

  expect(response.status).toBe(200)
  expect(body.data.humanJudgmentMode).toBe('prompt')
  expect(body.data.summarySourceProjectId).toBeNull()
  expect(state.promptLinks).toEqual([
    {
      criteriaDisposition: null,
      criteriaSectionKey: null,
      criteriaSectionLabel: null,
      id: 'comparison-project-prompt-1',
      order: 0,
      promptId: 'prompt-1',
    },
  ])
  expect(state.sourceProjectLinks).toEqual([{id: 'comparison-project-source-1', sourceProjectId: 'prompt-project-1'}])
})

test('comparison project create-from-project allows additional summary projects with different summary prompts', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false, promptLinks: []}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/from-project', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Different prompt multi-project summary comparison',
        name: 'Different prompt multi-project summary comparison',
        sourceProjectId: 'source-project-1',
        sourceProjectIds: ['source-project-mismatch'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  expect(response.status).toBe(200)
  expect(getMockDatabaseState().sourceProjectLinks).toEqual([
    {id: 'comparison-project-source-1', sourceProjectId: 'source-project-1'},
    {id: 'comparison-project-source-2', sourceProjectId: 'source-project-mismatch'},
  ])
})

test('comparison project create-from-project rejects non-summary additional projects in summary mode', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false, promptLinks: []}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/from-project', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Broken multi-project summary comparison',
        humanJudgmentMode: 'summary',
        name: 'Broken multi-project summary comparison',
        sourceProjectId: 'source-project-1',
        sourceProjectIds: ['prompt-project-1'],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('Additional projects require summary-capable source projects')
  expect(getMockDatabaseState().sourceProjectLinks).toEqual([])
})

test('comparison project create rejects summary mode without a summary source project', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false, promptLinks: []}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Manual summary comparison',
        humanJudgmentMode: 'summary',
        modelIds: ['model-1'],
        name: 'Manual summary comparison',
        promptSelections: [{promptId: 'prompt-1', order: 0}],
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('Summary mode requires a summary source project')
  expect(getMockDatabaseState().promptLinks).toEqual([])
})

test('comparison project create rejects prompt-mode projects as summary sources', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false, promptLinks: []}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Manual summary comparison',
        humanJudgmentMode: 'summary',
        modelIds: ['model-1'],
        name: 'Manual summary comparison',
        promptSelections: [{promptId: 'prompt-1', order: 0}],
        summarySourceProjectId: 'prompt-project-1',
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('Summary source project must exist and be summary-capable')
  expect(getMockDatabaseState().promptLinks).toEqual([])
})

test('comparison project update rejects summary mode without human comparison', async () => {
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
  const bodyText = await response.text()
  const state = getMockDatabaseState()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('Summary mode requires compareWithHumans to be true')
  expect(state.comparisonProject.humanJudgmentMode).toBe('prompt')
  expect(state.promptLinks).toEqual([{id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'}])
})

test('comparison project update rejects summary prompts outside source project', async () => {
  mockDatabaseStateRef.current = {...createMockDatabaseState(), failPromptInsert: false}

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1', {
      body: JSON.stringify({
        compareWithHumans: true,
        description: 'Rollback test project',
        humanJudgmentMode: 'summary',
        modelIds: ['model-1'],
        name: 'Rollback test project',
        promptSelections: [{promptId: 'missing-prompt', order: 0}],
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
  const bodyText = await response.text()
  const state = getMockDatabaseState()

  expect(response.status).toBe(500)
  expect(bodyText).toContain(
    'Summary mode selected prompts must exist on the summary source project and include summary criteria metadata',
  )
  expect(state.comparisonProject.humanJudgmentMode).toBe('prompt')
  expect(state.promptLinks).toEqual([{id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'}])
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

test('comparison judgments normalize missing and invalid rowFilter to multiple answers', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: false,
      humanJudgmentMode: 'prompt',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: null,
    },
    failPromptInsert: false,
    includeSingleAnswerArticle: true,
    promptLinks: [
      {id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'},
      {id: 'comparison-project-prompt-2', order: 1, promptId: 'prompt-2'},
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const missingResponse = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/judgments', {
      body: JSON.stringify({limit: '50', page: '1'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const invalidResponse = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/judgments', {
      body: JSON.stringify({limit: '50', page: '1', rowFilter: 'not-a-real-filter'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const allResponse = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/judgments', {
      body: JSON.stringify({limit: '50', page: '1', rowFilter: 'all'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const missingBody = (await missingResponse.json()) as {data: {totalCount: number}}
  const invalidBody = (await invalidResponse.json()) as {data: {totalCount: number}}
  const allBody = (await allResponse.json()) as {data: {totalCount: number}}

  expect(missingResponse.status).toBe(200)
  expect(invalidResponse.status).toBe(200)
  expect(allResponse.status).toBe(200)
  expect(missingBody.data.totalCount).toBe(1)
  expect(invalidBody.data.totalCount).toBe(1)
  expect(allBody.data.totalCount).toBe(2)
})

test('prompt comparison judgments apply rowFilter modes and keep difference filtering', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: false,
      humanJudgmentMode: 'prompt',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: null,
    },
    extraLlmRows: [
      getMockLlmJudgmentRow({answer: 'yes', articleId: 'article-2', modelId: 'model-1', promptId: 'prompt-1'}),
      getMockLlmJudgmentRow({answer: 'yes', articleId: 'article-2', modelId: 'model-1', promptId: 'prompt-2'}),
    ],
    failPromptInsert: false,
    promptLinks: [
      {id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'},
      {id: 'comparison-project-prompt-2', order: 1, promptId: 'prompt-2'},
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const multipleAnswersResponse = await postComparisonProjectJudgments(app, {
    limit: '50',
    page: '1',
    rowFilter: 'multiple-answers',
  })
  const fullyAnsweredResponse = await postComparisonProjectJudgments(app, {
    limit: '50',
    page: '1',
    rowFilter: 'fully-answered',
  })
  const allRowsWithDifferenceResponse = await postComparisonProjectJudgments(app, {
    differenceFilter: 'llm-vs-llm',
    limit: '50',
    page: '1',
    rowFilter: 'all',
  })
  const [multipleAnswersTotalCount, fullyAnsweredTotalCount, allRowsWithDifferenceTotalCount] = await Promise.all(
    [multipleAnswersResponse, fullyAnsweredResponse, allRowsWithDifferenceResponse].map(
      getComparisonProjectJudgmentsTotalCount,
    ),
  )

  expect(multipleAnswersResponse.status).toBe(200)
  expect(fullyAnsweredResponse.status).toBe(200)
  expect(allRowsWithDifferenceResponse.status).toBe(200)
  expect(multipleAnswersTotalCount).toBe(2)
  expect(fullyAnsweredTotalCount).toBe(1)
  expect(allRowsWithDifferenceTotalCount).toBe(1)
})

test('summary comparison judgments apply rowFilter modes to shown summary columns', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: true,
      humanJudgmentMode: 'summary',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: 'source-project-1',
    },
    extraLlmRows: [
      getMockLlmJudgmentRow({answer: 'no', articleId: 'article-2', modelId: 'model-1', promptId: 'prompt-1'}),
      getMockLlmJudgmentRow({answer: 'no', articleId: 'article-2', modelId: 'model-1', promptId: 'prompt-2'}),
      getMockLlmJudgmentRow({answer: 'yes', articleId: 'article-2', modelId: 'model-2', promptId: 'prompt-1'}),
      getMockLlmJudgmentRow({answer: 'no', articleId: 'article-2', modelId: 'model-2', promptId: 'prompt-2'}),
    ],
    failPromptInsert: false,
    promptLinks: [
      {
        criteriaDisposition: 'include',
        criteriaSectionKey: 'population',
        criteriaSectionLabel: 'Population',
        id: 'comparison-project-prompt-1',
        order: 0,
        promptId: 'prompt-1',
      },
      {
        criteriaDisposition: 'exclude',
        criteriaSectionKey: 'outcome',
        criteriaSectionLabel: 'Outcome',
        id: 'comparison-project-prompt-2',
        order: 1,
        promptId: 'prompt-2',
      },
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const multipleAnswersResponse = await postComparisonProjectJudgments(app, {
    limit: '50',
    page: '1',
    rowFilter: 'multiple-answers',
  })
  const fullyAnsweredResponse = await postComparisonProjectJudgments(app, {
    limit: '50',
    page: '1',
    rowFilter: 'fully-answered',
  })
  const allRowsWithDifferenceResponse = await postComparisonProjectJudgments(app, {
    differenceFilter: 'human-vs-llm',
    limit: '50',
    page: '1',
    rowFilter: 'all',
  })
  const [multipleAnswersTotalCount, fullyAnsweredTotalCount, allRowsWithDifferenceTotalCount] = await Promise.all(
    [multipleAnswersResponse, fullyAnsweredResponse, allRowsWithDifferenceResponse].map(
      getComparisonProjectJudgmentsTotalCount,
    ),
  )

  expect(multipleAnswersResponse.status).toBe(200)
  expect(fullyAnsweredResponse.status).toBe(200)
  expect(allRowsWithDifferenceResponse.status).toBe(200)
  expect(multipleAnswersTotalCount).toBe(2)
  expect(fullyAnsweredTotalCount).toBe(1)
  expect(allRowsWithDifferenceTotalCount).toBe(1)
})

test('comparison export filters match judgments endpoint row and difference filters', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: false,
      humanJudgmentMode: 'prompt',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: null,
    },
    extraLlmRows: [
      getMockLlmJudgmentRow({answer: 'yes', articleId: 'article-2', modelId: 'model-1', promptId: 'prompt-1'}),
      getMockLlmJudgmentRow({answer: 'yes', articleId: 'article-2', modelId: 'model-1', promptId: 'prompt-2'}),
    ],
    failPromptInsert: false,
    promptLinks: [
      {id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'},
      {id: 'comparison-project-prompt-2', order: 1, promptId: 'prompt-2'},
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const multipleAnswerTitles = await getComparisonProjectExportAndJudgmentTitles(app, {
    differenceFilter: 'all',
    rowFilter: 'multiple-answers',
  })
  const fullyAnsweredTitles = await getComparisonProjectExportAndJudgmentTitles(app, {
    differenceFilter: 'all',
    rowFilter: 'fully-answered',
  })
  const llmDifferenceTitles = await getComparisonProjectExportAndJudgmentTitles(app, {
    differenceFilter: 'llm-vs-llm',
    rowFilter: 'all',
  })

  expect(multipleAnswerTitles).toEqual(['Article 1', 'Article 2'])
  expect(fullyAnsweredTitles).toEqual(['Article 1'])
  expect(llmDifferenceTitles).toEqual(['Article 1'])
})

test('prompt comparison judgments keep legacy prompt columns and human prompt answers', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: true,
      humanJudgmentMode: null,
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: null,
    },
    failPromptInsert: false,
    promptLinks: [
      {id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'},
      {id: 'comparison-project-prompt-2', order: 1, promptId: 'prompt-2'},
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const metadataResponse = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1'),
  )
  const metadataBody = (await metadataResponse.json()) as {
    data: {
      columns: Array<{id: string; kind: string; promptId: string; promptLabel: string}>
      humanJudgmentMode: string
      summarySourceProjectId: string | null
    }
  }
  const judgmentsResponse = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/judgments', {
      body: JSON.stringify({differenceFilter: 'llm-vs-llm', limit: '50', page: '1', rowFilter: 'fully-answered'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const judgmentsBody = (await judgmentsResponse.json()) as {
    data: {
      data: Array<{articleSummary: string | null; cells: Record<string, string | null>; id: string}>
      totalCount: number
    }
  }
  const [row] = judgmentsBody.data.data
  const state = getMockDatabaseState()

  expect(metadataResponse.status).toBe(200)
  expect(metadataBody.data.humanJudgmentMode).toBe('prompt')
  expect(metadataBody.data.summarySourceProjectId).toBeNull()
  expect(
    metadataBody.data.columns.map((column) => {
      return column.promptId
    }),
  ).toEqual(['prompt-1', 'prompt-1', 'prompt-2', 'prompt-2', 'prompt-1', 'prompt-2'])
  expect(judgmentsResponse.status).toBe(200)
  expect(judgmentsBody.data.totalCount).toBe(1)
  expect(row?.cells['llm:model-1:1100:prompt-1']).toBe('yes')
  expect(row?.cells['llm:model-2:1100:prompt-2']).toBe('no')
  expect(row?.cells['human:prompt-1']).toBe('yes')
  expect(row?.cells['human:prompt-2']).toBe('no')
  expect(
    state.queryStatements.some((statement) => {
      return statement.includes('FROM app.judgment_human_summary')
    }),
  ).toBe(false)
})

test('comparison project export streams ordered csv rows with article context and flattened answers', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: true,
      humanJudgmentMode: 'prompt',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: null,
    },
    extraLlmRows: [
      {
        ...getMockLlmJudgmentRow({answer: 'yes', articleId: 'article-1', modelId: 'model-1', promptId: 'prompt-1'}),
        answeredOriginal: null,
        answeredOriginalAsArray: ['yes', 'maybe'],
        createdAt: new Date('2026-04-02T00:00:00.000Z'),
      },
    ],
    failPromptInsert: false,
    promptLinks: [
      {id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'},
      {id: 'comparison-project-prompt-2', order: 1, promptId: 'prompt-2'},
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await postComparisonProjectExport(app, {differenceFilter: 'all', rowFilter: 'fully-answered'})
  const csv = await response.text()
  const state = getMockDatabaseState()

  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type') ?? '').toContain('text/csv')
  expect(response.headers.get('Content-Disposition') ?? '').toContain('Rollback_test_project_comparison_export_')
  expect(csv.trim().split('\n')).toEqual([
    [
      'Title',
      'Abstract/Summary',
      'Date added',
      'Prompt 1 - Model 1 - Article Title and Abstract',
      'Prompt 1 - Model 2 - Article Title and Abstract',
      'Prompt 1 - Human',
      'Prompt 2 - Model 1 - Article Title and Abstract',
      'Prompt 2 - Model 2 - Article Title and Abstract',
      'Prompt 2 - Human',
    ].join(','),
    ['Article 1', 'Article 1 summary', '2026-03-30T00:00:00.000Z', 'yes; maybe', 'yes', 'yes', 'yes', 'no', 'no'].join(
      ',',
    ),
  ])
  expect(
    state.queryStatements.some((statement) => {
      return (
        statement.includes('FROM app.article a')
        && statement.includes('ORDER BY a.article_created_at DESC, a.article_title ASC, a.id ASC')
        && statement.includes('LIMIT 500')
        && statement.includes('OFFSET 0')
      )
    }),
  ).toBe(true)
})

test('summary comparison project export streams synthetic summary csv columns', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: true,
      humanJudgmentMode: 'summary',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: 'source-project-1',
    },
    failPromptInsert: false,
    promptLinks: [
      {
        criteriaDisposition: 'include',
        criteriaSectionKey: 'population',
        criteriaSectionLabel: 'Population',
        id: 'comparison-project-prompt-1',
        order: 0,
        promptId: 'prompt-1',
      },
      {
        criteriaDisposition: 'exclude',
        criteriaSectionKey: 'outcome',
        criteriaSectionLabel: 'Outcome',
        id: 'comparison-project-prompt-2',
        order: 1,
        promptId: 'prompt-2',
      },
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await postComparisonProjectExport(app, {differenceFilter: 'llm-vs-llm', rowFilter: 'fully-answered'})
  const csv = await response.text()

  expect(response.status).toBe(200)
  expect(csv.trim().split('\n')).toEqual([
    [
      'Title',
      'Abstract/Summary',
      'Date added',
      'Overall decision - Model 1 - Article Title and Abstract',
      'Overall decision - Model 2 - Article Title and Abstract',
      'Summary Source - Overall decision - Human',
    ].join(','),
    ['Article 1', 'Article 1 summary', '2026-03-30T00:00:00.000Z', 'no', 'yes', 'maybe'].join(','),
  ])
})

test('comparison project export allows archived projects without writes', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      archived: true,
      compareWithHumans: false,
      humanJudgmentMode: 'prompt',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: null,
    },
    failPromptInsert: false,
    promptLinks: [
      {id: 'comparison-project-prompt-1', order: 0, promptId: 'prompt-1'},
      {id: 'comparison-project-prompt-2', order: 1, promptId: 'prompt-2'},
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const response = await postComparisonProjectExport(app, {rowFilter: 'multiple-answers'})
  const csv = await response.text()
  const state = getMockDatabaseState()

  expect(response.status).toBe(200)
  expect(csv).toContain('Article 1,Article 1 summary,2026-03-30T00:00:00.000Z')
  expect(csv.trim().split('\n')[0]?.split(',').slice(0, 3)).toEqual(['Title', 'Abstract/Summary', 'Date added'])
  expect(csv.trim().split('\n')[1]?.split(',').slice(0, 3)).toEqual([
    'Article 1',
    'Article 1 summary',
    '2026-03-30T00:00:00.000Z',
  ])
  expect(state.transactionCalls).toBe(0)
  expect(state.rootRunStatements).toEqual([])
})

test('summary comparison judgments use synthetic summary columns and derived cells', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: true,
      humanJudgmentMode: 'summary',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: 'source-project-1',
    },
    failPromptInsert: false,
    promptLinks: [
      {
        criteriaDisposition: 'include',
        criteriaSectionKey: 'population',
        criteriaSectionLabel: 'Population',
        id: 'comparison-project-prompt-1',
        order: 0,
        promptId: 'prompt-1',
      },
      {
        criteriaDisposition: 'exclude',
        criteriaSectionKey: 'outcome',
        criteriaSectionLabel: 'Outcome',
        id: 'comparison-project-prompt-2',
        order: 1,
        promptId: 'prompt-2',
      },
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const metadataResponse = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1'),
  )
  const metadataBody = (await metadataResponse.json()) as {
    data: {columns: Array<{id: string; promptId: string; promptLabel: string}>}
  }
  const judgmentsResponse = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/judgments', {
      body: JSON.stringify({differenceFilter: 'llm-vs-llm', limit: '50', page: '1', rowFilter: 'fully-answered'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const judgmentsBody = (await judgmentsResponse.json()) as {
    data: {
      data: Array<{articleSummary: string | null; cells: Record<string, string | null>; id: string}>
      totalCount: number
    }
  }
  const [row] = judgmentsBody.data.data
  const state = getMockDatabaseState()

  expect(metadataResponse.status).toBe(200)
  expect(
    metadataBody.data.columns.map((column) => {
      return column.promptId
    }),
  ).toEqual(['summary', 'summary', 'summary'])
  expect(metadataBody.data.columns[0]?.promptLabel).toBe('Overall decision')
  expect(judgmentsResponse.status).toBe(200)
  expect(judgmentsBody.data.totalCount).toBe(1)
  expect(row?.cells['llm:model-1:1100:summary']).toBe('no')
  expect(row?.cells['llm:model-2:1100:summary']).toBe('yes')
  expect(row?.cells['human:summary']).toBe('maybe')
  expect(row?.articleSummary).toBe('Article 1 summary')
  expect(
    state.queryStatements.some((statement) => {
      return (
        statement.includes('FROM app.article a')
        && statement.includes('article_title AS articleTitle')
        && statement.includes('article_summary AS articleSummary')
        && statement.includes('article_created_at AS articleCreatedAt')
        && statement.includes('ORDER BY a.article_created_at DESC, a.article_title ASC, a.id ASC')
        && statement.includes('LIMIT 500')
        && statement.includes('OFFSET 0')
      )
    }),
  ).toBe(true)
  expect(
    state.queryStatements.some((statement) => {
      return (
        statement.includes('FROM app.article a')
        && statement.includes("pa.project_id IN ('source-project-1')")
        && statement.includes("air.import_route_id IN ('import-route-1')")
      )
    }),
  ).toBe(true)
  expect(
    state.queryStatements.some((statement) => {
      return (
        statement.includes('FROM app.judgment_human_summary') && statement.includes("project_id = 'source-project-1'")
      )
    }),
  ).toBe(true)
})

test('summary comparison judgments scope to explicit source project links when available', async () => {
  mockDatabaseStateRef.current = {
    ...createMockDatabaseState(),
    comparisonProject: {
      compareWithHumans: true,
      humanJudgmentMode: 'summary',
      id: 'comparison-project-1',
      modelIds: ['model-1', 'model-2'],
      summarySourceProjectId: 'source-project-1',
    },
    failPromptInsert: false,
    promptLinks: [
      {
        criteriaDisposition: 'include',
        criteriaSectionKey: 'population',
        criteriaSectionLabel: 'Population',
        id: 'comparison-project-prompt-1',
        order: 0,
        promptId: 'prompt-1',
      },
      {
        criteriaDisposition: 'exclude',
        criteriaSectionKey: 'outcome',
        criteriaSectionLabel: 'Outcome',
        id: 'comparison-project-prompt-2',
        order: 1,
        promptId: 'prompt-2',
      },
    ],
    routeLinks: [
      {id: 'comparison-project-route-1', importRouteId: 'import-route-1'},
      {id: 'comparison-project-route-2', importRouteId: 'import-route-2'},
    ],
    sourceProjectLinks: [
      {id: 'comparison-project-source-1', sourceProjectId: 'source-project-1'},
      {id: 'comparison-project-source-2', sourceProjectId: 'source-project-2'},
    ],
  }

  const {comparisonProjectsRoutes} = await loadComparisonProjectsRoutes()
  const app = new Elysia().use(comparisonProjectsRoutes)
  const judgmentsResponse = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/judgments', {
      body: JSON.stringify({differenceFilter: 'llm-vs-llm', limit: '50', page: '1', rowFilter: 'fully-answered'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const judgmentsBody = (await judgmentsResponse.json()) as {
    data: {data: Array<{cells: Record<string, string | null>}>; totalCount: number}
  }
  const [row] = judgmentsBody.data.data
  const state = getMockDatabaseState()

  expect(judgmentsResponse.status).toBe(200)
  expect(judgmentsBody.data.totalCount).toBe(1)
  expect(row?.cells['llm:source-project-1:model-1:1100:summary']).toBe('no')
  expect(row?.cells['llm:source-project-2:model-2:1100:summary']).toBe('yes')
  expect(row?.cells['human:summary']).toBe('maybe')
  expect(
    state.queryStatements.some((statement) => {
      return (
        statement.includes('FROM app.article a')
        && statement.includes("pa.project_id IN ('source-project-1', 'source-project-2')")
        && !statement.includes('air.import_route_id IN')
      )
    }),
  ).toBe(true)
})

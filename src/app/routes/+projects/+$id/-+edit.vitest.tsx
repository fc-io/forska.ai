// @vitest-environment happy-dom

import {createMemoryHistory} from '@tanstack/history'
import {QueryClient} from '@tanstack/solid-query'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {routeErrorSurfaceTestId} from '../../../routerErrorSurface'
import {createBrowserFailureAssertions} from '../../../utils/browserFailureAssertions'

type MockProjectAccess = {archived: boolean; id: string; name: string}
type MockProjectDetails = {
  hasJudgedArticles: boolean
  importRouteNamesByRoute: Record<string, string | null>
  importRoutes: string[]
  model: {id: string; modelName: string | null; name: string; provider: string | null; version: string | null} | null
  project: {
    dateFrom: string | null
    dateTo: string | null
    description: string | null
    name: string
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useTitle: boolean
  }
  prompts: Array<{
    archived: boolean
    createdAt?: string | null
    enabled?: boolean
    id: string
    order: number
    originalText: string
    originProjectId?: string | null
    linkedToProject?: boolean
    promptArchived?: boolean
    promptHeading: string | null
    type: string | null
  }>
}

const mockState = vi.hoisted(() => {
  return {
    apiCallCounts: {
      importRoutes: 0,
      modelEnsure: 0,
      models: 0,
      projectAccess: 0,
      projectDetails: 0,
      providerConnections: 0,
    },
    editPatchResponse: null as {data?: unknown; error?: unknown; status?: number} | null,
    editPayloads: [] as unknown[],
    importRoutes: [] as Array<{name: string | null; route: string}>,
    models: [
      {
        id: 'model-1',
        label: 'GPT Test',
        modelName: 'gpt-test',
        name: 'GPT Test',
        provider: 'openai-compatible',
        version: null,
      },
    ],
    projectAccessById: {} as Record<string, MockProjectAccess>,
    projectDetailsById: {} as Record<string, MockProjectDetails>,
    providerConnectionsPayload: {
      catalog: [],
      connections: [],
      runtime: {activeModelNames: [], providerKind: null, sourceMetadata: null, workerUrls: []},
    },
  }
})

const buildProjectAccess = (projectId: string): MockProjectAccess => {
  return {archived: false, id: projectId, name: 'Test Project'}
}

const buildProjectDetails = (projectId: string): MockProjectDetails => {
  return {
    hasJudgedArticles: false,
    importRouteNamesByRoute: {},
    importRoutes: [],
    model: {id: 'model-1', modelName: 'gpt-test', name: 'GPT Test', provider: 'openai-compatible', version: null},
    project: {
      dateFrom: null,
      dateTo: null,
      description: `Description for ${projectId}`,
      name: `Project ${projectId}`,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    },
    prompts: [
      {
        archived: false,
        createdAt: null,
        enabled: true,
        id: 'prompt-1',
        order: 1,
        originalText: 'Prompt body',
        originProjectId: null,
        linkedToProject: true,
        promptArchived: false,
        promptHeading: 'Population Inclusion',
        type: "'yes' | 'no' | 'maybe'",
      },
    ],
  }
}

const getProjectAccess = (projectId: string) => {
  return mockState.projectAccessById[projectId] ?? buildProjectAccess(projectId)
}

const getProjectDetails = (projectId: string) => {
  return mockState.projectDetailsById[projectId] ?? buildProjectDetails(projectId)
}

const waitForUpdates = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
}

const resetApiCallCounts = () => {
  mockState.apiCallCounts = {
    importRoutes: 0,
    modelEnsure: 0,
    models: 0,
    projectAccess: 0,
    projectDetails: 0,
    providerConnections: 0,
  }
  mockState.editPatchResponse = null
  mockState.editPayloads = []
}

const setFormValue = (element: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  expect(element).not.toBeNull()
  if (!element) {
    return
  }
  element.value = value
  element.dispatchEvent(new Event('input', {bubbles: true}))
}

const expectNoEditRouteFetches = () => {
  expect(mockState.apiCallCounts.projectAccess).toBe(0)
  expect(mockState.apiCallCounts.projectDetails).toBe(0)
  expect(mockState.apiCallCounts.models).toBe(0)
  expect(mockState.apiCallCounts.providerConnections).toBe(0)
  expect(mockState.apiCallCounts.importRoutes).toBe(0)
}

const seedEditRouteQueries = (queryClient: QueryClient, projectId: string) => {
  queryClient.setQueryData(['project', projectId, 'access'], getProjectAccess(projectId))
  queryClient.setQueryData(['project', projectId, 'with-prompts'], getProjectDetails(projectId))
  queryClient.setQueryData(['models'], mockState.models)
  queryClient.setQueryData(['provider-connections', 'project-edit', projectId], mockState.providerConnectionsPayload)
  queryClient.setQueryData(['import-routes'], mockState.importRoutes)
}

const seedCovidenceImportQueries = (queryClient: QueryClient) => {
  queryClient.setQueryData(['models', 'covidence-import'], mockState.models)
}

const loadFreshRouteContext = async (params: {editComponent?: () => unknown; includeCovidenceImport: boolean}) => {
  vi.resetModules()

  const [
    solidQueryModule,
    solidRouterModule,
    solidWebModule,
    queryClientModule,
    {Route: rootRouteImport},
    {Route: editRouteImport},
    covidenceRouteModule,
  ] = await Promise.all([
    import('@tanstack/solid-query'),
    import('@tanstack/solid-router'),
    import('solid-js/web'),
    import('../../../queryClient.ts'),
    import('../../+__root.tsx'),
    import('./+edit.tsx'),
    params.includeCovidenceImport ? import('../../+admin/+datasources/+covidence-import.tsx') : Promise.resolve(null),
  ])

  const editRoute = editRouteImport.update({
    ...(params.editComponent ? {component: params.editComponent} : {}),
    getParentRoute: () => {
      return rootRouteImport
    },
    id: '/projects/$id/edit',
    path: '/projects/$id/edit',
  } as never)

  const routeTree =
    params.includeCovidenceImport && covidenceRouteModule
      ? rootRouteImport.addChildren([
          covidenceRouteModule.Route.update({
            getParentRoute: () => {
              return rootRouteImport
            },
            id: '/admin/datasources/covidence-import',
            path: '/admin/datasources/covidence-import',
          } as never),
          editRoute,
        ])
      : rootRouteImport.addChildren([editRoute])

  return {
    appQueryClient: queryClientModule.appQueryClient,
    routeTree,
    solidQueryModule,
    solidRouterModule,
    solidWebModule,
  }
}

const mountRouterAtPath = async (params: {
  path: string
  queryClient: QueryClient
  routeTree: unknown
  solidQueryModule: typeof import('@tanstack/solid-query')
  solidRouterModule: typeof import('@tanstack/solid-router')
  solidWebModule: typeof import('solid-js/web')
}) => {
  const {QueryClientProvider} = params.solidQueryModule
  const {createRouter, RouterProvider} = params.solidRouterModule
  const {render} = params.solidWebModule

  const router = createRouter({
    defaultPendingComponent: () => {
      return null
    },
    defaultPendingMinMs: 0,
    history: createMemoryHistory({initialEntries: [params.path]}),
    routeTree: params.routeTree as never,
  })

  await router.load()

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={params.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
  }, container)

  await waitForUpdates()

  return {container, dispose, router}
}

vi.mock('../../../../components/Navigation.tsx', () => {
  return {
    Navigation: () => {
      return <div>Navigation</div>
    },
  }
})

vi.mock('../../../../services/apiClient.ts', () => {
  return {
    apiClient: {
      api: {
        'import-routes': {
          get: async () => {
            mockState.apiCallCounts.importRoutes += 1
            return {data: {data: mockState.importRoutes}}
          },
        },
        'provider-connections': {
          get: async () => {
            mockState.apiCallCounts.providerConnections += 1
            return {data: {data: mockState.providerConnectionsPayload}}
          },
        },
        models: {
          codex: {
            login: {
              get: async () => {
                return {data: {data: {done: true, modelId: 'model-1'}}}
              },
              post: async () => {
                return {data: {data: {jobId: 'codex-job-1'}}}
              },
            },
            status: {
              get: async () => {
                return {data: {data: {connected: true}}}
              },
            },
          },
          ensure: {
            post: async () => {
              mockState.apiCallCounts.modelEnsure += 1
              return {data: {data: {modelId: 'model-1'}, error: null}}
            },
          },
          get: async () => {
            mockState.apiCallCounts.models += 1
            return {data: {data: mockState.models}}
          },
        },
        projects: ({id}: {id: string}) => {
          return {
            access: {
              get: async () => {
                mockState.apiCallCounts.projectAccess += 1
                return {data: {data: getProjectAccess(id)}}
              },
            },
            clone: {
              post: async () => {
                return {data: {data: {id: `${id}-clone`}}}
              },
            },
            delete: async () => {
              return {data: {success: true}}
            },
            get: async () => {
              mockState.apiCallCounts.projectDetails += 1
              return {data: {data: getProjectDetails(id)}}
            },
            edit: {
              patch: async (payload: unknown) => {
                mockState.editPayloads.push(payload)
                if (mockState.editPatchResponse) {
                  return mockState.editPatchResponse
                }
                const details = getProjectDetails(id)
                return {data: {data: {project: details.project, prompts: details.prompts}}}
              },
            },
            patch: async () => {
              return {data: {data: getProjectDetails(id)}}
            },
            unarchive: {
              post: async () => {
                return {data: {success: true}}
              },
            },
          }
        },
      },
    },
  }
})

describe('project edit route regressions', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    resetApiCallCounts()
    mockState.importRoutes = []
    mockState.models = [
      {
        id: 'model-1',
        label: 'GPT Test',
        modelName: 'gpt-test',
        name: 'GPT Test',
        provider: 'openai-compatible',
        version: null,
      },
    ]
    mockState.projectAccessById = {}
    mockState.projectDetailsById = {}
    mockState.providerConnectionsPayload = {
      catalog: [],
      connections: [],
      runtime: {activeModelNames: [], providerKind: null, sourceMetadata: null, workerUrls: []},
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('project edit route keeps using the shared singleton query client boundary', async () => {
    const projectId = 'project-smoke-test'
    const routeContext = await loadFreshRouteContext({includeCovidenceImport: false})
    const queryClient = routeContext.appQueryClient
    const providerQueryClient = new QueryClient()
    const browserFailures = createBrowserFailureAssertions(window)

    queryClient.clear()
    seedEditRouteQueries(queryClient, projectId)

    const {container, dispose} = await mountRouterAtPath({
      path: `/projects/${projectId}/edit`,
      queryClient: providerQueryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      const text = container.textContent ?? ''
      const projectNameInput = container.querySelector<HTMLInputElement>('#project-name')

      expect(text).toContain('Edit Project')
      expect(text).toContain('Project Name')
      expect(projectNameInput?.value).toBe(`Project ${projectId}`)
      expectNoEditRouteFetches()
      browserFailures.assertNoFailures()
    } finally {
      browserFailures.dispose()
      queryClient.clear()
      providerQueryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('judged project edit keeps metadata and prompts editable while locking judgment settings', async () => {
    const projectId = 'project-partial-lock-test'
    const routeContext = await loadFreshRouteContext({includeCovidenceImport: false})
    const queryClient = routeContext.appQueryClient
    const providerQueryClient = new QueryClient()
    const browserFailures = createBrowserFailureAssertions(window)

    mockState.importRoutes = [{name: 'Locked Route', route: 'locked-route'}]
    mockState.projectDetailsById[projectId] = {
      ...buildProjectDetails(projectId),
      hasJudgedArticles: true,
      importRoutes: ['locked-route'],
    }
    queryClient.clear()
    seedEditRouteQueries(queryClient, projectId)

    const {container, dispose} = await mountRouterAtPath({
      path: `/projects/${projectId}/edit`,
      queryClient: providerQueryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      const text = container.textContent ?? ''
      const modelSelect = container.querySelector<HTMLSelectElement>('#model')
      const projectNameInput = container.querySelector<HTMLInputElement>('#project-name')
      const descriptionInput = container.querySelector<HTMLTextAreaElement>('#description')
      const dateInput = container.querySelector<HTMLInputElement>('input[placeholder="YYYY-MM-DD"]')
      const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      const routeCheckbox = checkboxes[0]
      const headingInput = container.querySelector<HTMLInputElement>(
        'input[placeholder="Prompt 1 heading (optional)..."]',
      )
      const typeInput = container.querySelector<HTMLInputElement>('input[placeholder="Prompt 1 type (optional)..."]')
      const orderInput = container.querySelector<HTMLInputElement>('input[type="number"]')
      const textareas = Array.from(container.querySelectorAll<HTMLTextAreaElement>('textarea'))
      const addPromptButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => {
        return button.textContent?.includes('+ Add Prompt')
      })
      const removePromptButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => {
        return button.textContent?.includes('×')
      })
      const submitButton = container.querySelector<HTMLButtonElement>('button[type="submit"]')

      expect(text).toContain('Judgment Settings Locked')
      expect(text).not.toContain('Project Locked for Editing')
      expect(modelSelect?.disabled).toBe(true)
      expect(routeCheckbox?.disabled).toBe(true)
      expect(
        checkboxes.every((checkbox) => {
          return checkbox.disabled
        }),
      ).toBe(true)
      expect(dateInput?.disabled).toBe(true)
      expect(projectNameInput?.disabled).toBe(false)
      expect(descriptionInput?.disabled).toBe(false)
      expect(headingInput?.disabled).toBe(false)
      expect(typeInput?.disabled).toBe(false)
      expect(orderInput?.disabled).toBe(false)
      expect(textareas[1]?.disabled).toBe(false)
      expect(addPromptButton?.disabled).toBe(false)
      expect(removePromptButton?.disabled).toBe(false)
      expect(submitButton?.disabled).toBe(false)
      browserFailures.assertNoFailures()
    } finally {
      browserFailures.dispose()
      queryClient.clear()
      providerQueryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('judged project submit omits protected settings and skips model ensure', async () => {
    const projectId = 'project-restricted-submit-test'
    const routeContext = await loadFreshRouteContext({includeCovidenceImport: false})
    const queryClient = routeContext.appQueryClient
    const providerQueryClient = new QueryClient()

    mockState.importRoutes = [{name: 'Restricted Route', route: 'restricted-route'}]
    mockState.projectDetailsById[projectId] = {
      ...buildProjectDetails(projectId),
      hasJudgedArticles: true,
      importRoutes: ['restricted-route'],
    }
    queryClient.clear()
    seedEditRouteQueries(queryClient, projectId)

    const {container, dispose} = await mountRouterAtPath({
      path: `/projects/${projectId}/edit`,
      queryClient: providerQueryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      const form = container.querySelector<HTMLFormElement>('form')

      form?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
      await waitForUpdates()

      const payload = mockState.editPayloads[0] as Record<string, unknown>

      expect(mockState.apiCallCounts.modelEnsure).toBe(0)
      expect(payload.name).toBe(`Project ${projectId}`)
      expect(payload.description).toBe(`Description for ${projectId}`)
      expect(Array.isArray(payload.prompts)).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(payload, 'modelId')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(payload, 'dateFrom')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(payload, 'dateTo')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(payload, 'importRoutes')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(payload, 'useTitle')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(payload, 'useAbstract')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(payload, 'useFulltext')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(payload, 'useFulltextNoImages')).toBe(false)
    } finally {
      queryClient.clear()
      providerQueryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('judged project submit includes cleared prompt heading and type', async () => {
    const projectId = 'project-cleared-prompt-meta-test'
    const routeContext = await loadFreshRouteContext({includeCovidenceImport: false})
    const queryClient = routeContext.appQueryClient
    const providerQueryClient = new QueryClient()

    mockState.projectDetailsById[projectId] = {...buildProjectDetails(projectId), hasJudgedArticles: true}
    queryClient.clear()
    seedEditRouteQueries(queryClient, projectId)

    const {container, dispose} = await mountRouterAtPath({
      path: `/projects/${projectId}/edit`,
      queryClient: providerQueryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      const form = container.querySelector<HTMLFormElement>('form')
      const headingInput = container.querySelector<HTMLInputElement>(
        'input[placeholder="Prompt 1 heading (optional)..."]',
      )
      const typeInput = container.querySelector<HTMLInputElement>('input[placeholder="Prompt 1 type (optional)..."]')

      setFormValue(headingInput, '')
      setFormValue(typeInput, '')
      form?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
      await waitForUpdates()

      const payload = mockState.editPayloads[0] as Record<string, unknown>
      const prompts = payload.prompts as Array<Record<string, unknown>>
      const prompt = prompts[0]

      expect(Object.prototype.hasOwnProperty.call(prompt, 'promptHeading')).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(prompt, 'type')).toBe(true)
      expect(prompt?.promptHeading).toBe('')
      expect(prompt?.type).toBe('')
    } finally {
      queryClient.clear()
      providerQueryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('judged project unsafe prompt edit 409 is surfaced to the user', async () => {
    const projectId = 'project-unsafe-prompt-edit-test'
    const routeContext = await loadFreshRouteContext({includeCovidenceImport: false})
    const queryClient = routeContext.appQueryClient
    const providerQueryClient = new QueryClient()

    mockState.editPatchResponse = {
      data: {error: {message: 'Pause or drain the judgment job before editing prompts.'}},
      status: 409,
    }
    mockState.projectDetailsById[projectId] = {...buildProjectDetails(projectId), hasJudgedArticles: true}
    queryClient.clear()
    seedEditRouteQueries(queryClient, projectId)

    const {container, dispose} = await mountRouterAtPath({
      path: `/projects/${projectId}/edit`,
      queryClient: providerQueryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      const form = container.querySelector<HTMLFormElement>('form')

      form?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
      await waitForUpdates()

      expect(container.textContent ?? '').toContain('Pause or drain the judgment job before editing prompts.')
    } finally {
      queryClient.clear()
      providerQueryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('judged project prompt cleanup summary renders rerun guidance', async () => {
    const projectId = 'project-cleanup-summary-test'
    const routeContext = await loadFreshRouteContext({includeCovidenceImport: false})
    const queryClient = routeContext.appQueryClient
    const providerQueryClient = new QueryClient()
    const details = {...buildProjectDetails(projectId), hasJudgedArticles: true}

    mockState.projectDetailsById[projectId] = details
    mockState.editPatchResponse = {
      data: {
        data: {
          project: details.project,
          promptCleanupSummary: {
            changedPromptLinks: [{newPromptId: 'prompt-new', oldPromptId: 'prompt-old', projectPromptId: 'link-1'}],
            deletedHumanPromptAnswers: 2,
            keptSharedLlmJudgments: 3,
            skippedComparisonPromptReferencedJudgments: 4,
            softDeletedLlmJudgments: 5,
          },
          prompts: details.prompts,
        },
      },
    }
    queryClient.clear()
    seedEditRouteQueries(queryClient, projectId)

    const {container, dispose} = await mountRouterAtPath({
      path: `/projects/${projectId}/edit`,
      queryClient: providerQueryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      const form = container.querySelector<HTMLFormElement>('form')

      form?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
      await waitForUpdates()

      const text = container.textContent ?? ''

      expect(text).toContain('Prompt Changes Saved')
      expect(text).toContain('Start Job Clean')
      expect(text).toContain('Changed prompt links: 1')
      expect(text).toContain('Deleted human answers: 2')
      expect(text).toContain('Soft-deleted LLM judgments: 5')
      expect(text).toContain('Kept shared LLM judgments: 3')
      expect(text).toContain('Kept comparison judgments: 4')
    } finally {
      queryClient.clear()
      providerQueryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('navigating from Covidence import to project edit renders without query client crashes', async () => {
    const projectId = 'project-navigation-test'
    const routeContext = await loadFreshRouteContext({includeCovidenceImport: true})
    const queryClient = routeContext.appQueryClient
    const providerQueryClient = new QueryClient()
    const browserFailures = createBrowserFailureAssertions(window)

    queryClient.clear()
    seedCovidenceImportQueries(queryClient)
    seedEditRouteQueries(queryClient, projectId)

    const {container, dispose, router} = await mountRouterAtPath({
      path: '/admin/datasources/covidence-import',
      queryClient: providerQueryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      expect(container.textContent ?? '').toContain('Covidence multi-file import')
      resetApiCallCounts()

      await router.navigate({params: {id: projectId} as never, to: '/projects/$id/edit'})
      await waitForUpdates()

      const text = container.textContent ?? ''
      const projectNameInput = container.querySelector<HTMLInputElement>('#project-name')

      expect(text).toContain('Edit Project')
      expect(text).toContain('Project Name')
      expect(projectNameInput?.value).toBe(`Project ${projectId}`)
      expectNoEditRouteFetches()
      browserFailures.assertNoFailures()
    } finally {
      browserFailures.dispose()
      queryClient.clear()
      providerQueryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('Covidence import refetches models when mounting with cached options', async () => {
    const routeContext = await loadFreshRouteContext({includeCovidenceImport: true})
    const providerQueryClient = new QueryClient()
    const browserFailures = createBrowserFailureAssertions(window)

    providerQueryClient.setQueryData(
      ['models', 'covidence-import'],
      [
        {
          id: 'model-stale',
          label: 'Stale Model',
          modelName: 'stale-model',
          name: 'Stale Model',
          provider: 'openai-compatible',
          version: null,
        },
      ],
    )
    mockState.models = [
      {
        id: 'model-fresh',
        label: 'Fresh Model',
        modelName: 'fresh-model',
        name: 'Fresh Model',
        provider: 'openai-compatible',
        version: null,
      },
    ]
    resetApiCallCounts()

    const {container, dispose} = await mountRouterAtPath({
      path: '/admin/datasources/covidence-import',
      queryClient: providerQueryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      await waitForUpdates()

      expect(mockState.apiCallCounts.models).toBe(1)
      expect(container.textContent ?? '').toContain('Fresh Model')
      expect(container.textContent ?? '').not.toContain('Stale Model')
      browserFailures.assertNoFailures()
    } finally {
      browserFailures.dispose()
      providerQueryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('project edit path exposes a stable route error surface for render crashes', async () => {
    const projectId = 'project-route-error-test'
    const routeContext = await loadFreshRouteContext({
      editComponent: () => {
        throw new Error('project edit render crash')
      },
      includeCovidenceImport: false,
    })
    const queryClient = routeContext.appQueryClient

    queryClient.clear()

    const {container, dispose} = await mountRouterAtPath({
      path: `/projects/${projectId}/edit`,
      queryClient,
      routeTree: routeContext.routeTree,
      solidQueryModule: routeContext.solidQueryModule,
      solidRouterModule: routeContext.solidRouterModule,
      solidWebModule: routeContext.solidWebModule,
    })

    try {
      const routeErrorSurface = container.querySelector<HTMLElement>(`[data-testid="${routeErrorSurfaceTestId}"]`)

      expect(routeErrorSurface?.textContent ?? '').toContain('Route render failed')
      expect(routeErrorSurface?.textContent ?? '').toContain('project edit render crash')
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  })
})

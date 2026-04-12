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
    promptArchived?: boolean
    promptHeading: string | null
    type: string | null
  }>
}

const mockState = vi.hoisted(() => {
  return {
    apiCallCounts: {importRoutes: 0, models: 0, projectAccess: 0, projectDetails: 0, providerConnections: 0},
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
        promptArchived: false,
        promptHeading: 'Matches Population Inclusion',
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
  mockState.apiCallCounts = {importRoutes: 0, models: 0, projectAccess: 0, projectDetails: 0, providerConnections: 0}
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
  queryClient.setQueryData(['importroutes'], mockState.importRoutes)
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
        judgments: {
          model: {
            get: async () => {
              return {data: {data: {}}}
            },
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

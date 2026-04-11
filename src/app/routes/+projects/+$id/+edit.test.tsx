import {beforeEach, expect, mock, test} from 'bun:test'
import {createMemoryHistory} from '@tanstack/history'
import type {QueryClient} from '@tanstack/solid-query'
import GlobalWindow from 'happy-dom/lib/window/GlobalWindow.js'

const navigationModulePath = new URL('../../../../components/Navigation.tsx', import.meta.url).pathname
const apiClientModulePath = new URL('../../../../services/apiClient.ts', import.meta.url).pathname
const solidBrowserModulePath = new URL('../../../../../node_modules/solid-js/dist/dev.js', import.meta.url).pathname
const solidStoreBrowserModulePath = new URL('../../../../../node_modules/solid-js/store/dist/dev.js', import.meta.url)
  .pathname
const solidWebBrowserModulePath = new URL('../../../../../node_modules/solid-js/web/dist/dev.js', import.meta.url)
  .pathname

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

const mockState = {
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

const setGlobalValue = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, {configurable: true, value, writable: true})
}

const installDom = () => {
  const window = new GlobalWindow()

  setGlobalValue('window', window)
  setGlobalValue('document', window.document)
  setGlobalValue('self', window)
  setGlobalValue('navigator', window.navigator)
  setGlobalValue('location', window.location)
  setGlobalValue('history', window.history)
  setGlobalValue('Node', window.Node)
  setGlobalValue('Element', window.Element)
  setGlobalValue('HTMLElement', window.HTMLElement)
  setGlobalValue('HTMLAnchorElement', window.HTMLAnchorElement)
  setGlobalValue('HTMLButtonElement', window.HTMLButtonElement)
  setGlobalValue('HTMLDivElement', window.HTMLDivElement)
  setGlobalValue('HTMLInputElement', window.HTMLInputElement)
  setGlobalValue('HTMLSelectElement', window.HTMLSelectElement)
  setGlobalValue('HTMLTextAreaElement', window.HTMLTextAreaElement)
  setGlobalValue('SVGElement', window.SVGElement)
  setGlobalValue('Event', window.Event)
  setGlobalValue('EventTarget', window.EventTarget)
  setGlobalValue('CustomEvent', window.CustomEvent)
  setGlobalValue('KeyboardEvent', window.KeyboardEvent)
  setGlobalValue('MouseEvent', window.MouseEvent)
  setGlobalValue('PointerEvent', window.PointerEvent)
  setGlobalValue('FocusEvent', window.FocusEvent)
  setGlobalValue('MutationObserver', window.MutationObserver)
  setGlobalValue('requestAnimationFrame', window.requestAnimationFrame.bind(window))
  setGlobalValue('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
  setGlobalValue('getComputedStyle', window.getComputedStyle.bind(window))

  return window
}

const waitForUpdates = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
}

const buildQueryClient = async (): Promise<QueryClient> => {
  const {QueryClient} = await import('@tanstack/solid-query')

  return new QueryClient({defaultOptions: {queries: {retry: false, refetchOnWindowFocus: false, suspense: false}}})
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

const loadFreshRouteTree = async (includeCovidenceImport: boolean) => {
  const suffix = `?test=${Date.now()}-${Math.random()}`
  const [{createFileRoute}, {Route: rootRouteImport}, {Route: editRouteImport}] = await Promise.all([
    import('@tanstack/solid-router'),
    import(new URL('../../+__root.tsx', import.meta.url).pathname + suffix),
    import(new URL('./+edit.tsx', import.meta.url).pathname + suffix),
  ])

  const editRoute = editRouteImport.update({
    getParentRoute: () => rootRouteImport,
    id: '/projects/$id/edit',
    path: '/projects/$id/edit',
  } as never)

  return includeCovidenceImport
    ? rootRouteImport.addChildren([
        createFileRoute('/admin/datasources/covidence-import')({component: () => 'Covidence multi-file import'}).update(
          {
            getParentRoute: () => rootRouteImport,
            id: '/admin/datasources/covidence-import',
            path: '/admin/datasources/covidence-import',
          } as never,
        ),
        editRoute,
      ])
    : rootRouteImport.addChildren([editRoute])
}

const mountRouterAtPath = async (params: {path: string; queryClient: QueryClient; routeTree: unknown}) => {
  const [{createComponent}, {QueryClientProvider}, {createRouter, RouterProvider}, {render}] = await Promise.all([
    import('solid-js'),
    import('@tanstack/solid-query'),
    import('@tanstack/solid-router'),
    import('solid-js/web'),
  ])

  const router = createRouter({
    defaultPendingComponent: () => null,
    defaultPendingMinMs: 0,
    history: createMemoryHistory({initialEntries: [params.path]}),
    routeTree: params.routeTree as never,
  })

  await router.load()

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return createComponent(QueryClientProvider, {
      client: params.queryClient,
      get children() {
        return createComponent(RouterProvider, {router})
      },
    })
  }, container)

  await waitForUpdates()

  return {container, dispose, router}
}

beforeEach(() => {
  installDom()
  document.body.innerHTML = ''
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

void mock.module('solid-js/web', async () => {
  return await import(solidWebBrowserModulePath)
})

void mock.module('solid-js', async () => {
  return await import(solidBrowserModulePath)
})

void mock.module('solid-js/store', async () => {
  return await import(solidStoreBrowserModulePath)
})

void mock.module(navigationModulePath, () => {
  return {Navigation: () => 'Navigation'}
})

void mock.module(apiClientModulePath, () => {
  return {
    apiClient: {
      api: {
        'import-routes': {
          get: async () => {
            return {data: {data: mockState.importRoutes}}
          },
        },
        'provider-connections': {
          get: async () => {
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
            return {data: {data: mockState.models}}
          },
        },
        projects: ({id}: {id: string}) => {
          return {
            access: {
              get: async () => {
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

test('project edit route renders inside the shared query client provider', async () => {
  const projectId = 'project-smoke-test'
  const queryClient = await buildQueryClient()
  const routeTree = await loadFreshRouteTree(false)

  seedEditRouteQueries(queryClient, projectId)

  const {container, dispose} = await mountRouterAtPath({path: `/projects/${projectId}/edit`, queryClient, routeTree})

  try {
    const text = container.textContent ?? ''

    expect(text).toContain('Edit Project')
    expect(text).toContain('Project Name')
    expect(text).toContain(`Project ${projectId}`)
  } finally {
    dispose()
    container.remove()
  }
})

test('navigating from Covidence import to project edit renders without query client crashes', async () => {
  const projectId = 'project-navigation-test'
  const queryClient = await buildQueryClient()
  const routeTree = await loadFreshRouteTree(true)

  seedCovidenceImportQueries(queryClient)
  seedEditRouteQueries(queryClient, projectId)

  const {container, dispose, router} = await mountRouterAtPath({
    path: '/admin/datasources/covidence-import',
    queryClient,
    routeTree,
  })

  try {
    expect(container.textContent ?? '').toContain('Covidence multi-file import')

    await router.navigate({params: {id: projectId} as never, to: '/projects/$id/edit'})
    await waitForUpdates()

    const text = container.textContent ?? ''

    expect(text).toContain('Edit Project')
    expect(text).toContain('Project Name')
    expect(text).toContain(`Project ${projectId}`)
  } finally {
    dispose()
    container.remove()
  }
})

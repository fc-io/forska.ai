// @vitest-environment happy-dom

import {createMemoryHistory} from '@tanstack/history'
import {QueryClient} from '@tanstack/solid-query'
import type {AnyRouter} from '@tanstack/solid-router'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {createBrowserFailureAssertions} from '../../utils/browserFailureAssertions'

type MockModel = {
  id: string
  label: string
  modelName: string | null
  name: string
  provider: string | null
  version: string | null
}

const mockState = vi.hoisted(() => {
  return {
    createPayloads: [] as unknown[],
    models: [] as MockModel[],
    providerConnectionsPayload: {
      catalog: [],
      connections: [],
      runtime: {activeModelNames: [], providerKind: null, sourceMetadata: null, workerUrls: []},
    },
  }
})

const buildModels = (): MockModel[] => {
  return [
    {
      id: 'model-1',
      label: 'GPT Test',
      modelName: 'gpt-test',
      name: 'GPT Test',
      provider: 'openai-compatible',
      version: null,
    },
  ]
}

const buildCreatedProject = (payload: unknown) => {
  const body = payload as Record<string, unknown>
  return {
    archived: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    dateFrom: null,
    dateTo: null,
    description: null,
    id: 'project-created',
    importRoutes: [],
    modelId: 'model-1',
    name: typeof body.name === 'string' ? body.name : '',
    useAbstract: body.useAbstract === true,
    useFulltext: body.useFulltext === true,
    useFulltextNoImages: body.useFulltextNoImages === true,
    useMetadata: body.useMetadata === true,
    useTitle: body.useTitle === true,
  }
}

const waitForUpdates = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
}

const setFormValue = (element: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  expect(element).not.toBeNull()
  if (!element) {
    return
  }
  element.value = value
  element.dispatchEvent(new Event('input', {bubbles: true}))
}

const getMetadataCheckbox = (container: HTMLElement) => {
  const label = Array.from(container.querySelectorAll<HTMLLabelElement>('label')).find((element) => {
    return element.textContent?.includes('Article metadata (journal, year, publication type)')
  })
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
}

const seedCreateRouteQueries = (queryClient: QueryClient) => {
  queryClient.setQueryData(['backend-availability'], {ready: true})
  queryClient.setQueryData(['import-routes'], [])
  queryClient.setQueryData(['models'], mockState.models)
  queryClient.setQueryData(['provider-connections', 'project-create'], mockState.providerConnectionsPayload)
  queryClient.setQueryData(['prompts'], [])
}

const loadFreshRouteContext = async () => {
  vi.resetModules()

  const [solidQueryModule, solidRouterModule, solidWebModule, {Route: rootRouteImport}, {Route: createRouteImport}] =
    await Promise.all([
      import('@tanstack/solid-query'),
      import('@tanstack/solid-router'),
      import('solid-js/web'),
      import('../+__root.tsx'),
      import('./+create.tsx'),
    ])

  const createRoute = createRouteImport.update({
    getParentRoute: () => {
      return rootRouteImport
    },
    id: '/projects/create',
    path: '/projects/create',
  } as never)

  return {routeTree: rootRouteImport.addChildren([createRoute]), solidQueryModule, solidRouterModule, solidWebModule}
}

const mountCreateRoute = async () => {
  const routeContext = await loadFreshRouteContext()
  const {QueryClientProvider} = routeContext.solidQueryModule
  const {createRouter, RouterProvider} = routeContext.solidRouterModule
  const {render} = routeContext.solidWebModule
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})

  seedCreateRouteQueries(queryClient)

  const createAnyRouter = createRouter as (options: unknown) => AnyRouter
  const router = createAnyRouter({
    defaultPendingComponent: () => {
      return null
    },
    defaultPendingMinMs: 0,
    history: createMemoryHistory({initialEntries: ['/projects/create']}),
    routeTree: routeContext.routeTree,
  })

  await router.load()

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
  }, container)

  await waitForUpdates()

  return {container, dispose, queryClient}
}

const submitCreateForm = async (container: HTMLElement) => {
  const form = container.querySelector<HTMLFormElement>('form')
  setFormValue(container.querySelector<HTMLInputElement>('#project-name'), 'Metadata Project')
  await waitForUpdates()
  form?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
  await waitForUpdates()
  await waitForUpdates()
}

vi.mock('../../../components/Navigation.tsx', () => {
  return {
    Navigation: () => {
      return <div>Navigation</div>
    },
  }
})

vi.mock('../../../services/apiClient.ts', () => {
  return {
    apiClient: {
      api: {
        'import-routes': {
          get: async () => {
            return {data: {data: []}}
          },
        },
        'provider-connections': {
          get: async () => {
            return {data: {data: mockState.providerConnectionsPayload}}
          },
        },
        models: {
          get: async () => {
            return {data: {data: mockState.models}}
          },
        },
        projects: {
          post: async (payload: unknown) => {
            mockState.createPayloads.push(payload)
            return {data: {data: buildCreatedProject(payload)}}
          },
        },
        prompts: {
          get: async () => {
            return {data: {data: []}}
          },
        },
        runtime: {
          ready: {
            get: async () => {
              return {data: {data: {ready: true}}}
            },
          },
        },
      },
    },
  }
})

describe('project create route content flags', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    mockState.createPayloads = []
    mockState.models = buildModels()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('renders the article metadata checkbox unchecked by default', async () => {
    const browserFailures = createBrowserFailureAssertions(window)
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      const text = container.textContent ?? ''
      const metadataCheckbox = getMetadataCheckbox(container)

      expect(text).toContain('Create New Project')
      expect(text).toContain('Article Content Used')
      expect(metadataCheckbox).not.toBeNull()
      expect(metadataCheckbox?.checked).toBe(false)
      expect(metadataCheckbox?.disabled).toBe(false)
      browserFailures.assertNoFailures()
    } finally {
      browserFailures.dispose()
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('create submit sends useMetadata false by default', async () => {
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      await submitCreateForm(container)

      const payload = mockState.createPayloads[0] as Record<string, unknown>

      expect(mockState.createPayloads).toHaveLength(1)
      expect(payload.name).toBe('Metadata Project')
      expect(payload.modelId).toBe('model-1')
      expect(payload.useMetadata).toBe(false)
      expect(payload.useTitle).toBe(true)
      expect(payload.useAbstract).toBe(true)
      expect(payload.useFulltext).toBe(false)
      expect(payload.useFulltextNoImages).toBe(false)
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('create submit sends useMetadata true after checking the metadata checkbox', async () => {
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      const metadataCheckbox = getMetadataCheckbox(container)

      metadataCheckbox?.click()
      await waitForUpdates()
      expect(metadataCheckbox?.checked).toBe(true)

      await submitCreateForm(container)

      const payload = mockState.createPayloads[0] as Record<string, unknown>

      expect(mockState.createPayloads).toHaveLength(1)
      expect(payload.useMetadata).toBe(true)
      expect(payload.useFulltext).toBe(false)
      expect(payload.useFulltextNoImages).toBe(false)
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  })
})

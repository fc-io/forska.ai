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

type MockImportRoute = {name: string | null; route: string}

type MockPrompt = {
  createdAt: string | null
  id: string
  linkedToCovidenceProject?: boolean
  originalText: string
  promptHeading: string | null
  type: string | null
}

const mockState = vi.hoisted(() => {
  return {
    createPayloads: [] as unknown[],
    fullTextPreviewPayloads: [] as unknown[],
    fullTextValidationErrorsByModelId: {} as Record<string, string[]>,
    fullTextValidationWarnings: [] as string[],
    imageTransportsMissing: false,
    importRoutes: [] as MockImportRoute[],
    models: [] as MockModel[],
    prompts: [] as MockPrompt[],
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
    {
      id: 'model-small',
      label: 'Small Test',
      modelName: 'small-test',
      name: 'Small Test',
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

const modelLabelsById: Record<string, string> = {'model-1': 'GPT Test', 'model-small': 'Small Test'}

const getFullTextPreview = (payload: unknown) => {
  const body = payload as {
    fullTextChunkPolicy: {maxPromptTokens: number; mode: string} | null
    fullTextFigureMode: string | null
    modelId: string | null
    useFulltext: boolean
  }
  const modelLabel = body.modelId ? (modelLabelsById[body.modelId] ?? body.modelId) : null
  const modelAcceptsImages = body.modelId === 'model-1'
  const errors = [
    ...(mockState.fullTextValidationErrorsByModelId[body.modelId ?? ''] ?? []),
    body.fullTextFigureMode
      ? null
      : 'Full text needs a figure mode: choose Text only (figures reduced to their captions) or Include figures as images.',
    body.fullTextChunkPolicy
      ? null
      : 'Full text needs a chunk policy: choose 24k, 48k or 96k and single only or chunked.',
    body.fullTextFigureMode === 'native_images' && mockState.imageTransportsMissing
      ? 'Including figures as images needs image transports, which this build does not include yet. Choose Text only (figures reduced to their captions).'
      : null,
    body.fullTextFigureMode === 'native_images' && !modelAcceptsImages
      ? `Model ${modelLabel} cannot receive images. Choose Text only (figures reduced to their captions), or another model.`
      : null,
  ].filter((error): error is string => {
    return error !== null
  })

  const validationBase = {
    current: null,
    errors,
    modelAcceptsImages,
    modelLabel,
    recordStrategyOnSave: false,
    warnings: mockState.fullTextValidationWarnings,
  }

  return errors.length > 0
    ? {...validationBase, strategyId: null, strategyLabel: null}
    : {
        ...validationBase,
        strategyId: 'fts-0123456789abcdef',
        strategyLabel: `mineru 4.0.12 / ${body.fullTextFigureMode === 'native_images' ? 'native images' : 'none'} / ${body.fullTextChunkPolicy?.mode === 'chunked' ? 'chunked' : 'single'} ${(body.fullTextChunkPolicy?.maxPromptTokens ?? 0) / 1000}k`,
      }
}

const getFullTextCheckbox = (container: HTMLElement) => {
  return (
    container.querySelector<HTMLInputElement>('[data-testid="full-text-strategy-settings"] input[type="checkbox"]')
    ?? null
  )
}

const clickRadio = async (container: HTMLElement, name: string, value: string) => {
  const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`)
  expect(radio).not.toBeNull()
  radio?.click()
  await waitForUpdates()
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

const getDetailsBySummaryText = (container: HTMLElement, text: string) => {
  return (
    Array.from(container.querySelectorAll<HTMLDetailsElement>('details')).find((element) => {
      return element.querySelector('summary')?.textContent?.includes(text)
    }) ?? null
  )
}

const seedCreateRouteQueries = (queryClient: QueryClient) => {
  queryClient.setQueryData(['backend-availability'], {ready: true})
  queryClient.setQueryData(['import-routes'], mockState.importRoutes)
  queryClient.setQueryData(['models'], mockState.models)
  queryClient.setQueryData(['provider-connections', 'project-create'], mockState.providerConnectionsPayload)
  queryClient.setQueryData(['prompts'], mockState.prompts)
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
            return {data: {data: mockState.importRoutes}}
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
          'full-text-validation': {
            post: async (payload: unknown) => {
              mockState.fullTextPreviewPayloads.push(payload)
              return {data: {data: getFullTextPreview(payload)}}
            },
          },
          post: async (payload: unknown) => {
            mockState.createPayloads.push(payload)
            return {data: {data: buildCreatedProject(payload)}}
          },
        },
        prompts: {
          get: async () => {
            return {data: {data: mockState.prompts}}
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
    mockState.fullTextPreviewPayloads = []
    mockState.fullTextValidationErrorsByModelId = {}
    mockState.fullTextValidationWarnings = []
    mockState.imageTransportsMissing = false
    mockState.importRoutes = []
    mockState.models = buildModels()
    mockState.prompts = []
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
      expect(payload.fullTextFigureMode).toBeNull()
      expect(payload.fullTextChunkPolicy).toBeNull()
      expect(payload).not.toHaveProperty('useFulltextNoImages')
      expect(mockState.fullTextPreviewPayloads).toHaveLength(0)
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
      expect(payload).not.toHaveProperty('useFulltextNoImages')
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  })

  test('groups import routes under headings, data source group open, and submits the selected route', async () => {
    mockState.importRoutes = [
      {name: '/api/datasources/import/pubmed', route: '/api/datasources/import/pubmed'},
      {name: 'cov 6 | 3', route: 'covidence:route-1'},
      {name: 'cov 6 | 2', route: 'covidence:route-2'},
      {name: 'Uploaded file', route: 'imported-file:Uploaded file'},
    ]
    const browserFailures = createBrowserFailureAssertions(window)
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      const dataSourceGroup = getDetailsBySummaryText(container, 'Data source imports')
      const covidenceGroup = getDetailsBySummaryText(container, 'Covidence imports')
      const fileGroup = getDetailsBySummaryText(container, 'File imports')
      const covidenceSummary = covidenceGroup?.querySelector('summary')
      const covidenceCheckbox = covidenceGroup?.querySelector<HTMLInputElement>('input[type="checkbox"]')

      expect(container.textContent).not.toContain('Other imports')
      expect(container.textContent).not.toContain('Import Routes')
      expect(dataSourceGroup?.hasAttribute('open')).toBe(true)
      expect(covidenceGroup?.hasAttribute('open')).toBe(false)
      expect(fileGroup?.hasAttribute('open')).toBe(false)
      expect(dataSourceGroup?.querySelector('summary')?.textContent).toContain('0 of 1 selected')
      expect(covidenceSummary?.textContent).toContain('0 of 2 selected')
      expect(covidenceGroup?.textContent).toContain('covidence:route-1')
      expect(fileGroup?.textContent).not.toContain('imported-file:')

      covidenceCheckbox?.click()
      await waitForUpdates()

      expect(covidenceCheckbox?.checked).toBe(true)
      expect(covidenceSummary?.textContent).toContain('1 of 2 selected')
      expect(covidenceGroup?.hasAttribute('open')).toBe(false)

      await submitCreateForm(container)

      const payload = mockState.createPayloads[0] as Record<string, unknown>

      expect(mockState.createPayloads).toHaveLength(1)
      expect(payload.importRoutes).toEqual(['covidence:route-1'])
      browserFailures.assertNoFailures()
    } finally {
      browserFailures.dispose()
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('splits existing prompts into collapsed sections, Covidence project prompts apart', async () => {
    mockState.prompts = [
      {
        createdAt: '2026-10-01T00:00:00.000Z',
        id: 'prompt-1',
        originalText: 'First prompt text',
        promptHeading: 'First heading',
        type: 'inclusion',
      },
      {
        createdAt: '2026-09-01T00:00:00.000Z',
        id: 'prompt-2',
        originalText: 'Second prompt text',
        promptHeading: 'Second heading',
        type: null,
      },
      {
        createdAt: '2026-08-01T00:00:00.000Z',
        id: 'prompt-3',
        linkedToCovidenceProject: true,
        originalText: 'Third prompt text',
        promptHeading: 'Third heading',
        type: null,
      },
    ]
    const browserFailures = createBrowserFailureAssertions(window)
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      const regularSection = getDetailsBySummaryText(container, 'Existing prompts')
      const covidenceSection = getDetailsBySummaryText(container, 'Covidence project prompts')
      const regularSummary = regularSection?.querySelector('summary')
      const includeCheckbox = regularSection?.querySelector<HTMLInputElement>('input[type="checkbox"]')

      expect(container.querySelectorAll('details')).toHaveLength(2)
      expect(regularSection?.hasAttribute('open')).toBe(false)
      expect(covidenceSection?.hasAttribute('open')).toBe(false)
      expect(regularSummary?.textContent).toContain('0 of 2 selected')
      expect(covidenceSection?.querySelector('summary')?.textContent).toContain('0 of 1 selected')
      expect(regularSection?.textContent).toContain('First prompt text')
      expect(regularSection?.textContent).toContain('Second heading')
      expect(regularSection?.textContent).not.toContain('Third heading')
      expect(covidenceSection?.textContent).toContain('Third prompt text')

      includeCheckbox?.click()
      await waitForUpdates()

      expect(includeCheckbox?.checked).toBe(true)
      expect(regularSummary?.textContent).toContain('1 of 2 selected')
      expect(regularSection?.textContent).toContain('Selected')
      expect(regularSection?.hasAttribute('open')).toBe(false)
      expect(covidenceSection?.hasAttribute('open')).toBe(false)

      await submitCreateForm(container)

      const payload = mockState.createPayloads[0] as Record<string, unknown>

      expect(mockState.createPayloads).toHaveLength(1)
      expect(payload.existingPromptIds).toEqual([{order: 0, originalId: 'prompt-1'}])
      browserFailures.assertNoFailures()
    } finally {
      browserFailures.dispose()
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('full text shows figure mode and chunk policy selectors with nothing preselected and blocks submit', async () => {
    const browserFailures = createBrowserFailureAssertions(window)
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      const text = container.textContent ?? ''

      expect(text).not.toContain('Use Full Text (without images)')
      expect(text).not.toContain('Use Full Text (with images)')
      expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0)

      getFullTextCheckbox(container)?.click()
      await waitForUpdates()
      await waitForUpdates()

      const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'))

      expect(
        radios.map((radio) => {
          return `${radio.name}:${radio.value}`
        }),
      ).toEqual([
        'full-text-figure-mode:none',
        'full-text-figure-mode:native_images',
        'full-text-max-prompt-tokens:24000',
        'full-text-max-prompt-tokens:48000',
        'full-text-max-prompt-tokens:96000',
        'full-text-chunk-mode:single_only',
        'full-text-chunk-mode:chunked',
      ])
      expect(
        radios.some((radio) => {
          return radio.checked
        }),
      ).toBe(false)
      expect(container.querySelector('[data-testid="full-text-strategy-errors"]')?.textContent).toContain(
        'Full text needs a figure mode',
      )

      await submitCreateForm(container)

      expect(mockState.createPayloads).toHaveLength(0)
      expect(container.textContent).toContain(
        'Full text needs a figure mode: choose Text only (figures reduced to their captions) or Include figures as images. Full text needs a chunk policy',
      )
      browserFailures.assertNoFailures()
    } finally {
      browserFailures.dispose()
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('explicit full-text choices show the derived strategy and are sent on create', async () => {
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      getFullTextCheckbox(container)?.click()
      await waitForUpdates()
      await clickRadio(container, 'full-text-figure-mode', 'none')
      await clickRadio(container, 'full-text-max-prompt-tokens', '48000')
      await clickRadio(container, 'full-text-chunk-mode', 'chunked')
      await waitForUpdates()

      expect(container.querySelector('[data-testid="full-text-strategy-label"]')?.textContent).toBe(
        'mineru 4.0.12 / none / chunked 48k',
      )
      expect(container.querySelector('[data-testid="full-text-strategy-id"]')?.textContent).toBe('fts-0123456789abcdef')

      await submitCreateForm(container)

      const payload = mockState.createPayloads[0] as Record<string, unknown>

      expect(mockState.createPayloads).toHaveLength(1)
      expect(payload.useFulltext).toBe(true)
      expect(payload.fullTextFigureMode).toBe('none')
      expect(payload.fullTextChunkPolicy).toEqual({maxPromptTokens: 48_000, mode: 'chunked'})
      expect(payload).not.toHaveProperty('useFulltextNoImages')
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('a figure mode this build cannot serve shows the server reason instead of a strategy', async () => {
    mockState.imageTransportsMissing = true

    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      getFullTextCheckbox(container)?.click()
      await waitForUpdates()
      await clickRadio(container, 'full-text-figure-mode', 'native_images')
      await clickRadio(container, 'full-text-max-prompt-tokens', '24000')
      await clickRadio(container, 'full-text-chunk-mode', 'single_only')
      await waitForUpdates()

      expect(container.querySelector('[data-testid="full-text-strategy-errors"]')?.textContent).toContain(
        'Including figures as images needs image transports',
      )
      expect(container.querySelector('[data-testid="full-text-strategy-label"]')).toBeNull()
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)
  test('a gate error for the selected model disables submit and clears when another model is chosen', async () => {
    const smallWindowError =
      "Model Small Test (openai-compatible) accepts 32,768 prompt tokens, fewer than the chunk policy's 48,000-token prompt size. Choose a smaller prompt size or another model, or correct its context window on the Models page."

    mockState.fullTextValidationErrorsByModelId = {'model-small': [smallWindowError]}
    mockState.fullTextValidationWarnings = [
      'PDF-to-text model MinerU standard: The last health check of MinerU failed at 2026-10-17 20:15 UTC: connect ECONNREFUSED. Conversion will not run until the server is reachable.',
    ]

    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      const modelSelect = container.querySelector<HTMLSelectElement>('#model')
      const submitButton = () => {
        return container.querySelector<HTMLButtonElement>('button[type="submit"]')
      }

      setFormValue(container.querySelector<HTMLInputElement>('#project-name'), 'Gate Project')
      getFullTextCheckbox(container)?.click()
      await waitForUpdates()
      await clickRadio(container, 'full-text-figure-mode', 'none')
      await clickRadio(container, 'full-text-max-prompt-tokens', '48000')
      await clickRadio(container, 'full-text-chunk-mode', 'chunked')
      await waitForUpdates()

      expect(submitButton()?.disabled).toBe(false)
      expect(container.querySelector('[data-testid="full-text-validation-warnings"]')?.textContent).toContain(
        'Conversion will not run until the server is reachable.',
      )

      if (modelSelect) {
        modelSelect.value = 'model-small'
        modelSelect.dispatchEvent(new Event('change', {bubbles: true}))
      }
      await waitForUpdates()
      await waitForUpdates()

      expect(container.querySelector('[data-testid="full-text-strategy-errors"]')?.textContent).toContain(
        smallWindowError,
      )
      expect(submitButton()?.disabled).toBe(true)
      expect(
        mockState.fullTextPreviewPayloads.some((payload) => {
          return (payload as {modelId?: string}).modelId === 'model-small'
        }),
      ).toBe(true)

      if (modelSelect) {
        modelSelect.value = 'model-1'
        modelSelect.dispatchEvent(new Event('change', {bubbles: true}))
      }
      await waitForUpdates()
      await waitForUpdates()

      expect(container.querySelector('[data-testid="full-text-strategy-errors"]')).toBeNull()
      expect(submitButton()?.disabled).toBe(false)
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('the figure modes are labelled text only and include figures as images', async () => {
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      getFullTextCheckbox(container)?.click()
      await waitForUpdates()

      const fieldset = container
        .querySelector<HTMLInputElement>('input[name="full-text-figure-mode"]')
        ?.closest('fieldset')

      expect(fieldset?.textContent).toContain('Text only (figures reduced to their captions)')
      expect(fieldset?.textContent).toContain('Include figures as images')
      expect(fieldset?.textContent).not.toContain('Descriptions')
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('a model that cannot receive images shows the warning and keeps only text only selectable', async () => {
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      const modelSelect = container.querySelector<HTMLSelectElement>('#model')

      setFormValue(container.querySelector<HTMLInputElement>('#project-name'), 'Text Only Project')
      getFullTextCheckbox(container)?.click()
      await waitForUpdates()
      if (modelSelect) {
        modelSelect.value = 'model-small'
        modelSelect.dispatchEvent(new Event('change', {bubbles: true}))
      }
      await waitForUpdates()
      await waitForUpdates()

      const nativeImagesRadio = container.querySelector<HTMLInputElement>(
        'input[name="full-text-figure-mode"][value="native_images"]',
      )

      expect(container.querySelector('[data-testid="full-text-figure-image-warning"]')?.textContent).toBe(
        'Model Small Test cannot receive images. Figures will be reduced to their captions (text only).',
      )
      expect(nativeImagesRadio?.disabled).toBe(true)
      expect(
        container.querySelector<HTMLInputElement>('input[name="full-text-figure-mode"][value="none"]')?.disabled,
      ).toBe(false)

      await clickRadio(container, 'full-text-figure-mode', 'none')
      await clickRadio(container, 'full-text-max-prompt-tokens', '48000')
      await clickRadio(container, 'full-text-chunk-mode', 'chunked')
      await waitForUpdates()
      await submitCreateForm(container)

      expect((mockState.createPayloads[0] as Record<string, unknown>).fullTextFigureMode).toBe('none')
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('a vision model shows no warning and both figure modes are selectable', async () => {
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      getFullTextCheckbox(container)?.click()
      await waitForUpdates()
      await clickRadio(container, 'full-text-figure-mode', 'native_images')
      await clickRadio(container, 'full-text-max-prompt-tokens', '48000')
      await clickRadio(container, 'full-text-chunk-mode', 'chunked')
      await waitForUpdates()

      expect(container.querySelector('[data-testid="full-text-figure-image-warning"]')).toBeNull()
      expect(
        container.querySelector<HTMLInputElement>('input[name="full-text-figure-mode"][value="native_images"]')
          ?.disabled,
      ).toBe(false)
      expect(container.querySelector('[data-testid="full-text-strategy-label"]')?.textContent).toBe(
        'mineru 4.0.12 / native images / chunked 48k',
      )
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)

  test('images chosen, then a model that cannot receive images: an error until text only is picked, no silent flip', async () => {
    const {container, dispose, queryClient} = await mountCreateRoute()

    try {
      const modelSelect = container.querySelector<HTMLSelectElement>('#model')
      const submitButton = () => {
        return container.querySelector<HTMLButtonElement>('button[type="submit"]')
      }
      const nativeImagesRadio = () => {
        return container.querySelector<HTMLInputElement>('input[name="full-text-figure-mode"][value="native_images"]')
      }

      setFormValue(container.querySelector<HTMLInputElement>('#project-name'), 'Switch Model Project')
      getFullTextCheckbox(container)?.click()
      await waitForUpdates()
      await clickRadio(container, 'full-text-figure-mode', 'native_images')
      await clickRadio(container, 'full-text-max-prompt-tokens', '48000')
      await clickRadio(container, 'full-text-chunk-mode', 'chunked')
      await waitForUpdates()

      expect(submitButton()?.disabled).toBe(false)

      if (modelSelect) {
        modelSelect.value = 'model-small'
        modelSelect.dispatchEvent(new Event('change', {bubbles: true}))
      }
      await waitForUpdates()
      await waitForUpdates()

      expect(nativeImagesRadio()?.checked).toBe(true)
      expect(nativeImagesRadio()?.disabled).toBe(true)
      expect(container.querySelector('[data-testid="full-text-figure-image-warning"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="full-text-strategy-errors"]')?.textContent).toContain(
        'Model Small Test cannot receive images. Choose Text only (figures reduced to their captions), or another model.',
      )
      expect(submitButton()?.disabled).toBe(true)

      await clickRadio(container, 'full-text-figure-mode', 'none')
      await waitForUpdates()

      expect(nativeImagesRadio()?.checked).toBe(false)
      expect(container.querySelector('[data-testid="full-text-strategy-errors"]')).toBeNull()
      expect(submitButton()?.disabled).toBe(false)

      await submitCreateForm(container)

      expect((mockState.createPayloads[0] as Record<string, unknown>).fullTextFigureMode).toBe('none')
    } finally {
      queryClient.clear()
      dispose()
      container.remove()
    }
  }, 15_000)
})

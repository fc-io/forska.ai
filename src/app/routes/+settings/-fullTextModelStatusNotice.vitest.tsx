// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import type {FullTextModelRole, FullTextModelStatus} from './-fullTextModelStatusNotice.tsx'

const statusState = vi.hoisted(() => {
  return {requests: [] as unknown[], statusesByModelId: {} as Record<string, unknown>}
})

vi.mock('../../../services/apiClient', () => {
  return {
    apiClient: {
      api: {
        users: {
          'full-text-model-status': {
            get: async (options: {query: {modelId: string; role: string}}) => {
              statusState.requests.push(options.query)
              return {data: {data: statusState.statusesByModelId[options.query.modelId] ?? null}}
            },
          },
        },
      },
    },
  }
})

const getStatus = (overrides: {
  capability?: Partial<FullTextModelStatus['capability']>
  health?: Partial<FullTextModelStatus['health']>
}): FullTextModelStatus => {
  return {
    capability: {
      detail: 'Reports mineru 4.0.12.',
      label: 'Converter server version',
      state: 'verified',
      ...overrides.capability,
    },
    health: {
      detail: 'The last health check of MinerU passed at 2026-10-17 20:15 UTC.',
      lastCheckedAt: '2026-10-17T20:15:30.000Z',
      lastError: null,
      state: 'healthy',
      ...overrides.health,
    },
    modelId: 'model-mineru',
    modelLabel: 'MinerU standard',
    providerConnectionId: 'connection-mineru',
    providerKind: 'mineru',
    providerLabel: 'MinerU',
    role: 'pdf_conversion',
  }
}

const flush = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const renderNotice = async (modelId: string, role: FullTextModelRole) => {
  const {FullTextModelStatusNotice} = await import('./-fullTextModelStatusNotice.tsx')
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <FullTextModelStatusNotice modelId={modelId} role={role} />
      </QueryClientProvider>
    )
  }, container)

  await flush()
  await flush()

  return {container, dispose}
}

afterEach(() => {
  document.body.innerHTML = ''
  statusState.requests = []
  statusState.statusesByModelId = {}
})

describe('full-text model status notice', () => {
  test('shows nothing and asks nothing when no model is selected', async () => {
    const {container, dispose} = await renderNotice('', 'pdf_conversion')

    try {
      expect(container.textContent).toBe('')
      expect(statusState.requests).toEqual([])
    } finally {
      dispose()
    }
  })

  test('shows a healthy provider and the verified capability for the selected model', async () => {
    statusState.statusesByModelId['model-mineru'] = getStatus({})

    const {container, dispose} = await renderNotice('model-mineru', 'pdf_conversion')

    try {
      expect(statusState.requests).toEqual([{modelId: 'model-mineru', role: 'pdf_conversion'}])
      expect(container.querySelector('[data-testid="full-text-model-health"]')?.textContent).toBe(
        'Provider health: Healthy. The last health check of MinerU passed at 2026-10-17 20:15 UTC.',
      )
      expect(container.querySelector('[data-testid="full-text-model-capability"]')?.textContent).toBe(
        'Converter server version: Verified. Reports mineru 4.0.12.',
      )
    } finally {
      dispose()
    }
  })

  test('shows the failed check with its error, and unverified and disabled states', async () => {
    statusState.statusesByModelId['model-failed'] = getStatus({
      health: {
        detail: 'The last health check of MinerU failed at 2026-10-17 20:15 UTC: connect ECONNREFUSED.',
        lastError: 'connect ECONNREFUSED',
        state: 'failed',
      },
    })
    statusState.statusesByModelId['model-unverified'] = getStatus({
      capability: {
        detail: 'No verified image input. Set it on the Models page.',
        label: 'Image input',
        state: 'unverified',
      },
      health: {
        detail: 'Ollama has not been health-checked yet. Test the connection on the Models page.',
        state: 'unverified',
      },
    })
    statusState.statusesByModelId['model-disabled'] = getStatus({
      health: {
        detail: 'The model or its provider MinerU is disabled. Enable both on the Models page.',
        state: 'disabled',
      },
    })

    const failed = await renderNotice('model-failed', 'pdf_conversion')
    const unverified = await renderNotice('model-unverified', 'figure_description')
    const disabled = await renderNotice('model-disabled', 'pdf_conversion')

    try {
      expect(failed.container.textContent).toContain('Provider health: Health check failed.')
      expect(failed.container.textContent).toContain('connect ECONNREFUSED')
      expect(unverified.container.textContent).toContain('Provider health: Unverified.')
      expect(unverified.container.textContent).toContain('Image input: Unverified. No verified image input.')
      expect(disabled.container.textContent).toContain('Provider health: Disabled.')
    } finally {
      failed.dispose()
      unverified.dispose()
      disabled.dispose()
    }
  })

  test('a model id the server no longer knows is called out', async () => {
    const {container, dispose} = await renderNotice('model-gone', 'figure_description')

    try {
      expect(container.textContent).toBe('The selected model no longer exists.')
    } finally {
      dispose()
    }
  })
})

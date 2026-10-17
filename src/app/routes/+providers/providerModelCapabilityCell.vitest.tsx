// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {render} from 'solid-js/web'
import {afterEach, expect, test, vi} from 'vitest'

import {type ProviderModelCapabilities} from '../+admin/+models/providerConnectionsClient.ts'
import {ProviderModelCapabilityCell} from './providerModelCapabilityCell.tsx'

const mockedClient = vi.hoisted(() => {
  return {updateProviderModelCapabilityOverrides: vi.fn()}
})

vi.mock('../+admin/+models/providerConnectionsClient.ts', () => {
  return {updateProviderModelCapabilityOverrides: mockedClient.updateProviderModelCapabilityOverrides}
})

const shippedCapabilities: ProviderModelCapabilities = {
  contextWindow: {
    inputTokens: 922_000,
    source: 'shipped',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
    totalTokens: 1_050_000,
    verifiedAt: '2026-10-17',
  },
  supportsImageInput: {
    source: 'shipped',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
    value: true,
    verifiedAt: '2026-10-17',
  },
  supportsPdfInput: {
    source: 'shipped',
    sourceUrl: 'https://developers.openai.com/codex/app-server',
    value: false,
    verifiedAt: '2026-10-17',
  },
}

const waitForCondition = async (assertion: () => void, remaining = 30): Promise<void> => {
  try {
    assertion()
  } catch (error) {
    if (remaining <= 0) {
      throw error
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return waitForCondition(assertion, remaining - 1)
  }
}

const renderCell = ({
  capabilities,
  modelId,
  onSaved = vi.fn(async () => {
    return undefined
  }),
}: {
  capabilities: ProviderModelCapabilities | null
  modelId: string | null
  onSaved?: () => Promise<unknown>
}) => {
  const queryClient = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <ProviderModelCapabilityCell capabilities={capabilities} modelId={modelId} onSaved={onSaved} />
      </QueryClientProvider>
    )
  }, container)

  return {container, dispose, onSaved}
}

const getButton = (container: HTMLElement, label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((element) => {
    return element.textContent?.trim() === label
  })

  if (!button) {
    throw new Error(`Button ${label} not found`)
  }

  return button
}

const getTokenInputs = (container: HTMLElement) => {
  const [inputTokens, totalTokens] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="number"]'))

  if (!inputTokens || !totalTokens) {
    throw new Error('Token fields not found')
  }

  return {inputTokens, totalTokens}
}

const setInputValue = (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new Event('input', {bubbles: true}))
}

afterEach(() => {
  document.body.innerHTML = ''
  mockedClient.updateProviderModelCapabilityOverrides.mockReset()
})

test('shows the context window, image and PDF support with the shipped source and verified date', () => {
  const {container, dispose} = renderCell({capabilities: shippedCapabilities, modelId: 'model-1'})
  const sourceLinks = Array.from(container.querySelectorAll('a'))

  expect(container.textContent).toContain('922,000 in / 1,050,000 total')
  expect(container.textContent).toContain('Images')
  expect(container.textContent).toContain('Yes')
  expect(container.textContent).toContain('No')
  expect(sourceLinks[0]?.textContent).toBe('shipped · verified 2026-10-17')
  expect(sourceLinks[0]?.getAttribute('href')).toBe('https://developers.openai.com/api/docs/models/gpt-6-astra')
  expect(container.textContent).not.toContain('Unverified')

  dispose()
})

test('marks every absent capability as unverified', () => {
  const {container, dispose} = renderCell({capabilities: null, modelId: 'model-1'})

  expect(container.textContent?.match(/Unverified/gu)?.length).toBe(3)

  dispose()
})

test('saves a user context window override and leaves blank fields unset', async () => {
  mockedClient.updateProviderModelCapabilityOverrides.mockResolvedValue({id: 'model-1'})
  const {container, dispose, onSaved} = renderCell({capabilities: null, modelId: 'model-1'})

  getButton(container, 'Edit capabilities').click()

  const {inputTokens} = getTokenInputs(container)

  setInputValue(inputTokens, '4096')
  getButton(container, 'Save override').click()

  await waitForCondition(() => {
    expect(mockedClient.updateProviderModelCapabilityOverrides).toHaveBeenCalledWith({
      id: 'model-1',
      overrides: {
        contextWindow: {inputTokens: 4096, totalTokens: null},
        supportsImageInput: null,
        supportsPdfInput: null,
      },
    })
    expect(onSaved).toHaveBeenCalled()
  })

  dispose()
})

test('rejects a total below the input tokens without calling the API', () => {
  const {container, dispose} = renderCell({capabilities: null, modelId: 'model-1'})

  getButton(container, 'Edit capabilities').click()

  const {inputTokens, totalTokens} = getTokenInputs(container)

  setInputValue(inputTokens, '8000')
  setInputValue(totalTokens, '4000')
  getButton(container, 'Save override').click()

  expect(container.textContent).toContain('Total tokens must be at least the input tokens.')
  expect(mockedClient.updateProviderModelCapabilityOverrides).not.toHaveBeenCalled()

  dispose()
})

test('clears an existing user override', async () => {
  mockedClient.updateProviderModelCapabilityOverrides.mockResolvedValue({id: 'model-1'})
  const {container, dispose} = renderCell({
    capabilities: {
      ...shippedCapabilities,
      contextWindow: {inputTokens: 4096, source: 'user', sourceUrl: null, totalTokens: null, verifiedAt: '2026-10-17'},
    },
    modelId: 'model-1',
  })

  expect(container.textContent).toContain('user · set 2026-10-17')

  getButton(container, 'Edit capabilities').click()
  getButton(container, 'Clear override').click()

  await waitForCondition(() => {
    expect(mockedClient.updateProviderModelCapabilityOverrides).toHaveBeenCalledWith({
      id: 'model-1',
      overrides: {contextWindow: null, supportsImageInput: null, supportsPdfInput: null},
    })
  })

  dispose()
})

test('unsaved variant rows show the inherited values without an edit control', () => {
  const {container, dispose} = renderCell({capabilities: shippedCapabilities, modelId: null})

  expect(container.textContent).toContain('Save the model to set capability overrides.')
  expect(container.querySelector('button')).toBeNull()

  dispose()
})

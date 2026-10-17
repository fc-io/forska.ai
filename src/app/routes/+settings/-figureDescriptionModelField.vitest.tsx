// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

const optionsResponse = vi.hoisted(() => {
  return {
    current: {
      data: {
        data: [
          {
            capabilitySource: 'discovery',
            id: 'model-vlm',
            label: 'qwen3-vl:2b-instruct (Ollama)',
            providerConnectionId: 'connection-ollama',
            providerKind: 'ollama',
          },
          {
            capabilitySource: 'shipped',
            id: 'model-claude',
            label: 'claude-sonnet-5-5 (Anthropic)',
            providerConnectionId: 'connection-anthropic',
            providerKind: 'anthropic',
          },
        ],
      },
    } as unknown,
  }
})

vi.mock('../../../services/apiClient', () => {
  return {
    apiClient: {
      api: {
        users: {
          'figure-description-models': {
            get: async () => {
              return optionsResponse.current
            },
          },
        },
      },
    },
  }
})

const flush = async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const renderField = async (initialValue: string) => {
  const {FigureDescriptionModelField} = await import('./-figureDescriptionModelField.tsx')
  const [value, setValue] = createSignal(initialValue)
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <FigureDescriptionModelField value={value()} onChange={setValue} />
      </QueryClientProvider>
    )
  }, container)

  await flush()
  await flush()

  return {container, dispose, value}
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('figure-description model field', () => {
  test('lists None first and then only the image-capable models from the server', async () => {
    const {container, dispose} = await renderField('')

    try {
      const options = Array.from(container.querySelectorAll('option')).map((option) => {
        return [option.value, option.textContent]
      })

      expect(options).toEqual([
        ['', 'None (figure mode Descriptions is unavailable)'],
        ['model-vlm', 'qwen3-vl:2b-instruct (Ollama)'],
        ['model-claude', 'claude-sonnet-5-5 (Anthropic)'],
      ])
      expect(container.textContent).not.toContain('no longer accepts image input')
    } finally {
      dispose()
    }
  })

  test('selecting a model reports its id', async () => {
    const {container, dispose, value} = await renderField('')

    try {
      const select = container.querySelector<HTMLSelectElement>('#figure-description-model')

      if (!select) {
        throw new Error('Expected the figure-description select')
      }

      select.value = 'model-vlm'
      select.dispatchEvent(new Event('input', {bubbles: true}))

      expect(value()).toBe('model-vlm')
    } finally {
      dispose()
    }
  })

  test('warns when the saved model is no longer selectable', async () => {
    const {container, dispose} = await renderField('model-text-only')

    try {
      expect(container.textContent).toContain('no longer accepts image input')
      expect(container.querySelector<HTMLSelectElement>('#figure-description-model')?.value).toBe('model-text-only')
    } finally {
      dispose()
    }
  })
})

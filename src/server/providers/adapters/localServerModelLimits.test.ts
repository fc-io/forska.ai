import {afterEach, expect, spyOn, test} from 'bun:test'

import {getNormalizedProviderModelMetadata} from '../providerModelMetadata.ts'
import {type ProviderListedModel} from '../providerTypes.ts'
import {addLocalServerModelLimits} from './localServerModelLimits.ts'

const getListedModel = ({
  providerKind,
  remoteModelId,
}: {
  providerKind: 'llamacpp' | 'llmstudio' | 'ollama'
  remoteModelId: string
}) => {
  const listedModel = {
    displayName: remoteModelId,
    metadataJson: null,
    modelName: remoteModelId,
    remoteModelId,
    variant: null,
    version: null,
  }

  return {
    ...listedModel,
    metadataJson: getNormalizedProviderModelMetadata({
      listedModel,
      providerKind,
      rawMetadata: null,
      source: 'provider',
    }),
  } satisfies ProviderListedModel
}

const getDiscovery = (model: ProviderListedModel | undefined) => {
  return (
    model?.metadataJson as {
      discovery: {capabilities: {supportsImageInput: boolean | null}; contextWindow: Record<string, number | null>}
    }
  ).discovery
}

const stubFetch = (responses: Record<string, unknown>) => {
  const requestedUrls: string[] = []
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : input.toString()

    requestedUrls.push(url)

    return url in responses ? Response.json(responses[url]) : new Response('not found', {status: 404})
  }) as typeof fetch)

  return {fetchSpy, requestedUrls}
}

afterEach(() => {
  ;(globalThis.fetch as unknown as {mockRestore?: () => void}).mockRestore?.()
})

test('llama.cpp uses the per-slot n_ctx and vision modality reported by /props', async () => {
  stubFetch({
    'http://127.0.0.1:8080/props': {
      default_generation_settings: {n_ctx: 8192},
      modalities: {vision: false},
      total_slots: 4,
    },
  })

  const [model] = await addLocalServerModelLimits({
    baseURL: 'http://127.0.0.1:8080/v1',
    models: [getListedModel({providerKind: 'llamacpp', remoteModelId: 'qwen2.5-1.5b-instruct'})],
    providerKind: 'llamacpp',
  })

  expect(getDiscovery(model).contextWindow).toEqual({inputTokens: 8192, outputTokens: null, totalTokens: 8192})
  expect(getDiscovery(model).capabilities.supportsImageInput).toBe(false)
})

test('LM Studio uses max_context_length and the model type from /api/v0/models', async () => {
  stubFetch({
    'http://127.0.0.1:1234/api/v0/models': {
      data: [
        {id: 'qwen2.5-1.5b-instruct', max_context_length: 32768, type: 'llm'},
        {id: 'qwen2-vl-7b-instruct', max_context_length: 32768, type: 'vlm'},
      ],
    },
  })

  const models = await addLocalServerModelLimits({
    baseURL: 'http://127.0.0.1:1234/v1',
    models: [
      getListedModel({providerKind: 'llmstudio', remoteModelId: 'qwen2.5-1.5b-instruct'}),
      getListedModel({providerKind: 'llmstudio', remoteModelId: 'qwen2-vl-7b-instruct'}),
      getListedModel({providerKind: 'llmstudio', remoteModelId: 'not-reported'}),
    ],
    providerKind: 'llmstudio',
  })

  expect(
    models.map((model) => {
      return [getDiscovery(model).contextWindow.inputTokens, getDiscovery(model).capabilities.supportsImageInput]
    }),
  ).toEqual([
    [32768, false],
    [32768, true],
    [null, null],
  ])
})

test('Ollama reads <arch>.context_length and the vision capability from /api/show', async () => {
  stubFetch({
    'http://127.0.0.1:11434/api/show': {capabilities: ['completion'], model_info: {'qwen2.context_length': 32768}},
  })

  const [model] = await addLocalServerModelLimits({
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [getListedModel({providerKind: 'ollama', remoteModelId: 'qwen2.5:1.5b'})],
    providerKind: 'ollama',
  })

  expect(getDiscovery(model).contextWindow.inputTokens).toBe(32768)
  expect(getDiscovery(model).capabilities.supportsImageInput).toBe(false)
})

test('unreachable servers and other providers leave the listed models unchanged', async () => {
  const {requestedUrls} = stubFetch({})
  const llamaModel = getListedModel({providerKind: 'llamacpp', remoteModelId: 'm'})
  const [unreachable] = await addLocalServerModelLimits({
    baseURL: 'http://127.0.0.1:8080',
    models: [llamaModel],
    providerKind: 'llamacpp',
  })
  const [other] = await addLocalServerModelLimits({
    baseURL: 'http://x/v1',
    models: [llamaModel],
    providerKind: 'sglang',
  })

  expect(unreachable).toEqual(llamaModel)
  expect(other).toBe(llamaModel)
  expect(requestedUrls).toEqual(['http://127.0.0.1:8080/props'])
})

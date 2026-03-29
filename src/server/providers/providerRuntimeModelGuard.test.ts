import {afterEach, expect, mock, test} from 'bun:test'

const providerAuthServiceModulePath = new URL('./providerAuthService.ts', import.meta.url).pathname
const providerConnectionRepositoryModulePath = new URL('./providerConnectionRepository.ts', import.meta.url).pathname
const providerRuntimeDetectorModulePath = new URL('./providerRuntimeDetector.ts', import.meta.url).pathname
const providerModelRepositoryModulePath = new URL('./providerModelRepository.ts', import.meta.url).pathname
const providerRegistryModulePath = new URL('./providerRegistry.ts', import.meta.url).pathname
const providerRuntimeDiscoveryModulePath = new URL('./providerRuntimeDiscovery.ts', import.meta.url).pathname

const defaultBaseURL = 'http://127.0.0.1:30000/v1'
const expectedModelName = 'Qwen/Qwen3.5-35B-A3B'

const state = {
  discoverOpenAICompatibleRuntimeModel: mock(async (_input: unknown) => {
    return {
      baseURL: defaultBaseURL,
      contextLength: null,
      modelName: expectedModelName,
      raw: null,
      servedModelName: null,
    }
  }),
  getProviderConnectionForStoredModel: mock(async (_modelId: string) => {
    return {baseURL: defaultBaseURL, id: 'connection-1', providerKind: 'sglang'}
  }),
  listProviderConnections: mock(async () => {
    return []
  }),
  getProviderModels: mock(async ([modelId]: string[]) => {
    return new Map([
      [modelId, {modelName: expectedModelName, providerConnectionId: 'connection-1', remoteModelId: expectedModelName}],
    ])
  }),
  listModels: mock(async (_input: unknown) => {
    return [
      {
        displayName: expectedModelName,
        metadataJson: null,
        modelName: expectedModelName,
        remoteModelId: expectedModelName,
        variant: null,
        version: null,
      },
    ]
  }),
  resolveProviderRuntimeCredentials: mock(async (_connection: unknown) => {
    return {apiKey: null, baseURL: defaultBaseURL, headers: {}, secretRef: null}
  }),
}

const resetState = (): void => {
  state.discoverOpenAICompatibleRuntimeModel.mockImplementation(async (_input: unknown) => {
    return {
      baseURL: defaultBaseURL,
      contextLength: null,
      modelName: expectedModelName,
      raw: null,
      servedModelName: null,
    }
  })
  state.getProviderConnectionForStoredModel.mockImplementation(async (_modelId: string) => {
    return {baseURL: defaultBaseURL, id: 'connection-1', providerKind: 'sglang'}
  })
  state.listProviderConnections.mockImplementation(async () => {
    return []
  })
  state.getProviderModels.mockImplementation(async ([modelId]: string[]) => {
    return new Map([
      [modelId, {modelName: expectedModelName, providerConnectionId: 'connection-1', remoteModelId: expectedModelName}],
    ])
  })
  state.listModels.mockImplementation(async (_input: unknown) => {
    return [
      {
        displayName: expectedModelName,
        metadataJson: null,
        modelName: expectedModelName,
        remoteModelId: expectedModelName,
        variant: null,
        version: null,
      },
    ]
  })
  state.resolveProviderRuntimeCredentials.mockImplementation(async (_connection: unknown) => {
    return {apiKey: null, baseURL: defaultBaseURL, headers: {}, secretRef: null}
  })
}

void mock.module(providerAuthServiceModulePath, () => {
  return {resolveProviderRuntimeCredentials: state.resolveProviderRuntimeCredentials}
})

void mock.module(providerConnectionRepositoryModulePath, () => {
  return {
    getProviderConnectionForStoredModel: state.getProviderConnectionForStoredModel,
    listProviderConnections: state.listProviderConnections,
  }
})

void mock.module(providerModelRepositoryModulePath, () => {
  return {getProviderModels: state.getProviderModels}
})

void mock.module(providerRegistryModulePath, () => {
  return {
    requireProviderRegistryEntry: () => {
      return {listModels: state.listModels}
    },
  }
})

void mock.module(providerRuntimeDiscoveryModulePath, () => {
  return {
    discoverOpenAICompatibleRuntimeModel: state.discoverOpenAICompatibleRuntimeModel,
    supportsSavedLocalProviderProbe: (providerKind: string | null | undefined) => {
      return ['ollama', 'llamacpp', 'llmstudio', 'sglang', 'vllm'].includes(String(providerKind ?? '').trim())
    },
  }
})

const loadGuard = () => {
  return import('./providerRuntimeModelGuard.ts')
}

afterEach(() => {
  resetState()

  return (import(providerRuntimeDetectorModulePath) as Promise<{clearProviderRuntimeDetectorCache: () => void}>).then(
    ({clearProviderRuntimeDetectorCache}) => {
      clearProviderRuntimeDetectorCache()
    },
  )
})

test('getStoredProviderModelRuntimeMatch returns an unreachable-runtime message when SGLang cannot be reached', async () => {
  state.listModels.mockImplementationOnce(async (_input: unknown) => {
    throw new Error('Connection error.')
  })
  const {getStoredProviderModelRuntimeMatch} = await loadGuard()

  const result = await getStoredProviderModelRuntimeMatch({modelId: 'model-unreachable'})

  expect(result).toEqual({
    message:
      'Could not reach the configured SGLang runtime at http://127.0.0.1:30000/v1, so Forska could not confirm it serves Qwen/Qwen3.5-35B-A3B. Connection error.',
    ok: false,
    reason: 'runtime-unreachable',
  })
})

test('getStoredProviderModelRuntimeMatch returns a mismatch message when SGLang serves another model', async () => {
  state.listModels.mockImplementationOnce(async (_input: unknown) => {
    return [
      {
        displayName: 'other-model',
        metadataJson: null,
        modelName: 'other-model',
        remoteModelId: 'other-model',
        variant: null,
        version: null,
      },
    ]
  })
  state.discoverOpenAICompatibleRuntimeModel.mockImplementationOnce(async (_input: unknown) => {
    return {baseURL: defaultBaseURL, contextLength: null, modelName: 'other-model', raw: null, servedModelName: null}
  })
  const {getStoredProviderModelRuntimeMatch} = await loadGuard()

  const result = await getStoredProviderModelRuntimeMatch({modelId: 'model-mismatch'})

  expect(result).toEqual({
    message:
      'Configured SGLang runtime at http://127.0.0.1:30000/v1 is serving other-model, but the project expects Qwen/Qwen3.5-35B-A3B.',
    ok: false,
    reason: 'runtime-mismatch',
  })
})

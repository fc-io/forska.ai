import {afterEach, expect, mock, test} from 'bun:test'

const providerConnectionRepositoryModulePath = new URL('./providerConnectionRepository.ts', import.meta.url).pathname
const providerRuntimeDiscoveryModulePath = new URL('./providerRuntimeDiscovery.ts', import.meta.url).pathname
const providerRuntimeRecordsModulePath = new URL('../../utils/providerRuntimeRecords.ts', import.meta.url).pathname

const state = {
  discoverOpenAICompatibleRuntimeModel: mock(async ({baseURL}: {baseURL: string}) => {
    return {
      baseURL,
      contextLength: null,
      modelName: 'Qwen/Qwen3',
      modelNames: ['Qwen/Qwen3'],
      raw: null,
      servedModelName: null,
    }
  }),
  getLatestActiveProviderRuntimeRecord: mock(() => {
    return null
  }),
  getProviderRuntimeRecordStatus: mock(() => {
    return 'stopped'
  }),
  loadProviderRuntimeRecords: mock(() => {
    return []
  }),
  listProviderConnections: mock(async (): Promise<unknown[]> => {
    return []
  }),
}

const registerModuleMocks = () => {
  void mock.module(providerConnectionRepositoryModulePath, () => {
    return {listProviderConnections: state.listProviderConnections}
  })

  void mock.module(providerRuntimeDiscoveryModulePath, () => {
    return {
      discoverOpenAICompatibleRuntimeModel: state.discoverOpenAICompatibleRuntimeModel,
      supportsSavedLocalProviderProbe: (providerKind: string | null | undefined) => {
        return ['ollama', 'llamacpp', 'llmstudio', 'sglang', 'vllm'].includes(String(providerKind ?? '').trim())
      },
    }
  })

  void mock.module(providerRuntimeRecordsModulePath, () => {
    return {
      getLatestActiveProviderRuntimeRecord: state.getLatestActiveProviderRuntimeRecord,
      getProviderRuntimeRecordStatus: state.getProviderRuntimeRecordStatus,
      loadProviderRuntimeRecords: state.loadProviderRuntimeRecords,
    }
  })
}

const loadDetector = () => {
  registerModuleMocks()

  return import(`./providerRuntimeDetector.ts?test=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  state.discoverOpenAICompatibleRuntimeModel.mockClear()
  state.discoverOpenAICompatibleRuntimeModel.mockImplementation(async ({baseURL}: {baseURL: string}) => {
    return {
      baseURL,
      contextLength: null,
      modelName: 'Qwen/Qwen3',
      modelNames: ['Qwen/Qwen3'],
      raw: null,
      servedModelName: null,
    }
  })
  state.getLatestActiveProviderRuntimeRecord.mockReset()
  state.getLatestActiveProviderRuntimeRecord.mockImplementation(() => {
    return null
  })
  state.getProviderRuntimeRecordStatus.mockReset()
  state.getProviderRuntimeRecordStatus.mockImplementation(() => {
    return 'stopped'
  })
  state.loadProviderRuntimeRecords.mockReset()
  state.loadProviderRuntimeRecords.mockImplementation(() => {
    return []
  })
  state.listProviderConnections.mockReset()
  state.listProviderConnections.mockImplementation(async (): Promise<unknown[]> => {
    return []
  })

  mock.restore()
})

test('detector probes saved manual worker urls for runtime-backed providers', async () => {
  state.listProviderConnections.mockImplementationOnce(async () => {
    return [
      {
        baseURL: null,
        config: {manualWorkerUrls: ['http://127.0.0.1:30010'], workerUrlMode: 'manual'},
        enabled: true,
        providerKind: 'sglang',
      },
    ]
  })
  const {getDetectedProviderRuntimeSummary} = await loadDetector()

  const summary = await getDetectedProviderRuntimeSummary({now: 100})

  expect(state.discoverOpenAICompatibleRuntimeModel).toHaveBeenCalledWith({
    baseURL: 'http://127.0.0.1:30010/v1',
    providerKind: 'sglang',
  })
  expect(summary).toEqual({
    activeModelNames: ['Qwen/Qwen3'],
    providerKind: 'sglang',
    remoteWorkerUrls: ['http://127.0.0.1:30010'],
    sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
    workerUrls: ['http://127.0.0.1:30010'],
  })
})

test('detector probes only saved local provider endpoints', async () => {
  state.listProviderConnections.mockImplementationOnce(async () => {
    return [
      {
        baseURL: 'https://api.openai.com/v1',
        config: {manualWorkerUrls: ['http://127.0.0.1:30010'], workerUrlMode: 'manual'},
        enabled: true,
        providerKind: 'openai',
      },
      {
        baseURL: 'http://127.0.0.1:1234/v1',
        config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
        enabled: true,
        providerKind: 'llmstudio',
      },
    ]
  })
  const {getDetectedProviderRuntimeSummary} = await loadDetector()

  const summary = await getDetectedProviderRuntimeSummary({now: 100})

  expect(state.discoverOpenAICompatibleRuntimeModel).toHaveBeenCalledTimes(1)
  expect(state.discoverOpenAICompatibleRuntimeModel).toHaveBeenCalledWith({
    baseURL: 'http://127.0.0.1:1234/v1',
    providerKind: 'llmstudio',
  })
  expect(summary).toEqual({
    activeModelNames: ['Qwen/Qwen3'],
    providerKind: 'llmstudio',
    remoteWorkerUrls: ['http://127.0.0.1:1234'],
    sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
    workerUrls: ['http://127.0.0.1:1234'],
  })
})

test('detector lists all detected runtime summaries for saved connections', async () => {
  state.listProviderConnections.mockImplementationOnce(async () => {
    return [
      {
        baseURL: 'http://127.0.0.1:1234/v1',
        config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
        enabled: true,
        providerKind: 'llmstudio',
      },
      {
        baseURL: null,
        config: {manualWorkerUrls: ['http://127.0.0.1:30010'], workerUrlMode: 'manual'},
        enabled: true,
        providerKind: 'sglang',
      },
    ]
  })
  const {getDetectedProviderRuntimeSummaries} = await loadDetector()

  const summaries = await getDetectedProviderRuntimeSummaries({now: 100})

  expect(summaries).toEqual([
    {
      activeModelNames: ['Qwen/Qwen3'],
      providerKind: 'llmstudio',
      remoteWorkerUrls: ['http://127.0.0.1:1234'],
      sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
      workerUrls: ['http://127.0.0.1:1234'],
    },
    {
      activeModelNames: ['Qwen/Qwen3'],
      providerKind: 'sglang',
      remoteWorkerUrls: ['http://127.0.0.1:30010'],
      sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
      workerUrls: ['http://127.0.0.1:30010'],
    },
  ])
})

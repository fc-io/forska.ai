import {expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname

const state = {
  globalQueryJson: mock(async (_statement: string) => {
    throw new Error('global queryJson should not be used inside upsertDiscoveredModels transaction')
  }),
  globalRun: mock(async (_statement: string) => {}),
  transaction: mock(
    async (
      operation: (databaseRunner: {
        queryJson: <T>(statement: string) => Promise<T[]>
        run: (statement: string) => Promise<void>
      }) => Promise<unknown>,
    ) => {
      return await operation({
        queryJson: async <T>(statement: string) => {
          if (statement.includes('SELECT id') && statement.includes('FROM app.model')) {
            return [] as T[]
          }

          if (statement.includes('INSERT INTO app.model')) {
            return [
              {
                baseURL: null,
                createdAt: null,
                displayName: 'Qwen3-4B-Q4_K_M',
                enabled: true,
                id: 'model-1',
                metadataJson: {providerKind: 'llmstudio'},
                modelName: 'Qwen3-4B-Q4_K_M',
                name: 'Qwen3-4B-Q4_K_M',
                provider: null,
                providerConnectionId: 'connection-1',
                remoteModelId: 'Qwen3-4B-Q4_K_M',
                source: 'discovered',
                updatedAt: null,
                variant: null,
                version: null,
              },
            ] as T[]
          }

          throw new Error(`Unexpected SQL in tx.queryJson: ${statement}`)
        },
        run: async (_statement: string) => {},
      })
    },
  ),
}

void mock.module(appDatabaseServiceModulePath, () => {
  return {
    getAppDatabaseService: () => {
      return {queryJson: state.globalQueryJson, run: state.globalRun, transaction: state.transaction}
    },
  }
})

test('upsertDiscoveredModels uses the transaction runner for sync queries and writes', async () => {
  state.globalQueryJson.mockClear()
  state.globalRun.mockClear()
  state.transaction.mockClear()

  const {upsertDiscoveredModels} = await import('./providerModelRepository.ts')
  const savedModels = await upsertDiscoveredModels({
    connection: {
      authMode: 'none',
      baseURL: 'http://127.0.0.1:8080/v1',
      config: {disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: false,
      id: 'connection-1',
      label: 'LM Studio',
      lastCheckedAt: null,
      lastError: null,
      providerKind: 'llmstudio',
      secretRef: null,
      updatedAt: null,
    },
    models: [
      {
        displayName: 'Qwen3-4B-Q4_K_M',
        metadataJson: {id: 'Qwen3-4B-Q4_K_M'},
        modelName: 'Qwen3-4B-Q4_K_M',
        remoteModelId: 'Qwen3-4B-Q4_K_M',
        variant: null,
        version: null,
      },
    ],
  })

  expect(state.transaction).toHaveBeenCalledTimes(1)
  expect(state.globalQueryJson).not.toHaveBeenCalled()
  expect(savedModels).toHaveLength(1)
  expect(savedModels[0]).toMatchObject({
    displayName: 'Qwen3-4B-Q4_K_M',
    providerConnectionId: 'connection-1',
    remoteModelId: 'Qwen3-4B-Q4_K_M',
  })
})

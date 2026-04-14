import {beforeEach, expect, mock, test} from 'bun:test'

const getCodexAppServerClientModulePath = new URL('../../utils/getCodexAppServerClient.ts', import.meta.url).pathname

const runJsonTurn = mock(async (): Promise<{text: string; usage: unknown}> => {
  return {text: 'codex-response', usage: null}
})

void mock.module(getCodexAppServerClientModulePath, () => {
  return {
    getCodexAppServerClient: () => {
      return {
        modelList: async () => {
          return {data: [], nextCursor: null}
        },
        runJsonTurn,
      }
    },
    getCodexBinPath: () => {
      return '/usr/local/bin/codex'
    },
  }
})

const loadTransport = () => {
  return import('./codexAppTransport.ts')
}

beforeEach(() => {
  runJsonTurn.mockReset()
})

test('invokeCodexAppModel maps Codex token usage into provider usage', async () => {
  runJsonTurn.mockResolvedValue({
    text: 'codex-response',
    usage: {
      last: {cachedInputTokens: 20, inputTokens: 120, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 155},
      modelContextWindow: 200_000,
      total: {cachedInputTokens: 20, inputTokens: 120, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 155},
    },
  })

  const {invokeCodexAppModel} = await loadTransport()
  const result = await invokeCodexAppModel({
    modelName: 'codex-mini',
    outputSchema: {type: 'object'},
    prompt: 'hello',
    systemPrompt: 'system',
    version: 'medium',
  })

  expect(result).toEqual({text: 'codex-response', usage: {completionTokens: 35, promptTokens: 120, totalTokens: 155}})
})

test('getProviderUsageFromCodexThreadTokenUsage falls back to output totals when needed', async () => {
  const {getProviderUsageFromCodexThreadTokenUsage} = await loadTransport()

  const result = getProviderUsageFromCodexThreadTokenUsage({
    last: {cachedInputTokens: 0, inputTokens: 0, outputTokens: 11, reasoningOutputTokens: 7, totalTokens: 0},
    modelContextWindow: null,
    total: {cachedInputTokens: 0, inputTokens: 0, outputTokens: 11, reasoningOutputTokens: 7, totalTokens: 0},
  })

  expect(result).toEqual({completionTokens: 18, promptTokens: 0, totalTokens: 0})
})

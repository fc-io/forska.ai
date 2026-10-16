import {beforeEach, expect, mock, test} from 'bun:test'

import {type ProviderConnectionRecord, type ProviderModelRecord} from '../providerTypes.ts'
import {type ClaudeCodeCliStatus} from '../transports/claudeCodeCliTransport.ts'

const claudeCodeCliTransportModulePath = new URL('../transports/claudeCodeCliTransport.ts', import.meta.url).href

const loggedInStatus: ClaudeCodeCliStatus = {
  authMethod: 'claude.ai',
  binPath: '/opt/homebrew/bin/claude',
  cliAvailable: true,
  email: 'me@example.com',
  loggedIn: true,
  message: 'Claude Code 2.1.300 logged in as me@example.com (max).',
  subscriptionType: 'max',
  version: '2.1.300',
}

const state = {
  invoke: mock(async (_input: unknown) => {
    return {text: '{"answer":"yes"}', usage: {completionTokens: 1, promptTokens: 2, totalTokens: 3}}
  }),
  status: loggedInStatus,
}

void mock.module(claudeCodeCliTransportModulePath, () => {
  return {
    getClaudeCodeCliStatus: async () => {
      return state.status
    },
    getClaudeCodeHealthResult: (status: ClaudeCodeCliStatus) => {
      return status.loggedIn
        ? {lastError: null, message: status.message, modelCount: null, ok: true}
        : {lastError: status.message, message: status.message, modelCount: null, ok: false}
    },
    invokeClaudeCodeCliModel: state.invoke,
    listClaudeCodeModels: () => {
      return [
        {
          defaultEnabled: true,
          displayName: 'Claude Opus 5.5 (effort: high)',
          metadataJson: {
            id: 'claude-opus-5-5',
            reasoningEffort: 'high',
            supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'high'}],
          },
          modelName: 'claude-opus-5-5',
          remoteModelId: 'claude-opus-5-5',
          variant: 'high',
          version: 'high',
        },
      ]
    },
  }
})

const connection: ProviderConnectionRecord = {
  authMode: 'claude-cli',
  baseURL: null,
  config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
  createdAt: null,
  enabled: true,
  hasSecret: false,
  id: 'connection-claude-code',
  label: 'Claude Code',
  lastCheckedAt: null,
  lastError: null,
  maxInflightRequests: null,
  providerKind: 'claude-code',
  secretRef: null,
  updatedAt: null,
}

const model: ProviderModelRecord = {
  baseURL: null,
  createdAt: null,
  displayName: 'Claude Opus 5.5 (effort: high)',
  enabled: true,
  id: 'model-claude-code',
  metadataJson: null,
  modelName: 'claude-opus-5-5',
  name: 'Claude Opus 5.5 (effort: high)',
  provider: 'claude-code',
  providerConnectionId: connection.id,
  remoteModelId: 'claude-opus-5-5',
  source: 'discovered',
  updatedAt: null,
  variant: 'high',
  version: 'high',
}

const loadAdapter = async () => {
  const {requireProviderRegistryEntry} = await import('../providerRegistry.ts')

  return requireProviderRegistryEntry('claude-code')
}

beforeEach(() => {
  state.invoke.mockClear()
  state.status = loggedInStatus
})

test('Claude Code auth completes immediately when the CLI is logged in', async () => {
  const adapter = await loadAdapter()
  const result = await adapter.beginAuth?.({connection: null, providerKind: 'claude-code'})

  expect(result).toMatchObject({
    message: loggedInStatus.message,
    payload: {authMode: 'claude-cli', providerState: loggedInStatus},
    status: 'complete',
  })
})

test('Claude Code auth returns the terminal login instruction when logged out', async () => {
  state.status = {
    ...loggedInStatus,
    email: null,
    loggedIn: false,
    message: 'Claude Code 2.1.300 is not logged in. Run `claude` in a terminal and use /login.',
  }
  const adapter = await loadAdapter()
  const begin = await adapter.beginAuth?.({connection: null, providerKind: 'claude-code'})
  const health = await adapter.health({
    connection,
    runtimeCredentials: {apiKey: null, baseURL: null, headers: {}, secretRef: null},
  })

  expect(begin?.status).toBe('unsupported')
  expect(begin?.message).toContain('/login')
  expect(health).toMatchObject({ok: false})
  expect(health.lastError).toContain('/login')
})

test('Claude Code health reports the account and the listed model count', async () => {
  const adapter = await loadAdapter()
  const health = await adapter.testConnection({
    connection,
    runtimeCredentials: {apiKey: null, baseURL: null, headers: {}, secretRef: null},
  })

  expect(health.ok).toBe(true)
  expect(health.modelCount).toBe(1)
  expect(health.message).toContain('me@example.com (max)')
})

test('Claude Code listModels carries reasoning-effort discovery metadata and default enablement', async () => {
  const adapter = await loadAdapter()
  const [listed] = await adapter.listModels({
    connection,
    runtimeCredentials: {apiKey: null, baseURL: null, headers: {}, secretRef: null},
  })

  expect(listed).toMatchObject({defaultEnabled: true, modelName: 'claude-opus-5-5', variant: 'high'})
  expect(listed?.metadataJson).toMatchObject({
    discovery: {capabilities: {reasoningEfforts: ['low', 'high']}, providerKind: 'claude-code'},
  })
})

test('Claude Code invoke passes the model id, effort, schema, and prompts to the CLI transport', async () => {
  const adapter = await loadAdapter()
  const signal = new AbortController().signal

  await adapter.invoke({
    connection,
    model,
    request: {
      maxCompletionTokens: 4096,
      outputSchema: {type: 'object'},
      prompt: 'prompt',
      signal,
      systemPrompt: 'system',
      temperature: 0.2,
    },
    runtimeCredentials: {apiKey: null, baseURL: 'claude-code://cli', headers: {}, secretRef: null},
  })

  expect(state.invoke).toHaveBeenCalledWith({
    effort: 'high',
    modelName: 'claude-opus-5-5',
    outputSchema: {type: 'object'},
    prompt: 'prompt',
    signal,
    systemPrompt: 'system',
  })
})

import {expect, test} from 'bun:test'

import {
  getProviderCatalogEntry,
  isClaudeCodeProvider,
  isLocalCliProvider,
  isOpenAICompatibleProvider,
  normalizeProviderKind,
} from './providerCatalog.ts'

test('provider catalog exposes Claude Code as a secretless CLI provider', () => {
  expect(normalizeProviderKind(' Claude-Code ')).toBe('claude-code')
  expect(isClaudeCodeProvider('claude-code')).toBe(true)
  expect(isLocalCliProvider('claude-code')).toBe(true)
  expect(isLocalCliProvider('codex')).toBe(true)
  expect(isLocalCliProvider('anthropic')).toBe(false)
  expect(isOpenAICompatibleProvider('claude-code')).toBe(false)
  expect(getProviderCatalogEntry('claude-code')).toEqual({
    defaultBaseURL: null,
    description: 'Claude Code CLI using your claude.ai subscription login',
    kind: 'claude-code',
    label: 'Claude Code',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  })
})

test('provider catalog normalizes llamacpp and returns its local defaults', () => {
  const entry = getProviderCatalogEntry('LLAMACPP')

  expect(normalizeProviderKind('LLAMACPP')).toBe('llamacpp')
  expect(isOpenAICompatibleProvider('llamacpp')).toBe(true)
  expect(entry).toEqual({
    defaultBaseURL: 'http://127.0.0.1:8080',
    description: 'Local llama.cpp llama-server OpenAI-compatible endpoint',
    kind: 'llamacpp',
    label: 'llama.cpp / llama-server',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  })
})

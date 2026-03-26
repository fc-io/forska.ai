import {expect, test} from 'bun:test'

import {requireProviderRegistryEntry} from './providerRegistry.ts'

test('provider registry returns direct adapters for primary providers', () => {
  expect(requireProviderRegistryEntry('openai').transportFamily).toBe('openai-responses')
  expect(requireProviderRegistryEntry('codex').transportFamily).toBe('codex-app')
  expect(requireProviderRegistryEntry('docling').transportFamily).toBe('docling-convert')
  expect(requireProviderRegistryEntry('anthropic').transportFamily).toBe('anthropic-messages')
  expect(requireProviderRegistryEntry('google').transportFamily).toBe('gemini-generate-content')
})

test('provider registry returns explicit adapters for OpenAI-compatible providers', () => {
  expect(requireProviderRegistryEntry('openrouter').transportFamily).toBe('openai-chat')
  expect(requireProviderRegistryEntry('ollama').transportFamily).toBe('ollama-native-discovery')
  expect(requireProviderRegistryEntry('llmstudio').transportFamily).toBe('openai-chat')
  expect(requireProviderRegistryEntry('llamacpp').transportFamily).toBe('openai-chat')
  expect(requireProviderRegistryEntry('sglang').transportFamily).toBe('openai-chat')
  expect(requireProviderRegistryEntry('vllm').transportFamily).toBe('openai-chat')
})

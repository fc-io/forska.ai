import {expect, test} from 'bun:test'

import {
  getPersistedProviderModelOptions,
  getProviderModelEffectiveVariant,
  getProviderModelOptions,
  getProviderModelOptionsVariant,
  getProviderModelSupportedOptions,
  getProviderModelThinkingOption,
} from './providerModelOptions.ts'

test('normalizes provider model thinking options', () => {
  expect(getProviderModelThinkingOption('enabled')).toBe('enabled')
  expect(getProviderModelThinkingOption(' disabled ')).toBe('disabled')
  expect(getProviderModelThinkingOption('High')).toBe('high')
  expect(getProviderModelThinkingOption(' xhigh ')).toBe('xhigh')
  expect(getProviderModelThinkingOption(' max ')).toBe('max')
  expect(getProviderModelThinkingOption('thinking')).toBe('enabled')
  expect(getProviderModelThinkingOption('non-thinking')).toBe('disabled')
  expect(getProviderModelThinkingOption('other')).toBeNull()
})

test('reads provider model options from metadata', () => {
  expect(getProviderModelOptions({options: {thinking: 'enabled'}})).toEqual({thinking: 'enabled'})
  expect(getProviderModelOptions({options: {thinking: 'disabled'}})).toEqual({thinking: 'disabled'})
  expect(getProviderModelOptions({options: {thinking: 'medium'}})).toEqual({thinking: 'medium'})
  expect(getProviderModelOptions({options: {thinkingMode: 'enabled'}})).toEqual({
    thinking: null,
    thinkingMode: 'enabled',
  })
  expect(getProviderModelOptions({options: {thinking_mode: 'disabled'}})).toEqual({
    thinking: null,
    thinkingMode: 'disabled',
  })
  expect(getProviderModelOptions(null)).toEqual({thinking: null})
})

test('reads supported provider model options from discovery metadata', () => {
  expect(getProviderModelSupportedOptions({discovery: {capabilities: {supportedOptions: {thinking: true}}}})).toEqual({
    thinking: true,
  })
  expect(getProviderModelSupportedOptions({discovery: {capabilities: {reasoningEfforts: ['low']}}})).toEqual({
    thinking: true,
  })
  expect(getProviderModelSupportedOptions({})).toEqual({thinking: false})
})

test('persists provider model options only when set', () => {
  expect(getPersistedProviderModelOptions({thinking: 'enabled'})).toEqual({thinking: 'enabled'})
  expect(getPersistedProviderModelOptions({thinking: null, thinkingMode: 'enabled'})).toEqual({thinkingMode: 'enabled'})
  expect(getPersistedProviderModelOptions({thinking: null, thinkingMode: null})).toBeNull()
})

test('builds provider model option variants for runtime reasoning settings', () => {
  expect(getProviderModelOptionsVariant({thinking: 'max', thinkingMode: 'enabled'})).toBe(
    'reasoning-max--thinking-enabled',
  )
  expect(getProviderModelOptionsVariant({thinking: null, thinkingMode: 'disabled'})).toBe('thinking-disabled')
  expect(
    getProviderModelEffectiveVariant({
      options: {thinking: 'high', thinkingMode: 'enabled'},
      provider: 'sglang',
      remoteModelId: 'deepseek-ai/DeepSeek-V4-Flash',
      variant: null,
    }),
  ).toBe('reasoning-high--thinking-enabled')
  expect(
    getProviderModelEffectiveVariant({
      options: {thinking: 'high', thinkingMode: 'enabled'},
      provider: 'sglang',
      remoteModelId: 'deepseek-ai/DeepSeek-V4-Flash',
      variant: 'custom',
    }),
  ).toBe('custom')
  expect(
    getProviderModelEffectiveVariant({
      options: {thinking: 'high', thinkingMode: 'enabled'},
      provider: 'openrouter',
      remoteModelId: 'deepseek/deepseek-v4',
      variant: null,
    }),
  ).toBeNull()
})

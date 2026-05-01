import {expect, test} from 'bun:test'

import {
  getPersistedProviderModelOptions,
  getProviderModelOptions,
  getProviderModelSupportedOptions,
  getProviderModelThinkingOption,
} from './providerModelOptions.ts'

test('normalizes provider model thinking options', () => {
  expect(getProviderModelThinkingOption('enabled')).toBe('enabled')
  expect(getProviderModelThinkingOption(' disabled ')).toBe('disabled')
  expect(getProviderModelThinkingOption('High')).toBe('high')
  expect(getProviderModelThinkingOption(' xhigh ')).toBe('xhigh')
  expect(getProviderModelThinkingOption('thinking')).toBe('enabled')
  expect(getProviderModelThinkingOption('non-thinking')).toBe('disabled')
  expect(getProviderModelThinkingOption('other')).toBeNull()
})

test('reads provider model options from metadata', () => {
  expect(getProviderModelOptions({options: {thinking: 'enabled'}})).toEqual({thinking: 'enabled'})
  expect(getProviderModelOptions({options: {thinking: 'disabled'}})).toEqual({thinking: 'disabled'})
  expect(getProviderModelOptions({options: {thinking: 'medium'}})).toEqual({thinking: 'medium'})
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
  expect(getPersistedProviderModelOptions({thinking: null})).toBeNull()
})

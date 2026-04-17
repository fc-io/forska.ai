import {expect, test} from 'bun:test'

import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
  getProviderModelThinkingBadgeLabel,
  stripProviderModelThinkingBadgeLabel,
} from './providerModelLabel.ts'

test('formats provider model thinking badge labels', () => {
  expect(getProviderModelThinkingBadgeLabel('enabled')).toBe('thinking: enabled')
  expect(getProviderModelThinkingBadgeLabel('disabled')).toBe('thinking: disabled')
  expect(getProviderModelThinkingBadgeLabel('medium')).toBe('thinking: medium')
  expect(getProviderModelThinkingBadgeLabel(null)).toBeNull()
})

test('prefers explicit thinking options over provider version badges', () => {
  expect(getProviderModelThinkingBadgeValue({provider: 'anthropic', thinking: 'enabled', version: 'medium'})).toBe(
    'enabled',
  )
  expect(getProviderModelThinkingBadgeValue({provider: 'anthropic', thinking: null, version: 'medium'})).toBe('medium')
  expect(getProviderModelThinkingBadgeValue({provider: 'codex', thinking: null, version: 'low'})).toBe('low')
  expect(getProviderModelThinkingBadgeValue({provider: 'openai', thinking: null, version: 'high'})).toBeNull()
})

test('strips provider model thinking badge labels', () => {
  expect(stripProviderModelThinkingBadgeLabel('Qwen/Qwen3.5-27B (thinking: enabled)')).toBe('Qwen/Qwen3.5-27B')
  expect(stripProviderModelThinkingBadgeLabel('Qwen/Qwen3.5-27B')).toBe('Qwen/Qwen3.5-27B')
})

test('appends provider model thinking badge labels once', () => {
  expect(appendProviderModelThinkingBadgeLabel({label: 'Qwen/Qwen3.5-27B', thinking: 'enabled'})).toBe(
    'Qwen/Qwen3.5-27B (thinking: enabled)',
  )
  expect(
    appendProviderModelThinkingBadgeLabel({label: 'Qwen/Qwen3.5-27B (thinking: disabled)', thinking: 'enabled'}),
  ).toBe('Qwen/Qwen3.5-27B (thinking: enabled)')
})

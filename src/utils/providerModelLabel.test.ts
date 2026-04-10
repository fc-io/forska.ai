import {expect, test} from 'bun:test'

import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeLabel,
  stripProviderModelThinkingBadgeLabel,
} from './providerModelLabel.ts'

test('formats provider model thinking badge labels', () => {
  expect(getProviderModelThinkingBadgeLabel('enabled')).toBe('thinking: enabled')
  expect(getProviderModelThinkingBadgeLabel('disabled')).toBe('thinking: disabled')
  expect(getProviderModelThinkingBadgeLabel(null)).toBeNull()
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

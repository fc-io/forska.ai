import {expect, test} from 'bun:test'

import {
  getAnthropicSupportedThinkingEfforts,
  getAnthropicThinkingConfig,
  getAnthropicThinkingEffort,
} from './anthropicThinking.ts'

test('detects supported Anthropic thinking efforts by model generation', () => {
  expect(getAnthropicSupportedThinkingEfforts('claude-opus-4-7')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(getAnthropicSupportedThinkingEfforts('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
  expect(getAnthropicSupportedThinkingEfforts('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max'])
  expect(getAnthropicSupportedThinkingEfforts('claude-opus-4-5')).toEqual([])
})

test('normalizes Anthropic thinking effort values', () => {
  expect(getAnthropicThinkingEffort(' medium ')).toBe('medium')
  expect(getAnthropicThinkingEffort('xhigh')).toBe('xhigh')
  expect(getAnthropicThinkingEffort('enabled')).toBeNull()
})

test('builds adaptive Anthropic thinking config only for supported effort variants', () => {
  expect(getAnthropicThinkingConfig({modelName: 'claude-opus-4-7', version: 'xhigh'})).toEqual({
    outputConfig: {effort: 'xhigh'},
    thinking: {display: 'omitted', type: 'adaptive'},
  })
  expect(getAnthropicThinkingConfig({modelName: 'claude-opus-4-6', version: 'xhigh'})).toBeNull()
  expect(getAnthropicThinkingConfig({modelName: 'claude-opus-4-5', version: 'high'})).toBeNull()
})

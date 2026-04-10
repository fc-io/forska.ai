import {expect, test} from 'bun:test'

import {getQwen35ThinkingEnabled, getQwen35ThinkingVariant, isQwen35Model} from './qwen35Thinking.ts'

test('detects Qwen3.5 model ids', () => {
  expect(isQwen35Model('Qwen/Qwen3.5-27B')).toBe(true)
  expect(isQwen35Model('Qwen/Qwen3.5-122B-A10B')).toBe(true)
  expect(isQwen35Model('Qwen3.5-27B')).toBe(true)
  expect(isQwen35Model(' qwen/qwen3.5-27b ')).toBe(true)
  expect(isQwen35Model('Qwen/Qwen3-32B')).toBe(false)
})

test('normalizes Qwen3.5 thinking variants', () => {
  expect(getQwen35ThinkingVariant('thinking')).toBe('thinking')
  expect(getQwen35ThinkingVariant(' non-thinking ')).toBe('non-thinking')
  expect(getQwen35ThinkingVariant('disabled')).toBeNull()
  expect(getQwen35ThinkingVariant(null)).toBeNull()
})

test('enables Qwen3.5 thinking only for the thinking variant', () => {
  expect(getQwen35ThinkingEnabled('thinking')).toBe(true)
  expect(getQwen35ThinkingEnabled('non-thinking')).toBe(false)
  expect(getQwen35ThinkingEnabled(null)).toBe(false)
})

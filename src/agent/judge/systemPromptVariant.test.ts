import {expect, test} from 'bun:test'

import {
  defaultSystemPromptVariant,
  getSystemPromptVariant,
  newProjectSystemPromptVariant,
  systemPromptVariantAllowsArticleMetadataQuotes,
  systemPromptVariants,
} from './systemPromptVariant.ts'

test('screening_v2 to screening_v5 are registered variants and screening_v5 is the default for new projects', () => {
  expect(systemPromptVariants).toEqual([
    'legacy',
    'screening_v1',
    'screening_v2',
    'screening_v3',
    'screening_v4',
    'screening_v5',
  ])
  expect(defaultSystemPromptVariant).toBe('legacy')
  expect(newProjectSystemPromptVariant).toBe('screening_v5')
  expect(getSystemPromptVariant('screening_v2')).toBe('screening_v2')
  expect(getSystemPromptVariant('screening_v3')).toBe('screening_v3')
  expect(getSystemPromptVariant('screening_v4')).toBe('screening_v4')
  expect(getSystemPromptVariant('screening_v5')).toBe('screening_v5')
  expect(getSystemPromptVariant('screening_v6')).toBe('legacy')
})

test('only screening_v2 to screening_v5 let the model quote the article_metadata block', () => {
  expect(
    [...systemPromptVariants, null, undefined, 'screening_v6'].map((variant) => {
      return [variant, systemPromptVariantAllowsArticleMetadataQuotes(variant)]
    }),
  ).toEqual([
    ['legacy', false],
    ['screening_v1', false],
    ['screening_v2', true],
    ['screening_v3', true],
    ['screening_v4', true],
    ['screening_v5', true],
    [null, false],
    [undefined, false],
    ['screening_v6', false],
  ])
})

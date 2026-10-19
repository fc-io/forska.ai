import {expect, test} from 'bun:test'

import {
  covidenceSystemPromptVariant,
  defaultSystemPromptVariant,
  getSystemPromptVariant,
  systemPromptVariantAllowsArticleMetadataQuotes,
  systemPromptVariants,
} from './systemPromptVariant.ts'

test('screening_v2 is a registered variant and the default for new Covidence projects', () => {
  expect(systemPromptVariants).toEqual(['legacy', 'screening_v1', 'screening_v2'])
  expect(defaultSystemPromptVariant).toBe('legacy')
  expect(covidenceSystemPromptVariant).toBe('screening_v2')
  expect(getSystemPromptVariant('screening_v2')).toBe('screening_v2')
  expect(getSystemPromptVariant('screening_v3')).toBe('legacy')
})

test('only screening_v2 lets the model quote the article_metadata block', () => {
  expect(
    [...systemPromptVariants, null, undefined, 'screening_v3'].map((variant) => {
      return [variant, systemPromptVariantAllowsArticleMetadataQuotes(variant)]
    }),
  ).toEqual([
    ['legacy', false],
    ['screening_v1', false],
    ['screening_v2', true],
    [null, false],
    [undefined, false],
    ['screening_v3', false],
  ])
})

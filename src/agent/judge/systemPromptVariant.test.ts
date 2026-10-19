import {expect, test} from 'bun:test'

import {
  covidenceSystemPromptVariant,
  defaultSystemPromptVariant,
  getSystemPromptVariant,
  systemPromptVariantAllowsArticleMetadataQuotes,
  systemPromptVariants,
} from './systemPromptVariant.ts'

test('screening_v2 is a registered variant and the default for new Covidence projects', () => {
  expect(systemPromptVariants).toEqual(['legacy', 'screening_v1', 'screening_v2', 'screening_v3'])
  expect(defaultSystemPromptVariant).toBe('legacy')
  expect(covidenceSystemPromptVariant).toBe('screening_v2')
  expect(getSystemPromptVariant('screening_v2')).toBe('screening_v2')
  expect(getSystemPromptVariant('screening_v3')).toBe('screening_v3')
  expect(getSystemPromptVariant('screening_v4')).toBe('legacy')
})

test('only screening_v2 and screening_v3 let the model quote the article_metadata block', () => {
  expect(
    [...systemPromptVariants, null, undefined, 'screening_v4'].map((variant) => {
      return [variant, systemPromptVariantAllowsArticleMetadataQuotes(variant)]
    }),
  ).toEqual([
    ['legacy', false],
    ['screening_v1', false],
    ['screening_v2', true],
    ['screening_v3', true],
    [null, false],
    [undefined, false],
    ['screening_v4', false],
  ])
})

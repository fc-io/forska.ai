import {expect, test} from 'bun:test'

import {checkFulltextTokenBudget} from './fulltextProcessing.ts'

test('checkFulltextTokenBudget treats the supplied limit as prompt budget', () => {
  const promptTokenLimit = 30768
  const text = 'x'.repeat(28768 * 4)
  const result = checkFulltextTokenBudget(text, promptTokenLimit)

  expect(result.withinBudget).toBe(true)
  expect(result.tokenCount).toBe(28768)
  expect(result.maxTokens).toBe(28768)
})

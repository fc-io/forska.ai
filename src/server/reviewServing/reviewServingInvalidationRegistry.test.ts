import {expect, test} from 'bun:test'

import {reviewServingChangeKinds} from './reviewServingContracts.ts'
import {
  getReviewServingInvalidationRule,
  getReviewServingInvalidationRuleOrNull,
  getUnmappedReviewServingChangeKinds,
} from './reviewServingInvalidationRegistry.ts'

test('reviewServingInvalidationRegistry maps every Phase 0 change kind', () => {
  const unmapped = getUnmappedReviewServingChangeKinds()

  expect(unmapped).toEqual([])
  expect(reviewServingChangeKinds.map(getReviewServingInvalidationRule)).toHaveLength(reviewServingChangeKinds.length)
})

test('LLM judgment changes do not invalidate display, selected import, or search components', () => {
  const rule = getReviewServingInvalidationRule('judgment.llm.updated')

  expect(rule.firstAffectedComponent).toBe('llmStatus')
  expect(rule.affectedComponents).toContain('llmStatus')
  expect(rule.affectedComponents).toContain('queue')
  expect(rule.affectedComponents).not.toContain('display')
  expect(rule.affectedComponents).not.toContain('selectedImport')
  expect(rule.affectedComponents).not.toContain('search')
})

test('search text changes are search-only at the first projection step', () => {
  const rule = getReviewServingInvalidationRule('article.searchText.updated')

  expect(rule.firstAffectedComponent).toBe('search')
  expect(rule.affectedComponents).toEqual(['search'])
})

test('unknown change kinds are not treated as broad project invalidation', () => {
  const rule = getReviewServingInvalidationRuleOrNull('project.everything.changed')

  expect(rule).toBeNull()
})

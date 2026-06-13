import {expect, test} from 'bun:test'

import {reviewServingChangeKinds, reviewServingProjectionComponents} from './reviewServingContracts.ts'
import {
  getReviewServingInvalidationRule,
  getReviewServingInvalidationRuleOrNull,
  getUnmappedReviewServingChangeKinds,
} from './reviewServingInvalidationRegistry.ts'

test('reviewServingInvalidationRegistry maps every Phase 0 change kind', () => {
  const unmapped = getUnmappedReviewServingChangeKinds()
  const rules = reviewServingChangeKinds.map(getReviewServingInvalidationRule)

  expect(unmapped).toEqual([])
  expect(rules).toHaveLength(reviewServingChangeKinds.length)
  expect(
    rules.map((rule) => {
      return rule.firstAffectedComponent
    }),
  ).not.toContain(undefined)
  expect(
    rules.map((rule) => {
      return rule.updateMode
    }),
  ).not.toContain(undefined)
  expect(
    rules.filter((rule) => {
      return rule.requiredKeys.length === 0
    }),
  ).toEqual([])
  expect(
    rules.filter((rule) => {
      const affectedComponentSet = new Set(rule.affectedComponents)

      return (
        !affectedComponentSet.has(rule.firstAffectedComponent)
        || rule.downstreamDependents.some((component) => {
          return !affectedComponentSet.has(component)
        })
      )
    }),
  ).toEqual([])
})

test('LLM judgment changes do not invalidate display, selected import, or search components', () => {
  const llmJudgmentRules = reviewServingChangeKinds
    .filter((changeKind) => {
      return changeKind.startsWith('judgment.llm.')
    })
    .map(getReviewServingInvalidationRule)

  expect(llmJudgmentRules).toHaveLength(3)
  expect(
    llmJudgmentRules.map((rule) => {
      return rule.firstAffectedComponent
    }),
  ).toEqual(['llmStatus', 'llmStatus', 'llmStatus'])
  expect(
    llmJudgmentRules.map((rule) => {
      return rule.affectedComponents
    }),
  ).toEqual([
    ['llmStatus', 'queue', 'posting', 'summary'],
    ['llmStatus', 'queue', 'posting', 'summary'],
    ['llmStatus', 'queue', 'posting', 'summary'],
  ])
  expect(
    llmJudgmentRules.flatMap((rule) => {
      return rule.affectedComponents.filter((component) => {
        return ['display', 'selectedImport', 'search'].includes(component)
      })
    }),
  ).toEqual([])
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

test('registered invalidation components stay within the published projection vocabulary', () => {
  const componentSet = new Set(reviewServingProjectionComponents)
  const unknownComponents = reviewServingChangeKinds
    .map(getReviewServingInvalidationRule)
    .flatMap((rule) => {
      return [rule.firstAffectedComponent, ...rule.affectedComponents, ...rule.downstreamDependents]
    })
    .filter((component) => {
      return !componentSet.has(component)
    })

  expect(unknownComponents).toEqual([])
})

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

test('every emitted delta kind declares complete invalidation metadata', () => {
  const rules = reviewServingChangeKinds.map(getReviewServingInvalidationRule)
  const incompleteRules = rules.filter((rule) => {
    return (
      rule.changeKind.length === 0
      || rule.firstAffectedComponent.length === 0
      || rule.affectedComponents.length === 0
      || rule.requiredKeys.length === 0
      || rule.updateMode.length === 0
      || !rule.requiredKeys.includes('sourceHighWaterMark')
      || !rule.affectedComponents.includes(rule.firstAffectedComponent)
      || rule.downstreamDependents.some((component) => {
        return !rule.affectedComponents.includes(component)
      })
    )
  })

  expect(incompleteRules).toEqual([])
  expect(
    rules.map((rule) => {
      return [
        rule.changeKind,
        rule.firstAffectedComponent,
        rule.downstreamDependents,
        rule.requiredKeys,
        rule.updateMode,
      ]
    }),
  ).toEqual([
    [
      'article.display.updated',
      'display',
      ['payload', 'posting', 'summary'],
      ['articleId', 'changedDisplayFieldNames', 'sourceHighWaterMark'],
      'componentPatch',
    ],
    [
      'article.searchText.updated',
      'search',
      [],
      ['articleId', 'changedSearchableFieldNames', 'sourceHighWaterMark'],
      'componentPatch',
    ],
    [
      'article.judgmentInput.updated',
      'judgmentInputContent',
      ['llmStatus', 'queue', 'posting', 'summary', 'payload'],
      ['articleId', 'affectedContentFlags', 'sourceHighWaterMark'],
      'componentPatch',
    ],
    [
      'importRoute.article.added',
      'projectScope',
      ['selectedImport', 'llmStatus', 'humanStatus', 'queue', 'posting', 'summary', 'payload'],
      ['importRouteId', 'articleId', 'importSourceRecordKey', 'sourceHighWaterMark'],
      'appendPatch',
    ],
    [
      'importRoute.article.removed',
      'projectScope',
      ['selectedImport', 'llmStatus', 'humanStatus', 'queue', 'posting', 'summary', 'payload'],
      ['importRouteId', 'articleId', 'importSourceRecordKey', 'sourceHighWaterMark'],
      'appendPatch',
    ],
    [
      'importRoute.article.rankFields.updated',
      'selectedImport',
      ['posting', 'summary'],
      ['importRouteId', 'articleId', 'changedRankFilterFields', 'sourceHighWaterMark'],
      'componentPatch',
    ],
    [
      'projectScope.article.added',
      'projectScope',
      ['selectedImport', 'llmStatus', 'humanStatus', 'queue', 'posting', 'search', 'summary', 'payload'],
      ['projectId', 'articleId', 'projectArticleId', 'sourceHighWaterMark'],
      'appendPatch',
    ],
    [
      'projectScope.article.removed',
      'projectScope',
      ['selectedImport', 'llmStatus', 'humanStatus', 'queue', 'posting', 'search', 'summary', 'payload'],
      ['projectId', 'articleId', 'projectArticleId', 'sourceHighWaterMark'],
      'appendPatch',
    ],
    [
      'judgment.llm.created',
      'llmStatus',
      ['queue', 'posting', 'summary', 'payload'],
      ['projectId', 'articleId', 'promptId', 'modelId', 'contentFlags', 'judgmentId', 'sourceHighWaterMark'],
      'contributionDiff',
    ],
    [
      'judgment.llm.updated',
      'llmStatus',
      ['queue', 'posting', 'summary', 'payload'],
      ['projectId', 'articleId', 'promptId', 'modelId', 'contentFlags', 'judgmentId', 'sourceHighWaterMark'],
      'contributionDiff',
    ],
    [
      'judgment.llm.deleted',
      'llmStatus',
      ['queue', 'posting', 'summary', 'payload'],
      ['projectId', 'articleId', 'promptId', 'modelId', 'contentFlags', 'judgmentId', 'sourceHighWaterMark'],
      'contributionDiff',
    ],
    [
      'judgment.human.updated',
      'humanStatus',
      ['queue', 'posting', 'summary', 'payload'],
      ['projectId', 'articleId', 'humanJudgmentKey', 'sourceHighWaterMark'],
      'contributionDiff',
    ],
    [
      'prompt.config.updated',
      'llmStatus',
      ['queue', 'posting', 'summary', 'payload'],
      ['projectId', 'promptId', 'changedPromptConfigFields', 'sourceHighWaterMark'],
      'promptScopedRebuild',
    ],
    [
      'project.reviewConfig.updated',
      'projectScope',
      [
        'selectedImport',
        'judgmentInputContent',
        'llmStatus',
        'humanStatus',
        'queue',
        'posting',
        'search',
        'summary',
        'payload',
      ],
      ['projectId', 'changedReviewConfigFields', 'sourceHighWaterMark'],
      'componentRebuild',
    ],
  ])
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
    ['llmStatus', 'queue', 'posting', 'summary', 'payload'],
    ['llmStatus', 'queue', 'posting', 'summary', 'payload'],
    ['llmStatus', 'queue', 'posting', 'summary', 'payload'],
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

test('judgment input changes invalidate dependent LLM facts and payload rows', () => {
  const rule = getReviewServingInvalidationRule('article.judgmentInput.updated')

  expect(rule.firstAffectedComponent).toBe('judgmentInputContent')
  expect(rule.affectedComponents).toEqual([
    'judgmentInputContent',
    'llmStatus',
    'queue',
    'posting',
    'summary',
    'payload',
  ])
  expect(rule.downstreamDependents).toEqual(['llmStatus', 'queue', 'posting', 'summary', 'payload'])
})

test('human judgment updates do not require prompt-scoped keys', () => {
  const rule = getReviewServingInvalidationRule('judgment.human.updated')

  expect(rule.requiredKeys).toEqual(['projectId', 'articleId', 'humanJudgmentKey', 'sourceHighWaterMark'])
  expect(rule.affectedComponents).toEqual(['humanStatus', 'queue', 'posting', 'summary', 'payload'])
  expect(rule.downstreamDependents).toEqual(['queue', 'posting', 'summary', 'payload'])
})

test('review config changes invalidate judgment input content for content flag changes', () => {
  const rule = getReviewServingInvalidationRule('project.reviewConfig.updated')

  expect(rule.firstAffectedComponent).toBe('projectScope')
  expect(rule.affectedComponents).toContain('projectScope')
  expect(rule.affectedComponents).toContain('selectedImport')
  expect(rule.affectedComponents).toContain('judgmentInputContent')
  expect(rule.affectedComponents).toContain('search')
  expect(rule.affectedComponents).toContain('payload')
  expect(rule.downstreamDependents).toEqual([
    'selectedImport',
    'judgmentInputContent',
    'llmStatus',
    'humanStatus',
    'queue',
    'posting',
    'search',
    'summary',
    'payload',
  ])
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

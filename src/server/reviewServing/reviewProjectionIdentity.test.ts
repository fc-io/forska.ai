import {expect, test} from 'bun:test'

import {
  buildPromptConfigHash,
  buildReviewConfigHash,
  buildReviewProjectionIdentity,
  buildSummaryDefinitionIdentity,
  getStableReviewServingJson,
} from './reviewProjectionIdentity.ts'

test('getStableReviewServingJson is stable for equivalent object key order', () => {
  const left = getStableReviewServingJson({b: '2', a: {d: '4', c: '3'}})
  const right = getStableReviewServingJson({a: {c: '3', d: '4'}, b: '2'})

  expect(left).toBe(right)
})

test('buildReviewProjectionIdentity keeps projection components narrow', () => {
  const displayIdentity = buildReviewProjectionIdentity({
    component: 'display',
    definitionVersion: 'display:v1',
    upstreamDigests: {articleDisplay: 'digest-a'},
  })
  const searchIdentity = buildReviewProjectionIdentity({
    component: 'search',
    definitionVersion: 'search:v1',
    upstreamDigests: {articleDisplay: 'digest-a'},
  })

  expect(displayIdentity).not.toBe(searchIdentity)
  expect(displayIdentity.startsWith('display:')).toBe(true)
  expect(searchIdentity.startsWith('search:')).toBe(true)
})

test('buildReviewConfigHash sorts prompt configs before hashing', () => {
  const promptA = buildPromptConfigHash({
    answerSchemaHash: 'answer-a',
    promptId: 'prompt-a',
    promptTextHash: 'text-a',
    settingsVersion: 'settings:v1',
    thresholdVersion: null,
  })
  const promptB = buildPromptConfigHash({
    answerSchemaHash: 'answer-b',
    promptId: 'prompt-b',
    promptTextHash: 'text-b',
    settingsVersion: 'settings:v1',
    thresholdVersion: null,
  })
  const left = buildReviewConfigHash({
    modelId: 'model-a',
    promptConfigs: [
      {promptConfigHash: promptB, promptId: 'prompt-b'},
      {promptConfigHash: promptA, promptId: 'prompt-a'},
    ],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  const right = buildReviewConfigHash({
    modelId: 'model-a',
    promptConfigs: [
      {promptConfigHash: promptA, promptId: 'prompt-a'},
      {promptConfigHash: promptB, promptId: 'prompt-b'},
    ],
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })

  expect(left).toBe(right)
})

test('buildSummaryDefinitionIdentity sorts contribution keys before hashing', () => {
  const left = buildSummaryDefinitionIdentity({
    contributionKeys: ['answer:yes', 'answer:no'],
    summaryDefinitionVersion: 'summary:v1',
  })
  const right = buildSummaryDefinitionIdentity({
    contributionKeys: ['answer:no', 'answer:yes'],
    summaryDefinitionVersion: 'summary:v1',
  })

  expect(left).toBe(right)
})

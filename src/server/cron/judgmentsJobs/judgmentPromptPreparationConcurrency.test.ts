import {expect, test} from 'bun:test'

import {getJudgmentPromptQueueTargetFromProviderLimit} from './judgmentBacklogController.ts'
import {
  getPromptPreparationConcurrencyLimit,
  promptPreparationConcurrencyBounds,
} from './judgmentsJobsSendToLLM/processPromptWithLLM.ts'

test('prompt preparation concurrency is dynamic and bounded', () => {
  expect(getPromptPreparationConcurrencyLimit({providerMaxInflightRequests: null})).toBe(
    promptPreparationConcurrencyBounds.minimum,
  )
  expect(getPromptPreparationConcurrencyLimit({providerMaxInflightRequests: 1})).toBe(
    promptPreparationConcurrencyBounds.minimum,
  )
  expect(getPromptPreparationConcurrencyLimit({providerMaxInflightRequests: 8})).toBe(16)
  expect(getPromptPreparationConcurrencyLimit({providerMaxInflightRequests: 10_000})).toBe(
    promptPreparationConcurrencyBounds.maximum,
  )
})

test('prompt pipeline width preserves small-provider headroom and scales to large provider limits', () => {
  expect(getJudgmentPromptQueueTargetFromProviderLimit({providerMaxInflightRequests: 1})).toEqual({
    activePromptLimit: 2,
    queuedPromptLimit: 1,
  })
  expect(
    getJudgmentPromptQueueTargetFromProviderLimit({providerMaxInflightRequests: 2, providerPromptBacklogTarget: 6}),
  ).toEqual({activePromptLimit: 4, queuedPromptLimit: 2})
  expect(getJudgmentPromptQueueTargetFromProviderLimit({providerMaxInflightRequests: 300})).toEqual({
    activePromptLimit: 512,
    queuedPromptLimit: 88,
  })
})

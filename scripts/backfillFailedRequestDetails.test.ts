import {expect, test} from 'bun:test'

import {getFailedRequestDetailsRowAnalysis} from './backfillFailedRequestDetails.ts'

const buildFailedRequestDetail = () => {
  return {
    articleId: 'article-1',
    promptIds: ['prompt-1'],
    modelId: 'model-1',
    modelName: 'model-name',
    baseURL: 'http://worker-a/v1',
    failureType: 'retry',
    attempts: 2,
    failedAttempts: 1,
    failedPromptTokens: 10,
    failedCompletionTokens: 5,
    failedTotalTokens: 15,
    error: 'Invalid JSON response',
    sanitizationAttempted: false,
    sanitizedError: null,
    sanitizedResponse: null,
    lastResponse: '{bad json}',
    systemPrompt: 'system',
    userPrompt: 'user',
  }
}

test('getFailedRequestDetailsRowAnalysis normalizes legacy string entries', () => {
  const detail = buildFailedRequestDetail()
  const analysis = getFailedRequestDetailsRowAnalysis({
    id: 'token-use-1',
    failedRequestsDetailsJson: JSON.stringify([JSON.stringify(detail)]),
  })

  expect(analysis.legacyStringCount).toBe(1)
  expect(analysis.unsupportedLegacyStringCount).toBe(0)
  expect(analysis.patch?.failedRequestsDetails).toEqual([detail])
})

test('getFailedRequestDetailsRowAnalysis leaves unsupported strings untouched', () => {
  const analysis = getFailedRequestDetailsRowAnalysis({
    id: 'token-use-2',
    failedRequestsDetailsJson: JSON.stringify(['not-json-object']),
  })

  expect(analysis.legacyStringCount).toBe(0)
  expect(analysis.unsupportedLegacyStringCount).toBe(1)
  expect(analysis.patch).toBeNull()
})

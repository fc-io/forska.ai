import {expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

import {judgmentCompletionBodySchema} from '../judgmentsJobsRoutes/judgmentsJobsRoutesSchemas.ts'

const calls: unknown[] = []

void mock.module('../../services/providerCostQueryService.ts', () => {
  return {
    getProviderCostByHour: async (input: unknown) => {
      calls.push(input)
      return {hours: [], quota: []}
    },
  }
})

const {tokensRoutes} = await import('../TokensRoutes.ts')

const postCostByHour = (body: unknown) => {
  return tokensRoutes.handle(
    new Request('http://localhost/api/tokens/cost-by-hour', {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

test('cost-by-hour accepts optional from, to and jobId and passes parsed dates to the service', async () => {
  const response = await postCostByHour({from: '2026-11-06T10:00:00Z', jobId: 'job-1', to: '2026-11-06T12:00:00Z'})

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({data: {hours: [], quota: []}, error: null})
  expect(calls.at(-1)).toEqual({
    query: {from: new Date('2026-11-06T10:00:00Z'), jobId: 'job-1', to: new Date('2026-11-06T12:00:00Z')},
  })
})

test('cost-by-hour accepts an empty body as an unbounded window', async () => {
  const response = await postCostByHour({})

  expect(response.status).toBe(200)
  expect(calls.at(-1)).toEqual({query: {from: null, jobId: null, to: null}})
})

test('cost-by-hour rejects a non-string from in the schema and an inverted window in the handler', async () => {
  const callsBefore = calls.length

  expect((await postCostByHour({from: 1_762_423_200_000})).status).toBe(422)
  expect((await postCostByHour({from: '2026-11-06T12:00:00Z', to: '2026-11-06T10:00:00Z'})).status).toBe(400)
  expect(calls.length).toBe(callsBefore)
})

test('the completion route schema keeps the token breakdown and call identity instead of stripping them', async () => {
  const app = new Elysia().post(
    '/complete',
    ({body}) => {
      return body.tokenUse
    },
    {body: judgmentCompletionBodySchema},
  )
  const tokenUse = {
    failedRequests: 0,
    failedRequestsDetails: [],
    hasFailedRequests: false,
    modelId: 'model-opus-high',
    modelName: 'claude-opus-5-5',
    providerConnectionId: 'conn-claude',
    providerKind: 'claude-code',
    successfulRequests: 1,
    totalCacheCreationInputTokens: 600,
    totalCacheReadInputTokens: null,
    totalCompletionTokens: 200,
    totalFailedCompletionTokens: 0,
    totalFailedPromptTokens: 0,
    totalFailedTokens: 0,
    totalPromptTokens: 1000,
    totalRequests: 1,
    totalSuccessCompletionTokens: 200,
    totalSuccessPromptTokens: 1000,
    totalSuccessTokens: 1200,
    totalThinkingTokens: 50,
    totalTokens: 1200,
  }
  const response = await app.handle(
    new Request('http://localhost/complete', {
      body: JSON.stringify({
        articleId: 'article-1',
        claimId: 'claim-1',
        executionSnapshotHash: 'hash-1',
        executionSnapshotId: 'snapshot-1',
        jobId: 'job-1',
        modelId: 'model-opus-high',
        projectId: 'project-1',
        promptId: 'prompt-1',
        queueRecordId: 'queue-1',
        tokenUse,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    modelId: 'model-opus-high',
    providerConnectionId: 'conn-claude',
    providerKind: 'claude-code',
    totalCacheCreationInputTokens: 600,
    totalCacheReadInputTokens: null,
    totalThinkingTokens: 50,
  })
})

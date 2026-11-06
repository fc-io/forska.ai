import {beforeEach, expect, mock, test} from 'bun:test'

type OutboxRow = {completionJson: string; jobId: string; tokenUseId: string}

const state = {deleted: [] as string[][], enqueued: [] as OutboxRow[], inserted: [] as Array<Record<string, unknown>>[]}

void mock.module('./judgmentJobSqliteService.ts', () => {
  return {
    getJudgmentJobSqliteService: () => {
      return {
        deleteCompletionTokenUse: async (_jobId: string, tokenUseIds: string[]) => {
          state.deleted.push(tokenUseIds)
        },
        enqueueCompletionTokenUse: async (row: OutboxRow) => {
          state.enqueued.push(row)
        },
        getPendingCompletionTokenUse: async () => {
          return state.enqueued.map((row) => {
            return {completionJson: row.completionJson, tokenUseId: row.tokenUseId}
          })
        },
      }
    },
  }
})

void mock.module('../../services/tokenUseQueryService.ts', () => {
  return {
    getTokenUseQueryService: () => {
      return {
        insertTokenUsesOnce: async (values: Array<Record<string, unknown>>) => {
          state.inserted.push(values)
          return {conflicts: []}
        },
      }
    },
  }
})

const {drainCompletionTokenUseOutbox, enqueueCompletionTokenUse} = await import('./judgmentCompletionTokenUseOutbox.ts')

const baseTokenUse = {
  failedRequests: 0,
  failedRequestsDetails: [],
  finishedAt: '2026-11-06T10:15:00.000Z',
  hasFailedRequests: false,
  modelName: 'claude-opus-5-5',
  startedAt: '2026-11-06T10:14:00.000Z',
  successfulRequests: 1,
  totalCompletionTokens: 200,
  totalFailedCompletionTokens: 0,
  totalFailedPromptTokens: 0,
  totalFailedTokens: 0,
  totalPromptTokens: 1000,
  totalRequests: 1,
  totalSuccessCompletionTokens: 200,
  totalSuccessPromptTokens: 1000,
  totalSuccessTokens: 1200,
  totalTokens: 1200,
}

beforeEach(() => {
  state.deleted = []
  state.enqueued = []
  state.inserted = []
})

test('the breakdown and call identity survive the outbox JSON into the batched insert values', async () => {
  await enqueueCompletionTokenUse({
    claimId: 'claim-1',
    jobId: 'job-1',
    queueRecordId: 'queue-1',
    tokenUse: {
      ...baseTokenUse,
      modelId: 'model-opus-high',
      providerConnectionId: 'conn-claude',
      providerKind: 'claude-code',
      totalCacheCreationInputTokens: 600,
      totalCacheReadInputTokens: 300,
      totalThinkingTokens: 50,
    },
  })

  expect(await drainCompletionTokenUseOutbox('job-1')).toBe(1)
  expect(state.inserted).toHaveLength(1)
  expect(state.inserted[0]?.[0]).toMatchObject({
    cache_creation_input_tokens: 600,
    cache_read_input_tokens: 300,
    id: 'judgment-completion-token-use:claim-1',
    model_id: 'model-opus-high',
    model_name: 'claude-opus-5-5',
    provider_connection_id: 'conn-claude',
    provider_kind: 'claude-code',
    sglang_model: 'claude-opus-5-5',
    thinking_tokens: 50,
    total_completion_tokens: 200,
    total_prompt_tokens: 1000,
  })
  expect(state.deleted).toEqual([['judgment-completion-token-use:claim-1']])
})

test('an outbox row written before the breakdown existed inserts NULL, never zero', async () => {
  state.enqueued.push({
    completionJson: JSON.stringify({
      claimId: 'claim-old',
      jobId: 'job-1',
      queueRecordId: 'queue-old',
      tokenUse: baseTokenUse,
    }),
    jobId: 'job-1',
    tokenUseId: 'judgment-completion-token-use:claim-old',
  })

  await drainCompletionTokenUseOutbox('job-1')

  expect(state.inserted[0]?.[0]).toMatchObject({
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    model_id: null,
    model_name: 'claude-opus-5-5',
    provider_connection_id: null,
    provider_kind: null,
    thinking_tokens: null,
  })
})

test('one drain inserts every pending row in a single batch with one column set', async () => {
  await Promise.all(
    ['claim-a', 'claim-b'].map((claimId) => {
      return enqueueCompletionTokenUse({
        claimId,
        jobId: 'job-1',
        queueRecordId: `queue-${claimId}`,
        tokenUse: baseTokenUse,
      })
    }),
  )

  await drainCompletionTokenUseOutbox('job-1')

  expect(state.inserted).toHaveLength(1)
  expect(
    state.inserted[0]?.map((values) => {
      return Object.keys(values).join(',')
    }),
  ).toEqual([Object.keys(state.inserted[0]?.[0] ?? {}).join(','), Object.keys(state.inserted[0]?.[0] ?? {}).join(',')])
})

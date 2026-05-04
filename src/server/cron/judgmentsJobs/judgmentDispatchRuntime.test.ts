import {afterEach, expect, mock, test} from 'bun:test'

import {createJudgmentDispatchRuntime, shutdownJudgmentDispatchRuntime} from './judgmentDispatchRuntime.ts'
import type {PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const createSignal = () => {
  let resolve: () => void = () => {
    return undefined
  }
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return {promise, resolve}
}

const createPrompt = (overrides: Partial<PromptToProcess> = {}): PromptToProcess => {
  return {
    articleId: 'article-a',
    claimId: 'claim-a',
    executionSnapshotHash: 'snapshot-hash-a',
    executionSnapshotId: 'snapshot-a',
    jobId: 'job-a',
    modelBaseUrl: 'http://runtime.test/v1',
    modelId: 'model-a',
    modelMetadataJson: null,
    modelName: 'Model A',
    modelProvider: 'openai',
    modelSecretRef: null,
    modelVersion: null,
    modelWorkerUrls: [],
    projectId: 'project-a',
    promptId: 'prompt-a',
    providerConnectionId: 'connection-a',
    providerMaxInflightRequests: 1,
    providerUsesFamilyDefault: false,
    recordId: 'record-a',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
    ...overrides,
  }
}

afterEach(async () => {
  await shutdownJudgmentDispatchRuntime('test-cleanup')
})

test('bounds accepted prompts by provider queue capacity', async () => {
  const processPromptBatch = mock(async (_input: {label: string; prompts: PromptToProcess[]}) => {})
  const runtime = createJudgmentDispatchRuntime({processPromptBatch})

  const result = await runtime.enqueueClaimedPrompts({
    label: 'capacity-test',
    prompts: [
      createPrompt({articleId: 'article-1', promptId: 'prompt-1', recordId: 'record-1'}),
      createPrompt({articleId: 'article-2', promptId: 'prompt-2', recordId: 'record-2'}),
    ],
  })

  expect(result.acceptedCount).toBe(1)
  expect(
    result.rejectedPrompts.map((prompt) => {
      return prompt.recordId
    }),
  ).toEqual(['record-2'])
  expect(
    await runtime.getProviderQueueCapacity({
      providerConnectionId: 'connection-a',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
    }),
  ).toBeGreaterThanOrEqual(0)

  await runtime.shutdown('test-complete')
})

test('queues one prompt ahead of the active slot and starts it when capacity frees', async () => {
  const firstRelease = createSignal()
  const secondRelease = createSignal()
  const started: string[] = []
  const processPromptBatch = mock(async ({prompts}: {label: string; prompts: PromptToProcess[]}) => {
    const [firstPrompt] = prompts

    if (firstPrompt?.recordId === 'record-active') {
      started.push(firstPrompt.recordId)
      await firstRelease.promise
      return
    }

    if (firstPrompt?.recordId === 'record-queued') {
      started.push(firstPrompt.recordId)
      await secondRelease.promise
    }
  })
  const runtime = createJudgmentDispatchRuntime({processPromptBatch})

  const firstResult = await runtime.enqueueClaimedPrompts({
    label: 'active-headroom',
    prompts: [createPrompt({recordId: 'record-active'})],
  })

  await flush()

  const secondResult = await runtime.enqueueClaimedPrompts({
    label: 'active-headroom',
    prompts: [createPrompt({recordId: 'record-queued'})],
  })

  const thirdResult = await runtime.enqueueClaimedPrompts({
    label: 'active-headroom',
    prompts: [createPrompt({recordId: 'record-rejected'})],
  })

  expect(firstResult.acceptedCount).toBe(1)
  expect(secondResult.acceptedCount).toBe(1)
  expect(thirdResult.acceptedCount).toBe(0)
  expect(
    thirdResult.rejectedPrompts.map((prompt) => {
      return prompt.recordId
    }),
  ).toEqual(['record-rejected'])
  expect(started).toEqual(['record-active'])
  expect(
    await runtime.getProviderQueueCapacity({
      providerConnectionId: 'connection-a',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
    }),
  ).toBe(0)

  firstRelease.resolve()
  await flush()

  expect(started).toEqual(['record-active', 'record-queued'])

  secondRelease.resolve()
  await runtime.shutdown('test-complete')
})

test('applies lower provider caps without restart', async () => {
  const processPromptBatch = mock(async (_input: {label: string; prompts: PromptToProcess[]}) => {})
  const runtime = createJudgmentDispatchRuntime({processPromptBatch})

  expect(
    await runtime.getProviderQueueCapacity({
      providerConnectionId: 'connection-a',
      providerMaxInflightRequests: 2,
      providerUsesFamilyDefault: false,
    }),
  ).toBe(2)

  expect(
    await runtime.getProviderQueueCapacity({
      providerConnectionId: 'connection-a',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
    }),
  ).toBe(1)

  await runtime.shutdown('test-complete')
})

test('uses adaptive prompt backlog target when provided', async () => {
  const release = createSignal()
  const processPromptBatch = mock(async ({prompts}: {label: string; prompts: PromptToProcess[]}) => {
    const [firstPrompt] = prompts

    if (firstPrompt?.recordId === 'record-active') {
      await release.promise
    }
  })
  const runtime = createJudgmentDispatchRuntime({processPromptBatch})

  await runtime.enqueueClaimedPrompts({
    label: 'adaptive-target',
    prompts: [
      createPrompt({providerMaxInflightRequests: 2, providerPromptBacklogTarget: 6, recordId: 'record-active'}),
    ],
  })
  await flush()

  expect(
    await runtime.getProviderQueueCapacity({
      providerConnectionId: 'connection-a',
      providerMaxInflightRequests: 2,
      providerPromptBacklogTarget: 6,
      providerUsesFamilyDefault: false,
    }),
  ).toBe(4)

  release.resolve()
  await runtime.shutdown('test-complete')
})

test('reports job-local and provider dispatch stats separately', async () => {
  const release = createSignal()
  const processPromptBatch = mock(async ({prompts}: {label: string; prompts: PromptToProcess[]}) => {
    const [firstPrompt] = prompts

    if (firstPrompt?.recordId === 'record-active') {
      await release.promise
    }
  })
  const runtime = createJudgmentDispatchRuntime({processPromptBatch})

  await runtime.enqueueClaimedPrompts({
    label: 'stats',
    prompts: [createPrompt({jobId: 'job-a', recordId: 'record-active'})],
  })
  await flush()
  await runtime.enqueueClaimedPrompts({
    label: 'stats',
    prompts: [createPrompt({jobId: 'job-a', recordId: 'record-queued'})],
  })
  await flush()

  expect(
    await runtime.getProviderDispatchStats({
      jobId: 'job-a',
      providerConnectionId: 'connection-a',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
    }),
  ).toEqual({
    jobActivePromptCount: 1,
    jobQueuedPromptCount: 1,
    providerActiveLimit: 1,
    providerActivePromptCount: 1,
    providerQueueLimit: 1,
    providerQueuedPromptCount: 1,
  })
  expect(await runtime.getJobDispatchPromptIds('job-a')).toEqual(['record-active', 'record-queued'])

  release.resolve()
  await runtime.shutdown('test-complete')
})

test('recovers active prompt when processor fails before terminal cleanup', async () => {
  const recovered = mock(async (_prompts: PromptToProcess[], _reason: string) => {})
  const runtime = createJudgmentDispatchRuntime({
    processPrompt: async () => {
      throw new Error('lease lost before terminal cleanup')
    },
    recoverPrompts: recovered,
  })

  await runtime.enqueueClaimedPrompts({label: 'recover-active', prompts: [createPrompt({recordId: 'record-active'})]})
  await flush()

  expect(recovered).toHaveBeenCalledWith([createPrompt({recordId: 'record-active'})], 'processing-error')
  expect(await runtime.getJobDispatchPromptIds('job-a')).toEqual([])

  await runtime.shutdown('test-complete')
})

test('runs same-provider batches concurrently up to the provider cap', async () => {
  const firstProviderRelease = createSignal()
  const secondProviderRelease = createSignal()
  const startedBatches: string[] = []
  const processPromptBatch = mock(async ({prompts}: {label: string; prompts: PromptToProcess[]}) => {
    const [firstPrompt] = prompts

    if (!firstPrompt) {
      return
    }

    startedBatches.push(firstPrompt.recordId)

    if (firstPrompt.providerConnectionId === 'connection-a') {
      await firstProviderRelease.promise
      return
    }

    await secondProviderRelease.promise
  })
  const runtime = createJudgmentDispatchRuntime({processPromptBatch})

  await runtime.enqueueClaimedPrompts({label: 'dispatch-a', prompts: [createPrompt({recordId: 'record-a1'})]})
  await runtime.enqueueClaimedPrompts({
    label: 'dispatch-a',
    prompts: [createPrompt({providerMaxInflightRequests: 2, recordId: 'record-a2'})],
  })
  await runtime.enqueueClaimedPrompts({
    label: 'dispatch-b',
    prompts: [
      createPrompt({providerConnectionId: 'connection-b', providerMaxInflightRequests: 2, recordId: 'record-b1'}),
    ],
  })

  await flush()

  expect(startedBatches).toContain('record-a1')
  expect(startedBatches).toContain('record-a2')
  expect(startedBatches).toContain('record-b1')

  firstProviderRelease.resolve()
  secondProviderRelease.resolve()
  await runtime.shutdown('test-complete')
})

test('shutdown recovers active and queued prompts for a provider', async () => {
  const release = createSignal()
  const recovered = mock(async (prompts: PromptToProcess[], reason: string) => {
    expect(reason).toBe('duckdb-owner-demoted')
    expect(
      prompts
        .map((prompt) => {
          return prompt.recordId
        })
        .sort(),
    ).toEqual(['record-active', 'record-queued'])
  })
  const processPromptBatch = mock(async ({prompts}: {label: string; prompts: PromptToProcess[]}) => {
    if (
      prompts.some((prompt) => {
        return prompt.recordId === 'record-active'
      })
    ) {
      await release.promise
    }
  })
  const runtime = createJudgmentDispatchRuntime({processPromptBatch, recoverPrompts: recovered})

  await runtime.enqueueClaimedPrompts({label: 'shutdown', prompts: [createPrompt({recordId: 'record-active'})]})
  await flush()
  await runtime.enqueueClaimedPrompts({label: 'shutdown', prompts: [createPrompt({recordId: 'record-queued'})]})
  await flush()

  await runtime.shutdown('duckdb-owner-demoted')
  release.resolve()

  expect(recovered).toHaveBeenCalledTimes(1)
})

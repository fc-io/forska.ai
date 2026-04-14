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

test('counts active prompts against provider headroom', async () => {
  const release = createSignal()
  const processPromptBatch = mock(async ({prompts}: {label: string; prompts: PromptToProcess[]}) => {
    const [firstPrompt] = prompts

    if (firstPrompt?.recordId === 'record-active') {
      await release.promise
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
    prompts: [createPrompt({recordId: 'record-rejected'})],
  })

  expect(firstResult.acceptedCount).toBe(1)
  expect(secondResult.acceptedCount).toBe(0)
  expect(
    secondResult.rejectedPrompts.map((prompt) => {
      return prompt.recordId
    }),
  ).toEqual(['record-rejected'])
  expect(
    await runtime.getProviderQueueCapacity({
      providerConnectionId: 'connection-a',
      providerMaxInflightRequests: 1,
      providerUsesFamilyDefault: false,
    }),
  ).toBe(0)

  release.resolve()
  await runtime.shutdown('test-complete')
})

test('runs provider workers independently while serializing each provider queue', async () => {
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
  expect(startedBatches).toContain('record-b1')
  expect(startedBatches).not.toContain('record-a2')

  firstProviderRelease.resolve()
  await flush()

  expect(startedBatches).toContain('record-a2')

  secondProviderRelease.resolve()
  await runtime.shutdown('test-complete')
})

test('shutdown recovers active and queued prompts', async () => {
  const release = createSignal()
  const recovered = mock(async (prompts: PromptToProcess[], reason: string) => {
    expect(reason).toBe('writer-demoted')
    expect(
      prompts
        .map((prompt) => {
          return prompt.recordId
        })
        .sort(),
    ).toEqual(['record-active', 'record-queued'])
  })
  const processPromptBatch = mock(async ({prompts}: {label: string; prompts: PromptToProcess[]}) => {
    const [firstPrompt] = prompts

    if (firstPrompt?.recordId === 'record-active') {
      await release.promise
    }
  })
  const runtime = createJudgmentDispatchRuntime({processPromptBatch, recoverPrompts: recovered})

  await runtime.enqueueClaimedPrompts({label: 'shutdown', prompts: [createPrompt({recordId: 'record-active'})]})
  await flush()
  await runtime.enqueueClaimedPrompts({label: 'shutdown', prompts: [createPrompt({recordId: 'record-queued'})]})
  await flush()

  await runtime.shutdown('writer-demoted')
  release.resolve()

  expect(recovered).toHaveBeenCalledTimes(1)
})

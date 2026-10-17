import {afterEach, expect, mock, test} from 'bun:test'

import {loadFullTextTokenCounter} from '../../server/fullText/fullTextTokenizer.ts'
import type {FullTextChunkPolicy} from '../../utils/fullTextStrategyOptions.ts'
import {buildFullTextChunkPlan} from './fullTextChunkPlan.ts'
import {type FullTextJudgingInput, FullTextTooLargeError} from './fullTextJudgingInput.ts'
import {JudgmentPersistenceError} from './storeSinglePromptJudgment.ts'

type JudgeModule = typeof import('../judge.ts')
type JudgeSinglePromptInput = Parameters<JudgeModule['judgeSinglePrompt']>[0]
type InvokeInput = {outputSchema?: unknown; prompt: string; systemPrompt: string}

const judgeModulePath = new URL('../judge.ts', import.meta.url).href
const judgmentsRequestRuntimeModulePath = new URL(
  '../../server/cron/judgmentsJobs/judgmentsRequestRuntime.ts',
  import.meta.url,
).href
const providerInvocationServiceModulePath = new URL(
  '../../server/providers/providerInvocationService.ts',
  import.meta.url,
).href
const judgeStoreTokenUseModulePath = new URL('./judgeStoreTokenUse.ts', import.meta.url).href
const storeSinglePromptJudgmentModulePath = new URL('./storeSinglePromptJudgment.ts', import.meta.url).href

const strategyId = 'fts-0123456789abcdef'

const getSectionText = (section: number): string => {
  return Array.from({length: 120}, (_, sentence) => {
    return `Section ${section} sentence ${sentence} reports that participants in arm ${sentence % 3} received the allocated intervention and were followed for outcome ${sentence % 7}.`
  }).join(' ')
}

const longFullText = Array.from({length: 12}, (_, section) => {
  return `## Results > Part ${section + 1}\n\n${getSectionText(section + 1)}`
}).join('\n\n')

const shortFullText = '## Methods\n\nAdults with chronic pain were randomised to the intervention or usual care.'

const getFullTextJudgingInput = async ({
  chunkPolicy,
  renderedText,
}: {
  chunkPolicy: FullTextChunkPolicy
  renderedText: string
}): Promise<FullTextJudgingInput> => {
  const plan = buildFullTextChunkPlan({
    abstract: 'Preview summary',
    chunkPolicy,
    countTokens: await loadFullTextTokenCounter(),
    fullTextStrategyId: strategyId,
    renderedText,
  })

  return {
    chunkPlan: chunkPolicy.mode === 'chunked' ? plan : null,
    renderedText,
    strategy: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy,
      figureDescriptionModelId: null,
      figureDescriptionPromptVersion: null,
      figureMode: 'none',
      id: strategyId,
    },
    textHash: plan.textHash,
  }
}

const createInput = (fullTextJudging: FullTextJudgingInput): JudgeSinglePromptInput => {
  return {
    article: {
      articleSummary: 'Preview summary',
      articleTitle: 'Preview title',
      createdAt: new Date(0),
      fullText: fullTextJudging.renderedText,
      id: 'article-full-text',
      publicationStatus: null,
      updatedAt: new Date(0),
    } as JudgeSinglePromptInput['article'],
    contentSettings: {
      useAbstract: true,
      useFulltext: true,
      useFulltextNoImages: false,
      useMetadata: false,
      useTitle: true,
    },
    fullTextJudging,
    fullTextStrategyId: strategyId,
    judgmentsJobId: 'job-1',
    modelConfig: {
      baseURL: 'http://runtime.test/v1',
      modelId: 'model-1',
      modelName: 'gpt-5.4',
      provider: 'openai',
      providerConnectionId: 'provider-1',
      providerMaxInflightRequests: 20,
      providerUsesFamilyDefault: false,
      workerUrls: [],
    },
    modelContext: 200_000,
    projectId: 'project-1',
    prompt: {
      id: 'prompt-1',
      order: 1,
      originalText: 'Were participants randomised?',
      promptHeading: 'Design',
      type: 'string',
    },
    queueRecordId: 'queue-1',
    sessionId: null,
  }
}

const loadJudgeModule = ({
  invokeStoredProviderModel,
  storeSinglePromptJudgment,
}: {
  invokeStoredProviderModel: ReturnType<typeof mock>
  storeSinglePromptJudgment: ReturnType<typeof mock>
}): Promise<JudgeModule> => {
  void mock.module(judgmentsRequestRuntimeModulePath, () => {
    return {
      isProviderAdmissionLeaseLostError: () => {
        return false
      },
      updateJudgmentPromptRequestWork: () => {
        return undefined
      },
      withJudgmentRequest: async (
        {fallbackBaseURL}: {fallbackBaseURL: string},
        run: (baseURL: string, requestAttempt: Record<string, string>) => Promise<unknown>,
      ) => {
        const now = new Date(0).toISOString()

        return run(fallbackBaseURL, {
          baseURL: fallbackBaseURL,
          createdAt: now,
          providerKey: 'provider-key-1',
          requestAttemptId: `request-attempt-${Math.random()}`,
          startedAt: now,
        })
      },
    }
  })
  void mock.module(providerInvocationServiceModulePath, () => {
    return {invokeStoredProviderModel}
  })
  void mock.module(judgeStoreTokenUseModulePath, () => {
    return {
      judgeStoreTokenUse: async () => {
        return undefined
      },
    }
  })
  void mock.module(storeSinglePromptJudgmentModulePath, () => {
    return {JudgmentPersistenceError, storeSinglePromptJudgment}
  })

  return import(`${judgeModulePath}?test=${Date.now()}-${Math.random()}`) as Promise<JudgeModule>
}

const getResponse = (value: unknown) => {
  return {text: JSON.stringify(value), usage: {completionTokens: 0, promptTokens: 0, totalTokens: 0}}
}

afterEach(() => {
  mock.restore()
})

test('an article that fits is judged in one call with the rendered full text and stored as single', async () => {
  const prompts: InvokeInput[] = []
  const invokeStoredProviderModel = mock(async (input: InvokeInput) => {
    prompts.push(input)

    return getResponse({answer: 'yes', explanation: 'Randomised.', quotes: ['were randomised to the intervention']})
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({invokeStoredProviderModel, storeSinglePromptJudgment})
  const fullTextJudging = await getFullTextJudgingInput({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
    renderedText: shortFullText,
  })

  await judgeSinglePrompt(createInput(fullTextJudging))

  expect(prompts).toHaveLength(1)
  expect(prompts[0]?.prompt).toContain('## article_fulltext')
  expect(prompts[0]?.prompt).toContain(shortFullText)
  expect(storeSinglePromptJudgment.mock.calls[0]?.[0]).toMatchObject({
    fullTextExecution: {chunkCount: null, chunkPlanHash: null, fullTextMode: 'single'},
    fullTextStrategyId: strategyId,
    judgment: {answer: 'yes'},
  })
})

test('single_only rejects an article that does not fit before any provider call', async () => {
  const invokeStoredProviderModel = mock(async () => {
    return getResponse({answer: 'yes', explanation: 'x', quotes: []})
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({invokeStoredProviderModel, storeSinglePromptJudgment})
  const fullTextJudging = await getFullTextJudgingInput({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
    renderedText: longFullText,
  })

  const error = await judgeSinglePrompt(createInput(fullTextJudging)).catch((rejection: unknown) => {
    return rejection
  })

  expect(error).toBeInstanceOf(FullTextTooLargeError)
  expect(invokeStoredProviderModel).not.toHaveBeenCalled()
  expect(storeSinglePromptJudgment).not.toHaveBeenCalled()
})

test('chunked judges every part with the real question, merges once, validates quotes against the full text', async () => {
  const partPrompts: string[] = []
  const mergePrompts: string[] = []
  const invokeStoredProviderModel = mock(async (input: InvokeInput) => {
    if (input.prompt.includes('## part_judgments')) {
      mergePrompts.push(input.prompt)

      return getResponse({
        answer: 'yes',
        explanation: 'Every part reports allocation.',
        quotes: [
          mergePrompts.length === 1 ? 'a quote that is nowhere in the article' : 'received the allocated intervention',
        ],
      })
    }

    partPrompts.push(input.prompt)

    return getResponse({
      answer: 'yes',
      confidence: 0.8,
      explanation: `Part ${partPrompts.length} reports allocation.`,
      quotes: [`Section ${partPrompts.length} sentence 1 reports`],
    })
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({invokeStoredProviderModel, storeSinglePromptJudgment})
  const fullTextJudging = await getFullTextJudgingInput({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
    renderedText: longFullText,
  })
  const plan = fullTextJudging.chunkPlan

  await judgeSinglePrompt(createInput(fullTextJudging))

  expect(plan?.chunkCount).toBeGreaterThan(1)
  expect(partPrompts).toHaveLength(plan?.chunkCount ?? 0)
  expect(
    partPrompts.every((prompt) => {
      return prompt.includes('Were participants randomised?') && prompt.includes('## article_fulltext_part')
    }),
  ).toBe(true)
  expect(mergePrompts).toHaveLength(2)
  expect(mergePrompts[0]).toContain('"part":1')
  expect(mergePrompts[0]).toContain(`"part":${plan?.chunkCount}`)
  expect(mergePrompts[1]).toContain('a quote that is nowhere in the article')
  expect(storeSinglePromptJudgment).toHaveBeenCalledTimes(1)
  expect(storeSinglePromptJudgment.mock.calls[0]?.[0]).toMatchObject({
    fullTextExecution: {chunkCount: plan?.chunkCount, chunkPlanHash: plan?.planHash, fullTextMode: 'chunked'},
    judgment: {answer: 'yes', quotes: ['received the allocated intervention']},
  })
})

test('a failed part stops the article before the merge call', async () => {
  const invokeStoredProviderModel = mock(async (input: InvokeInput) => {
    return input.prompt.includes('## part_judgments')
      ? getResponse({answer: 'yes', explanation: 'merged', quotes: []})
      : getResponse({answer: 'yes', explanation: 'no confidence key', quotes: []})
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({invokeStoredProviderModel, storeSinglePromptJudgment})
  const fullTextJudging = await getFullTextJudgingInput({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
    renderedText: longFullText,
  })

  await judgeSinglePrompt(createInput(fullTextJudging)).catch(() => {
    return undefined
  })

  expect(
    invokeStoredProviderModel.mock.calls.some(([input]) => {
      return input.prompt.includes('## part_judgments')
    }),
  ).toBe(false)
  expect(storeSinglePromptJudgment).not.toHaveBeenCalled()
})

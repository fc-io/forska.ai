import {afterEach, expect, mock, test} from 'bun:test'

import {loadFullTextTokenCounter} from '../../server/fullText/fullTextTokenizer.ts'
import {buildCanonicalFixture, getCanonicalFixtureAssets} from '../../server/test/canonicalFullTextFixtures.ts'
import type {FullTextChunkPolicy} from '../../utils/fullTextStrategyOptions.ts'
import {buildFullTextChunkPlan} from './fullTextChunkPlan.ts'
import {
  FullTextFigureTooLargeError,
  type FullTextJudgingInput,
  FullTextTooLargeError,
  prepareFullTextJudgingInput,
  prepareFullTextJudgingText,
} from './fullTextJudgingInput.ts'
import {getFullTextJudgingFigureAssets} from './renderFullTextForJudging.ts'
import {JudgmentPersistenceError} from './storeSinglePromptJudgment.ts'

type JudgeModule = typeof import('../judge.ts')
type JudgeSinglePromptInput = Parameters<JudgeModule['judgeSinglePrompt']>[0]
type InvokeInput = {
  outputSchema?: unknown
  prompt: string | {images: Array<{bytes: Uint8Array; mimeType: string}>; text: string}
  systemPrompt: string
}

const getPromptText = (input: InvokeInput): string => {
  return typeof input.prompt === 'string' ? input.prompt : input.prompt.text
}

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
  figureImages = [],
  figureMode = 'none',
  imageTokens = 1_000,
  renderedText,
}: {
  chunkPolicy: FullTextChunkPolicy
  figureImages?: FullTextJudgingInput['figureImages']
  figureMode?: 'native_images' | 'none'
  imageTokens?: number
  renderedText: string
}): Promise<FullTextJudgingInput> => {
  const figureImageTokens =
    figureMode === 'native_images'
      ? new Map(
          figureImages.map((image) => {
            return [image.figureIndex, imageTokens] as const
          }),
        )
      : null
  const plan = buildFullTextChunkPlan({
    abstract: 'Preview summary',
    chunkPolicy,
    countTokens: await loadFullTextTokenCounter(),
    figureImageTokens,
    fullTextStrategyId: strategyId,
    renderedText,
  })

  return {
    chunkPlan: chunkPolicy.mode === 'chunked' ? plan : null,
    figureImageTokens,
    figureImages,
    renderedText,
    strategy: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy,
      figureMode,
      id: strategyId,
      imageTokenEstimateVersion: figureMode === 'native_images' ? 'img-tok-v1' : null,
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
  judgeStoreTokenUse = mock(async (_entries: unknown) => {}),
  storeSinglePromptJudgment,
}: {
  invokeStoredProviderModel: ReturnType<typeof mock>
  judgeStoreTokenUse?: ReturnType<typeof mock>
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
    return {judgeStoreTokenUse}
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
  expect(prompts[0] ? getPromptText(prompts[0]) : '').toContain('## article_fulltext')
  expect(prompts[0] ? getPromptText(prompts[0]) : '').toContain(shortFullText)
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
    if (getPromptText(input).includes('## part_judgments')) {
      mergePrompts.push(getPromptText(input))

      return getResponse({
        answer: 'yes',
        explanation: 'Every part reports allocation.',
        quotes: [
          mergePrompts.length === 1 ? 'a quote that is nowhere in the article' : 'received the allocated intervention',
        ],
      })
    }

    partPrompts.push(getPromptText(input))

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
    return getPromptText(input).includes('## part_judgments')
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
      return getPromptText(input).includes('## part_judgments')
    }),
  ).toBe(false)
  expect(storeSinglePromptJudgment).not.toHaveBeenCalled()
})

const getStoredMarkerTextJudgingInput = async (): Promise<FullTextJudgingInput> => {
  const assets = getCanonicalFixtureAssets('frontiers-fmed-2023-1283512', 'mineru')
  const markerText = buildCanonicalFixture({
    assets,
    converterKind: 'mineru',
    figureMode: 'native_images',
    name: 'frontiers-fmed-2023-1283512',
  }).text

  return prepareFullTextJudgingInput({
    abstract: 'Preview summary',
    countTokens: await loadFullTextTokenCounter(),
    figureImages: [],
    text: prepareFullTextJudgingText({
      articleId: 'article-full-text',
      block: {
        article: {
          canonicalTextVersion: 'canonical-v1',
          figureAssets: getFullTextJudgingFigureAssets(assets),
          figureModeBuilt: 'markers',
        },
        chunkPlan: null,
        strategy: {
          canonicalTextVersion: 'canonical-v1',
          chunkPolicy: {maxPromptTokens: 96_000, mode: 'single_only'},
          figureMode: 'none',
          id: strategyId,
          imageTokenEstimateVersion: null,
        },
      },
      fullText: markerText,
      fullTextStrategyId: strategyId,
    }),
  })
}

test('text only: a vision and a non-vision model receive byte-identical prompts with no images', async () => {
  const prompts: InvokeInput[] = []
  const invokeStoredProviderModel = mock(async (input: InvokeInput) => {
    prompts.push(input)

    return getResponse({answer: 'yes', explanation: 'Randomised.', quotes: []})
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({invokeStoredProviderModel, storeSinglePromptJudgment})
  const fullTextJudging = await getStoredMarkerTextJudgingInput()
  const baseInput = createInput(fullTextJudging)
  const getModelInput = (modelName: string, modelContext: number) => {
    return {
      ...baseInput,
      modelConfig: {...baseInput.modelConfig, modelId: `model-${modelName}`, modelName, provider: 'ollama'},
      modelContext,
    }
  }

  await judgeSinglePrompt(getModelInput('qwen3-vl:8b-instruct', 262_144))
  await judgeSinglePrompt(getModelInput('qwen2.5:1.5b', 131_072))

  const [visionRequest, textRequest] = prompts

  expect(prompts).toHaveLength(2)
  expect(typeof visionRequest?.prompt).toBe('string')
  expect(textRequest?.prompt).toBe(visionRequest?.prompt ?? '')
  expect(textRequest?.systemPrompt).toBe(visionRequest?.systemPrompt ?? '')
  expect(visionRequest ? getPromptText(visionRequest) : '').toContain('\nFigure 1\n')
  expect(visionRequest ? getPromptText(visionRequest) : '').not.toContain('[figure:')
  expect(
    storeSinglePromptJudgment.mock.calls.map((call) => {
      return (call[0] as {fullTextStrategyId: string}).fullTextStrategyId
    }),
  ).toEqual([strategyId, strategyId])
})

const getImage = (figureIndex: number) => {
  return {bytes: new Uint8Array([figureIndex]), figureIndex, mimeType: 'image/png' as const}
}

test('native images: the single call sends the text plus one image per marker in document order', async () => {
  const prompts: InvokeInput[] = []
  const invokeStoredProviderModel = mock(async (input: InvokeInput) => {
    prompts.push(input)

    return getResponse({answer: 'yes', explanation: 'Randomised.', quotes: []})
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({invokeStoredProviderModel, storeSinglePromptJudgment})
  const renderedText = `${shortFullText}\n\nFigure 2: Flow\n[figure:2]\n\nFigure 1: Pain\n[figure:1]`
  const fullTextJudging = await getFullTextJudgingInput({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
    figureImages: [getImage(1), getImage(2)],
    figureMode: 'native_images',
    renderedText,
  })

  await judgeSinglePrompt(createInput(fullTextJudging))

  const prompt = prompts[0]?.prompt

  expect(typeof prompt === 'string' ? null : prompt?.text).toContain('[figure:2]')
  expect(
    typeof prompt === 'string'
      ? null
      : prompt?.images.map((image) => {
          return image.bytes[0]
        }),
  ).toEqual([2, 1])
})

test('native images: each part carries only its own figures and the merge call is text only', async () => {
  const promptImages: Array<{merge: boolean; images: number[]}> = []
  const invokeStoredProviderModel = mock(async (input: InvokeInput) => {
    const isMerge = getPromptText(input).includes('## part_judgments')

    promptImages.push({
      images:
        typeof input.prompt === 'string'
          ? []
          : input.prompt.images.map((image) => {
              return image.bytes[0] ?? -1
            }),
      merge: isMerge,
    })

    return getResponse(
      isMerge
        ? {answer: 'yes', explanation: 'merged', quotes: []}
        : {answer: 'yes', confidence: 0.5, explanation: 'part', quotes: []},
    )
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({invokeStoredProviderModel, storeSinglePromptJudgment})
  const sections = longFullText.split('\n\n## ')
  const renderedText = [
    `${sections[0]}\n\nFigure 1: First\n[figure:1]`,
    ...sections.slice(1, -1),
    `${sections.at(-1)}\n\nFigure 2: Last\n[figure:2]`,
  ].join('\n\n## ')
  const fullTextJudging = await getFullTextJudgingInput({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
    figureImages: [getImage(1), getImage(2)],
    figureMode: 'native_images',
    renderedText,
  })

  await judgeSinglePrompt(createInput(fullTextJudging))

  const parts = promptImages.filter((entry) => {
    return !entry.merge
  })

  expect(parts.length).toBe(fullTextJudging.chunkPlan?.chunkCount ?? 0)
  expect(parts[0]?.images).toEqual([1])
  expect(parts.at(-1)?.images).toEqual([2])
  expect(
    parts.slice(1, -1).every((entry) => {
      return entry.images.length === 0
    }),
  ).toBe(true)
  expect(
    promptImages.filter((entry) => {
      return entry.merge
    }),
  ).toEqual([{images: [], merge: true}])
})

const mediumFullText = Array.from({length: 4}, (_, section) => {
  return `## Results > Part ${section + 1}\n\n${getSectionText(section + 1)}`
}).join('\n\n')

const getImageBudgetRun = async ({
  chunkPolicy,
  imageTokens,
  renderedText,
}: {
  chunkPolicy: FullTextChunkPolicy
  imageTokens: number
  renderedText: string
}) => {
  const imageCounts: number[] = []
  const invokeStoredProviderModel = mock(async (input: InvokeInput) => {
    const isMerge = getPromptText(input).includes('## part_judgments')

    imageCounts.push(typeof input.prompt === 'string' ? 0 : input.prompt.images.length)

    return getResponse(
      isMerge
        ? {answer: 'yes', explanation: 'merged', quotes: []}
        : {answer: 'yes', confidence: 0.5, explanation: 'part', quotes: []},
    )
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const judgeStoreTokenUse = mock(async (_entries: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({
    invokeStoredProviderModel,
    judgeStoreTokenUse,
    storeSinglePromptJudgment,
  })
  const fullTextJudging = await getFullTextJudgingInput({
    chunkPolicy,
    figureImages: [getImage(1)],
    figureMode: 'native_images',
    imageTokens,
    renderedText,
  })
  const error = await judgeSinglePrompt(createInput(fullTextJudging)).then(
    () => {
      return null
    },
    (rejection: unknown) => {
      return rejection
    },
  )

  const tokenUse = (judgeStoreTokenUse.mock.calls[0]?.[0] ?? []) as Array<{imageBytes?: number; imageCount?: number}>

  return {error, fullTextJudging, imageCounts, invokeStoredProviderModel, storeSinglePromptJudgment, tokenUse}
}

const figureText = `${mediumFullText}\n\nFigure 1: Flow of participants\n[figure:1]`

test('native images: image tokens decide single vs chunked; text that fits alone is chunked once its images do not', async () => {
  const small = await getImageBudgetRun({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
    imageTokens: 100,
    renderedText: figureText,
  })
  const large = await getImageBudgetRun({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
    imageTokens: 9_000,
    renderedText: figureText,
  })

  expect(small.imageCounts).toEqual([1])
  expect(small.storeSinglePromptJudgment.mock.calls[0]?.[0]).toMatchObject({
    fullTextExecution: {fullTextMode: 'single'},
  })
  expect(large.fullTextJudging.chunkPlan?.chunkCount).toBe(2)
  expect(
    large.fullTextJudging.chunkPlan?.chunks.map((chunk) => {
      return chunk.imageTokenCount
    }),
  ).toEqual([0, 9_000])
  expect(large.imageCounts).toEqual([0, 1, 0])
  expect(
    large.tokenUse.map((entry) => {
      return [entry.imageCount ?? null, entry.imageBytes ?? null]
    }),
  ).toEqual([
    [null, null],
    [1, 1],
    [null, null],
  ])
  expect(
    small.tokenUse.map((entry) => {
      return [entry.imageCount, entry.imageBytes]
    }),
  ).toEqual([[1, 1]])
  expect(large.storeSinglePromptJudgment.mock.calls[0]?.[0]).toMatchObject({
    fullTextExecution: {chunkCount: 2, fullTextMode: 'chunked'},
  })
})

test('native images on single_only: images that push the article over the limit skip it before any call', async () => {
  const run = await getImageBudgetRun({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
    imageTokens: 9_000,
    renderedText: figureText,
  })

  expect(run.error).toBeInstanceOf(FullTextTooLargeError)
  expect((run.error as Error).message).toMatch(
    /^Article article-full-text needs \d+ prompt tokens and 9000 estimated image tokens \(img-tok-v1\) plus 4000 completion tokens; the project's single-only chunk policy allows 24000\.$/,
  )
  expect(run.invokeStoredProviderModel).not.toHaveBeenCalled()
})

test('a figure that does not fit in a part of its own is skipped by name before any call', async () => {
  const run = await getImageBudgetRun({
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
    imageTokens: 21_000,
    renderedText: figureText,
  })

  expect(run.error).toBeInstanceOf(FullTextFigureTooLargeError)
  expect((run.error as Error).message).toMatch(
    /^Figure 1 of article article-full-text does not fit in a part of its own: it needs \d+ prompt tokens and 21000 estimated image tokens \(img-tok-v1\) plus 4000 completion tokens; the limit is 24000\. A figure is never split or sent without its image, so the article is skipped\.$/,
  )
  expect(run.invokeStoredProviderModel).not.toHaveBeenCalled()
  expect(run.storeSinglePromptJudgment).not.toHaveBeenCalled()
})

test('zero marked figures: native images and text only send byte-identical prompts as a plain string', async () => {
  const prompts: InvokeInput[] = []
  const invokeStoredProviderModel = mock(async (input: InvokeInput) => {
    prompts.push(input)

    return getResponse({answer: 'no', explanation: 'Not reported.', quotes: []})
  })
  const storeSinglePromptJudgment = mock(async (_input: unknown) => {})
  const {judgeSinglePrompt} = await loadJudgeModule({invokeStoredProviderModel, storeSinglePromptJudgment})
  const countTokens = await loadFullTextTokenCounter()
  const unmarkedText = `${shortFullText}\n\nFigure 1: Logo of the journal`
  const getInput = (figureMode: 'native_images' | 'none') => {
    return prepareFullTextJudgingInput({
      abstract: 'Preview summary',
      countTokens,
      figureImages: [],
      text: prepareFullTextJudgingText({
        articleId: 'article-full-text',
        block: {
          article: {
            canonicalTextVersion: 'canonical-v1',
            figureAssets: [{imagePath: 'assets/full-text-assets/article-full-text/fig-1.jpg', index: 1}],
            figureModeBuilt: 'markers',
          },
          chunkPlan: null,
          strategy: {
            canonicalTextVersion: 'canonical-v1',
            chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
            figureMode,
            id: strategyId,
            imageTokenEstimateVersion: figureMode === 'native_images' ? 'img-tok-v1' : null,
          },
        },
        fullText: unmarkedText,
        fullTextStrategyId: strategyId,
      }),
    })
  }

  await judgeSinglePrompt(createInput(getInput('native_images')))
  await judgeSinglePrompt(createInput(getInput('none')))

  const [nativeRequest, textOnlyRequest] = prompts

  expect(prompts).toHaveLength(2)
  expect(typeof nativeRequest?.prompt).toBe('string')
  expect(typeof textOnlyRequest?.prompt).toBe('string')
  expect(nativeRequest?.prompt).toBe(textOnlyRequest?.prompt ?? '')
  expect(nativeRequest?.systemPrompt).toBe(textOnlyRequest?.systemPrompt ?? '')
  expect(nativeRequest ? getPromptText(nativeRequest) : '').toContain('Figure 1: Logo of the journal')
})

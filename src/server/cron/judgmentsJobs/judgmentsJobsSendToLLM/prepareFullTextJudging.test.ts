import {afterEach, expect, mock, test} from 'bun:test'

import type {FullTextJudgingBlock, FullTextJudgingStrategy} from '../../../../agent/judge/fullTextJudgingInput.ts'

type PrepareModule = typeof import('./prepareFullTextJudging.ts')

const prepareModulePath = new URL('./prepareFullTextJudging.ts', import.meta.url).href
const appDatabaseServiceModulePath = new URL('../../../services/appDatabaseService.ts', import.meta.url).href
const figureDescriptionStoreModulePath = new URL('../../../fullText/figureDescriptionStore.ts', import.meta.url).href

const strategyId = 'fts-00000000000000d1'
const target = {modelId: 'vlm-1', promptVersion: 'fig-desc-v1'}
const markerText =
  '## Results\n\nPain fell in both arms.\n\nFigure 1: Pain scores\n[figure:1]\n\nFigure 2: Flow\n[figure:2]'

const strategy: FullTextJudgingStrategy = {
  canonicalTextVersion: 'canonical-v1',
  chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
  figureDescriptionModelId: target.modelId,
  figureDescriptionPromptVersion: target.promptVersion,
  figureMode: 'descriptions',
  id: strategyId,
}

const getBlock = (states: Array<'described' | 'failed' | 'needed'>): FullTextJudgingBlock => {
  return {
    article: {
      canonicalTextVersion: 'canonical-v1',
      figureAssets: states.map((descriptionState, position) => {
        return {
          description: descriptionState === 'described' ? `Figure ${position + 1} shows bars.` : '',
          descriptionState,
          imagePath: `assets/full-text-assets/article-1/fig-${position + 1}.png`,
          index: position + 1,
        }
      }),
      figureModeBuilt: 'markers',
    },
    chunkPlan: null,
    strategy,
  }
}

const getStoredAsset = (index: number, described: boolean) => {
  return {
    caption: `Caption ${index}`,
    imagePath: `assets/full-text-assets/article-1/fig-${index}.png`,
    index,
    ...(described
      ? {
          description: `Figure ${index} shows bars.`,
          descriptionModelId: target.modelId,
          descriptionPromptVersion: target.promptVersion,
        }
      : {}),
  }
}

const loadPrepareModule = ({
  described,
  ensureFigureDescriptions,
  installationTarget = target,
}: {
  described: () => boolean
  ensureFigureDescriptions: ReturnType<typeof mock>
  installationTarget?: typeof target | null
}): Promise<PrepareModule> => {
  const queryJson = mock(async (sql: string) => {
    return sql.includes('FROM app.full_text_strategy')
      ? [{id: strategyId, inputs: JSON.stringify(strategy)}]
      : sql.includes('FROM app.article_full_text_chunk_plan')
        ? []
        : [
            {
              articleSummary: 'Summary',
              fullText: markerText,
              fullTextAssets: JSON.stringify([getStoredAsset(1, described()), getStoredAsset(2, described())]),
              fullTextCanonicalVersion: 'canonical-v1',
              fullTextFigureModeBuilt: 'markers',
            },
          ]
  })

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {queryJson, run: async () => {}}
      },
    }
  })
  void mock.module(figureDescriptionStoreModulePath, () => {
    return {
      ensureFigureDescriptions,
      getFigureDescriptionTarget: async () => {
        return installationTarget
      },
    }
  })

  return import(`${prepareModulePath}?test=${Date.now()}-${Math.random()}`) as Promise<PrepareModule>
}

const getPreparationInput = (block: FullTextJudgingBlock | null, overrides: Record<string, unknown> = {}) => {
  return {
    abstract: 'Summary',
    articleId: 'article-1',
    block,
    fullText: markerText,
    fullTextStrategyId: strategyId,
    modelContext: 200_000,
    modelName: 'model-a',
    ...overrides,
  }
}

afterEach(() => {
  mock.restore()
})

test('descriptions mode requeues while a referenced figure is pending and skips when one failed', async () => {
  const {prepareFullTextJudging} = await loadPrepareModule({
    described: () => {
      return true
    },
    ensureFigureDescriptions: mock(async () => {}),
  })

  expect(await prepareFullTextJudging(getPreparationInput(getBlock(['described', 'needed'])))).toMatchObject({
    kind: 'requeue',
    reason: 'figure_descriptions_pending',
  })
  expect(await prepareFullTextJudging(getPreparationInput(getBlock(['failed', 'needed'])))).toMatchObject({
    kind: 'skipped',
    skipReason: 'figure_description_failed',
  })

  const ready = await prepareFullTextJudging(getPreparationInput(getBlock(['described', 'described'])))

  expect(ready.kind).toBe('ready')
  expect(ready.kind === 'ready' ? ready.fullTextJudging.renderedText : '').toContain(
    'Figure 1: Pain scores\nDescription: Figure 1 shows bars.',
  )
  expect(ready.kind === 'ready' ? ready.fullTextJudging.renderedText : '').not.toContain('[figure:')
})

test('missing strategy inputs, legacy strategies and small model windows are config requeues; bad text closes', async () => {
  const {prepareFullTextJudging} = await loadPrepareModule({
    described: () => {
      return true
    },
    ensureFigureDescriptions: mock(async () => {}),
  })
  const block = getBlock(['described', 'described'])

  expect(await prepareFullTextJudging(getPreparationInput(null))).toMatchObject({
    kind: 'requeue',
    reason: 'full_text_config',
  })
  expect(await prepareFullTextJudging(getPreparationInput(block, {fullTextStrategyId: 'fts-legacy-v0'}))).toMatchObject(
    {kind: 'requeue', reason: 'full_text_config'},
  )
  const smallWindow = await prepareFullTextJudging(getPreparationInput(block, {modelContext: 16_000}))

  expect(smallWindow).toMatchObject({kind: 'requeue', reason: 'full_text_config'})
  expect(smallWindow.kind === 'requeue' ? smallWindow.message : '').toContain('16000-token input window')
  expect(
    await prepareFullTextJudging(
      getPreparationInput({...block, article: {...block.article, canonicalTextVersion: null}}),
    ),
  ).toMatchObject({kind: 'closed'})
})

test('the local path describes pending figures on demand before judging, then renders the new descriptions', async () => {
  let isDescribed = false
  const ensureFigureDescriptions = mock(async () => {
    isDescribed = true

    return {articleId: 'article-1', described: 2, failed: 0, missing: 2, pending: 0, total: 2}
  })
  const {prepareLocalFullTextJudging} = await loadPrepareModule({
    described: () => {
      return isDescribed
    },
    ensureFigureDescriptions,
  })

  const result = await prepareLocalFullTextJudging({
    articleId: 'article-1',
    fallbackFullText: null,
    fullTextStrategyId: strategyId,
    modelContext: 200_000,
    modelName: 'model-a',
  })

  expect(ensureFigureDescriptions).toHaveBeenCalledTimes(1)
  expect(result.kind).toBe('ready')
  expect(result.kind === 'ready' ? result.fullTextJudging.renderedText : '').toContain(
    'Description: Figure 2 shows bars.',
  )
})

test('the local path never describes with a different installation model; it requeues with the reason', async () => {
  const ensureFigureDescriptions = mock(async () => {})
  const {prepareLocalFullTextJudging} = await loadPrepareModule({
    described: () => {
      return false
    },
    ensureFigureDescriptions,
    installationTarget: {modelId: 'vlm-2', promptVersion: 'fig-desc-v1'},
  })

  const result = await prepareLocalFullTextJudging({
    articleId: 'article-1',
    fallbackFullText: null,
    fullTextStrategyId: strategyId,
    modelContext: 200_000,
    modelName: 'model-a',
  })

  expect(ensureFigureDescriptions).not.toHaveBeenCalled()
  expect(result).toMatchObject({kind: 'requeue', reason: 'full_text_config'})
  expect(result.kind === 'requeue' ? result.message : '').toContain('model vlm-2 (fig-desc-v1)')
})

test('native images: preparation loads one flattened image per marker and closes the prompt when a crop is missing', async () => {
  const {prepareFullTextJudging} = await loadPrepareModule({
    described: () => {
      return false
    },
    ensureFigureDescriptions: mock(async () => {}),
  })
  const fixturePath = new URL('../../../fullText/fixtures/figureImages/opaque-2x1.png', import.meta.url).pathname
  const nativeStrategy: FullTextJudgingStrategy = {
    ...strategy,
    figureDescriptionModelId: null,
    figureDescriptionPromptVersion: null,
    figureMode: 'native_images',
  }
  const getNativeBlock = (imagePath: string): FullTextJudgingBlock => {
    return {
      article: {
        canonicalTextVersion: 'canonical-v1',
        figureAssets: [1, 2].map((index) => {
          return {description: '', descriptionState: null, imagePath, index}
        }),
        figureModeBuilt: 'markers',
      },
      chunkPlan: null,
      strategy: nativeStrategy,
    }
  }

  const ready = await prepareFullTextJudging(getPreparationInput(getNativeBlock(fixturePath)))

  expect(ready.kind).toBe('ready')
  expect(
    ready.kind === 'ready'
      ? ready.fullTextJudging.figureImages.map((image) => {
          return [image.figureIndex, image.mimeType]
        })
      : [],
  ).toEqual([
    [1, 'image/png'],
    [2, 'image/png'],
  ])
  expect(ready.kind === 'ready' ? ready.fullTextJudging.renderedText : '').toContain('[figure:1]')
  expect(await prepareFullTextJudging(getPreparationInput(getNativeBlock(`${fixturePath}.missing.png`)))).toMatchObject(
    {kind: 'closed'},
  )
})

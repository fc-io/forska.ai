import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, mock, test} from 'bun:test'

import type {FullTextJudgingBlock, FullTextJudgingStrategy} from '../../../../agent/judge/fullTextJudgingInput.ts'

type PrepareModule = typeof import('./prepareFullTextJudging.ts')

const prepareModulePath = new URL('./prepareFullTextJudging.ts', import.meta.url).href
const appDatabaseServiceModulePath = new URL('../../../services/appDatabaseService.ts', import.meta.url).href

const strategyId = 'fts-00000000000000d1'
const markerText =
  '## Results\n\nPain fell in both arms.\n\nFigure 1: Pain scores\n[figure:1]\n\nFigure 2: Flow\n[figure:2]'

const strategy: FullTextJudgingStrategy = {
  canonicalTextVersion: 'canonical-v1',
  chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
  figureMode: 'none',
  id: strategyId,
}

const getBlock = (): FullTextJudgingBlock => {
  return {
    article: {
      canonicalTextVersion: 'canonical-v1',
      figureAssets: [1, 2].map((index) => {
        return {imagePath: `assets/full-text-assets/article-1/fig-${index}.png`, index}
      }),
      figureModeBuilt: 'markers',
    },
    chunkPlan: null,
    strategy,
  }
}

const getStoredAsset = (index: number) => {
  return {
    caption: `Caption ${index}`,
    description: `Figure ${index} shows bars.`,
    descriptionModelId: 'vlm-1',
    descriptionPromptVersion: 'fig-desc-v1',
    imagePath: `assets/full-text-assets/article-1/fig-${index}.png`,
    index,
  }
}

const loadPrepareModule = (): Promise<PrepareModule> => {
  const queryJson = mock(async (sql: string) => {
    return sql.includes('FROM app.full_text_strategy')
      ? [{id: strategyId, inputs: JSON.stringify(strategy)}]
      : sql.includes('FROM app.article_full_text_chunk_plan')
        ? []
        : [
            {
              articleSummary: 'Summary',
              fullText: markerText,
              fullTextAssets: JSON.stringify([getStoredAsset(1), getStoredAsset(2)]),
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

test('text only is ready at once: caption lines stay, figure markers go, no images', async () => {
  const {prepareFullTextJudging} = await loadPrepareModule()
  const ready = await prepareFullTextJudging(getPreparationInput(getBlock()))

  expect(ready.kind).toBe('ready')
  expect(ready.kind === 'ready' ? ready.fullTextJudging.renderedText : '').toBe(
    '## Results\n\nPain fell in both arms.\n\nFigure 1: Pain scores\n\nFigure 2: Flow',
  )
  expect(ready.kind === 'ready' ? ready.fullTextJudging.figureImages : null).toEqual([])
})

test('missing strategy inputs, legacy strategies and small model windows are config requeues; bad text closes', async () => {
  const {prepareFullTextJudging} = await loadPrepareModule()
  const block = getBlock()

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

test('the local path renders the stored article and ignores stored description fields', async () => {
  const {prepareLocalFullTextJudging} = await loadPrepareModule()

  const result = await prepareLocalFullTextJudging({
    articleId: 'article-1',
    fallbackFullText: null,
    fullTextStrategyId: strategyId,
    modelContext: 200_000,
    modelName: 'model-a',
  })

  expect(result.kind).toBe('ready')
  expect(result.kind === 'ready' ? result.fullTextJudging.renderedText : '').toContain('Figure 2: Flow')
  expect(result.kind === 'ready' ? result.fullTextJudging.renderedText : '').not.toContain('Description:')
  expect(result.kind === 'ready' ? result.fullTextJudging.renderedText : '').not.toContain('[figure:')
})

test('native images: preparation loads one flattened image per marker and closes the prompt when a crop is missing', async () => {
  const {prepareFullTextJudging} = await loadPrepareModule()
  const fixturePath = new URL('../../../fullText/fixtures/figureImages/opaque-2x1.png', import.meta.url).pathname
  const nativeStrategy: FullTextJudgingStrategy = {...strategy, figureMode: 'native_images'}
  const getNativeBlock = (imagePath: string): FullTextJudgingBlock => {
    return {
      article: {
        canonicalTextVersion: 'canonical-v1',
        figureAssets: [1, 2].map((index) => {
          return {imagePath, index}
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

  const notPngDirectory = mkdtempSync(join(tmpdir(), 'native-figure-not-png-'))
  const notPngPath = join(notPngDirectory, 'fig-1.png')

  writeFileSync(notPngPath, 'not a png')

  try {
    expect(await prepareFullTextJudging(getPreparationInput(getNativeBlock(notPngPath)))).toMatchObject({
      kind: 'closed',
      message: expect.stringContaining('is not a PNG file') as unknown as string,
    })
  } finally {
    rmSync(notPngDirectory, {force: true, recursive: true})
  }
})

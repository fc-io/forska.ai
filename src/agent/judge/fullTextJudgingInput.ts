import type {FullTextTokenCounter} from '../../server/fullText/fullTextTokenizer.ts'
import {
  type FullTextChunkPolicy,
  type FullTextFigureMode,
  getFullTextChunkPolicy,
  isFullTextFigureMode,
} from '../../utils/fullTextStrategyOptions.ts'
import {
  buildFullTextChunkPlan,
  type FullTextChunkPlan,
  getFullTextChunkPlan,
  getFullTextJudgingTextHash,
} from './fullTextChunkPlan.ts'
import {
  FullTextFigureMarkerError,
  type FullTextJudgingFigureAsset,
  getFullTextJudgingFigureAssets,
  renderFullTextForJudging,
} from './renderFullTextForJudging.ts'

export type FullTextJudgingStrategy = {
  canonicalTextVersion: string
  chunkPolicy: FullTextChunkPolicy
  figureMode: FullTextFigureMode
  id: string
}

export type FullTextJudgingArticleForm = {
  canonicalTextVersion: string | null
  figureAssets: FullTextJudgingFigureAsset[] | null
  figureModeBuilt: string | null
}

export type FullTextJudgingBlock = {
  article: FullTextJudgingArticleForm
  chunkPlan: FullTextChunkPlan | null
  strategy: FullTextJudgingStrategy | null
}

export type FullTextJudgingInput = {
  chunkPlan: FullTextChunkPlan | null
  renderedText: string
  strategy: FullTextJudgingStrategy
  textHash: string
}

export type FullTextJudgingPreparation =
  | {input: FullTextJudgingInput; kind: 'ready'}
  | {kind: 'figure_descriptions_pending'; missingFigureIndexes: number[]}

export class FullTextJudgingConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FullTextJudgingConfigError'
  }
}

export class FullTextArticleNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FullTextArticleNotReadyError'
  }
}

export class FullTextTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FullTextTooLargeError'
  }
}

const markerFormFigureModesBuilt = ['markers', 'native_images']

const figureFreeFormsBuilt = [...markerFormFigureModesBuilt, 'none']

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getStringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null
}

export const getFullTextJudgingStrategyFromInputs = (id: string, inputs: unknown): FullTextJudgingStrategy | null => {
  const parsed = typeof inputs === 'string' ? (JSON.parse(inputs) as unknown) : inputs
  const chunkPolicy = isRecord(parsed) ? getFullTextChunkPolicy(parsed.chunkPolicy) : null
  const figureMode = isRecord(parsed) ? parsed.figureMode : null
  const canonicalTextVersion = isRecord(parsed) ? getStringOrNull(parsed.canonicalTextVersion) : null

  return chunkPolicy && isFullTextFigureMode(figureMode) && canonicalTextVersion
    ? {canonicalTextVersion, chunkPolicy, figureMode, id}
    : null
}

const getFigureAssetsOrNull = (value: unknown): FullTextJudgingFigureAsset[] | null => {
  try {
    return getFullTextJudgingFigureAssets(value)
  } catch {
    return null
  }
}

export const getFullTextJudgingArticleForm = ({
  canonicalTextVersion,
  figureModeBuilt,
  fullTextAssets,
}: {
  canonicalTextVersion: string | null
  figureModeBuilt: string | null
  fullTextAssets: unknown
}): FullTextJudgingArticleForm => {
  return {canonicalTextVersion, figureAssets: getFigureAssetsOrNull(fullTextAssets), figureModeBuilt}
}

const getStrategyFromBlockValue = (value: unknown): FullTextJudgingStrategy | null => {
  return isRecord(value) && typeof value.id === 'string' ? getFullTextJudgingStrategyFromInputs(value.id, value) : null
}

const getArticleFormFromBlockValue = (value: unknown): FullTextJudgingArticleForm => {
  const record = isRecord(value) ? value : {}

  return {
    canonicalTextVersion: getStringOrNull(record.canonicalTextVersion),
    figureAssets: Array.isArray(record.figureAssets) ? getFigureAssetsOrNull(record.figureAssets) : null,
    figureModeBuilt: getStringOrNull(record.figureModeBuilt),
  }
}

export const getFullTextJudgingBlockFromPayload = (value: unknown): FullTextJudgingBlock | null => {
  return isRecord(value)
    ? {
        article: getArticleFormFromBlockValue(value.article),
        chunkPlan:
          value.chunkPlan === null || value.chunkPlan === undefined ? null : getFullTextChunkPlan(value.chunkPlan),
        strategy: getStrategyFromBlockValue(value.strategy),
      }
    : null
}

export const getFullTextArticleFormError = ({
  article,
  articleId,
  strategy,
}: {
  article: FullTextJudgingArticleForm
  articleId: string
  strategy: FullTextJudgingStrategy
}): string | null => {
  const acceptedForms = strategy.figureMode === 'none' ? figureFreeFormsBuilt : markerFormFigureModesBuilt

  return article.canonicalTextVersion !== strategy.canonicalTextVersion
    ? `Article ${articleId} full text is ${article.canonicalTextVersion ?? 'not canonical text'}; full-text strategy ${strategy.id} needs ${strategy.canonicalTextVersion}. Reconvert the article.`
    : !acceptedForms.includes(article.figureModeBuilt ?? '')
      ? `Article ${articleId} canonical text was stored as ${article.figureModeBuilt ?? 'an unknown form'}; figure mode ${strategy.figureMode} needs figure markers. Rebuild the article's canonical text.`
      : article.figureAssets === null
        ? `Article ${articleId} full_text_assets is not a figure list. Reconvert the article.`
        : null
}

const renderOrThrow = (
  articleId: string,
  input: Parameters<typeof renderFullTextForJudging>[0],
): ReturnType<typeof renderFullTextForJudging> => {
  try {
    return renderFullTextForJudging(input)
  } catch (error) {
    throw error instanceof FullTextFigureMarkerError
      ? new FullTextArticleNotReadyError(
          `Article ${articleId}: ${error.message}. Rebuild the article's canonical text.`,
        )
      : error
  }
}

const getChunkPlanForText = ({
  abstract,
  block,
  countTokens,
  renderedText,
  strategy,
  textHash,
}: {
  abstract: string | null
  block: FullTextJudgingBlock
  countTokens: FullTextTokenCounter
  renderedText: string
  strategy: FullTextJudgingStrategy
  textHash: string
}): FullTextChunkPlan | null => {
  return strategy.chunkPolicy.mode !== 'chunked'
    ? null
    : block.chunkPlan?.textHash === textHash
      ? block.chunkPlan
      : buildFullTextChunkPlan({
          abstract,
          chunkPolicy: strategy.chunkPolicy,
          countTokens,
          fullTextStrategyId: strategy.id,
          renderedText,
        })
}

export const assertModelContextFitsChunkPolicy = ({
  modelContext,
  modelName,
  strategy,
}: {
  modelContext: number
  modelName: string
  strategy: FullTextJudgingStrategy
}): void => {
  if (modelContext < strategy.chunkPolicy.maxPromptTokens) {
    throw new FullTextJudgingConfigError(
      `Model ${modelName} has a ${modelContext}-token input window, smaller than the project's chunk policy of ${strategy.chunkPolicy.maxPromptTokens} tokens. Choose a smaller chunk policy or another model.`,
    )
  }
}

export const prepareFullTextJudgingInput = ({
  abstract,
  articleId,
  block,
  countTokens,
  fullText,
  fullTextStrategyId,
}: {
  abstract: string | null
  articleId: string
  block: FullTextJudgingBlock | null
  countTokens: FullTextTokenCounter
  fullText: string
  fullTextStrategyId: string
}): FullTextJudgingPreparation => {
  const strategy = block?.strategy ?? null

  if (!block || !strategy) {
    throw new FullTextJudgingConfigError(
      `Full-text strategy ${fullTextStrategyId} has no stored chunk policy and figure mode. Set them on the project's edit page and start the job again.`,
    )
  }

  const formError = getFullTextArticleFormError({article: block.article, articleId, strategy})

  if (formError) {
    throw new FullTextArticleNotReadyError(formError)
  }

  const rendered = renderOrThrow(articleId, {
    assets: block.article.figureAssets ?? [],
    figureMode: strategy.figureMode,
    text: fullText,
  })
  const textHash = getFullTextJudgingTextHash(rendered.text)

  return rendered.missingDescriptionFigureIndexes.length > 0
    ? {kind: 'figure_descriptions_pending', missingFigureIndexes: rendered.missingDescriptionFigureIndexes}
    : {
        input: {
          chunkPlan: getChunkPlanForText({
            abstract,
            block,
            countTokens,
            renderedText: rendered.text,
            strategy,
            textHash,
          }),
          renderedText: rendered.text,
          strategy,
          textHash,
        },
        kind: 'ready',
      }
}

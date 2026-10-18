import {
  assertModelContextFitsChunkPolicy,
  FullTextArticleNotReadyError,
  type FullTextJudgingBlock,
  FullTextJudgingConfigError,
  type FullTextJudgingFigureImage,
  type FullTextJudgingInput,
  type FullTextJudgingText,
  prepareFullTextJudgingInput,
  prepareFullTextJudgingText,
} from '../../../../agent/judge/fullTextJudgingInput.ts'
import {isFigureImageEncodingError} from '../../../fullText/figureImageEncoding.ts'
import {getFullTextChunkPlanKey} from '../../../fullText/fullTextChunkPlanStore.ts'
import {getFullTextJudgingBlocks} from '../../../fullText/fullTextJudgingBlocks.ts'
import {FULL_TEXT_STRATEGY_LEGACY, FULL_TEXT_STRATEGY_NONE} from '../../../fullText/fullTextStrategy.ts'
import {loadFullTextTokenCounter} from '../../../fullText/fullTextTokenizer.ts'
import {getNativeFigureImageInputs, isNativeFigureImageError} from '../../../fullText/nativeFigureImages.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'

export type FullTextJudgingRequeueReason = 'full_text_config'

export type FullTextJudgingPreparedResult =
  | {fullTextJudging: FullTextJudgingInput; kind: 'ready'}
  | {kind: 'closed'; message: string}
  | {kind: 'requeue'; message: string; reason: FullTextJudgingRequeueReason}

export type FullTextJudgingSource = {
  abstract: string | null
  block: FullTextJudgingBlock | null
  fullText: string | null
}

type LocalFullTextJudgingArticleRow = {
  articleSummary: string | null
  fullText: string | null
  fullTextAssets: unknown
  fullTextCanonicalVersion: string | null
  fullTextFigureModeBuilt: string | null
}

type FullTextJudgingPreparationInput = {
  abstract: string | null
  articleId: string
  block: FullTextJudgingBlock | null
  fullText: string
  fullTextStrategyId: string
  modelContext: number
  modelName: string
}

export const fullTextJudgingRequeueDelayMs = 60_000

export const isFullTextJudgingStrategy = (fullTextStrategyId: string): boolean => {
  return fullTextStrategyId !== FULL_TEXT_STRATEGY_NONE
}

export const getLegacyFullTextStrategyMessage = (): string => {
  return `This project uses full text without a full-text strategy (${FULL_TEXT_STRATEGY_LEGACY}). Choose a figure mode and a chunk policy on the project's edit page, then start the job again.`
}

const getFigureImages = async (text: FullTextJudgingText): Promise<FullTextJudgingFigureImage[]> => {
  return text.strategy.figureMode === 'native_images'
    ? getNativeFigureImageInputs({
        assets: (text.block.article.figureAssets ?? []).flatMap((asset) => {
          return asset.imagePath === null ? [] : [{imagePath: asset.imagePath, index: asset.index}]
        }),
        renderedText: text.renderedText,
      })
    : []
}

const getPreparedResult = async (input: FullTextJudgingPreparationInput): Promise<FullTextJudgingPreparedResult> => {
  const text = prepareFullTextJudgingText({
    articleId: input.articleId,
    block: input.block,
    fullText: input.fullText,
    fullTextStrategyId: input.fullTextStrategyId,
  })

  assertModelContextFitsChunkPolicy({
    modelContext: input.modelContext,
    modelName: input.modelName,
    strategy: text.strategy,
  })

  const fullTextJudging: FullTextJudgingInput = prepareFullTextJudgingInput({
    abstract: input.abstract,
    countTokens: await loadFullTextTokenCounter(),
    figureImages: await getFigureImages(text),
    text,
  })

  return {fullTextJudging, kind: 'ready'}
}

const getErrorResult = (error: unknown): FullTextJudgingPreparedResult => {
  if (error instanceof FullTextJudgingConfigError) {
    return {kind: 'requeue', message: error.message, reason: 'full_text_config'}
  }

  if (
    error instanceof FullTextArticleNotReadyError
    || isNativeFigureImageError(error)
    || isFigureImageEncodingError(error)
  ) {
    return {kind: 'closed', message: error.message}
  }

  throw error
}

export const prepareFullTextJudging = async (
  input: FullTextJudgingPreparationInput,
): Promise<FullTextJudgingPreparedResult> => {
  return input.fullTextStrategyId === FULL_TEXT_STRATEGY_LEGACY
    ? {kind: 'requeue', message: getLegacyFullTextStrategyMessage(), reason: 'full_text_config'}
    : getPreparedResult(input).catch(getErrorResult)
}

export const getLocalFullTextJudgingSource = async ({
  articleId,
  fullTextStrategyId,
}: {
  articleId: string
  fullTextStrategyId: string
}): Promise<FullTextJudgingSource> => {
  const database = getAppDatabaseService()
  const [row] = await database.queryJson<LocalFullTextJudgingArticleRow>(`
    SELECT
      article_summary AS articleSummary,
      full_text AS fullText,
      TO_JSON(full_text_assets) AS fullTextAssets,
      full_text_canonical_version AS fullTextCanonicalVersion,
      full_text_figure_mode_built AS fullTextFigureModeBuilt
    FROM app.article
    WHERE id = ${getSqlLiteral(articleId)}
    LIMIT 1
  `)
  const blocks = row
    ? await getFullTextJudgingBlocks({database, rows: [{...row, articleId, fullTextStrategyId}], writable: true})
    : new Map<string, FullTextJudgingBlock>()

  return {
    abstract: row?.articleSummary ?? null,
    block: blocks.get(getFullTextChunkPlanKey({articleId, fullTextStrategyId})) ?? null,
    fullText: row?.fullText ?? null,
  }
}

export const prepareLocalFullTextJudging = async ({
  articleId,
  fallbackFullText,
  fullTextStrategyId,
  modelContext,
  modelName,
}: {
  articleId: string
  fallbackFullText: string | null
  fullTextStrategyId: string
  modelContext: number
  modelName: string
}): Promise<FullTextJudgingPreparedResult> => {
  const source = await getLocalFullTextJudgingSource({articleId, fullTextStrategyId}).catch((error: unknown) => {
    return error instanceof FullTextJudgingConfigError ? error : Promise.reject(error)
  })

  return source instanceof FullTextJudgingConfigError
    ? {kind: 'requeue', message: source.message, reason: 'full_text_config'}
    : prepareFullTextJudging({
        abstract: source.abstract,
        articleId,
        block: source.block,
        fullText: source.fullText ?? fallbackFullText ?? '',
        fullTextStrategyId,
        modelContext,
        modelName,
      })
}

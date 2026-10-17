import {
  buildFullTextChunkPlan,
  type FullTextChunkPlan,
  getFullTextJudgingTextHash,
} from '../../agent/judge/fullTextChunkPlan.ts'
import {
  type FullTextJudgingBlock,
  type FullTextJudgingStrategy,
  getFullTextArticleFormError,
  getFullTextJudgingArticleForm,
  getFullTextJudgingStrategyFromInputs,
} from '../../agent/judge/fullTextJudgingInput.ts'
import {renderFullTextForJudging} from '../../agent/judge/renderFullTextForJudging.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  type FullTextChunkPlanQueryService,
  getCachedFullTextChunkPlans,
  getFullTextChunkPlanKey,
  type StoredFullTextChunkPlan,
  storeFullTextChunkPlans,
} from './fullTextChunkPlanStore.ts'
import {isReservedFullTextStrategyId} from './fullTextStrategy.ts'
import {type FullTextTokenCounter, loadFullTextTokenCounter} from './fullTextTokenizer.ts'

export type FullTextJudgingArticleRow = {
  articleId: string
  articleSummary: string | null
  fullText: string | null
  fullTextAssets: unknown
  fullTextCanonicalVersion: string | null
  fullTextFigureModeBuilt: string | null
  fullTextStrategyId: string
}

const strategyById = new Map<string, FullTextJudgingStrategy>()

const loadFullTextJudgingStrategies = async (
  database: FullTextChunkPlanQueryService,
  ids: string[],
): Promise<Map<string, FullTextJudgingStrategy>> => {
  const missingIds = ids.filter((id) => {
    return !strategyById.has(id)
  })
  const rows =
    missingIds.length === 0
      ? []
      : await database.queryJson<{id: string; inputs: string}>(`
          SELECT id, CAST(inputs AS VARCHAR) AS inputs
          FROM app.full_text_strategy
          WHERE id IN (${missingIds.map(getSqlLiteral).join(', ')})
        `)

  rows.forEach((row) => {
    const strategy = getFullTextJudgingStrategyFromInputs(row.id, row.inputs)

    if (strategy) {
      strategyById.set(row.id, strategy)
    }
  })

  return new Map(
    ids.flatMap((id): Array<[string, FullTextJudgingStrategy]> => {
      const strategy = strategyById.get(id)

      return strategy ? [[id, strategy]] : []
    }),
  )
}

export const getFullTextJudgingStrategy = async (
  database: FullTextChunkPlanQueryService,
  id: string,
): Promise<FullTextJudgingStrategy | null> => {
  return (await loadFullTextJudgingStrategies(database, [id])).get(id) ?? null
}

export const resetFullTextJudgingStrategyCacheForTests = (): void => {
  strategyById.clear()
}

const getRenderedTextForPlan = (
  row: FullTextJudgingArticleRow,
  block: Omit<FullTextJudgingBlock, 'chunkPlan'>,
): string | null => {
  const strategy = block.strategy
  const renderable =
    strategy !== null
    && strategy.chunkPolicy.mode === 'chunked'
    && row.fullText !== null
    && getFullTextArticleFormError({article: block.article, articleId: row.articleId, strategy}) === null
  const rendered = renderable
    ? (() => {
        try {
          return renderFullTextForJudging({
            assets: block.article.figureAssets ?? [],
            figureMode: strategy.figureMode,
            text: row.fullText ?? '',
          })
        } catch {
          return null
        }
      })()
    : null

  return rendered
    && rendered.missingDescriptionFigureIndexes.length === 0
    && rendered.failedDescriptionFigureIndexes.length === 0
    ? rendered.text
    : null
}

const getChunkPlan = ({
  cachedPlan,
  countTokens,
  renderedText,
  row,
  strategy,
}: {
  cachedPlan: FullTextChunkPlan | undefined
  countTokens: FullTextTokenCounter
  renderedText: string
  row: FullTextJudgingArticleRow
  strategy: FullTextJudgingStrategy
}): {plan: FullTextChunkPlan; stored: boolean} => {
  return cachedPlan?.textHash === getFullTextJudgingTextHash(renderedText)
    ? {plan: cachedPlan, stored: true}
    : {
        plan: buildFullTextChunkPlan({
          abstract: row.articleSummary,
          chunkPolicy: strategy.chunkPolicy,
          countTokens,
          fullTextStrategyId: strategy.id,
          renderedText,
        }),
        stored: false,
      }
}

const getUniqueRows = (rows: FullTextJudgingArticleRow[]): FullTextJudgingArticleRow[] => {
  return [
    ...new Map(
      rows
        .filter((row) => {
          return !isReservedFullTextStrategyId(row.fullTextStrategyId)
        })
        .map((row) => {
          return [getFullTextChunkPlanKey(row), row] as const
        }),
    ).values(),
  ]
}

export const getFullTextJudgingBlocks = async ({
  database,
  rows,
  writable,
}: {
  database: FullTextChunkPlanQueryService
  rows: FullTextJudgingArticleRow[]
  writable: boolean
}): Promise<Map<string, FullTextJudgingBlock>> => {
  const uniqueRows = getUniqueRows(rows)

  if (uniqueRows.length === 0) {
    return new Map()
  }

  const strategies = await loadFullTextJudgingStrategies(database, [
    ...new Set(
      uniqueRows.map((row) => {
        return row.fullTextStrategyId
      }),
    ),
  ])
  const cachedPlans = await getCachedFullTextChunkPlans(database, uniqueRows)
  const countTokens = await loadFullTextTokenCounter()
  const entries = uniqueRows.map((row) => {
    const strategy = strategies.get(row.fullTextStrategyId) ?? null
    const block = {
      article: getFullTextJudgingArticleForm({
        canonicalTextVersion: row.fullTextCanonicalVersion,
        figureModeBuilt: row.fullTextFigureModeBuilt,
        fullTextAssets: row.fullTextAssets,
        strategy,
      }),
      strategy,
    }
    const renderedText = getRenderedTextForPlan(row, block)
    const chunkPlan =
      renderedText !== null && block.strategy
        ? getChunkPlan({
            cachedPlan: cachedPlans.get(getFullTextChunkPlanKey(row)),
            countTokens,
            renderedText,
            row,
            strategy: block.strategy,
          })
        : null

    return {block: {...block, chunkPlan: chunkPlan?.plan ?? null}, chunkPlan, row}
  })
  const newPlans = entries.flatMap(({chunkPlan, row}): StoredFullTextChunkPlan[] => {
    return chunkPlan && !chunkPlan.stored ? [{...row, plan: chunkPlan.plan}] : []
  })

  if (writable) {
    await storeFullTextChunkPlans(newPlans)
  }

  return new Map(
    entries.map(({block, row}) => {
      return [getFullTextChunkPlanKey(row), block] as const
    }),
  )
}

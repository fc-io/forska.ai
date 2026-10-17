import {type FullTextChunkPlan, getFullTextChunkPlan} from '../../agent/judge/fullTextChunkPlan.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {AppReadOnlyDatabaseService} from '../services/appReadOnlyDatabaseService.ts'

export type FullTextChunkPlanQueryService = Pick<
  ReturnType<typeof getAppDatabaseService> | AppReadOnlyDatabaseService,
  'queryJson'
>

export type FullTextChunkPlanKey = {articleId: string; fullTextStrategyId: string}

export type StoredFullTextChunkPlan = FullTextChunkPlanKey & {plan: FullTextChunkPlan}

type StoredChunkPlanRow = {
  articleId: string
  chunkCount: number
  chunks: string
  fullTextStrategyId: string
  planHash: string
  textHash: string
}

export const getFullTextChunkPlanKey = ({articleId, fullTextStrategyId}: FullTextChunkPlanKey): string => {
  return `${articleId}|${fullTextStrategyId}`
}

const getKeyValuesSql = (keys: FullTextChunkPlanKey[]): string => {
  return keys
    .map((key) => {
      return `(${getSqlLiteral(key.articleId)}, ${getSqlLiteral(key.fullTextStrategyId)})`
    })
    .join(', ')
}

const toStoredPlan = (row: StoredChunkPlanRow): [string, FullTextChunkPlan] | null => {
  const plan = getFullTextChunkPlan({
    chunkCount: Number(row.chunkCount),
    chunks: JSON.parse(row.chunks) as unknown,
    planHash: row.planHash,
    textHash: row.textHash,
  })

  return plan ? [getFullTextChunkPlanKey(row), plan] : null
}

export const getCachedFullTextChunkPlans = async (
  database: FullTextChunkPlanQueryService,
  keys: FullTextChunkPlanKey[],
): Promise<Map<string, FullTextChunkPlan>> => {
  const rows =
    keys.length === 0
      ? []
      : await database.queryJson<StoredChunkPlanRow>(`
          SELECT
            plan.article_id AS articleId,
            plan.full_text_strategy_id AS fullTextStrategyId,
            plan.plan_hash AS planHash,
            plan.text_hash AS textHash,
            plan.chunk_count AS chunkCount,
            CAST(plan.chunks AS VARCHAR) AS chunks
          FROM app.article_full_text_chunk_plan plan
          INNER JOIN (VALUES ${getKeyValuesSql(keys)}) requested(article_id, full_text_strategy_id)
            ON requested.article_id = plan.article_id
           AND requested.full_text_strategy_id = plan.full_text_strategy_id
        `)

  return new Map(
    rows.map(toStoredPlan).filter((entry): entry is [string, FullTextChunkPlan] => {
      return entry !== null
    }),
  )
}

const getPlanValuesSql = (plans: StoredFullTextChunkPlan[]): string => {
  return plans
    .map(({articleId, fullTextStrategyId, plan}) => {
      return `(${[
        getSqlLiteral(articleId),
        getSqlLiteral(fullTextStrategyId),
        getSqlLiteral(plan.planHash),
        getSqlLiteral(plan.textHash),
        String(plan.chunkCount),
        `${getSqlLiteral(JSON.stringify(plan.chunks))}::JSON`,
      ].join(', ')})`
    })
    .join(',\n')
}

export const storeFullTextChunkPlans = async (plans: StoredFullTextChunkPlan[]): Promise<void> => {
  if (plans.length === 0) {
    return undefined
  }

  await getAppDatabaseService().run(`
    INSERT INTO app.article_full_text_chunk_plan (
      article_id,
      full_text_strategy_id,
      plan_hash,
      text_hash,
      chunk_count,
      chunks
    ) VALUES ${getPlanValuesSql(plans)}
    ON CONFLICT (article_id, full_text_strategy_id) DO UPDATE SET
      plan_hash = EXCLUDED.plan_hash,
      text_hash = EXCLUDED.text_hash,
      chunk_count = EXCLUDED.chunk_count,
      chunks = EXCLUDED.chunks,
      created_at = now()
  `)
}

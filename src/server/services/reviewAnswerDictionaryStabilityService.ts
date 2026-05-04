import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'

type AppRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
type RowIdRow = {rowId: bigint | number | string}

export type ReviewAnswerDictionaryPruneBatchResult = {deletedRowCount: number}

const defaultReviewAnswerDictionaryPruneBatchSize = 1000

const getPositiveBatchSize = (batchSize: number) => {
  return Math.max(1, Math.floor(batchSize))
}

const getRowIdsSql = (rows: RowIdRow[]) => {
  return rows
    .map((row) => {
      return getSqlLiteral(row.rowId)
    })
    .join(', ')
}

const getUnreferencedReviewAnswerDictionaryRowsTx = async (tx: AppRunner, batchSize: number) => {
  return tx.queryJson<RowIdRow>(`
    SELECT dictionary.rowid AS rowId
    FROM app.review_answer_dictionary dictionary
    WHERE NOT EXISTS (
        SELECT 1
        FROM mart.review_article_filter_member member
        WHERE member.project_id = dictionary.project_id
          AND member.prompt_id = dictionary.prompt_id
          AND member.answer_id = dictionary.answer_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_mart_large_rebuild_state rebuild_state
        WHERE rebuild_state.project_id = dictionary.project_id
          AND rebuild_state.superseded_at IS NULL
          AND rebuild_state.target_generation IS NOT NULL
          AND rebuild_state.refresh_status IN ('running', 'paused')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_review_serving_generation generation
        INNER JOIN mart.review_article_serving serving
          ON serving.project_id = generation.project_id
         AND serving.generation IN (generation.active_generation, generation.active_generation - 1)
        WHERE generation.project_id = dictionary.project_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.project_review_serving_generation generation
        INNER JOIN mart.review_article_serving_detail detail
          ON detail.project_id = generation.project_id
         AND detail.generation IN (generation.active_generation, generation.active_generation - 1)
        WHERE generation.project_id = dictionary.project_id
          AND detail.prompt_id = dictionary.prompt_id
      )
    ORDER BY dictionary.project_id ASC, dictionary.prompt_id ASC, dictionary.answer_id ASC
    LIMIT ${getSqlLiteral(batchSize)}
  `)
}

export const pruneUnreferencedReviewAnswerDictionaryBatch = async ({
  batchSize = defaultReviewAnswerDictionaryPruneBatchSize,
}: {batchSize?: number} = {}): Promise<ReviewAnswerDictionaryPruneBatchResult> => {
  return getAppDatabaseService().transaction(async (tx) => {
    const rows = await getUnreferencedReviewAnswerDictionaryRowsTx(tx, getPositiveBatchSize(batchSize))

    if (rows.length === 0) {
      return {deletedRowCount: 0}
    }

    await tx.run(`
      DELETE FROM app.review_answer_dictionary
      WHERE rowid IN (${getRowIdsSql(rows)})
    `)

    return {deletedRowCount: rows.length}
  })
}

export const getReviewAnswerDictionaryStabilityService = () => {
  return {pruneUnreferencedReviewAnswerDictionaryBatch}
}

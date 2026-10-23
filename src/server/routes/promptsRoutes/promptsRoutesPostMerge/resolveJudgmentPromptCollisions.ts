import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import {appendLlmJudgmentReviewServingDeltas} from '../../../reviewServing/llmJudgmentReviewServingDeltaService.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import type {PromptMergeTransaction} from './promptMergeTransaction.ts'

type JudgmentPromptCollisionRow = {
  articleId: string
  keepJudgmentId: string
  mergeJudgmentId: string
  modelId: string
  projectId: string | null
  promptId: string
  systemPromptVariant: SystemPromptVariant
  fullTextStrategyId: string
  updatedAt: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
}
type JudgmentAssessmentRow = {id: string}

const getJudgmentPromptCollisions = async ({
  keepPromptId,
  mergeId,
  tx,
}: {
  keepPromptId: string
  mergeId: string
  tx: PromptMergeTransaction
}) => {
  return tx.queryJson<JudgmentPromptCollisionRow>(`
    SELECT keep_row.id AS keepJudgmentId,
           merge_row.id AS mergeJudgmentId,
           merge_row.article_id AS articleId,
           merge_row.model_id AS modelId,
           merge_row.project_id AS projectId,
           merge_row.prompt_id AS promptId,
           merge_row.updated_at AS updatedAt,
           merge_row.use_abstract AS useAbstract,
           merge_row.use_fulltext AS useFulltext,
           merge_row.use_fulltext_no_images AS useFulltextNoImages,
           merge_row.use_metadata AS useMetadata,
           merge_row.use_title AS useTitle,
           merge_row.system_prompt_variant AS systemPromptVariant,
           merge_row.full_text_strategy_id AS fullTextStrategyId
    FROM app.judgment merge_row
    INNER JOIN app.judgment keep_row
      ON keep_row.article_id = merge_row.article_id
     AND keep_row.prompt_id = '${escapeSqlString(keepPromptId)}'
     AND keep_row.model_id = merge_row.model_id
     AND keep_row.use_title = merge_row.use_title
     AND keep_row.use_abstract = merge_row.use_abstract
     AND keep_row.use_fulltext = merge_row.use_fulltext
     AND keep_row.use_fulltext_no_images = merge_row.use_fulltext_no_images
     AND keep_row.use_metadata = merge_row.use_metadata
     AND keep_row.system_prompt_variant = merge_row.system_prompt_variant
     AND keep_row.full_text_strategy_id = merge_row.full_text_strategy_id
     AND keep_row.delete_generation = merge_row.delete_generation
    WHERE merge_row.prompt_id = '${escapeSqlString(mergeId)}'
  `)
}

const moveJudgmentAssessmentToKeptJudgment = async ({
  keepJudgmentId,
  mergeJudgmentId,
  tx,
}: {
  keepJudgmentId: string
  mergeJudgmentId: string
  tx: PromptMergeTransaction
}) => {
  const [keepAssessment, mergeAssessment] = await Promise.all([
    tx.queryJson<JudgmentAssessmentRow>(`
      SELECT id
      FROM app.judgment_assessment
      WHERE judgment_id = '${escapeSqlString(keepJudgmentId)}'
      LIMIT 1
    `),
    tx.queryJson<JudgmentAssessmentRow>(`
      SELECT id
      FROM app.judgment_assessment
      WHERE judgment_id = '${escapeSqlString(mergeJudgmentId)}'
      LIMIT 1
    `),
  ])

  const mergeAssessmentRow = mergeAssessment.at(0)

  if (!mergeAssessmentRow) {
    return
  }

  const {id: mergeAssessmentId} = mergeAssessmentRow

  if (keepAssessment.length > 0) {
    await tx.run(`
      DELETE FROM app.judgment_assessment
      WHERE id = '${escapeSqlString(mergeAssessmentId)}'
    `)
    return
  }

  await tx.run(`
    UPDATE app.judgment_assessment
    SET judgment_id = '${escapeSqlString(keepJudgmentId)}',
        updated_at = current_timestamp
    WHERE id = '${escapeSqlString(mergeAssessmentId)}'
  `)
}

export const resolveJudgmentPromptCollisions = async ({
  affectedProjectIds,
  keepPromptId,
  mergeId,
  tx,
}: {
  affectedProjectIds: string[]
  keepPromptId: string
  mergeId: string
  tx: PromptMergeTransaction
}) => {
  const collisions = await getJudgmentPromptCollisions({keepPromptId, mergeId, tx})

  for (const collision of collisions) {
    await moveJudgmentAssessmentToKeptJudgment({
      keepJudgmentId: collision.keepJudgmentId,
      mergeJudgmentId: collision.mergeJudgmentId,
      tx,
    })
    await appendLlmJudgmentReviewServingDeltas(
      tx,
      affectedProjectIds.map((projectId) => {
        return {
          articleId: collision.articleId,
          changeKind: 'judgment.llm.deleted',
          judgmentId: collision.mergeJudgmentId,
          modelId: collision.modelId,
          projectId,
          promptId: collision.promptId,
          sourceMutationKey: `promptMerge|${mergeId}|${keepPromptId}|${collision.mergeJudgmentId}|${projectId}`,
          sourceOperation: 'delete',
          sourceUpdatedAt: collision.updatedAt,
          systemPromptVariant: collision.systemPromptVariant,
          fullTextStrategyId: collision.fullTextStrategyId,
          useAbstract: collision.useAbstract,
          useFulltext: collision.useFulltext,
          useFulltextNoImages: collision.useFulltextNoImages,
          useMetadata: collision.useMetadata,
          useTitle: collision.useTitle,
        }
      }),
    )
    await tx.run(`
      DELETE FROM app.judgment
      WHERE id = '${escapeSqlString(collision.mergeJudgmentId)}'
    `)
  }
}

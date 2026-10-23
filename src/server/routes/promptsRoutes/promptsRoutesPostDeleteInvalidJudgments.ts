import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {appendLlmJudgmentReviewServingDeltas} from '../../reviewServing/llmJudgmentReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'

export const promptsRoutesPostDeleteInvalidJudgments = async ({body}: {body: {judgmentIds: string[]}}) => {
  const {judgmentIds} = body

  if (judgmentIds.length === 0) {
    return {success: true, data: {deletedCount: 0}}
  }

  const now = new Date()

  await getAppDatabaseService().transaction(async (tx) => {
    const affectedJudgments = await tx.queryJson<{
      articleId: string
      judgmentId: string
      modelId: string | null
      projectId: string | null
      promptId: string | null
      systemPromptVariant: SystemPromptVariant
      fullTextStrategyId: string
      useAbstract: boolean
      useFulltext: boolean
      useFulltextNoImages: boolean
      useMetadata: boolean
      useTitle: boolean
    }>(`
          SELECT
            article_id AS articleId,
            id AS judgmentId,
            model_id AS modelId,
            project_id AS projectId,
            prompt_id AS promptId,
            COALESCE(use_abstract, FALSE) AS useAbstract,
            COALESCE(use_fulltext, FALSE) AS useFulltext,
            COALESCE(use_fulltext_no_images, FALSE) AS useFulltextNoImages,
            COALESCE(use_metadata, FALSE) AS useMetadata,
            COALESCE(use_title, FALSE) AS useTitle,
            system_prompt_variant AS systemPromptVariant,
            full_text_strategy_id AS fullTextStrategyId
          FROM app.judgment
          WHERE id IN (${getQuotedStringList(judgmentIds).join(', ')})
        `)

    await tx.run(`
          UPDATE app.judgment
          SET deleted_at = ${getSqlLiteral(now)},
              updated_at = ${getSqlLiteral(now)}
          WHERE id IN (${getQuotedStringList(judgmentIds).join(', ')})
        `)

    await appendLlmJudgmentReviewServingDeltas(
      tx,
      affectedJudgments
        .filter((judgment) => {
          return judgment.modelId !== null && judgment.promptId !== null
        })
        .map((judgment) => {
          return {
            articleId: judgment.articleId,
            changeKind: 'judgment.llm.deleted' as const,
            judgmentId: judgment.judgmentId,
            modelId: judgment.modelId ?? '',
            projectId: judgment.projectId,
            promptId: judgment.promptId ?? '',
            sourceMutationKey: `PromptsRoutes.deleteInvalidJudgments|${judgment.judgmentId}|${now.toISOString()}`,
            sourceOperation: 'delete' as const,
            sourceUpdatedAt: now,
            systemPromptVariant: judgment.systemPromptVariant,
            fullTextStrategyId: judgment.fullTextStrategyId,
            useAbstract: judgment.useAbstract,
            useFulltext: judgment.useFulltext,
            useFulltextNoImages: judgment.useFulltextNoImages,
            useMetadata: judgment.useMetadata,
            useTitle: judgment.useTitle,
          }
        }),
    )
  })

  return {success: true, data: {deletedCount: judgmentIds.length}}
}

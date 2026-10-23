import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {requireTopologySeedBoundary} from './requireTopologySeedBoundary.ts'

export const judgmentWorkflowTopologyTestRoutesPostRealCodexEvidence = async ({
  body,
}: {
  body: {modelId: string; projectId: string; promptId: string; token: string}
}) => {
  requireTopologySeedBoundary(body.token)
  const judgments = await getAppDatabaseService().queryJson<{
    answeredOriginal: string | null
    articleId: string
    confidenceOriginal: string | null
    explanation: string | null
    fullTextStrategyId: string
    isAnswered: boolean | null
    modelId: string
    projectId: string
    promptId: string
    quotes: unknown
    systemPromptVariant: string
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useMetadata: boolean
    useTitle: boolean
  }>(`
        SELECT article_id AS articleId,
               model_id AS modelId,
               prompt_id AS promptId,
               project_id AS projectId,
               is_answered AS isAnswered,
               answered_original AS answeredOriginal,
               confidence_original AS confidenceOriginal,
               explanation,
               quotes,
               use_title AS useTitle,
               use_abstract AS useAbstract,
               use_fulltext AS useFulltext,
               use_fulltext_no_images AS useFulltextNoImages,
               use_metadata AS useMetadata,
               system_prompt_variant AS systemPromptVariant,
               full_text_strategy_id AS fullTextStrategyId
        FROM app.judgment
        WHERE project_id = ${getSqlLiteral(body.projectId)}
          AND model_id = ${getSqlLiteral(body.modelId)}
          AND prompt_id = ${getSqlLiteral(body.promptId)}
        ORDER BY article_id
      `)
  const [projection] = await getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM (
          SELECT DISTINCT project_id, review_config_hash, payload_kind, article_id, prompt_id
          FROM mart.review_article_judgment_detail_serving_v4
          WHERE project_id = ${getSqlLiteral(body.projectId)}
            AND prompt_id = ${getSqlLiteral(body.promptId)}
            AND payload_kind = 'llm'
        ) projection
      `)

  return {data: {judgments, visibleProjectionCount: Number(projection?.count ?? 0)}, error: null}
}

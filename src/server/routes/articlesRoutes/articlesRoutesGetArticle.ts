import {getArticleMetadataLines} from '../../../agent/judge/articleMetadataPrompt.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {type ArticleJudgmentRow, getArticleJudgmentValue} from './articlesRoutesGetArticle/getArticleJudgmentValue.ts'

export const articlesRoutesGetArticle = async ({params}: {params: {id: string}}) => {
  const {id} = params

  const [article] = await getAppQueryService().getFullArticlesByIds([id])

  if (!article) {
    throw new Error('Article not found')
  }

  const allArticleJudgments = await getAppDatabaseService().queryJson<ArticleJudgmentRow>(`
        SELECT
          j.id AS judgmentId,
          j.created_at AS judgmentCreatedAt,
          j.updated_at AS judgmentUpdatedAt,
          j.deleted_at AS judgmentDeletedAt,
          j.article_id AS judgmentArticleId,
          j.model_id AS judgmentModelId,
          j.prompt_id AS judgmentPromptId,
          j.project_id AS judgmentProjectId,
          j.use_title AS judgmentUseTitle,
          j.use_abstract AS judgmentUseAbstract,
          j.use_fulltext AS judgmentUseFulltext,
          j.use_fulltext_no_images AS judgmentUseFulltextNoImages,
          j.use_metadata AS judgmentUseMetadata,
          j.system_prompt_variant AS judgmentSystemPromptVariant,
          j.full_text_strategy_id AS judgmentFullTextStrategyId,
      j.full_text_strategy_id AS judgmentFullTextStrategyId,
          j.chunking_strategy AS judgmentChunkingStrategy,
          j.full_text_mode AS judgmentFullTextMode,
          j.chunk_count AS judgmentChunkCount,
          j.chunk_plan_hash AS judgmentChunkPlanHash,
          j.is_answered AS judgmentIsAnswered,
          j.answered_original AS judgmentAnsweredOriginal,
          TO_JSON(j.answered_original_as_array) AS judgmentAnsweredOriginalAsArray,
          j.confidence_original AS judgmentConfidenceOriginal,
          j.explanation AS judgmentExplanation,
          TO_JSON(j.quotes) AS judgmentQuotes,
          j.snapshot_project_id AS judgmentSnapshotProjectId,
          j.snapshot_project_model_name AS judgmentSnapshotProjectModelName,
          p.original_text AS promptOriginalText,
          p.prompt_heading AS promptHeading,
          TO_JSON(m.metadata_json) AS modelMetadataJson,
          COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
          pc.provider_kind AS modelProvider,
          m.variant AS modelVersion
        FROM app.judgment j
        INNER JOIN app.prompt p ON j.prompt_id = p.id
        LEFT JOIN app.model m ON j.model_id = m.id
        LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
        WHERE j.article_id = '${escapeSqlString(id)}'
        ORDER BY j.created_at DESC NULLS LAST, j.id ASC
      `)

  const allJudgments = allArticleJudgments.map((row) => {
    return getArticleJudgmentValue(row)
  })

  const snapshotProjectIds = Array.from(
    new Set(
      allJudgments
        .map((j) => {
          return j.snapshotProjectId
        })
        .filter((id): id is string => {
          return Boolean(id)
        }),
    ),
  )
  const projectNameRows =
    snapshotProjectIds.length > 0
      ? await getAppDatabaseService().queryJson<{id: string; name: string}>(`
              SELECT id, name
              FROM app.project
              WHERE id IN (${getQuotedStringList(snapshotProjectIds).join(', ')})
            `)
      : []
  const projectsById = projectNameRows.reduce<Record<string, {name: string}>>((acc, row) => {
    acc[row.id] = {name: row.name}
    return acc
  }, {})

  return {article, articleMetadata: getArticleMetadataLines(article), allJudgments, projectsById}
}

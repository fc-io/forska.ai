import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getProjectVisibleJudgmentScopeSql} from '../../../services/projectVisibleJudgmentRule.ts'
import type {ArticleJudgmentRow} from './articleReviewDetailTypes.ts'
import {getProjectReviewDetailsWorkloadContext} from './getProjectReviewDetailsWorkloadContext.ts'
import {getProjectScopeArticleCteSql} from './getProjectScopeArticleCteSql.ts'

export const getArticleJudgmentRows = async (params: {
  articleId: string
  projectId: string
}): Promise<ArticleJudgmentRow[]> => {
  return getAppDatabaseService().queryJson<ArticleJudgmentRow>(
    `
    WITH ${getProjectScopeArticleCteSql(params)}
    SELECT
      j.id AS judgmentId,
      [] AS judgmentAssessments,
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
      NULL AS modelThinking,
      m.variant AS modelVersion
    FROM app.judgment j
    INNER JOIN project_scope_article scope_article ON scope_article.article_id = j.article_id
    INNER JOIN app.project project ON project.id = scope_article.project_id
    INNER JOIN app.project_prompt project_prompt ON project_prompt.prompt_id = j.prompt_id
    INNER JOIN app.prompt p ON j.prompt_id = p.id
    LEFT JOIN app.model m ON j.model_id = m.id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE project.id = ${getSqlLiteral(params.projectId)}
      AND project.archived = FALSE
      AND ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'j',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'scope_article',
      })}
      AND j.deleted_at IS NULL
    ORDER BY j.created_at DESC NULLS LAST, j.id ASC
  `,
    getProjectReviewDetailsWorkloadContext({operation: 'legacyArticleJudgments', projectId: params.projectId}),
  )
}

import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import {getProjectFullTextStrategyIdSql} from '../../../fullText/fullTextStrategy.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import type {AppTx} from '../appTx.ts'

type ProjectPromptLlmCleanupCandidateRow = {
  articleId: string
  comparisonPromptReferenced: boolean
  id: string
  modelId: string
  projectId: string | null
  promptId: string
  sharedProjectReferenced: boolean
  systemPromptVariant: SystemPromptVariant
  fullTextStrategyId: string
  updatedAt: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
}

export const getProjectPromptLlmCleanupCandidateRowsTx = async (
  tx: AppTx,
  params: {oldPromptIds: string[]; projectId: string},
) => {
  return tx.queryJson<ProjectPromptLlmCleanupCandidateRow>(`
    WITH old_prompt(prompt_id) AS (
      VALUES ${params.oldPromptIds
        .map((promptId) => {
          return `('${escapeSqlString(promptId)}')`
        })
        .join(', ')}
    ),
    candidate AS (
      SELECT
        judgment.id,
        judgment.article_id,
        judgment.model_id,
        judgment.project_id,
        judgment.prompt_id,
        judgment.updated_at,
        judgment.use_abstract,
        judgment.use_fulltext,
        judgment.use_fulltext_no_images,
        judgment.use_metadata,
        judgment.use_title,
        judgment.system_prompt_variant,
        judgment.full_text_strategy_id
      FROM app.judgment judgment
      INNER JOIN old_prompt ON old_prompt.prompt_id = judgment.prompt_id
      INNER JOIN app.project project ON project.id = '${escapeSqlString(params.projectId)}'
      INNER JOIN app.article article ON article.id = judgment.article_id
      WHERE judgment.deleted_at IS NULL
        AND judgment.model_id = project.model_id
        AND judgment.use_title = project.use_title
        AND judgment.use_abstract = project.use_abstract
        AND judgment.use_fulltext = project.use_fulltext
        AND judgment.use_fulltext_no_images = project.use_fulltext_no_images
        AND judgment.use_metadata = COALESCE(project.use_metadata, FALSE)
        AND judgment.system_prompt_variant = COALESCE(project.system_prompt_variant, 'legacy')
        AND judgment.full_text_strategy_id = ${getProjectFullTextStrategyIdSql('project')}
        AND project.archived = FALSE
        AND project.delete_pending_at IS NULL
        AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
        AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = project.id
            AND tombstone.completed_at IS NULL
        )
        AND (
          EXISTS (
            SELECT 1
            FROM app.project_article project_article
            WHERE project_article.project_id = project.id
              AND project_article.article_id = judgment.article_id
          )
          OR EXISTS (
            SELECT 1
            FROM app.project_import_route project_import_route
            INNER JOIN app.article_import_route article_import_route
              ON article_import_route.import_route_id = project_import_route.import_route_id
            WHERE project_import_route.project_id = project.id
              AND article_import_route.article_id = judgment.article_id
          )
        )
    )
    SELECT
      candidate.id AS id,
      candidate.article_id AS articleId,
      candidate.model_id AS modelId,
      candidate.project_id AS projectId,
      candidate.prompt_id AS promptId,
      candidate.updated_at AS updatedAt,
      candidate.use_abstract AS useAbstract,
      candidate.use_fulltext AS useFulltext,
      candidate.use_fulltext_no_images AS useFulltextNoImages,
      candidate.use_metadata AS useMetadata,
      candidate.use_title AS useTitle,
      candidate.system_prompt_variant AS systemPromptVariant,
      candidate.full_text_strategy_id AS fullTextStrategyId,
      EXISTS (
        SELECT 1
        FROM app.comparison_project_prompt comparison_prompt
        INNER JOIN app.comparison_project comparison_project
          ON comparison_project.id = comparison_prompt.comparison_project_id
        WHERE comparison_prompt.prompt_id = candidate.prompt_id
          AND comparison_project.archived = FALSE
      ) AS comparisonPromptReferenced,
      EXISTS (
        SELECT 1
        FROM app.project other_project
        INNER JOIN app.project_prompt other_project_prompt
          ON other_project_prompt.project_id = other_project.id
        INNER JOIN app.article other_article ON other_article.id = candidate.article_id
        WHERE other_project.id <> '${escapeSqlString(params.projectId)}'
          AND other_project_prompt.prompt_id = candidate.prompt_id
          AND other_project_prompt.enabled = TRUE
          AND other_project.archived = FALSE
          AND other_project.delete_pending_at IS NULL
          AND other_project.model_id = (
            SELECT project.model_id FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND other_project.use_title = (
            SELECT project.use_title FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND other_project.use_abstract = (
            SELECT project.use_abstract FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND other_project.use_fulltext = (
            SELECT project.use_fulltext FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND other_project.use_fulltext_no_images = (
            SELECT project.use_fulltext_no_images FROM app.project project WHERE project.id = '${escapeSqlString(params.projectId)}'
          )
          AND COALESCE(other_project.use_metadata, FALSE) = candidate.use_metadata
          AND COALESCE(other_project.system_prompt_variant, 'legacy') = candidate.system_prompt_variant
          AND ${getProjectFullTextStrategyIdSql('other_project')} = candidate.full_text_strategy_id
          AND (other_project.date_from IS NULL OR other_article.article_created_at >= other_project.date_from)
          AND (other_project.date_to IS NULL OR other_article.article_created_at <= other_project.date_to)
          AND NOT EXISTS (
            SELECT 1
            FROM app.archived_project_delete_tombstone tombstone
            WHERE tombstone.project_id = other_project.id
              AND tombstone.completed_at IS NULL
          )
          AND (
            EXISTS (
              SELECT 1
              FROM app.project_article other_project_article
              WHERE other_project_article.project_id = other_project.id
                AND other_project_article.article_id = candidate.article_id
            )
            OR EXISTS (
              SELECT 1
              FROM app.project_import_route other_project_import_route
              INNER JOIN app.article_import_route other_article_import_route
                ON other_article_import_route.import_route_id = other_project_import_route.import_route_id
              WHERE other_project_import_route.project_id = other_project.id
                AND other_article_import_route.article_id = candidate.article_id
            )
          )
      ) AS sharedProjectReferenced
    FROM candidate
  `)
}

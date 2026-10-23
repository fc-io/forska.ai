import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {ProjectReviewConfig, ServingHumanJudgmentDetailRow} from './articleReviewDetailTypes.ts'
import {getProjectReviewDetailsWorkloadContext} from './getProjectReviewDetailsWorkloadContext.ts'

const getAppHumanPromptDetailRowsSql = (params: {articleId: string; projectId: string}) => {
  return `
    SELECT
      judgment_human.id AS judgment_id,
      judgment_human.article_id AS article_id,
      judgment_human.prompt_id AS prompt_id,
      judgment_human.answer AS answered_original,
      judgment_human.comment AS human_comment,
      judgment_human.created_at AS judgment_created_at,
      judgment_human.updated_at AS detail_updated_at,
      prompt.original_text AS prompt_original_text,
      prompt.prompt_heading AS prompt_heading,
      project_prompt.prompt_order AS prompt_order,
      prompt.type AS prompt_type,
      project_prompt.criteria_disposition AS prompt_criteria_disposition
    FROM app.judgment_human judgment_human
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = ${getSqlLiteral(params.projectId)}
      AND project_prompt.prompt_id = judgment_human.prompt_id
      AND project_prompt.enabled
      AND NOT project_prompt.archived
    INNER JOIN app.prompt prompt
      ON prompt.id = judgment_human.prompt_id
      AND COALESCE(prompt.archived, FALSE) = FALSE
    WHERE judgment_human.project_id = ${getSqlLiteral(params.projectId)}
      AND judgment_human.article_id = ${getSqlLiteral(params.articleId)}
    ORDER BY project_prompt.prompt_order ASC NULLS LAST, judgment_human.prompt_id ASC
  `
}

const getAppHumanSummaryDetailRowsSql = (params: {articleId: string; projectId: string}) => {
  return `
    SELECT
      judgment_human_summary.id AS judgment_id,
      judgment_human_summary.article_id AS article_id,
      'summary' AS prompt_id,
      judgment_human_summary.answer AS answered_original,
      NULL AS human_comment,
      judgment_human_summary.created_at AS judgment_created_at,
      judgment_human_summary.updated_at AS detail_updated_at,
      'Overall human screening decision' AS prompt_original_text,
      NULL AS prompt_heading,
      -1 AS prompt_order,
      'summary' AS prompt_type,
      NULL AS prompt_criteria_disposition
    FROM app.judgment_human_summary judgment_human_summary
    WHERE judgment_human_summary.project_id = ${getSqlLiteral(params.projectId)}
      AND judgment_human_summary.article_id = ${getSqlLiteral(params.articleId)}
    ORDER BY judgment_human_summary.updated_at DESC NULLS LAST, judgment_human_summary.id ASC
  `
}

export const getAppHumanDetailRows = async (params: {
  articleId: string
  humanJudgmentMode: ProjectReviewConfig['humanJudgmentMode']
  projectId: string
}) => {
  return getAppDatabaseService().queryJson<ServingHumanJudgmentDetailRow>(
    params.humanJudgmentMode === 'summary'
      ? getAppHumanSummaryDetailRowsSql(params)
      : getAppHumanPromptDetailRowsSql(params),
    getProjectReviewDetailsWorkloadContext({operation: 'appHumanJudgments', projectId: params.projectId}),
  )
}

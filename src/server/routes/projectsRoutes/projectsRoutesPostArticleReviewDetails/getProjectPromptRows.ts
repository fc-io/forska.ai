import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {ProjectPromptRow} from './articleReviewDetailTypes.ts'
import {getProjectReviewDetailsWorkloadContext} from './getProjectReviewDetailsWorkloadContext.ts'

export const getProjectPromptRows = async (projectId: string): Promise<ProjectPromptRow[]> => {
  return getAppDatabaseService().queryJson<ProjectPromptRow>(
    `
    SELECT
      prompt.id AS id,
      prompt.original_text AS originalText,
      prompt.prompt_heading AS promptHeading,
      project_prompt.prompt_order AS "order",
      prompt.type AS type,
      project_prompt.enabled AS enabled,
      project_prompt.criteria_disposition AS criteriaDisposition,
      project_prompt.origin_project_id AS originProjectId
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
    ORDER BY project_prompt.prompt_order ASC NULLS LAST, prompt.id ASC
  `,
    getProjectReviewDetailsWorkloadContext({operation: 'projectPrompts', projectId}),
  )
}

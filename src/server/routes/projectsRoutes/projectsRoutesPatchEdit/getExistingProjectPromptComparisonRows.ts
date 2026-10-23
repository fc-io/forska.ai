import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import type {ExistingProjectPromptComparisonRow} from './projectEditTypes.ts'

export const getExistingProjectPromptComparisonRows = async (projectId: string) => {
  return getAppDatabaseService().queryJson<ExistingProjectPromptComparisonRow>(`
    SELECT
      pp.id AS id,
      pp.prompt_id AS promptId,
      pp.origin_project_id AS originProjectId,
      pp.archived AS archived,
      pp.enabled AS enabled,
      pp.criteria_disposition AS criteriaDisposition,
      pp.criteria_section_key AS criteriaSectionKey,
      pp.criteria_section_label AS criteriaSectionLabel,
      pp.prompt_order AS "order",
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      p.type AS type
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${escapeSqlString(projectId)}'
  `)
}

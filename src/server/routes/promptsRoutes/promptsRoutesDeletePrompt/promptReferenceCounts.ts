import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'

type PromptReferenceCounts = {
  comparisonProjectCount: number
  humanJudgmentCount: number
  judgmentCount: number
  projectCount: number
}

export const getPromptReferenceCounts = async (id: string): Promise<PromptReferenceCounts> => {
  const [[projectCount], [comparisonProjectCount], [judgmentCount], [humanJudgmentCount]] = await Promise.all([
    getAppDatabaseService().queryJson<{count: number}>(`
      SELECT COUNT(*) AS count
      FROM app.project_prompt
      WHERE prompt_id = '${escapeSqlString(id)}'
    `),
    getAppDatabaseService().queryJson<{count: number}>(`
      SELECT COUNT(*) AS count
      FROM app.comparison_project_prompt
      WHERE prompt_id = '${escapeSqlString(id)}'
    `),
    getAppDatabaseService().queryJson<{count: number}>(`
      SELECT COUNT(*) AS count
      FROM app.judgment
      WHERE prompt_id = '${escapeSqlString(id)}'
    `),
    getAppDatabaseService().queryJson<{count: number}>(`
      SELECT COUNT(*) AS count
      FROM app.judgment_human
      WHERE prompt_id = '${escapeSqlString(id)}'
    `),
  ])

  return {
    projectCount: Number(projectCount?.count ?? 0),
    comparisonProjectCount: Number(comparisonProjectCount?.count ?? 0),
    judgmentCount: Number(judgmentCount?.count ?? 0),
    humanJudgmentCount: Number(humanJudgmentCount?.count ?? 0),
  }
}

export const hasPromptReferences = ({
  comparisonProjectCount,
  humanJudgmentCount,
  judgmentCount,
  projectCount,
}: PromptReferenceCounts) => {
  return projectCount > 0 || comparisonProjectCount > 0 || judgmentCount > 0 || humanJudgmentCount > 0
}

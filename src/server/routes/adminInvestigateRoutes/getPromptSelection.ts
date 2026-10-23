import * as appQueryHelpers from '../../services/appQueryHelpers.ts'
import {appDatabaseService, appQueryService} from './adminInvestigateRoutesServices.ts'

type PromptWithType = {id: string; promptHeading: string | null; type: string | null}

const getProjectPrompts = async (projectId: string) => {
  return appQueryService.getProjectPromptRows(projectId).then((rows) => {
    return rows.filter((row) => {
      return row.type !== null
    })
  })
}

export const getPromptSelection = async (projectId: string | null, promptId: string | null) => {
  return promptId
    ? appDatabaseService.queryJson<PromptWithType>(`
        SELECT id, prompt_heading AS promptHeading, type
        FROM app.prompt
        WHERE id = '${appQueryHelpers.escapeSqlString(promptId)}'
          AND type IS NOT NULL
      `)
    : projectId
      ? getProjectPrompts(projectId)
      : appDatabaseService.queryJson<PromptWithType>(`
          SELECT id, prompt_heading AS promptHeading, type
          FROM app.prompt
          WHERE type IS NOT NULL
        `)
}

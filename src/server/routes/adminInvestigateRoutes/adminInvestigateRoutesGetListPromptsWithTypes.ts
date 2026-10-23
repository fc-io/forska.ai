import * as appQueryHelpers from '../../services/appQueryHelpers.ts'
import {appDatabaseService} from './adminInvestigateRoutesServices.ts'
import {isOpenEndedType} from './promptTypeOptions.ts'

const getTypedPrompts = async () => {
  return appDatabaseService.queryJson<{
    id: string
    promptHeading: string | null
    type: string | null
    originalText: string
    createdAt: unknown
    archived: boolean
  }>(`
    SELECT
      id,
      prompt_heading AS promptHeading,
      type,
      original_text AS originalText,
      created_at AS createdAt,
      archived
    FROM app.prompt
    WHERE type IS NOT NULL
    ORDER BY prompt_heading ASC NULLS LAST
  `)
}

export const adminInvestigateRoutesGetListPromptsWithTypes = async () => {
  const promptsList = await getTypedPrompts()
  const filtered = promptsList.filter((prompt) => {
    return !isOpenEndedType(prompt.type)
  })

  return {
    prompts: filtered.map((prompt) => {
      return {
        id: prompt.id,
        promptHeading: prompt.promptHeading || 'Untitled',
        type: prompt.type,
        originalText: prompt.originalText,
        createdAt: appQueryHelpers.getDateValue(prompt.createdAt),
        archived: prompt.archived,
      }
    }),
  }
}

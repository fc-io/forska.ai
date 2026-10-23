import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getQuotedStringList} from '../../../services/appQueryHelpers.ts'
import {parseArktypeOptions} from '../../projectsRoutes/articlesReviewsFiltersUtils.ts'
import {getProjectExportWorkloadContext} from '../getProjectExportWorkloadContext.ts'
import type {PromptDetails} from '../projectExportRouteTypes.ts'

const getPromptDetails = async (projectId: string, promptIds: string[]) => {
  return promptIds.length === 0
    ? []
    : getAppDatabaseService().queryJson<PromptDetails>(
        `
        SELECT
          id,
          prompt_heading AS promptHeading,
          original_text AS originalText,
          type
        FROM app.prompt
        WHERE id IN (${getQuotedStringList(promptIds).join(', ')})
      `,
        getProjectExportWorkloadContext({maxResultRows: promptIds.length, operation: 'promptDetails', projectId}),
      )
}

export const getExportPromptFilters = async (
  projectId: string,
  promptSelections: Array<{promptId: string; types: string[]}>,
) => {
  const promptDetails = await getPromptDetails(
    projectId,
    promptSelections.map((selection) => {
      return selection.promptId
    }),
  )
  const answerOptionsByPromptId = new Map(
    promptDetails.map((prompt) => {
      return [prompt.id, parseArktypeOptions(prompt.type) ?? []]
    }),
  )

  return promptSelections.reduce<Record<string, string[]>>((filters, selection) => {
    const answerOptions = answerOptionsByPromptId.get(selection.promptId) ?? []
    const selectedAllOptions =
      answerOptions.length > 0
      && answerOptions.every((option) => {
        return selection.types.includes(option)
      })

    return selection.types.length > 0 && !selectedAllOptions
      ? {...filters, [selection.promptId]: selection.types}
      : filters
  }, {})
}

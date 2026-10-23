import * as appQueryHelpers from '../../services/appQueryHelpers.ts'
import {appDatabaseService} from './adminInvestigateRoutesServices.ts'
import {fetchProjectScope} from './fetchProjectScope.ts'
import {getPromptSelection} from './getPromptSelection.ts'
import {getUnexpectedAnswersSummary} from './getUnexpectedAnswersSummary.ts'
import {isOpenEndedType} from './promptTypeOptions.ts'

const getProjectName = async (projectId: string) => {
  const [project] = await appDatabaseService.queryJson<{name: string}>(`
    SELECT name
    FROM app.project
    WHERE id = '${appQueryHelpers.escapeSqlString(projectId)}'
    LIMIT 1
  `)

  return project?.name ?? null
}

export const adminInvestigateRoutesGetInvestigateUnexpectedAnswers = async ({
  query,
}: {
  query: {projectId?: string; promptId?: string}
}) => {
  const projectId = query.projectId
  const promptId = query.promptId

  console.log(
    `[Admin] Fetching prompts${projectId ? ` for project ${projectId}` : ''}${promptId ? ` for prompt ${promptId}` : ''}...`,
  )

  const projectName = projectId ? await getProjectName(projectId) : 'All Projects'
  if (projectId && !projectName) {
    throw new Error('Project not found')
  }

  const allPrompts = await getPromptSelection(projectId ?? null, promptId ?? null)
  console.log(`[Admin] Found ${allPrompts.length} prompts with defined types`)

  const projectScope = projectId ? await fetchProjectScope(projectId) : null
  if (projectId && !projectScope) {
    throw new Error('Project not found or has no configuration')
  }

  const results: Array<{
    promptId: string
    promptHeading: string
    expectedOptions: string[]
    unexpectedAnswers: Array<{value: string | null; count: number}>
    totalJudgments: number
    percentUnexpected: number
  }> = []

  for (const prompt of allPrompts) {
    if (isOpenEndedType(prompt.type)) {
      continue
    }

    const {expectedOptions, totalJudgments, unexpectedAnswers} = await getUnexpectedAnswersSummary({
      promptId: prompt.id,
      promptType: prompt.type,
      projectScope,
    })

    if (expectedOptions.length === 0 || unexpectedAnswers.length === 0) {
      continue
    }

    const unexpectedCount = unexpectedAnswers.reduce((sum, answer) => {
      return sum + answer.count
    }, 0)
    const percentUnexpected = totalJudgments > 0 ? (unexpectedCount / totalJudgments) * 100 : 0

    results.push({
      promptId: prompt.id,
      promptHeading: prompt.promptHeading || 'Untitled',
      expectedOptions,
      unexpectedAnswers,
      totalJudgments,
      percentUnexpected,
    })
  }

  console.log(`[Admin] Found ${results.length} prompts with unexpected answers`)

  return promptId
    ? {projectName, promptHeading: allPrompts[0]?.promptHeading || 'Untitled', result: results[0] ?? null}
    : {
        summary: {totalPromptsWithTypes: allPrompts.length, promptsWithUnexpectedAnswers: results.length},
        results: results.sort((left, right) => {
          return right.percentUnexpected - left.percentUnexpected
        }),
        projectName,
      }
}

import * as appQueryHelpers from '../../services/appQueryHelpers.ts'
import {appDatabaseService} from './adminInvestigateRoutesServices.ts'
import {fetchProjectScope} from './fetchProjectScope.ts'
import {getProjectJudgmentClause} from './getProjectJudgmentClause.ts'
import {isArrayType, isOpenEndedType, parseArktypeOptions} from './promptTypeOptions.ts'

const getPromptById = async (promptId: string) => {
  const [prompt] = await appDatabaseService.queryJson<{id: string; type: string | null}>(`
    SELECT id, type
    FROM app.prompt
    WHERE id = '${appQueryHelpers.escapeSqlString(promptId)}'
    LIMIT 1
  `)

  return prompt ?? null
}

export const deleteUnexpectedJudgments = async (
  projectId: string | null,
  promptId: string,
  unexpectedValue: string | null,
) => {
  const prompt = await getPromptById(promptId)

  if (!prompt || isOpenEndedType(prompt.type)) {
    return {deleted: 0}
  }

  const expectedOptions = parseArktypeOptions(prompt.type)
  if (expectedOptions.length === 0) {
    return {deleted: 0}
  }

  const projectScope = projectId ? await fetchProjectScope(projectId) : null
  if (projectId && !projectScope) {
    return {deleted: 0}
  }

  const isArray = isArrayType(prompt.type)
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])
  const judgmentRows = await appDatabaseService.queryJson<{
    id: string
    answeredOriginal: string | null
    answeredOriginalAsArray: string | null
  }>(`
    SELECT
      j.id AS id,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray
    FROM app.judgment j
    WHERE ${whereClause}
  `)
  const idsToDelete = judgmentRows
    .filter((row) => {
      const parsedArray = appQueryHelpers.getJsonValue(row.answeredOriginalAsArray)
      const currentValue = isArray ? (parsedArray === null ? null : JSON.stringify(parsedArray)) : row.answeredOriginal
      return currentValue === unexpectedValue
    })
    .map((row) => {
      return row.id
    })

  if (idsToDelete.length === 0) {
    return {deleted: 0}
  }

  const now = new Date()
  await appDatabaseService.run(`
    UPDATE app.judgment
    SET deleted_at = ${appQueryHelpers.getSqlLiteral(now)},
        updated_at = ${appQueryHelpers.getSqlLiteral(now)}
    WHERE id IN (${appQueryHelpers.getQuotedStringList(idsToDelete).join(', ')})
  `)

  return {deleted: idsToDelete.length}
}

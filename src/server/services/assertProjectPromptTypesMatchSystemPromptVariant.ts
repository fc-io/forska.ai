import {isIncludeExcludePromptType} from '../../agent/judge/isIncludeExcludePromptType.ts'
import {getSystemPromptVariant} from '../../agent/judge/systemPromptVariant.ts'
import {HttpError} from '../utils/httpError.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'

type EnabledPromptTypeRow = {promptType: string | null; systemPromptVariant: string | null}

const includeExcludeSystemPromptVariant = 'screening_v5'

const getUnsupportedIncludeExcludePromptRows = (rows: readonly EnabledPromptTypeRow[]) => {
  return rows.filter((row) => {
    return (
      isIncludeExcludePromptType(row.promptType)
      && getSystemPromptVariant(row.systemPromptVariant) !== includeExcludeSystemPromptVariant
    )
  })
}

export const assertProjectPromptTypesMatchSystemPromptVariant = async (projectId: string): Promise<void> => {
  const rows = await getAppDatabaseService().queryJson<EnabledPromptTypeRow>(`
    SELECT
      prompt.type AS promptType,
      project.system_prompt_variant AS systemPromptVariant
    FROM app.project project
    INNER JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = project.id
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project.id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT COALESCE(project_prompt.archived, FALSE)
      AND COALESCE(prompt.archived, FALSE) = FALSE
  `)
  const [unsupportedRow] = getUnsupportedIncludeExcludePromptRows(rows)

  if (unsupportedRow) {
    throw new HttpError(
      409,
      `Prompt type 'include' | 'exclude' requires system prompt variant ${includeExcludeSystemPromptVariant}; this project uses ${getSystemPromptVariant(unsupportedRow.systemPromptVariant)}.`,
    )
  }
}

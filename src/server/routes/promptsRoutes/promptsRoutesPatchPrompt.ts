import type {Context} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue} from '../../services/appQueryHelpers.ts'

export const promptsRoutesPatchPrompt = async ({
  params,
  body,
  set,
}: {
  params: {id: string}
  body: {archived: boolean}
  set: Context['set']
}) => {
  const [existingPrompt] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.prompt
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)

  if (!existingPrompt) {
    set.status = 404
    return {data: null, error: 'Prompt not found'}
  }

  const [updatedPrompt] = await getAppDatabaseService().queryJson<{
    id: string
    originalText: string
    promptHeading: string | null
    type: string | null
    createdAt: unknown
    updatedAt: unknown
    archived: boolean
  }>(`
        UPDATE app.prompt
        SET archived = ${body.archived ? 'TRUE' : 'FALSE'},
            updated_at = current_timestamp
        WHERE id = '${escapeSqlString(params.id)}'
        RETURNING
          id,
          original_text AS originalText,
          prompt_heading AS promptHeading,
          type,
          created_at AS createdAt,
          updated_at AS updatedAt,
          archived
      `)

  return {
    data: updatedPrompt
      ? {
          ...updatedPrompt,
          createdAt: getDateValue(updatedPrompt.createdAt),
          updatedAt: getDateValue(updatedPrompt.updatedAt),
        }
      : null,
  }
}

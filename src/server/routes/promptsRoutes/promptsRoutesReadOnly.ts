import {Elysia} from 'elysia'

import type {PromptRecord} from '../../../db/schemaTypes.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {withErrorHandler} from '../../utils/routeErrorHandler.ts'

type PromptListRow = Pick<PromptRecord, 'id' | 'originalText' | 'promptHeading' | 'type'> & {
  archived: boolean
  createdAt: unknown
  updatedAt: unknown
}

const normalizePromptListRow = <TRow extends Record<string, unknown>>(row: TRow) => {
  return {...row, createdAt: getDateValue(row['createdAt']), updatedAt: getDateValue(row['updatedAt'])}
}

const getPromptRows = async (archived: boolean) => {
  return getApiReadOnlyAppDatabaseService().queryJson<PromptListRow>(`
    SELECT
      id,
      original_text AS originalText,
      prompt_heading AS promptHeading,
      type,
      created_at AS createdAt,
      updated_at AS updatedAt,
      archived
    FROM app.prompt
    WHERE archived = ${archived ? 'TRUE' : 'FALSE'}
    ORDER BY created_at DESC
  `)
}

export const promptsReadOnlyRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/prompts', async () => {
    const list = await getPromptRows(false)

    return {data: list.map(normalizePromptListRow)}
  })
  .get('/api/prompts/archived', async () => {
    const list = await getPromptRows(true)

    return {data: list.map(normalizePromptListRow)}
  })

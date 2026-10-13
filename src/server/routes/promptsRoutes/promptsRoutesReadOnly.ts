import {Elysia} from 'elysia'

import type {PromptRecord} from '../../../db/schemaTypes.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {withErrorHandler} from '../../utils/routeErrorHandler.ts'

type PromptListRow = Pick<PromptRecord, 'id' | 'originalText' | 'promptHeading' | 'type'> & {
  archived: boolean
  createdAt: unknown
  linkedToCovidenceProject: boolean
  updatedAt: unknown
}

const normalizePromptListRow = <TRow extends Record<string, unknown>>(row: TRow) => {
  return {...row, createdAt: getDateValue(row['createdAt']), updatedAt: getDateValue(row['updatedAt'])}
}

// linkedToCovidenceProject: Covidence imports link a 'covidence:<id>' route to the project (see getImportRouteGroupKey).
// Keep the SQL free of prose: the read-only helper rejects statements containing words like "import".
const getPromptRows = async (archived: boolean) => {
  return getApiReadOnlyAppDatabaseService().queryJson<PromptListRow>(`
    SELECT
      p.id,
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      p.type,
      p.created_at AS createdAt,
      p.updated_at AS updatedAt,
      p.archived,
      EXISTS (
        SELECT 1
        FROM app.project_prompt pp
        INNER JOIN app.project_import_route pir ON pir.project_id = pp.project_id
        INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
        WHERE pp.prompt_id = p.id
          AND ir.route LIKE 'covidence:%'
      ) AS linkedToCovidenceProject
    FROM app.prompt p
    WHERE p.archived = ${archived ? 'TRUE' : 'FALSE'}
    ORDER BY p.created_at DESC
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

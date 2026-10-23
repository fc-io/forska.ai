import {getAppDatabaseService} from '../../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../../services/appQueryHelpers.ts'
import {getProjectExportWorkloadContext} from '../../getProjectExportWorkloadContext.ts'
import type {PromptDetails} from '../../projectExportRouteTypes.ts'
import type {ExportServingSnapshotScope} from '../projectExportDownloadTypes.ts'

type PromptDetailsRow = PromptDetails & {promptOrder: number | null; sourceProjectOrder: number}

export const getExportPromptDetails = async (input: {
  promptIds: string[]
  projectId: string
  snapshotScopes: ExportServingSnapshotScope[]
}) => {
  if (input.promptIds.length === 0) {
    return []
  }

  if (input.snapshotScopes.length === 0) {
    return input.promptIds.map((promptId) => {
      return {id: promptId, originalText: null, promptHeading: promptId, type: null}
    })
  }

  const scopeRows = input.snapshotScopes
    .map((scope, index) => {
      return `(${getSqlLiteral(scope.projectId)}, ${getSqlLiteral(scope.reviewConfigHash)}, ${getSqlLiteral(scope.snapshotId)}, ${index})`
    })
    .join(', ')
  const promptRows = input.promptIds
    .map((promptId) => {
      return `(${getSqlLiteral(promptId)})`
    })
    .join(', ')
  const maxResultRows = input.promptIds.length * Math.max(input.snapshotScopes.length, 1)
  const rows = await getAppDatabaseService().queryJson<PromptDetailsRow>(
    `
    WITH
      export_scope(project_id, review_config_hash, snapshot_id, source_project_order) AS (VALUES ${scopeRows}),
      export_prompt(prompt_id) AS (VALUES ${promptRows})
    SELECT
      prompt.id AS id,
      prompt.prompt_heading AS promptHeading,
      prompt.original_text AS originalText,
      prompt.type,
      project_prompt.prompt_order AS promptOrder,
      export_scope.source_project_order AS sourceProjectOrder
    FROM export_scope
    INNER JOIN export_prompt
      ON TRUE
    INNER JOIN app.prompt prompt
      ON prompt.id = export_prompt.prompt_id
    LEFT JOIN app.project_prompt project_prompt
      ON project_prompt.project_id = export_scope.project_id
     AND project_prompt.prompt_id = export_prompt.prompt_id
    ORDER BY project_prompt.prompt_order ASC NULLS LAST, prompt.id ASC, export_scope.source_project_order ASC
    LIMIT ${getSqlLiteral(maxResultRows)}
  `,
    getProjectExportWorkloadContext({maxResultRows, operation: 'servingPromptDetails', projectId: input.projectId}),
  )
  const rowByPromptId = rows.reduce<Map<string, PromptDetails>>((details, row) => {
    return details.has(row.id) ? details : details.set(row.id, row)
  }, new Map())

  return input.promptIds.map((promptId) => {
    return rowByPromptId.get(promptId) ?? {id: promptId, originalText: null, promptHeading: promptId, type: null}
  })
}

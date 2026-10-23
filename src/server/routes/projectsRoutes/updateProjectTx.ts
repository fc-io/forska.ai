import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import type {AppTx} from './appTx.ts'
import {getProjectRow} from './getProjectRow.ts'

export const updateProjectTx = async (tx: AppTx, params: {projectId: string; updateParts: string[]}) => {
  await tx.run(`
    UPDATE app.project
    SET ${params.updateParts.join(', ')}
    WHERE id = '${escapeSqlString(params.projectId)}'
      AND delete_pending_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app.archived_project_delete_tombstone tombstone
        WHERE tombstone.project_id = app.project.id
          AND tombstone.completed_at IS NULL
      )
  `)

  return getProjectRow(tx, params.projectId)
}

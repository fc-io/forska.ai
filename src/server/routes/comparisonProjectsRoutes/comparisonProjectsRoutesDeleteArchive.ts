import {Elysia} from 'elysia'

import {checkpointComparisonProjectMutation} from './comparisonProjectMutationCheckpoint.ts'
import {updateComparisonProjectTx} from './comparisonProjectRecord.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'

export const comparisonProjectsRoutesDeleteArchive = new Elysia().delete(
  '/api/comparison-projects/:id',
  async (context) => {
    const {params, set} = context
    const archivedComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return updateComparisonProjectTx(tx, {
        comparisonProjectId: params.id,
        setParts: ['archived = TRUE', 'updated_at = current_timestamp'],
      })
    })

    if (!archivedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    await checkpointComparisonProjectMutation()

    return {success: true}
  },
)

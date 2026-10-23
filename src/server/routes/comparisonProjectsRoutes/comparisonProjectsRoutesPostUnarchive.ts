import {Elysia} from 'elysia'

import {checkpointComparisonProjectMutation} from './comparisonProjectMutationCheckpoint.ts'
import {updateComparisonProjectTx} from './comparisonProjectRecord.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'

export const comparisonProjectsRoutesPostUnarchive = new Elysia().post(
  '/api/comparison-projects/:id/unarchive',
  async (context) => {
    const {params, set} = context
    const unarchivedComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return updateComparisonProjectTx(tx, {
        comparisonProjectId: params.id,
        setParts: ['archived = FALSE', 'updated_at = current_timestamp'],
      })
    })

    if (!unarchivedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    await checkpointComparisonProjectMutation()

    return {success: true}
  },
)

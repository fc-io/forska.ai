import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {appendProjectReviewConfigDeltaIfNeeded} from './appendProjectReviewConfigDeltaIfNeeded.ts'
import {getReviewServingSourceTimestamp} from './getReviewServingSourceTimestamp.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'
import {updateProjectTx} from './updateProjectTx.ts'

export const projectsRoutesDeleteProject = async ({params}: {params: {id: string}}) => {
  await assertProjectIsActive(params.id)

  const archivedProject = await getAppDatabaseService().transaction(async (tx) => {
    const updatedProject = await updateProjectTx(tx, {
      projectId: params.id,
      updateParts: ['archived = TRUE', 'updated_at = current_timestamp'],
    })

    if (updatedProject) {
      await appendProjectReviewConfigDeltaIfNeeded(tx, {
        changedReviewConfigFields: ['archived'],
        projectId: params.id,
        sourceMutationKey: `projectArchive|${params.id}|${getReviewServingSourceTimestamp(updatedProject.updatedAt)}`,
        sourceOperation: 'update',
        sourceUpdatedAt: getReviewServingSourceTimestamp(updatedProject.updatedAt),
      })
      await tx.run(`
          UPDATE app.judgment_job
          SET status = CASE
                WHEN status IN ('completed', 'failed', 'project_removed') THEN status
                ELSE 'project_removed'
              END,
              storage_state = CASE
                WHEN storage_state IN ('drained', 'quarantined') THEN storage_state
                ELSE 'draining'
              END,
              pause_requested_at = current_timestamp,
              updated_at = current_timestamp
          WHERE project_id = '${escapeSqlString(params.id)}'
        `)
    }

    return updatedProject
  })

  if (!archivedProject) {
    throw new Error('Project not found')
  }

  return {success: true}
}

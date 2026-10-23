import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {appendProjectReviewConfigDeltaIfNeeded} from './appendProjectReviewConfigDeltaIfNeeded.ts'
import {getReviewServingSourceTimestamp} from './getReviewServingSourceTimestamp.ts'
import {updateProjectTx} from './updateProjectTx.ts'

export const projectsRoutesPostUnarchive = async ({params}: {params: {id: string}}) => {
  const unarchivedProject = await getAppDatabaseService().transaction(async (tx) => {
    const updatedProject = await updateProjectTx(tx, {
      projectId: params.id,
      updateParts: ['archived = FALSE', 'updated_at = current_timestamp'],
    })

    if (updatedProject) {
      await appendProjectReviewConfigDeltaIfNeeded(tx, {
        changedReviewConfigFields: ['archived'],
        projectId: params.id,
        sourceMutationKey: `projectUnarchive|${params.id}|${getReviewServingSourceTimestamp(updatedProject.updatedAt)}`,
        sourceOperation: 'update',
        sourceUpdatedAt: getReviewServingSourceTimestamp(updatedProject.updatedAt),
      })
    }

    return updatedProject
  })

  if (!unarchivedProject) {
    throw new Error('Project not found')
  }

  return {success: true}
}

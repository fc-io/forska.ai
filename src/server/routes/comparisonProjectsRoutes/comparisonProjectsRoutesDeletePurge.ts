import {Elysia} from 'elysia'

import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import {comparisonProjectConflictCommentTable} from './comparisonProjectConflictComment.ts'
import {checkpointComparisonProjectMutation} from './comparisonProjectMutationCheckpoint.ts'
import {getComparisonProjectRecord} from './comparisonProjectRecord.ts'
import {
  comparisonProjectConflictResolutionTable,
  comparisonProjectImportRouteTable,
  comparisonProjectPromptTable,
  comparisonProjectSourceProjectTable,
  comparisonProjectTable,
} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService, comparisonProjectServingGenerationService} from './comparisonProjectRouteServices.ts'
import type {AppTx} from './comparisonProjectRouteTypes.ts'

const getComparisonProjectServingGenerationTxDependencies = (tx: AppTx) => {
  return {
    queryJson: tx.queryJson,
    transaction: <T>(operation: (runner: Pick<AppTx, 'queryJson' | 'run'>) => Promise<T>) => {
      return operation(tx)
    },
  }
}

const purgeArchivedComparisonProjectTx = async (tx: AppTx, comparisonProjectId: string) => {
  const comparisonProject = await getComparisonProjectRecord(tx, comparisonProjectId)

  if (!comparisonProject) {
    return null
  }

  if (!comparisonProject.archived) {
    throw new HttpError(409, 'Comparison project must be archived before it can be permanently deleted')
  }

  try {
    await comparisonProjectServingGenerationService.cleanupComparisonProjectServing(
      comparisonProjectId,
      getComparisonProjectServingGenerationTxDependencies(tx),
    )
  } catch (error) {
    throw new HttpError(500, 'Failed to clean up comparison project serving data before permanent delete', {
      cause: error,
    })
  }

  await tx.run(`
    DELETE FROM app.comparison_project_serving_generation
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectConflictCommentTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectPromptTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectImportRouteTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  await tx.run(`
    DELETE FROM ${comparisonProjectSourceProjectTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
  const [deletedComparisonProject] = await tx.queryJson<{id: string}>(`
    DELETE FROM ${comparisonProjectTable}
    WHERE id = ${getSqlLiteral(comparisonProjectId)}
      AND archived = TRUE
    RETURNING id
  `)

  if (!deletedComparisonProject) {
    throw new Error('Failed to delete archived comparison project')
  }

  return comparisonProject
}

export const comparisonProjectsRoutesDeletePurge = new Elysia().delete(
  '/api/comparison-projects/:id/purge',
  async (context) => {
    const {params, set} = context
    const purgedComparisonProject = await appDatabaseService.transaction(async (tx) => {
      return purgeArchivedComparisonProjectTx(tx, params.id)
    })

    if (!purgedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    await checkpointComparisonProjectMutation()

    return {success: true}
  },
)

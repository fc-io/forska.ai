import {
  appendProjectReviewConfigReviewServingDelta,
  type ProjectReviewConfigReviewServingField,
} from '../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import type {AppTx} from './appTx.ts'

export const appendProjectReviewConfigDeltaIfNeeded = async (
  tx: AppTx,
  params: {
    changedReviewConfigFields: ProjectReviewConfigReviewServingField[]
    projectId: string
    sourceMutationKey: string
    sourceOperation: 'insert' | 'update' | 'upsert'
    sourceUpdatedAt?: Date | string | null
    sourceTable?: string
  },
) => {
  return params.changedReviewConfigFields.length === 0
    ? undefined
    : await appendProjectReviewConfigReviewServingDelta(tx, {
        changedReviewConfigFields: params.changedReviewConfigFields,
        projectId: params.projectId,
        sourceMutationKey: params.sourceMutationKey,
        sourceOperation: params.sourceOperation,
        sourceUpdatedAt: params.sourceUpdatedAt,
        sourceTable: params.sourceTable,
      })
}

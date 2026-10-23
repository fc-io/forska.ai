import {assertSelectableProviderModelIds} from '../../providers/providerModelRepository.ts'
import {projectTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'

export const getValidatedComparisonSourceProjectIds = async (db: AppQueryRunner, sourceProjectIds: string[]) => {
  const uniqueSourceProjectIds = getUniqueStringValues(sourceProjectIds)

  if (uniqueSourceProjectIds.length === 0) {
    return []
  }

  const sourceProjectRows = await db.queryJson<{id: string}>(`
    SELECT id
    FROM ${projectTable}
    WHERE id IN (${getInClause(uniqueSourceProjectIds)})
      AND archived = FALSE
  `)

  if (sourceProjectRows.length !== uniqueSourceProjectIds.length) {
    throw new Error('One or more selected source projects are invalid')
  }

  return uniqueSourceProjectIds
}

export const getValidatedModelIds = async (db: AppQueryRunner, modelIds: string[]) => {
  if (modelIds.length === 0) {
    return null
  }

  return assertSelectableProviderModelIds(db, {
    errorMessage: 'One or more selected models do not exist or are disabled',
    modelIds,
  })
}

export const getSummarySourceProjectId = (summarySourceProjectId?: string | null) => {
  const trimmedSummarySourceProjectId = summarySourceProjectId?.trim() ?? ''

  if (!trimmedSummarySourceProjectId) {
    throw new Error('Summary mode requires a summary source project')
  }

  return trimmedSummarySourceProjectId
}

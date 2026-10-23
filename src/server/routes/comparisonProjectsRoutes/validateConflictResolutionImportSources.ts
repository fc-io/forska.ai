import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {getConflictResolutionImportRejectedError} from './comparisonProjectConflictResolutionImportValidation.ts'
import {comparisonProjectConflictResolutionTable, comparisonProjectTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'

type ComparisonProjectConflictResolutionImportSourceValidationRow = {
  allowConflictResolution: boolean | null
  archived: boolean
  humanJudgmentMode: HumanJudgmentMode | null
  id: string
  resolutionCount: unknown
}

export const validateConflictResolutionImportSources = async (
  db: AppQueryRunner,
  sourceComparisonProjectIds: string[],
) => {
  if (sourceComparisonProjectIds.length === 0) {
    return
  }

  const rows = await db.queryJson<ComparisonProjectConflictResolutionImportSourceValidationRow>(`
    SELECT
      cp.id AS id,
      COALESCE(cp.allow_conflict_resolution, FALSE) AS allowConflictResolution,
      cp.archived AS archived,
      cp.human_judgment_mode AS humanJudgmentMode,
      COUNT(cr.id) AS resolutionCount
    FROM ${comparisonProjectTable} cp
    LEFT JOIN ${comparisonProjectConflictResolutionTable} cr ON cr.comparison_project_id = cp.id
    WHERE cp.id IN (${getInClause(sourceComparisonProjectIds)})
    GROUP BY cp.id, cp.allow_conflict_resolution, cp.archived, cp.human_judgment_mode
  `)
  const rowsById = rows.reduce<Map<string, ComparisonProjectConflictResolutionImportSourceValidationRow>>(
    (rowMap, row) => {
      rowMap.set(row.id, row)
      return rowMap
    },
    new Map<string, ComparisonProjectConflictResolutionImportSourceValidationRow>(),
  )
  const missingSourceId = sourceComparisonProjectIds.find((sourceComparisonProjectId) => {
    return !rowsById.has(sourceComparisonProjectId)
  })
  const archivedSource = rows.find((row) => {
    return row.archived
  })
  const disabledSource = rows.find((row) => {
    return !row.allowConflictResolution
  })
  const nonSummarySource = rows.find((row) => {
    return row.humanJudgmentMode !== 'summary'
  })
  const emptySource = rows.find((row) => {
    return Number(row.resolutionCount ?? 0) <= 0
  })

  if (missingSourceId) {
    throw getConflictResolutionImportRejectedError('One or more conflict resolution import sources were not found')
  }

  if (archivedSource) {
    throw getConflictResolutionImportRejectedError('Conflict resolution import sources must not be archived')
  }

  if (disabledSource) {
    throw getConflictResolutionImportRejectedError('Conflict resolution import sources must allow conflict resolution')
  }

  if (nonSummarySource) {
    throw getConflictResolutionImportRejectedError('Conflict resolution import sources must use summary mode')
  }

  if (emptySource) {
    throw getConflictResolutionImportRejectedError('Conflict resolution import sources must contain resolutions')
  }
}

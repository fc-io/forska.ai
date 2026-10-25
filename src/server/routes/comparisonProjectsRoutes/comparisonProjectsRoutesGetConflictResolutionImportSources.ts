import {Elysia} from 'elysia'

import {getComparisonProjectConflictResolutionImportSourcesSql} from './comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportSourcesSql.ts'
import {
  type ComparisonProjectConflictResolutionImportSourceQueryRow,
  getComparisonProjectConflictResolutionImportSourceValue,
} from './comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportSourceValue.ts'
import {comparisonProjectConflictResolutionTable, comparisonProjectTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'

const getComparisonProjectConflictResolutionImportSources = async () => {
  const rows = await appDatabaseService.queryJson<ComparisonProjectConflictResolutionImportSourceQueryRow>(
    getComparisonProjectConflictResolutionImportSourcesSql({
      comparisonProjectConflictResolutionTable,
      comparisonProjectTable,
    }),
  )

  return rows.map(getComparisonProjectConflictResolutionImportSourceValue)
}

export const comparisonProjectsRoutesGetConflictResolutionImportSources = new Elysia().get(
  '/api/comparison-projects/conflict-resolution-import-sources',
  async () => {
    const data = await getComparisonProjectConflictResolutionImportSources()

    return {data}
  },
)

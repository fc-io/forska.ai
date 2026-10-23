import {Elysia, t} from 'elysia'

import {getComparisonJudgmentContextsByIds} from '../../services/comparisonJudgmentContext.ts'
import {
  type ComparisonProjectConflictResolutionTransferJudgmentContextV2,
  type ComparisonProjectConflictResolutionTransferSourceRow,
  createComparisonProjectConflictResolutionTransferArtifact,
  getComparisonProjectConflictResolutionTransferFilename,
  getComparisonProjectConflictResolutionTransferRows,
} from './comparisonProjectConflictResolutionFileTransfer.ts'
import {
  comparisonProjectFilterSelectionBodySchema,
  type ComparisonProjectJudgmentFilters,
  getRequestedComparisonProjectJudgmentFilters,
} from './comparisonProjectJudgmentFilters.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectConflictResolutionExportSourceRows} from './comparisonProjectsRoutesPostConflictResolutionsExport/getComparisonProjectConflictResolutionExportSourceRows.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'

const getComparisonProjectConflictResolutionExportJudgmentContexts = async (
  sourceRows: readonly ComparisonProjectConflictResolutionTransferSourceRow[],
): Promise<ComparisonProjectConflictResolutionTransferJudgmentContextV2[]> => {
  const summaries = await getComparisonJudgmentContextsByIds(
    appDatabaseService,
    getUniqueStringValues(
      sourceRows.map((sourceRow) => {
        return sourceRow.provenanceContextId ?? ''
      }),
    ),
  )

  return summaries.map((summary) => {
    return {context: summary.context, id: summary.id}
  })
}

const getComparisonProjectConflictResolutionExportResponse = async (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
) => {
  const exportedAt = new Date()
  const sourceRows = await getComparisonProjectConflictResolutionExportSourceRows(scope, filters)
  const artifact = createComparisonProjectConflictResolutionTransferArtifact({
    exportedAt,
    judgmentContexts: await getComparisonProjectConflictResolutionExportJudgmentContexts(sourceRows),
    source: {
      comparisonProjectId: scope.id,
      comparisonProjectName: scope.name,
      comparisonProjectDescription: scope.description,
    },
    rows: getComparisonProjectConflictResolutionTransferRows(sourceRows),
  })
  const filename = getComparisonProjectConflictResolutionTransferFilename(scope.id)

  return new Response(JSON.stringify(artifact), {
    headers: {'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Type': 'application/json'},
  })
}

export const comparisonProjectsRoutesPostConflictResolutionsExport = new Elysia().post(
  '/api/comparison-projects/:id/conflict-resolutions/export',
  async (context) => {
    const {params, body, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    if (scope.activeGeneration === null) {
      set.status = 409
      return {data: null, error: 'Conflict resolution export requires an active comparison serving generation'}
    }

    return getComparisonProjectConflictResolutionExportResponse(
      scope,
      getRequestedComparisonProjectJudgmentFilters(scope, body),
    )
  },
  {
    body: t.Object({
      rowFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      articleCategoryFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      conflictResolutionFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      conflictResolutionProvenanceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      differenceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      search: t.Optional(t.String()),
    }),
  },
)

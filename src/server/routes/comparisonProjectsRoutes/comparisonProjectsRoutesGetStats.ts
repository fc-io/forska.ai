import {Elysia, t} from 'elysia'

import type {ComparisonProjectServingStatus} from '../../../db/schemaTypes.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectStatsWithCategoryBreakdowns} from './comparisonProjectStats.ts'
import type {
  ComparisonProjectAdditionalStats,
  ComparisonProjectStatsCategoryBreakdown,
  ComparisonProjectStatsComparison,
  ComparisonProjectStatsConflictResolutionProvenance,
} from './comparisonProjectStats/comparisonProjectStatsTypes.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

type ComparisonProjectStatsConflictResolutionProvenanceScope = {
  applied: boolean
  reason: 'no-active-context' | null
  requested: ComparisonProjectStatsConflictResolutionProvenance
}
type ComparisonProjectStatsResponse = {
  activeGeneration: number | null
  additionalProjectStats: ComparisonProjectAdditionalStats
  categoryBreakdowns: ComparisonProjectStatsCategoryBreakdown[]
  comparisons: ComparisonProjectStatsComparison[]
  conflictResolutionProvenance: ComparisonProjectStatsConflictResolutionProvenance
  conflictResolutionProvenanceScope: ComparisonProjectStatsConflictResolutionProvenanceScope
  judgmentContextId: string | null
  isServingReady: boolean
  servingStatus: ComparisonProjectServingStatus
  servingUpdatedAt: Date | null
}

const getComparisonProjectStatsConflictResolutionProvenanceScope = (
  requested: ComparisonProjectStatsConflictResolutionProvenance,
  judgmentContextId: string | null,
): ComparisonProjectStatsConflictResolutionProvenanceScope => {
  return requested === 'current' && judgmentContextId === null
    ? {applied: false, reason: 'no-active-context', requested}
    : {applied: true, reason: null, requested}
}

const getComparisonProjectStatsResponse = async (
  scope: ComparisonProjectScope,
  conflictResolutionProvenance: ComparisonProjectStatsConflictResolutionProvenance = 'all',
): Promise<ComparisonProjectStatsResponse> => {
  const conflictResolutionProvenanceScope = getComparisonProjectStatsConflictResolutionProvenanceScope(
    conflictResolutionProvenance,
    scope.judgmentContextId,
  )

  if (scope.archived) {
    return {
      activeGeneration: scope.activeGeneration,
      additionalProjectStats: {conflictResolutionAnswerComparisons: [], resolvedTruthComparisons: []},
      categoryBreakdowns: [],
      comparisons: [],
      conflictResolutionProvenance,
      conflictResolutionProvenanceScope,
      judgmentContextId: scope.judgmentContextId,
      isServingReady: scope.isServingReady,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
    }
  }

  const statsParams = {
    allowConflictResolution: scope.allowConflictResolution,
    columns: scope.columns,
    comparisonProjectId: scope.id,
    conflictResolutionProvenance: conflictResolutionProvenanceScope.applied ? conflictResolutionProvenance : 'all',
    currentJudgmentContextId: scope.judgmentContextId,
    generation: scope.activeGeneration,
    isSummaryMode: getIsSummaryMode(scope),
    primaryModelId: scope.modelIds?.[0] ?? null,
    primarySourceProjectId: scope.summarySourceProjectId ?? scope.sourceProjectIds[0] ?? null,
    queryRunner: appDatabaseService,
  }
  const stats = await getComparisonProjectStatsWithCategoryBreakdowns(statsParams)

  return {
    activeGeneration: scope.activeGeneration,
    additionalProjectStats: stats.additionalProjectStats,
    categoryBreakdowns: stats.categoryBreakdowns,
    comparisons: stats.comparisons,
    conflictResolutionProvenance,
    conflictResolutionProvenanceScope,
    judgmentContextId: scope.judgmentContextId,
    isServingReady: scope.isServingReady,
    servingStatus: scope.servingStatus,
    servingUpdatedAt: scope.servingUpdatedAt,
  }
}

export const comparisonProjectsRoutesGetStats = new Elysia().get(
  '/api/comparison-projects/:id/stats',
  async (context) => {
    const {params, query, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const data = await getComparisonProjectStatsResponse(scope, query.conflictResolutionProvenance ?? 'all')

    return {data}
  },
  {query: t.Object({conflictResolutionProvenance: t.Optional(t.Union([t.Literal('all'), t.Literal('current')]))})},
)

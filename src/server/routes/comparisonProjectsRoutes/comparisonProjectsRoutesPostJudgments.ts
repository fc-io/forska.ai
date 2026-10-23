import {Elysia, t} from 'elysia'

import {getNormalizedComparisonProjectDifferenceFilters} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  comparisonProjectFilterSelectionBodySchema,
  type ComparisonProjectJudgmentFilters,
  getComparisonProjectDifferenceFilterAvailability,
  getRequestedComparisonProjectJudgmentFilters,
} from './comparisonProjectJudgmentFilters.ts'
import {getComparisonProjectServingJudgmentRowsPage} from './comparisonProjectJudgmentRows.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getRequestedPositiveInteger} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectRowsWithConflictResolutions} from './getComparisonProjectRowsWithConflictResolutions.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'

const getComparisonProjectJudgmentsCursor = (params: {cursor?: string | null; limit: number; page: number}) => {
  return params.cursor ?? (params.page > 1 ? String((params.page - 1) * params.limit - 1) : null)
}

const getComparisonProjectJudgmentsPage = async (
  scope: ComparisonProjectScope,
  page: number,
  limit: number,
  cursor: string | null,
  filters: ComparisonProjectJudgmentFilters,
) => {
  if (scope.archived || scope.prompts.length === 0 || scope.columns.length === 0) {
    return {
      activeGeneration: scope.activeGeneration,
      data: [],
      isServingReady: scope.isServingReady,
      limit,
      nextCursor: null,
      page: 1,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
      totalCount: null,
      totalPages: null,
    }
  }

  if (scope.activeGeneration === null) {
    return {
      activeGeneration: scope.activeGeneration,
      data: [],
      isServingReady: scope.isServingReady,
      limit,
      nextCursor: null,
      page: 1,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
      totalCount: null,
      totalPages: null,
    }
  }

  const normalizedDifferenceFilters = getNormalizedComparisonProjectDifferenceFilters(
    filters.differenceFilters,
    scope.columns,
    getComparisonProjectDifferenceFilterAvailability(scope),
  )
  const pageResult = await getComparisonProjectServingJudgmentRowsPage({
    comparisonProjectId: scope.id,
    articleCategoryFilter: filters.articleCategoryFilters,
    conflictResolutionFilter: filters.conflictResolutionFilters,
    conflictResolutionProvenanceFilter: filters.conflictResolutionProvenanceFilters,
    currentJudgmentContextId: scope.judgmentContextId,
    cursor,
    differenceFilter: normalizedDifferenceFilters,
    limit,
    queryRunner: appDatabaseService,
    rowFilter: filters.rowFilters,
    searchText: filters.searchText,
  })
  const rowsWithConflictResolutions = await getComparisonProjectRowsWithConflictResolutions(scope, pageResult.rows)

  return {
    activeGeneration: scope.activeGeneration,
    data: rowsWithConflictResolutions,
    isServingReady: scope.isServingReady,
    limit,
    nextCursor: pageResult.nextCursor,
    page,
    servingStatus: scope.servingStatus,
    servingUpdatedAt: scope.servingUpdatedAt,
    totalCount: null,
    totalPages: null,
  }
}

export const comparisonProjectsRoutesPostJudgments = new Elysia().post(
  '/api/comparison-projects/:id/judgments',
  async (context) => {
    const {params, body, set} = context
    const data = await getComparisonProjectScope(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const parsedPage = getRequestedPositiveInteger(body.page, 1)
    const parsedLimit = getRequestedPositiveInteger(body.limit, 50)
    const page = Math.max(parsedPage, 1)
    const limit = Math.min(Math.max(parsedLimit, 1), 100)
    const cursor = getComparisonProjectJudgmentsCursor({cursor: body.cursor, limit, page})
    const filters = getRequestedComparisonProjectJudgmentFilters(data, body)
    const judgmentsPage = await getComparisonProjectJudgmentsPage(data, page, limit, cursor, filters)

    return {data: judgmentsPage}
  },
  {
    body: t.Object({
      page: t.Optional(t.Union([t.String(), t.Number()])),
      limit: t.Union([t.String(), t.Number()]),
      cursor: t.Optional(t.Nullable(t.String())),
      search: t.Optional(t.String()),
      rowFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      articleCategoryFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      conflictResolutionFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      conflictResolutionProvenanceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      differenceFilter: t.Optional(comparisonProjectFilterSelectionBodySchema),
      showOnlyModelDifferences: t.Optional(t.Boolean()),
    }),
  },
)

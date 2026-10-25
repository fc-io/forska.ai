import {
  getComparisonProjectStatsAggregateColumnIds,
  getComparisonProjectStatsColumnIds,
  getComparisonProjectStatsResolvedTruthColumnIds,
} from './comparisonProjectStats/comparisonProjectStatsColumnIds.ts'
import type {
  ComparisonProjectAdditionalStats,
  ComparisonProjectStatsAggregateRow,
  ComparisonProjectStatsArticleCategoryCountRow,
  ComparisonProjectStatsCategoryBreakdown,
  ComparisonProjectStatsColumn,
  ComparisonProjectStatsComparison,
  ComparisonProjectStatsConflictResolutionProvenanceParams,
  ComparisonProjectStatsQueryRunner,
  ComparisonProjectStatsResolvedTruthAggregateRow,
} from './comparisonProjectStats/comparisonProjectStatsTypes.ts'
import {getComparisonProjectAdditionalStatsFromAggregates} from './comparisonProjectStats/getComparisonProjectAdditionalStatsFromAggregates.ts'
import {getComparisonProjectAdditionalStatsGroups} from './comparisonProjectStats/getComparisonProjectAdditionalStatsGroups.ts'
import {getComparisonProjectConflictResolutionAnswerStatsFromAggregates} from './comparisonProjectStats/getComparisonProjectConflictResolutionAnswerStatsFromAggregates.ts'
import {getComparisonProjectConflictResolutionAnswerStatsGroups} from './comparisonProjectStats/getComparisonProjectConflictResolutionAnswerStatsGroups.ts'
import {getComparisonProjectStatsActiveGeneration} from './comparisonProjectStats/getComparisonProjectStatsActiveGeneration.ts'
import {getComparisonProjectStatsAggregatesSql} from './comparisonProjectStats/getComparisonProjectStatsAggregatesSql.ts'
import {getComparisonProjectStatsArticleCategoryCountsSql} from './comparisonProjectStats/getComparisonProjectStatsArticleCategoryCountsSql.ts'
import {getComparisonProjectStatsCategoryBreakdownsFromAggregates} from './comparisonProjectStats/getComparisonProjectStatsCategoryBreakdownsFromAggregates.ts'
import {getComparisonProjectStatsComparisonGroups} from './comparisonProjectStats/getComparisonProjectStatsComparisonGroups.ts'
import {getComparisonProjectStatsFromAggregates} from './comparisonProjectStats/getComparisonProjectStatsFromAggregates.ts'
import {getComparisonProjectStatsResolvedTruthAggregatesSql} from './comparisonProjectStats/getComparisonProjectStatsResolvedTruthAggregatesSql.ts'

type ComparisonProjectStatsParams = ComparisonProjectStatsConflictResolutionProvenanceParams & {
  allowConflictResolution?: boolean
  columns: readonly ComparisonProjectStatsColumn[]
  comparisonProjectId: string
  generation?: number | null
  isSummaryMode: boolean
  primaryModelId?: string | null
  primarySourceProjectId?: string | null
  queryRunner: ComparisonProjectStatsQueryRunner
}

const emptyComparisonProjectAdditionalStats = {
  conflictResolutionAnswerComparisons: [],
  resolvedTruthComparisons: [],
} satisfies ComparisonProjectAdditionalStats

export const getComparisonProjectStats = async (params: ComparisonProjectStatsParams) => {
  const groups = getComparisonProjectStatsComparisonGroups(params)
  const columnIds = getComparisonProjectStatsColumnIds(groups)

  if (columnIds.length === 0) {
    return []
  }

  const generation = await getComparisonProjectStatsActiveGeneration(params)

  if (generation === null) {
    return []
  }

  const aggregateRows = await params.queryRunner.queryJson<ComparisonProjectStatsAggregateRow>(
    getComparisonProjectStatsAggregatesSql({
      columnIds,
      comparisonProjectId: params.comparisonProjectId,
      conflictResolutionProvenance: params.conflictResolutionProvenance,
      currentJudgmentContextId: params.currentJudgmentContextId,
      generation,
      groups,
    }),
  )
  return getComparisonProjectStatsFromAggregates({
    aggregateRows,
    columns: params.columns,
    groups,
    isSummaryMode: params.isSummaryMode,
  })
}

export const getComparisonProjectAdditionalStats = async (
  params: ComparisonProjectStatsParams,
): Promise<ComparisonProjectAdditionalStats> => {
  const resolvedTruthGroups = getComparisonProjectAdditionalStatsGroups(params)
  const conflictResolutionAnswerGroups = getComparisonProjectConflictResolutionAnswerStatsGroups(params)
  const resolvedTruthColumnIds = getComparisonProjectStatsResolvedTruthColumnIds(resolvedTruthGroups)
  const conflictResolutionAnswerColumnIds = getComparisonProjectStatsAggregateColumnIds(conflictResolutionAnswerGroups)

  if (resolvedTruthColumnIds.length === 0 && conflictResolutionAnswerColumnIds.length === 0) {
    return emptyComparisonProjectAdditionalStats
  }

  const generation = await getComparisonProjectStatsActiveGeneration(params)

  if (generation === null) {
    return emptyComparisonProjectAdditionalStats
  }

  const resolvedTruthAggregateRows =
    resolvedTruthColumnIds.length === 0
      ? []
      : await params.queryRunner.queryJson<ComparisonProjectStatsResolvedTruthAggregateRow>(
          getComparisonProjectStatsResolvedTruthAggregatesSql({
            columnIds: resolvedTruthColumnIds,
            comparisonProjectId: params.comparisonProjectId,
            conflictResolutionProvenance: params.conflictResolutionProvenance,
            currentJudgmentContextId: params.currentJudgmentContextId,
            generation,
            groups: resolvedTruthGroups,
          }),
        )
  const conflictResolutionAnswerAggregateRows =
    conflictResolutionAnswerColumnIds.length === 0
      ? []
      : await params.queryRunner.queryJson<ComparisonProjectStatsAggregateRow>(
          getComparisonProjectStatsAggregatesSql({
            columnIds: conflictResolutionAnswerColumnIds,
            comparisonProjectId: params.comparisonProjectId,
            conflictResolutionProvenance: params.conflictResolutionProvenance,
            currentJudgmentContextId: params.currentJudgmentContextId,
            generation,
            groups: conflictResolutionAnswerGroups,
          }),
        )
  const additionalStats = getComparisonProjectAdditionalStatsFromAggregates({
    aggregateRows: resolvedTruthAggregateRows,
    groups: resolvedTruthGroups,
  })

  return {
    ...additionalStats,
    conflictResolutionAnswerComparisons: getComparisonProjectConflictResolutionAnswerStatsFromAggregates({
      aggregateRows: conflictResolutionAnswerAggregateRows,
      groups: conflictResolutionAnswerGroups,
    }),
  }
}

export const getComparisonProjectStatsWithCategoryBreakdowns = async (
  params: ComparisonProjectStatsParams,
): Promise<{
  additionalProjectStats: ComparisonProjectAdditionalStats
  categoryBreakdowns: ComparisonProjectStatsCategoryBreakdown[]
  comparisons: ComparisonProjectStatsComparison[]
}> => {
  const groups = getComparisonProjectStatsComparisonGroups(params)
  const resolvedTruthGroups = getComparisonProjectAdditionalStatsGroups(params)
  const conflictResolutionAnswerGroups = getComparisonProjectConflictResolutionAnswerStatsGroups(params)
  const columnIds = getComparisonProjectStatsColumnIds(groups)
  const resolvedTruthColumnIds = getComparisonProjectStatsResolvedTruthColumnIds(resolvedTruthGroups)
  const conflictResolutionAnswerColumnIds = getComparisonProjectStatsAggregateColumnIds(conflictResolutionAnswerGroups)
  const generation = await getComparisonProjectStatsActiveGeneration(params)

  if (generation === null) {
    return {additionalProjectStats: emptyComparisonProjectAdditionalStats, categoryBreakdowns: [], comparisons: []}
  }

  const articleCategoryCountRows = await params.queryRunner.queryJson<ComparisonProjectStatsArticleCategoryCountRow>(
    getComparisonProjectStatsArticleCategoryCountsSql({comparisonProjectId: params.comparisonProjectId, generation}),
  )
  const aggregateRows =
    columnIds.length === 0
      ? []
      : await params.queryRunner.queryJson<ComparisonProjectStatsAggregateRow>(
          getComparisonProjectStatsAggregatesSql({
            columnIds,
            comparisonProjectId: params.comparisonProjectId,
            conflictResolutionProvenance: params.conflictResolutionProvenance,
            currentJudgmentContextId: params.currentJudgmentContextId,
            generation,
            groups,
          }),
        )
  const resolvedTruthAggregateRows =
    resolvedTruthColumnIds.length === 0
      ? []
      : await params.queryRunner.queryJson<ComparisonProjectStatsResolvedTruthAggregateRow>(
          getComparisonProjectStatsResolvedTruthAggregatesSql({
            columnIds: resolvedTruthColumnIds,
            comparisonProjectId: params.comparisonProjectId,
            conflictResolutionProvenance: params.conflictResolutionProvenance,
            currentJudgmentContextId: params.currentJudgmentContextId,
            generation,
            groups: resolvedTruthGroups,
          }),
        )
  const conflictResolutionAnswerAggregateRows =
    conflictResolutionAnswerColumnIds.length === 0
      ? []
      : await params.queryRunner.queryJson<ComparisonProjectStatsAggregateRow>(
          getComparisonProjectStatsAggregatesSql({
            columnIds: conflictResolutionAnswerColumnIds,
            comparisonProjectId: params.comparisonProjectId,
            conflictResolutionProvenance: params.conflictResolutionProvenance,
            currentJudgmentContextId: params.currentJudgmentContextId,
            generation,
            groups: conflictResolutionAnswerGroups,
          }),
        )
  const additionalProjectStats = getComparisonProjectAdditionalStatsFromAggregates({
    aggregateRows: resolvedTruthAggregateRows,
    groups: resolvedTruthGroups,
  })

  return {
    additionalProjectStats: {
      ...additionalProjectStats,
      conflictResolutionAnswerComparisons: getComparisonProjectConflictResolutionAnswerStatsFromAggregates({
        aggregateRows: conflictResolutionAnswerAggregateRows,
        groups: conflictResolutionAnswerGroups,
      }),
    },
    categoryBreakdowns: getComparisonProjectStatsCategoryBreakdownsFromAggregates({
      aggregateRows,
      articleCategoryCountRows,
      columns: params.columns,
      conflictResolutionAnswerAggregateRows,
      conflictResolutionAnswerGroups,
      groups,
      isSummaryMode: params.isSummaryMode,
      resolvedTruthAggregateRows,
      resolvedTruthGroups,
    }),
    comparisons: getComparisonProjectStatsFromAggregates({
      aggregateRows,
      columns: params.columns,
      groups,
      isSummaryMode: params.isSummaryMode,
    }),
  }
}

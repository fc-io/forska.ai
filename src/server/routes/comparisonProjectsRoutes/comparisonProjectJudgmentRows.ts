import {defaultComparisonProjectArticleCategoryFilter} from '../../../utils/comparisonProjectArticleCategoryFilter.ts'
import type {
  ComparisonProjectDifferenceColumn,
  ComparisonProjectDifferenceFilter,
} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectRowFilter} from '../../../utils/comparisonProjectRowFilter.ts'
import type {
  ComparisonProjectArticleCategoryFilterSelection,
  ComparisonProjectConflictResolutionFilterSelection,
  ComparisonProjectDifferenceFilterSelection,
  ComparisonProjectJudgmentHumanRow,
  ComparisonProjectJudgmentLlmRow,
  ComparisonProjectJudgmentRow,
  ComparisonProjectRowFilterSelection,
  ComparisonProjectScopedArticle,
  ComparisonProjectScopedArticleQueryRunner,
  ComparisonProjectServingArticleRow,
  ComparisonProjectServingCellRow,
  ComparisonProjectServingConflictResolutionProvenanceParams,
  ComparisonProjectServingMemberRow,
} from './comparisonProjectJudgmentRows/comparisonProjectJudgmentRowsTypes.ts'
import {getPositiveInteger} from './comparisonProjectJudgmentRows/comparisonProjectJudgmentRowsUtils.ts'
import {getComparisonProjectServingNextCursor} from './comparisonProjectJudgmentRows/comparisonProjectServingCursor.ts'
import {
  getComparisonProjectFilterSelectionList,
  getComparisonProjectServingRequiresConflictResolution,
} from './comparisonProjectJudgmentRows/comparisonProjectServingFilterSql.ts'
import {getComparisonProjectBatchRows} from './comparisonProjectJudgmentRows/getComparisonProjectBatchRows.ts'
import {getComparisonProjectRequiredColumnIds} from './comparisonProjectJudgmentRows/getComparisonProjectRequiredColumnIds.ts'
import {getComparisonProjectServingArticlesSql} from './comparisonProjectJudgmentRows/getComparisonProjectServingArticlesSql.ts'
import {getComparisonProjectServingCellsSql} from './comparisonProjectJudgmentRows/getComparisonProjectServingCellsSql.ts'
import {getComparisonProjectServingJudgmentCountSql} from './comparisonProjectJudgmentRows/getComparisonProjectServingJudgmentCountSql.ts'
import {getComparisonProjectServingJudgmentFilteredCountSql} from './comparisonProjectJudgmentRows/getComparisonProjectServingJudgmentFilteredCountSql.ts'
import {getComparisonProjectServingJudgmentRows} from './comparisonProjectJudgmentRows/getComparisonProjectServingJudgmentRows.ts'
import {getComparisonProjectServingMemberSql} from './comparisonProjectJudgmentRows/getComparisonProjectServingMemberSql.ts'
import {getComparisonProjectSearchQuery} from './comparisonProjectJudgmentSearch.ts'

export type ComparisonProjectScopedArticleBatchRequest = {limit: number; offset: number}

type ForEachComparisonProjectJudgmentRowBatchParams = {
  articleBatchSize: number
  columns: readonly ComparisonProjectDifferenceColumn[]
  differenceFilter: ComparisonProjectDifferenceFilter
  isSummaryMode: boolean
  loadHumanRows: (articleIds: string[]) => Promise<readonly ComparisonProjectJudgmentHumanRow[]>
  loadLlmRows: (articleIds: string[]) => Promise<readonly ComparisonProjectJudgmentLlmRow[]>
  loadScopedArticles: (
    request: ComparisonProjectScopedArticleBatchRequest,
  ) => Promise<readonly ComparisonProjectScopedArticle[]>
  onRows: (rows: ComparisonProjectJudgmentRow[]) => Promise<void> | void
  rowFilter: ComparisonProjectRowFilter
}

type ComparisonProjectServingJudgmentRowsParams = ComparisonProjectServingConflictResolutionProvenanceParams & {
  articleCategoryFilter?: ComparisonProjectArticleCategoryFilterSelection
  comparisonProjectId: string
  conflictResolutionFilter?: ComparisonProjectConflictResolutionFilterSelection
  cursor?: string | null
  differenceFilter: ComparisonProjectDifferenceFilterSelection
  limit: number
  queryRunner: ComparisonProjectScopedArticleQueryRunner
  rowFilter: ComparisonProjectRowFilterSelection
  searchText?: string | null
}

type ForEachComparisonProjectServingJudgmentRowBatchParams = ComparisonProjectServingJudgmentRowsParams & {
  onRows: (rows: ComparisonProjectJudgmentRow[]) => Promise<void> | void
}

type ForEachComparisonProjectServingJudgmentArticleIdBatchParams = ComparisonProjectServingJudgmentRowsParams & {
  onArticleIds: (articleIds: string[]) => Promise<void> | void
}

type ComparisonProjectServingJudgmentCountParams = ComparisonProjectServingConflictResolutionProvenanceParams & {
  articleCategoryFilter?: ComparisonProjectArticleCategoryFilterSelection
  comparisonProjectId: string
  conflictResolutionFilter?: ComparisonProjectConflictResolutionFilterSelection
  differenceFilter: ComparisonProjectDifferenceFilterSelection
  limit: number
  queryRunner: ComparisonProjectScopedArticleQueryRunner
  rowFilter: ComparisonProjectRowFilterSelection
  searchText?: string | null
}

export type ComparisonProjectServingJudgmentRowsPage = {nextCursor: string | null; rows: ComparisonProjectJudgmentRow[]}
export type ComparisonProjectServingJudgmentCount = {totalCount: number; totalPages: number}

const getComparisonProjectServingGeneration = (value: unknown) => {
  const parsedGeneration = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedGeneration) && parsedGeneration > 0 ? parsedGeneration : null
}

const getComparisonProjectServingCount = (value: unknown) => {
  const parsedCount = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedCount) && parsedCount >= 0 ? parsedCount : 0
}

export const getComparisonProjectServingJudgmentCount = async (
  params: ComparisonProjectServingJudgmentCountParams,
): Promise<ComparisonProjectServingJudgmentCount> => {
  const limit = getPositiveInteger(params.limit)
  const conflictResolutionFilter = params.conflictResolutionFilter ?? []
  const rowFilters = getComparisonProjectFilterSelectionList(params.rowFilter)
  const differenceFilters = getComparisonProjectFilterSelectionList(params.differenceFilter)
  const articleCategoryFilters = getComparisonProjectFilterSelectionList(params.articleCategoryFilter)
  const canUsePrecomputedStats =
    rowFilters.length <= 1
    && differenceFilters.length <= 1
    && articleCategoryFilters.length <= 1
    && getComparisonProjectSearchQuery(params.searchText) === null
    && !getComparisonProjectServingRequiresConflictResolution(
      conflictResolutionFilter,
      params.differenceFilter,
      params.conflictResolutionProvenanceFilter,
    )
  const [row] = await params.queryRunner.queryJson<{totalCount: unknown}>(
    canUsePrecomputedStats
      ? getComparisonProjectServingJudgmentCountSql({
          articleCategoryFilter: articleCategoryFilters[0] ?? defaultComparisonProjectArticleCategoryFilter,
          comparisonProjectId: params.comparisonProjectId,
          differenceFilter: differenceFilters[0] ?? 'all',
          rowFilter: rowFilters[0] ?? 'all',
        })
      : getComparisonProjectServingJudgmentFilteredCountSql({...params, conflictResolutionFilter}),
  )
  const totalCount = getComparisonProjectServingCount(row?.totalCount)

  return {totalCount, totalPages: totalCount > 0 ? Math.ceil(totalCount / limit) : 0}
}

export const getComparisonProjectServingJudgmentRowsPage = async (
  params: ComparisonProjectServingJudgmentRowsParams,
): Promise<ComparisonProjectServingJudgmentRowsPage> => {
  const limit = getPositiveInteger(params.limit)
  const memberRows = await params.queryRunner.queryJson<ComparisonProjectServingMemberRow>(
    getComparisonProjectServingMemberSql({...params, limit}),
  )
  const hasMore = memberRows.length > limit
  const pageMemberRows = memberRows.slice(0, limit)
  const generation = getComparisonProjectServingGeneration(pageMemberRows[0]?.generation)
  const lastPageMemberRow = pageMemberRows[pageMemberRows.length - 1]
  const nextCursor = getComparisonProjectServingNextCursor(lastPageMemberRow)
  const articleIds = pageMemberRows.map((row) => {
    return row.articleId
  })

  if (articleIds.length === 0 || generation === null) {
    return {nextCursor: null, rows: []}
  }

  const [articleRows, cellRows] = await Promise.all([
    params.queryRunner.queryJson<ComparisonProjectServingArticleRow>(
      getComparisonProjectServingArticlesSql({articleIds, comparisonProjectId: params.comparisonProjectId, generation}),
    ),
    params.queryRunner.queryJson<ComparisonProjectServingCellRow>(
      getComparisonProjectServingCellsSql({articleIds, comparisonProjectId: params.comparisonProjectId, generation}),
    ),
  ])

  return {
    nextCursor: hasMore ? nextCursor : null,
    rows: getComparisonProjectServingJudgmentRows({articleRows, cellRows, memberRows: pageMemberRows}),
  }
}

export const forEachComparisonProjectServingJudgmentRowBatch = async (
  params: ForEachComparisonProjectServingJudgmentRowBatchParams,
  cursor: string | null = null,
): Promise<void> => {
  const pageResult = await getComparisonProjectServingJudgmentRowsPage({...params, cursor})
  const rowsResult = pageResult.rows.length > 0 ? params.onRows(pageResult.rows) : undefined

  await rowsResult

  return pageResult.nextCursor
    ? forEachComparisonProjectServingJudgmentRowBatch(params, pageResult.nextCursor)
    : undefined
}

export const forEachComparisonProjectServingJudgmentArticleIdBatch = async (
  params: ForEachComparisonProjectServingJudgmentArticleIdBatchParams,
  cursor: string | null = null,
): Promise<void> => {
  const limit = getPositiveInteger(params.limit)
  const memberRows = await params.queryRunner.queryJson<ComparisonProjectServingMemberRow>(
    getComparisonProjectServingMemberSql({...params, cursor, limit}),
  )
  const pageMemberRows = memberRows.slice(0, limit)
  const articleIds = pageMemberRows.map((row) => {
    return row.articleId
  })
  const lastPageMemberRow = pageMemberRows[pageMemberRows.length - 1]
  const nextCursor = getComparisonProjectServingNextCursor(lastPageMemberRow)
  const articleIdResult = articleIds.length > 0 ? params.onArticleIds(articleIds) : undefined

  await articleIdResult

  return memberRows.length > limit && nextCursor
    ? forEachComparisonProjectServingJudgmentArticleIdBatch(params, nextCursor)
    : undefined
}

export const forEachComparisonProjectJudgmentRowBatch = async (
  params: ForEachComparisonProjectJudgmentRowBatchParams,
  offset = 0,
): Promise<void> => {
  const limit = getPositiveInteger(params.articleBatchSize)
  const articles = await params.loadScopedArticles({limit, offset})

  if (articles.length === 0) {
    return
  }

  const articleIds = articles.map((article) => {
    return article.id
  })
  const [llmRows, humanRows] = await Promise.all([params.loadLlmRows(articleIds), params.loadHumanRows(articleIds)])
  const rows = getComparisonProjectBatchRows({
    articles,
    columns: params.columns,
    differenceFilter: params.differenceFilter,
    humanRows,
    isSummaryMode: params.isSummaryMode,
    llmRows,
    requiredHumanColumnIds: getComparisonProjectRequiredColumnIds(params.columns, 'human'),
    requiredLlmColumnIds: getComparisonProjectRequiredColumnIds(params.columns, 'llm'),
    rowFilter: params.rowFilter,
  })

  await params.onRows(rows)

  if (articles.length < limit) {
    return
  }

  return forEachComparisonProjectJudgmentRowBatch(params, offset + limit)
}

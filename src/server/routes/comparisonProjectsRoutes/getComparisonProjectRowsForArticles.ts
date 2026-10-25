import {getComparisonProjectBatchRows} from './comparisonProjectJudgmentRows/getComparisonProjectBatchRows.ts'
import {getComparisonProjectRequiredColumnIds} from './comparisonProjectJudgmentRows/getComparisonProjectRequiredColumnIds.ts'
import {getComparisonProjectScopedArticleBatch} from './comparisonProjectJudgmentRows/getComparisonProjectScopedArticleBatch.ts'
import {articleTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getInClause, getWhereClause} from './comparisonProjectSqlClauses.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getArticleScopeConditions} from './getArticleScopeConditions.ts'
import {getComparisonProjectLlmRows} from './getComparisonProjectLlmRows.ts'
import {getComparisonProjectHumanRows} from './getComparisonProjectRowsForArticles/getComparisonProjectHumanRows.ts'
import {getComparisonProjectLlmSummaryRows} from './getComparisonProjectRowsForArticles/getComparisonProjectLlmSummaryRows.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

export const getComparisonProjectRowsForArticles = async (
  scope: ComparisonProjectScope,
  articleIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  const uniqueArticleIds = getUniqueStringValues(articleIds)

  if (uniqueArticleIds.length === 0) {
    return []
  }

  const articleScopeConditions = getArticleScopeConditions(
    scope.importRouteIds,
    scope.sourceProjectIds,
    scope.useImportRoutesForScope,
  )
  const articleScopeWhereClause = getWhereClause([
    ...articleScopeConditions,
    `a.id IN (${getInClause(uniqueArticleIds)})`,
  ])
  const articles = await getComparisonProjectScopedArticleBatch({
    articleTable,
    limit: uniqueArticleIds.length,
    offset: 0,
    queryRunner,
    whereClause: articleScopeWhereClause,
  })
  const [rawLlmRows, humanRows] = await Promise.all([
    getComparisonProjectLlmRows(scope, uniqueArticleIds, queryRunner),
    getComparisonProjectHumanRows(scope, uniqueArticleIds, queryRunner),
  ])

  return getComparisonProjectBatchRows({
    articles,
    columns: scope.columns,
    differenceFilter: 'all',
    humanRows,
    isSummaryMode: getIsSummaryMode(scope),
    llmRows: getComparisonProjectLlmSummaryRows(scope, rawLlmRows),
    requiredHumanColumnIds: getComparisonProjectRequiredColumnIds(scope.columns, 'human'),
    requiredLlmColumnIds: getComparisonProjectRequiredColumnIds(scope.columns, 'llm'),
    rowFilter: 'all',
  })
}

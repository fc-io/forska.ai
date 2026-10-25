import {getComparisonProjectConflictResolutionImportIdentifierKeys} from '../comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportIdentifierKeys.ts'
import {
  getComparisonProjectConflictResolutionImportIdTitleKey,
  getComparisonProjectConflictResolutionImportTitleKey,
} from '../comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTitleKeys.ts'
import type {ComparisonProjectConflictResolutionImportSourceRow} from '../comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'
import {getComparisonProjectConflictResolutionImportArticleIdTargetArticlesSql} from '../comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportArticleIdTargetArticlesSql.ts'
import {getComparisonProjectConflictResolutionImportIdentifierTargetArticlesSql} from '../comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportIdentifierTargetArticlesSql.ts'
import {getComparisonProjectConflictResolutionImportIdTitleTargetArticlesSql} from '../comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportIdTitleTargetArticlesSql.ts'
import {getComparisonProjectConflictResolutionImportServingArticleIdTargetArticlesSql} from '../comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportServingArticleIdTargetArticlesSql.ts'
import {getComparisonProjectConflictResolutionImportServingIdentifierTargetArticlesSql} from '../comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportServingIdentifierTargetArticlesSql.ts'
import {getComparisonProjectConflictResolutionImportServingIdTitleTargetArticlesSql} from '../comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportServingIdTitleTargetArticlesSql.ts'
import {getComparisonProjectConflictResolutionImportServingTitleTargetArticlesSql} from '../comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportServingTitleTargetArticlesSql.ts'
import {getComparisonProjectConflictResolutionImportTitleTargetArticlesSql} from '../comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportTitleTargetArticlesSql.ts'
import {
  type ComparisonProjectConflictResolutionImportTargetArticleQueryRow,
  mergeComparisonProjectConflictResolutionImportTargetArticleRows,
} from '../comparisonProjectConflictResolutionImport/mergeComparisonProjectConflictResolutionImportTargetArticleRows.ts'
import {articleIdentifierTable, articleImportRouteTable, articleTable} from '../comparisonProjectRouteConstants.ts'
import type {AppQueryRunner} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {getUniqueStringValues} from '../comparisonProjectValueHelpers.ts'
import {getArticleScopeConditions} from '../getArticleScopeConditions.ts'

const getConflictResolutionImportIdentifierKeys = (
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[],
) => {
  return getUniqueStringValues(
    sourceRows
      .flatMap((row) => {
        return getComparisonProjectConflictResolutionImportIdentifierKeys(row)
      })
      .filter(Boolean),
  )
}

const getConflictResolutionImportIdTitleKeys = (
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[],
) => {
  return getUniqueStringValues(
    sourceRows
      .map((row) => {
        return getComparisonProjectConflictResolutionImportIdTitleKey(row) ?? ''
      })
      .filter(Boolean),
  )
}

const getConflictResolutionImportTitleKeys = (
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[],
) => {
  return getUniqueStringValues(
    sourceRows
      .map((row) => {
        return getComparisonProjectConflictResolutionImportTitleKey(row) ?? ''
      })
      .filter(Boolean),
  )
}

const getConflictResolutionImportSourceArticleIds = (
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[],
) => {
  return getUniqueStringValues(
    sourceRows
      .map((row) => {
        return row.sourceArticleId
      })
      .filter(Boolean),
  )
}

const getConflictResolutionImportUnmatchedSourceRows = (params: {
  articleIdTargetRows: readonly ComparisonProjectConflictResolutionImportTargetArticleQueryRow[]
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
}) => {
  const matchedArticleIds = new Set(
    params.articleIdTargetRows.map((row) => {
      return row.articleId
    }),
  )

  return params.sourceRows.filter((row) => {
    return !matchedArticleIds.has(row.sourceArticleId)
  })
}

const getConflictResolutionImportServingCandidateTargetRows = async (params: {
  generation: number
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  scope: ComparisonProjectScope
  tx: AppQueryRunner
}) => {
  const sourceArticleIds = getConflictResolutionImportSourceArticleIds(params.sourceRows)
  const articleIdTargetRows =
    sourceArticleIds.length > 0
      ? await params.tx.queryJson<ComparisonProjectConflictResolutionImportTargetArticleQueryRow>(
          getComparisonProjectConflictResolutionImportServingArticleIdTargetArticlesSql({
            articleIds: sourceArticleIds,
            comparisonProjectId: params.scope.id,
            generation: params.generation,
          }),
        )
      : []
  const unmatchedSourceRows = getConflictResolutionImportUnmatchedSourceRows({
    articleIdTargetRows,
    sourceRows: params.sourceRows,
  })
  const identifierKeys = getConflictResolutionImportIdentifierKeys(unmatchedSourceRows)
  const idTitleKeys = getConflictResolutionImportIdTitleKeys(unmatchedSourceRows)
  const titleKeys = getConflictResolutionImportTitleKeys(unmatchedSourceRows)
  const identifierTargetRows =
    identifierKeys.length > 0
      ? await params.tx.queryJson<ComparisonProjectConflictResolutionImportTargetArticleQueryRow>(
          getComparisonProjectConflictResolutionImportServingIdentifierTargetArticlesSql({
            comparisonProjectId: params.scope.id,
            generation: params.generation,
            identifierKeys,
          }),
        )
      : []
  const idTitleTargetRows =
    idTitleKeys.length > 0
      ? await params.tx.queryJson<ComparisonProjectConflictResolutionImportTargetArticleQueryRow>(
          getComparisonProjectConflictResolutionImportServingIdTitleTargetArticlesSql({
            comparisonProjectId: params.scope.id,
            generation: params.generation,
            idTitleKeys,
          }),
        )
      : []
  const titleTargetRows =
    titleKeys.length > 0
      ? await params.tx.queryJson<ComparisonProjectConflictResolutionImportTargetArticleQueryRow>(
          getComparisonProjectConflictResolutionImportServingTitleTargetArticlesSql({
            comparisonProjectId: params.scope.id,
            generation: params.generation,
            titleKeys,
          }),
        )
      : []

  return mergeComparisonProjectConflictResolutionImportTargetArticleRows([
    ...articleIdTargetRows,
    ...identifierTargetRows,
    ...idTitleTargetRows,
    ...titleTargetRows,
  ])
}

export const getConflictResolutionImportCandidateTargetRows = async (params: {
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  scope: ComparisonProjectScope
  tx: AppQueryRunner
}) => {
  if (params.scope.activeGeneration !== null) {
    return getConflictResolutionImportServingCandidateTargetRows({
      generation: params.scope.activeGeneration,
      sourceRows: params.sourceRows,
      scope: params.scope,
      tx: params.tx,
    })
  }

  const articleScopeConditions = getArticleScopeConditions(
    params.scope.importRouteIds,
    params.scope.sourceProjectIds,
    params.scope.useImportRoutesForScope,
  )
  const sourceArticleIds = getConflictResolutionImportSourceArticleIds(params.sourceRows)
  const articleIdTargetRows =
    sourceArticleIds.length > 0
      ? await params.tx.queryJson<ComparisonProjectConflictResolutionImportTargetArticleQueryRow>(
          getComparisonProjectConflictResolutionImportArticleIdTargetArticlesSql({
            articleIds: sourceArticleIds,
            articleIdentifierTable,
            articleImportRouteTable,
            articleScopeConditions,
            articleTable,
            externalArticleImportRouteIds: params.scope.importRouteIds,
          }),
        )
      : []
  const unmatchedSourceRows = getConflictResolutionImportUnmatchedSourceRows({
    articleIdTargetRows,
    sourceRows: params.sourceRows,
  })
  const identifierKeys = getConflictResolutionImportIdentifierKeys(unmatchedSourceRows)
  const idTitleKeys = getConflictResolutionImportIdTitleKeys(unmatchedSourceRows)
  const titleKeys = getConflictResolutionImportTitleKeys(unmatchedSourceRows)
  const identifierTargetRows =
    identifierKeys.length > 0
      ? await params.tx.queryJson<ComparisonProjectConflictResolutionImportTargetArticleQueryRow>(
          getComparisonProjectConflictResolutionImportIdentifierTargetArticlesSql({
            articleIdentifierTable,
            articleImportRouteTable,
            articleScopeConditions,
            articleTable,
            externalArticleImportRouteIds: params.scope.importRouteIds,
            identifierKeys,
          }),
        )
      : []
  const idTitleTargetRows =
    idTitleKeys.length > 0
      ? await params.tx.queryJson<ComparisonProjectConflictResolutionImportTargetArticleQueryRow>(
          getComparisonProjectConflictResolutionImportIdTitleTargetArticlesSql({
            articleIdentifierTable,
            articleImportRouteTable,
            articleScopeConditions,
            articleTable,
            externalArticleImportRouteIds: params.scope.importRouteIds,
            idTitleKeys,
          }),
        )
      : []
  const titleTargetRows =
    titleKeys.length > 0
      ? await params.tx.queryJson<ComparisonProjectConflictResolutionImportTargetArticleQueryRow>(
          getComparisonProjectConflictResolutionImportTitleTargetArticlesSql({
            articleIdentifierTable,
            articleImportRouteTable,
            articleScopeConditions,
            articleTable,
            externalArticleImportRouteIds: params.scope.importRouteIds,
            titleKeys,
          }),
        )
      : []

  return mergeComparisonProjectConflictResolutionImportTargetArticleRows([
    ...articleIdTargetRows,
    ...identifierTargetRows,
    ...idTitleTargetRows,
    ...titleTargetRows,
  ])
}

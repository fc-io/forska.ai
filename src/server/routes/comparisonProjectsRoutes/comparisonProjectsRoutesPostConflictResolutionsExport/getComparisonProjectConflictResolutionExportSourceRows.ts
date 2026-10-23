import {getNormalizedComparisonProjectDifferenceFilters} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {HttpError} from '../../../utils/httpError.ts'
import {comparisonProjectConflictCommentTable} from '../comparisonProjectConflictComment.ts'
import type {ComparisonProjectConflictResolutionTransferSourceRow} from '../comparisonProjectConflictResolutionFileTransfer.ts'
import {getComparisonProjectConflictResolutionOptionByValue} from '../comparisonProjectConflictResolutionOptions.ts'
import {
  type ComparisonProjectJudgmentFilters,
  getComparisonProjectDifferenceFilterAvailability,
} from '../comparisonProjectJudgmentFilters.ts'
import {forEachComparisonProjectServingJudgmentArticleIdBatch} from '../comparisonProjectJudgmentRows.ts'
import {
  comparisonProjectConflictResolutionTable,
  comparisonProjectJudgmentArticleBatchSize,
} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {ComparisonProjectConflictResolutionOption} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {getInClause} from '../comparisonProjectSqlClauses.ts'
import {getIsSummaryMode} from '../getIsSummaryMode.ts'

type ComparisonProjectConflictResolutionExportQueryRow = Omit<
  ComparisonProjectConflictResolutionTransferSourceRow,
  'resolutionLabel' | 'resolutionMode' | 'resolutionValue'
> & {answerValue: string | null; promptId: string | null}

const getComparisonProjectConflictResolutionExportResolutionValue = (
  scope: ComparisonProjectScope,
  row: ComparisonProjectConflictResolutionExportQueryRow,
) => {
  return getIsSummaryMode(scope) ? row.answerValue : row.promptId
}

const getComparisonProjectConflictResolutionExportSourceRow = (
  scope: ComparisonProjectScope,
  optionByValue: Map<string, ComparisonProjectConflictResolutionOption>,
  row: ComparisonProjectConflictResolutionExportQueryRow,
): ComparisonProjectConflictResolutionTransferSourceRow => {
  const resolutionValue =
    row.sourceResolutionId === null
      ? null
      : (getComparisonProjectConflictResolutionExportResolutionValue(scope, row) ?? '')
  const option = resolutionValue === null ? undefined : optionByValue.get(resolutionValue)

  return {
    ...row,
    resolutionLabel: option?.label ?? resolutionValue,
    resolutionMode: getIsSummaryMode(scope) ? 'summary' : 'prompt',
    resolutionValue,
  }
}

export const getComparisonProjectConflictResolutionExportSourceRows = async (
  scope: ComparisonProjectScope,
  filters: ComparisonProjectJudgmentFilters,
): Promise<ComparisonProjectConflictResolutionTransferSourceRow[]> => {
  if (scope.activeGeneration === null) {
    throw new HttpError(409, 'Conflict resolution export requires an active comparison serving generation')
  }

  const optionByValue = getComparisonProjectConflictResolutionOptionByValue(scope)
  const comparisonProjectLiteral = getSqlLiteral(scope.id)
  const activeGenerationLiteral = getSqlLiteral(scope.activeGeneration)
  const normalizedDifferenceFilters = getNormalizedComparisonProjectDifferenceFilters(
    filters.differenceFilters,
    scope.columns,
    getComparisonProjectDifferenceFilterAvailability(scope),
  )
  const sourceRows: ComparisonProjectConflictResolutionTransferSourceRow[] = []
  const appendSourceRowsForArticleIds = async (articleIds: string[]) => {
    if (articleIds.length === 0) {
      return
    }

    const rows = await appDatabaseService.queryJson<ComparisonProjectConflictResolutionExportQueryRow>(`
    WITH batch_resolution AS (
      SELECT *
      FROM ${comparisonProjectConflictResolutionTable} cr
      WHERE cr.comparison_project_id = ${comparisonProjectLiteral}
        AND cr.article_id IN (${getInClause(articleIds)})
    ),
    batch_comment AS (
      SELECT id, article_id, comment, created_at
      FROM ${comparisonProjectConflictCommentTable}
      WHERE comparison_project_id = ${comparisonProjectLiteral}
        AND article_id IN (${getInClause(articleIds)})
      QUALIFY ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY updated_at DESC, id DESC) = 1
    ),
    batch_row AS (
      SELECT
        batch_resolution.id AS resolution_id,
        batch_comment.id AS comment_id,
        COALESCE(batch_resolution.article_id, batch_comment.article_id) AS article_id,
        batch_resolution.prompt_id,
        batch_resolution.answer_value,
        batch_resolution.reviewer_user_id,
        batch_resolution.reviewer_display_name,
        batch_resolution.judgment_context_id,
        batch_resolution.updated_at,
        batch_resolution.origin,
        COALESCE(batch_resolution.created_at, batch_comment.created_at) AS sort_created_at,
        batch_comment.comment
      FROM batch_resolution
      FULL OUTER JOIN batch_comment ON batch_comment.article_id = batch_resolution.article_id
    )
    SELECT
      br.resolution_id AS sourceResolutionId,
      br.article_id AS sourceArticleRowId,
      a.article_external_id AS externalArticleId,
      a.article_title AS title,
      a.doi AS doi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      a.biorxiv_id AS biorxivId,
      a.medrxiv_id AS medrxivId,
      a.url AS url,
      ai.source_identifier_id AS sourceIdentifierId,
      ai.kind AS identifierKind,
      ai.normalized_value AS identifierNormalizedValue,
      ai.source AS identifierSource,
      ai.is_primary AS identifierIsPrimary,
      br.prompt_id AS promptId,
      br.answer_value AS answerValue,
      COALESCE(NULLIF(TRIM(br.reviewer_display_name), ''), NULLIF(TRIM(reviewer.name), '')) AS provenanceReviewerDisplayName,
      br.judgment_context_id AS provenanceContextId,
      br.updated_at AS provenanceSetAt,
      br.origin AS provenanceOrigin,
      br.comment AS comment
    FROM batch_row br
    LEFT JOIN app.user_config reviewer ON reviewer.id = br.reviewer_user_id
    INNER JOIN mart.comparison_article_serving a
      ON a.comparison_project_id = ${comparisonProjectLiteral}
     AND a.generation = ${activeGenerationLiteral}
     AND a.article_id = br.article_id
    LEFT JOIN mart.comparison_article_identifier_serving ai
      ON ai.comparison_project_id = a.comparison_project_id
     AND ai.generation = a.generation
     AND ai.article_id = a.article_id
    ORDER BY
      br.sort_created_at ASC,
      COALESCE(br.resolution_id, br.comment_id) ASC,
      ai.is_primary DESC,
      ai.kind ASC,
      ai.normalized_value ASC,
      ai.source_identifier_id ASC
  `)

    sourceRows.push(
      ...rows.map((row) => {
        return getComparisonProjectConflictResolutionExportSourceRow(scope, optionByValue, row)
      }),
    )
  }

  await forEachComparisonProjectServingJudgmentArticleIdBatch({
    comparisonProjectId: scope.id,
    articleCategoryFilter: filters.articleCategoryFilters,
    conflictResolutionFilter: filters.conflictResolutionFilters,
    conflictResolutionProvenanceFilter: filters.conflictResolutionProvenanceFilters,
    currentJudgmentContextId: scope.judgmentContextId,
    differenceFilter: normalizedDifferenceFilters,
    limit: comparisonProjectJudgmentArticleBatchSize,
    onArticleIds: appendSourceRowsForArticleIds,
    queryRunner: appDatabaseService,
    rowFilter: filters.rowFilters,
    searchText: filters.searchText,
  })

  return sourceRows
}

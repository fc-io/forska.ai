import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {identifierKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'
import {getInClause} from './comparisonProjectConflictResolutionImportSql.ts'

const getSourceComparisonProjectWhereSql = (alias: string, sourceComparisonProjectIds: string[]) => {
  return sourceComparisonProjectIds.length > 0
    ? `WHERE ${alias}.comparison_project_id IN (${getInClause(sourceComparisonProjectIds)})`
    : 'WHERE FALSE'
}

type ComparisonProjectConflictResolutionImportSourceExternalArticleSqlParams = {
  articleImportRouteTable: string
  comparisonProjectImportRouteTable: string
  comparisonProjectSourceProjectTable: string
  projectImportRouteTable: string
  sourceComparisonProjectIds: string[]
}

const getComparisonProjectConflictResolutionImportSourceExternalArticleCtesSql = (
  params: ComparisonProjectConflictResolutionImportSourceExternalArticleSqlParams,
) => {
  return `
    source_route AS (
      SELECT
        cpir.comparison_project_id AS sourceComparisonProjectId,
        cpir.import_route_id AS importRouteId,
        0 AS routeOrder
      FROM ${params.comparisonProjectImportRouteTable} cpir
      ${getSourceComparisonProjectWhereSql('cpir', params.sourceComparisonProjectIds)}
      UNION ALL
      SELECT
        cpsp.comparison_project_id AS sourceComparisonProjectId,
        pir.import_route_id AS importRouteId,
        1 AS routeOrder
      FROM ${params.comparisonProjectSourceProjectTable} cpsp
      INNER JOIN ${params.projectImportRouteTable} pir ON pir.project_id = cpsp.source_project_id
      ${getSourceComparisonProjectWhereSql('cpsp', params.sourceComparisonProjectIds)}
    ),
    source_external_article AS (
      SELECT
        source_row.sourceComparisonProjectId AS sourceComparisonProjectId,
        source_row.sourceArticleId AS sourceArticleId,
        air.external_article_id AS externalArticleId
      FROM source_row
      INNER JOIN source_route ON source_route.sourceComparisonProjectId = source_row.sourceComparisonProjectId
      INNER JOIN ${params.articleImportRouteTable} air
        ON air.import_route_id = source_route.importRouteId
       AND air.article_id = source_row.sourceArticleId
      WHERE NULLIF(TRIM(COALESCE(air.external_article_id, '')), '') IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY source_row.sourceComparisonProjectId, source_row.sourceArticleId
        ORDER BY source_route.routeOrder ASC, air.external_article_id ASC
      ) = 1
    ),`
}

export const getComparisonProjectConflictResolutionImportSourceRowsSql = (
  params: {
    articleIdentifierTable: string
    articleTable: string
    comparisonProjectConflictCommentTable: string
    comparisonProjectTable: string
    comparisonProjectConflictResolutionTable: string
  } & ComparisonProjectConflictResolutionImportSourceExternalArticleSqlParams,
) => {
  const sourceExternalArticleIdSql = 'COALESCE(source_external_article.externalArticleId, source_article.article_id)'

  return `
    WITH source_resolution AS (
      SELECT
        cr.comparison_project_id AS sourceComparisonProjectId,
        cr.id AS sourceResolutionId,
        cr.id AS sourceRowId,
        cr.article_id AS sourceArticleId,
        COALESCE(cr.answer_value, cr.prompt_id, '') AS resolutionValue,
        cr.reviewer_user_id AS sourceReviewerUserId,
        COALESCE(NULLIF(TRIM(cr.reviewer_display_name), ''), NULLIF(TRIM(source_reviewer.name), '')) AS sourceReviewerDisplayName,
        cr.judgment_context_id AS sourceJudgmentContextId
      FROM ${params.comparisonProjectConflictResolutionTable} cr
      LEFT JOIN app.user_config source_reviewer ON source_reviewer.id = cr.reviewer_user_id
      ${getSourceComparisonProjectWhereSql('cr', params.sourceComparisonProjectIds)}
    ),
    source_comment AS (
      SELECT
        cc.comparison_project_id AS sourceComparisonProjectId,
        cc.id AS sourceCommentId,
        cc.article_id AS sourceArticleId,
        cc.comment AS sourceComment,
        cc.author_user_id AS sourceCommentAuthorUserId,
        COALESCE(NULLIF(TRIM(cc.author_display_name), ''), NULLIF(TRIM(source_comment_author.name), '')) AS sourceCommentAuthorDisplayName
      FROM ${params.comparisonProjectConflictCommentTable} cc
      LEFT JOIN app.user_config source_comment_author ON source_comment_author.id = cc.author_user_id
      ${getSourceComparisonProjectWhereSql('cc', params.sourceComparisonProjectIds)}
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY cc.comparison_project_id, cc.article_id
        ORDER BY cc.updated_at DESC, cc.id DESC
      ) = 1
    ),
    source_row AS (
      SELECT
        COALESCE(source_resolution.sourceComparisonProjectId, source_comment.sourceComparisonProjectId) AS sourceComparisonProjectId,
        COALESCE(source_resolution.sourceResolutionId, source_comment.sourceCommentId) AS sourceResolutionId,
        COALESCE(source_resolution.sourceRowId, source_comment.sourceCommentId) AS sourceRowId,
        COALESCE(source_resolution.sourceArticleId, source_comment.sourceArticleId) AS sourceArticleId,
        source_resolution.resolutionValue AS resolutionValue,
        source_resolution.sourceReviewerUserId AS sourceReviewerUserId,
        source_resolution.sourceReviewerDisplayName AS sourceReviewerDisplayName,
        source_resolution.sourceJudgmentContextId AS sourceJudgmentContextId,
        source_comment.sourceComment AS sourceComment,
        source_comment.sourceCommentAuthorUserId AS sourceCommentAuthorUserId,
        source_comment.sourceCommentAuthorDisplayName AS sourceCommentAuthorDisplayName
      FROM source_resolution
      FULL OUTER JOIN source_comment
        ON source_comment.sourceComparisonProjectId = source_resolution.sourceComparisonProjectId
       AND source_comment.sourceArticleId = source_resolution.sourceArticleId
    ),
    ${getComparisonProjectConflictResolutionImportSourceExternalArticleCtesSql(params)}
    doi_identifier AS (
      SELECT
        article_id AS articleId,
        LIST(DISTINCT normalized_value ORDER BY normalized_value) AS doiKeys
      FROM ${params.articleIdentifierTable}
      WHERE kind = 'doi'
      GROUP BY article_id
    ),
    strong_identifier AS (
      SELECT
        article_id AS articleId,
        LIST(DISTINCT kind || ${getSqlLiteral(identifierKeySeparator)} || normalized_value ORDER BY kind || ${getSqlLiteral(identifierKeySeparator)} || normalized_value) AS identifierKeys
      FROM ${params.articleIdentifierTable}
      WHERE kind IN ('doi', 'pmid', 'arxiv')
      GROUP BY article_id
    )
    SELECT
      source_row.sourceComparisonProjectId AS sourceComparisonProjectId,
      source_comparison_project.name AS sourceComparisonProjectName,
      source_row.sourceResolutionId AS sourceResolutionId,
      source_row.sourceRowId AS sourceRowId,
      source_row.sourceArticleId AS sourceArticleId,
      ${sourceExternalArticleIdSql} AS sourceExternalArticleId,
      source_article.article_title AS sourceArticleTitle,
      source_row.resolutionValue AS resolutionValue,
      source_row.sourceReviewerUserId AS sourceReviewerUserId,
      source_row.sourceReviewerDisplayName AS sourceReviewerDisplayName,
      source_row.sourceJudgmentContextId AS sourceJudgmentContextId,
      source_row.sourceComment AS sourceComment,
      source_row.sourceCommentAuthorUserId AS sourceCommentAuthorUserId,
      source_row.sourceCommentAuthorDisplayName AS sourceCommentAuthorDisplayName,
      'summary' AS resolutionMode,
      doi_identifier.doiKeys AS doiKeys,
      strong_identifier.identifierKeys AS identifierKeys,
      source_article.doi AS doi,
      source_article.pubmed_id AS pubmedId,
      source_article.arxiv_id AS arxivId,
      ${sourceExternalArticleIdSql} AS externalArticleId,
      source_article.article_title AS title
    FROM source_row
    INNER JOIN ${params.comparisonProjectTable} source_comparison_project
      ON source_comparison_project.id = source_row.sourceComparisonProjectId
    INNER JOIN ${params.articleTable} source_article ON source_article.id = source_row.sourceArticleId
    LEFT JOIN source_external_article
      ON source_external_article.sourceComparisonProjectId = source_row.sourceComparisonProjectId
     AND source_external_article.sourceArticleId = source_row.sourceArticleId
    LEFT JOIN doi_identifier ON doi_identifier.articleId = source_article.id
    LEFT JOIN strong_identifier ON strong_identifier.articleId = source_article.id
    ORDER BY source_row.sourceRowId ASC
  `
}

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingProjectScopeProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingProjectScopeInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  projectId: string
  projectionIdentity: string
  status?: ReviewServingProjectionManifestStatus
}

type ProjectScopeArticleRowsInput = {getArticlePredicate: (alias: string) => string; projectId: string}

const projectScopeProjectorName = 'project-scope-projector'

export const getProjectScopeArticleRowsStatement = (input: ProjectScopeArticleRowsInput) => {
  const projectIdSql = getSqlLiteral(input.projectId)

  return `
    DELETE FROM mart.project_scope_article scope
    WHERE scope.project_id = ${projectIdSql}
      AND ${input.getArticlePredicate('scope')};
    INSERT INTO mart.project_scope_article (
      project_id,
      article_id,
      in_curated_scope,
      in_route_scope,
      article_title,
      article_created_at,
      article_updated_at
    )
    WITH route_scope AS (
      SELECT
        project_import_route.project_id,
        article_import_route.article_id,
        TRUE AS in_route_scope,
        FALSE AS in_curated_scope
      FROM app.project_import_route project_import_route
      INNER JOIN app.article_import_route article_import_route
        ON article_import_route.import_route_id = project_import_route.import_route_id
      WHERE project_import_route.project_id = ${projectIdSql}
        AND ${input.getArticlePredicate('article_import_route')}
    ),
    curated_scope AS (
      SELECT
        project_article.project_id,
        project_article.article_id,
        FALSE AS in_route_scope,
        TRUE AS in_curated_scope
      FROM app.project_article project_article
      WHERE project_article.project_id = ${projectIdSql}
        AND ${input.getArticlePredicate('project_article')}
    ),
    combined_scope AS (
      SELECT * FROM route_scope
      UNION ALL
      SELECT * FROM curated_scope
    ),
    aggregated_scope AS (
      SELECT
        project_id,
        article_id,
        COALESCE(BOOL_OR(in_curated_scope), FALSE) AS in_curated_scope,
        COALESCE(BOOL_OR(in_route_scope), FALSE) AS in_route_scope
      FROM combined_scope
      GROUP BY project_id, article_id
    )
    SELECT
      aggregated_scope.project_id,
      aggregated_scope.article_id,
      aggregated_scope.in_curated_scope,
      aggregated_scope.in_route_scope,
      article.article_title,
      article.article_created_at,
      article.article_updated_at
    FROM aggregated_scope
    INNER JOIN app.project project
      ON project.id = aggregated_scope.project_id
      AND project.archived = FALSE
    INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    WHERE aggregated_scope.project_id = ${projectIdSql}
      AND ${input.getArticlePredicate('aggregated_scope')}
      AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
      AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
  `
}

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.flatMap((claim) => {
        return claim.articleId === null ? [] : [claim.articleId]
      }),
    ),
  ]
}

const getProjectScopeArticlePatchStatements = (input: {articleIds: readonly string[]; projectId: string}) => {
  const articleIdsSql = input.articleIds.map(getSqlLiteral).join(', ')

  return input.articleIds.length === 0
    ? []
    : [
        getProjectScopeArticleRowsStatement({
          getArticlePredicate: (alias) => {
            return `${alias}.article_id IN (${articleIdsSql})`
          },
          projectId: input.projectId,
        }),
      ]
}

const getPatchWatermark = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )
}

const getPatchRangeStart = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.min(
    ...claims.map((claim) => {
      return claim.firstSourceHighWaterMark
    }),
  )
}

const getClaimSourcePartition = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims[0]?.sourcePartition ?? 'review-change'
}

const getClaimKinds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.map((claim) => {
        return claim.dirtyKind
      }),
    ),
  ].join(',')
}

const getProjectScopePatchManifest = (
  input: ProjectReviewServingProjectScopeInput,
): ReviewServingProjectionIdentityManifestInput => {
  const patchWatermark = getPatchWatermark(input.claims)

  return {
    baseGeneration: input.baseGeneration,
    definitionVersion: input.definitionVersion,
    inputDigest: getClaimKinds(input.claims),
    inputWatermark: patchWatermark,
    inputWatermarks: getReviewServingSourcePartitionWatermarks(input.claims),
    invalidationReason: getClaimKinds(input.claims),
    patchRangeEnd: patchWatermark,
    patchRangeStart: getPatchRangeStart(input.claims),
    patchWatermark,
    projectId: input.projectId,
    projectionComponent: 'projectScope',
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

export const projectReviewServingProjectScopePatches = async (
  input: ProjectReviewServingProjectScopeInput,
  database: ReviewServingProjectScopeProjectorDatabase = getAppDatabaseService(),
) => {
  const patchWatermark = getPatchWatermark(input.claims)
  const shouldAcknowledgeClaims = input.claims.length > 0 && input.acknowledgeClaims !== false

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: shouldAcknowledgeClaims ? input.claims : [],
      component: 'projectScope',
      projectionManifests: shouldAcknowledgeClaims ? [getProjectScopePatchManifest(input)] : [],
      statements: getProjectScopeArticlePatchStatements({
        articleIds: getClaimArticleIds(input.claims),
        projectId: input.projectId,
      }),
      watermark: !shouldAcknowledgeClaims
        ? undefined
        : {
            projectId: input.projectId,
            projectionComponent: 'projectScope',
            projectorName: projectScopeProjectorName,
            sourceHighWaterMark: patchWatermark,
            sourcePartition: getClaimSourcePartition(input.claims),
          },
    },
    database,
  )

  return {patchWatermark}
}

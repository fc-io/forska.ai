import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingProjectionComponent, type ReviewServingSearchAvailability} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'
import {getReviewServingOptionalComponentAvailability} from './reviewServingSnapshotPromotionService.ts'

export type ReviewServingTitleSearchProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingTitleSearchInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  claims?: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion?: string
  projectId: string
  projectScopeIdentity: string
  projectionIdentity?: string
  searchIdentity: string
  selectedImportSnapshotId?: string | null
  snapshotId: string
  status?: ReviewServingProjectionManifestStatus
}

export type ProjectReviewServingTitleSearchRebuildInput = {
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  projectId: string
  projectScopeIdentity: string
  searchIdentity: string
  selectedImportSnapshotId?: string | null
  snapshotId: string
}

type TitleSearchSourceRow = {
  activitySortAt: Date | string | null
  articleId: string
  articleTitle: string | null
  tombstone: boolean
}

const titleSearchProjectorName = 'title-search-projector'
const titleSearchTokenizerVersion = 'title-token-v1'
const titlePrefixLength = 128

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

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[] = []) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.articleId ?? (claim.scopeKind === 'article' ? (claim.scopeId.split(':').at(-1) ?? null) : null)
        })
        .filter((articleId) => {
          return articleId !== null && articleId.trim().length > 0
        }) as string[],
    ),
  ]
}

const getDirtyArticleCteSql = (articleIds: readonly string[]) => {
  return articleIds.length === 0
    ? ''
    : `dirty_article(article_id) AS (SELECT * FROM (VALUES ${articleIds
        .map((articleId) => {
          return `(${getSqlLiteral(articleId)})`
        })
        .join(', ')}))`
}

const getArticleRangePredicate = (input: {chunkEndArticleId?: string | null; chunkStartArticleId?: string | null}) => {
  const startPredicate =
    input.chunkStartArticleId === null || input.chunkStartArticleId === undefined
      ? ''
      : `AND scope.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}`
  const endPredicate =
    input.chunkEndArticleId === null || input.chunkEndArticleId === undefined
      ? ''
      : `AND scope.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}`

  return `${startPredicate}
      ${endPredicate}`
}

const getSelectedImportTitleSql = (input: ProjectReviewServingTitleSearchInput) => {
  return input.selectedImportSnapshotId === null || input.selectedImportSnapshotId === undefined
    ? 'article.article_title'
    : `CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN article.article_title
        WHEN selected_patch.patch_watermark IS NOT NULL THEN COALESCE(selected_patch.article_title, article.article_title)
        ELSE COALESCE(selected_base.article_title, article.article_title)
      END`
}

const getSelectedImportTitleJoinSql = (input: ProjectReviewServingTitleSearchInput) => {
  return input.selectedImportSnapshotId === null || input.selectedImportSnapshotId === undefined
    ? ''
    : `
    LEFT JOIN app.review_selected_article_import_v4 selected_base
      ON selected_base.project_id = ${getSqlLiteral(input.projectId)}
      AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected_base.article_id = scope.article_id
    LEFT JOIN mart.review_selected_import_patch_v4 selected_patch
      ON selected_patch.project_id = ${getSqlLiteral(input.projectId)}
      AND selected_patch.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_patch.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected_patch.article_id = scope.article_id
      AND selected_patch.patch_watermark = (
        SELECT MAX(newer.patch_watermark)
        FROM mart.review_selected_import_patch_v4 newer
        WHERE newer.project_id = selected_patch.project_id
          AND newer.project_scope_identity = selected_patch.project_scope_identity
          AND newer.selected_import_snapshot_id = selected_patch.selected_import_snapshot_id
          AND newer.article_id = selected_patch.article_id
      )`
}

const getNormalizedTitleToken = (value: string) => {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export const getReviewServingTitleSearchTokens = (title: string | null) => {
  return [
    ...new Set(
      getNormalizedTitleToken(title ?? '')
        .split(/[^a-z0-9]+/)
        .filter((token) => {
          return token.length > 0
        }),
    ),
  ]
}

const getTitlePrefix = (title: string | null) => {
  return getNormalizedTitleToken(title ?? '').slice(0, titlePrefixLength)
}

const getTitleSearchRows = async (
  input: ProjectReviewServingTitleSearchInput,
  database: ReviewServingTitleSearchProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const dirtyArticleCte = getDirtyArticleCteSql(articleIds)
  const dirtyJoinSql =
    articleIds.length === 0 ? '' : 'INNER JOIN dirty_article dirty ON dirty.article_id = scope.article_id'
  const withSql = dirtyArticleCte.length === 0 ? '' : `WITH ${dirtyArticleCte}`

  return database.queryJson<TitleSearchSourceRow>(`
    ${withSql}
    SELECT
      scope.article_id AS articleId,
      ${getSelectedImportTitleSql(input)} AS articleTitle,
      COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at) AS activitySortAt,
      article.id IS NULL OR NOT (scope.in_curated_scope OR scope.in_route_scope) AS tombstone
    FROM mart.project_scope_article scope
    ${dirtyJoinSql}
    LEFT JOIN app."article" article
      ON article.id = scope.article_id
    ${getSelectedImportTitleJoinSql(input)}
    WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
      AND (scope.in_curated_scope OR scope.in_route_scope OR ${articleIds.length > 0 ? 'TRUE' : 'FALSE'})
      ${getArticleRangePredicate(input)}
    ORDER BY scope.article_id ASC
  `)
}

const getTitleSearchRecord = (
  input: ProjectReviewServingTitleSearchInput,
  row: TitleSearchSourceRow,
  token: string,
): ReviewServingProjectorRecord => {
  return {
    keyColumns: ['project_id', 'search_identity', 'project_scope_identity', 'snapshot_id', 'token', 'article_id'],
    table: 'mart.review_title_search_serving_v4',
    values: {
      activity_sort_at: row.activitySortAt,
      article_id: row.articleId,
      project_id: input.projectId,
      project_scope_identity: input.projectScopeIdentity,
      search_identity: input.searchIdentity,
      search_updated_at: new Date(),
      snapshot_id: input.snapshotId,
      title_prefix: getTitlePrefix(row.articleTitle),
      token,
    },
  }
}

const getTitleSearchManifest = (
  input: ProjectReviewServingTitleSearchInput & {
    claims: readonly ReviewServingDirtyWorkClaim[]
    definitionVersion: string
    projectionIdentity: string
  },
): ReviewServingProjectionIdentityManifestInput => {
  const patchWatermark = getPatchWatermark(input.claims)

  return {
    baseGeneration: input.baseGeneration,
    definitionVersion: input.definitionVersion,
    inputDigest: `${titleSearchTokenizerVersion}:${getClaimKinds(input.claims)}`,
    inputWatermark: patchWatermark,
    inputWatermarks: getReviewServingSourcePartitionWatermarks(input.claims),
    invalidationReason: getClaimKinds(input.claims),
    patchRangeEnd: patchWatermark,
    patchRangeStart: getPatchRangeStart(input.claims),
    patchWatermark,
    projectId: input.projectId,
    projectionComponent: 'search',
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

const getDeleteDirtyTitleSearchRowsStatements = (input: ProjectReviewServingTitleSearchInput) => {
  const articleIds = getClaimArticleIds(input.claims)
  const hasClaimedWork = (input.claims?.length ?? 0) > 0

  return !hasClaimedWork
    ? []
    : [
        getDeleteReviewServingProjectorRowsStatement({
          predicates: {
            ...(articleIds.length > 0 ? {article_id: articleIds} : {}),
            project_id: input.projectId,
            project_scope_identity: input.projectScopeIdentity,
            search_identity: input.searchIdentity,
            snapshot_id: input.snapshotId,
          },
          table: 'mart.review_title_search_serving_v4',
        }),
      ]
}

const getInsertTitleSearchRebuildRowsStatement = (input: ProjectReviewServingTitleSearchRebuildInput) => {
  const articleTitleSql = getSelectedImportTitleSql(input)

  return `
    INSERT INTO mart.review_title_search_serving_v4 (
      project_id,
      search_identity,
      project_scope_identity,
      snapshot_id,
      token,
      article_id,
      title_prefix,
      activity_sort_at,
      search_updated_at
    )
    WITH source AS (
      SELECT
        scope.article_id,
        lower(strip_accents(COALESCE(${articleTitleSql}, ''))) AS normalized_title,
        COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at) AS activity_sort_at
      FROM mart.project_scope_article scope
      LEFT JOIN app."article" article
        ON article.id = scope.article_id
      ${getSelectedImportTitleJoinSql(input)}
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        AND article.id IS NOT NULL
        ${getArticleRangePredicate(input)}
    ), tokenized AS (
      SELECT DISTINCT
        source.article_id,
        token_rows.token,
        left(source.normalized_title, ${getSqlLiteral(titlePrefixLength)}) AS title_prefix,
        source.activity_sort_at
      FROM source
      CROSS JOIN unnest(regexp_split_to_array(source.normalized_title, '[^a-z0-9]+')) AS token_rows(token)
      WHERE token_rows.token <> ''
    )
    SELECT
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.searchIdentity)} AS search_identity,
      ${getSqlLiteral(input.projectScopeIdentity)} AS project_scope_identity,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      tokenized.token,
      tokenized.article_id,
      tokenized.title_prefix,
      tokenized.activity_sort_at,
      current_timestamp AS search_updated_at
    FROM tokenized
    ON CONFLICT(project_id, search_identity, project_scope_identity, snapshot_id, token, article_id) DO UPDATE SET
      title_prefix = excluded.title_prefix,
      activity_sort_at = excluded.activity_sort_at,
      search_updated_at = excluded.search_updated_at
  `
}

export const getReviewServingSearchAvailabilityFromManifest = (input: {
  hasActiveSnapshot: boolean
  optionalComponents: readonly string[]
  optionalSearchStatePresent: boolean
}): ReviewServingSearchAvailability => {
  return getReviewServingOptionalComponentAvailability({
    component: 'search',
    hasActiveSnapshot: input.hasActiveSnapshot,
    optionalComponents: input.optionalComponents as readonly ReviewServingProjectionComponent[],
    optionalStatePresent: input.optionalSearchStatePresent,
  }) as ReviewServingSearchAvailability
}

export const projectReviewServingTitleSearchRows = async (
  input: ProjectReviewServingTitleSearchInput,
  database: ReviewServingTitleSearchProjectorDatabase = getAppDatabaseService() as ReviewServingTitleSearchProjectorDatabase,
) => {
  const claims = input.claims ?? []
  const rows = await getTitleSearchRows(input, database)
  const definitionVersion = input.definitionVersion
  const projectionIdentity = input.projectionIdentity
  const records = rows.flatMap((row) => {
    return row.tombstone
      ? []
      : getReviewServingTitleSearchTokens(row.articleTitle).map((token) => {
          return getTitleSearchRecord(input, row, token)
        })
  })
  const patchWatermark = getPatchWatermark(claims)
  const hasClaimedWork = claims.length > 0 && definitionVersion !== undefined && projectionIdentity !== undefined

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: hasClaimedWork && input.acknowledgeClaims !== false ? claims : [],
      component: 'search',
      projectionManifests: hasClaimedWork
        ? [getTitleSearchManifest({...input, claims, definitionVersion, projectionIdentity})]
        : [],
      records,
      statements: getDeleteDirtyTitleSearchRowsStatements(input),
      watermark: hasClaimedWork
        ? {
            projectId: input.projectId,
            projectionComponent: 'search',
            projectorName: titleSearchProjectorName,
            sourceHighWaterMark: patchWatermark,
            sourcePartition: getClaimSourcePartition(claims),
          }
        : undefined,
    },
    database,
  )

  return {patchWatermark, searchRowCount: records.length}
}

export const projectReviewServingTitleSearchRebuildRows = async (
  input: ProjectReviewServingTitleSearchRebuildInput,
  database: ReviewServingTitleSearchProjectorDatabase = getAppDatabaseService() as ReviewServingTitleSearchProjectorDatabase,
) => {
  await database.run(getInsertTitleSearchRebuildRowsStatement(input))

  return {patchWatermark: 0}
}

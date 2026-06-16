import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingSearchAvailability} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingTitleSearchProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingTitleSearchInput = {
  baseGeneration: number
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
          return claim.articleId ?? claim.scopeId.split(':').at(-1) ?? null
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

const getNormalizedTitleToken = (value: string) => {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

const getTitleTokens = (title: string | null) => {
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
      article.article_title AS articleTitle,
      COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at) AS activitySortAt,
      article.id IS NULL OR NOT (scope.in_curated_scope OR scope.in_route_scope) AS tombstone
    FROM mart.project_scope_article scope
    ${dirtyJoinSql}
    LEFT JOIN app."article" article
      ON article.id = scope.article_id
    WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
      AND (scope.in_curated_scope OR scope.in_route_scope OR ${articleIds.length > 0 ? 'TRUE' : 'FALSE'})
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

  return articleIds.length === 0
    ? []
    : [
        getDeleteReviewServingProjectorRowsStatement({
          predicates: {
            article_id: articleIds,
            project_id: input.projectId,
            project_scope_identity: input.projectScopeIdentity,
            search_identity: input.searchIdentity,
            snapshot_id: input.snapshotId,
          },
          table: 'mart.review_title_search_serving_v4',
        }),
      ]
}

export const getReviewServingSearchAvailabilityFromManifest = (input: {
  hasActiveSnapshot: boolean
  optionalComponents: readonly string[]
  optionalSearchStatePresent: boolean
}): ReviewServingSearchAvailability => {
  return !input.hasActiveSnapshot
    ? 'unavailable'
    : !input.optionalComponents.includes('search')
      ? 'async'
      : input.optionalSearchStatePresent
        ? 'ready'
        : 'indexing'
}

export const projectReviewServingTitleSearchRows = async (
  input: ProjectReviewServingTitleSearchInput,
  database: ReviewServingTitleSearchProjectorDatabase = getAppDatabaseService(),
) => {
  const claims = input.claims ?? []
  const rows = await getTitleSearchRows(input, database)
  const records = rows.flatMap((row) => {
    return row.tombstone
      ? []
      : getTitleTokens(row.articleTitle).map((token) => {
          return getTitleSearchRecord(input, row, token)
        })
  })
  const patchWatermark = getPatchWatermark(claims)
  const hasClaimedWork =
    claims.length > 0 && input.definitionVersion !== undefined && input.projectionIdentity !== undefined

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: hasClaimedWork ? claims : [],
      component: 'search',
      projectionManifests: hasClaimedWork
        ? [
            getTitleSearchManifest({
              ...input,
              claims,
              definitionVersion: input.definitionVersion,
              projectionIdentity: input.projectionIdentity,
            }),
          ]
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

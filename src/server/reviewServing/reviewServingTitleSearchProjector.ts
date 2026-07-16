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
  type ReviewServingProjectorWriterDiagnostics,
  writeReviewServingProjectorComponent,
  writeReviewServingTitleSearchRebuildRanges,
  writeReviewServingTitleSearchRebuildRows,
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

export type ProjectReviewServingTitleSearchRebuildRangesInput = {
  ranges: readonly ProjectReviewServingTitleSearchRebuildInput[]
}

type TitleSearchSourceRow = {
  activitySortAt: Date | string | null
  articleId: string
  articleTitle: string | null
  tombstone: boolean
}

type SelectedImportTitleSqlInput = {
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId?: string | null
}

const titleSearchProjectorName = 'title-search-projector'
const titleSearchTokenizerVersion = 'title-token-v1'
const titlePrefixLength = 128

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const getTimedProjector = () => {
  const phaseTimings: Record<string, number> = {}
  const measure = async <T>(phase: string, operation: () => Promise<T>) => {
    const startedAtMs = Date.now()
    const result = await operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }
  const measureSync = <T>(phase: string, operation: () => T) => {
    const startedAtMs = Date.now()
    const result = operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }

  return {measure, measureSync, phaseTimings}
}

const getTitleSearchDiagnosticsJson = (input: {
  phaseTimings: Record<string, number>
  sourceRowCount?: number
  writer?: ReviewServingProjectorWriterDiagnostics
}) => {
  return {
    phaseTimings: input.phaseTimings,
    titleSearchProjector: {sourceRowCount: input.sourceRowCount, writer: input.writer},
  }
}

const withDiagnosticsJson = <T extends object>(result: T, diagnosticsJson: unknown): T => {
  return Object.defineProperty(result, 'diagnosticsJson', {enumerable: false, value: diagnosticsJson})
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

const getArticleRangePredicate = (
  input: {chunkEndArticleId?: string | null; chunkStartArticleId?: string | null},
  tableAlias = 'scope',
) => {
  const startPredicate =
    input.chunkStartArticleId === null || input.chunkStartArticleId === undefined
      ? ''
      : `AND ${tableAlias}.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}`
  const endPredicate =
    input.chunkEndArticleId === null || input.chunkEndArticleId === undefined
      ? ''
      : `AND ${tableAlias}.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}`

  return `${startPredicate}
      ${endPredicate}`
}

const getSelectedImportTitleSql = (
  input: SelectedImportTitleSqlInput,
  _options: {includeSelectedPatchOverlay?: boolean} = {},
) => {
  if (input.selectedImportSnapshotId === null || input.selectedImportSnapshotId === undefined) {
    return 'article.article_title'
  }

  return `CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN article.article_title
        ELSE COALESCE(selected_base.article_title, article.article_title)
      END`
}

const getSelectedImportTitleJoinSql = (
  input: SelectedImportTitleSqlInput,
  _options: {includeSelectedPatchOverlay?: boolean} = {},
) => {
  if (input.selectedImportSnapshotId === null || input.selectedImportSnapshotId === undefined) {
    return ''
  }

  const selectedBaseJoinSql = `
    LEFT JOIN app.review_selected_article_import_v4 selected_base
      ON selected_base.project_id = ${getSqlLiteral(input.projectId)}
      AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected_base.article_id = scope.article_id`

  return selectedBaseJoinSql
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
  const includeSelectedPatchOverlay = false

  return database.queryJson<TitleSearchSourceRow>(`
    ${withSql}
    SELECT
      scope.article_id AS articleId,
      ${getSelectedImportTitleSql(input, {includeSelectedPatchOverlay})} AS articleTitle,
      COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at) AS activitySortAt,
      article.id IS NULL OR NOT (scope.in_curated_scope OR scope.in_route_scope) AS tombstone
    FROM mart.project_scope_article scope
    ${dirtyJoinSql}
    LEFT JOIN app."article" article
      ON article.id = scope.article_id
    ${getSelectedImportTitleJoinSql(input, {includeSelectedPatchOverlay})}
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
  const {measure, measureSync, phaseTimings} = getTimedProjector()
  const claims = input.claims ?? []
  const rows = await measure('sourceQueryMs', async () => {
    return getTitleSearchRows(input, database)
  })
  const definitionVersion = input.definitionVersion
  const projectionIdentity = input.projectionIdentity
  const records = measureSync('recordTransformMs', () => {
    return rows.flatMap((row) => {
      return row.tombstone
        ? []
        : getReviewServingTitleSearchTokens(row.articleTitle).map((token) => {
            return getTitleSearchRecord(input, row, token)
          })
    })
  })
  const patchWatermark = getPatchWatermark(claims)
  const hasClaimedWork = claims.length > 0 && definitionVersion !== undefined && projectionIdentity !== undefined
  const shouldAcknowledgeClaims = hasClaimedWork && input.acknowledgeClaims !== false

  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: shouldAcknowledgeClaims ? claims : [],
        component: 'search',
        projectionManifests: shouldAcknowledgeClaims
          ? [getTitleSearchManifest({...input, claims, definitionVersion, projectionIdentity})]
          : [],
        records,
        statements: getDeleteDirtyTitleSearchRowsStatements(input),
        watermark: shouldAcknowledgeClaims
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
  })

  return withDiagnosticsJson(
    {patchWatermark, searchRowCount: records.length},
    getTitleSearchDiagnosticsJson({phaseTimings, sourceRowCount: rows.length, writer: writer.diagnostics}),
  )
}

export const projectReviewServingTitleSearchRebuildRows = async (
  input: ProjectReviewServingTitleSearchRebuildInput,
  database: ReviewServingTitleSearchProjectorDatabase = getAppDatabaseService() as ReviewServingTitleSearchProjectorDatabase,
) => {
  const {measure, phaseTimings} = getTimedProjector()
  await measure('writerMs', async () => {
    return writeReviewServingTitleSearchRebuildRows(getReviewServingTitleSearchRebuildWriterInput(input), database)
  })

  return withDiagnosticsJson({patchWatermark: 0}, getTitleSearchDiagnosticsJson({phaseTimings}))
}

const getReviewServingTitleSearchRebuildWriterInput = (input: ProjectReviewServingTitleSearchRebuildInput) => {
  return {
    activitySortAtSql:
      'COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at)',
    articleRangePredicateSql: getArticleRangePredicate(input),
    articleTitleSql: getSelectedImportTitleSql(input, {includeSelectedPatchOverlay: false}),
    projectId: input.projectId,
    projectScopeIdentity: input.projectScopeIdentity,
    searchIdentity: input.searchIdentity,
    selectedImportJoinSql: getSelectedImportTitleJoinSql(input, {includeSelectedPatchOverlay: false}),
    snapshotId: input.snapshotId,
    targetArticleRangePredicateSql: getArticleRangePredicate(input, 'search'),
    titlePrefixLength,
  }
}

export const projectReviewServingTitleSearchRebuildRanges = async (
  input: ProjectReviewServingTitleSearchRebuildRangesInput,
  database: ReviewServingTitleSearchProjectorDatabase = getAppDatabaseService() as ReviewServingTitleSearchProjectorDatabase,
) => {
  const {measure, phaseTimings} = getTimedProjector()
  const writer = await measure('writerMs', async () => {
    return writeReviewServingTitleSearchRebuildRanges(
      {
        ranges: input.ranges.map((range) => {
          return getReviewServingTitleSearchRebuildWriterInput(range)
        }),
      },
      database,
    )
  })

  return withDiagnosticsJson(
    {patchWatermark: 0, rangeCount: input.ranges.length},
    getTitleSearchDiagnosticsJson({phaseTimings, writer: writer.diagnostics}),
  )
}

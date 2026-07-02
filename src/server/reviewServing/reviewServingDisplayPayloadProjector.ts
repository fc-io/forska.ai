import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
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

export type ReviewServingDisplayPayloadProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingDisplayBaseInput = {
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  displayIdentity: string
  humanStatusIdentity: string
  listModeKeys: readonly string[]
  llmStatusIdentity: string
  payloadIdentity: string
  postingIdentity: string
  projectId: string
  projectScopeIdentity: string
  reviewConfigHash: string
  selectedImportIdentity: string
  selectedImportSnapshotId: string
  snapshotId: string
  summaryIdentity: string
}

export type ProjectReviewServingDisplayPatchInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  displayIdentity: string
  projectId: string
  projectScopeIdentity: string
  projectionIdentity: string
  selectedImportSnapshotId: string
  snapshotId: string
  status?: ReviewServingProjectionManifestStatus
}

export type ProjectReviewServingPayloadInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  claims?: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion?: string
  displayIdentity: string
  payloadIdentity: string
  projectId: string
  projectionIdentity?: string
  selectedImportSnapshotId: string
  snapshotId: string
  status?: ReviewServingProjectionManifestStatus
}

type DisplayProjectionRow = {
  activitySortAt: Date | string
  articleCreatedAt: Date | string | null
  articleExternalId: string | null
  articleId: string
  articleTitle: string
  articleUpdatedAt: Date | string | null
  arxivId: string | null
  biorxivId: string | null
  conflictFlag: boolean | null
  doi: string | null
  fullTextConversionStatus: string | null
  fullTextFetchedAt: Date | string | null
  duplicateFlag: boolean | null
  fullTextPdf: string | null
  journalTitle: string | null
  medrxivId: string | null
  pmid: string | null
  publicationYear: number | null
  selectedImportRouteId: string | null
  selectedRankKey: string | null
  sourceMetadata: ReviewServingIdentityValue | null
  sortKey: Date | string
  url: string | null
}

type DisplayPatchRow = {
  activitySortAt: Date | string | null
  articleCreatedAt: Date | string | null
  articleExternalId: string | null
  articleId: string
  articleTitle: string | null
  articleUpdatedAt: Date | string | null
  arxivId: string | null
  biorxivId: string | null
  doi: string | null
  fullTextConversionStatus: string | null
  fullTextFetchedAt: Date | string | null
  fullTextPdf: string | null
  journalTitle: string | null
  medrxivId: string | null
  pmid: string | null
  publicationYear: number | null
  sourceMetadata: ReviewServingIdentityValue | null
  sortKey: Date | string | null
  tombstone: boolean
  url: string | null
}

type PayloadProjectionRow = {
  abstractText: string | null
  articleCreatedAt: Date | string | null
  articleId: string
  fullTextPreview: string | null
  payloadBytes: number
  sourceMetadata: ReviewServingIdentityValue | null
}

type ReviewServingPayloadPatchManifestInput = {
  baseGeneration: number
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  projectId: string
  projectionIdentity: string
  status?: ReviewServingProjectionManifestStatus
}

const displayProjectorName = 'display-projector'
const payloadProjectorName = 'payload-projector'

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

const getDirtyArticleCteSql = (articleIds: readonly string[]) => {
  return articleIds.length === 0
    ? ''
    : `
      WITH dirty_article(article_id) AS (
        SELECT * FROM (VALUES ${articleIds
          .map((articleId) => {
            return `(${getSqlLiteral(articleId)})`
          })
          .join(', ')})
      )
    `
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

const getServingArticleRangePredicate = (
  input: {chunkEndArticleId?: string | null; chunkStartArticleId?: string | null},
  column = 'article_id',
) => {
  const startPredicate =
    input.chunkStartArticleId === null || input.chunkStartArticleId === undefined
      ? ''
      : `AND ${column} >= ${getSqlLiteral(input.chunkStartArticleId)}`
  const endPredicate =
    input.chunkEndArticleId === null || input.chunkEndArticleId === undefined
      ? ''
      : `AND ${column} <= ${getSqlLiteral(input.chunkEndArticleId)}`

  return `${startPredicate}
      ${endPredicate}`
}

const getListModeKeyPredicate = (listModeKeys: readonly string[]) => {
  return listModeKeys.length === 0
    ? 'FALSE'
    : `list_mode_key IN (${listModeKeys
        .map((listModeKey) => {
          return getSqlLiteral(listModeKey)
        })
        .join(', ')})`
}

const getDisplayBaseRowsSql = (input: ProjectReviewServingDisplayBaseInput, options: {orderBy?: boolean} = {}) => {
  const orderBy = options.orderBy === false ? '' : 'ORDER BY scope.article_id ASC'

  return `
    SELECT
      scope.article_id AS articleId,
      article.article_created_at AS articleCreatedAt,
      article.article_updated_at AS articleUpdatedAt,
      COALESCE(article.article_created_at, scope.article_created_at, current_timestamp) AS sortKey,
      COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at, current_timestamp) AS activitySortAt,
      COALESCE(
        CASE
          WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
          WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.article_title
          ELSE selected_base.article_title
        END,
        article.article_title
      ) AS articleTitle,
      COALESCE(
        CASE
          WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
          WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.external_id
          ELSE selected_base.external_id
        END,
        article.article_id
      ) AS articleExternalId,
      article.arxiv_id AS arxivId,
      article.biorxiv_id AS biorxivId,
      article.medrxiv_id AS medrxivId,
      article.doi,
      article.pubmed_id AS pmid,
      CASE
        WHEN article.source_metadata IS NULL AND selected_source.import_metadata IS NULL THEN NULL
        ELSE json_merge_patch(
          COALESCE(article.source_metadata, CAST('{}' AS JSON)),
          COALESCE(selected_source.import_metadata, CAST('{}' AS JSON))
        )
      END AS sourceMetadata,
      CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.journal_title
        ELSE selected_base.journal_title
      END AS journalTitle,
      COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url,
      article.full_text_pdf AS fullTextPdf,
      article.full_text_fetched_at AS fullTextFetchedAt,
      article.full_text_conversion_status AS fullTextConversionStatus,
      CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.import_route_id
        ELSE selected_base.import_route_id
      END AS selectedImportRouteId,
      CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.selected_rank_key
        ELSE selected_base.selected_rank_key
      END AS selectedRankKey,
      CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.publication_year
        ELSE selected_base.publication_year
      END AS publicationYear,
      CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.duplicate_flag
        ELSE selected_base.duplicate_flag
      END AS duplicateFlag,
      CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.conflict_flag
        ELSE selected_base.conflict_flag
      END AS conflictFlag
    FROM mart.project_scope_article scope
    INNER JOIN app."article" article
      ON article.id = scope.article_id
    LEFT JOIN app.review_selected_article_import_v4 selected_base
      ON selected_base.project_id = scope.project_id
      AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected_base.article_id = scope.article_id
    LEFT JOIN mart.review_selected_import_patch_v4 selected_patch
      ON selected_patch.project_id = scope.project_id
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
      )
    LEFT JOIN app.article_import_route_source_record selected_source
      ON selected_source.import_route_id = CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.import_route_id
        ELSE selected_base.import_route_id
      END
      AND selected_source.article_id = scope.article_id
      AND selected_source.source_record_key = CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.source_record_key
        ELSE selected_base.source_record_key
      END
      AND selected_source.quarantined_at IS NULL
    WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
      AND (scope.in_curated_scope OR scope.in_route_scope)
      ${getArticleRangePredicate(input)}
    ${orderBy}
  `
}

const getDisplayBaseRows = async (
  input: ProjectReviewServingDisplayBaseInput,
  database: ReviewServingDisplayPayloadProjectorDatabase,
) => {
  return database.queryJson<DisplayProjectionRow>(getDisplayBaseRowsSql(input))
}

const getDisplayBaseListModeRowsSql = (listModeKeys: readonly string[]) => {
  return listModeKeys
    .map((listModeKey) => {
      return `(${getSqlLiteral(listModeKey)})`
    })
    .join(', ')
}

const getInsertDisplayBaseRowsStatement = (input: ProjectReviewServingDisplayBaseInput) => {
  return `
    INSERT INTO mart.review_article_serving_v4 (
      activity_sort_at,
      article_created_at,
      article_external_id,
      article_id,
      article_title,
      article_updated_at,
      arxiv_id,
      biorxiv_id,
      base_generation,
      conflict_flag,
      display_identity,
      doi,
      duplicate_flag,
      full_text_conversion_status,
      full_text_fetched_at,
      enabled_prompt_count,
      full_text_pdf,
      human_answered_prompt_count,
      human_status_identity,
      journal_title,
      list_mode_key,
      llm_judged_prompt_count,
      llm_status_identity,
      medrxiv_id,
      patch_watermark,
      payload_identity,
      pmid,
      posting_identity,
      project_id,
      project_scope_identity,
      publication_year,
      review_config_hash,
      review_opened,
      review_sections_completed,
      selected_import_identity,
      selected_import_route_id,
      selected_rank_key,
      serving_updated_at,
      snapshot_id,
      sort_key,
      summary_identity,
      url
    )
    WITH display_base AS (
      ${getDisplayBaseRowsSql(input, {orderBy: false})}
    ),
    list_mode(list_mode_key) AS (
      SELECT * FROM (VALUES ${getDisplayBaseListModeRowsSql(input.listModeKeys)})
    )
    SELECT
      display_base.activitySortAt AS activity_sort_at,
      display_base.articleCreatedAt AS article_created_at,
      display_base.articleExternalId AS article_external_id,
      display_base.articleId AS article_id,
      display_base.articleTitle AS article_title,
      display_base.articleUpdatedAt AS article_updated_at,
      display_base.arxivId AS arxiv_id,
      display_base.biorxivId AS biorxiv_id,
      ${getSqlLiteral(input.baseGeneration)} AS base_generation,
      COALESCE(display_base.conflictFlag, FALSE) AS conflict_flag,
      ${getSqlLiteral(input.displayIdentity)} AS display_identity,
      display_base.doi,
      COALESCE(display_base.duplicateFlag, FALSE) AS duplicate_flag,
      display_base.fullTextConversionStatus AS full_text_conversion_status,
      display_base.fullTextFetchedAt AS full_text_fetched_at,
      0 AS enabled_prompt_count,
      display_base.fullTextPdf AS full_text_pdf,
      0 AS human_answered_prompt_count,
      ${getSqlLiteral(input.humanStatusIdentity)} AS human_status_identity,
      display_base.journalTitle AS journal_title,
      list_mode.list_mode_key,
      0 AS llm_judged_prompt_count,
      ${getSqlLiteral(input.llmStatusIdentity)} AS llm_status_identity,
      display_base.medrxivId AS medrxiv_id,
      0 AS patch_watermark,
      ${getSqlLiteral(input.payloadIdentity)} AS payload_identity,
      display_base.pmid,
      ${getSqlLiteral(input.postingIdentity)} AS posting_identity,
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.projectScopeIdentity)} AS project_scope_identity,
      display_base.publicationYear AS publication_year,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      FALSE AS review_opened,
      0 AS review_sections_completed,
      ${getSqlLiteral(input.selectedImportIdentity)} AS selected_import_identity,
      display_base.selectedImportRouteId AS selected_import_route_id,
      display_base.selectedRankKey AS selected_rank_key,
      current_timestamp AS serving_updated_at,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      display_base.sortKey AS sort_key,
      ${getSqlLiteral(input.summaryIdentity)} AS summary_identity,
      display_base.url
    FROM display_base
    CROSS JOIN list_mode
    ORDER BY display_base.articleId ASC, list_mode.list_mode_key ASC
  `
}

const getDisplayPatchRows = async (
  input: ProjectReviewServingDisplayPatchInput,
  database: ReviewServingDisplayPayloadProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)

  return articleIds.length === 0
    ? []
    : database.queryJson<DisplayPatchRow>(`
        ${getDirtyArticleCteSql(articleIds)}
        SELECT
          dirty.article_id AS articleId,
          article.article_created_at AS articleCreatedAt,
          article.article_updated_at AS articleUpdatedAt,
          COALESCE(article.article_created_at, scope.article_created_at, current_timestamp) AS sortKey,
          COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at, current_timestamp) AS activitySortAt,
          COALESCE(
            CASE
              WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
              WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.article_title
              ELSE selected_base.article_title
            END,
            article.article_title
          ) AS articleTitle,
          COALESCE(
            CASE
              WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
              WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.external_id
              ELSE selected_base.external_id
            END,
            article.article_id
          ) AS articleExternalId,
          article.arxiv_id AS arxivId,
          article.biorxiv_id AS biorxivId,
          article.medrxiv_id AS medrxivId,
          article.doi,
          article.pubmed_id AS pmid,
          CASE
            WHEN article.source_metadata IS NULL AND selected_source.import_metadata IS NULL THEN NULL
            ELSE json_merge_patch(
              COALESCE(article.source_metadata, CAST('{}' AS JSON)),
              COALESCE(selected_source.import_metadata, CAST('{}' AS JSON))
            )
          END AS sourceMetadata,
          article.full_text_pdf AS fullTextPdf,
          article.full_text_fetched_at AS fullTextFetchedAt,
          article.full_text_conversion_status AS fullTextConversionStatus,
          CASE
            WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
            WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.journal_title
            ELSE selected_base.journal_title
          END AS journalTitle,
          COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url,
          CASE
            WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
            WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.publication_year
            ELSE selected_base.publication_year
          END AS publicationYear,
          article.id IS NULL AS tombstone
        FROM dirty_article dirty
        LEFT JOIN app."article" article
          ON article.id = dirty.article_id
        LEFT JOIN mart.project_scope_article scope
          ON scope.project_id = ${getSqlLiteral(input.projectId)}
          AND scope.article_id = dirty.article_id
          AND (scope.in_curated_scope OR scope.in_route_scope)
        LEFT JOIN app.review_selected_article_import_v4 selected_base
          ON selected_base.project_id = ${getSqlLiteral(input.projectId)}
          AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
          AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
          AND selected_base.article_id = dirty.article_id
        LEFT JOIN mart.review_selected_import_patch_v4 selected_patch
          ON selected_patch.project_id = ${getSqlLiteral(input.projectId)}
          AND selected_patch.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
          AND selected_patch.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
          AND selected_patch.article_id = dirty.article_id
          AND selected_patch.patch_watermark = (
            SELECT MAX(newer.patch_watermark)
            FROM mart.review_selected_import_patch_v4 newer
            WHERE newer.project_id = selected_patch.project_id
              AND newer.project_scope_identity = selected_patch.project_scope_identity
              AND newer.selected_import_snapshot_id = selected_patch.selected_import_snapshot_id
              AND newer.article_id = selected_patch.article_id
          )
        LEFT JOIN app.article_import_route_source_record selected_source
          ON selected_source.import_route_id = CASE
            WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
            WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.import_route_id
            ELSE selected_base.import_route_id
          END
          AND selected_source.article_id = dirty.article_id
          AND selected_source.source_record_key = CASE
            WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
            WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.source_record_key
            ELSE selected_base.source_record_key
          END
          AND selected_source.quarantined_at IS NULL
        ORDER BY dirty.article_id ASC
      `)
}

const getPayloadRows = async (
  input: ProjectReviewServingPayloadInput,
  database: ReviewServingDisplayPayloadProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const dirtyJoinSql =
    articleIds.length === 0 ? '' : 'INNER JOIN dirty_article dirty ON dirty.article_id = scope.article_id'

  return database.queryJson<PayloadProjectionRow>(`
    ${getDirtyArticleCteSql(articleIds)}
    SELECT
      scope.article_id AS articleId,
      article.article_created_at AS articleCreatedAt,
      CASE
        WHEN article.source_metadata IS NULL AND selected_source.import_metadata IS NULL THEN NULL
        ELSE json_merge_patch(
          COALESCE(article.source_metadata, CAST('{}' AS JSON)),
          COALESCE(selected_source.import_metadata, CAST('{}' AS JSON))
        )
      END AS sourceMetadata,
      LEFT(article.article_summary, 2000) AS abstractText,
      LEFT(COALESCE(article.full_text, regexp_replace(COALESCE(article.full_text_html, ''), '<[^>]+>', '', 'g')), 2000) AS fullTextPreview,
      CAST(
        length(COALESCE(article.article_summary, ''))
        + length(COALESCE(article.full_text, ''))
        + length(COALESCE(article.full_text_html, ''))
        + length(COALESCE(CAST(article.source_metadata AS VARCHAR), ''))
        + length(COALESCE(CAST(selected_source.import_metadata AS VARCHAR), ''))
        AS BIGINT
      ) AS payloadBytes
    FROM mart.project_scope_article scope
    ${dirtyJoinSql}
    INNER JOIN app."article" article
      ON article.id = scope.article_id
    LEFT JOIN app.review_selected_article_import_v4 selected_base
      ON selected_base.project_id = scope.project_id
      AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected_base.article_id = scope.article_id
    LEFT JOIN mart.review_selected_import_patch_v4 selected_patch
      ON selected_patch.project_id = scope.project_id
      AND selected_patch.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected_patch.article_id = scope.article_id
      AND selected_patch.patch_watermark = (
        SELECT MAX(newer.patch_watermark)
        FROM mart.review_selected_import_patch_v4 newer
        WHERE newer.project_id = selected_patch.project_id
          AND newer.project_scope_identity = selected_patch.project_scope_identity
          AND newer.selected_import_snapshot_id = selected_patch.selected_import_snapshot_id
          AND newer.article_id = selected_patch.article_id
      )
    LEFT JOIN app.article_import_route_source_record selected_source
      ON selected_source.import_route_id = CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.import_route_id
        ELSE selected_base.import_route_id
      END
      AND selected_source.article_id = scope.article_id
      AND selected_source.source_record_key = CASE
        WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL
        WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.source_record_key
        ELSE selected_base.source_record_key
      END
      AND selected_source.quarantined_at IS NULL
    WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
      AND (scope.in_curated_scope OR scope.in_route_scope)
      ${getArticleRangePredicate(input)}
    ORDER BY article.article_created_at ASC NULLS LAST, scope.article_id ASC
  `)
}

const getDisplayPatchRecord = (
  input: ProjectReviewServingDisplayPatchInput,
  row: DisplayPatchRow,
): ReviewServingProjectorRecord => {
  return {
    keyColumns: ['project_id', 'display_identity', 'base_generation', 'patch_watermark', 'article_id'],
    table: 'mart.review_article_display_patch_v4',
    values: {
      article_external_id: row.tombstone ? null : row.articleExternalId,
      article_created_at: row.tombstone ? null : row.articleCreatedAt,
      article_id: row.articleId,
      article_title: row.tombstone ? null : row.articleTitle,
      article_updated_at: row.tombstone ? null : row.articleUpdatedAt,
      arxiv_id: row.tombstone ? null : row.arxivId,
      biorxiv_id: row.tombstone ? null : row.biorxivId,
      activity_sort_at: row.tombstone ? null : row.activitySortAt,
      base_generation: input.baseGeneration,
      display_identity: input.displayIdentity,
      doi: row.tombstone ? null : row.doi,
      full_text_conversion_status: row.tombstone ? null : row.fullTextConversionStatus,
      full_text_fetched_at: row.tombstone ? null : row.fullTextFetchedAt,
      full_text_pdf: row.tombstone ? null : row.fullTextPdf,
      journal_title: row.tombstone ? null : row.journalTitle,
      medrxiv_id: row.tombstone ? null : row.medrxivId,
      patch_updated_at: new Date(),
      patch_watermark: getPatchWatermark(input.claims),
      pmid: row.tombstone ? null : row.pmid,
      project_id: input.projectId,
      publication_year: row.tombstone ? null : row.publicationYear,
      sort_key: row.tombstone ? null : row.sortKey,
      tombstone: row.tombstone,
      url: row.tombstone ? null : row.url,
    },
  }
}

const getPayloadRecord = (
  input: ProjectReviewServingPayloadInput,
  row: PayloadProjectionRow,
): ReviewServingProjectorRecord => {
  return {
    keyColumns: ['project_id', 'display_identity', 'payload_identity', 'snapshot_id', 'article_id'],
    table: 'mart.review_article_serving_payload_v4',
    values: {
      abstract_text: row.abstractText,
      article_created_at: row.articleCreatedAt,
      article_id: row.articleId,
      display_identity: input.displayIdentity,
      full_text_preview: row.fullTextPreview,
      payload_bytes: row.payloadBytes,
      payload_identity: input.payloadIdentity,
      payload_updated_at: new Date(),
      project_id: input.projectId,
      snapshot_id: input.snapshotId,
      source_metadata: row.sourceMetadata,
    },
  }
}

const getDeletePayloadRowsStatement = (input: ProjectReviewServingPayloadInput) => {
  const articleIds = getClaimArticleIds(input.claims)
  const hasClaimedWork = (input.claims?.length ?? 0) > 0

  return !hasClaimedWork
    ? null
    : getDeleteReviewServingProjectorRowsStatement({
        predicates: {
          ...(articleIds.length > 0 ? {article_id: articleIds} : {}),
          display_identity: input.displayIdentity,
          payload_identity: input.payloadIdentity,
          project_id: input.projectId,
          snapshot_id: input.snapshotId,
        },
        table: 'mart.review_article_serving_payload_v4',
      })
}

const getApplyDisplayPatchServingStatement = (input: ProjectReviewServingDisplayPatchInput, row: DisplayPatchRow) => {
  const rowPredicate = `project_id = ${getSqlLiteral(input.projectId)}
          AND display_identity = ${getSqlLiteral(input.displayIdentity)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND base_generation = ${getSqlLiteral(input.baseGeneration)}
          AND article_id = ${getSqlLiteral(row.articleId)}`

  return row.tombstone
    ? `DELETE FROM mart.review_article_serving_v4
        WHERE ${rowPredicate}`
    : `UPDATE mart.review_article_serving_v4
        SET
          article_external_id = ${getSqlLiteral(row.articleExternalId)},
          article_created_at = ${getSqlLiteral(row.articleCreatedAt)},
          article_updated_at = ${getSqlLiteral(row.articleUpdatedAt)},
          article_title = ${getSqlLiteral(row.articleTitle)},
          arxiv_id = ${getSqlLiteral(row.arxivId)},
          biorxiv_id = ${getSqlLiteral(row.biorxivId)},
          medrxiv_id = ${getSqlLiteral(row.medrxivId)},
          doi = ${getSqlLiteral(row.doi)},
          pmid = ${getSqlLiteral(row.pmid)},
          full_text_pdf = ${getSqlLiteral(row.fullTextPdf)},
          full_text_fetched_at = ${getSqlLiteral(row.fullTextFetchedAt)},
          full_text_conversion_status = ${getSqlLiteral(row.fullTextConversionStatus)},
          activity_sort_at = ${getSqlLiteral(row.activitySortAt)},
          sort_key = ${getSqlLiteral(row.sortKey)},
          url = ${getSqlLiteral(row.url)},
          serving_updated_at = current_timestamp
        WHERE ${rowPredicate}`
}

export const getReviewServingPayloadPatchManifest = (
  input: ReviewServingPayloadPatchManifestInput,
  projectionComponent: 'display' | 'payload',
): ReviewServingProjectionIdentityManifestInput => {
  const claims = input.claims
  const patchWatermark = getPatchWatermark(claims)

  return {
    baseGeneration: input.baseGeneration,
    definitionVersion: input.definitionVersion,
    inputDigest: getClaimKinds(claims),
    inputWatermark: patchWatermark,
    inputWatermarks: getReviewServingSourcePartitionWatermarks(claims),
    invalidationReason: getClaimKinds(claims),
    patchRangeEnd: patchWatermark,
    patchRangeStart: getPatchRangeStart(claims),
    patchWatermark,
    projectId: input.projectId,
    projectionComponent,
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

const getPayloadProjectionManifests = (
  input: ProjectReviewServingPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  return claims.length === 0
    || input.acknowledgeClaims === false
    || input.definitionVersion === undefined
    || input.projectionIdentity === undefined
    ? []
    : [
        getReviewServingPayloadPatchManifest(
          {
            baseGeneration: input.baseGeneration,
            claims,
            definitionVersion: input.definitionVersion,
            projectId: input.projectId,
            projectionIdentity: input.projectionIdentity,
            status: input.status,
          },
          'payload',
        ),
      ]
}

export const projectReviewServingDisplayBaseRows = async (
  input: ProjectReviewServingDisplayBaseInput,
  database: ReviewServingDisplayPayloadProjectorDatabase = getAppDatabaseService(),
) => {
  const rows = await getDisplayBaseRows(input, database)
  const rowCount = rows.length * input.listModeKeys.length

  await writeReviewServingProjectorComponent(
    {
      component: 'display',
      statements: [
        `DELETE FROM mart.review_article_serving_v4
          WHERE project_id = ${getSqlLiteral(input.projectId)}
            AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND ${getListModeKeyPredicate(input.listModeKeys)}
            ${getServingArticleRangePredicate(input)}`,
        input.listModeKeys.length === 0 ? null : getInsertDisplayBaseRowsStatement(input),
      ].flatMap((statement) => {
        return statement === null ? [] : [statement]
      }),
    },
    database,
  )

  return {rowCount}
}

export const projectReviewServingDisplayPatches = async (
  input: ProjectReviewServingDisplayPatchInput,
  database: ReviewServingDisplayPayloadProjectorDatabase = getAppDatabaseService(),
) => {
  const rows = await getDisplayPatchRows(input, database)
  const patchWatermark = getPatchWatermark(input.claims)

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.acknowledgeClaims === false ? [] : input.claims,
      component: 'display',
      projectionManifests: input.claims.length === 0 ? [] : [getReviewServingPayloadPatchManifest(input, 'display')],
      records: rows.map((row) => {
        return getDisplayPatchRecord(input, row)
      }),
      statements: rows.map((row) => {
        return getApplyDisplayPatchServingStatement(input, row)
      }),
      watermark:
        input.claims.length === 0
          ? undefined
          : {
              projectId: input.projectId,
              projectionComponent: 'display',
              projectorName: displayProjectorName,
              sourceHighWaterMark: patchWatermark,
              sourcePartition: getClaimSourcePartition(input.claims),
            },
    },
    database,
  )

  return {patchRowCount: rows.length, patchWatermark}
}

export const projectReviewServingPayloadRows = async (
  input: ProjectReviewServingPayloadInput,
  database: ReviewServingDisplayPayloadProjectorDatabase = getAppDatabaseService(),
) => {
  const claims = input.claims ?? []
  const rows = await getPayloadRows(input, database)
  const hasClaimedWork =
    claims.length > 0 && input.definitionVersion !== undefined && input.projectionIdentity !== undefined
  const shouldAcknowledgeClaims = hasClaimedWork && input.acknowledgeClaims !== false
  const projectionManifests = getPayloadProjectionManifests(input, claims)
  const patchWatermark = getPatchWatermark(claims)

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: shouldAcknowledgeClaims ? claims : [],
      component: 'payload',
      projectionManifests,
      records: rows.map((row) => {
        return getPayloadRecord(input, row)
      }),
      statements: [getDeletePayloadRowsStatement(input)].flatMap((statement) => {
        return statement === null ? [] : [statement]
      }),
      watermark: shouldAcknowledgeClaims
        ? {
            projectId: input.projectId,
            projectionComponent: 'payload',
            projectorName: payloadProjectorName,
            sourceHighWaterMark: patchWatermark,
            sourcePartition: getClaimSourcePartition(claims),
          }
        : undefined,
    },
    database,
  )

  return {payloadRowCount: rows.length, patchWatermark}
}

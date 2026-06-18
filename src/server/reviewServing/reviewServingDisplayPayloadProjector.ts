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
  claims?: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion?: string
  displayIdentity: string
  payloadIdentity: string
  projectId: string
  projectionIdentity?: string
  snapshotId: string
  status?: ReviewServingProjectionManifestStatus
}

type DisplayProjectionRow = {
  activitySortAt: Date | string
  articleExternalId: string | null
  articleId: string
  articleTitle: string
  conflictFlag: boolean | null
  duplicateFlag: boolean | null
  fullTextPdf: string | null
  journalTitle: string | null
  publicationYear: number | null
  selectedImportRouteId: string | null
  selectedRankKey: string | null
  sortKey: Date | string
  url: string | null
}

type DisplayPatchRow = {
  activitySortAt: Date | string | null
  articleExternalId: string | null
  articleId: string
  articleTitle: string | null
  fullTextPdf: string | null
  journalTitle: string | null
  publicationYear: number | null
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

const getDisplayBaseRows = async (
  input: ProjectReviewServingDisplayBaseInput,
  database: ReviewServingDisplayPayloadProjectorDatabase,
) => {
  return database.queryJson<DisplayProjectionRow>(`
    SELECT
      scope.article_id AS articleId,
      COALESCE(article.article_created_at, scope.article_created_at, current_timestamp) AS sortKey,
      COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at, current_timestamp) AS activitySortAt,
      article.article_title AS articleTitle,
      article.article_id AS articleExternalId,
      selected.journal_title AS journalTitle,
      article.url,
      article.full_text_pdf AS fullTextPdf,
      selected.import_route_id AS selectedImportRouteId,
      selected.selected_rank_key AS selectedRankKey,
      selected.publication_year AS publicationYear,
      selected.duplicate_flag AS duplicateFlag,
      selected.conflict_flag AS conflictFlag
    FROM mart.project_scope_article scope
    INNER JOIN app."article" article
      ON article.id = scope.article_id
    LEFT JOIN app.review_selected_article_import_v4 selected
      ON selected.project_id = scope.project_id
      AND selected.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected.article_id = scope.article_id
      AND NOT selected.tombstone
    WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
      AND (scope.in_curated_scope OR scope.in_route_scope)
    ORDER BY scope.article_id ASC
  `)
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
          COALESCE(article.article_created_at, current_timestamp) AS sortKey,
          COALESCE(article.article_updated_at, article.article_created_at, current_timestamp) AS activitySortAt,
          article.article_title AS articleTitle,
          article.article_id AS articleExternalId,
          article.full_text_pdf AS fullTextPdf,
          selected.journal_title AS journalTitle,
          article.url,
          selected.publication_year AS publicationYear,
          article.id IS NULL AS tombstone
        FROM dirty_article dirty
        LEFT JOIN app."article" article
          ON article.id = dirty.article_id
        LEFT JOIN app.review_selected_article_import_v4 selected
          ON selected.project_id = ${getSqlLiteral(input.projectId)}
          AND selected.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
          AND selected.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
          AND selected.article_id = dirty.article_id
          AND NOT selected.tombstone
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
      article.source_metadata AS sourceMetadata,
      LEFT(article.article_summary, 2000) AS abstractText,
      LEFT(COALESCE(article.full_text, regexp_replace(COALESCE(article.full_text_html, ''), '<[^>]+>', '', 'g')), 2000) AS fullTextPreview,
      CAST(
        length(COALESCE(article.article_summary, ''))
        + length(COALESCE(article.full_text, ''))
        + length(COALESCE(article.full_text_html, ''))
        + length(COALESCE(CAST(article.source_metadata AS VARCHAR), ''))
        AS BIGINT
      ) AS payloadBytes
    FROM mart.project_scope_article scope
    ${dirtyJoinSql}
    INNER JOIN app."article" article
      ON article.id = scope.article_id
    WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
      AND (scope.in_curated_scope OR scope.in_route_scope)
    ORDER BY article.article_created_at ASC NULLS LAST, scope.article_id ASC
  `)
}

const getDisplayBaseRecord = (
  input: ProjectReviewServingDisplayBaseInput,
  row: DisplayProjectionRow,
  listModeKey: string,
): ReviewServingProjectorRecord => {
  return {
    keyColumns: ['project_id', 'review_config_hash', 'snapshot_id', 'list_mode_key', 'article_id'],
    table: 'mart.review_article_serving_v4',
    values: {
      activity_sort_at: row.activitySortAt,
      article_external_id: row.articleExternalId,
      article_id: row.articleId,
      article_title: row.articleTitle,
      base_generation: input.baseGeneration,
      conflict_flag: row.conflictFlag ?? false,
      display_identity: input.displayIdentity,
      duplicate_flag: row.duplicateFlag ?? false,
      enabled_prompt_count: 0,
      full_text_pdf: row.fullTextPdf,
      human_answered_prompt_count: 0,
      human_status_identity: input.humanStatusIdentity,
      journal_title: row.journalTitle,
      list_mode_key: listModeKey,
      llm_judged_prompt_count: 0,
      llm_status_identity: input.llmStatusIdentity,
      patch_watermark: 0,
      payload_identity: input.payloadIdentity,
      posting_identity: input.postingIdentity,
      project_id: input.projectId,
      project_scope_identity: input.projectScopeIdentity,
      publication_year: row.publicationYear,
      review_config_hash: input.reviewConfigHash,
      review_opened: false,
      review_sections_completed: 0,
      selected_import_identity: input.selectedImportIdentity,
      selected_import_route_id: row.selectedImportRouteId,
      selected_rank_key: row.selectedRankKey,
      serving_updated_at: new Date(),
      snapshot_id: input.snapshotId,
      sort_key: row.sortKey,
      summary_identity: input.summaryIdentity,
      url: row.url,
    },
  }
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
      article_id: row.articleId,
      article_title: row.tombstone ? null : row.articleTitle,
      activity_sort_at: row.tombstone ? null : row.activitySortAt,
      base_generation: input.baseGeneration,
      display_identity: input.displayIdentity,
      journal_title: row.tombstone ? null : row.journalTitle,
      patch_updated_at: new Date(),
      patch_watermark: getPatchWatermark(input.claims),
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
          article_title = ${getSqlLiteral(row.articleTitle)},
          full_text_pdf = ${getSqlLiteral(row.fullTextPdf)},
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
  const records = rows.flatMap((row) => {
    return input.listModeKeys.map((listModeKey) => {
      return getDisplayBaseRecord(input, row, listModeKey)
    })
  })

  await writeReviewServingProjectorComponent({component: 'display', records}, database)

  return {rowCount: records.length}
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

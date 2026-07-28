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
  type ReviewServingProjectorWriterDiagnostics,
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

export type ProjectReviewServingDisplayBaseRangesInput = {ranges: readonly ProjectReviewServingDisplayBaseInput[]}

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
  duplicateFlag: boolean | null
  journalTitle: string | null
  medrxivId: string | null
  pmid: string | null
  publicationYear: number | null
  selectedImportRouteId: string | null
  selectedRankKey: string | null
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
  journalTitle: string | null
  medrxivId: string | null
  pmid: string | null
  publicationYear: number | null
  sortKey: Date | string | null
  tombstone: boolean
  url: string | null
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

const getProjectorDiagnosticsJson = (input: {
  phaseTimings: Record<string, number>
  projectorName: string
  sourceRowCount?: number
  writer: ReviewServingProjectorWriterDiagnostics
}) => {
  return {
    phaseTimings: input.phaseTimings,
    [input.projectorName]: {sourceRowCount: input.sourceRowCount, writer: input.writer},
  }
}

const withDiagnosticsJson = <T extends object>(result: T, diagnosticsJson: unknown): T => {
  return Object.defineProperty(result, 'diagnosticsJson', {enumerable: false, value: diagnosticsJson})
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

const getDisplayBaseRowsSql = (input: ProjectReviewServingDisplayBaseInput, options: {orderBy?: boolean} = {}) => {
  const orderBy = options.orderBy === false ? '' : 'ORDER BY scope.article_id ASC'
  const selectedImportRouteIdSql = `CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_base.import_route_id
      END`
  const selectedSourceRecordKeySql = `CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_base.source_record_key
      END`

  return `
    SELECT
      scope.article_id AS articleId,
      article.article_created_at AS articleCreatedAt,
      article.article_updated_at AS articleUpdatedAt,
      COALESCE(article.article_created_at, scope.article_created_at, current_timestamp) AS sortKey,
      COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at, current_timestamp) AS activitySortAt,
      COALESCE(
        CASE
          WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
          ELSE selected_hot.article_title
        END,
        article.article_title
      ) AS articleTitle,
      COALESCE(
        CASE
          WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
          ELSE selected_hot.external_id
        END,
        article.article_id
      ) AS articleExternalId,
      article.arxiv_id AS arxivId,
      article.biorxiv_id AS biorxivId,
      article.medrxiv_id AS medrxivId,
      article.doi,
      article.pubmed_id AS pmid,
      CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_hot.journal_title
      END AS journalTitle,
      COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url,
      CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_base.import_route_id
      END AS selectedImportRouteId,
      CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_base.selected_rank_key
      END AS selectedRankKey,
      CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE selected_hot.publication_year
      END AS publicationYear,
      CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE COALESCE(selected_hot.duplicate_flag, FALSE)
      END AS duplicateFlag,
      CASE
        WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
        ELSE COALESCE(selected_hot.conflict_flag, FALSE)
      END AS conflictFlag
    FROM mart.project_scope_article scope
    INNER JOIN app."article" article
      ON article.id = scope.article_id
    LEFT JOIN app.review_selected_article_import_v4 selected_base
      ON selected_base.project_id = scope.project_id
      AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
      AND selected_base.article_id = scope.article_id
    LEFT JOIN app.review_import_article_hot_field selected_hot
      ON selected_hot.import_route_id = ${selectedImportRouteIdSql}
      AND selected_hot.article_id = scope.article_id
      AND selected_hot.source_record_key = ${selectedSourceRecordKeySql}
      AND NOT selected_hot.tombstone
    LEFT JOIN app.article_import_route_source_record selected_source
      ON selected_source.import_route_id = ${selectedImportRouteIdSql}
      AND selected_source.article_id = scope.article_id
      AND selected_source.source_record_key = ${selectedSourceRecordKeySql}
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

const getHasListModeSql = (listModeKeys: readonly string[], listModeKey: string) => {
  return listModeKeys.includes(listModeKey) ? 'TRUE' : 'FALSE'
}

const getInsertDisplayBaseRowsStatements = (input: ProjectReviewServingDisplayBaseInput) => {
  return `
    INSERT INTO mart.review_article_serving_base_v4 (
      activity_sort_at,
      article_created_at,
      article_id,
      base_generation,
      patch_watermark,
      project_id,
      review_config_hash,
      snapshot_id,
      sort_key
    )
    WITH display_base AS (
      ${getDisplayBaseRowsSql(input, {orderBy: false})}
    )
    SELECT
      display_base.activitySortAt AS activity_sort_at,
      display_base.articleCreatedAt AS article_created_at,
      display_base.articleId AS article_id,
      ${getSqlLiteral(input.baseGeneration)} AS base_generation,
      0 AS patch_watermark,
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      display_base.sortKey AS sort_key
    FROM display_base
    WHERE NOT EXISTS (
      SELECT 1
      FROM mart.review_article_serving_base_v4 existing
      WHERE existing.project_id = ${getSqlLiteral(input.projectId)}
        AND existing.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
        AND existing.snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND existing.article_id = display_base.articleId
    )
    ORDER BY display_base.articleId ASC
  `.trim()
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
          COALESCE(CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_hot.article_title END, article.article_title) AS articleTitle,
          COALESCE(CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_hot.external_id END, article.article_id) AS articleExternalId,
          article.arxiv_id AS arxivId,
          article.biorxiv_id AS biorxivId,
          article.medrxiv_id AS medrxivId,
          article.doi,
          article.pubmed_id AS pmid,
          CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_hot.journal_title END AS journalTitle,
          COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url,
          CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_hot.publication_year END AS publicationYear,
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
        LEFT JOIN app.review_import_article_hot_field selected_hot
          ON selected_hot.import_route_id = CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_base.import_route_id END
          AND selected_hot.article_id = dirty.article_id
          AND selected_hot.source_record_key = CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_base.source_record_key END
          AND NOT selected_hot.tombstone
        LEFT JOIN app.article_import_route_source_record selected_source
          ON selected_source.import_route_id = CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_base.import_route_id END
          AND selected_source.article_id = dirty.article_id
          AND selected_source.source_record_key = CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_base.source_record_key END
          AND selected_source.quarantined_at IS NULL
        ORDER BY dirty.article_id ASC
      `)
}

const getInsertDisplayListModeStateRowsStatement = (input: ProjectReviewServingDisplayBaseInput) => {
  return `
    INSERT INTO mart.review_article_serving_list_mode_state_v4 (
      article_id,
      both_patch_watermark,
      has_both_list_mode,
      has_human_list_mode,
      has_llm_list_mode,
      has_unassessed_list_mode,
      human_patch_watermark,
      llm_patch_watermark,
      project_id,
      review_config_hash,
      snapshot_id,
      unassessed_patch_watermark
    )
    WITH display_base AS (
      ${getDisplayBaseRowsSql(input, {orderBy: false})}
    )
    SELECT
      display_base.articleId AS article_id,
      0 AS both_patch_watermark,
      ${getHasListModeSql(input.listModeKeys, 'both')} AS has_both_list_mode,
      ${getHasListModeSql(input.listModeKeys, 'human')} AS has_human_list_mode,
      ${getHasListModeSql(input.listModeKeys, 'llm')} AS has_llm_list_mode,
      ${getHasListModeSql(input.listModeKeys, 'unassessed')} AS has_unassessed_list_mode,
      0 AS human_patch_watermark,
      0 AS llm_patch_watermark,
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      0 AS unassessed_patch_watermark
    FROM display_base
    WHERE NOT EXISTS (
      SELECT 1
      FROM mart.review_article_serving_list_mode_state_v4 existing
      WHERE existing.project_id = ${getSqlLiteral(input.projectId)}
        AND existing.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
        AND existing.snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND existing.article_id = display_base.articleId
    )
    ORDER BY display_base.articleId ASC
  `.trim()
}

const getApplyDisplayPatchServingStatements = (input: ProjectReviewServingDisplayPatchInput, row: DisplayPatchRow) => {
  const rowPredicate = `project_id = ${getSqlLiteral(input.projectId)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND base_generation = ${getSqlLiteral(input.baseGeneration)}
          AND article_id = ${getSqlLiteral(row.articleId)}`

  return row.tombstone
    ? [
        `DELETE FROM mart.review_article_serving_base_v4
        WHERE ${rowPredicate}`,
        `DELETE FROM mart.review_article_serving_list_mode_state_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND article_id = ${getSqlLiteral(row.articleId)}`,
      ]
    : [
        `UPDATE mart.review_article_serving_base_v4
        SET
          article_created_at = ${getSqlLiteral(row.articleCreatedAt)},
          activity_sort_at = ${getSqlLiteral(row.activitySortAt)},
          sort_key = ${getSqlLiteral(row.sortKey)}
        WHERE ${rowPredicate}`,
      ]
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

export const projectReviewServingDisplayBaseRows = async (
  input: ProjectReviewServingDisplayBaseInput,
  database: ReviewServingDisplayPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingDisplayPayloadProjectorDatabase,
) => {
  const {measure, measureSync, phaseTimings} = getTimedProjector()
  const rows = await measure('sourceQueryMs', async () => {
    return getDisplayBaseRows(input, database)
  })
  const rowCount = measureSync('recordTransformMs', () => {
    return rows.length * input.listModeKeys.length
  })

  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {component: 'display', statements: getDisplayBaseRowsStatements(input)},
      database,
    )
  })

  return withDiagnosticsJson(
    {rowCount},
    getProjectorDiagnosticsJson({
      phaseTimings,
      projectorName: 'displayProjector',
      sourceRowCount: rows.length,
      writer: writer.diagnostics,
    }),
  )
}

const getDisplayBaseRowsStatements = (input: ProjectReviewServingDisplayBaseInput) => {
  return input.listModeKeys.length === 0
    ? []
    : [getInsertDisplayBaseRowsStatements(input), getInsertDisplayListModeStateRowsStatement(input)]
}

export const projectReviewServingDisplayBaseRanges = async (
  input: ProjectReviewServingDisplayBaseRangesInput,
  database: ReviewServingDisplayPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingDisplayPayloadProjectorDatabase,
) => {
  const {measure, phaseTimings} = getTimedProjector()
  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        component: 'display',
        statements: input.ranges.flatMap((range) => {
          return getDisplayBaseRowsStatements(range)
        }),
      },
      database,
    )
  })

  return withDiagnosticsJson(
    {rangeCount: input.ranges.length},
    getProjectorDiagnosticsJson({phaseTimings, projectorName: 'displayProjector', writer: writer.diagnostics}),
  )
}

export const projectReviewServingDisplayPatches = async (
  input: ProjectReviewServingDisplayPatchInput,
  database: ReviewServingDisplayPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingDisplayPayloadProjectorDatabase,
) => {
  const {measure, measureSync, phaseTimings} = getTimedProjector()
  const rows = await measure('sourceQueryMs', async () => {
    return getDisplayPatchRows(input, database)
  })
  const patchWatermark = getPatchWatermark(input.claims)
  const shouldAcknowledgeClaims = input.claims.length > 0 && input.acknowledgeClaims !== false
  const statements = measureSync('recordTransformMs', () => {
    return rows.flatMap((row) => {
      return getApplyDisplayPatchServingStatements(input, row)
    })
  })

  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: shouldAcknowledgeClaims ? input.claims : [],
        component: 'display',
        projectionManifests: shouldAcknowledgeClaims ? [getReviewServingPayloadPatchManifest(input, 'display')] : [],
        records: [],
        statements,
        watermark: !shouldAcknowledgeClaims
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
  })

  return withDiagnosticsJson(
    {patchRowCount: 0, patchWatermark},
    getProjectorDiagnosticsJson({
      phaseTimings,
      projectorName: 'displayProjector',
      sourceRowCount: rows.length,
      writer: writer.diagnostics,
    }),
  )
}

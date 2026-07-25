import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingProjectionManifestStatus,
} from './reviewServingManifestRepository.ts'
import {getReviewServingSourcePartitionWatermarks} from './reviewServingProjectorDomain.ts'
import {
  type ReviewServingProjectorRecord,
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

export type ProjectReviewServingPayloadRangesInput = {ranges: readonly ProjectReviewServingPayloadInput[]}

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

type PayloadProjectionRow = {articleId: string}

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

const getArticleRangeFilterCte = (ranges: readonly ProjectReviewServingPayloadInput[]) => {
  return `article_range_filter(chunk_start_article_id, chunk_end_article_id) AS (
        SELECT * FROM (VALUES ${ranges
          .map((range) => {
            return `(${getSqlLiteral(range.chunkStartArticleId)}, ${getSqlLiteral(range.chunkEndArticleId)})`
          })
          .join(', ')})
      )`
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
      article_id,
      base_generation,
      list_mode_key,
      patch_watermark,
      project_id,
      review_config_hash,
      snapshot_id,
      sort_key
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
      display_base.articleId AS article_id,
      ${getSqlLiteral(input.baseGeneration)} AS base_generation,
      list_mode.list_mode_key,
      0 AS patch_watermark,
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      display_base.sortKey AS sort_key
    FROM display_base
    CROSS JOIN list_mode
    ORDER BY display_base.articleId ASC, list_mode.list_mode_key ASC
    ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, article_id) DO NOTHING
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

const getPayloadRowsSql = (
  input: ProjectReviewServingPayloadInput,
  options: {orderBy?: boolean; ranges?: readonly ProjectReviewServingPayloadInput[]} = {},
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const dirtyJoinSql =
    articleIds.length === 0 ? '' : 'INNER JOIN dirty_article dirty ON dirty.article_id = scope.article_id'
  const rangeJoinSql =
    options.ranges === undefined
      ? ''
      : `INNER JOIN article_range_filter range
        ON scope.article_id >= range.chunk_start_article_id
        AND scope.article_id <= range.chunk_end_article_id`
  const orderBy =
    options.orderBy === false ? '' : 'ORDER BY scope.article_created_at ASC NULLS LAST, scope.article_id ASC'
  return `
    ${getDirtyArticleCteSql(articleIds)}
    SELECT
      scope.article_id AS articleId
    FROM mart.project_scope_article scope
    ${dirtyJoinSql}
    ${rangeJoinSql}
    WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
      AND (scope.in_curated_scope OR scope.in_route_scope)
      ${options.ranges === undefined ? getArticleRangePredicate(input) : ''}
    ${orderBy}
  `
}

const getPayloadRows = async (
  input: ProjectReviewServingPayloadInput,
  database: ReviewServingDisplayPayloadProjectorDatabase,
) => {
  return database.queryJson<PayloadProjectionRow>(getPayloadRowsSql(input))
}

const getPayloadRecord = (
  input: ProjectReviewServingPayloadInput,
  row: PayloadProjectionRow,
): ReviewServingProjectorRecord => {
  return {
    keyColumns: ['project_id', 'display_identity', 'payload_identity', 'snapshot_id', 'article_id'],
    table: 'mart.review_article_serving_payload_v4',
    values: {
      article_id: row.articleId,
      display_identity: input.displayIdentity,
      payload_identity: input.payloadIdentity,
      project_id: input.projectId,
      snapshot_id: input.snapshotId,
    },
  }
}

const getPayloadRebuildRowsStatements = (
  input: ProjectReviewServingPayloadInput,
  ranges?: readonly ProjectReviewServingPayloadInput[],
) => {
  return [
    `
    INSERT INTO mart.review_article_serving_payload_v4 (
      article_id,
      display_identity,
      payload_identity,
      project_id,
      snapshot_id
    )
    WITH ${
      ranges === undefined
        ? 'payload_source AS'
        : `${getArticleRangeFilterCte(ranges)},
    payload_source AS`
    } (
      ${getPayloadRowsSql(input, {orderBy: false, ranges})}
    ),
    payload_rows AS (
      SELECT
        payload_source.articleId AS article_id,
        ${getSqlLiteral(input.displayIdentity)} AS display_identity,
        ${getSqlLiteral(input.payloadIdentity)} AS payload_identity,
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id
      FROM payload_source
    )
    SELECT
      article_id,
      display_identity,
      payload_identity,
      project_id,
      snapshot_id
    FROM payload_rows
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY project_id, display_identity, payload_identity, snapshot_id, article_id
      ORDER BY article_id ASC
    ) = 1
    ON CONFLICT(project_id, display_identity, payload_identity, snapshot_id, article_id) DO NOTHING
  `,
  ]
}

const canUseSetBasedPayloadRangeInsert = (ranges: readonly ProjectReviewServingPayloadInput[]) => {
  const [firstRange] = ranges

  return (
    firstRange !== undefined
    && ranges.every((range) => {
      return (
        (range.claims === undefined || range.claims.length === 0)
        && range.chunkEndArticleId !== null
        && range.chunkEndArticleId !== undefined
        && range.chunkStartArticleId !== null
        && range.chunkStartArticleId !== undefined
        && range.displayIdentity === firstRange.displayIdentity
        && range.payloadIdentity === firstRange.payloadIdentity
        && range.projectId === firstRange.projectId
        && range.selectedImportSnapshotId === firstRange.selectedImportSnapshotId
        && range.snapshotId === firstRange.snapshotId
      )
    })
  )
}

const getApplyDisplayPatchServingStatement = (input: ProjectReviewServingDisplayPatchInput, row: DisplayPatchRow) => {
  const rowPredicate = `project_id = ${getSqlLiteral(input.projectId)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND base_generation = ${getSqlLiteral(input.baseGeneration)}
          AND article_id = ${getSqlLiteral(row.articleId)}`

  return row.tombstone
    ? `DELETE FROM mart.review_article_serving_v4
        WHERE ${rowPredicate}`
    : `UPDATE mart.review_article_serving_v4
        SET
          article_created_at = ${getSqlLiteral(row.articleCreatedAt)},
          activity_sort_at = ${getSqlLiteral(row.activitySortAt)},
          sort_key = ${getSqlLiteral(row.sortKey)}
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
  return [input.listModeKeys.length === 0 ? null : getInsertDisplayBaseRowsStatement(input)].flatMap((statement) => {
    return statement === null ? [] : [statement]
  })
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

export const projectReviewServingPayloadRanges = async (
  input: ProjectReviewServingPayloadRangesInput,
  database: ReviewServingDisplayPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingDisplayPayloadProjectorDatabase,
) => {
  const {measure, phaseTimings} = getTimedProjector()
  const writer = await measure('writerMs', async () => {
    const [firstRange] = input.ranges
    const statements =
      firstRange !== undefined && canUseSetBasedPayloadRangeInsert(input.ranges)
        ? getPayloadRebuildRowsStatements(firstRange, input.ranges)
        : input.ranges.flatMap((range) => {
            return getPayloadRebuildRowsStatements(range)
          })

    return writeReviewServingProjectorComponent({component: 'payload', statements}, database)
  })

  return withDiagnosticsJson(
    {rangeCount: input.ranges.length},
    getProjectorDiagnosticsJson({phaseTimings, projectorName: 'payloadProjector', writer: writer.diagnostics}),
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
    return rows.map((row) => {
      return getApplyDisplayPatchServingStatement(input, row)
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

export const projectReviewServingPayloadRows = async (
  input: ProjectReviewServingPayloadInput,
  database: ReviewServingDisplayPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingDisplayPayloadProjectorDatabase,
) => {
  const {measure, measureSync, phaseTimings} = getTimedProjector()
  const claims = input.claims ?? []
  const rows = await measure('sourceQueryMs', async () => {
    return getPayloadRows(input, database)
  })
  const hasClaimedWork =
    claims.length > 0 && input.definitionVersion !== undefined && input.projectionIdentity !== undefined
  const shouldAcknowledgeClaims = hasClaimedWork && input.acknowledgeClaims !== false
  const projectionManifests = getPayloadProjectionManifests(input, claims)
  const patchWatermark = getPatchWatermark(claims)
  const records = measureSync('recordTransformMs', () => {
    return rows.map((row) => {
      return getPayloadRecord(input, row)
    })
  })

  const writer = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: shouldAcknowledgeClaims ? claims : [],
        component: 'payload',
        projectionManifests,
        records,
        statements: [],
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
  })

  return withDiagnosticsJson(
    {patchWatermark, payloadRowCount: rows.length},
    getProjectorDiagnosticsJson({
      phaseTimings,
      projectorName: 'payloadProjector',
      sourceRowCount: rows.length,
      writer: writer.diagnostics,
    }),
  )
}

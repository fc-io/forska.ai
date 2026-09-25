import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'

export type ReviewServingSummaryLedgerStatus = 'building' | 'published'

export type ReviewServingSummaryLedgerBucket = {
  bucketId: string
  effectiveEndKey: string | null
  effectiveStartKey: string | null
  ledgerStatus: ReviewServingSummaryLedgerStatus
}

export type ReviewServingSummaryLedgerSnapshotScope = {projectId: string; reviewConfigHash: string; snapshotId: string}

export type ReviewServingSummaryLedgerSnapshotPatch = ReviewServingSummaryLedgerSnapshotScope & {
  buckets: readonly ReviewServingSummaryLedgerBucket[]
}

type ReviewServingSummaryLedgerDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

type SummaryLedgerPlanAction = 'ack' | 'defer' | 'patch'

type SummaryLedgerPlanRow = {
  action: SummaryLedgerPlanAction
  articleId: string
  bucketId: string
  effectiveEndKey: string | null
  effectiveStartKey: string | null
  ledgerStatus: ReviewServingSummaryLedgerStatus
}

export const reviewServingSummaryBucketTable = 'mart.review_article_summary_bucket_v4'
export const reviewServingSummaryBucketPartialTable = 'mart.review_article_summary_bucket_partial_v4'

const inFlightRebuildRequestPredicateSql =
  "request.status IN ('admitted', 'running') AND request.admission_state = 'admitted'"

const summaryLedgerKeyColumns = [
  'summary_kind',
  'summary_identity',
  'list_mode_key',
  'count_kind',
  'summary_definition_version',
  'filter_key',
  'facet_kind',
  'facet_key',
  'facet_value',
] as const

const summaryLedgerPartialColumns = [
  ...summaryLedgerKeyColumns,
  'prompt_id',
  'answer_id',
  'answer_value',
  'availability',
  'stale_reason',
  'count_value',
] as const

export const getReviewServingSummaryLedgerScopePredicate = (
  input: ReviewServingSummaryLedgerSnapshotScope & {alias?: string},
) => {
  const qualifier = input.alias === undefined ? '' : `${input.alias}.`

  return `${qualifier}project_id = ${getSqlLiteral(input.projectId)}
    AND ${qualifier}review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
    AND ${qualifier}snapshot_id = ${getSqlLiteral(input.snapshotId)}`
}

const getBucketIdListSql = (bucketIds: readonly string[]) => {
  return bucketIds.map(getSqlLiteral).join(', ')
}

// A rebuild chunk records its range as one bucket of the snapshot's ledger. A retried chunk replaces its own bucket
// and keeps the bucket's status, so it never demotes a published ledger.
export const getWriteReviewServingSummaryLedgerChunkStatements = (
  input: ReviewServingSummaryLedgerSnapshotScope & {
    chunkEndKey: string | null
    chunkId: string
    chunkStartKey: string | null
    requestId: string
    sourceTable: string
  },
) => {
  const scopePredicate = getReviewServingSummaryLedgerScopePredicate(input)
  const bucketPredicate = `${scopePredicate}
      AND bucket_id = ${getSqlLiteral(input.chunkId)}`

  return `
    DELETE FROM ${reviewServingSummaryBucketPartialTable}
    WHERE ${bucketPredicate};

    INSERT INTO ${reviewServingSummaryBucketPartialTable} (
      project_id,
      review_config_hash,
      snapshot_id,
      bucket_id,
      ${summaryLedgerPartialColumns.join(',\n      ')},
      partial_updated_at
    )
    SELECT
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.reviewConfigHash)},
      ${getSqlLiteral(input.snapshotId)},
      ${getSqlLiteral(input.chunkId)},
      ${summaryLedgerPartialColumns.join(',\n      ')},
      current_timestamp
    FROM ${input.sourceTable};

    UPDATE ${reviewServingSummaryBucketTable}
    SET
      request_id = ${getSqlLiteral(input.requestId)},
      bucket_start_key = ${getSqlLiteral(input.chunkStartKey)},
      bucket_end_key = ${getSqlLiteral(input.chunkEndKey)},
      bucket_updated_at = current_timestamp
    WHERE ${bucketPredicate};

    INSERT INTO ${reviewServingSummaryBucketTable} (
      project_id,
      review_config_hash,
      snapshot_id,
      bucket_id,
      request_id,
      bucket_start_key,
      bucket_end_key,
      ledger_status,
      bucket_updated_at
    )
    SELECT
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.reviewConfigHash)},
      ${getSqlLiteral(input.snapshotId)},
      ${getSqlLiteral(input.chunkId)},
      ${getSqlLiteral(input.requestId)},
      ${getSqlLiteral(input.chunkStartKey)},
      ${getSqlLiteral(input.chunkEndKey)},
      'building',
      current_timestamp
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${reviewServingSummaryBucketTable}
      WHERE ${bucketPredicate}
    );
  `
}

const getDeleteLedgerBucketsStatements = (
  input: ReviewServingSummaryLedgerSnapshotScope & {bucketPredicateSql: string},
) => {
  const scopePredicate = getReviewServingSummaryLedgerScopePredicate(input)

  return [
    `
      DELETE FROM ${reviewServingSummaryBucketPartialTable}
      WHERE ${scopePredicate}
        AND bucket_id IN (
          SELECT bucket.bucket_id
          FROM ${reviewServingSummaryBucketTable} bucket
          WHERE ${getReviewServingSummaryLedgerScopePredicate({...input, alias: 'bucket'})}
            AND (${input.bucketPredicateSql})
        )
    `,
    `
      DELETE FROM ${reviewServingSummaryBucketTable} bucket
      WHERE ${getReviewServingSummaryLedgerScopePredicate({...input, alias: 'bucket'})}
        AND (${input.bucketPredicateSql})
    `,
  ]
}

// Serving rows written outside the ledger (direct full rebuilds, accumulator publication) no longer equal the SUM of
// the published buckets, so the published ledger is dropped and the snapshot takes a rebuild for its next patch.
export const getInvalidateReviewServingSummaryLedgerStatements = (
  input: ReviewServingSummaryLedgerSnapshotScope & {requestId?: string | null},
) => {
  const requestPredicate =
    input.requestId === null || input.requestId === undefined
      ? ''
      : ` OR bucket.request_id = ${getSqlLiteral(input.requestId)}`

  return getDeleteLedgerBucketsStatements({
    ...input,
    bucketPredicateSql: `bucket.ledger_status = 'published'${requestPredicate}`,
  })
}

export const getPublishReviewServingSummaryLedgerStatusStatements = (
  input: ReviewServingSummaryLedgerSnapshotScope & {requestId: string},
) => {
  return [
    ...getDeleteLedgerBucketsStatements({
      ...input,
      bucketPredicateSql: `bucket.request_id <> ${getSqlLiteral(input.requestId)}`,
    }),
    `
      UPDATE ${reviewServingSummaryBucketTable}
      SET ledger_status = 'published', bucket_updated_at = current_timestamp
      WHERE ${getReviewServingSummaryLedgerScopePredicate(input)}
        AND request_id = ${getSqlLiteral(input.requestId)}
    `,
  ]
}

const getAffectedKeyJoinSql = (input: {affectedKeyTable?: string; summaryKind: 'count' | 'facet'}) => {
  if (input.affectedKeyTable === undefined) {
    return ''
  }

  return input.summaryKind === 'count'
    ? `INNER JOIN ${input.affectedKeyTable} affected
        ON affected.summary_kind = 'count'
        AND affected.list_mode_key = COALESCE(partial.list_mode_key, 'global')
        AND affected.count_kind = partial.count_kind
        AND affected.summary_definition_version = partial.summary_definition_version
        AND affected.filter_key IS NOT DISTINCT FROM partial.filter_key`
    : `INNER JOIN ${input.affectedKeyTable} affected
        ON affected.summary_kind = 'facet'
        AND affected.summary_identity = partial.summary_identity
        AND affected.facet_kind = partial.facet_kind
        AND affected.facet_key = partial.facet_key
        AND affected.facet_value = partial.facet_value
        AND affected.summary_definition_version = partial.summary_definition_version`
}

const getDeleteServingRowsStatements = (
  input: ReviewServingSummaryLedgerSnapshotScope & {affectedKeyTable?: string},
) => {
  const servingPredicate = getReviewServingSummaryLedgerScopePredicate({...input, alias: 'serving'})

  return input.affectedKeyTable === undefined
    ? [
        `DELETE FROM mart.review_article_count_serving_v4 serving WHERE ${servingPredicate}`,
        `DELETE FROM mart.review_filter_facet_serving_v4 serving WHERE ${servingPredicate}`,
      ]
    : [
        `
          DELETE FROM mart.review_article_count_serving_v4 serving
          USING ${input.affectedKeyTable} affected
          WHERE ${servingPredicate}
            AND affected.summary_kind = 'count'
            AND serving.list_mode_key = affected.list_mode_key
            AND serving.count_kind = affected.count_kind
            AND serving.summary_definition_version = affected.summary_definition_version
            AND serving.filter_key IS NOT DISTINCT FROM affected.filter_key
        `,
        `
          DELETE FROM mart.review_filter_facet_serving_v4 serving
          USING ${input.affectedKeyTable} affected
          WHERE ${servingPredicate}
            AND affected.summary_kind = 'facet'
            AND serving.summary_identity = affected.summary_identity
            AND serving.facet_kind = affected.facet_kind
            AND serving.facet_key = affected.facet_key
            AND serving.facet_value = affected.facet_value
            AND serving.summary_definition_version = affected.summary_definition_version
        `,
      ]
}

const getLedgerPartialSourceSql = (
  input: ReviewServingSummaryLedgerSnapshotScope & {
    affectedKeyTable?: string
    bucketPredicateSql: string
    summaryKind: 'count' | 'facet'
  },
) => {
  return `
    FROM ${reviewServingSummaryBucketPartialTable} partial
    INNER JOIN ${reviewServingSummaryBucketTable} bucket
      ON bucket.project_id = partial.project_id
      AND bucket.review_config_hash = partial.review_config_hash
      AND bucket.snapshot_id = partial.snapshot_id
      AND bucket.bucket_id = partial.bucket_id
    ${getAffectedKeyJoinSql(input)}
    WHERE ${getReviewServingSummaryLedgerScopePredicate({...input, alias: 'partial'})}
      AND partial.summary_kind = ${getSqlLiteral(input.summaryKind)}
      AND (${input.bucketPredicateSql})
  `
}

// Serving counts are the SUM of the ledger's bucket partials: either every key of the snapshot (publication) or only the
// keys a patch touched (affectedKeyTable).
export const getPublishReviewServingSummaryLedgerServingStatements = (
  input: ReviewServingSummaryLedgerSnapshotScope & {affectedKeyTable?: string; bucketPredicateSql: string},
) => {
  return [
    ...getDeleteServingRowsStatements(input),
    `
      INSERT INTO mart.review_article_count_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        list_mode_key,
        count_kind,
        summary_definition_version,
        filter_key,
        count_value,
        availability,
        stale_reason
      )
      SELECT
        partial.project_id,
        partial.review_config_hash,
        partial.snapshot_id,
        ANY_VALUE(partial.summary_identity),
        COALESCE(partial.list_mode_key, 'global'),
        partial.count_kind,
        partial.summary_definition_version,
        partial.filter_key,
        CASE WHEN ANY_VALUE(partial.availability) = 'ready' THEN SUM(COALESCE(partial.count_value, 0)) ELSE NULL END,
        ANY_VALUE(partial.availability),
        ANY_VALUE(partial.stale_reason)
      ${getLedgerPartialSourceSql({...input, summaryKind: 'count'})}
      GROUP BY
        partial.project_id,
        partial.review_config_hash,
        partial.snapshot_id,
        COALESCE(partial.list_mode_key, 'global'),
        partial.count_kind,
        partial.summary_definition_version,
        partial.filter_key
    `,
    `
      INSERT INTO mart.review_filter_facet_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        summary_identity,
        facet_kind,
        facet_key,
        facet_value,
        prompt_id,
        answer_id,
        answer_value,
        summary_definition_version,
        count_value,
        availability
      )
      SELECT
        partial.project_id,
        partial.review_config_hash,
        partial.snapshot_id,
        partial.summary_identity,
        partial.facet_kind,
        partial.facet_key,
        partial.facet_value,
        ANY_VALUE(partial.prompt_id),
        ANY_VALUE(partial.answer_id),
        ANY_VALUE(partial.answer_value),
        partial.summary_definition_version,
        CASE WHEN ANY_VALUE(partial.availability) = 'ready' THEN SUM(COALESCE(partial.count_value, 0)) ELSE NULL END,
        ANY_VALUE(partial.availability)
      ${getLedgerPartialSourceSql({...input, summaryKind: 'facet'})}
      GROUP BY
        partial.project_id,
        partial.review_config_hash,
        partial.snapshot_id,
        partial.summary_identity,
        partial.facet_kind,
        partial.facet_key,
        partial.facet_value,
        partial.summary_definition_version
    `,
  ]
}

export const getCreateReviewServingSummaryLedgerAffectedKeyStatement = (
  input: ReviewServingSummaryLedgerSnapshotScope & {
    affectedKeyTable: string
    bucketIds: readonly string[]
    replacementTable: string
  },
) => {
  const keySelect = `summary_kind, summary_identity, COALESCE(list_mode_key, 'global') AS list_mode_key, count_kind,
        summary_definition_version, filter_key, facet_kind, facet_key, facet_value`
  const bucketIdList = getBucketIdListSql(input.bucketIds)

  return `
    CREATE TEMPORARY TABLE ${input.affectedKeyTable} AS
    SELECT DISTINCT *
    FROM (
      SELECT ${keySelect}
      FROM ${reviewServingSummaryBucketPartialTable}
      WHERE ${getReviewServingSummaryLedgerScopePredicate(input)}
        AND bucket_id IN (${bucketIdList})
      UNION ALL
      SELECT ${keySelect}
      FROM ${input.replacementTable}
      WHERE bucket_id IN (${bucketIdList})
    )
  `
}

export const getReplaceReviewServingSummaryLedgerPartialsStatements = (
  input: ReviewServingSummaryLedgerSnapshotScope & {bucketIds: readonly string[]; replacementTable: string},
) => {
  const scopePredicate = getReviewServingSummaryLedgerScopePredicate(input)

  return [
    `
      DELETE FROM ${reviewServingSummaryBucketPartialTable}
      WHERE ${scopePredicate}
        AND bucket_id IN (${getBucketIdListSql(input.bucketIds)})
    `,
    `
      INSERT INTO ${reviewServingSummaryBucketPartialTable} (
        project_id,
        review_config_hash,
        snapshot_id,
        bucket_id,
        ${summaryLedgerPartialColumns.join(',\n        ')},
        partial_updated_at
      )
      SELECT
        ${getSqlLiteral(input.projectId)},
        ${getSqlLiteral(input.reviewConfigHash)},
        ${getSqlLiteral(input.snapshotId)},
        replacement.bucket_id,
        ${summaryLedgerPartialColumns
          .map((column) => {
            return `replacement.${column}`
          })
          .join(',\n        ')},
        current_timestamp
      FROM ${input.replacementTable} replacement
      INNER JOIN ${reviewServingSummaryBucketTable} bucket
        ON ${getReviewServingSummaryLedgerScopePredicate({...input, alias: 'bucket'})}
        AND bucket.bucket_id = replacement.bucket_id
      WHERE replacement.bucket_id IN (${getBucketIdListSql(input.bucketIds)})
    `,
    `
      UPDATE ${reviewServingSummaryBucketTable}
      SET bucket_updated_at = current_timestamp
      WHERE ${scopePredicate}
        AND bucket_id IN (${getBucketIdListSql(input.bucketIds)})
    `,
  ]
}

// A completed summary chunk of the request without a bucket for the snapshot ran before the ledger existed (or wrote the
// snapshot another way), so the request's buckets do not cover the snapshot. Split parents never write output.
const getLegacyRequestChunkPredicateSql = (input: {chunkAlias: string; snapshotAlias: string}) => {
  return `${input.chunkAlias}.project_id = ${input.snapshotAlias}.project_id
        AND (${input.chunkAlias}.snapshot_id = ${input.snapshotAlias}.snapshot_id OR ${input.chunkAlias}.snapshot_id IS NULL)
        AND ${input.chunkAlias}.projection_component = 'summary'
        AND ${input.chunkAlias}.status = 'completed'
        AND COALESCE(${input.chunkAlias}.checksum, '') NOT LIKE 'split:%'
        AND NOT EXISTS (
          SELECT 1
          FROM ${reviewServingSummaryBucketTable} chunk_bucket
          WHERE chunk_bucket.project_id = ${input.snapshotAlias}.project_id
            AND chunk_bucket.review_config_hash = ${input.snapshotAlias}.review_config_hash
            AND chunk_bucket.snapshot_id = ${input.snapshotAlias}.snapshot_id
            AND chunk_bucket.bucket_id = ${input.chunkAlias}.chunk_id
        )`
}

const getSnapshotScopeSourceSql = (input: ReviewServingSummaryLedgerSnapshotScope) => {
  return `(SELECT ${getSqlLiteral(input.projectId)} AS project_id, ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash, ${getSqlLiteral(input.snapshotId)} AS snapshot_id)`
}

export const getReviewServingSummaryLedgerPublicationState = async (
  input: ReviewServingSummaryLedgerSnapshotScope & {requestId: string},
  database: ReviewServingSummaryLedgerDatabase,
) => {
  const [row] = await database.queryJson<{bucketCount: number; legacyChunkCount: number}>(`
    SELECT
      CAST((
        SELECT COUNT(*)
        FROM ${reviewServingSummaryBucketTable} bucket
        WHERE ${getReviewServingSummaryLedgerScopePredicate({...input, alias: 'bucket'})}
          AND bucket.request_id = ${getSqlLiteral(input.requestId)}
      ) AS INTEGER) AS bucketCount,
      CAST((
        SELECT COUNT(*)
        FROM ${getSnapshotScopeSourceSql(input)} ledger_snapshot, app.review_rebuild_chunk_manifest legacy_chunk
        WHERE legacy_chunk.request_id = ${getSqlLiteral(input.requestId)}
          AND ${getLegacyRequestChunkPredicateSql({chunkAlias: 'legacy_chunk', snapshotAlias: 'ledger_snapshot'})}
      ) AS INTEGER) AS legacyChunkCount
  `)

  return {bucketCount: Number(row?.bucketCount ?? 0), legacyChunkCount: Number(row?.legacyChunkCount ?? 0)}
}

const getLegacyRequestChunkExistsSql = (input: {requestIdSql: string; snapshotAlias: string}) => {
  return `EXISTS (
      SELECT 1
      FROM app.review_rebuild_chunk_manifest legacy_chunk
      WHERE legacy_chunk.request_id = ${input.requestIdSql}
        AND ${getLegacyRequestChunkPredicateSql({chunkAlias: 'legacy_chunk', snapshotAlias: input.snapshotAlias})}
    )`
}

const getInFlightLedgerRequestSql = (input: {
  projectionIdentity: string
  snapshotAlias: string
  snapshotSourceSql?: string
}) => {
  return `
      SELECT DISTINCT chunk.request_id
      FROM ${input.snapshotSourceSql === undefined ? '' : `${input.snapshotSourceSql} ${input.snapshotAlias}, `}app.review_rebuild_chunk_manifest chunk
      INNER JOIN app.review_rebuild_request request
        ON request.request_id = chunk.request_id
      WHERE ${inFlightRebuildRequestPredicateSql}
        AND chunk.project_id = ${input.snapshotAlias}.project_id
        AND chunk.snapshot_id = ${input.snapshotAlias}.snapshot_id
        AND chunk.projection_component = 'summary'
        AND chunk.projection_identity = ${getSqlLiteral(input.projectionIdentity)}
        AND NOT EXISTS (
          SELECT 1
          FROM ${reviewServingSummaryBucketTable} published
          WHERE published.project_id = ${input.snapshotAlias}.project_id
            AND published.review_config_hash = ${input.snapshotAlias}.review_config_hash
            AND published.snapshot_id = ${input.snapshotAlias}.snapshot_id
            AND published.request_id = chunk.request_id
            AND published.ledger_status = 'published'
        )
        AND NOT ${getLegacyRequestChunkExistsSql({requestIdSql: 'chunk.request_id', snapshotAlias: input.snapshotAlias})}
  `
}

// A snapshot can take summary patches when it has a published ledger, or when an admitted summary rebuild whose chunks
// all write buckets is building one (candidate catch-up).
export const getReviewServingSummaryLedgerSnapshotPredicateSql = (input: {
  projectionIdentity: string
  snapshotAlias: string
}) => {
  return `(
    EXISTS (
      SELECT 1
      FROM ${reviewServingSummaryBucketTable} published
      WHERE published.project_id = ${input.snapshotAlias}.project_id
        AND published.review_config_hash = ${input.snapshotAlias}.review_config_hash
        AND published.snapshot_id = ${input.snapshotAlias}.snapshot_id
        AND published.ledger_status = 'published'
    )
    OR EXISTS (${getInFlightLedgerRequestSql(input)})
  )`
}

const getClaimArticleId = (claim: ReviewServingDirtyWorkClaim) => {
  const articleId =
    claim.articleId ?? (claim.scopeKind === 'article' ? (claim.scopeId.split(':').at(-1) ?? null) : null)

  return articleId !== null && articleId.trim().length > 0 ? articleId : null
}

export const getReviewServingSummaryLedgerClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.map(getClaimArticleId).filter((articleId): articleId is string => {
        return articleId !== null
      }),
    ),
  ]
}

const getEffectiveRangeSql = (input: {partitionSql: string; startKeySql: string; tieBreakerSql: string}) => {
  return `
        CASE
          WHEN ROW_NUMBER() OVER (PARTITION BY ${input.partitionSql} ORDER BY ${input.startKeySql} NULLS FIRST, ${input.tieBreakerSql}) = 1
          THEN NULL
          ELSE ${input.startKeySql}
        END AS effective_start_key,
        LEAD(${input.startKeySql}) OVER (PARTITION BY ${input.partitionSql} ORDER BY ${input.startKeySql} NULLS FIRST, ${input.tieBreakerSql}) AS effective_end_key`
}

const getArticleInEffectiveRangeSql = (articleSql: string, rangeAlias: string) => {
  return `(${rangeAlias}.effective_start_key IS NULL OR ${articleSql} >= ${rangeAlias}.effective_start_key)
        AND (${rangeAlias}.effective_end_key IS NULL OR ${articleSql} < ${rangeAlias}.effective_end_key)`
}

// Each ledger maps an article to one bucket over [bucket start, next bucket start), so articles added after the rebuild
// planned its ranges still land in a bucket. Published buckets are patched. Buckets of an in-flight rebuild are patched
// once their chunk completed; a pending chunk will read the article's patched upstream rows itself, so its claims are
// acknowledged; a running chunk, or a pending chunk whose own range misses the article, defers the claim.
const getSnapshotLedgerPlanRows = async (
  input: ReviewServingSummaryLedgerSnapshotScope & {articleIds: readonly string[]; projectionIdentity: string},
  database: ReviewServingSummaryLedgerDatabase,
) => {
  const snapshotSourceSql = getSnapshotScopeSourceSql(input)

  return database.queryJson<SummaryLedgerPlanRow>(`
    WITH claimed(article_id) AS (
      VALUES ${input.articleIds
        .map((articleId) => {
          return `(${getSqlLiteral(articleId)})`
        })
        .join(', ')}
    ),
    published_bucket AS (
      SELECT
        bucket.bucket_id,
        ${getEffectiveRangeSql({partitionSql: 'bucket.request_id', startKeySql: 'bucket.bucket_start_key', tieBreakerSql: 'bucket.bucket_id'})}
      FROM ${reviewServingSummaryBucketTable} bucket
      WHERE ${getReviewServingSummaryLedgerScopePredicate({...input, alias: 'bucket'})}
        AND bucket.ledger_status = 'published'
    ),
    building_request AS (
      ${getInFlightLedgerRequestSql({
        projectionIdentity: input.projectionIdentity,
        snapshotAlias: 'ledger_snapshot',
        snapshotSourceSql,
      })}
    ),
    building_chunk AS (
      SELECT
        chunk.chunk_id,
        chunk.status,
        chunk.chunk_start_key,
        chunk.chunk_end_key,
        EXISTS (
          SELECT 1
          FROM ${reviewServingSummaryBucketTable} bucket
          WHERE ${getReviewServingSummaryLedgerScopePredicate({...input, alias: 'bucket'})}
            AND bucket.bucket_id = chunk.chunk_id
        ) AS has_bucket,
        ${getEffectiveRangeSql({partitionSql: 'chunk.request_id', startKeySql: 'chunk.chunk_start_key', tieBreakerSql: 'chunk.chunk_id'})}
      FROM app.review_rebuild_chunk_manifest chunk
      INNER JOIN building_request
        ON building_request.request_id = chunk.request_id
      WHERE chunk.project_id = ${getSqlLiteral(input.projectId)}
        AND chunk.snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND chunk.projection_component = 'summary'
        AND chunk.projection_identity = ${getSqlLiteral(input.projectionIdentity)}
        AND NOT (chunk.status = 'completed' AND COALESCE(chunk.checksum, '') LIKE 'split:%')
    )
    SELECT
      claimed.article_id AS articleId,
      'published' AS ledgerStatus,
      published_bucket.bucket_id AS bucketId,
      published_bucket.effective_start_key AS effectiveStartKey,
      published_bucket.effective_end_key AS effectiveEndKey,
      'patch' AS action
    FROM claimed
    INNER JOIN published_bucket
      ON ${getArticleInEffectiveRangeSql('claimed.article_id', 'published_bucket')}
    UNION ALL
    SELECT
      claimed.article_id AS articleId,
      'building' AS ledgerStatus,
      building_chunk.chunk_id AS bucketId,
      building_chunk.effective_start_key AS effectiveStartKey,
      building_chunk.effective_end_key AS effectiveEndKey,
      CASE
        WHEN building_chunk.status = 'running' THEN 'defer'
        WHEN building_chunk.status = 'completed' AND building_chunk.has_bucket THEN 'patch'
        WHEN building_chunk.status = 'completed' THEN 'defer'
        WHEN (building_chunk.chunk_start_key IS NULL OR claimed.article_id >= building_chunk.chunk_start_key)
          AND (building_chunk.chunk_end_key IS NULL OR claimed.article_id <= building_chunk.chunk_end_key)
        THEN 'ack'
        ELSE 'defer'
      END AS action
    FROM claimed
    INNER JOIN building_chunk
      ON ${getArticleInEffectiveRangeSql('claimed.article_id', 'building_chunk')}
    ORDER BY articleId, ledgerStatus, bucketId
  `)
}

export const planReviewServingSummaryLedgerPatches = async (
  input: {
    claims: readonly ReviewServingDirtyWorkClaim[]
    projectId: string
    projectionIdentity: string
    snapshots: readonly {reviewConfigHash: string; snapshotId: string}[]
  },
  database: ReviewServingSummaryLedgerDatabase,
) => {
  const articleIds = getReviewServingSummaryLedgerClaimArticleIds(input.claims)
  const snapshotRows =
    articleIds.length === 0
      ? []
      : await input.snapshots.reduce<
          Promise<Array<{rows: SummaryLedgerPlanRow[]; snapshot: (typeof input.snapshots)[number]}>>
        >(async (previous, snapshot) => {
          const results = await previous
          const rows = await getSnapshotLedgerPlanRows(
            {...snapshot, articleIds, projectId: input.projectId, projectionIdentity: input.projectionIdentity},
            database,
          )

          return [...results, {rows, snapshot}]
        }, Promise.resolve([]))
  const deferredArticleIds = new Set(
    snapshotRows.flatMap(({rows}) => {
      return rows.flatMap((row) => {
        return row.action === 'defer' ? [row.articleId] : []
      })
    }),
  )
  const hasLedgerSnapshot = snapshotRows.some(({rows}) => {
    return rows.length > 0
  })
  const deferredClaimIds = input.claims.flatMap((claim) => {
    const articleId = getClaimArticleId(claim)

    return !hasLedgerSnapshot || articleId === null || deferredArticleIds.has(articleId) ? [claim.dirtyWorkId] : []
  })

  return {
    deferredClaimIds,
    getSnapshotPatches: (claims: readonly ReviewServingDirtyWorkClaim[]) => {
      const patchedArticleIds = new Set(getReviewServingSummaryLedgerClaimArticleIds(claims))

      return snapshotRows.flatMap(({rows, snapshot}): ReviewServingSummaryLedgerSnapshotPatch[] => {
        const buckets = [
          ...new Map(
            rows
              .filter((row) => {
                return row.action === 'patch' && patchedArticleIds.has(row.articleId)
              })
              .map((row) => {
                return [
                  row.bucketId,
                  {
                    bucketId: row.bucketId,
                    effectiveEndKey: row.effectiveEndKey,
                    effectiveStartKey: row.effectiveStartKey,
                    ledgerStatus: row.ledgerStatus,
                  },
                ] as const
              }),
          ).values(),
        ]

        return buckets.length === 0
          ? []
          : [
              {
                buckets,
                projectId: input.projectId,
                reviewConfigHash: snapshot.reviewConfigHash,
                snapshotId: snapshot.snapshotId,
              },
            ]
      })
    },
  }
}

export const getCloneReviewServingSummaryLedgerStatements = (input: {
  projectId: string
  sourceSnapshotId: string
  targetSnapshotId: string
}) => {
  const publishedSourceBucketSql = `
    SELECT bucket_id
    FROM ${reviewServingSummaryBucketTable}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot_id = ${getSqlLiteral(input.sourceSnapshotId)}
      AND ledger_status = 'published'
  `

  return [
    `
      DELETE FROM ${reviewServingSummaryBucketPartialTable}
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.targetSnapshotId)}
    `,
    `
      DELETE FROM ${reviewServingSummaryBucketTable}
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.targetSnapshotId)}
    `,
    `
      INSERT INTO ${reviewServingSummaryBucketTable} BY NAME
      SELECT * REPLACE (${getSqlLiteral(input.targetSnapshotId)} AS snapshot_id)
      FROM ${reviewServingSummaryBucketTable}
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.sourceSnapshotId)}
        AND ledger_status = 'published'
    `,
    `
      INSERT INTO ${reviewServingSummaryBucketPartialTable} BY NAME
      SELECT * REPLACE (${getSqlLiteral(input.targetSnapshotId)} AS snapshot_id)
      FROM ${reviewServingSummaryBucketPartialTable}
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.sourceSnapshotId)}
        AND bucket_id IN (${publishedSourceBucketSql})
    `,
  ]
}

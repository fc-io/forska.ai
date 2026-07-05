import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import {
  getReviewServingContributionDiffs,
  type ReviewServingContributionRow,
} from './reviewServingContributionService.ts'
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

export type ReviewServingFilterPostingProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingFilterPostingsInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  listModeKeys: readonly string[]
  projectId: string
  projectScopeIdentity: string
  projectionIdentity: string
  reviewConfigHash: string
  selectedImportSnapshotId: string
  snapshotId: string
  status?: ReviewServingProjectionManifestStatus
  refreshFullRebuildStats?: boolean
}

type PostingContributionRow = {
  articleId: string
  filterKind: string
  filterValue: string
  listModeKey: string
  sortKey: Date | string
  tombstone: boolean
}

type PostingStatsRow = {
  cardinality: number | string | null
  filterKind: string
  filterValue: string
  listModeKey: string
}

type PostingServingTotalRow = {contributionKey: string; contributionValue: number | string | null}

type PostingTotalRow = {listModeKey: string; totalArticleCount: number | string | null}

type PostingValidationCountRow = {actualChecksum: string | null; actualCount: number | string | null}

const filterPostingProjectorName = 'filter-posting-projector'
const stalePostingSortAt = '1970-01-01T00:00:00.000Z'

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const getPatchWatermark = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )
}

const isFullPostingRebuildInput = (input: Pick<ProjectReviewServingFilterPostingsInput, 'claims'>) => {
  return input.claims.length === 0
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

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
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

const getValuesCte = (columnName: string, values: readonly string[]) => {
  return values.length === 0
    ? ''
    : `${columnName}_filter(${columnName}) AS (SELECT * FROM (VALUES ${values
        .map((value) => {
          return `(${getSqlLiteral(value)})`
        })
        .join(', ')}))`
}

const hasChunkArticleRange = (input: {chunkEndArticleId?: string | null; chunkStartArticleId?: string | null}) => {
  return input.chunkStartArticleId !== undefined || input.chunkEndArticleId !== undefined
}

const getArticleRangePredicate = (input: {
  alias: string
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
}) => {
  const startPredicate =
    input.chunkStartArticleId === null || input.chunkStartArticleId === undefined
      ? ''
      : `AND ${input.alias}.article_id >= ${getSqlLiteral(input.chunkStartArticleId)}`
  const endPredicate =
    input.chunkEndArticleId === null || input.chunkEndArticleId === undefined
      ? ''
      : `AND ${input.alias}.article_id <= ${getSqlLiteral(input.chunkEndArticleId)}`

  return `${startPredicate}
          ${endPredicate}`
}

const getListModeCte = (listModeKeys: readonly string[]) => {
  return getValuesCte('list_mode_key', listModeKeys)
}

const getPostingIdentity = (row: Pick<PostingContributionRow, 'filterKind' | 'filterValue' | 'listModeKey'>) => {
  return getStableReviewServingJson({
    filterKind: row.filterKind,
    filterValue: row.filterValue,
    listModeKey: row.listModeKey,
  })
}

const getPostingIdentitySql = (alias: string) => {
  return `'{"filterKind":' || CAST(to_json(${alias}.filterKind) AS VARCHAR) || ',"filterValue":' || CAST(to_json(${alias}.filterValue) AS VARCHAR) || ',"listModeKey":' || CAST(to_json(${alias}.listModeKey) AS VARCHAR) || '}'`
}

const getContributionKey = (
  row: Pick<PostingContributionRow, 'articleId' | 'filterKind' | 'filterValue' | 'listModeKey'>,
) => {
  return getStableReviewServingJson({
    articleId: row.articleId,
    filterKind: row.filterKind,
    filterValue: row.filterValue,
    listModeKey: row.listModeKey,
  })
}

const getContributionStatsKey = (row: Pick<PostingContributionRow, 'filterKind' | 'filterValue' | 'listModeKey'>) => {
  return getStableReviewServingJson({
    filterKind: row.filterKind,
    filterValue: row.filterValue,
    listModeKey: row.listModeKey,
  })
}

const getPostingRowsAsContributionRows = (rows: readonly PostingContributionRow[]) => {
  const liveRowsByArticleAndStatsKey = rows
    .filter((row) => {
      return !row.tombstone
    })
    .reduce<Map<string, ReviewServingContributionRow>>((result, row) => {
      const contributionKey = getContributionStatsKey(row)
      const articleStatsKey = getStableReviewServingJson({articleId: row.articleId, contributionKey})

      result.set(articleStatsKey, {articleId: row.articleId, contributionKey, contributionValue: 1})

      return result
    }, new Map())

  return [...liveRowsByArticleAndStatsKey.values()]
}

const getDirtyArticleCte = (input: ProjectReviewServingFilterPostingsInput, articleIds: readonly string[]) => {
  return articleIds.length > 0
    ? getValuesCte('article_id', articleIds)
    : `article_id_filter(article_id) AS (
        SELECT scope.article_id
        FROM mart.project_scope_article scope
        WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
          ${hasChunkArticleRange(input) ? 'AND (scope.in_curated_scope OR scope.in_route_scope)' : ''}
          ${getArticleRangePredicate({alias: 'scope', ...input})}
      )`
}

const getPostingContributionRowsStatement = (input: ProjectReviewServingFilterPostingsInput) => {
  return getFullRebuildPostingContributionRowsStatement(input)
}

const getFullRebuildPostingContributionRowsStatement = (input: ProjectReviewServingFilterPostingsInput) => {
  return `
        WITH ${getDirtyArticleCte(input, getClaimArticleIds(input.claims))},
        ${getListModeCte(input.listModeKeys)},
        scoped_article AS (
          SELECT
            scope.article_id,
            COALESCE(scope.article_updated_at, scope.article_created_at, TIMESTAMPTZ ${getSqlLiteral(stalePostingSortAt)}) AS sort_key,
            NOT (scope.in_curated_scope OR scope.in_route_scope) AS scope_tombstone
          FROM article_id_filter dirty
          INNER JOIN mart.project_scope_article scope
            ON scope.project_id = ${getSqlLiteral(input.projectId)}
            AND scope.article_id = dirty.article_id
        ),
        selected_import_state AS (
          SELECT
            scoped.article_id,
            scoped.sort_key,
            selected.import_route_id,
            selected.selected_rank_key,
            selected.publication_year,
            COALESCE(selected.duplicate_flag, FALSE) AS duplicate_flag,
            COALESCE(selected.conflict_flag, FALSE) AS conflict_flag,
            scoped.scope_tombstone AS tombstone
          FROM scoped_article scoped
          LEFT JOIN app.review_selected_article_import_v4 selected
            ON selected.project_id = ${getSqlLiteral(input.projectId)}
            AND selected.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
            AND selected.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND selected.article_id = scoped.article_id
        ),
        selected_postings AS (
          SELECT selected.article_id AS articleId, list_mode_key.list_mode_key AS listModeKey, selected.sort_key AS sortKey, selected.tombstone AS tombstone, 'importRoute' AS filterKind, selected.import_route_id AS filterValue
          FROM selected_import_state selected CROSS JOIN list_mode_key_filter list_mode_key
          UNION ALL
          SELECT selected.article_id AS articleId, list_mode_key.list_mode_key AS listModeKey, selected.sort_key AS sortKey, selected.tombstone AS tombstone, 'publicationYear' AS filterKind, CAST(selected.publication_year AS VARCHAR) AS filterValue
          FROM selected_import_state selected CROSS JOIN list_mode_key_filter list_mode_key
          UNION ALL
          SELECT selected.article_id AS articleId, list_mode_key.list_mode_key AS listModeKey, selected.sort_key AS sortKey, selected.tombstone AS tombstone, 'duplicateFlag' AS filterKind, CAST(selected.duplicate_flag AS VARCHAR) AS filterValue
          FROM selected_import_state selected CROSS JOIN list_mode_key_filter list_mode_key
          UNION ALL
          SELECT selected.article_id AS articleId, list_mode_key.list_mode_key AS listModeKey, selected.sort_key AS sortKey, selected.tombstone AS tombstone, 'conflictFlag' AS filterKind, CAST(selected.conflict_flag AS VARCHAR) AS filterValue
          FROM selected_import_state selected CROSS JOIN list_mode_key_filter list_mode_key
        ),
        scoped_serving AS (
          SELECT serving.*
          FROM scoped_article scoped
          INNER JOIN mart.review_article_serving_v4 serving
            ON serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND serving.article_id = scoped.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = serving.list_mode_key
        ),
        serving_status_postings AS (
          SELECT serving.article_id AS articleId, serving.list_mode_key AS listModeKey, serving.sort_key AS sortKey, FALSE AS tombstone, 'llmStatus' AS filterKind, serving.llm_status_key AS filterValue
          FROM scoped_serving serving
          UNION ALL
          SELECT serving.article_id AS articleId, serving.list_mode_key AS listModeKey, serving.sort_key AS sortKey, FALSE AS tombstone, 'humanStatus' AS filterKind, serving.human_status_key AS filterValue
          FROM scoped_serving serving
        ),
        project_settings AS (
          SELECT COALESCE((SELECT project.human_judgment_mode FROM app.project project WHERE project.id = ${getSqlLiteral(input.projectId)}), 'prompt') AS human_judgment_mode
        ),
        llm_detail AS (
          SELECT detail.*
          FROM scoped_article scoped
          INNER JOIN mart.review_article_judgment_detail_serving_v4 detail
            ON detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND detail.payload_kind = 'llm'
            AND detail.article_id = scoped.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = detail.list_mode_key
        ),
        human_detail AS (
          SELECT detail.*
          FROM scoped_article scoped
          INNER JOIN mart.review_article_judgment_detail_serving_v4 detail
            ON detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND detail.payload_kind = 'human'
            AND detail.article_id = scoped.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = detail.list_mode_key
        ),
        llm_postings AS (
          SELECT llm.article_id AS articleId, llm.list_mode_key AS listModeKey, serving.sort_key AS sortKey, FALSE AS tombstone, 'promptAnswer' AS filterKind, concat('review:promptAnswer:', llm.prompt_id, ':', llm.answered_original) AS filterValue
          FROM scoped_article scoped
          INNER JOIN llm_detail llm
            ON llm.article_id = scoped.article_id
            AND llm.answered_original IS NOT NULL
            AND llm.answered_original_as_array IS NULL
          INNER JOIN scoped_serving serving
            ON serving.article_id = llm.article_id
            AND serving.list_mode_key = llm.list_mode_key
          UNION ALL
          SELECT llm.article_id AS articleId, llm.list_mode_key AS listModeKey, serving.sort_key AS sortKey, FALSE AS tombstone, 'promptAnswer' AS filterKind, concat('review:promptAnswer:', llm.prompt_id, ':', answer.answer_value) AS filterValue
          FROM scoped_article scoped
          INNER JOIN llm_detail llm
            ON llm.article_id = scoped.article_id
            AND llm.answered_original_as_array IS NOT NULL
          INNER JOIN scoped_serving serving
            ON serving.article_id = llm.article_id
            AND serving.list_mode_key = llm.list_mode_key
          CROSS JOIN UNNEST(llm.answered_original_as_array) AS answer(answer_value)
          WHERE answer.answer_value IS NOT NULL
        ),
        human_postings AS (
          SELECT human.article_id AS articleId, human.list_mode_key AS listModeKey, serving.sort_key AS sortKey, FALSE AS tombstone, 'promptAnswer' AS filterKind, concat('human:promptAnswer:', human.prompt_id, ':', human.answered_original) AS filterValue
          FROM scoped_article scoped
          INNER JOIN human_detail human
            ON human.article_id = scoped.article_id
            AND human.answered_original IS NOT NULL
          CROSS JOIN project_settings
          INNER JOIN scoped_serving serving
            ON serving.article_id = human.article_id
            AND serving.list_mode_key = human.list_mode_key
          WHERE (
            project_settings.human_judgment_mode = 'summary'
            AND human.prompt_id = 'summary'
          ) OR (
            project_settings.human_judgment_mode <> 'summary'
            AND human.prompt_id <> 'summary'
          )
        ),
        posting_union AS (
          SELECT * FROM selected_postings
          UNION ALL SELECT * FROM serving_status_postings
          UNION ALL SELECT * FROM llm_postings
          UNION ALL SELECT * FROM human_postings
        )
        SELECT articleId, filterKind, filterValue, listModeKey, sortKey, tombstone
        FROM posting_union
        WHERE filterValue IS NOT NULL
        ORDER BY listModeKey ASC, filterKind ASC, filterValue ASC, articleId ASC
      `
}

const getPostingContributionRows = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase,
) => {
  return input.listModeKeys.length === 0
    ? []
    : database.queryJson<PostingContributionRow>(getPostingContributionRowsStatement(input))
}

const getExistingPostingRows = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const articlePredicate =
    articleIds.length === 0
      ? getArticleRangePredicate({alias: 'serving', ...input})
      : `AND serving.article_id IN (${articleIds
          .map((articleId) => {
            return getSqlLiteral(articleId)
          })
          .join(', ')})`

  return database.queryJson<PostingContributionRow>(`
        SELECT
          serving.article_id AS articleId,
          serving.filter_kind AS filterKind,
          serving.filter_value AS filterValue,
          serving.list_mode_key AS listModeKey,
          serving.sort_key AS sortKey,
          FALSE AS tombstone
        FROM mart.review_article_filter_posting_serving_v4 serving
        WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${articlePredicate}
      `)
}

const getExistingStatsRows = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase,
  statsKeys: readonly string[],
) => {
  return statsKeys.length === 0
    ? []
    : database.queryJson<PostingStatsRow>(`
        SELECT filter_kind AS filterKind, filter_value AS filterValue, list_mode_key AS listModeKey, cardinality
        FROM mart.review_filter_posting_stats_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
      `)
}

const getExistingServingTotalRows = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase,
  rows: readonly PostingContributionRow[],
) => {
  const statsKeys = [
    ...new Map(
      rows.map((row) => {
        return [getContributionStatsKey(row), row]
      }),
    ).values(),
  ]

  return statsKeys.length === 0
    ? []
    : database.queryJson<PostingServingTotalRow>(`
        WITH stats_key_filter(filter_kind, filter_value, list_mode_key) AS (
          SELECT * FROM (VALUES ${statsKeys
            .map((row) => {
              return `(${getSqlLiteral(row.filterKind)}, ${getSqlLiteral(row.filterValue)}, ${getSqlLiteral(row.listModeKey)})`
            })
            .join(', ')})
        )
        SELECT
          ${getPostingIdentityFromStatsSql('filter')} AS contributionKey,
          COUNT(serving.article_id) AS contributionValue
        FROM stats_key_filter filter
        LEFT JOIN mart.review_article_filter_posting_serving_v4 serving
          ON serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND serving.filter_kind = filter.filter_kind
          AND serving.filter_value = filter.filter_value
          AND serving.list_mode_key = filter.list_mode_key
        GROUP BY filter.filter_kind, filter.filter_value, filter.list_mode_key
      `)
}

const getPostingTotalRows = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase,
) => {
  return input.listModeKeys.length === 0
    ? []
    : database.queryJson<PostingTotalRow>(`
        WITH ${getListModeCte(input.listModeKeys)}
        SELECT
          list_mode_key.list_mode_key AS listModeKey,
          (
            SELECT COUNT(*)
            FROM mart.project_scope_article scope
            WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
              AND (scope.in_curated_scope OR scope.in_route_scope)
          ) AS totalArticleCount
        FROM list_mode_key_filter list_mode_key
      `)
}

const getPostingServingRecord = (input: {
  projectId: string
  reviewConfigHash: string
  row: PostingContributionRow
  snapshotId: string
}): ReviewServingProjectorRecord => {
  return {
    keyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'filter_kind',
      'filter_value',
      'list_mode_key',
      'article_id',
    ],
    table: 'mart.review_article_filter_posting_serving_v4',
    values: {
      article_id: input.row.articleId,
      filter_kind: input.row.filterKind,
      filter_value: input.row.filterValue,
      list_mode_key: input.row.listModeKey,
      posting_identity: getPostingIdentity(input.row),
      posting_updated_at: new Date(),
      project_id: input.projectId,
      review_config_hash: input.reviewConfigHash,
      snapshot_id: input.snapshotId,
      sort_key: input.row.sortKey,
    },
  }
}

const getStatsRecord = (input: {
  cardinality: number
  filterKind: string
  filterValue: string
  listModeKey: string
  projectId: string
  reviewConfigHash: string
  snapshotId: string
  totalArticleCount: number
}): ReviewServingProjectorRecord => {
  return {
    keyColumns: ['project_id', 'review_config_hash', 'snapshot_id', 'filter_kind', 'filter_value', 'list_mode_key'],
    table: 'mart.review_filter_posting_stats_v4',
    values: {
      cardinality: input.cardinality,
      filter_kind: input.filterKind,
      filter_value: input.filterValue,
      list_mode_key: input.listModeKey,
      posting_identity: getPostingIdentity(input),
      project_id: input.projectId,
      review_config_hash: input.reviewConfigHash,
      selectivity: input.totalArticleCount === 0 ? null : input.cardinality / input.totalArticleCount,
      snapshot_id: input.snapshotId,
      stats_updated_at: new Date(),
    },
  }
}

const getDeleteServingRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  tombstoneRows: readonly PostingContributionRow[],
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const tombstoneValues = tombstoneRows
    .map((row) => {
      return `(${getSqlLiteral(row.articleId)}, ${getSqlLiteral(row.filterKind)}, ${getSqlLiteral(row.filterValue)}, ${getSqlLiteral(row.listModeKey)})`
    })
    .join(', ')

  return articleIds.length > 0
    ? getDeleteReviewServingProjectorRowsStatement({
        predicates: {
          article_id: articleIds,
          project_id: input.projectId,
          review_config_hash: input.reviewConfigHash,
          snapshot_id: input.snapshotId,
        },
        table: 'mart.review_article_filter_posting_serving_v4',
      })
    : hasChunkArticleRange(input)
      ? `DELETE FROM mart.review_article_filter_posting_serving_v4 serving
        WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${getArticleRangePredicate({alias: 'serving', ...input})}`
      : tombstoneValues.length === 0
        ? null
        : `WITH deleted(article_id, filter_kind, filter_value, list_mode_key) AS (
          SELECT * FROM (VALUES ${tombstoneValues})
        )
        DELETE FROM mart.review_article_filter_posting_serving_v4 serving
        USING deleted
        WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND serving.article_id = deleted.article_id
          AND serving.filter_kind = deleted.filter_kind
          AND serving.filter_value = deleted.filter_value
          AND serving.list_mode_key = deleted.list_mode_key`
}

const getDeleteFullRebuildServingRowsStatement = (input: ProjectReviewServingFilterPostingsInput) => {
  const rangePredicate = hasChunkArticleRange(input) ? getArticleRangePredicate({alias: 'serving', ...input}) : ''

  return `DELETE FROM mart.review_article_filter_posting_serving_v4 serving
    WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
      AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      ${rangePredicate}`
}

const getInsertFullRebuildServingRowsStatement = (input: ProjectReviewServingFilterPostingsInput) => {
  return `INSERT INTO mart.review_article_filter_posting_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      posting_identity,
      filter_kind,
      filter_value,
      list_mode_key,
      article_id,
      sort_key,
      posting_updated_at
    )
    WITH posting_source AS (${getFullRebuildPostingContributionRowsStatement(input)}),
    serving_source AS (
      SELECT
        posting.filterKind,
        posting.filterValue,
        posting.listModeKey,
        posting.articleId,
        MAX(posting.sortKey) AS sortKey
      FROM posting_source posting
      WHERE NOT posting.tombstone
      GROUP BY posting.filterKind, posting.filterValue, posting.listModeKey, posting.articleId
    )
    SELECT
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      ${getPostingIdentitySql('posting')} AS posting_identity,
      posting.filterKind AS filter_kind,
      posting.filterValue AS filter_value,
      posting.listModeKey AS list_mode_key,
      posting.articleId AS article_id,
      posting.sortKey AS sort_key,
      current_timestamp AS posting_updated_at
    FROM serving_source posting
    ON CONFLICT(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, article_id) DO UPDATE SET
      posting_identity = excluded.posting_identity,
      sort_key = excluded.sort_key,
      posting_updated_at = excluded.posting_updated_at`
}

const getDeleteFullRebuildStatsRowsStatement = (
  input: Pick<ProjectReviewServingFilterPostingsInput, 'projectId' | 'reviewConfigHash' | 'snapshotId'>,
) => {
  return `DELETE FROM mart.review_filter_posting_stats_v4 stats
    WHERE stats.project_id = ${getSqlLiteral(input.projectId)}
      AND stats.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND stats.snapshot_id = ${getSqlLiteral(input.snapshotId)}`
}

const getPostingIdentityFromStatsSql = (alias: string) => {
  return `'{"filterKind":' || CAST(to_json(${alias}.filter_kind) AS VARCHAR) || ',"filterValue":' || CAST(to_json(${alias}.filter_value) AS VARCHAR) || ',"listModeKey":' || CAST(to_json(${alias}.list_mode_key) AS VARCHAR) || '}'`
}

const getInsertFullRebuildStatsRowsStatement = (
  input: Pick<ProjectReviewServingFilterPostingsInput, 'projectId' | 'reviewConfigHash' | 'snapshotId'>,
) => {
  return `INSERT INTO mart.review_filter_posting_stats_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      posting_identity,
      filter_kind,
      filter_value,
      list_mode_key,
      cardinality,
      selectivity,
      stats_updated_at
    )
    WITH total_article AS (
      SELECT COUNT(*) AS totalArticleCount
      FROM mart.project_scope_article scope
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
    ), stats_source AS (
      SELECT
        serving.filter_kind,
        serving.filter_value,
        serving.list_mode_key,
        COUNT(*) AS cardinality
      FROM mart.review_article_filter_posting_serving_v4 serving
      WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
        AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
        AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      GROUP BY serving.filter_kind, serving.filter_value, serving.list_mode_key
    )
    SELECT
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      ${getPostingIdentityFromStatsSql('stats')} AS posting_identity,
      stats.filter_kind,
      stats.filter_value,
      stats.list_mode_key,
      stats.cardinality,
      CASE
        WHEN total.totalArticleCount = 0 THEN NULL
        ELSE CAST(stats.cardinality AS DOUBLE) / CAST(total.totalArticleCount AS DOUBLE)
      END AS selectivity,
      current_timestamp AS stats_updated_at
    FROM stats_source stats
    CROSS JOIN total_article total
    ON CONFLICT(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key) DO UPDATE SET
      posting_identity = excluded.posting_identity,
      cardinality = excluded.cardinality,
      selectivity = excluded.selectivity,
      stats_updated_at = excluded.stats_updated_at`
}

export const refreshReviewServingFilterPostingStats = async (
  input: Pick<ProjectReviewServingFilterPostingsInput, 'projectId' | 'reviewConfigHash' | 'snapshotId'>,
  database: ReviewServingFilterPostingProjectorDatabase = getAppDatabaseService() as ReviewServingFilterPostingProjectorDatabase,
) => {
  await writeReviewServingProjectorComponent(
    {
      acknowledgements: [],
      component: 'posting',
      projectionManifests: [],
      records: [],
      repairDirtyWork: [],
      statements: [getDeleteFullRebuildStatsRowsStatement(input), getInsertFullRebuildStatsRowsStatement(input)],
    },
    database,
  )
}

const getFullRebuildWriteStatements = (input: ProjectReviewServingFilterPostingsInput) => {
  const insertStatements = input.listModeKeys.length === 0 ? [] : [getInsertFullRebuildServingRowsStatement(input)]
  const statsStatements =
    input.refreshFullRebuildStats === false
      ? []
      : [getDeleteFullRebuildStatsRowsStatement(input), getInsertFullRebuildStatsRowsStatement(input)]

  return [getDeleteFullRebuildServingRowsStatement(input), ...insertStatements, ...statsStatements]
}

const getDeleteStatsRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  statsRecords: readonly ReviewServingProjectorRecord[],
) => {
  const statsValues = [
    ...new Set(
      statsRecords.map((record) => {
        return [
          getSqlLiteral(record.values.filter_kind ?? null),
          getSqlLiteral(record.values.filter_value ?? null),
          getSqlLiteral(record.values.list_mode_key ?? null),
        ].join(', ')
      }),
    ),
  ]

  return statsValues.length === 0
    ? null
    : `WITH deleted(filter_kind, filter_value, list_mode_key) AS (
      SELECT * FROM (VALUES (${statsValues.join('), (')}))
    )
    DELETE FROM mart.review_filter_posting_stats_v4 stats
    USING deleted
    WHERE stats.project_id = ${getSqlLiteral(input.projectId)}
      AND stats.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND stats.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND stats.filter_kind = deleted.filter_kind
      AND stats.filter_value = deleted.filter_value
      AND stats.list_mode_key = deleted.list_mode_key`
}

const getPostingManifest = (
  input: ProjectReviewServingFilterPostingsInput,
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
    projectionComponent: 'posting',
    projectionIdentity: input.projectionIdentity,
    reviewConfigHash: input.reviewConfigHash,
    status: input.status ?? 'candidate',
  }
}

const getFiniteNumber = (value: number | string | null | undefined) => {
  const numberValue = typeof value === 'string' ? Number(value) : value

  return numberValue === null || numberValue === undefined || !Number.isFinite(numberValue) ? 0 : numberValue
}

const getNonNegativeFiniteNumber = (value: number | string | null | undefined) => {
  return Math.max(0, getFiniteNumber(value))
}

const getUniqueStatsKeys = (rows: readonly PostingContributionRow[]) => {
  return [
    ...new Set(
      rows.map((row) => {
        return getContributionStatsKey(row)
      }),
    ),
  ]
}

const getStatsRowIsInvalid = (row: PostingStatsRow | undefined, totalArticleCount: number) => {
  if (row === undefined) {
    return false
  }

  const cardinality = getFiniteNumber(row.cardinality)

  return cardinality < 0 || !Number.isSafeInteger(cardinality) || cardinality > totalArticleCount
}

const getStatsRecords = async (input: {
  database: ReviewServingFilterPostingProjectorDatabase
  diffs: readonly {contributionKey: string; delta: number}[]
  rows: readonly PostingContributionRow[]
  projectorInput: ProjectReviewServingFilterPostingsInput
}) => {
  const changedDiffs = input.diffs.filter((diff) => {
    return diff.delta !== 0
  })
  const rowKeys = getUniqueStatsKeys(input.rows)
  const [existingStatsRows, totalRows] = await Promise.all([
    getExistingStatsRows(input.projectorInput, input.database, rowKeys),
    getPostingTotalRows(input.projectorInput, input.database),
  ])
  const statsRowsByKey = new Map(
    existingStatsRows.map((row) => {
      return [getContributionStatsKey(row), row]
    }),
  )
  const totalRowsByListMode = new Map(
    totalRows.map((row) => {
      return [row.listModeKey, getNonNegativeFiniteNumber(row.totalArticleCount)]
    }),
  )
  const rowsByKey = new Map(
    input.rows.map((row) => {
      return [getContributionStatsKey(row), row]
    }),
  )
  const invalidStatsKeys = rowKeys.filter((key) => {
    const row = rowsByKey.get(key)

    return row === undefined
      ? false
      : getStatsRowIsInvalid(statsRowsByKey.get(key), totalRowsByListMode.get(row.listModeKey) ?? 0)
  })
  const statsKeysToWrite = [
    ...new Set([
      ...changedDiffs.map((diff) => {
        return diff.contributionKey
      }),
      ...invalidStatsKeys,
    ]),
  ]
  const statsRowsToWrite = input.rows.filter((row) => {
    return statsKeysToWrite.includes(getContributionStatsKey(row))
  })
  const contributionTotals = await getExistingServingTotalRows(input.projectorInput, input.database, statsRowsToWrite)
  const contributionTotalsByKey = new Map(
    contributionTotals.map((row) => {
      return [row.contributionKey, getNonNegativeFiniteNumber(row.contributionValue)]
    }),
  )
  const diffsByKey = new Map(
    changedDiffs.map((diff) => {
      return [diff.contributionKey, diff.delta]
    }),
  )

  return statsKeysToWrite.flatMap((statsKey) => {
    const row = rowsByKey.get(statsKey)
    const existingCardinality = contributionTotalsByKey.get(statsKey) ?? 0
    const cardinality = Math.max(0, existingCardinality + (diffsByKey.get(statsKey) ?? 0))

    return row === undefined
      ? []
      : [
          getStatsRecord({
            cardinality,
            filterKind: row.filterKind,
            filterValue: row.filterValue,
            listModeKey: row.listModeKey,
            projectId: input.projectorInput.projectId,
            reviewConfigHash: input.projectorInput.reviewConfigHash,
            snapshotId: input.projectorInput.snapshotId,
            totalArticleCount: totalRowsByListMode.get(row.listModeKey) ?? 0,
          }),
        ]
  })
}

const getRecordValue = (record: ReviewServingProjectorRecord, column: string) => {
  return record.values[column]
}

const getCheapCountChecksum = (count: number) => {
  return createHash('sha256').update(`cheap-count:${count}`).digest('hex')
}

const getFullPostingRebuildOutputValidationResult = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase,
) => {
  const [row] = await database.queryJson<PostingValidationCountRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256('cheap-count:' || CAST(COUNT(*) AS VARCHAR)) AS actualChecksum
    FROM mart.review_article_filter_posting_serving_v4 serving
    WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
      AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      ${getArticleRangePredicate({alias: 'serving', ...input})}
  `)
  const actualCount = getNonNegativeFiniteNumber(row?.actualCount)
  const actualChecksum = row?.actualChecksum ?? getCheapCountChecksum(actualCount)

  return {
    actualChecksum,
    actualCount,
    diagnosticsJson: {validationMode: 'post-write-serving-count'},
    expectedChecksum: actualChecksum,
    expectedCount: actualCount,
  }
}

const getTombstoneRows = (input: {
  existingRows: readonly PostingContributionRow[]
  newRows: readonly PostingContributionRow[]
}) => {
  const liveNewKeys = new Set(
    input.newRows
      .filter((row) => {
        return !row.tombstone
      })
      .map((row) => {
        return getContributionKey(row)
      }),
  )

  return input.existingRows
    .filter((row) => {
      return !liveNewKeys.has(getContributionKey(row))
    })
    .map((row) => {
      return {...row, tombstone: true}
    })
}

export const projectReviewServingFilterPostings = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase = getAppDatabaseService() as ReviewServingFilterPostingProjectorDatabase,
) => {
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
  const patchWatermark = getPatchWatermark(input.claims)

  if (isFullPostingRebuildInput(input)) {
    const writerResult = await measure('writerMs', async () => {
      return writeReviewServingProjectorComponent(
        {
          acknowledgements: input.acknowledgeClaims === false ? [] : input.claims,
          component: 'posting',
          projectionManifests: [],
          records: [],
          repairDirtyWork: [],
          statements: getFullRebuildWriteStatements(input),
        },
        database,
      )
    })
    const validationResult = await measure('validationMs', async () => {
      return getFullPostingRebuildOutputValidationResult(input, database)
    })

    return {
      diagnosticsJson: {
        phaseTimings,
        postingProjector: {
          fullRebuildMode: 'set-based',
          servingRowCount: validationResult.actualCount,
          writer: writerResult.diagnostics,
        },
      },
      patchRowCount: 0,
      patchWatermark,
      repairRequired: false,
      servingRowCount: validationResult.actualCount,
      statsRowCount: 0,
      statsValues: [],
      validationResult,
    }
  }

  const [existingRows, newRows] = await measure('sourceQueryMs', async () => {
    return Promise.all([getExistingPostingRows(input, database), getPostingContributionRows(input, database)])
  })
  const {contributionRows, liveRows} = measureSync('diffInputTransformMs', () => {
    const transformedContributionRows = [...newRows, ...getTombstoneRows({existingRows, newRows})]
    const transformedLiveRows = transformedContributionRows.filter((row) => {
      return !row.tombstone
    })

    return {contributionRows: transformedContributionRows, liveRows: transformedLiveRows}
  })
  const contributionDiffs = measureSync('contributionDiffMs', () => {
    return getReviewServingContributionDiffs({
      newRows: getPostingRowsAsContributionRows(liveRows),
      oldRows: getPostingRowsAsContributionRows(existingRows),
    })
  })
  const {servingRecords} = measureSync('recordTransformMs', () => {
    const nextServingRecords = liveRows.map((row) => {
      return getPostingServingRecord({
        projectId: input.projectId,
        reviewConfigHash: input.reviewConfigHash,
        row,
        snapshotId: input.snapshotId,
      })
    })

    return {servingRecords: nextServingRecords}
  })
  const servingRowCount = servingRecords.length
  const statsRecords = await measure('statsQueryAndTransformMs', async () => {
    return getStatsRecords({database, diffs: contributionDiffs, projectorInput: input, rows: contributionRows})
  })
  const {deleteServingRowsStatement, deleteStatsRowsStatement} = measureSync('deleteStatementBuildMs', () => {
    const nextDeleteServingRowsStatement = getDeleteServingRowsStatement(
      input,
      contributionRows.filter((row) => {
        return row.tombstone
      }),
    )
    const nextDeleteStatsRowsStatement = getDeleteStatsRowsStatement(input, statsRecords)

    return {
      deleteServingRowsStatement: nextDeleteServingRowsStatement,
      deleteStatsRowsStatement: nextDeleteStatsRowsStatement,
    }
  })
  const writerResult = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: input.acknowledgeClaims === false ? [] : input.claims,
        component: 'posting',
        projectionManifests: input.claims.length === 0 ? [] : [getPostingManifest(input)],
        records: [...servingRecords, ...statsRecords],
        repairDirtyWork: [],
        statements: [deleteServingRowsStatement, deleteStatsRowsStatement].flatMap((statement) => {
          return statement === null ? [] : [statement]
        }),
        watermark:
          input.claims.length === 0
            ? undefined
            : {
                projectId: input.projectId,
                projectionComponent: 'posting',
                projectorName: filterPostingProjectorName,
                sourceHighWaterMark: patchWatermark,
                sourcePartition: getClaimSourcePartition(input.claims),
              },
      },
      database,
    )
  })

  return {
    diagnosticsJson: {
      phaseTimings,
      postingProjector: {
        contributionDiffCount: contributionDiffs.length,
        contributionRecordCount: 0,
        contributionRowCount: contributionRows.length,
        existingRowCount: existingRows.length,
        liveRowCount: liveRows.length,
        newRowCount: newRows.length,
        writer: writerResult.diagnostics,
      },
    },
    patchRowCount: 0,
    patchWatermark,
    repairRequired: false,
    servingRowCount,
    statsRowCount: statsRecords.length,
    statsValues: statsRecords.map((record) => {
      return {
        cardinality: getRecordValue(record, 'cardinality'),
        filterKind: getRecordValue(record, 'filter_kind'),
        filterValue: getRecordValue(record, 'filter_value'),
        listModeKey: getRecordValue(record, 'list_mode_key'),
        selectivity: getRecordValue(record, 'selectivity'),
      }
    }),
    validationResult: undefined,
  }
}

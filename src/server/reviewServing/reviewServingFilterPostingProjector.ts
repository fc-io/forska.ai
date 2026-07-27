import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
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
}

export type ProjectReviewServingFilterPostingRangesInput = {ranges: readonly ProjectReviewServingFilterPostingsInput[]}

type PostingContributionRow = {
  articleId: string
  filterKind: string
  filterValue: string
  listModeKey: string
  tombstone: boolean
}

type FilterStateServingRow = {
  articleId: string
  conflictFlag: boolean
  duplicateFlag: boolean
  humanStatus: string | null
  llmHasJudgment: boolean
  listModeKey: string
  llmStatus: string | null
  tombstone: boolean
}

type PostingValidationCountRow = {actualChecksum: string | null; actualCount: number | string | null}
type CompactPostingRow = {articleIds: readonly string[]; filterKind: string; filterValue: string; listModeKey: string}

const filterPostingProjectorName = 'filter-posting-projector'
const stateFilterKinds = new Set(['duplicateFlag', 'conflictFlag', 'llmStatus', 'humanStatus', 'llmHasJudgment'])
const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const isStateFilterKind = (filterKind: string) => {
  return stateFilterKinds.has(filterKind)
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

const getCompactContributionKey = (row: Pick<PostingContributionRow, 'filterKind' | 'filterValue' | 'listModeKey'>) => {
  return getStableReviewServingJson({
    filterKind: row.filterKind,
    filterValue: row.filterValue,
    listModeKey: row.listModeKey,
  })
}

const getCompactPostingRows = (rows: readonly PostingContributionRow[]) => {
  const compactRows = new Map<string, CompactPostingRow>()

  rows.forEach((row) => {
    const key = getCompactContributionKey(row)
    const existingRow = compactRows.get(key)
    const articleIds = [...(existingRow?.articleIds ?? []), row.articleId]

    compactRows.set(key, {
      articleIds: [...new Set(articleIds)].sort(),
      filterKind: row.filterKind,
      filterValue: row.filterValue,
      listModeKey: row.listModeKey,
    })
  })

  return [...compactRows.values()]
}

const getStateContributionKey = (row: Pick<FilterStateServingRow, 'articleId'>) => {
  return getStableReviewServingJson({articleId: row.articleId})
}

const getRangeValuesCte = (ranges: readonly ProjectReviewServingFilterPostingsInput[]) => {
  return `article_range_filter(chunk_start_article_id, chunk_end_article_id) AS (
        SELECT * FROM (VALUES ${ranges
          .map((range) => {
            return `(${getSqlLiteral(range.chunkStartArticleId ?? null)}, ${getSqlLiteral(range.chunkEndArticleId ?? null)})`
          })
          .join(', ')})
      )`
}

const getDirtyArticleCte = (
  input: ProjectReviewServingFilterPostingsInput,
  articleIds: readonly string[],
  ranges?: readonly ProjectReviewServingFilterPostingsInput[],
) => {
  if (ranges !== undefined) {
    return `${getRangeValuesCte(ranges)},
      article_id_filter(article_id) AS (
        SELECT DISTINCT scope.article_id
        FROM mart.project_scope_article scope
        INNER JOIN article_range_filter range
          ON (range.chunk_start_article_id IS NULL OR scope.article_id >= range.chunk_start_article_id)
          AND (range.chunk_end_article_id IS NULL OR scope.article_id <= range.chunk_end_article_id)
        WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
      )`
  }

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

const getFullRebuildPostingContributionRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  ranges?: readonly ProjectReviewServingFilterPostingsInput[],
) => {
  return `
        WITH ${getDirtyArticleCte(input, getClaimArticleIds(input.claims), ranges)},
        ${getListModeCte(input.listModeKeys)},
        scoped_article AS (
          SELECT
            scope.article_id,
            NOT (scope.in_curated_scope OR scope.in_route_scope) AS scope_tombstone
          FROM article_id_filter dirty
          INNER JOIN mart.project_scope_article scope
            ON scope.project_id = ${getSqlLiteral(input.projectId)}
            AND scope.article_id = dirty.article_id
        ),
        selected_import_state AS (
          SELECT
            scoped.article_id,
            selected.import_route_id,
            selected.selected_rank_key,
            selected_hot.publication_year AS publication_year,
            COALESCE(selected_hot.duplicate_flag, FALSE) AS duplicate_flag,
            COALESCE(selected_hot.conflict_flag, FALSE) AS conflict_flag,
            scoped.scope_tombstone AS tombstone
          FROM scoped_article scoped
          LEFT JOIN app.review_selected_article_import_v4 selected
            ON selected.project_id = ${getSqlLiteral(input.projectId)}
            AND selected.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
            AND selected.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND selected.article_id = scoped.article_id
          LEFT JOIN app.review_import_article_hot_field selected_hot
            ON selected_hot.import_route_id = selected.import_route_id
            AND selected_hot.article_id = selected.article_id
            AND selected_hot.source_record_key = selected.source_record_key
            AND NOT selected_hot.tombstone
        ),
        selected_postings AS (
          SELECT selected.article_id AS articleId, list_mode_key.list_mode_key AS listModeKey, selected.tombstone AS tombstone, 'importRoute' AS filterKind, selected.import_route_id AS filterValue
          FROM selected_import_state selected CROSS JOIN list_mode_key_filter list_mode_key
          UNION ALL
          SELECT selected.article_id AS articleId, list_mode_key.list_mode_key AS listModeKey, selected.tombstone AS tombstone, 'publicationYear' AS filterKind, CAST(selected.publication_year AS VARCHAR) AS filterValue
          FROM selected_import_state selected CROSS JOIN list_mode_key_filter list_mode_key
          UNION ALL
          SELECT selected.article_id AS articleId, list_mode_key.list_mode_key AS listModeKey, selected.tombstone AS tombstone, 'duplicateFlag' AS filterKind, CAST(selected.duplicate_flag AS VARCHAR) AS filterValue
          FROM selected_import_state selected CROSS JOIN list_mode_key_filter list_mode_key
          UNION ALL
          SELECT selected.article_id AS articleId, list_mode_key.list_mode_key AS listModeKey, selected.tombstone AS tombstone, 'conflictFlag' AS filterKind, CAST(selected.conflict_flag AS VARCHAR) AS filterValue
          FROM selected_import_state selected CROSS JOIN list_mode_key_filter list_mode_key
        ),
        scoped_serving AS (
          SELECT
            serving.article_id,
            list_mode_key.list_mode_key
          FROM scoped_article scoped
          INNER JOIN mart.review_article_serving_base_v4 serving
            ON serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND serving.article_id = scoped.article_id
          INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state
            ON list_mode_state.project_id = serving.project_id
            AND list_mode_state.review_config_hash = serving.review_config_hash
            AND list_mode_state.snapshot_id = serving.snapshot_id
            AND list_mode_state.article_id = serving.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_contains(list_mode_state.list_mode_keys, list_mode_key.list_mode_key)
        ),
        project_settings AS (
          SELECT COALESCE((SELECT project.human_judgment_mode FROM app.project project WHERE project.id = ${getSqlLiteral(input.projectId)}), 'prompt') AS human_judgment_mode
        ),
        enabled_prompt_count AS (
          SELECT COUNT(*) AS prompt_count
          FROM app.project_prompt project_prompt
          INNER JOIN app.prompt prompt
            ON prompt.id = project_prompt.prompt_id
          WHERE project_prompt.project_id = ${getSqlLiteral(input.projectId)}
            AND project_prompt.enabled
            AND NOT project_prompt.archived
            AND COALESCE(prompt.archived, FALSE) = FALSE
        ),
        judgment_detail_source AS (
          SELECT
            detail.article_id,
            detail.payload_kind,
            detail.prompt_id,
            detail.is_answered,
            detail.answered_original,
            detail.answered_original_as_array,
            detail.placeholder_kind
          FROM scoped_article scoped
          INNER JOIN mart.review_article_judgment_detail_serving_v4 detail
            ON detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND detail.payload_kind IN ('llm', 'human')
            AND detail.article_id = scoped.article_id
        ),
        article_judgment_status AS (
          SELECT
            scoped.article_id,
            COUNT(detail.prompt_id) FILTER (
              WHERE detail.payload_kind = 'llm'
                AND detail.is_answered IS TRUE
            ) AS llm_answered_prompt_count,
            COUNT(detail.prompt_id) FILTER (
              WHERE detail.payload_kind = 'llm'
                AND detail.is_answered IS TRUE
                AND detail.placeholder_kind IS NULL
            ) AS llm_answered_non_placeholder_prompt_count,
            COUNT(detail.prompt_id) FILTER (
              WHERE detail.payload_kind = 'human'
                AND detail.prompt_id <> 'summary'
                AND detail.is_answered IS TRUE
            ) AS human_answered_prompt_count,
            COUNT(detail.prompt_id) FILTER (
              WHERE detail.payload_kind = 'human'
                AND detail.prompt_id = 'summary'
                AND detail.is_answered IS TRUE
            ) AS human_answered_summary_count
          FROM scoped_article scoped
          LEFT JOIN judgment_detail_source detail
            ON detail.article_id = scoped.article_id
          GROUP BY scoped.article_id
        ),
        serving_status_postings AS (
          SELECT
            serving.article_id AS articleId,
            serving.list_mode_key AS listModeKey,
            FALSE AS tombstone,
            'llmStatus' AS filterKind,
            CASE
              WHEN enabled_prompt_count.prompt_count = 0 THEN NULL
              WHEN enabled_prompt_count.prompt_count = article_judgment_status.llm_answered_prompt_count THEN 'answered'
              ELSE 'unanswered'
            END AS filterValue
          FROM scoped_serving serving
          INNER JOIN article_judgment_status
            ON article_judgment_status.article_id = serving.article_id
          CROSS JOIN enabled_prompt_count
          UNION ALL
          SELECT
            serving.article_id AS articleId,
            serving.list_mode_key AS listModeKey,
            FALSE AS tombstone,
            'llmHasJudgment' AS filterKind,
            CAST(article_judgment_status.llm_answered_non_placeholder_prompt_count > 0 AS VARCHAR) AS filterValue
          FROM scoped_serving serving
          INNER JOIN article_judgment_status
            ON article_judgment_status.article_id = serving.article_id
          UNION ALL
          SELECT
            serving.article_id AS articleId,
            serving.list_mode_key AS listModeKey,
            FALSE AS tombstone,
            'humanStatus' AS filterKind,
            CASE
              WHEN project_settings.human_judgment_mode = 'summary' AND article_judgment_status.human_answered_summary_count > 0 THEN 'answered'
              WHEN project_settings.human_judgment_mode = 'summary' THEN 'unanswered'
              WHEN enabled_prompt_count.prompt_count = 0 THEN NULL
              WHEN enabled_prompt_count.prompt_count = article_judgment_status.human_answered_prompt_count THEN 'answered'
              ELSE 'unanswered'
            END AS filterValue
          FROM scoped_serving serving
          INNER JOIN article_judgment_status
            ON article_judgment_status.article_id = serving.article_id
          CROSS JOIN enabled_prompt_count
          CROSS JOIN project_settings
        ),
        llm_detail AS (
          SELECT
            detail.article_id,
            detail.prompt_id,
            list_mode_key.list_mode_key,
            detail.answered_original,
            detail.answered_original_as_array
          FROM judgment_detail_source detail
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key IN ('llm', 'both')
          WHERE detail.payload_kind = 'llm'
        ),
        human_detail AS (
          SELECT
            detail.article_id,
            detail.prompt_id,
            list_mode_key.list_mode_key,
            detail.answered_original
          FROM judgment_detail_source detail
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key IN ('human', 'both')
          WHERE detail.payload_kind = 'human'
        ),
        llm_postings AS (
          SELECT llm.article_id AS articleId, llm.list_mode_key AS listModeKey, FALSE AS tombstone, 'promptAnswer' AS filterKind, concat('review:promptAnswer:', llm.prompt_id, ':', llm.answered_original) AS filterValue
          FROM scoped_article scoped
          INNER JOIN llm_detail llm
            ON llm.article_id = scoped.article_id
            AND llm.answered_original IS NOT NULL
            AND llm.answered_original_as_array IS NULL
          INNER JOIN scoped_serving serving
            ON serving.article_id = llm.article_id
            AND serving.list_mode_key = llm.list_mode_key
          UNION ALL
          SELECT llm.article_id AS articleId, llm.list_mode_key AS listModeKey, FALSE AS tombstone, 'promptAnswer' AS filterKind, concat('review:promptAnswer:', llm.prompt_id, ':', answer.answer_value) AS filterValue
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
          SELECT human.article_id AS articleId, human.list_mode_key AS listModeKey, FALSE AS tombstone, 'promptAnswer' AS filterKind, concat('human:promptAnswer:', human.prompt_id, ':', human.answered_original) AS filterValue
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
        SELECT articleId, filterKind, filterValue, listModeKey, tombstone
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
      ? getArticleRangePredicate({alias: 'serving_article', ...input})
      : `AND list_contains(${getSqlLiteral(articleIds)}::VARCHAR[], serving_article.article_id)`

  return database.queryJson<PostingContributionRow>(`
        SELECT
          serving_article.article_id AS articleId,
          serving.filter_kind AS filterKind,
          serving.filter_value AS filterValue,
          serving.list_mode_key AS listModeKey,
          FALSE AS tombstone
        FROM mart.review_article_filter_posting_serving_v4 serving
        CROSS JOIN UNNEST(serving.article_ids) AS serving_article(article_id)
        WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${articlePredicate}
      `)
}

const getArticleIdsArraySql = (articleIds: readonly string[]) => {
  return `${getSqlLiteral(articleIds)}::VARCHAR[]`
}

const getCompactPostingValuesSql = (rows: readonly CompactPostingRow[]) => {
  return rows
    .map((row) => {
      return `(${getSqlLiteral(row.filterKind)}, ${getSqlLiteral(row.filterValue)}, ${getSqlLiteral(row.listModeKey)}, ${getArticleIdsArraySql(row.articleIds)})`
    })
    .join(', ')
}

const getMergePostingArticleIdsSql = (incomingArticleIdsSql: string, existingArticleIdsSql: string) => {
  return `(SELECT LIST(DISTINCT article_id ORDER BY article_id) FROM (SELECT UNNEST(COALESCE(${existingArticleIdsSql}, []::VARCHAR[])) AS article_id UNION ALL SELECT UNNEST(${incomingArticleIdsSql}) AS article_id))`
}

const getDeleteServingRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  tombstoneRows: readonly PostingContributionRow[],
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const tombstoneValues = getCompactPostingRows(tombstoneRows)
    .map((row) => {
      return `(${getSqlLiteral(row.filterKind)}, ${getSqlLiteral(row.filterValue)}, ${getSqlLiteral(row.listModeKey)}, ${getArticleIdsArraySql(row.articleIds)})`
    })
    .join(', ')

  return articleIds.length > 0
    ? [
        `UPDATE mart.review_article_filter_posting_serving_v4 serving
        SET article_ids = list_filter(article_ids, article_id -> NOT list_contains(${getArticleIdsArraySql(articleIds)}, article_id))
        WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND list_has_any(serving.article_ids, ${getArticleIdsArraySql(articleIds)})`,
        `DELETE FROM mart.review_article_filter_posting_serving_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND length(article_ids) = 0`,
      ]
    : hasChunkArticleRange(input)
      ? [
          `UPDATE mart.review_article_filter_posting_serving_v4 serving
        SET article_ids = list_filter(article_ids, article_id -> NOT (
          ${input.chunkStartArticleId === undefined || input.chunkStartArticleId === null ? 'TRUE' : `article_id >= ${getSqlLiteral(input.chunkStartArticleId)}`}
          AND ${input.chunkEndArticleId === undefined || input.chunkEndArticleId === null ? 'TRUE' : `article_id <= ${getSqlLiteral(input.chunkEndArticleId)}`}
        ))
        WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}`,
          `DELETE FROM mart.review_article_filter_posting_serving_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND length(article_ids) = 0`,
        ]
      : tombstoneValues.length === 0
        ? []
        : [
            `WITH deleted(filter_kind, filter_value, list_mode_key, article_ids) AS (
          SELECT * FROM (VALUES ${tombstoneValues})
        )
        UPDATE mart.review_article_filter_posting_serving_v4 serving
        SET article_ids = list_filter(serving.article_ids, article_id -> NOT list_contains(deleted.article_ids, article_id))
        USING deleted
        WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND serving.filter_kind = deleted.filter_kind
          AND serving.filter_value = deleted.filter_value
          AND serving.list_mode_key = deleted.list_mode_key
          AND list_has_any(serving.article_ids, deleted.article_ids)`,
            `DELETE FROM mart.review_article_filter_posting_serving_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND length(article_ids) = 0`,
          ]
}

const getResetListModeStateRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  options: {resetAllWhenUnscoped?: boolean} = {},
) => {
  const articleIds = getClaimArticleIds(input.claims)

  return articleIds.length > 0
    ? `UPDATE mart.review_article_serving_list_mode_state_v4 state
        SET duplicate_flag = FALSE,
            conflict_flag = FALSE,
            llm_status = NULL,
            human_status = NULL,
            llm_has_judgment = FALSE
        WHERE state.project_id = ${getSqlLiteral(input.projectId)}
          AND state.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND state.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND state.article_id IN (${articleIds
            .map((articleId) => {
              return getSqlLiteral(articleId)
            })
            .join(', ')})`
    : hasChunkArticleRange(input)
      ? `UPDATE mart.review_article_serving_list_mode_state_v4 state
        SET duplicate_flag = FALSE,
            conflict_flag = FALSE,
            llm_status = NULL,
            human_status = NULL,
            llm_has_judgment = FALSE
        WHERE state.project_id = ${getSqlLiteral(input.projectId)}
          AND state.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND state.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${getArticleRangePredicate({alias: 'state', ...input})}`
      : options.resetAllWhenUnscoped === true
        ? `UPDATE mart.review_article_serving_list_mode_state_v4 state
        SET duplicate_flag = FALSE,
            conflict_flag = FALSE,
            llm_status = NULL,
            human_status = NULL,
            llm_has_judgment = FALSE
        WHERE state.project_id = ${getSqlLiteral(input.projectId)}
          AND state.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND state.snapshot_id = ${getSqlLiteral(input.snapshotId)}`
        : null
}

const getResetListModeStateRangeRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  ranges: readonly ProjectReviewServingFilterPostingsInput[],
) => {
  if (ranges.length === 0) {
    return getResetListModeStateRowsStatement(input)
  }

  return `WITH ${getRangeValuesCte(ranges)}
    UPDATE mart.review_article_serving_list_mode_state_v4 state
    SET duplicate_flag = FALSE,
        conflict_flag = FALSE,
        llm_status = NULL,
        human_status = NULL,
        llm_has_judgment = FALSE
    FROM article_range_filter range_filter
    WHERE state.project_id = ${getSqlLiteral(input.projectId)}
      AND state.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND state.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND (range_filter.chunk_start_article_id IS NULL OR state.article_id >= range_filter.chunk_start_article_id)
      AND (range_filter.chunk_end_article_id IS NULL OR state.article_id <= range_filter.chunk_end_article_id)`
}

const getInsertFullRebuildServingRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  ranges?: readonly ProjectReviewServingFilterPostingsInput[],
  postingSourceSql = getFullRebuildPostingContributionRowsStatement(input, ranges),
) => {
  return `INSERT INTO mart.review_article_filter_posting_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      filter_kind,
      filter_value,
      list_mode_key,
      article_ids
    )
    WITH posting_source AS (${postingSourceSql}),
    serving_source AS (
      SELECT
        CAST(posting.filterKind AS VARCHAR) AS filterKind,
        CAST(posting.filterValue AS VARCHAR) AS filterValue,
        CAST(posting.listModeKey AS VARCHAR) AS listModeKey,
        LIST(DISTINCT CAST(posting.articleId AS VARCHAR) ORDER BY CAST(posting.articleId AS VARCHAR)) AS articleIds
      FROM posting_source posting
      WHERE NOT posting.tombstone
        AND posting.filterKind NOT IN ('duplicateFlag', 'conflictFlag', 'llmStatus', 'humanStatus', 'llmHasJudgment')
      GROUP BY
        CAST(posting.filterKind AS VARCHAR),
        CAST(posting.filterValue AS VARCHAR),
        CAST(posting.listModeKey AS VARCHAR)
    )
    SELECT
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      posting.filterKind AS filter_kind,
      posting.filterValue AS filter_value,
      posting.listModeKey AS list_mode_key,
      posting.articleIds AS article_ids
    FROM serving_source posting
    ON CONFLICT(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key) DO UPDATE SET
      article_ids = ${getMergePostingArticleIdsSql('excluded.article_ids', 'mart.review_article_filter_posting_serving_v4.article_ids')}`
}

const getInsertCompactServingRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  rows: readonly CompactPostingRow[],
) => {
  if (rows.length === 0) {
    return null
  }

  return `INSERT INTO mart.review_article_filter_posting_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      filter_kind,
      filter_value,
      list_mode_key,
      article_ids
    )
    SELECT
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      row.filter_kind,
      row.filter_value,
      row.list_mode_key,
      row.article_ids
    FROM (VALUES ${getCompactPostingValuesSql(rows)}) AS row(filter_kind, filter_value, list_mode_key, article_ids)
    ON CONFLICT(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key) DO UPDATE SET
      article_ids = ${getMergePostingArticleIdsSql('excluded.article_ids', 'mart.review_article_filter_posting_serving_v4.article_ids')}`
}

const getFilterStateValuesSql = (rows: readonly FilterStateServingRow[]) => {
  return rows
    .map((row) => {
      return `(${getSqlLiteral(row.articleId)}, ${row.duplicateFlag ? 'TRUE' : 'FALSE'}, ${row.conflictFlag ? 'TRUE' : 'FALSE'}, ${getSqlLiteral(row.llmStatus)}, ${getSqlLiteral(row.humanStatus)}, ${row.llmHasJudgment ? 'TRUE' : 'FALSE'})`
    })
    .join(', ')
}

const getUpdateCompactListModeStateRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  rows: readonly FilterStateServingRow[],
) => {
  if (rows.length === 0) {
    return null
  }

  return `UPDATE mart.review_article_serving_list_mode_state_v4 state
    SET duplicate_flag = incoming.duplicate_flag,
        conflict_flag = incoming.conflict_flag,
        llm_status = incoming.llm_status,
        human_status = incoming.human_status,
        llm_has_judgment = incoming.llm_has_judgment
    FROM (VALUES ${getFilterStateValuesSql(rows)}) AS incoming(article_id, duplicate_flag, conflict_flag, llm_status, human_status, llm_has_judgment)
    WHERE state.project_id = ${getSqlLiteral(input.projectId)}
      AND state.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND state.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND state.article_id = incoming.article_id`
}

const getUpdateFullRebuildListModeStateRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  ranges?: readonly ProjectReviewServingFilterPostingsInput[],
  postingSourceSql = getFullRebuildPostingContributionRowsStatement(input, ranges),
) => {
  return `WITH posting_source AS (${postingSourceSql}),
    state_source AS (
      SELECT
        CAST(posting.articleId AS VARCHAR) AS articleId,
        COALESCE(BOOL_OR(posting.filterKind = 'duplicateFlag' AND posting.filterValue = 'true'), FALSE) AS duplicateFlag,
        COALESCE(BOOL_OR(posting.filterKind = 'conflictFlag' AND posting.filterValue = 'true'), FALSE) AS conflictFlag,
        MAX(CASE WHEN posting.filterKind = 'llmStatus' THEN posting.filterValue END) AS llmStatus,
        MAX(CASE WHEN posting.filterKind = 'humanStatus' THEN posting.filterValue END) AS humanStatus,
        COALESCE(BOOL_OR(posting.filterKind = 'llmHasJudgment' AND posting.filterValue = 'true'), FALSE) AS llmHasJudgment
      FROM posting_source posting
      WHERE NOT posting.tombstone
        AND posting.filterKind IN ('duplicateFlag', 'conflictFlag', 'llmStatus', 'humanStatus', 'llmHasJudgment')
      GROUP BY
        CAST(posting.articleId AS VARCHAR)
    )
    UPDATE mart.review_article_serving_list_mode_state_v4 state
    SET duplicate_flag = COALESCE(source.duplicateFlag, FALSE),
        conflict_flag = COALESCE(source.conflictFlag, FALSE),
        llm_status = source.llmStatus,
        human_status = source.humanStatus,
        llm_has_judgment = COALESCE(source.llmHasJudgment, FALSE)
    FROM state_source source
    WHERE state.project_id = ${getSqlLiteral(input.projectId)}
      AND state.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND state.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND state.article_id = source.articleId`
}

const fullRebuildPostingSourceTempTable = 'review_filter_posting_source_v4'
const getCreateFullRebuildPostingSourceStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  ranges?: readonly ProjectReviewServingFilterPostingsInput[],
) => {
  return `CREATE OR REPLACE TEMP TABLE ${fullRebuildPostingSourceTempTable} AS
    ${getFullRebuildPostingContributionRowsStatement(input, ranges)}`
}

const getDropFullRebuildPostingSourceStatement = () => {
  return `DROP TABLE IF EXISTS ${fullRebuildPostingSourceTempTable}`
}

const getFullRebuildPostingSourceSelectSql = () => {
  return `SELECT * FROM ${fullRebuildPostingSourceTempTable}`
}

const getFullRebuildWriteStatements = (input: ProjectReviewServingFilterPostingsInput) => {
  return input.listModeKeys.length === 0
    ? []
    : [
        getCreateFullRebuildPostingSourceStatement(input),
        getInsertFullRebuildServingRowsStatement(input, undefined, getFullRebuildPostingSourceSelectSql()),
        getResetListModeStateRowsStatement(input, {resetAllWhenUnscoped: true}),
        getUpdateFullRebuildListModeStateRowsStatement(input, undefined, getFullRebuildPostingSourceSelectSql()),
        getDropFullRebuildPostingSourceStatement(),
      ]
}

const getFullRebuildRangeWriteStatements = (input: ProjectReviewServingFilterPostingRangesInput) => {
  const firstRange = input.ranges[0]

  if (firstRange === undefined) {
    return []
  }

  return firstRange.listModeKeys.length === 0
    ? []
    : [
        getCreateFullRebuildPostingSourceStatement(firstRange, input.ranges),
        getInsertFullRebuildServingRowsStatement(firstRange, undefined, getFullRebuildPostingSourceSelectSql()),
        getResetListModeStateRangeRowsStatement(firstRange, input.ranges),
        getUpdateFullRebuildListModeStateRowsStatement(firstRange, undefined, getFullRebuildPostingSourceSelectSql()),
        getDropFullRebuildPostingSourceStatement(),
      ]
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

const getNonNegativeFiniteNumber = (value: number | string | null | undefined) => {
  const numberValue = typeof value === 'string' ? Number(value) : value

  return Math.max(
    0,
    numberValue === null || numberValue === undefined || !Number.isFinite(numberValue) ? 0 : numberValue,
  )
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
    CROSS JOIN UNNEST(serving.article_ids) AS serving_article(article_id)
    WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
      AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      ${getArticleRangePredicate({alias: 'serving_article', ...input})}
  `)
  const [stateRow] = await database.queryJson<PostingValidationCountRow>(`
    SELECT
      CAST(COUNT(*) AS INTEGER) AS actualCount,
      sha256('cheap-count:' || CAST(COUNT(*) AS VARCHAR)) AS actualChecksum
    FROM mart.review_article_serving_list_mode_state_v4 state
    WHERE state.project_id = ${getSqlLiteral(input.projectId)}
      AND state.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND state.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      ${getArticleRangePredicate({alias: 'state', ...input})}
  `)
  const actualCount = getNonNegativeFiniteNumber(row?.actualCount) + getNonNegativeFiniteNumber(stateRow?.actualCount)
  const actualChecksum = getCheapCountChecksum(actualCount)

  return {
    actualChecksum,
    actualCount,
    diagnosticsJson: {validationMode: 'post-write-serving-count'},
    expectedChecksum: actualChecksum,
    expectedCount: actualCount,
  }
}

const getFilterStateRows = (rows: readonly PostingContributionRow[]) => {
  const stateRows = new Map<string, FilterStateServingRow>()

  const maxStatus = (left: string | null, right: string | null) => {
    if (left === null) {
      return right
    }

    if (right === null) {
      return left
    }

    return left > right ? left : right
  }

  for (const row of rows) {
    if (!isStateFilterKind(row.filterKind)) {
      continue
    }

    const key = getStateContributionKey(row)
    const stateRow =
      stateRows.get(key)
      ?? ({
        articleId: row.articleId,
        conflictFlag: false,
        duplicateFlag: false,
        humanStatus: null,
        llmHasJudgment: false,
        listModeKey: 'all',
        llmStatus: null,
        tombstone: row.tombstone,
      } satisfies FilterStateServingRow)

    if (row.filterKind === 'duplicateFlag') {
      stateRow.duplicateFlag = stateRow.duplicateFlag || row.filterValue === 'true'
    } else if (row.filterKind === 'conflictFlag') {
      stateRow.conflictFlag = stateRow.conflictFlag || row.filterValue === 'true'
    } else if (row.filterKind === 'llmStatus') {
      stateRow.llmStatus = maxStatus(stateRow.llmStatus, row.filterValue)
    } else if (row.filterKind === 'humanStatus') {
      stateRow.humanStatus = maxStatus(stateRow.humanStatus, row.filterValue)
    } else if (row.filterKind === 'llmHasJudgment') {
      stateRow.llmHasJudgment = stateRow.llmHasJudgment || row.filterValue === 'true'
    }

    stateRow.tombstone = stateRow.tombstone && row.tombstone
    stateRows.set(key, stateRow)
  }

  return [...stateRows.values()]
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
      validationResult,
    }
  }

  const [existingRows, newRows] = await measure('sourceQueryMs', async () => {
    return Promise.all([getExistingPostingRows(input, database), getPostingContributionRows(input, database)])
  })
  const {contributionRows, liveRows} = measureSync('diffInputTransformMs', () => {
    const genericNewRows = newRows.filter((row) => {
      return !isStateFilterKind(row.filterKind)
    })
    const transformedContributionRows = [
      ...genericNewRows,
      ...getTombstoneRows({existingRows, newRows: genericNewRows}),
    ]
    const transformedLiveRows = transformedContributionRows.filter((row) => {
      return !row.tombstone
    })

    return {contributionRows: transformedContributionRows, liveRows: transformedLiveRows}
  })
  const {compactServingRows, stateRows} = measureSync('recordTransformMs', () => {
    const nextCompactServingRows = getCompactPostingRows(liveRows)
    const nextStateRows = getFilterStateRows(newRows).filter((row) => {
      return !row.tombstone
    })

    return {compactServingRows: nextCompactServingRows, stateRows: nextStateRows}
  })
  const servingRowCount = compactServingRows.length + stateRows.length
  const {writeStatements} = measureSync('deleteStatementBuildMs', () => {
    const nextDeleteServingRowsStatement = getDeleteServingRowsStatement(
      input,
      contributionRows.filter((row) => {
        return row.tombstone
      }),
    )
    const nextInsertServingRowsStatement = getInsertCompactServingRowsStatement(input, compactServingRows)
    const nextResetStateRowsStatement = getResetListModeStateRowsStatement(input)
    const nextUpdateStateRowsStatement = getUpdateCompactListModeStateRowsStatement(input, stateRows)

    return {
      writeStatements: [
        ...nextDeleteServingRowsStatement,
        nextInsertServingRowsStatement,
        nextResetStateRowsStatement,
        nextUpdateStateRowsStatement,
      ].flatMap((statement) => {
        return statement === null ? [] : [statement]
      }),
    }
  })
  const writerResult = await measure('writerMs', async () => {
    const shouldAcknowledgeClaims = input.claims.length > 0 && input.acknowledgeClaims !== false

    return writeReviewServingProjectorComponent(
      {
        acknowledgements: shouldAcknowledgeClaims ? input.claims : [],
        component: 'posting',
        projectionManifests: shouldAcknowledgeClaims ? [getPostingManifest(input)] : [],
        records: [],
        repairDirtyWork: [],
        statements: writeStatements,
        watermark: !shouldAcknowledgeClaims
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
        contributionRecordCount: 0,
        contributionRowCount: contributionRows.length,
        existingRowCount: existingRows.length,
        liveRowCount: liveRows.length,
        newRowCount: newRows.length,
        stateRowCount: stateRows.length,
        writer: writerResult.diagnostics,
      },
    },
    patchRowCount: 0,
    patchWatermark,
    repairRequired: false,
    servingRowCount,
    validationResult: undefined,
  }
}

export const projectReviewServingFilterPostingRanges = async (
  input: ProjectReviewServingFilterPostingRangesInput,
  database: ReviewServingFilterPostingProjectorDatabase = getAppDatabaseService() as ReviewServingFilterPostingProjectorDatabase,
) => {
  const phaseTimings: Record<string, number> = {}
  const measure = async <T>(phase: string, operation: () => Promise<T>) => {
    const startedAtMs = Date.now()
    const result = await operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }
  const firstRange = input.ranges[0]

  if (firstRange === undefined) {
    return {
      diagnosticsJson: {phaseTimings, postingProjector: {fullRebuildMode: 'range-set-based', rangeCount: 0}},
      patchRowCount: 0,
      servingRowCount: 0,
      validationResult: undefined,
    }
  }

  const writerResult = await measure('writerMs', async () => {
    return writeReviewServingProjectorComponent(
      {
        acknowledgements: [],
        component: 'posting',
        projectionManifests: [],
        records: [],
        repairDirtyWork: [],
        statements: getFullRebuildRangeWriteStatements(input),
      },
      database,
    )
  })

  return {
    diagnosticsJson: {
      phaseTimings,
      postingProjector: {
        fullRebuildMode: 'range-set-based',
        rangeCount: input.ranges.length,
        writer: writerResult.diagnostics,
      },
    },
    patchRowCount: 0,
    servingRowCount: 0,
    validationResult: undefined,
  }
}

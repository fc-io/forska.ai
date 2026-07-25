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
}

export type ProjectReviewServingFilterPostingRangesInput = {ranges: readonly ProjectReviewServingFilterPostingsInput[]}

type PostingContributionRow = {
  articleId: string
  filterKind: string
  filterValue: string
  listModeKey: string
  tombstone: boolean
}

type PostingValidationCountRow = {actualChecksum: string | null; actualCount: number | string | null}

const filterPostingProjectorName = 'filter-posting-projector'
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
          SELECT serving.article_id AS articleId, serving.list_mode_key AS listModeKey, FALSE AS tombstone, 'llmStatus' AS filterKind, serving.llm_status_key AS filterValue
          FROM scoped_serving serving
          UNION ALL
          SELECT serving.article_id AS articleId, serving.list_mode_key AS listModeKey, FALSE AS tombstone, 'humanStatus' AS filterKind, serving.human_status_key AS filterValue
          FROM scoped_serving serving
        ),
        project_settings AS (
          SELECT COALESCE((SELECT project.human_judgment_mode FROM app.project project WHERE project.id = ${getSqlLiteral(input.projectId)}), 'prompt') AS human_judgment_mode
        ),
        llm_detail AS (
          SELECT
            detail.article_id,
            detail.prompt_id,
            list_mode_key.list_mode_key,
            detail.answered_original,
            detail.answered_original_as_array
          FROM scoped_article scoped
          INNER JOIN mart.review_article_judgment_detail_serving_v4 detail
            ON detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND detail.payload_kind = 'llm'
            AND detail.list_mode_key = 'llm'
            AND detail.article_id = scoped.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key IN ('llm', 'both')
        ),
        human_detail AS (
          SELECT
            detail.article_id,
            detail.prompt_id,
            list_mode_key.list_mode_key,
            detail.answered_original
          FROM scoped_article scoped
          INNER JOIN mart.review_article_judgment_detail_serving_v4 detail
            ON detail.project_id = ${getSqlLiteral(input.projectId)}
            AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
            AND detail.payload_kind = 'human'
            AND detail.list_mode_key = 'human'
            AND detail.article_id = scoped.article_id
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key IN ('human', 'both')
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
          FALSE AS tombstone
        FROM mart.review_article_filter_posting_serving_v4 serving
        WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
          AND serving.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND serving.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${articlePredicate}
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
      project_id: input.projectId,
      review_config_hash: input.reviewConfigHash,
      snapshot_id: input.snapshotId,
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

const getInsertFullRebuildServingRowsStatement = (
  input: ProjectReviewServingFilterPostingsInput,
  ranges?: readonly ProjectReviewServingFilterPostingsInput[],
) => {
  return `INSERT INTO mart.review_article_filter_posting_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      filter_kind,
      filter_value,
      list_mode_key,
      article_id
    )
    WITH posting_source AS (${getFullRebuildPostingContributionRowsStatement(input, ranges)}),
    serving_source AS (
      SELECT
        CAST(posting.filterKind AS VARCHAR) AS filterKind,
        CAST(posting.filterValue AS VARCHAR) AS filterValue,
        CAST(posting.listModeKey AS VARCHAR) AS listModeKey,
        CAST(posting.articleId AS VARCHAR) AS articleId
      FROM posting_source posting
      WHERE NOT posting.tombstone
      GROUP BY
        CAST(posting.filterKind AS VARCHAR),
        CAST(posting.filterValue AS VARCHAR),
        CAST(posting.listModeKey AS VARCHAR),
        CAST(posting.articleId AS VARCHAR)
    )
    SELECT
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      posting.filterKind AS filter_kind,
      posting.filterValue AS filter_value,
      posting.listModeKey AS list_mode_key,
      posting.articleId AS article_id
    FROM serving_source posting
    ON CONFLICT(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, article_id) DO NOTHING`
}

const getFullRebuildWriteStatements = (input: ProjectReviewServingFilterPostingsInput) => {
  return input.listModeKeys.length === 0 ? [] : [getInsertFullRebuildServingRowsStatement(input)]
}

const getFullRebuildRangeWriteStatements = (input: ProjectReviewServingFilterPostingRangesInput) => {
  const firstRange = input.ranges[0]

  if (firstRange === undefined) {
    return []
  }

  return firstRange.listModeKeys.length === 0
    ? []
    : [getInsertFullRebuildServingRowsStatement(firstRange, input.ranges)]
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
  const {deleteServingRowsStatement} = measureSync('deleteStatementBuildMs', () => {
    const nextDeleteServingRowsStatement = getDeleteServingRowsStatement(
      input,
      contributionRows.filter((row) => {
        return row.tombstone
      }),
    )

    return {deleteServingRowsStatement: nextDeleteServingRowsStatement}
  })
  const writerResult = await measure('writerMs', async () => {
    const shouldAcknowledgeClaims = input.claims.length > 0 && input.acknowledgeClaims !== false

    return writeReviewServingProjectorComponent(
      {
        acknowledgements: shouldAcknowledgeClaims ? input.claims : [],
        component: 'posting',
        projectionManifests: shouldAcknowledgeClaims ? [getPostingManifest(input)] : [],
        records: servingRecords,
        repairDirtyWork: [],
        statements: [deleteServingRowsStatement].flatMap((statement) => {
          return statement === null ? [] : [statement]
        }),
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

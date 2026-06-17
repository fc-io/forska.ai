import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import {
  prepareReviewServingContributionDiff,
  type ReviewServingContributionDiff,
  type ReviewServingContributionRow,
} from './reviewServingContributionService.ts'
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

export type ReviewServingFilterPostingProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingFilterPostingsInput = {
  baseGeneration: number
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

type PostingContributionRow = {
  articleId: string
  filterKind: string
  filterValue: string
  listModeKey: string
  sortKey: Date | string
  tombstone: boolean
}

type PostingStatsRow = {cardinality: number | null; filterKind: string; filterValue: string; listModeKey: string}

type PostingTotalRow = {listModeKey: string; totalArticleCount: number | null}

const filterPostingProjectorName = 'filter-posting-projector'
const stalePostingSortAt = '1970-01-01T00:00:00.000Z'

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

const getExpectedArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[], rows: readonly PostingContributionRow[]) => {
  const claimArticleIds = getClaimArticleIds(claims)

  return claimArticleIds.length > 0
    ? claimArticleIds
    : [
        ...new Set(
          rows.map((row) => {
            return row.articleId
          }),
        ),
      ]
}

const getClaimPromptIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.scopeKind === 'prompt' ? (claim.scopeId.split(':').at(-1) ?? null) : null
        })
        .filter((promptId) => {
          return promptId !== null && promptId.trim().length > 0
        }) as string[],
    ),
  ]
}

const getLatestHumanPatchPredicate = (alias: string) => {
  return `NOT EXISTS (
              SELECT 1
              FROM mart.review_human_status_patch_v4 newer
              WHERE newer.project_id = ${alias}.project_id
                AND newer.prompt_config_hash = ${alias}.prompt_config_hash
                AND newer.base_generation = ${alias}.base_generation
                AND newer.article_id = ${alias}.article_id
                AND newer.prompt_id IS NOT DISTINCT FROM ${alias}.prompt_id
                AND newer.list_mode_key = ${alias}.list_mode_key
                AND newer.patch_watermark > ${alias}.patch_watermark
            )`
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

const getDirtyArticleCte = (projectId: string, articleIds: readonly string[]) => {
  return articleIds.length > 0
    ? getValuesCte('article_id', articleIds)
    : `article_id_filter(article_id) AS (
        SELECT scope.article_id
        FROM mart.project_scope_article scope
        WHERE scope.project_id = ${getSqlLiteral(projectId)}
      )`
}

const getPostingContributionRows = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)

  return input.listModeKeys.length === 0
    ? []
    : database.queryJson<PostingContributionRow>(`
        WITH ${getDirtyArticleCte(input.projectId, articleIds)},
        ${getListModeCte(input.listModeKeys)},
        scoped_article AS (
          SELECT
            scope.article_id,
            COALESCE(scope.article_updated_at, scope.source_updated_at, scope.article_created_at, TIMESTAMPTZ ${getSqlLiteral(stalePostingSortAt)}) AS sort_key,
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
            CASE WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL ELSE COALESCE(selected_patch.import_route_id, selected_base.import_route_id) END AS import_route_id,
            CASE WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL ELSE COALESCE(selected_patch.selected_rank_key, selected_base.selected_rank_key) END AS selected_rank_key,
            CASE WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN NULL ELSE COALESCE(selected_patch.publication_year, selected_base.publication_year) END AS publication_year,
            CASE WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN FALSE ELSE COALESCE(selected_patch.duplicate_flag, selected_base.duplicate_flag, FALSE) END AS duplicate_flag,
            CASE WHEN COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) THEN FALSE ELSE COALESCE(selected_patch.conflict_flag, selected_base.conflict_flag, FALSE) END AS conflict_flag,
            scoped.scope_tombstone AS tombstone
          FROM scoped_article scoped
          LEFT JOIN app.review_selected_article_import_v4 selected_base
            ON selected_base.project_id = ${getSqlLiteral(input.projectId)}
            AND selected_base.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
            AND selected_base.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND selected_base.article_id = scoped.article_id
          LEFT JOIN mart.review_selected_import_patch_v4 selected_patch
            ON selected_patch.project_id = ${getSqlLiteral(input.projectId)}
            AND selected_patch.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
            AND selected_patch.selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
            AND selected_patch.article_id = scoped.article_id
            AND selected_patch.patch_watermark = (
              SELECT MAX(newer.patch_watermark)
              FROM mart.review_selected_import_patch_v4 newer
              WHERE newer.project_id = selected_patch.project_id
                AND newer.project_scope_identity = selected_patch.project_scope_identity
                AND newer.selected_import_snapshot_id = selected_patch.selected_import_snapshot_id
                AND newer.article_id = selected_patch.article_id
            )
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
        llm_postings AS (
          SELECT llm.article_id AS articleId, llm.list_mode_key AS listModeKey, COALESCE(llm.latest_llm_created_at, scoped.sort_key) AS sortKey, llm.tombstone OR scoped.scope_tombstone AS tombstone, 'llmStatus' AS filterKind, llm.llm_status_key AS filterValue
          FROM scoped_article scoped
          INNER JOIN mart.review_llm_status_patch_v4 llm
            ON llm.project_id = ${getSqlLiteral(input.projectId)}
            AND llm.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND llm.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND llm.article_id = scoped.article_id
            AND NOT EXISTS (
              SELECT 1
              FROM mart.review_llm_status_patch_v4 newer
              WHERE newer.project_id = llm.project_id
                AND newer.review_config_hash = llm.review_config_hash
                AND newer.base_generation = llm.base_generation
                AND newer.article_id = llm.article_id
                AND newer.prompt_id = llm.prompt_id
                AND newer.list_mode_key = llm.list_mode_key
                AND newer.patch_watermark > llm.patch_watermark
            )
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = llm.list_mode_key
          UNION ALL
          SELECT llm.article_id AS articleId, llm.list_mode_key AS listModeKey, COALESCE(llm.latest_llm_created_at, scoped.sort_key) AS sortKey, llm.tombstone OR scoped.scope_tombstone AS tombstone, 'promptAnswer' AS filterKind, llm.answered_original AS filterValue
          FROM scoped_article scoped
          INNER JOIN mart.review_llm_status_patch_v4 llm
            ON llm.project_id = ${getSqlLiteral(input.projectId)}
            AND llm.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
            AND llm.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND llm.article_id = scoped.article_id
            AND NOT EXISTS (
              SELECT 1
              FROM mart.review_llm_status_patch_v4 newer
              WHERE newer.project_id = llm.project_id
                AND newer.review_config_hash = llm.review_config_hash
                AND newer.base_generation = llm.base_generation
                AND newer.article_id = llm.article_id
                AND newer.prompt_id = llm.prompt_id
                AND newer.list_mode_key = llm.list_mode_key
                AND newer.patch_watermark > llm.patch_watermark
            )
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = llm.list_mode_key
        ),
        human_postings AS (
          SELECT human.article_id AS articleId, human.list_mode_key AS listModeKey, COALESCE(human.latest_human_updated_at, scoped.sort_key) AS sortKey, human.tombstone OR scoped.scope_tombstone AS tombstone, 'humanStatus' AS filterKind, human.human_status_key AS filterValue
          FROM scoped_article scoped
          INNER JOIN mart.review_human_status_patch_v4 human
            ON human.project_id = ${getSqlLiteral(input.projectId)}
            AND human.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND human.article_id = scoped.article_id
            AND ${getLatestHumanPatchPredicate('human')}
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = human.list_mode_key
          UNION ALL
          SELECT human.article_id AS articleId, human.list_mode_key AS listModeKey, COALESCE(human.latest_human_updated_at, scoped.sort_key) AS sortKey, human.tombstone OR scoped.scope_tombstone AS tombstone, 'promptAnswer' AS filterKind, human.human_answered_value AS filterValue
          FROM scoped_article scoped
          INNER JOIN mart.review_human_status_patch_v4 human
            ON human.project_id = ${getSqlLiteral(input.projectId)}
            AND human.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND human.article_id = scoped.article_id
            AND ${getLatestHumanPatchPredicate('human')}
          INNER JOIN list_mode_key_filter list_mode_key
            ON list_mode_key.list_mode_key = human.list_mode_key
        ),
        posting_union AS (
          SELECT * FROM selected_postings
          UNION ALL SELECT * FROM llm_postings
          UNION ALL SELECT * FROM human_postings
        )
        SELECT articleId, filterKind, filterValue, listModeKey, sortKey, tombstone
        FROM posting_union
        WHERE filterValue IS NOT NULL
        ORDER BY listModeKey ASC, filterKind ASC, filterValue ASC, articleId ASC
      `)
}

const getExistingPostingRows = async (
  input: ProjectReviewServingFilterPostingsInput,
  database: ReviewServingFilterPostingProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const articlePredicate =
    articleIds.length === 0
      ? ''
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

const getPostingPatchRecord = (input: {
  baseGeneration: number
  patchWatermark: number
  projectId: string
  row: PostingContributionRow
}): ReviewServingProjectorRecord => {
  return {
    keyColumns: [
      'project_id',
      'posting_identity',
      'base_generation',
      'patch_watermark',
      'filter_kind',
      'filter_value',
      'list_mode_key',
      'article_id',
    ],
    table: 'mart.review_article_filter_posting_patch_v4',
    values: {
      article_id: input.row.articleId,
      base_generation: input.baseGeneration,
      filter_kind: input.row.filterKind,
      filter_value: input.row.filterValue,
      list_mode_key: input.row.listModeKey,
      patch_updated_at: new Date(),
      patch_watermark: input.patchWatermark,
      posting_identity: getPostingIdentity(input.row),
      project_id: input.projectId,
      sort_key: input.row.sortKey,
      tombstone: input.row.tombstone,
    },
  }
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

const getDeleteServingRowsStatement = (input: ProjectReviewServingFilterPostingsInput) => {
  const articleIds = getClaimArticleIds(input.claims)
  const promptIds = getClaimPromptIds(input.claims)

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
    : promptIds.length === 0
      ? null
      : getDeleteReviewServingProjectorRowsStatement({
          predicates: {
            project_id: input.projectId,
            review_config_hash: input.reviewConfigHash,
            snapshot_id: input.snapshotId,
          },
          table: 'mart.review_article_filter_posting_serving_v4',
        })
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

const getStatsRecords = async (input: {
  database: ReviewServingFilterPostingProjectorDatabase
  diffs: readonly ReviewServingContributionDiff[]
  rows: readonly PostingContributionRow[]
  projectorInput: ProjectReviewServingFilterPostingsInput
}) => {
  const changedDiffs = input.diffs.filter((diff) => {
    return diff.delta !== 0
  })
  const [existingStatsRows, totalRows] = await Promise.all([
    getExistingStatsRows(
      input.projectorInput,
      input.database,
      changedDiffs.map((diff) => {
        return diff.contributionKey
      }),
    ),
    getPostingTotalRows(input.projectorInput, input.database),
  ])
  const statsRowsByKey = new Map(
    existingStatsRows.map((row) => {
      return [getContributionStatsKey(row), row]
    }),
  )
  const totalRowsByListMode = new Map(
    totalRows.map((row) => {
      return [row.listModeKey, row.totalArticleCount ?? 0]
    }),
  )
  const rowsByKey = new Map(
    input.rows.map((row) => {
      return [getContributionStatsKey(row), row]
    }),
  )

  return changedDiffs.flatMap((diff) => {
    const row = rowsByKey.get(diff.contributionKey)
    const existingCardinality = statsRowsByKey.get(diff.contributionKey)?.cardinality ?? 0
    const cardinality = Math.max(0, existingCardinality + diff.delta)

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
  database: ReviewServingFilterPostingProjectorDatabase = getAppDatabaseService(),
) => {
  const [existingRows, newRows] = await Promise.all([
    getExistingPostingRows(input, database),
    getPostingContributionRows(input, database),
  ])
  const patchWatermark = getPatchWatermark(input.claims)
  const contributionRows = [...newRows, ...getTombstoneRows({existingRows, newRows})]
  const liveRows = contributionRows.filter((row) => {
    return !row.tombstone
  })
  const contributionDiff = await prepareReviewServingContributionDiff(
    {
      claims: input.claims,
      componentKind: 'posting',
      expectedArticleIds: getExpectedArticleIds(input.claims, contributionRows),
      newRows: getPostingRowsAsContributionRows(liveRows),
      projectId: input.projectId,
      projectionComponent: 'posting',
      projectionIdentity: input.projectionIdentity,
      requireExistingState: existingRows.length > 0,
      reviewConfigHash: input.reviewConfigHash,
      snapshotId: input.snapshotId,
      summaryDefinitionVersion: input.definitionVersion,
    },
    database,
  )
  const patchRecords = contributionRows.map((row) => {
    return getPostingPatchRecord({
      baseGeneration: input.baseGeneration,
      patchWatermark,
      projectId: input.projectId,
      row,
    })
  })
  const servingRecords = liveRows.map((row) => {
    return getPostingServingRecord({
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      row,
      snapshotId: input.snapshotId,
    })
  })
  const statsRecords = await getStatsRecords({
    database,
    diffs: contributionDiff.diffs,
    projectorInput: input,
    rows: contributionRows,
  })
  const deleteServingRowsStatement = getDeleteServingRowsStatement(input)

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.claims,
      component: 'posting',
      projectionManifests: input.claims.length === 0 ? [] : [getPostingManifest(input)],
      records: [...patchRecords, ...servingRecords, ...statsRecords, ...contributionDiff.contributionRecords],
      repairDirtyWork: contributionDiff.repairDirtyWork,
      statements: [deleteServingRowsStatement, contributionDiff.deleteContributionStateStatement].flatMap(
        (statement) => {
          return statement === null ? [] : [statement]
        },
      ),
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

  return {
    patchRowCount: patchRecords.length,
    patchWatermark,
    repairRequired: contributionDiff.repairRequired,
    servingRowCount: servingRecords.length,
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
  }
}

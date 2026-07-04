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
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
  writeReviewServingQueueRebuildRows,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingQueueProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingQueueInput = {
  acknowledgeClaims?: boolean
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  claims: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion: string
  projectId: string
  projectScopeIdentity: string
  projectionIdentity: string
  selectedImportSnapshotId: string
  snapshotId?: string | null
  status?: ReviewServingProjectionManifestStatus
}

export type ProjectReviewServingQueueRebuildInput = {
  baseGeneration: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  projectId: string
  projectScopeIdentity: string
  reviewConfigHash: string
  selectedImportSnapshotId: string
  snapshotId: string
}

type QueueSourceRow = {
  activitySortAt: Date | string | null
  articleId: string
  priorityBucket: number | null
  promptId: string | null
  queueIdentity: string | null
  queueKind: string
  reviewConfigHash: string | null
  tombstone: boolean
}

const queueProjectorName = 'queue-projector'
const staleQueueSortAt = '1970-01-01T00:00:00.000Z'

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

const hasProjectScopedClaim = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims.some((claim) => {
    return claim.scopeKind === 'project'
  })
}

const isQueueReviewConfigHash = (reviewConfigHash: string | null): reviewConfigHash is string => {
  return reviewConfigHash !== null
}

const getQueueReviewConfigHashes = (rows: readonly QueueSourceRow[]) => {
  return [
    ...new Set(
      rows
        .map((row) => {
          return row.reviewConfigHash
        })
        .filter(isQueueReviewConfigHash),
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

const getQueueServingRangePredicate = (input: {
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
}) => {
  const startPredicate =
    input.chunkStartArticleId === null || input.chunkStartArticleId === undefined
      ? ''
      : `AND article_id >= ${getSqlLiteral(input.chunkStartArticleId)}`
  const endPredicate =
    input.chunkEndArticleId === null || input.chunkEndArticleId === undefined
      ? ''
      : `AND article_id <= ${getSqlLiteral(input.chunkEndArticleId)}`

  return `${startPredicate}
          ${endPredicate}`
}

const getQueueIdentitySql = (input: {promptId: string; queueKind: string; reviewConfigHash: string}) => {
  return `'{"promptId":' || CAST(to_json(${input.promptId}) AS VARCHAR) || ',"queueKind":' || CAST(to_json(${input.queueKind}) AS VARCHAR) || ',"reviewConfigHash":' || CAST(to_json(${input.reviewConfigHash}) AS VARCHAR) || '}'`
}

const getQueueRebuildSourceCtes = (input: ProjectReviewServingQueueRebuildInput) => {
  return `scoped_article AS (
      SELECT
        scope.article_id,
        COALESCE(scope.article_updated_at, scope.article_created_at, TIMESTAMPTZ ${getSqlLiteral(staleQueueSortAt)}) AS activity_sort_at,
        scope.article_id IS NULL OR NOT (scope.in_curated_scope OR scope.in_route_scope) AS scope_tombstone
      FROM mart.project_scope_article scope
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        ${getArticleRangePredicate({alias: 'scope', ...input})}
    ),
    selected_import_state AS (
      SELECT
        scoped.article_id,
        COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) AS selected_tombstone
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
    ), enabled_prompt AS (
      SELECT
        prompt.id AS prompt_id
      FROM app.project_prompt project_prompt
      INNER JOIN app.prompt prompt
        ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.project_id = ${getSqlLiteral(input.projectId)}
        AND project_prompt.enabled
        AND NOT project_prompt.archived
        AND COALESCE(prompt.archived, FALSE) = FALSE
    ), project_settings AS (
      SELECT
        project.model_id,
        project.use_title,
        project.use_abstract,
        project.use_fulltext,
        project.use_fulltext_no_images,
        COALESCE(project.human_judgment_mode, 'prompt') AS human_judgment_mode
      FROM app.project project
      WHERE project.id = ${getSqlLiteral(input.projectId)}
    ), latest_judgment AS (
      SELECT
        judgment.*,
        ${['row', 'number'].join('_')}() OVER (PARTITION BY judgment.article_id, judgment.prompt_id ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC) AS judgment_rank
      FROM app."judgment" judgment
      INNER JOIN scoped_article scoped
        ON scoped.article_id = judgment.article_id
      INNER JOIN project_settings project
        ON project.model_id = judgment.model_id
        AND project.use_title = judgment.use_title
        AND project.use_abstract = judgment.use_abstract
        AND project.use_fulltext = judgment.use_fulltext
        AND project.use_fulltext_no_images = judgment.use_fulltext_no_images
      WHERE judgment.deleted_at IS NULL
    ), llm_queue AS (
      SELECT
        scoped.article_id,
        prompt.prompt_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral('unassessed')} AS queue_kind,
        CASE WHEN judgment.created_at IS NULL THEN 0 ELSE 1 END AS priority_bucket,
        COALESCE(judgment.created_at, scoped.activity_sort_at) AS activity_sort_at,
        selected.selected_tombstone
          OR scoped.scope_tombstone
          OR judgment.is_answered
          OR judgment.answered_original IS NOT NULL
          OR COALESCE(LENGTH(judgment.answered_original_as_array), 0) > 0 AS tombstone
      FROM scoped_article scoped
      INNER JOIN selected_import_state selected
        ON selected.article_id = scoped.article_id
      CROSS JOIN enabled_prompt prompt
      LEFT JOIN latest_judgment judgment
        ON judgment.article_id = scoped.article_id
        AND judgment.prompt_id = prompt.prompt_id
        AND judgment.judgment_rank = 1
    ),
    human_queue AS (
      SELECT DISTINCT
        scoped.article_id,
        CASE WHEN project_settings.human_judgment_mode = 'summary' THEN 'summary' ELSE prompt.prompt_id END AS prompt_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral('human-unreviewed')} AS queue_kind,
        CASE
          WHEN COALESCE(judgment_human.updated_at, judgment_human_summary.updated_at) IS NULL THEN 0
          ELSE 1
        END AS priority_bucket,
        COALESCE(judgment_human.updated_at, judgment_human_summary.updated_at, scoped.activity_sort_at) AS activity_sort_at,
        selected.selected_tombstone
          OR scoped.scope_tombstone
          OR NULLIF(TRIM(COALESCE(judgment_human.answer, judgment_human_summary.answer, '')), '') IS NOT NULL AS tombstone
      FROM scoped_article scoped
      INNER JOIN selected_import_state selected
        ON selected.article_id = scoped.article_id
      CROSS JOIN project_settings
      CROSS JOIN enabled_prompt prompt
      LEFT JOIN app."judgment_human" judgment_human
        ON judgment_human.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
        AND judgment_human.article_id = scoped.article_id
        AND judgment_human.prompt_id = prompt.prompt_id
        AND project_settings.human_judgment_mode <> 'summary'
      LEFT JOIN app."judgment_human_summary" judgment_human_summary
        ON judgment_human_summary.project_id = ${getSqlLiteral(input.projectId)}
        AND judgment_human_summary.article_id = scoped.article_id
        AND project_settings.human_judgment_mode = 'summary'
    ),
    queue_union AS (
      SELECT * FROM llm_queue
      UNION ALL
      SELECT * FROM human_queue
    )`
}

const getDirtyArticleCte = (projectId: string, articleIds: readonly string[], promptIds: readonly string[]) => {
  if (articleIds.length > 0) {
    return getValuesCte('article_id', articleIds)
  }

  return promptIds.length === 0
    ? ''
    : `article_id_filter(article_id) AS (
        SELECT scope.article_id
        FROM mart.project_scope_article scope
        WHERE scope.project_id = ${getSqlLiteral(projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
      )`
}

const getQueueDirtyArticleCte = (
  input: ProjectReviewServingQueueInput,
  articleIds: readonly string[],
  promptIds: readonly string[],
) => {
  return (promptIds.length === 0 && hasProjectScopedClaim(input.claims)) || hasChunkArticleRange(input)
    ? `article_id_filter(article_id) AS (
        SELECT scope.article_id
        FROM mart.project_scope_article scope
        WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
          AND (scope.in_curated_scope OR scope.in_route_scope)
          ${getArticleRangePredicate({alias: 'scope', ...input})}
      )`
    : getDirtyArticleCte(input.projectId, articleIds, promptIds)
}

const getDirtyPromptJoin = (promptIds: readonly string[], alias: string) => {
  return promptIds.length === 0
    ? ''
    : `INNER JOIN prompt_id_filter dirty_prompt
          ON dirty_prompt.prompt_id = ${alias}.prompt_id`
}

const getHumanDirtyPromptJoin = (promptIds: readonly string[]) => {
  return promptIds.length === 0
    ? ''
    : `INNER JOIN prompt_id_filter dirty_prompt
          ON dirty_prompt.prompt_id = human.prompt_id OR human.prompt_id = 'summary'`
}

const getQueueIdentity = (row: QueueSourceRow) => {
  return (
    row.queueIdentity
    ?? getStableReviewServingJson({
      promptId: row.promptId,
      queueKind: row.queueKind,
      reviewConfigHash: row.reviewConfigHash,
    })
  )
}

const getQueueRows = async (input: ProjectReviewServingQueueInput, database: ReviewServingQueueProjectorDatabase) => {
  const broadProjectClaim = hasProjectScopedClaim(input.claims)
  const articleIds = broadProjectClaim ? [] : getClaimArticleIds(input.claims)
  const promptIds = broadProjectClaim ? [] : getClaimPromptIds(input.claims)
  const dirtyArticleCte = getQueueDirtyArticleCte(input, articleIds, promptIds)
  const dirtyPromptCte = getValuesCte('prompt_id', promptIds)
  const ctes = [dirtyArticleCte, dirtyPromptCte].filter((cte) => {
    return cte.length > 0
  })

  return ctes.length === 0
    ? []
    : database.queryJson<QueueSourceRow>(`
        WITH ${ctes.join(',\n        ')},
        scoped_article AS (
          SELECT
            dirty.article_id,
            COALESCE(scope.article_updated_at, scope.article_created_at, TIMESTAMPTZ ${getSqlLiteral(staleQueueSortAt)}) AS activity_sort_at,
            scope.article_id IS NULL OR NOT (scope.in_curated_scope OR scope.in_route_scope) AS scope_tombstone
          FROM article_id_filter dirty
          LEFT JOIN mart.project_scope_article scope
            ON scope.project_id = ${getSqlLiteral(input.projectId)}
            AND scope.article_id = dirty.article_id
        ),
        selected_import_state AS (
          SELECT
            scoped.article_id,
            COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) AS selected_tombstone
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
        ), project_settings AS (
          SELECT COALESCE((SELECT project.human_judgment_mode FROM app.project project WHERE project.id = ${getSqlLiteral(input.projectId)}), 'prompt') AS human_judgment_mode
        ),
        llm_queue AS (
          SELECT
            scoped.article_id AS articleId,
            llm.prompt_id AS promptId,
            llm.review_config_hash AS reviewConfigHash,
            ${getSqlLiteral('unassessed')} AS queueKind,
            CASE WHEN llm.latest_llm_created_at IS NULL THEN 0 ELSE 1 END AS priorityBucket,
            COALESCE(llm.latest_llm_created_at, scoped.activity_sort_at) AS activitySortAt,
            llm.tombstone OR llm.llm_status_key = 'answered' OR scoped.scope_tombstone AS tombstone
          FROM scoped_article scoped
          INNER JOIN selected_import_state selected
            ON selected.article_id = scoped.article_id
          INNER JOIN mart.review_llm_status_patch_v4 llm
            ON llm.project_id = ${getSqlLiteral(input.projectId)}
            AND llm.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND llm.article_id = scoped.article_id
            ${getDirtyPromptJoin(promptIds, 'llm')}
            AND llm.patch_watermark = (
              SELECT MAX(newer.patch_watermark)
              FROM mart.review_llm_status_patch_v4 newer
              WHERE newer.project_id = llm.project_id
                AND newer.review_config_hash = llm.review_config_hash
                AND newer.prompt_config_hash = llm.prompt_config_hash
                AND newer.base_generation = llm.base_generation
                AND newer.article_id = llm.article_id
                AND newer.prompt_id = llm.prompt_id
                AND newer.list_mode_key = llm.list_mode_key
            )
        ),
        human_queue AS (
          SELECT DISTINCT
            scoped.article_id AS articleId,
            human.prompt_id AS promptId,
            llm.review_config_hash AS reviewConfigHash,
            ${getSqlLiteral('human-unreviewed')} AS queueKind,
            CASE WHEN human.latest_human_updated_at IS NULL THEN 0 ELSE 1 END AS priorityBucket,
            COALESCE(human.latest_human_updated_at, scoped.activity_sort_at) AS activitySortAt,
            human.tombstone OR human.human_status_key = 'answered' OR scoped.scope_tombstone AS tombstone
          FROM scoped_article scoped
          INNER JOIN selected_import_state selected
            ON selected.article_id = scoped.article_id
          INNER JOIN mart.review_human_status_patch_v4 human
            ON human.project_id = ${getSqlLiteral(input.projectId)}
            AND human.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND human.article_id = scoped.article_id
            ${getHumanDirtyPromptJoin(promptIds)}
          CROSS JOIN project_settings
          INNER JOIN mart.review_llm_status_patch_v4 llm
            ON llm.project_id = ${getSqlLiteral(input.projectId)}
            AND llm.base_generation = ${getSqlLiteral(input.baseGeneration)}
            AND llm.article_id = human.article_id
            AND (llm.prompt_id = human.prompt_id OR human.prompt_id = 'summary')
            AND llm.list_mode_key = human.list_mode_key
            AND llm.patch_watermark = (
              SELECT MAX(newer_llm.patch_watermark)
              FROM mart.review_llm_status_patch_v4 newer_llm
              WHERE newer_llm.project_id = llm.project_id
                AND newer_llm.review_config_hash = llm.review_config_hash
                AND newer_llm.prompt_config_hash = llm.prompt_config_hash
                AND newer_llm.base_generation = llm.base_generation
                AND newer_llm.list_mode_key = llm.list_mode_key
                AND newer_llm.article_id = llm.article_id
                AND newer_llm.prompt_id = llm.prompt_id
            )
            AND human.patch_watermark = (
              SELECT MAX(newer.patch_watermark)
              FROM mart.review_human_status_patch_v4 newer
              WHERE newer.project_id = human.project_id
                AND newer.prompt_config_hash = human.prompt_config_hash
                AND newer.base_generation = human.base_generation
                AND newer.article_id = human.article_id
                AND newer.prompt_id IS NOT DISTINCT FROM human.prompt_id
                AND newer.list_mode_key = human.list_mode_key
            )
            AND (
              (project_settings.human_judgment_mode = 'summary' AND human.prompt_id = 'summary')
              OR (project_settings.human_judgment_mode <> 'summary' AND human.prompt_id <> 'summary')
            )
        ),
        queue_union AS (
          SELECT * FROM llm_queue
          UNION ALL
          SELECT * FROM human_queue
        )
        SELECT
          queue.articleId,
          queue.promptId,
          queue.reviewConfigHash,
          ${getSqlLiteral(null)} AS queueIdentity,
          queue.queueKind,
          queue.priorityBucket,
          queue.activitySortAt,
          queue.tombstone
        FROM queue_union queue
        ORDER BY queue.articleId ASC, queue.promptId ASC, queue.queueKind ASC, queue.reviewConfigHash ASC
      `)
}

const getQueuePatchRecord = (
  input: ProjectReviewServingQueueInput,
  row: QueueSourceRow,
): ReviewServingProjectorRecord => {
  const activitySortAt = row.activitySortAt ?? staleQueueSortAt

  return {
    keyColumns: [
      'project_id',
      'queue_identity',
      'base_generation',
      'patch_watermark',
      'queue_kind',
      'priority_bucket',
      'sort_key',
      'article_id',
    ],
    table: 'mart.review_queue_patch_v4',
    values: {
      article_id: row.articleId,
      base_generation: input.baseGeneration,
      patch_updated_at: new Date(),
      patch_watermark: getPatchWatermark(input.claims),
      priority_bucket: row.priorityBucket ?? 0,
      project_id: input.projectId,
      queue_identity: getQueueIdentity(row),
      queue_kind: row.queueKind,
      sort_key: activitySortAt,
      tombstone: row.tombstone,
    },
  }
}

const getUnassessedQueueServingRecord = (
  input: ProjectReviewServingQueueInput,
  row: QueueSourceRow,
): ReviewServingProjectorRecord | null => {
  const activitySortAt = row.activitySortAt ?? staleQueueSortAt

  return input.snapshotId === null || input.snapshotId === undefined || row.reviewConfigHash === null || row.tombstone
    ? null
    : {
        keyColumns: [
          'project_id',
          'review_config_hash',
          'snapshot_id',
          'queue_kind',
          'priority_bucket',
          'activity_sort_at',
          'article_id',
          'prompt_id',
          'queue_identity',
        ],
        table: 'mart.review_unassessed_queue_serving_v4',
        values: {
          activity_sort_at: activitySortAt,
          article_id: row.articleId,
          priority_bucket: row.priorityBucket ?? 0,
          project_id: input.projectId,
          prompt_id: row.promptId,
          queue_identity: getQueueIdentity(row),
          queue_kind: row.queueKind,
          queue_updated_at: new Date(),
          review_config_hash: row.reviewConfigHash,
          snapshot_id: input.snapshotId,
        },
      }
}

const getQueuePatchManifest = (input: ProjectReviewServingQueueInput): ReviewServingProjectionIdentityManifestInput => {
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
    projectionComponent: 'queue',
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

const getDeleteReplacedQueueServingStatement = (
  input: ProjectReviewServingQueueInput,
  rows: readonly QueueSourceRow[],
) => {
  const broadProjectClaim = hasProjectScopedClaim(input.claims)
  const articleIds = broadProjectClaim ? [] : getClaimArticleIds(input.claims)
  const promptIds = broadProjectClaim ? [] : getClaimPromptIds(input.claims)
  const reviewConfigHashes = getQueueReviewConfigHashes(rows)
  const reviewConfigPredicate =
    reviewConfigHashes.length === 0
      ? ''
      : `AND review_config_hash IN (${reviewConfigHashes.map(getSqlLiteral).join(', ')})`
  const rangePredicate = getQueueServingRangePredicate(input)

  return input.snapshotId === null
    || input.snapshotId === undefined
    || (!broadProjectClaim
      && !hasChunkArticleRange(input)
      && articleIds.length === 0
      && promptIds.length === 0
      && reviewConfigHashes.length === 0)
    ? null
    : articleIds.length > 0
      ? `DELETE FROM mart.review_unassessed_queue_serving_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${reviewConfigPredicate}
          AND article_id IN (${articleIds.map(getSqlLiteral).join(', ')})`
      : promptIds.length > 0
        ? `DELETE FROM mart.review_unassessed_queue_serving_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${reviewConfigPredicate}
          AND prompt_id IN (${promptIds.map(getSqlLiteral).join(', ')})`
        : `DELETE FROM mart.review_unassessed_queue_serving_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${rangePredicate}
          ${reviewConfigPredicate}`
}

export const projectReviewServingQueuePatches = async (
  input: ProjectReviewServingQueueInput,
  database: ReviewServingQueueProjectorDatabase = getAppDatabaseService() as ReviewServingQueueProjectorDatabase,
) => {
  const rows = await getQueueRows(input, database)
  const patchRecords = rows.map((row) => {
    return getQueuePatchRecord(input, row)
  })
  const servingRecords = rows
    .map((row) => {
      return getUnassessedQueueServingRecord(input, row)
    })
    .filter((record) => {
      return record !== null
    })
  const patchWatermark = getPatchWatermark(input.claims)
  const deleteReplacedQueueServingStatement = getDeleteReplacedQueueServingStatement(input, rows)

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.acknowledgeClaims === false ? [] : input.claims,
      component: 'queue',
      projectionManifests: input.claims.length === 0 ? [] : [getQueuePatchManifest(input)],
      records: [...patchRecords, ...servingRecords],
      statements: deleteReplacedQueueServingStatement === null ? [] : [deleteReplacedQueueServingStatement],
      watermark:
        input.claims.length === 0
          ? undefined
          : {
              projectId: input.projectId,
              projectionComponent: 'queue',
              projectorName: queueProjectorName,
              sourceHighWaterMark: patchWatermark,
              sourcePartition: getClaimSourcePartition(input.claims),
            },
    },
    database,
  )

  return {patchRowCount: patchRecords.length, patchWatermark, servingRowCount: servingRecords.length}
}

export const projectReviewServingQueueRebuildRows = async (
  input: ProjectReviewServingQueueRebuildInput,
  database: Pick<ReviewServingQueueProjectorDatabase, 'run'> = getAppDatabaseService(),
) => {
  await writeReviewServingQueueRebuildRows(
    {
      projectId: input.projectId,
      queueIdentitySql: getQueueIdentitySql({
        promptId: 'queue.prompt_id',
        queueKind: 'queue.queue_kind',
        reviewConfigHash: 'queue.review_config_hash',
      }),
      rangePredicateSql: getQueueServingRangePredicate(input),
      rebuildSourceCtesSql: getQueueRebuildSourceCtes(input),
      reviewConfigHash: input.reviewConfigHash,
      snapshotId: input.snapshotId,
    },
    database,
  )
}

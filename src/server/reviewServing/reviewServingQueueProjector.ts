import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
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
  writeReviewServingQueueRebuildRanges,
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
  onPhaseStart?: (event: ReviewServingQueueProjectorPhaseStartEvent) => Promise<void> | void
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

export type ProjectReviewServingQueueRebuildRangesInput = {ranges: readonly ProjectReviewServingQueueRebuildInput[]}

type QueueSourceRow = {
  activitySortAt: Date | string | null
  articleId: string
  priorityBucket: number | null
  promptId: string | null
  queueKind: string
  reviewConfigHash: string | null
  tombstone: boolean
}

const queueProjectorName = 'queue-projector'
const queueProjectScopeDirtySourceRowLimit = 50_000
const staleQueueSortAt = '1970-01-01T00:00:00.000Z'
const queueProjectorPhaseLogger = createRateLimitedLogger({showSuppressedCount: false, sink: 'file-only', windowMs: 0})

type QueueProjectorPhase = 'rebuildBatchWriter' | 'rebuildWriter' | 'sourceQuery' | 'writer'

export type ReviewServingQueueProjectorPhaseStartEvent = {
  articleCount?: number
  broadProjectClaim?: boolean
  chunkCount?: number
  chunkEndArticleId?: string | null
  chunkIndex?: number
  chunkStartArticleId?: string | null
  claimCount?: number
  phase: QueueProjectorPhase
  projectId: string
  rangeCount?: number
  recordCount?: number
  scopeKinds?: readonly string[]
  snapshotId?: string | null
  sourceRowCount?: number
  sourceRowLimit?: number
  statementCount?: number
}

type QueueProjectScopeChunkRangeRow = {
  articleCount: number
  articleLimit: number
  chunkEndArticleId: string | null
  chunkStartArticleId: string | null
  estimatedSourceRowCount: number
  sourceFanout: number
}

type QueueProjectScopeChunkRange = {
  articleCount: number
  articleLimit: number
  chunkEndArticleId: string
  chunkStartArticleId: string
  estimatedSourceRowCount: number
  sourceFanout: number
}

type QueueProjectorChunkDiagnostics = {
  articleCount?: number
  articleLimit?: number
  chunkCount?: number
  chunkIndex?: number
  estimatedSourceRowCount?: number
  sourceFanout?: number
  sourceRowLimit?: number
}

type ProjectReviewServingQueueChunkInput = ProjectReviewServingQueueInput & {
  chunkDiagnostics?: QueueProjectorChunkDiagnostics
}

const logQueueProjectorPhaseStarted = async (
  input: ReviewServingQueueProjectorPhaseStartEvent & {onPhaseStart?: ProjectReviewServingQueueInput['onPhaseStart']},
) => {
  const chunkKey = input.chunkIndex === undefined ? 'single' : String(input.chunkIndex)

  queueProjectorPhaseLogger.force(
    `review-serving-queue-projector:${input.phase}:started:${input.projectId}:${input.snapshotId ?? 'no-snapshot'}:${chunkKey}`,
    '[reviewServingQueueProjector] phase started',
    'log',
    {
      articleCount: input.articleCount,
      broadProjectClaim: input.broadProjectClaim,
      chunkCount: input.chunkCount,
      chunkEndArticleId: input.chunkEndArticleId,
      chunkIndex: input.chunkIndex,
      chunkStartArticleId: input.chunkStartArticleId,
      claimCount: input.claimCount,
      component: 'queue',
      event: 'queueProjectorPhaseStarted',
      phase: input.phase,
      projectId: input.projectId,
      rangeCount: input.rangeCount,
      recordCount: input.recordCount,
      scopeKinds: input.scopeKinds,
      snapshotId: input.snapshotId,
      sourceRowCount: input.sourceRowCount,
      sourceRowLimit: input.sourceRowLimit,
      statementCount: input.statementCount,
    },
  )

  await input.onPhaseStart?.(input)
}

const getQueueProjectorChunkDiagnostics = (input: ProjectReviewServingQueueChunkInput) => {
  return input.chunkDiagnostics ?? {}
}

const getQueueProjectorPhaseChunkInput = (input: ProjectReviewServingQueueChunkInput) => {
  const chunkDiagnostics = getQueueProjectorChunkDiagnostics(input)

  return {
    articleCount: chunkDiagnostics.articleCount,
    chunkCount: chunkDiagnostics.chunkCount,
    chunkIndex: chunkDiagnostics.chunkIndex,
    sourceRowLimit: chunkDiagnostics.sourceRowLimit,
  }
}

const getQueueProjectorClaimPhaseInput = (input: ProjectReviewServingQueueChunkInput) => {
  return {
    broadProjectClaim: hasProjectScopedClaim(input.claims),
    chunkEndArticleId: input.chunkEndArticleId,
    chunkStartArticleId: input.chunkStartArticleId,
    claimCount: input.claims.length,
    onPhaseStart: input.onPhaseStart,
    projectId: input.projectId,
    scopeKinds: getClaimScopeKinds(input.claims),
    snapshotId: input.snapshotId,
    ...getQueueProjectorPhaseChunkInput(input),
  }
}

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

const getQueueDiagnosticsJson = (input: {
  chunkDiagnostics?: QueueProjectorChunkDiagnostics
  chunkedProjectScope?: {chunkCount: number; chunkDiagnostics: readonly unknown[]; sourceRowLimit: number}
  phaseTimings: Record<string, number>
  sourceRowCount?: number
  writer?: ReviewServingProjectorWriterDiagnostics
}) => {
  return {
    phaseTimings: input.phaseTimings,
    queueProjector: {
      chunkDiagnostics: input.chunkDiagnostics,
      chunkedProjectScope: input.chunkedProjectScope,
      sourceRowCount: input.sourceRowCount,
      writer: input.writer,
    },
  }
}

const withDiagnosticsJson = <T extends object>(result: T, diagnosticsJson: unknown): T => {
  return Object.defineProperty(result, 'diagnosticsJson', {enumerable: false, value: diagnosticsJson})
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

const getClaimScopeKinds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.map((claim) => {
        return claim.scopeKind
      }),
    ),
  ]
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

const getSnapshotReviewConfigHash = async (
  input: ProjectReviewServingQueueInput,
  database: Pick<ReviewServingQueueProjectorDatabase, 'queryJson'>,
) => {
  if (input.snapshotId === null || input.snapshotId === undefined) {
    return null
  }

  const [row] = await database.queryJson<{reviewConfigHash: string | null}>(`
    SELECT review_config_hash AS reviewConfigHash
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND snapshot_status IN ('candidate', 'active')
    LIMIT 1
  `)

  return row?.reviewConfigHash ?? null
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

export const getReviewServingQueueRebuildSourceCtes = (input: ProjectReviewServingQueueRebuildInput) => {
  return `scoped_article AS (
      SELECT
        scope.article_id,
        COALESCE(scope.article_updated_at, scope.article_created_at, TIMESTAMPTZ ${getSqlLiteral(staleQueueSortAt)}) AS activity_sort_at,
        scope.article_id IS NULL OR NOT (scope.in_curated_scope OR scope.in_route_scope) AS scope_tombstone
      FROM mart.project_scope_article scope
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        ${getArticleRangePredicate({alias: 'scope', ...input})}
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
    ), human_prompt AS (
      SELECT
        enabled_prompt.prompt_id
      FROM enabled_prompt
      CROSS JOIN project_settings
      WHERE project_settings.human_judgment_mode <> 'summary'
      UNION ALL
      SELECT
        ${getSqlLiteral('summary')} AS prompt_id
      FROM project_settings
      WHERE project_settings.human_judgment_mode = 'summary'
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
        scoped.scope_tombstone
          OR COALESCE(judgment.is_answered, FALSE)
          OR judgment.answered_original IS NOT NULL
          OR COALESCE(LENGTH(judgment.answered_original_as_array), 0) > 0 AS tombstone
      FROM scoped_article scoped
      CROSS JOIN enabled_prompt prompt
      LEFT JOIN latest_judgment judgment
        ON judgment.article_id = scoped.article_id
        AND judgment.prompt_id = prompt.prompt_id
        AND judgment.judgment_rank = 1
    ),
    human_queue AS (
      SELECT DISTINCT
        scoped.article_id,
        prompt.prompt_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral('human-unreviewed')} AS queue_kind,
        CASE
          WHEN COALESCE(judgment_human.updated_at, judgment_human_summary.updated_at) IS NULL THEN 0
          ELSE 1
        END AS priority_bucket,
        COALESCE(judgment_human.updated_at, judgment_human_summary.updated_at, scoped.activity_sort_at) AS activity_sort_at,
        scoped.scope_tombstone
          OR NULLIF(TRIM(COALESCE(judgment_human.answer, judgment_human_summary.answer, '')), '') IS NOT NULL AS tombstone
      FROM scoped_article scoped
      CROSS JOIN project_settings
      CROSS JOIN human_prompt prompt
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
  input: ProjectReviewServingQueueChunkInput,
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

const getQueueRows = async (
  input: ProjectReviewServingQueueChunkInput,
  database: ReviewServingQueueProjectorDatabase,
) => {
  const broadProjectClaim = hasProjectScopedClaim(input.claims)
  const articleIds = broadProjectClaim ? [] : getClaimArticleIds(input.claims)
  const promptIds = broadProjectClaim ? [] : getClaimPromptIds(input.claims)
  const dirtyArticleCte = getQueueDirtyArticleCte(input, articleIds, promptIds)
  const ctes = [dirtyArticleCte].filter((cte) => {
    return cte.length > 0
  })

  const reviewConfigHash = await getSnapshotReviewConfigHash(input, database)

  return ctes.length === 0 || input.snapshotId === null || input.snapshotId === undefined || reviewConfigHash === null
    ? []
    : database.queryJson<QueueSourceRow>(`
        WITH ${ctes.join(',\n        ')},
        ${getReviewServingQueueRebuildSourceCtes({...input, reviewConfigHash, snapshotId: input.snapshotId})}
        SELECT
          queue.article_id AS articleId,
          queue.prompt_id AS promptId,
          queue.review_config_hash AS reviewConfigHash,
          queue.queue_kind AS queueKind,
          queue.priority_bucket AS priorityBucket,
          queue.activity_sort_at AS activitySortAt,
          queue.tombstone
        FROM queue_union queue
        INNER JOIN article_id_filter dirty
          ON dirty.article_id = queue.article_id
        ORDER BY articleId ASC, promptId ASC, queueKind ASC, reviewConfigHash ASC
      `)
}

const getUnassessedQueueArticleRankRecords = (
  input: ProjectReviewServingQueueChunkInput,
  rows: readonly QueueSourceRow[],
): ReviewServingProjectorRecord[] => {
  const groupedRows = new Map<string, QueueSourceRow>()

  rows.forEach((row) => {
    const activitySortAt = row.activitySortAt ?? staleQueueSortAt

    if (input.snapshotId === null || input.snapshotId === undefined || row.reviewConfigHash === null || row.tombstone) {
      return
    }

    if (row.promptId === null) {
      return
    }

    const key = [input.projectId, row.reviewConfigHash, input.snapshotId, row.queueKind, row.articleId].join('\t')
    const existing = groupedRows.get(key)

    if (existing === undefined) {
      groupedRows.set(key, {...row, activitySortAt})
      return
    }

    const existingPriorityBucket = existing.priorityBucket ?? 0
    const nextPriorityBucket = row.priorityBucket ?? 0
    const existingActivitySortAt =
      existing.activitySortAt instanceof Date
        ? existing.activitySortAt.toISOString()
        : (existing.activitySortAt ?? staleQueueSortAt)
    const nextActivitySortAt = activitySortAt instanceof Date ? activitySortAt.toISOString() : activitySortAt

    if (
      nextPriorityBucket > existingPriorityBucket
      || (nextPriorityBucket === existingPriorityBucket && nextActivitySortAt > existingActivitySortAt)
    ) {
      groupedRows.set(key, {...row, activitySortAt})
    }
  })

  return [...groupedRows.values()].map((row) => {
    const activitySortAt = row.activitySortAt ?? staleQueueSortAt

    return {
      keyColumns: ['project_id', 'review_config_hash', 'snapshot_id', 'queue_kind', 'article_id'],
      table: 'mart.review_unassessed_queue_article_rank_serving_v4',
      values: {
        activity_sort_at: activitySortAt,
        article_id: row.articleId,
        priority_bucket: row.priorityBucket ?? 0,
        project_id: input.projectId,
        queue_kind: row.queueKind,
        queue_updated_at: new Date(),
        review_config_hash: row.reviewConfigHash,
        snapshot_id: input.snapshotId,
      },
    }
  })
}

const getQueuePatchManifest = (
  input: ProjectReviewServingQueueChunkInput,
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
    projectionComponent: 'queue',
    projectionIdentity: input.projectionIdentity,
    status: input.status ?? 'candidate',
  }
}

const getRefreshUnassessedQueueArticleRankStatements = (
  input: ProjectReviewServingQueueChunkInput,
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
  const scopePredicate =
    articleIds.length > 0
      ? `AND article_id IN (${articleIds.map(getSqlLiteral).join(', ')})`
      : hasChunkArticleRange(input)
        ? rangePredicate
        : ''

  return input.snapshotId === null
    || input.snapshotId === undefined
    || (!broadProjectClaim
      && !hasChunkArticleRange(input)
      && articleIds.length === 0
      && promptIds.length === 0
      && reviewConfigHashes.length === 0)
    ? []
    : [
        `DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          ${reviewConfigPredicate}
          ${scopePredicate}`,
      ]
}

const projectReviewServingQueuePatchChunk = async (
  input: ProjectReviewServingQueueChunkInput,
  database: ReviewServingQueueProjectorDatabase,
) => {
  const {measure, measureSync, phaseTimings} = getTimedProjector()
  const rows = await measure('sourceQueryMs', async () => {
    await logQueueProjectorPhaseStarted({...getQueueProjectorClaimPhaseInput(input), phase: 'sourceQuery'})

    return getQueueRows(input, database)
  })
  const articleRankRecords = measureSync('recordTransformMs', () => {
    return getUnassessedQueueArticleRankRecords(input, rows)
  })
  const patchWatermark = getPatchWatermark(input.claims)
  const shouldAcknowledgeClaims = input.claims.length > 0 && input.acknowledgeClaims !== false
  const refreshArticleRankStatements = measureSync('articleRankStatementBuildMs', () => {
    return getRefreshUnassessedQueueArticleRankStatements(input, rows)
  })

  const writer = await measure('writerMs', async () => {
    await logQueueProjectorPhaseStarted({
      ...getQueueProjectorClaimPhaseInput(input),
      phase: 'writer',
      recordCount: articleRankRecords.length,
      sourceRowCount: rows.length,
      statementCount: refreshArticleRankStatements.length,
    })

    return writeReviewServingProjectorComponent(
      {
        acknowledgements: shouldAcknowledgeClaims ? input.claims : [],
        component: 'queue',
        projectionManifests: shouldAcknowledgeClaims ? [getQueuePatchManifest(input)] : [],
        records: articleRankRecords,
        statements: refreshArticleRankStatements,
        watermark: !shouldAcknowledgeClaims
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
  })

  return withDiagnosticsJson(
    {patchRowCount: 0, patchWatermark, servingRowCount: articleRankRecords.length},
    getQueueDiagnosticsJson({
      chunkDiagnostics: input.chunkDiagnostics,
      phaseTimings,
      sourceRowCount: rows.length,
      writer: writer.diagnostics,
    }),
  )
}

const getQueueProjectScopeChunkRanges = async (
  input: ProjectReviewServingQueueInput,
  database: Pick<ReviewServingQueueProjectorDatabase, 'queryJson'>,
) => {
  const rows = await database.queryJson<QueueProjectScopeChunkRangeRow>(`
    WITH project_settings AS (
      SELECT COALESCE(project.human_judgment_mode, 'prompt') AS human_judgment_mode
      FROM app.project project
      WHERE project.id = ${getSqlLiteral(input.projectId)}
    ), enabled_prompt AS (
      SELECT CAST(COUNT(*) AS INTEGER) AS enabled_prompt_count
      FROM app.project_prompt project_prompt
      INNER JOIN app.prompt prompt
        ON prompt.id = project_prompt.prompt_id
      WHERE project_prompt.project_id = ${getSqlLiteral(input.projectId)}
        AND project_prompt.enabled
        AND NOT project_prompt.archived
        AND COALESCE(prompt.archived, FALSE) = FALSE
    ), queue_source_budget AS (
      SELECT
        GREATEST(1, enabled_prompt.enabled_prompt_count) AS enabled_prompt_count,
        CASE
          WHEN COALESCE(project_settings.human_judgment_mode, 'prompt') = 'summary' THEN 1
          ELSE GREATEST(1, enabled_prompt.enabled_prompt_count)
        END AS human_prompt_count
      FROM enabled_prompt
      LEFT JOIN project_settings ON TRUE
    ), article_limit AS (
      SELECT
        GREATEST(
          1,
          CAST(FLOOR(${queueProjectScopeDirtySourceRowLimit} / GREATEST(1, enabled_prompt_count + human_prompt_count)) AS INTEGER)
        ) AS article_limit,
        GREATEST(1, enabled_prompt_count + human_prompt_count) AS source_fanout
      FROM queue_source_budget
    ), scoped_article AS (
      SELECT
        scope.article_id
      FROM mart.project_scope_article scope
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
    ), scoped_article_count AS (
      SELECT CAST(COUNT(*) AS INTEGER) AS scoped_article_count
      FROM scoped_article
    ), article_plan AS (
      SELECT
        article_limit.article_limit,
        article_limit.source_fanout,
        GREATEST(
          1,
          CAST(CEIL(scoped_article_count.scoped_article_count / article_limit.article_limit) AS INTEGER)
        ) AS chunk_count
      FROM article_limit
      CROSS JOIN scoped_article_count
    ), chunked_article AS (
      SELECT
        scoped_article.article_id,
        NTILE(article_plan.chunk_count) OVER (ORDER BY scoped_article.article_id) AS chunk_index,
        article_plan.article_limit,
        article_plan.source_fanout
      FROM scoped_article
      CROSS JOIN article_plan
    ), bucket_range AS (
      SELECT
        chunk_index,
        CAST(COUNT(*) AS INTEGER) AS article_count,
        MIN(article_id) AS scoped_start_key,
        MAX(article_id) AS scoped_end_key,
        ANY_VALUE(article_limit) AS article_limit,
        ANY_VALUE(source_fanout) AS source_fanout
      FROM chunked_article
      GROUP BY chunk_index
      HAVING COUNT(*) > 0
    ), bucket_with_boundary AS (
      SELECT
        article_count,
        article_limit,
        source_fanout,
        scoped_start_key,
        scoped_end_key,
        LAG(scoped_end_key) OVER (ORDER BY chunk_index) AS previous_scoped_end_key
      FROM bucket_range
    )
    SELECT
      CASE
        WHEN previous_scoped_end_key IS NULL THEN scoped_start_key
        ELSE previous_scoped_end_key || ' '
      END AS chunkStartArticleId,
      scoped_end_key AS chunkEndArticleId,
      article_count AS articleCount,
      article_limit AS articleLimit,
      source_fanout AS sourceFanout,
      article_count * source_fanout AS estimatedSourceRowCount
    FROM bucket_with_boundary
    ORDER BY scoped_start_key
  `)

  return rows.flatMap((row): QueueProjectScopeChunkRange[] => {
    return row.chunkStartArticleId === null || row.chunkEndArticleId === null
      ? []
      : [
          {
            articleCount: Number(row.articleCount),
            articleLimit: Number(row.articleLimit),
            chunkEndArticleId: row.chunkEndArticleId,
            chunkStartArticleId: row.chunkStartArticleId,
            estimatedSourceRowCount: Number(row.estimatedSourceRowCount),
            sourceFanout: Number(row.sourceFanout),
          },
        ]
  })
}

const getChunkedQueuePatchResultDiagnosticsJson = (result: object) => {
  return (result as {diagnosticsJson?: unknown}).diagnosticsJson ?? {}
}

const yieldBetweenQueueProjectorChunks = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const projectReviewServingQueueProjectScopeChunks = async (
  input: ProjectReviewServingQueueInput,
  chunkRanges: readonly QueueProjectScopeChunkRange[],
  database: ReviewServingQueueProjectorDatabase,
) => {
  const startedAtMs = Date.now()
  const chunkResults = await chunkRanges.reduce<
    Promise<Array<Awaited<ReturnType<typeof projectReviewServingQueuePatchChunk>>>>
  >(async (previous, range, index) => {
    const results = await previous
    const acknowledgeClaims = index === chunkRanges.length - 1 ? input.acknowledgeClaims : false
    const result = await projectReviewServingQueuePatchChunk(
      {
        ...input,
        acknowledgeClaims,
        chunkDiagnostics: {
          articleCount: range.articleCount,
          articleLimit: range.articleLimit,
          chunkCount: chunkRanges.length,
          chunkIndex: index,
          estimatedSourceRowCount: range.estimatedSourceRowCount,
          sourceFanout: range.sourceFanout,
          sourceRowLimit: queueProjectScopeDirtySourceRowLimit,
        },
        chunkEndArticleId: range.chunkEndArticleId,
        chunkStartArticleId: range.chunkStartArticleId,
      },
      database,
    )

    if (index < chunkRanges.length - 1) {
      await yieldBetweenQueueProjectorChunks()
    }

    return [...results, result]
  }, Promise.resolve([]))
  const patchWatermark = getPatchWatermark(input.claims)
  const phaseTimings = {chunkedProjectScopeMs: getNonNegativeElapsedMs(startedAtMs)}

  return withDiagnosticsJson(
    {
      patchRowCount: 0,
      patchWatermark,
      servingRowCount: chunkResults.reduce((total, result) => {
        return total + result.servingRowCount
      }, 0),
    },
    getQueueDiagnosticsJson({
      chunkedProjectScope: {
        chunkCount: chunkRanges.length,
        chunkDiagnostics: chunkResults.map(getChunkedQueuePatchResultDiagnosticsJson),
        sourceRowLimit: queueProjectScopeDirtySourceRowLimit,
      },
      phaseTimings,
    }),
  )
}

export const projectReviewServingQueuePatches = async (
  input: ProjectReviewServingQueueInput,
  database: ReviewServingQueueProjectorDatabase = getAppDatabaseService() as ReviewServingQueueProjectorDatabase,
) => {
  if (
    hasProjectScopedClaim(input.claims)
    && !hasChunkArticleRange(input)
    && input.snapshotId !== null
    && input.snapshotId !== undefined
  ) {
    const chunkRanges = await getQueueProjectScopeChunkRanges(input, database)

    return chunkRanges.length === 0
      ? projectReviewServingQueuePatchChunk(input, database)
      : projectReviewServingQueueProjectScopeChunks(input, chunkRanges, database)
  }

  return projectReviewServingQueuePatchChunk(input, database)
}

export const projectReviewServingQueueRebuildRows = async (
  input: ProjectReviewServingQueueRebuildInput,
  database: Pick<ReviewServingQueueProjectorDatabase, 'run'> = getAppDatabaseService(),
) => {
  const {measure, phaseTimings} = getTimedProjector()
  await measure('writerMs', async () => {
    await logQueueProjectorPhaseStarted({
      chunkEndArticleId: input.chunkEndArticleId,
      chunkStartArticleId: input.chunkStartArticleId,
      phase: 'rebuildWriter',
      projectId: input.projectId,
      rangeCount: 1,
      snapshotId: input.snapshotId,
    })

    return writeReviewServingQueueRebuildRows(getReviewServingQueueRebuildWriterInput(input), database)
  })

  return withDiagnosticsJson({}, getQueueDiagnosticsJson({phaseTimings}))
}

const getReviewServingQueueRebuildWriterInput = (input: ProjectReviewServingQueueRebuildInput) => {
  return {
    projectId: input.projectId,
    rangePredicateSql: getQueueServingRangePredicate(input),
    rebuildSourceCtesSql: getReviewServingQueueRebuildSourceCtes(input),
    reviewConfigHash: input.reviewConfigHash,
    snapshotId: input.snapshotId,
  }
}

export const projectReviewServingQueueRebuildRanges = async (
  input: ProjectReviewServingQueueRebuildRangesInput,
  database: ReviewServingQueueProjectorDatabase = getAppDatabaseService() as ReviewServingQueueProjectorDatabase,
) => {
  const {measure, phaseTimings} = getTimedProjector()
  const writer = await measure('writerMs', async () => {
    const [firstRange] = input.ranges

    await logQueueProjectorPhaseStarted({
      chunkEndArticleId: firstRange?.chunkEndArticleId,
      chunkStartArticleId: firstRange?.chunkStartArticleId,
      phase: 'rebuildBatchWriter',
      projectId: firstRange?.projectId ?? 'unknown',
      rangeCount: input.ranges.length,
      snapshotId: firstRange?.snapshotId,
    })

    return writeReviewServingQueueRebuildRanges(
      {
        ranges: input.ranges.map((range) => {
          return getReviewServingQueueRebuildWriterInput(range)
        }),
      },
      database,
    )
  })

  return withDiagnosticsJson({}, getQueueDiagnosticsJson({phaseTimings, writer: writer.diagnostics}))
}

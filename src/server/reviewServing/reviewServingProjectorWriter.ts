import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  advanceReviewServingProjectorWatermark,
  assertReviewServingProjectorWatermarkCanAdvance,
  type ReviewServingProjectorWatermarkAdvanceInput,
} from './reviewServingDeltaReconciliation.ts'
import {
  completeReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkClaim,
  type ReviewServingDirtyWorkInput,
  upsertReviewServingDirtyWork,
} from './reviewServingDirtyWorkService.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getReviewServingSnapshotManifest,
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingSnapshotManifestInput,
  upsertReviewServingProjectionIdentityManifest,
} from './reviewServingManifestRepository.ts'
import {compactReviewServingCandidateSnapshotPatches} from './reviewServingRetentionService.ts'
import {validateReviewServingCandidateSnapshotManifest} from './reviewServingSnapshotPromotionService.ts'

export type ReviewServingProjectorWriterDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(operation: (tx: ReviewServingProjectorWriterTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingProjectorWriterTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingProjectorWritableTable =
  | 'app.review_selected_article_import_v4'
  | 'mart.review_article_filter_posting_patch_v4'
  | 'mart.review_article_display_patch_v4'
  | 'mart.review_human_status_patch_v4'
  | 'mart.review_llm_status_patch_v4'
  | 'mart.review_queue_patch_v4'
  | 'mart.review_selected_import_patch_v4'
  | 'mart.review_article_count_serving_v4'
  | 'mart.review_article_filter_posting_serving_v4'
  | 'mart.review_article_judgment_detail_serving_v4'
  | 'mart.review_article_serving_payload_v4'
  | 'mart.review_article_serving_v4'
  | 'mart.review_article_summary_contribution_v4'
  | 'mart.review_article_summary_contribution_rebuild_partial_v4'
  | 'mart.review_article_summary_rebuild_partial_v4'
  | 'mart.review_filter_facet_serving_v4'
  | 'mart.review_filter_option_serving_v4'
  | 'mart.review_filter_posting_stats_v4'
  | 'mart.review_title_search_serving_v4'
  | 'mart.review_unassessed_queue_serving_v4'

export type ReviewServingProjectorRecordValue = Date | ReviewServingIdentityValue | readonly string[] | null

export type ReviewServingProjectorRecord = {
  keyColumns: readonly string[]
  table: ReviewServingProjectorWritableTable
  values: Record<string, ReviewServingProjectorRecordValue>
}

export type DeleteReviewServingProjectorRowsInput = {
  predicates: Record<string, ReviewServingProjectorRecordValue | readonly string[]>
  table: ReviewServingProjectorWritableTable
}

export type PromoteReviewServingProjectorSnapshotInput = {
  projectId: string
  reviewConfigHash?: string | null
  snapshotId: string
}

export type PromoteReviewServingProjectorSnapshotResult =
  | {error: string; promoted: false; snapshotId: string}
  | {promoted: true; snapshotId: string}

export type ReviewServingSelectedImportSnapshotCursorInput = {
  cursorJson: ReviewServingIdentityValue | null
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
  sourceDeltaHighWater: number
  status: 'candidate' | 'completed'
}

export type WriteReviewServingTitleSearchRebuildRowsInput = {
  activitySortAtSql: string
  articleRangePredicateSql: string
  articleTitleSql: string
  projectId: string
  projectScopeIdentity: string
  searchIdentity: string
  selectedImportJoinSql: string
  snapshotId: string
  targetArticleRangePredicateSql: string
  titlePrefixLength: number
}

export type WriteReviewServingTitleSearchRebuildRangesInput = {
  ranges: readonly WriteReviewServingTitleSearchRebuildRowsInput[]
}

const projectorRecordBatchSize = 250
const reviewServingProjectorDeleteScopedInsertOnlyTables = new Set<string>([
  'app.review_selected_article_import_v4',
  'mart.review_human_status_patch_v4',
  'mart.review_llm_status_patch_v4',
])

export type WriteReviewServingQueueRebuildRowsInput = {
  projectId: string
  queueIdentitySql: string
  rangePredicateSql: string
  rebuildSourceCtesSql: string
  reviewConfigHash: string
  snapshotId: string
}

export type WriteReviewServingProjectorComponentInput = {
  acknowledgements?: readonly ReviewServingDirtyWorkClaim[]
  candidateSnapshot?: ReviewServingSnapshotManifestInput
  component: ReviewServingProjectionComponent
  projectionManifests?: readonly ReviewServingProjectionIdentityManifestInput[]
  records?: readonly ReviewServingProjectorRecord[]
  repairDirtyWork?: readonly ReviewServingDirtyWorkInput[]
  selectedImportSnapshotCursor?: ReviewServingSelectedImportSnapshotCursorInput
  snapshotPromotion?: PromoteReviewServingProjectorSnapshotInput
  statements?: readonly string[]
  watermark?: ReviewServingProjectorWatermarkAdvanceInput
}

export type ReviewServingProjectorRecordWriteDiagnostics = {
  batchCount: number
  batchesByTable: Record<string, number>
  dedupedRecordCount: number
  dedupedRecordsByTable: Record<string, number>
  inputRecordCount: number
  inputRecordsByTable: Record<string, number>
  writeMsByTable: Record<string, number>
}

export type ReviewServingProjectorWriterDiagnostics = {
  phaseTimings: Record<string, number>
  records: ReviewServingProjectorRecordWriteDiagnostics
  statements: {count: number}
}

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const incrementDiagnosticsCounter = (target: Record<string, number>, key: string, increment: number) => {
  target[key] = (target[key] ?? 0) + increment
}

const getReviewServingProjectorHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const getSqlRecordValue = (value: ReviewServingProjectorRecordValue) => {
  if (value instanceof Date) {
    return getSqlLiteral(value.toISOString())
  }

  return Array.isArray(value) ? getSqlLiteral(value) : getSqlLiteral(value)
}

const getReviewServingJsonLiteral = (value: ReviewServingIdentityValue) => {
  return `${getSqlLiteral(getStableReviewServingJson(value))}::JSON`
}

const getReviewServingNullableJsonLiteral = (value: ReviewServingIdentityValue | null | undefined) => {
  return value === null || value === undefined ? 'NULL' : getReviewServingJsonLiteral(value)
}

const getReviewServingDeletePredicate = (
  column: string,
  value: ReviewServingProjectorRecordValue | readonly string[],
) => {
  return Array.isArray(value)
    ? `${column} IN (${value
        .map((entry) => {
          return getSqlLiteral(entry)
        })
        .join(', ')})`
    : `${column} IS NOT DISTINCT FROM ${getSqlRecordValue(value)}`
}

export const getDeleteReviewServingProjectorRowsStatement = (input: DeleteReviewServingProjectorRowsInput) => {
  const predicates = Object.entries(input.predicates).map(([column, value]) => {
    return getReviewServingDeletePredicate(column, value)
  })

  return `DELETE FROM ${input.table} WHERE ${predicates.join(' AND ')}`
}

export const deleteReviewServingProjectorRows = async (
  input: DeleteReviewServingProjectorRowsInput,
  tx: ReviewServingProjectorWriterTransaction,
) => {
  await tx.run(getDeleteReviewServingProjectorRowsStatement(input))
}

export const getReviewServingProjectorReplayKey = (input: {
  articleId?: string | null
  baseGeneration: number
  contributionKey?: string | null
  filterKey?: string | null
  patchWatermark: number
  projectionIdentity: string
  promptId?: string | null
  snapshotId: string
}) => {
  return `projectorReplay:${getReviewServingProjectorHash('review-serving-projector-replay', {
    articleId: input.articleId ?? null,
    baseGeneration: input.baseGeneration,
    contributionKey: input.contributionKey ?? null,
    filterKey: input.filterKey ?? null,
    patchWatermark: input.patchWatermark,
    projectionIdentity: input.projectionIdentity,
    promptId: input.promptId ?? null,
    snapshotId: input.snapshotId,
  }).slice(0, 32)}`
}

const writeReviewServingProjectorRecordBatch = async (
  records: readonly ReviewServingProjectorRecord[],
  tx: ReviewServingProjectorWriterTransaction,
  options: {insertOnly: boolean} = {insertOnly: false},
) => {
  const firstRecord = records[0]
  if (firstRecord === undefined) {
    return
  }

  const columns = Object.keys(firstRecord.values)
  const keyColumns = firstRecord.keyColumns
  const table = firstRecord.table
  const assignments = columns
    .filter((column) => {
      return !keyColumns.includes(column)
    })
    .map((column) => {
      return `${column} = excluded.${column}`
    })
  const conflictUpdate = assignments.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${assignments.join(', ')}`
  const conflictClause = options.insertOnly
    ? ''
    : `
    ON CONFLICT(${keyColumns.join(', ')}) ${conflictUpdate}`

  await tx.run(`
    INSERT INTO ${table} (
      ${columns.join(',\n      ')}
    ) VALUES (
      ${records
        .map((record) => {
          return columns
            .map((column) => {
              return getSqlRecordValue(record.values[column] ?? null)
            })
            .join(',\n      ')
        })
        .join('\n    ),\n    (')}
    )
    ${conflictClause}
  `)
}

const getReviewServingProjectorRecordShapeKey = (record: ReviewServingProjectorRecord) => {
  return `${record.table}\n${record.keyColumns.join('\t')}\n${Object.keys(record.values).join('\t')}`
}

const getReviewServingProjectorRecordPrimaryKey = (record: ReviewServingProjectorRecord) => {
  return record.keyColumns
    .map((column) => {
      return `${column}=${getSqlRecordValue(record.values[column] ?? null)}`
    })
    .join('\t')
}

const getDedupedReviewServingProjectorRecords = (records: readonly ReviewServingProjectorRecord[]) => {
  const dedupedRecords = new Map<string, ReviewServingProjectorRecord>()

  records.forEach((record) => {
    dedupedRecords.set(getReviewServingProjectorRecordPrimaryKey(record), record)
  })

  return [...dedupedRecords.values()]
}

const writeReviewServingProjectorRecords = async (
  records: readonly ReviewServingProjectorRecord[],
  tx: ReviewServingProjectorWriterTransaction,
  options: {insertOnlyTables?: ReadonlySet<string>} = {},
) => {
  const recordGroups = new Map<string, ReviewServingProjectorRecord[]>()
  const diagnostics: ReviewServingProjectorRecordWriteDiagnostics = {
    batchCount: 0,
    batchesByTable: {},
    dedupedRecordCount: 0,
    dedupedRecordsByTable: {},
    inputRecordCount: records.length,
    inputRecordsByTable: {},
    writeMsByTable: {},
  }

  records.forEach((record) => {
    incrementDiagnosticsCounter(diagnostics.inputRecordsByTable, record.table, 1)

    const key = getReviewServingProjectorRecordShapeKey(record)
    const group = recordGroups.get(key)

    if (group === undefined) {
      recordGroups.set(key, [record])
      return
    }

    group.push(record)
  })

  for (const group of recordGroups.values()) {
    const dedupedGroup = getDedupedReviewServingProjectorRecords(group)
    const table = group[0]?.table ?? 'unknown'
    const insertOnly = options.insertOnlyTables?.has(table) ?? false

    diagnostics.dedupedRecordCount += dedupedGroup.length
    incrementDiagnosticsCounter(diagnostics.dedupedRecordsByTable, table, dedupedGroup.length)

    for (let index = 0; index < dedupedGroup.length; index += projectorRecordBatchSize) {
      const batchStartedAtMs = Date.now()
      await writeReviewServingProjectorRecordBatch(dedupedGroup.slice(index, index + projectorRecordBatchSize), tx, {
        insertOnly,
      })
      diagnostics.batchCount += 1
      incrementDiagnosticsCounter(diagnostics.batchesByTable, table, 1)
      incrementDiagnosticsCounter(diagnostics.writeMsByTable, table, getNonNegativeElapsedMs(batchStartedAtMs))
    }
  }

  return diagnostics
}

const getReviewServingProjectorDeleteScopedTables = (statements: readonly string[]) => {
  const tables = new Set<string>()

  statements.forEach((statement) => {
    for (const match of statement.matchAll(/\bDELETE\s+FROM\s+([a-zA-Z_]\w*\.[a-zA-Z_]\w*)\b/giu)) {
      const table = match[1]

      if (table !== undefined && reviewServingProjectorDeleteScopedInsertOnlyTables.has(table)) {
        tables.add(table)
      }
    }
  })

  return tables
}

const createCandidateReviewServingSnapshotManifestFromWriter = async (
  input: ReviewServingSnapshotManifestInput,
  tx: ReviewServingProjectorWriterTransaction,
) => {
  await tx.run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id,
      snapshot_id,
      snapshot_status,
      review_config_hash,
      composed_identity_json,
      component_state_json,
      required_components_json,
      optional_components_json,
      source_watermarks_json,
      validation_result_json,
      selected_import_snapshot_id,
      last_known_good_snapshot_id,
      updated_at
    ) VALUES (
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.snapshotId)},
      'candidate',
      ${getSqlLiteral(input.reviewConfigHash ?? null)},
      ${getReviewServingJsonLiteral(input.composedIdentity)},
      ${getReviewServingJsonLiteral(input.componentState as unknown as ReviewServingIdentityValue)},
      ${getReviewServingJsonLiteral(input.componentRequirements.requiredComponents)},
      ${getReviewServingJsonLiteral(input.componentRequirements.optionalComponents)},
      ${getReviewServingJsonLiteral(input.sourceWatermarks)},
      ${getReviewServingNullableJsonLiteral(input.validationResult)},
      ${getSqlLiteral(input.selectedImportSnapshotId ?? null)},
      ${getSqlLiteral(input.lastKnownGoodSnapshotId ?? null)},
      current_timestamp
    )
    ON CONFLICT(project_id, snapshot_id) DO UPDATE SET
      snapshot_status = 'candidate',
      review_config_hash = excluded.review_config_hash,
      composed_identity_json = excluded.composed_identity_json,
      component_state_json = excluded.component_state_json,
      required_components_json = excluded.required_components_json,
      optional_components_json = excluded.optional_components_json,
      source_watermarks_json = excluded.source_watermarks_json,
      validation_result_json = excluded.validation_result_json,
      selected_import_snapshot_id = excluded.selected_import_snapshot_id,
      last_known_good_snapshot_id = excluded.last_known_good_snapshot_id,
      failed_at = NULL,
      last_error = NULL,
      updated_at = excluded.updated_at
  `)
}

const writeReviewServingSelectedImportSnapshotCursor = async (
  input: ReviewServingSelectedImportSnapshotCursorInput,
  tx: ReviewServingProjectorWriterTransaction,
) => {
  await tx.run(`
    INSERT INTO app.review_selected_import_snapshot (
      selected_import_snapshot_id,
      project_id,
      project_scope_identity,
      source_delta_high_water,
      cursor_json,
      status,
      started_at,
      completed_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(input.selectedImportSnapshotId)},
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.projectScopeIdentity)},
      ${getSqlLiteral(input.sourceDeltaHighWater)},
      ${getReviewServingNullableJsonLiteral(input.cursorJson)},
      ${getSqlLiteral(input.status)},
      current_timestamp,
      ${input.status === 'completed' ? 'current_timestamp' : 'NULL'},
      current_timestamp
    )
    ON CONFLICT(selected_import_snapshot_id) DO UPDATE SET
      project_id = excluded.project_id,
      project_scope_identity = excluded.project_scope_identity,
      source_delta_high_water = excluded.source_delta_high_water,
      cursor_json = excluded.cursor_json,
      status = excluded.status,
      completed_at = excluded.completed_at,
      last_error = NULL,
      updated_at = excluded.updated_at
  `)
}

export const promoteReviewServingProjectorSnapshot = async (
  input: PromoteReviewServingProjectorSnapshotInput,
  database: ReviewServingProjectorWriterDatabase = getAppDatabaseService() as ReviewServingProjectorWriterDatabase,
): Promise<PromoteReviewServingProjectorSnapshotResult> => {
  return database.transaction(async (tx) => {
    const candidate = await getReviewServingSnapshotManifest(
      {projectId: input.projectId, snapshotId: input.snapshotId},
      tx,
    )

    if (candidate === null || candidate.status !== 'candidate') {
      return {error: 'candidate snapshot manifest is missing', promoted: false, snapshotId: input.snapshotId}
    }

    const validation = await validateReviewServingCandidateSnapshotManifest(candidate, tx)

    if (!validation.ok) {
      return {error: validation.error, promoted: false, snapshotId: input.snapshotId}
    }

    await tx.run(`
      UPDATE app.review_serving_snapshot_manifest
      SET
        validation_result_json = ${getReviewServingJsonLiteral(validation.validationResult)},
        updated_at = current_timestamp
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND snapshot_status = 'candidate'
    `)

    await compactReviewServingCandidateSnapshotPatches(
      {candidate},
      {
        queryJson: tx.queryJson,
        run: tx.run,
        transaction: async (operation) => {
          return operation(tx)
        },
      },
    )

    const candidateReviewConfigHash = candidate.reviewConfigHash
    const active = await getActiveReviewServingSnapshotManifest(
      {projectId: input.projectId, reviewConfigHash: candidateReviewConfigHash},
      tx,
    )
    const lastKnownGoodSnapshotId = active?.snapshotId ?? active?.lastKnownGoodSnapshotId ?? null

    await tx.run(`
      UPDATE app.review_serving_snapshot_manifest
      SET
        snapshot_status = 'retired',
        updated_at = current_timestamp
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(candidateReviewConfigHash)}
        AND snapshot_status = 'active'
        AND snapshot_id <> ${getSqlLiteral(input.snapshotId)}
    `)
    await tx.run(`
      UPDATE app.review_serving_snapshot_manifest
      SET
        snapshot_status = 'active',
        last_known_good_snapshot_id = ${getSqlLiteral(lastKnownGoodSnapshotId)},
        activated_at = current_timestamp,
        failed_at = NULL,
        last_error = NULL,
        updated_at = current_timestamp
      WHERE project_id = ${getSqlLiteral(input.projectId)}
        AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
        AND snapshot_status = 'candidate'
    `)

    return {promoted: true, snapshotId: input.snapshotId}
  })
}

const getReviewServingTitleSearchRebuildRowsStatements = (input: WriteReviewServingTitleSearchRebuildRowsInput) => {
  return [
    `
    DELETE FROM mart.review_title_search_serving_v4 search
    WHERE search.project_id = ${getSqlLiteral(input.projectId)}
      AND search.search_identity = ${getSqlLiteral(input.searchIdentity)}
      AND search.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND search.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      ${input.targetArticleRangePredicateSql}
  `,
    `
    INSERT INTO mart.review_title_search_serving_v4 (
      project_id,
      search_identity,
      project_scope_identity,
      snapshot_id,
      token,
      article_id,
      title_prefix,
      activity_sort_at,
      search_updated_at
    )
    WITH source AS (
      SELECT
        scope.article_id,
        lower(strip_accents(COALESCE(${input.articleTitleSql}, ''))) AS normalized_title,
        ${input.activitySortAtSql} AS activity_sort_at
      FROM mart.project_scope_article scope
      LEFT JOIN app."article" article
        ON article.id = scope.article_id
      ${input.selectedImportJoinSql}
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        AND article.id IS NOT NULL
        ${input.articleRangePredicateSql}
    ), tokenized AS (
      SELECT DISTINCT
        source.article_id,
        token_rows.token,
        left(source.normalized_title, ${getSqlLiteral(input.titlePrefixLength)}) AS title_prefix,
        source.activity_sort_at
      FROM source
      CROSS JOIN unnest(regexp_split_to_array(source.normalized_title, '[^a-z0-9]+')) AS token_rows(token)
      WHERE token_rows.token <> ''
    )
    SELECT
      ${getSqlLiteral(input.projectId)} AS project_id,
      ${getSqlLiteral(input.searchIdentity)} AS search_identity,
      ${getSqlLiteral(input.projectScopeIdentity)} AS project_scope_identity,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      tokenized.token,
      tokenized.article_id,
      tokenized.title_prefix,
      tokenized.activity_sort_at,
      current_timestamp AS search_updated_at
    FROM tokenized
    ON CONFLICT(project_id, search_identity, project_scope_identity, snapshot_id, token, article_id) DO UPDATE SET
      title_prefix = excluded.title_prefix,
      activity_sort_at = excluded.activity_sort_at,
      search_updated_at = excluded.search_updated_at
  `,
  ]
}

export const writeReviewServingTitleSearchRebuildRows = async (
  input: WriteReviewServingTitleSearchRebuildRowsInput,
  database: Pick<ReviewServingProjectorWriterDatabase, 'run'> = getAppDatabaseService(),
) => {
  await getReviewServingTitleSearchRebuildRowsStatements(input).reduce<Promise<void>>(async (previous, statement) => {
    await previous
    await database.run(statement)
  }, Promise.resolve())
}

export const writeReviewServingTitleSearchRebuildRanges = async (
  input: WriteReviewServingTitleSearchRebuildRangesInput,
  database: ReviewServingProjectorWriterDatabase = getAppDatabaseService() as ReviewServingProjectorWriterDatabase,
) => {
  await writeReviewServingProjectorComponent(
    {
      component: 'search',
      projectionManifests: [],
      records: [],
      statements: input.ranges.flatMap((range) => {
        return getReviewServingTitleSearchRebuildRowsStatements(range)
      }),
    },
    database,
  )
}

export const writeReviewServingQueueRebuildRows = async (
  input: WriteReviewServingQueueRebuildRowsInput,
  database: Pick<ReviewServingProjectorWriterDatabase, 'run'> = getAppDatabaseService(),
) => {
  await database.run(`
    DELETE FROM mart.review_unassessed_queue_serving_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
      ${input.rangePredicateSql}
  `)

  await database.run(`
    INSERT INTO mart.review_unassessed_queue_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      queue_identity,
      queue_kind,
      priority_bucket,
      activity_sort_at,
      article_id,
      prompt_id,
      queue_updated_at
    )
    WITH ${input.rebuildSourceCtesSql}
    SELECT DISTINCT
      ${getSqlLiteral(input.projectId)} AS project_id,
      queue.review_config_hash,
      ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
      ${input.queueIdentitySql} AS queue_identity,
      queue.queue_kind,
      queue.priority_bucket,
      queue.activity_sort_at,
      queue.article_id,
      queue.prompt_id,
      current_timestamp AS queue_updated_at
    FROM queue_union queue
    WHERE NOT queue.tombstone
    ON CONFLICT(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id, prompt_id, queue_identity) DO UPDATE SET
      queue_updated_at = excluded.queue_updated_at
  `)
}

export const writeReviewServingProjectorComponent = async (
  input: WriteReviewServingProjectorComponentInput,
  database: ReviewServingProjectorWriterDatabase = getAppDatabaseService() as ReviewServingProjectorWriterDatabase,
) => {
  return database.transaction(async (tx) => {
    const statements = input.statements ?? []
    const insertOnlyTables = getReviewServingProjectorDeleteScopedTables(statements)
    const phaseTimings: Record<string, number> = {}
    const measure = async <T>(phase: string, operation: () => Promise<T>) => {
      const startedAtMs = Date.now()
      const result = await operation()
      phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
      return result
    }

    if (input.watermark !== undefined) {
      await measure('watermarkAssertMs', async () => {
        await assertReviewServingProjectorWatermarkCanAdvance(
          tx,
          input.watermark as ReviewServingProjectorWatermarkAdvanceInput,
        )
      })
    }

    if (input.candidateSnapshot !== undefined) {
      await measure('candidateSnapshotMs', async () => {
        await createCandidateReviewServingSnapshotManifestFromWriter(
          input.candidateSnapshot as ReviewServingSnapshotManifestInput,
          tx,
        )
      })
    }

    await measure('projectionManifestsMs', async () => {
      await (input.projectionManifests ?? []).reduce<Promise<void>>((previous, manifest) => {
        return previous.then(async () => {
          await upsertReviewServingProjectionIdentityManifest(manifest, tx)
        })
      }, Promise.resolve())
    })

    await measure('statementsMs', async () => {
      await statements.reduce<Promise<void>>((previous, statement) => {
        return previous.then(async () => {
          await tx.run(statement)
        })
      }, Promise.resolve())
    })

    const recordDiagnostics = await measure('recordsMs', async () => {
      return writeReviewServingProjectorRecords(input.records ?? [], tx, {insertOnlyTables})
    })

    if (input.selectedImportSnapshotCursor !== undefined) {
      await measure('selectedImportSnapshotCursorMs', async () => {
        await writeReviewServingSelectedImportSnapshotCursor(
          input.selectedImportSnapshotCursor as ReviewServingSelectedImportSnapshotCursorInput,
          tx,
        )
      })
    }

    await measure('repairDirtyWorkMs', async () => {
      await (input.repairDirtyWork ?? []).reduce<Promise<void>>((previous, dirtyWork) => {
        return previous.then(async () => {
          await upsertReviewServingDirtyWork(dirtyWork, tx)
        })
      }, Promise.resolve())
    })

    if (input.acknowledgements !== undefined) {
      await measure('acknowledgementsMs', async () => {
        await completeReviewServingDirtyWorkClaims(input.acknowledgements ?? [], tx)
      })
    }

    if (input.watermark !== undefined) {
      await measure('watermarkAdvanceMs', async () => {
        await advanceReviewServingProjectorWatermark(tx, input.watermark as ReviewServingProjectorWatermarkAdvanceInput)
      })
    }

    if (input.snapshotPromotion !== undefined) {
      await measure('snapshotPromotionMs', async () => {
        await promoteReviewServingProjectorSnapshot(
          input.snapshotPromotion as PromoteReviewServingProjectorSnapshotInput,
          {
            queryJson: tx.queryJson,
            run: tx.run,
            transaction: async (operation) => {
              return operation(tx)
            },
          },
        )
      })
    }

    return {
      component: input.component,
      diagnostics: {
        phaseTimings,
        records: recordDiagnostics,
        statements: {count: statements.length},
      } satisfies ReviewServingProjectorWriterDiagnostics,
      promotedSnapshotId: input.snapshotPromotion?.snapshotId ?? null,
    }
  })
}

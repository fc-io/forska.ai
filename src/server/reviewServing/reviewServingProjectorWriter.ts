import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type DuckdbWorkloadContext, runWithDuckdbWorkloadDiagnosticContext} from '../utils/duckdbService.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  advanceReviewServingProjectorWatermark,
  assertReviewServingProjectorWatermarkCanAdvance,
  type ReviewServingProjectorWatermarkAdvanceInput,
} from './reviewServingDeltaReconciliation.ts'
import {
  completeReviewServingDirtyWorkClaims,
  completeReviewServingDirtyWorkCoveredByRebuild,
  type ReviewServingDirtyWorkClaim,
  type ReviewServingDirtyWorkCoverage,
  type ReviewServingDirtyWorkInput,
  upsertReviewServingDirtyWork,
} from './reviewServingDirtyWorkService.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getReviewServingProjectionIdentityManifest,
  getReviewServingSnapshotManifest,
  type ReviewServingProjectionIdentityManifestInput,
  type ReviewServingSnapshotManifest,
  type ReviewServingSnapshotManifestInput,
  upsertReviewServingProjectionIdentityManifest,
} from './reviewServingManifestRepository.ts'
import {
  selectedImportCompatibilityView,
  selectedImportPublishedTable,
} from './reviewServingSelectedImportMaintenance.ts'
import {validateReviewServingCandidateSnapshotManifest} from './reviewServingSnapshotPromotionService.ts'

export type ReviewServingProjectorWriterDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(
    operation: (tx: ReviewServingProjectorWriterTransaction) => Promise<T>,
    workloadContext?: DuckdbWorkloadContext,
  ) => Promise<T>
}

export type ReviewServingProjectorWriterTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingProjectorWritableTable =
  | 'mart.review_selected_article_import_staging_v4'
  | 'mart.review_article_count_serving_v4'
  | 'mart.review_article_filter_posting_serving_v4'
  | 'mart.review_article_judgment_detail_serving_v4'
  | 'mart.review_article_serving_base_v4'
  | 'mart.review_article_serving_list_mode_state_v4'
  | 'mart.review_article_summary_rebuild_accumulator_v4'
  | 'mart.review_article_summary_rebuild_accumulator_chunk_v4'
  | 'mart.review_filter_facet_serving_v4'
  | 'mart.review_filter_option_serving_v4'
  | 'mart.review_title_search_serving_v4'
  | 'mart.review_unassessed_queue_article_rank_serving_v4'
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

export type RemoveReviewServingTitleSearchArticleIdsInput = {
  articleIds: readonly string[]
  projectId: string
  projectScopeIdentity: string
  searchIdentity: string
  snapshotId: string
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

const getPromotedSnapshotDirtyWorkCoverages = async (
  candidate: ReviewServingSnapshotManifest,
  database: ReviewServingProjectorWriterTransaction,
): Promise<ReviewServingDirtyWorkCoverage[]> => {
  const componentStates = [...candidate.componentState.required, ...candidate.componentState.optional]
  const coverages = await componentStates.reduce<Promise<ReviewServingDirtyWorkCoverage[]>>(async (previous, state) => {
    const accumulated = await previous
    const manifest = await getReviewServingProjectionIdentityManifest(
      {
        projectId: candidate.projectId,
        projectionComponent: state.component,
        projectionIdentity: state.projectionIdentity,
      },
      database,
    )

    if (manifest === null) {
      return accumulated
    }

    const manifestCoverages = Object.entries(manifest.inputWatermarks).flatMap(
      ([sourcePartition, completedSourceHighWaterMark]) => {
        return Number.isFinite(completedSourceHighWaterMark)
          ? [
              {
                completedSourceHighWaterMark,
                projectId: candidate.projectId,
                projectionComponent: state.component,
                projectionIdentity: state.projectionIdentity,
                sourcePartition,
              },
            ]
          : []
      },
    )

    return [...accumulated, ...manifestCoverages]
  }, Promise.resolve([]))

  return coverages
}

export type WriteReviewServingTitleSearchRebuildRowsInput = {
  articleRangePredicateSql: string
  articleTitleSql: string
  projectId: string
  projectScopeIdentity: string
  searchIdentity: string
  selectedImportJoinSql: string
  snapshotId: string
}

export type WriteReviewServingTitleSearchRebuildRangesInput = {
  ranges: readonly WriteReviewServingTitleSearchRebuildRowsInput[]
}

const projectorRecordBatchSize = 250
const reviewServingProjectorRecordBatchSizeByTable = new Map<string, number>()
const reviewServingProjectorDeleteScopedInsertOnlyTables = new Set<string>([
  'mart.review_article_count_serving_v4',
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_filter_option_serving_v4',
])
const reviewServingProjectorScanGuardedInsertMissingTables = new Set<string>([])
const reviewServingDeleteFreeSummaryScanGuardedInsertMissingTables = new Set<string>([
  'mart.review_filter_option_serving_v4',
])

const getRelationMutationPattern = (relationName: string) => {
  return new RegExp(
    String.raw`\b(?:insert(?:\s+or\s+replace)?\s+into|update|delete\s+from|create(?:\s+or\s+replace)?\s+(?:table|view)(?:\s+if\s+not\s+exists)?|alter\s+(?:table|view)|drop\s+(?:table|view)(?:\s+if\s+exists)?|truncate\s+table)\s+${relationName.replaceAll(
      '.',
      String.raw`\s*\.\s*`,
    )}\b`,
    'iu',
  )
}

const selectedImportCompatibilityMutationPattern = getRelationMutationPattern(selectedImportCompatibilityView)
const selectedImportPublishedMutationPattern = getRelationMutationPattern(selectedImportPublishedTable)

const assertSelectedImportCompatibilityViewIsReadOnly = (input: WriteReviewServingProjectorComponentInput) => {
  const guardedStatements = [...(input.statements ?? []), ...(input.postRecordStatements ?? [])]
  const blockedStatement = guardedStatements.find((statement) => {
    return selectedImportCompatibilityMutationPattern.test(statement)
  })
  const blockedRecord = (input.records ?? []).find((record) => {
    return (record.table as string) === selectedImportCompatibilityView
  })

  if (blockedStatement !== undefined || blockedRecord !== undefined) {
    throw new Error(
      `${selectedImportCompatibilityView} is a read-only compatibility view over ${selectedImportPublishedTable}`,
    )
  }
}

const assertSelectedImportPublishedMutationsAreOwned = (input: WriteReviewServingProjectorComponentInput) => {
  if (input.component === 'selectedImport') {
    return
  }

  const guardedStatements = [...(input.statements ?? []), ...(input.postRecordStatements ?? [])]
  const blockedStatement = guardedStatements.find((statement) => {
    return selectedImportPublishedMutationPattern.test(statement)
  })
  const blockedRecord = (input.records ?? []).find((record) => {
    return (record.table as string) === selectedImportPublishedTable
  })

  if (blockedStatement !== undefined || blockedRecord !== undefined) {
    throw new Error(
      `${selectedImportPublishedTable} mutations must go through the selectedImport projector ownership path`,
    )
  }
}

export type WriteReviewServingQueueRebuildRowsInput = {
  projectId: string
  rangePredicateSql: string
  rebuildSourceCtesSql: string
  reviewConfigHash: string
  snapshotId: string
}

export type WriteReviewServingQueueRebuildRangesInput = {ranges: readonly WriteReviewServingQueueRebuildRowsInput[]}

export type WriteReviewServingProjectorComponentInput = {
  acknowledgements?: readonly ReviewServingDirtyWorkClaim[]
  candidateSnapshot?: ReviewServingSnapshotManifestInput
  component: ReviewServingProjectionComponent
  projectionManifests?: readonly ReviewServingProjectionIdentityManifestInput[]
  postRecordStatements?: readonly string[]
  records?: readonly ReviewServingProjectorRecord[]
  repairDirtyWork?: readonly ReviewServingDirtyWorkInput[]
  scanGuardedInsertMissingRecordTables?: readonly ReviewServingProjectorWritableTable[]
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

const getReviewServingProjectorWriterWorkloadContext = (
  component: ReviewServingProjectionComponent | 'snapshotPromotion',
): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: true,
    fallbackIntent: 'reject',
    routeOrJobKey: `reviewServing.projector.writer.${component}`,
    searchMode: 'none',
    workloadClass: 'reviewProjector',
  }
}

const getReviewServingProjectorHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const mergeReviewServingTitleSearchArticleIdsSql = (incomingArticleIdsSql: string, existingArticleIdsSql: string) => {
  return `list_sort(list_distinct(list_concat(COALESCE(${existingArticleIdsSql}, []::VARCHAR[]), COALESCE(${incomingArticleIdsSql}, []::VARCHAR[]))))`
}

const mergeReviewServingQueuePromptIdsSql = (incomingPromptIdsSql: string, existingPromptIdsSql: string) => {
  return `list_sort(list_distinct(list_concat(COALESCE(${existingPromptIdsSql}, []::VARCHAR[]), COALESCE(${incomingPromptIdsSql}, []::VARCHAR[]))))`
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

export const getRemoveReviewServingTitleSearchArticleIdsStatements = (
  input: RemoveReviewServingTitleSearchArticleIdsInput,
) => {
  if (input.articleIds.length === 0) {
    return []
  }

  const scopedPredicate = [
    `project_id = ${getSqlLiteral(input.projectId)}`,
    `project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}`,
    `search_identity = ${getSqlLiteral(input.searchIdentity)}`,
    `snapshot_id = ${getSqlLiteral(input.snapshotId)}`,
  ].join(' AND ')
  const articleIdsSql = `${getSqlLiteral(input.articleIds)}::VARCHAR[]`

  return [
    `UPDATE mart.review_title_search_serving_v4
      SET article_ids = list_filter(article_ids, article_id -> NOT list_contains(${articleIdsSql}, article_id))
      WHERE ${scopedPredicate}
        AND list_has_any(article_ids, ${articleIdsSql})`,
    `DELETE FROM mart.review_title_search_serving_v4
      WHERE ${scopedPredicate}
        AND length(article_ids) = 0`,
  ]
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
  options: {insertOnly: boolean; scanGuardedInsertMissing: boolean} = {
    insertOnly: false,
    scanGuardedInsertMissing: false,
  },
) => {
  const firstRecord = records[0]
  if (firstRecord === undefined) {
    return
  }

  const columns = Object.keys(firstRecord.values)
  const keyColumns = firstRecord.keyColumns
  const table = firstRecord.table
  const incomingAlias = 'incoming'
  const existingAlias = 'existing'
  const scanPredicate = keyColumns
    .map((column) => {
      return `(${existingAlias}.${column} || '') = (${incomingAlias}.${column} || '')`
    })
    .join('\n        AND ')
  const valuesSql = records
    .map((record) => {
      return columns
        .map((column) => {
          return getSqlRecordValue(record.values[column] ?? null)
        })
        .join(',\n      ')
    })
    .join('\n    ),\n    (')

  if (options.scanGuardedInsertMissing) {
    await tx.run(`
    INSERT INTO ${table} (
      ${columns.join(',\n      ')}
    )
    SELECT ${columns.join(', ')}
    FROM (
      VALUES (
      ${valuesSql}
    )
    ) AS ${incomingAlias}(${columns.join(', ')})
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${table} ${existingAlias}
      WHERE ${scanPredicate}
    )
  `)
    return
  }

  if (!options.insertOnly) {
    const updateAssignments = columns
      .filter((column) => {
        return !keyColumns.includes(column)
      })
      .map((column) => {
        return table === 'mart.review_title_search_serving_v4' && column === 'article_ids'
          ? `${column} = ${mergeReviewServingTitleSearchArticleIdsSql(`${incomingAlias}.${column}`, `${existingAlias}.${column}`)}`
          : table === 'mart.review_unassessed_queue_serving_v4' && column === 'prompt_ids'
            ? `${column} = ${mergeReviewServingQueuePromptIdsSql(`${incomingAlias}.${column}`, `${existingAlias}.${column}`)}`
            : `${column} = ${incomingAlias}.${column}`
      })

    if (updateAssignments.length > 0) {
      await tx.run(`
    UPDATE ${table} ${existingAlias}
    SET
      ${updateAssignments.join(',\n      ')}
    FROM (
      VALUES (
      ${valuesSql}
    )
    ) AS ${incomingAlias}(${columns.join(', ')})
    WHERE ${scanPredicate}
  `)
    }

    await tx.run(`
    INSERT INTO ${table} (
      ${columns.join(',\n      ')}
    )
    SELECT ${columns.join(', ')}
    FROM (
      VALUES (
      ${valuesSql}
    )
    ) AS ${incomingAlias}(${columns.join(', ')})
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${table} ${existingAlias}
      WHERE ${scanPredicate}
    )
  `)
    return
  }

  await tx.run(`
    INSERT INTO ${table} (
      ${columns.join(',\n      ')}
    ) VALUES (
      ${valuesSql}
    )
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
  options: {insertOnlyTables?: ReadonlySet<string>; scanGuardedInsertMissingTables?: ReadonlySet<string>} = {},
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
    const scanGuardedInsertMissing =
      reviewServingProjectorScanGuardedInsertMissingTables.has(table)
      || (options.scanGuardedInsertMissingTables?.has(table) ?? false)

    diagnostics.dedupedRecordCount += dedupedGroup.length
    incrementDiagnosticsCounter(diagnostics.dedupedRecordsByTable, table, dedupedGroup.length)

    const batchSize = reviewServingProjectorRecordBatchSizeByTable.get(table) ?? projectorRecordBatchSize

    for (let index = 0; index < dedupedGroup.length; index += batchSize) {
      const batchStartedAtMs = Date.now()
      await writeReviewServingProjectorRecordBatch(dedupedGroup.slice(index, index + batchSize), tx, {
        insertOnly,
        scanGuardedInsertMissing,
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

const getReviewServingProjectorDeleteFreeSummaryScanGuardedInsertMissingTables = (
  input: WriteReviewServingProjectorComponentInput,
) => {
  if (input.component !== 'summary') {
    return new Set<string>()
  }

  const statements = input.statements ?? []
  const deletedTables = new Set<string>()

  statements.forEach((statement) => {
    for (const match of statement.matchAll(/\bDELETE\s+FROM\s+([a-zA-Z_]\w*\.[a-zA-Z_]\w*)\b/giu)) {
      const table = match[1]

      if (table !== undefined) {
        deletedTables.add(table)
      }
    }
  })

  const tables = new Set<string>()
  const records = input.records ?? []

  records.forEach((record) => {
    if (
      reviewServingDeleteFreeSummaryScanGuardedInsertMissingTables.has(record.table)
      && !deletedTables.has(record.table)
    ) {
      tables.add(record.table)
    }
  })

  return tables
}

const createCandidateReviewServingSnapshotManifestFromWriter = async (
  input: ReviewServingSnapshotManifestInput,
  tx: ReviewServingProjectorWriterTransaction,
) => {
  await tx.run(`
    UPDATE app.review_serving_snapshot_manifest
    SET
      snapshot_status = 'candidate',
      review_config_hash = ${getSqlLiteral(input.reviewConfigHash ?? null)},
      composed_identity_json = ${getReviewServingJsonLiteral(input.composedIdentity)},
      component_state_json = ${getReviewServingJsonLiteral(input.componentState as unknown as ReviewServingIdentityValue)},
      required_components_json = ${getReviewServingJsonLiteral(input.componentRequirements.requiredComponents)},
      optional_components_json = ${getReviewServingJsonLiteral(input.componentRequirements.optionalComponents)},
      source_watermarks_json = ${getReviewServingJsonLiteral(input.sourceWatermarks)},
      validation_result_json = ${getReviewServingNullableJsonLiteral(input.validationResult)},
      selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId ?? null)},
      last_known_good_snapshot_id = ${getSqlLiteral(input.lastKnownGoodSnapshotId ?? null)},
      failed_at = NULL,
      last_error = NULL,
      updated_at = current_timestamp
    WHERE (project_id || '') = (${getSqlLiteral(input.projectId)} || '')
      AND (snapshot_id || '') = (${getSqlLiteral(input.snapshotId)} || '')
  `)

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
    )
    SELECT
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
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_snapshot_manifest existing
      WHERE (existing.project_id || '') = (${getSqlLiteral(input.projectId)} || '')
        AND (existing.snapshot_id || '') = (${getSqlLiteral(input.snapshotId)} || '')
    )
  `)
}

const writeReviewServingSelectedImportSnapshotCursor = async (
  input: ReviewServingSelectedImportSnapshotCursorInput,
  tx: ReviewServingProjectorWriterTransaction,
) => {
  await tx.run(`
    UPDATE app.review_selected_import_snapshot
    SET
      project_id = ${getSqlLiteral(input.projectId)},
      project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)},
      source_delta_high_water = ${getSqlLiteral(input.sourceDeltaHighWater)},
      cursor_json = ${getReviewServingNullableJsonLiteral(input.cursorJson)},
      status = ${getSqlLiteral(input.status)},
      completed_at = ${input.status === 'completed' ? 'current_timestamp' : 'NULL'},
      last_error = NULL,
      updated_at = current_timestamp
    WHERE (selected_import_snapshot_id || '') = (${getSqlLiteral(input.selectedImportSnapshotId)} || '')
  `)

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
    )
    SELECT
      ${getSqlLiteral(input.selectedImportSnapshotId)},
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.projectScopeIdentity)},
      ${getSqlLiteral(input.sourceDeltaHighWater)},
      ${getReviewServingNullableJsonLiteral(input.cursorJson)},
      ${getSqlLiteral(input.status)},
      current_timestamp,
      ${input.status === 'completed' ? 'current_timestamp' : 'NULL'},
      current_timestamp
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_selected_import_snapshot existing
      WHERE (existing.selected_import_snapshot_id || '') = (${getSqlLiteral(input.selectedImportSnapshotId)} || '')
    )
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

    await completeReviewServingDirtyWorkCoveredByRebuild(await getPromotedSnapshotDirtyWorkCoverages(candidate, tx), tx)

    return {promoted: true, snapshotId: input.snapshotId}
  }, getReviewServingProjectorWriterWorkloadContext('snapshotPromotion'))
}

const getReviewServingTitleSearchRebuildRowsCteSql = (input: WriteReviewServingTitleSearchRebuildRowsInput) => {
  return `
    WITH source_rows AS (
      SELECT
        scope.article_id,
        lower(strip_accents(COALESCE(${input.articleTitleSql}, ''))) AS normalized_title
      FROM mart.project_scope_article scope
      LEFT JOIN app."article" article
        ON article.id = scope.article_id
      ${input.selectedImportJoinSql}
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        AND article.id IS NOT NULL
        ${input.articleRangePredicateSql}
    ), source AS (
      SELECT
        article_id,
        ANY_VALUE(normalized_title) AS normalized_title
      FROM source_rows
      GROUP BY article_id
    ), tokenized_source AS (
      SELECT DISTINCT
        source.article_id,
        token_rows.token
      FROM source
      CROSS JOIN unnest(regexp_split_to_array(source.normalized_title, '[^a-z0-9]+')) AS token_rows(token)
      WHERE token_rows.token <> ''
    ), tokenized AS (
      SELECT
        article_id,
        token
      FROM tokenized_source
      GROUP BY article_id, token
    ), final_rows AS (
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.searchIdentity)} AS search_identity,
        ${getSqlLiteral(input.projectScopeIdentity)} AS project_scope_identity,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        tokenized.token,
        LIST(DISTINCT tokenized.article_id ORDER BY tokenized.article_id) AS article_ids
      FROM tokenized
      GROUP BY project_id, search_identity, project_scope_identity, snapshot_id, tokenized.token
    )
  `
}

const getReviewServingTitleSearchRebuildRowsStatements = (input: WriteReviewServingTitleSearchRebuildRowsInput) => {
  const finalRowsCteSql = getReviewServingTitleSearchRebuildRowsCteSql(input)

  return [
    `
    UPDATE mart.review_title_search_serving_v4 existing
    SET article_ids = (SELECT LIST(DISTINCT merged_article_id ORDER BY merged_article_id)
      FROM (
        SELECT existing_article.article_id AS merged_article_id
        FROM unnest(COALESCE(existing.article_ids, []::VARCHAR[])) AS existing_article(article_id)
        UNION ALL
        SELECT final_article.article_id AS merged_article_id
        FROM unnest(COALESCE(final_rows.article_ids, []::VARCHAR[])) AS final_article(article_id)
      ) merged_article_ids
    )
    FROM (
      ${finalRowsCteSql}
      SELECT
        final_rows.project_id,
        final_rows.search_identity,
        final_rows.project_scope_identity,
        final_rows.snapshot_id,
        final_rows.token,
        final_rows.article_ids
      FROM final_rows
    ) final_rows
    WHERE existing.project_id IS NOT DISTINCT FROM final_rows.project_id
      AND existing.search_identity IS NOT DISTINCT FROM final_rows.search_identity
      AND existing.project_scope_identity IS NOT DISTINCT FROM final_rows.project_scope_identity
      AND existing.snapshot_id IS NOT DISTINCT FROM final_rows.snapshot_id
      AND existing.token IS NOT DISTINCT FROM final_rows.token
  `,
    `
    INSERT INTO mart.review_title_search_serving_v4 (
      project_id,
      search_identity,
      project_scope_identity,
      snapshot_id,
      token,
      article_ids
    )
    ${finalRowsCteSql}
    SELECT
      final_rows.project_id,
      final_rows.search_identity,
      final_rows.project_scope_identity,
      final_rows.snapshot_id,
      final_rows.token,
      final_rows.article_ids
    FROM final_rows
    WHERE NOT EXISTS (
      SELECT 1
      FROM mart.review_title_search_serving_v4 existing
      WHERE existing.project_id IS NOT DISTINCT FROM final_rows.project_id
        AND existing.search_identity IS NOT DISTINCT FROM final_rows.search_identity
        AND existing.project_scope_identity IS NOT DISTINCT FROM final_rows.project_scope_identity
        AND existing.snapshot_id IS NOT DISTINCT FROM final_rows.snapshot_id
        AND existing.token IS NOT DISTINCT FROM final_rows.token
    )
  `,
  ]
}

const getReviewServingTitleSearchRebuildRangeExpression = (predicateSql: string) => {
  const trimmed = predicateSql.trim()

  if (trimmed.length === 0) {
    return 'TRUE'
  }

  if (trimmed.match(/^AND\b/i) === null) {
    return null
  }

  return `(${trimmed.replace(/^AND\b/i, '').trim()})`
}

const getReviewServingTitleSearchRebuildCombinedRangeInput = (
  ranges: readonly WriteReviewServingTitleSearchRebuildRowsInput[],
) => {
  const [firstRange] = ranges

  if (firstRange === undefined) {
    return null
  }

  const expressions = ranges.map((range) => {
    return getReviewServingTitleSearchRebuildRangeExpression(range.articleRangePredicateSql)
  })

  if (
    expressions.some((expression) => {
      return expression === null
    })
  ) {
    return null
  }

  const isCompatible = ranges.every((range) => {
    return (
      range.articleTitleSql === firstRange.articleTitleSql
      && range.projectId === firstRange.projectId
      && range.projectScopeIdentity === firstRange.projectScopeIdentity
      && range.searchIdentity === firstRange.searchIdentity
      && range.selectedImportJoinSql === firstRange.selectedImportJoinSql
      && range.snapshotId === firstRange.snapshotId
    )
  })

  if (!isCompatible) {
    return null
  }

  return {
    ...firstRange,
    articleRangePredicateSql: `
        AND (${expressions.join(' OR ')})`,
  }
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
  const phaseTimings: Record<string, number> = {}
  const startedAtMs = Date.now()
  const combinedRangeInput = getReviewServingTitleSearchRebuildCombinedRangeInput(input.ranges)
  const statements =
    combinedRangeInput === null
      ? input.ranges.flatMap((range) => {
          return getReviewServingTitleSearchRebuildRowsStatements(range)
        })
      : getReviewServingTitleSearchRebuildRowsStatements(combinedRangeInput)

  await statements.reduce<Promise<void>>(async (previous, statement) => {
    await previous
    await database.run(statement)
  }, Promise.resolve())

  phaseTimings.statementsMs = getNonNegativeElapsedMs(startedAtMs)

  return {
    component: 'search' as const,
    diagnostics: {
      phaseTimings,
      records: {
        batchCount: 0,
        batchesByTable: {},
        dedupedRecordCount: 0,
        dedupedRecordsByTable: {},
        inputRecordCount: 0,
        inputRecordsByTable: {},
        writeMsByTable: {},
      },
      statements: {count: statements.length},
    } satisfies ReviewServingProjectorWriterDiagnostics,
    promotedSnapshotId: null,
  }
}

const getReviewServingQueueRebuildRowsStatements = (input: WriteReviewServingQueueRebuildRowsInput) => {
  const articleRankRowsCteSql = `WITH ${input.rebuildSourceCtesSql},
    queue_rows AS (
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        queue.review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        queue.queue_kind,
        queue.priority_bucket,
        queue.article_id,
        queue.activity_sort_at,
        current_timestamp AS queue_updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY
            project_id,
            queue.review_config_hash,
            snapshot_id,
            queue.queue_kind,
            queue.article_id
          ORDER BY queue.priority_bucket DESC, queue.activity_sort_at DESC, queue.article_id DESC
        ) AS article_rank
      FROM queue_union queue
      WHERE NOT queue.tombstone
        AND queue.prompt_id IS NOT NULL
    ),
    final_article_rank_rows AS (
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        queue_kind,
        priority_bucket,
        article_id,
        activity_sort_at,
        queue_updated_at
      FROM queue_rows
      WHERE article_rank = 1
    )`

  return [
    `
    UPDATE mart.review_unassessed_queue_article_rank_serving_v4 existing
    SET
      priority_bucket = final_article_rank_rows.priority_bucket,
      activity_sort_at = final_article_rank_rows.activity_sort_at,
      queue_updated_at = final_article_rank_rows.queue_updated_at
    FROM (
      ${articleRankRowsCteSql}
      SELECT * FROM final_article_rank_rows
    ) final_article_rank_rows
    WHERE existing.project_id IS NOT DISTINCT FROM final_article_rank_rows.project_id
      AND existing.review_config_hash IS NOT DISTINCT FROM final_article_rank_rows.review_config_hash
      AND existing.snapshot_id IS NOT DISTINCT FROM final_article_rank_rows.snapshot_id
      AND existing.queue_kind IS NOT DISTINCT FROM final_article_rank_rows.queue_kind
      AND existing.article_id IS NOT DISTINCT FROM final_article_rank_rows.article_id
  `,
    `
    INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      queue_kind,
      priority_bucket,
      article_id,
      activity_sort_at,
      queue_updated_at
    )
    ${articleRankRowsCteSql}
    SELECT
      project_id,
      review_config_hash,
      snapshot_id,
      queue_kind,
      priority_bucket,
      article_id,
      activity_sort_at,
      queue_updated_at
    FROM final_article_rank_rows
    WHERE NOT EXISTS (
      SELECT 1
      FROM mart.review_unassessed_queue_article_rank_serving_v4 existing
      WHERE existing.project_id IS NOT DISTINCT FROM final_article_rank_rows.project_id
        AND existing.review_config_hash IS NOT DISTINCT FROM final_article_rank_rows.review_config_hash
        AND existing.snapshot_id IS NOT DISTINCT FROM final_article_rank_rows.snapshot_id
        AND existing.queue_kind IS NOT DISTINCT FROM final_article_rank_rows.queue_kind
        AND existing.article_id IS NOT DISTINCT FROM final_article_rank_rows.article_id
    )
  `,
  ]
}

export const writeReviewServingQueueRebuildRows = async (
  input: WriteReviewServingQueueRebuildRowsInput,
  database: Pick<ReviewServingProjectorWriterDatabase, 'run'> = getAppDatabaseService(),
) => {
  await getReviewServingQueueRebuildRowsStatements(input).reduce<Promise<void>>(async (previous, statement) => {
    await previous
    await database.run(statement)
  }, Promise.resolve())
}

export const writeReviewServingQueueRebuildRanges = async (
  input: WriteReviewServingQueueRebuildRangesInput,
  database: ReviewServingProjectorWriterDatabase = getAppDatabaseService() as ReviewServingProjectorWriterDatabase,
) => {
  return writeReviewServingProjectorComponent(
    {
      component: 'queue',
      projectionManifests: [],
      records: [],
      statements: input.ranges.flatMap((range) => {
        return getReviewServingQueueRebuildRowsStatements(range)
      }),
    },
    database,
  )
}

export const writeReviewServingProjectorComponent = async (
  input: WriteReviewServingProjectorComponentInput,
  database: ReviewServingProjectorWriterDatabase = getAppDatabaseService() as ReviewServingProjectorWriterDatabase,
) => {
  assertSelectedImportCompatibilityViewIsReadOnly(input)
  assertSelectedImportPublishedMutationsAreOwned(input)

  return database.transaction(async (tx) => {
    const statements = input.statements ?? []
    const insertOnlyTables = getReviewServingProjectorDeleteScopedTables(statements)
    const scanGuardedInsertMissingTables = new Set<string>(input.scanGuardedInsertMissingRecordTables ?? [])
    getReviewServingProjectorDeleteFreeSummaryScanGuardedInsertMissingTables(input).forEach((table) => {
      scanGuardedInsertMissingTables.add(table)
    })
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
      return writeReviewServingProjectorRecords(input.records ?? [], tx, {
        insertOnlyTables,
        scanGuardedInsertMissingTables,
      })
    })

    await measure('postRecordStatementsMs', async () => {
      await (input.postRecordStatements ?? []).reduce<Promise<void>>((previous, statement) => {
        return previous.then(async () => {
          await tx.run(statement)
        })
      }, Promise.resolve())
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
            transaction: async (operation, workloadContext) => {
              return workloadContext === undefined
                ? operation(tx)
                : runWithDuckdbWorkloadDiagnosticContext(workloadContext, () => {
                    return operation(tx)
                  })
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
  }, getReviewServingProjectorWriterWorkloadContext(input.component))
}

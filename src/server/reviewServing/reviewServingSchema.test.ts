import {readdirSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {reviewServingReadContractList} from './reviewServingReadContracts.ts'

const reviewServingPhase1MigrationPaths = [
  '../../db/duckdbMigrations/0097_reviewServingV4Foundation.sql',
  '../../db/duckdbMigrations/0098_reviewServingPayloadOrderColumns.sql',
  '../../db/duckdbMigrations/0099_reviewServingCountScopeAndDetailOptionTables.sql',
  '../../db/duckdbMigrations/0100_reviewServingFilterOptionValueKey.sql',
  '../../db/duckdbMigrations/0101_reviewServingFacetSummaryScope.sql',
  '../../db/duckdbMigrations/0102_reviewWriteOverlayReadSurface.sql',
  '../../db/duckdbMigrations/0103_reviewServingQueueIdentityPrimaryKey.sql',
  '../../db/duckdbMigrations/0105_reviewServingArticleMetadataStatus.sql',
  '../../db/duckdbMigrations/0106_reviewServingRemoveHotSourceMetadata.sql',
  '../../db/duckdbMigrations/0107_reviewServingRebuildRequest.sql',
  '../../db/duckdbMigrations/0109_reviewServingJudgmentDetailPayloadKindForwardMigration.sql',
  '../../db/duckdbMigrations/0112_reviewServingSummaryRebuildPartial.sql',
  '../../db/duckdbMigrations/0113_reviewServingSummaryContributionRebuildPartial.sql',
  '../../db/duckdbMigrations/0118_dropReviewQueuePatchV4.sql',
  '../../db/duckdbMigrations/0119_dropReviewHumanStatusPatchV4.sql',
  '../../db/duckdbMigrations/0120_dropReviewLlmStatusPatchV4.sql',
  '../../db/duckdbMigrations/0121_dropReviewArticleFilterPostingPatchV4.sql',
  '../../db/duckdbMigrations/0122_dropReviewArticleDisplayPatchV4.sql',
  '../../db/duckdbMigrations/0123_dropReviewTitleSearchActivitySortAt.sql',
  '../../db/duckdbMigrations/0124_dropReviewSelectedImportDisplayCopyColumns.sql',
  '../../db/duckdbMigrations/0125_reviewServingJudgmentDetailIsAnswered.sql',
  '../../db/duckdbMigrations/0126_dropReviewSelectedImportPatchV4.sql',
  '../../db/duckdbMigrations/0127_dropReviewTitleSearchUnusedColumns.sql',
  '../../db/duckdbMigrations/0128_dropReviewArticleServingIdentityCopyColumns.sql',
  '../../db/duckdbMigrations/0129_dropReviewFilterPostingStatsDerivedColumns.sql',
  '../../db/duckdbMigrations/0130_dropReviewFilterOptionPayloadJson.sql',
  '../../db/duckdbMigrations/0131_dropReviewArticleServingSelectedRankCopy.sql',
  '../../db/duckdbMigrations/0132_dropReviewPayloadBytes.sql',
  '../../db/duckdbMigrations/0133_dropReviewFilterPostingServingIdentity.sql',
  '../../db/duckdbMigrations/0134_dropReviewArticleServingReviewProgressCopy.sql',
  '../../db/duckdbMigrations/0135_reviewServingJudgmentDetailPromptScalars.sql',
  '../../db/duckdbMigrations/0136_dropReviewSummaryPartialServingKey.sql',
  '../../db/duckdbMigrations/0137_reviewServingJudgmentDetailHumanScalars.sql',
  '../../db/duckdbMigrations/0138_dropReviewJudgmentDetailModelId.sql',
  '../../db/duckdbMigrations/0139_dropReviewQueueServingIdentity.sql',
  '../../db/duckdbMigrations/0140_dropReviewFilterPostingServingUpdatedAt.sql',
  '../../db/duckdbMigrations/0141_dropReviewSummaryContributionServing.sql',
  '../../db/duckdbMigrations/0142_reviewRebuildPartialCleanupAuthorization.sql',
  '../../db/duckdbMigrations/0143_dropReviewSelectedImportBaseFlags.sql',
  '../../db/duckdbMigrations/0144_dropReviewProjectImportDeltaCursor.sql',
] as const
const reviewServingPhase1MigrationSqlByPath = Object.fromEntries(
  reviewServingPhase1MigrationPaths.map((migrationPath) => {
    return [migrationPath, readFileSync(resolve(import.meta.dir, migrationPath), 'utf8')]
  }),
)
const schemaMigrationSql = reviewServingPhase1MigrationPaths
  .map((migrationPath) => {
    return reviewServingPhase1MigrationSqlByPath[migrationPath]
  })
  .join('\n')
const reviewServingFoundationSchemaSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0097_reviewServingV4Foundation.sql']
const payloadOrderForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0098_reviewServingPayloadOrderColumns.sql']
const countScopeForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0099_reviewServingCountScopeAndDetailOptionTables.sql'
  ]
const filterOptionValueForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0100_reviewServingFilterOptionValueKey.sql']
const facetSummaryScopeForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0101_reviewServingFacetSummaryScope.sql']
const articleMetadataStatusForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0105_reviewServingArticleMetadataStatus.sql']
const judgmentDetailPayloadKindForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0109_reviewServingJudgmentDetailPayloadKindForwardMigration.sql'
  ]
const reviewQueuePatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0118_dropReviewQueuePatchV4.sql']
const reviewHumanStatusPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0119_dropReviewHumanStatusPatchV4.sql']
const reviewLlmStatusPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0120_dropReviewLlmStatusPatchV4.sql']
const reviewArticleFilterPostingPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0121_dropReviewArticleFilterPostingPatchV4.sql']
const reviewArticleDisplayPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0122_dropReviewArticleDisplayPatchV4.sql']
const reviewTitleSearchActivitySortAtDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0123_dropReviewTitleSearchActivitySortAt.sql']
const reviewSelectedImportDisplayCopyColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0124_dropReviewSelectedImportDisplayCopyColumns.sql']
const reviewJudgmentDetailIsAnsweredForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0125_reviewServingJudgmentDetailIsAnswered.sql']
const reviewJudgmentDetailPromptScalarsForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0135_reviewServingJudgmentDetailPromptScalars.sql']
const reviewSummaryPartialServingKeyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0136_dropReviewSummaryPartialServingKey.sql']
const reviewJudgmentDetailHumanScalarsForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0137_reviewServingJudgmentDetailHumanScalars.sql']
const reviewJudgmentDetailModelIdDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0138_dropReviewJudgmentDetailModelId.sql']
const reviewQueueServingIdentityDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0139_dropReviewQueueServingIdentity.sql']
const reviewFilterPostingServingUpdatedAtDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0140_dropReviewFilterPostingServingUpdatedAt.sql']
const reviewSummaryContributionServingDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0141_dropReviewSummaryContributionServing.sql']
const reviewSelectedImportBaseFlagDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0143_dropReviewSelectedImportBaseFlags.sql']
const reviewProjectImportDeltaCursorDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0144_dropReviewProjectImportDeltaCursor.sql']
const reviewSelectedImportPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0126_dropReviewSelectedImportPatchV4.sql']
const reviewTitleSearchUnusedColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0127_dropReviewTitleSearchUnusedColumns.sql']
const reviewArticleServingIdentityCopyColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0128_dropReviewArticleServingIdentityCopyColumns.sql'
  ]
const reviewFilterPostingStatsDerivedColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0129_dropReviewFilterPostingStatsDerivedColumns.sql']
const reviewFilterOptionPayloadJsonDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0130_dropReviewFilterOptionPayloadJson.sql']
const reviewArticleServingSelectedRankCopyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0131_dropReviewArticleServingSelectedRankCopy.sql']
const reviewPayloadBytesDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0132_dropReviewPayloadBytes.sql']
const reviewFilterPostingServingIdentityDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0133_dropReviewFilterPostingServingIdentity.sql']
const reviewArticleServingReviewProgressCopyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0134_dropReviewArticleServingReviewProgressCopy.sql']
const hotServingTables = [
  'mart.review_article_serving_v4',
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_count_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_filter_option_serving_v4',
  'mart.review_unassessed_queue_serving_v4',
] as const

const reviewServingPhase1Tables = [
  'app.import_run_article_delta',
  'app.review_change_delta',
  'app.review_source_change_outbox',
  'app.review_delta_reconciliation_cursor',
  'app.review_import_article_hot_field',
  'app.review_serving_dirty_work',
  'app.review_serving_dirty_work_ack',
  'app.review_serving_projector_watermark',
  'app.review_projection_identity_manifest',
  'app.review_rebuild_request',
  'app.review_rebuild_chunk_manifest',
  'app.review_selected_import_snapshot',
  'app.review_selected_article_import_v4',
  'app.review_serving_snapshot_manifest',
  'app.review_serving_snapshot_pin',
  'app.review_write_overlay',
  'app.review_bulk_operation_job',
  'app.review_search_job',
  'app.review_serving_retention_mark',
  'mart.review_title_search_serving_v4',
  'mart.review_article_serving_v4',
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_filter_posting_stats_v4',
  'mart.review_article_serving_payload_v4',
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_article_summary_contribution_rebuild_partial_v4',
  'mart.review_article_summary_rebuild_partial_v4',
  'mart.review_article_count_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_filter_option_serving_v4',
  'mart.review_unassessed_queue_serving_v4',
] as const
const retiredReviewServingTables = new Set<string>([
  'mart.review_queue_patch_v4',
  'mart.review_human_status_patch_v4',
  'mart.review_llm_status_patch_v4',
  'mart.review_article_filter_posting_patch_v4',
  'mart.review_article_display_patch_v4',
  'mart.review_selected_import_patch_v4',
  'mart.review_article_summary_contribution_v4',
])

const deltaEnvelopeColumns = [
  'delta_id',
  'change_kind',
  'source_table',
  'source_row_id',
  'source_operation',
  'source_partition',
  'source_high_water_mark',
  'source_updated_at',
  'idempotency_key',
  'payload_version',
  'payload_json',
  'created_at',
  'reconciled_at',
] as const

const escapeRegex = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const getLastDropTableIndex = (tableName: string) => {
  const dropMatches = [
    ...schemaMigrationSql.matchAll(new RegExp(`DROP TABLE(?: IF EXISTS)? ${escapeRegex(tableName)};`, 'g')),
  ]

  return dropMatches.at(-1)?.index ?? -1
}

const getTableSql = (tableName: string) => {
  const matches = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${escapeRegex(tableName)} \\([\\s\\S]*?\\n\\);`, 'g'),
    ),
  ]
  const lastMatch = matches.at(-1)

  if (lastMatch === undefined) {
    return ''
  }

  const lastDropIndex = retiredReviewServingTables.has(tableName) ? getLastDropTableIndex(tableName) : -1

  return lastDropIndex > (lastMatch.index ?? -1) ? '' : lastMatch[0]
}

const getTableColumnSql = (tableName: string) => {
  const alterColumnSql = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`ALTER TABLE ${escapeRegex(tableName)} ADD COLUMN IF NOT EXISTS [^;]+;`, 'g'),
    ),
  ]
    .map((match) => {
      return match[0]
    })
    .join('\n')

  return `${getTableSql(tableName)}\n${alterColumnSql}`
}

const getTableColumns = (tableName: string) => {
  const repairTableName = `${tableName}_repair`
  const hasRepairRename = schemaMigrationSql.includes(
    `ALTER TABLE ${repairTableName} RENAME TO ${tableName.split('.').at(-1)};`,
  )
  const sourceTableSql = hasRepairRename ? getTableSql(repairTableName) : getTableSql(tableName)
  const columns = new Set(
    [...sourceTableSql.matchAll(/^ {2}([a-z_][\w]*)\s+/gm)].map((match) => {
      return match[1]
    }),
  )
  const droppedColumnMatches = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`ALTER TABLE ${escapeRegex(tableName)} DROP COLUMN IF EXISTS ([a-z_][\\w]*);`, 'g'),
    ),
  ]

  droppedColumnMatches.forEach((match) => {
    columns.delete(match[1])
  })

  return columns
}

const getPhysicalColumnNameFromContractField = (field: string) => {
  const firstToken = field.trim().split(/\s+/)[0] ?? ''
  const columnName = firstToken.replace(/^.*\./, '')

  return /^[a-z_][\w]*$/.test(columnName) ? columnName : null
}

const getContractPhysicalColumns = (contract: (typeof reviewServingReadContractList)[number]) => {
  return [
    ...new Set(
      [...contract.cursorFields, ...contract.sort.fields]
        .map(getPhysicalColumnNameFromContractField)
        .filter((columnName): columnName is string => {
          return columnName !== null
        }),
    ),
  ]
}

const getMissingColumns = (tableName: string, columnNames: readonly string[]) => {
  const tableSql = getTableColumnSql(tableName)

  return columnNames.filter((columnName) => {
    return !new RegExp(`\\b${escapeRegex(columnName)}\\b`).test(tableSql)
  })
}

test('Phase 1 schema migration creates every review-serving table', () => {
  const missingTables = reviewServingPhase1Tables.filter((tableName) => {
    return getTableSql(tableName).length === 0
  })

  expect(missingTables).toEqual([])
})

test('retired patch tables are absent from the active review-serving schema', () => {
  expect(getTableSql('mart.review_queue_patch_v4')).toBe('')
  expect(reviewQueuePatchRetirementForwardMigrationSql.trim()).toBe('DROP TABLE IF EXISTS mart.review_queue_patch_v4;')
  expect(getTableSql('mart.review_human_status_patch_v4')).toBe('')
  expect(reviewHumanStatusPatchRetirementForwardMigrationSql.trim()).toBe(
    'DROP TABLE IF EXISTS mart.review_human_status_patch_v4;',
  )
  expect(getTableSql('mart.review_llm_status_patch_v4')).toBe('')
  expect(reviewLlmStatusPatchRetirementForwardMigrationSql.trim()).toBe(
    'DROP TABLE IF EXISTS mart.review_llm_status_patch_v4;',
  )
  expect(getTableSql('mart.review_article_filter_posting_patch_v4')).toBe('')
  expect(reviewArticleFilterPostingPatchRetirementForwardMigrationSql.trim()).toBe(
    'DROP TABLE IF EXISTS mart.review_article_filter_posting_patch_v4;',
  )
  expect(getTableSql('mart.review_article_display_patch_v4')).toBe('')
  expect(reviewArticleDisplayPatchRetirementForwardMigrationSql.trim()).toBe(
    'DROP TABLE IF EXISTS mart.review_article_display_patch_v4;',
  )
})

test('title search serving schema drops repeated unused metadata', () => {
  expect(reviewTitleSearchActivitySortAtDropForwardMigrationSql).toContain('Retired by 0127')
  expect(reviewTitleSearchUnusedColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_title_search_serving_v4_repair',
  )
  expect(reviewTitleSearchUnusedColumnDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_title_search_serving_v4_repair RENAME TO review_title_search_serving_v4;',
  )
  expect([...getTableColumns('mart.review_title_search_serving_v4')]).toEqual([
    'project_id',
    'search_identity',
    'project_scope_identity',
    'snapshot_id',
    'token',
    'article_id',
  ])
  expect(schemaMigrationSql).not.toContain('title_prefix')
  expect(schemaMigrationSql).not.toContain('search_updated_at')
})

test('selected import schema drops retired display-copy and selected-base flag columns', () => {
  expect(reviewSelectedImportDisplayCopyColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE app.review_selected_article_import_v4_repair',
  )
  expect(reviewSelectedImportDisplayCopyColumnDropForwardMigrationSql).toContain(
    'ALTER TABLE app.review_selected_article_import_v4_repair RENAME TO review_selected_article_import_v4;',
  )
  expect([...getTableColumns('app.review_selected_article_import_v4')]).toEqual([
    'project_id',
    'project_scope_identity',
    'selected_import_snapshot_id',
    'article_id',
    'import_route_id',
    'source_record_key',
    'selected_rank_key',
    'selected_rank_numeric',
    'tombstone',
    'selected_import_updated_at',
  ])
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).toContain(
    'CREATE TABLE app.review_selected_article_import_v4_flag_repair',
  )
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).toContain(
    'DROP TABLE app.review_selected_article_import_v4;',
  )
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).toContain(
    'ALTER TABLE app.review_selected_article_import_v4_flag_repair RENAME TO review_selected_article_import_v4;',
  )
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).not.toContain('duplicate_flag')
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).not.toContain('conflict_flag')
})

test('unassessed queue serving schema drops derived queue identity', () => {
  expect([...getTableColumns('mart.review_unassessed_queue_serving_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'queue_kind',
    'priority_bucket',
    'activity_sort_at',
    'article_id',
    'prompt_id',
    'queue_updated_at',
  ])
  expect(reviewQueueServingIdentityDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_unassessed_queue_serving_v4_without_queue_identity',
  )
  expect(reviewQueueServingIdentityDropForwardMigrationSql).toContain('MAX(queue_updated_at) AS queue_updated_at')
  expect(reviewQueueServingIdentityDropForwardMigrationSql).not.toContain('queue_identity VARCHAR')
})

test('projector watermark schema keeps lifecycle recovery fields nullable', () => {
  const projectorWatermarkSql = getTableSql('app.review_serving_projector_watermark')

  expect(projectorWatermarkSql).toContain('import_route_id VARCHAR')
  expect(projectorWatermarkSql).toContain('snapshot_id VARCHAR')
  expect(projectorWatermarkSql).toContain('lease_owner VARCHAR')
  expect(projectorWatermarkSql).toContain('lease_expires_at TIMESTAMPTZ')
  expect(projectorWatermarkSql).toContain('cursor_json JSON')
  expect(projectorWatermarkSql).toContain('last_error VARCHAR')
  expect(projectorWatermarkSql).not.toContain('snapshot_id VARCHAR NOT NULL')
  expect(projectorWatermarkSql).not.toContain('lease_owner VARCHAR NOT NULL')
  expect(projectorWatermarkSql).not.toContain('lease_expires_at TIMESTAMPTZ NOT NULL')
  expect(projectorWatermarkSql).not.toContain('cursor_json JSON NOT NULL')
  expect(projectorWatermarkSql).not.toContain('last_error VARCHAR NOT NULL')
})

test('summary rebuild partial schema drops derived serving key identity', () => {
  expect([...getTableColumns('mart.review_article_summary_rebuild_partial_v4')]).toEqual([
    'request_id',
    'chunk_id',
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'summary_kind',
    'summary_identity',
    'list_mode_key',
    'count_kind',
    'summary_definition_version',
    'filter_key',
    'facet_kind',
    'facet_key',
    'facet_value',
    'prompt_id',
    'answer_id',
    'answer_value',
    'availability',
    'stale_reason',
    'count_value',
    'partial_updated_at',
  ])
  expect(reviewSummaryPartialServingKeyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_summary_rebuild_partial_v4_without_serving_key',
  )
  expect(reviewSummaryPartialServingKeyDropForwardMigrationSql).toContain('SUM(COALESCE(count_value, 0))')
  expect(reviewSummaryPartialServingKeyDropForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_unique',
  )
  expect(schemaMigrationSql).not.toContain('serving_key VARCHAR')
})

test('Phase 1 schema migration creates every read-contract physical table', () => {
  const contractTables = [
    ...new Set(
      reviewServingReadContractList.map((contract) => {
        return contract.servingTable
      }),
    ),
  ]
  const missingTables = contractTables.filter((tableName) => {
    return getTableSql(tableName).length === 0
  })

  expect(missingTables).toEqual([])
})

const getRuntimeSourceFiles = (directoryPath: string): string[] => {
  return readdirSync(directoryPath, {withFileTypes: true}).flatMap((entry) => {
    const entryPath = resolve(directoryPath, entry.name)

    if (entry.isDirectory()) {
      return getRuntimeSourceFiles(entryPath)
    }

    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [entryPath] : []
  })
}

test('runtime review-serving code does not reference retired patch storage', () => {
  const runtimeSourceFiles = [
    ...getRuntimeSourceFiles(resolve(import.meta.dir, '.')),
    ...getRuntimeSourceFiles(resolve(import.meta.dir, '../workers')),
  ]
  const runtimeReferences = runtimeSourceFiles.flatMap((sourcePath) => {
    const source = readFileSync(sourcePath, 'utf8')
    const retiredReference = [...retiredReviewServingTables].find((tableName) => {
      return source.includes(tableName)
    })

    return retiredReference === undefined ? [] : [`${sourcePath}: ${retiredReference}`]
  })

  expect(runtimeReferences).toEqual([])
})

test('Phase 1 schema migration includes the common delta envelope', () => {
  expect(getMissingColumns('app.import_run_article_delta', deltaEnvelopeColumns)).toEqual([])
  expect(getMissingColumns('app.review_change_delta', deltaEnvelopeColumns)).toEqual([])
})

test('project import delta cursor is retired from the review-serving schema', () => {
  expect(getTableSql('app.review_project_import_delta_cursor')).toBe('')
  expect(reviewServingFoundationSchemaSql).not.toContain('app.review_project_import_delta_cursor')
  expect(reviewServingFoundationSchemaSql).not.toContain('idx_review_project_import_delta_cursor_route')
  expect(reviewProjectImportDeltaCursorDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS app.idx_review_project_import_delta_cursor_route;',
      'DROP INDEX IF EXISTS idx_review_project_import_delta_cursor_route;',
      'DROP TABLE IF EXISTS app.review_project_import_delta_cursor;',
    ].join('\n'),
  )
})

test('Phase 1 schema migration separates logical snapshots from component bases and patches', () => {
  expect(
    getMissingColumns('mart.review_article_serving_v4', ['snapshot_id', 'base_generation', 'patch_watermark']),
  ).toEqual([])
  expect(getMissingColumns('app.review_serving_snapshot_manifest', ['required_components_json'])).toEqual([])
  expect(getMissingColumns('app.review_serving_snapshot_manifest', ['optional_components_json'])).toEqual([])
})

test('Phase 5B schema migration adds rebuild request admission above chunk manifests', () => {
  expect(
    getMissingColumns('app.review_rebuild_request', [
      'request_id',
      'project_id',
      'requested_components_json',
      'source_watermarks_json',
      'identity_json',
      'status',
      'admission_state',
      'retry_policy_json',
      'retry_after',
      'oom_category',
      'over_budget_reason',
      'diagnostics_json',
    ]),
  ).toEqual([])
  expect(
    getMissingColumns('app.review_rebuild_chunk_manifest', [
      'request_id',
      'parent_chunk_id',
      'split_depth',
      'snapshot_id',
      'snapshot_count',
      'retry_count',
      'retry_after',
      'oom_category',
      'over_budget_reason',
      'max_input_rows',
      'max_output_rows',
      'max_output_bytes',
      'max_payload_bytes',
      'max_prompt_count',
      'max_temp_bytes',
      'workload_class',
      'admission_state',
      'budget_json',
      'diagnostics_json',
    ]),
  ).toEqual([])
})

test('review-serving schema includes audited summary partial cleanup authorization', () => {
  expect(
    getMissingColumns('app.review_rebuild_partial_cleanup_authorization', [
      'authorization_id',
      'project_id',
      'review_config_hash',
      'request_id',
      'chunk_id',
      'snapshot_id',
      'partial_table',
      'cleanup_mode',
      'reason',
      'evidence_json',
      'expected_row_count',
      'observed_row_count',
      'operator_ack',
      'authorized_at',
      'expires_at',
      'applied_at',
      'applied_row_count',
    ]),
  ).toEqual([])
  expect(schemaMigrationSql).toContain('idx_review_rebuild_partial_cleanup_authorization_lookup')
})

test('Phase 1 schema migration keeps raw payloads out of import hot fields', () => {
  const hotFieldSql = getTableSql('app.review_import_article_hot_field')

  expect(hotFieldSql).toContain('selected_rank_key')
  expect(hotFieldSql).toContain('publication_year')
  expect(hotFieldSql).not.toContain('payload_json')
  expect(hotFieldSql).not.toContain('source_metadata JSON')
})

test('Phase 1 schema migration keeps raw payloads out of hot serving tables', () => {
  expect(
    hotServingTables.flatMap((tableName) => {
      return getTableSql(tableName).includes('source_metadata JSON') ? [tableName] : []
    }),
  ).toEqual([])
  expect(getTableSql('mart.review_article_serving_payload_v4')).toContain('source_metadata JSON')
})

test('Phase 1 payload serving schema preserves prompt preview article ordering', () => {
  expect(getMissingColumns('mart.review_article_serving_payload_v4', ['article_created_at', 'article_id'])).toEqual([])
  expect(getTableColumns('mart.review_article_serving_payload_v4').has('payload_bytes')).toBe(false)
  expect(reviewPayloadBytesDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_repair',
  )
  expect(reviewPayloadBytesDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_repair RENAME TO review_article_serving_payload_v4;',
  )
})

test('Phase 1 article serving schema preserves review table display metadata', () => {
  expect(
    getMissingColumns('mart.review_article_serving_v4', [
      'article_updated_at',
      'arxiv_id',
      'biorxiv_id',
      'medrxiv_id',
      'doi',
      'pmid',
      'full_text_fetched_at',
      'full_text_conversion_status',
    ]),
  ).toEqual([])
  const removedIdentityColumns = [
    'display_identity',
    'project_scope_identity',
    'selected_import_identity',
    'llm_status_identity',
    'human_status_identity',
    'posting_identity',
    'summary_identity',
    'payload_identity',
    'selected_rank_key',
    'review_opened',
    'review_sections_completed',
  ]
  expect(
    [...getTableColumns('mart.review_article_serving_v4')].filter((columnName) => {
      return removedIdentityColumns.includes(columnName)
    }),
  ).toEqual([])
  expect(reviewArticleServingIdentityCopyColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_repair',
  )
  expect(reviewArticleServingSelectedRankCopyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_repair',
  )
  expect(reviewArticleServingSelectedRankCopyDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingReviewProgressCopyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_repair',
  )
  expect(reviewArticleServingReviewProgressCopyDropForwardMigrationSql).not.toContain('review_opened')
  expect(reviewArticleServingReviewProgressCopyDropForwardMigrationSql).not.toContain('review_sections_completed')
  expect(articleMetadataStatusForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4 ADD COLUMN IF NOT EXISTS article_updated_at TIMESTAMPTZ;',
  )
})

test('selected import patch mart is retired from the review-serving schema', () => {
  expect(reviewSelectedImportPatchRetirementForwardMigrationSql).toContain(
    'DROP TABLE IF EXISTS mart.review_selected_import_patch_v4',
  )
  expect(schemaMigrationSql).not.toContain('CREATE TABLE IF NOT EXISTS mart.review_selected_import_patch_v4')
  expect(schemaMigrationSql).not.toContain('idx_review_selected_import_patch_v4_lookup')
  expect(reviewServingPhase1Tables).not.toContain('mart.review_selected_import_patch_v4')
  expect(retiredReviewServingTables.has('mart.review_selected_import_patch_v4')).toBe(true)
})

test('summary contribution serving mart is retired from the review-serving schema', () => {
  expect(reviewSummaryContributionServingDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_article_summary_contribution_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_article_summary_contribution_v4_lookup;',
      'DROP TABLE IF EXISTS mart.review_article_summary_contribution_v4;',
    ].join('\n'),
  )
  expect(getTableSql('mart.review_article_summary_contribution_v4')).toBe('')
  expect(schemaMigrationSql).not.toContain('CREATE TABLE IF NOT EXISTS mart.review_article_summary_contribution_v4')
  expect(schemaMigrationSql).not.toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_summary_contribution_v4_lookup',
  )
  expect(reviewServingPhase1Tables).not.toContain('mart.review_article_summary_contribution_v4')
  expect(retiredReviewServingTables.has('mart.review_article_summary_contribution_v4')).toBe(true)
  expect(getTableSql('mart.review_article_summary_contribution_rebuild_partial_v4')).not.toBe('')
})

test('filter posting stats schema drops derived identity and selectivity columns', () => {
  expect(reviewFilterPostingStatsDerivedColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_filter_posting_stats_v4_repair',
  )
  expect(reviewFilterPostingStatsDerivedColumnDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_filter_posting_stats_v4_repair RENAME TO review_filter_posting_stats_v4;',
  )
  expect([...getTableColumns('mart.review_filter_posting_stats_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'filter_kind',
    'filter_value',
    'list_mode_key',
    'cardinality',
    'stats_updated_at',
  ])
  expect(schemaMigrationSql).not.toContain('selectivity DOUBLE')
  expect(getTableColumns('mart.review_article_filter_posting_serving_v4').has('posting_identity')).toBe(false)
  expect(reviewFilterPostingServingIdentityDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_filter_posting_serving_v4_repair',
  )
  expect(reviewFilterPostingServingIdentityDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingUpdatedAtDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_filter_posting_serving_v4_repair',
  )
  expect(reviewFilterPostingServingUpdatedAtDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingUpdatedAtDropForwardMigrationSql).not.toContain('posting_updated_at')
  expect(getTableColumns('mart.review_article_filter_posting_serving_v4').has('posting_updated_at')).toBe(false)
})

test('filter option schema drops reconstructable payload JSON column', () => {
  expect(reviewFilterOptionPayloadJsonDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_filter_option_serving_v4_repair',
  )
  expect(reviewFilterOptionPayloadJsonDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_filter_option_serving_v4_repair RENAME TO review_filter_option_serving_v4;',
  )
  expect([...getTableColumns('mart.review_filter_option_serving_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'search_identity',
    'filter_option_identity',
    'option_value_key',
    'filter_kind',
    'facet_key',
    'facet_value',
    'prompt_id',
    'answer_id',
    'numeric_min',
    'numeric_max',
    'count_value',
    'option_updated_at',
  ])
  expect(getTableColumns('mart.review_filter_option_serving_v4').has('option_payload_json')).toBe(false)
})

test('Phase 1 schema migration creates contract cursor and sort columns on non-job serving tables', () => {
  const missingColumns = reviewServingReadContractList
    .filter((contract) => {
      return contract.physicalAccessStrategy !== 'jobCriteria'
    })
    .flatMap((contract) => {
      const tableColumns = getTableColumns(contract.servingTable)

      return getContractPhysicalColumns(contract)
        .filter((columnName) => {
          return !tableColumns.has(columnName)
        })
        .map((columnName) => {
          return `${contract.key}:${contract.servingTable}.${columnName}`
        })
    })

  expect(missingColumns).toEqual([])
})

test('Phase 1 schema migration keeps job contracts on job cursor and sort columns', () => {
  const jobContractFields = reviewServingReadContractList
    .filter((contract) => {
      return contract.physicalAccessStrategy === 'jobCriteria'
    })
    .flatMap((contract) => {
      return getContractPhysicalColumns(contract).map((columnName) => {
        return `${contract.key}:${columnName}`
      })
    })
  const invalidJobContractFields = jobContractFields.filter((field) => {
    return !field.endsWith(':updated_at') && !field.endsWith(':job_id')
  })

  expect(invalidJobContractFields).toEqual([])
})

test('payload order forward migration upgrades already-applied review-serving schemas', () => {
  expect(payloadOrderForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4\nADD COLUMN IF NOT EXISTS article_created_at TIMESTAMPTZ;',
  )
  expect(payloadOrderForwardMigrationSql).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_preview_order',
  )
  expect(payloadOrderForwardMigrationSql).toContain(
    'ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_created_at, article_id);',
  )
})

test('Phase 1 schema migration keeps count rows list-mode scoped', () => {
  expect(getMissingColumns('mart.review_article_count_serving_v4', ['list_mode_key'])).toEqual([])
  expect(countScopeForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_article_count_serving_v4')
  expect(countScopeForwardMigrationSql).toContain("list_mode_key VARCHAR NOT NULL DEFAULT 'global'")
})

test('Phase 1 schema migration includes dedicated judgment detail and filter option tables', () => {
  expect(
    getMissingColumns('mart.review_article_judgment_detail_serving_v4', [
      'article_id',
      'prompt_id',
      'payload_kind',
      'is_answered',
      'prompt_original_text',
      'prompt_heading',
      'prompt_type',
      'prompt_criteria_disposition',
      'judgment_created_at',
      'human_comment',
      'judgment_payload_json',
      'placeholder_kind',
    ]),
  ).toEqual([])
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('model_id')).toBe(false)
  expect(
    getMissingColumns('mart.review_filter_option_serving_v4', [
      'filter_kind',
      'filter_option_identity',
      'option_value_key',
      'search_identity',
    ]),
  ).toEqual([])
  expect(countScopeForwardMigrationSql).toContain(
    'CREATE TABLE IF NOT EXISTS mart.review_article_judgment_detail_serving_v4',
  )
  expect(countScopeForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_article_judgment_detail_serving_v4')
  expect(countScopeForwardMigrationSql).toContain("payload_kind VARCHAR NOT NULL DEFAULT 'llm'")
  expect(reviewJudgmentDetailIsAnsweredForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_is_answered_next',
  )
  expect(reviewJudgmentDetailIsAnsweredForwardMigrationSql).toContain('is_answered BOOLEAN')
  expect(reviewJudgmentDetailIsAnsweredForwardMigrationSql).toContain(
    "TRY_CAST(json_extract_string(judgment_payload_json, '$.isAnswered') AS BOOLEAN)",
  )
  expect(reviewJudgmentDetailIsAnsweredForwardMigrationSql).toContain(
    'RENAME TO review_article_judgment_detail_serving_v4',
  )
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_prompt_scalars_next',
  )
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain('prompt_original_text VARCHAR')
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain('prompt_heading VARCHAR')
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain('prompt_type VARCHAR')
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain(
    'prompt_criteria_disposition project_prompt_criteria_disposition_v2',
  )
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain(
    'CASE WHEN placeholder_kind IS NOT NULL THEN NULL ELSE judgment_payload_json END AS judgment_payload_json',
  )
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain(
    'RENAME TO review_article_judgment_detail_serving_v4',
  )
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_human_scalars_next',
  )
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain('judgment_created_at TIMESTAMPTZ')
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain('human_comment VARCHAR')
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain(
    "WHEN payload_kind = 'human' THEN json_extract_string(judgment_payload_json, '$.comment')",
  )
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain(
    "WHEN payload_kind = 'human' OR placeholder_kind IS NOT NULL THEN NULL",
  )
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain(
    'RENAME TO review_article_judgment_detail_serving_v4',
  )
  expect(reviewJudgmentDetailModelIdDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair',
  )
  expect(reviewJudgmentDetailModelIdDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;',
  )
  expect(reviewJudgmentDetailModelIdDropForwardMigrationSql).not.toContain('model_id VARCHAR')
  expect(reviewJudgmentDetailModelIdDropForwardMigrationSql).not.toContain('model_id,')
  expect(countScopeForwardMigrationSql).toContain(
    'PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)',
  )
  expect(countScopeForwardMigrationSql).toContain('CREATE TABLE IF NOT EXISTS mart.review_filter_option_serving_v4')
  expect(countScopeForwardMigrationSql).toContain('option_value_key VARCHAR NOT NULL')
  expect(filterOptionValueForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_filter_option_serving_v4')
  expect(filterOptionValueForwardMigrationSql).toContain('option_value_key VARCHAR NOT NULL')
})

test('judgment detail payload-kind forward migration repairs already-applied V4 table shape', () => {
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    "ALTER TABLE mart.review_article_judgment_detail_serving_v4\nADD COLUMN IF NOT EXISTS payload_kind VARCHAR DEFAULT 'llm';",
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_payload_kind_next',
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    'PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)',
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    "SELECT\n  project_id,\n  review_config_hash,\n  snapshot_id,\n  list_mode_key,\n  COALESCE(payload_kind, 'llm') AS payload_kind,",
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    'ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);',
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain('UPDATE app.review_rebuild_request AS request')
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain('UPDATE app.review_rebuild_chunk_manifest')
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain("projection_component = 'judgmentInputContent'")
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain("request.status IN ('failed', 'blocked_over_budget')")
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    "chunk.status IN ('failed', 'blocked_over_budget', 'quarantined')",
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain('newer_request.project_id = request.project_id')
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    "status IN ('failed', 'blocked_over_budget', 'quarantined')",
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    'last_error ILIKE \'%Referenced column "payload_kind" not found%\'',
  )
})

test('Phase 1 schema migration keeps facets scoped by summary and facet kind in the final table shape', () => {
  expect(
    getMissingColumns('mart.review_filter_facet_serving_v4', [
      'answer_value',
      'facet_kind',
      'facet_key',
      'facet_value',
      'prompt_id',
      'summary_definition_version',
      'summary_identity',
    ]),
  ).toEqual([])
  expect(facetSummaryScopeForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_filter_facet_serving_v4')
  expect(facetSummaryScopeForwardMigrationSql).toContain(
    'PRIMARY KEY(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value, summary_definition_version)',
  )
})

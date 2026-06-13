import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {reviewServingReadContractList} from './reviewServingReadContracts.ts'

const schemaMigrationSql = readFileSync(
  resolve(import.meta.dir, '../../db/duckdbMigrations/0097_reviewServingV4Foundation.sql'),
  'utf8',
)

const reviewServingPhase1Tables = [
  'app.import_run_article_delta',
  'app.review_change_delta',
  'app.review_source_change_outbox',
  'app.review_delta_reconciliation_cursor',
  'app.review_import_article_hot_field',
  'app.review_serving_dirty_work',
  'app.review_serving_dirty_work_ack',
  'app.review_project_import_delta_cursor',
  'app.review_serving_projector_watermark',
  'app.review_projection_identity_manifest',
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
  'mart.review_article_display_patch_v4',
  'mart.review_selected_import_patch_v4',
  'mart.review_llm_status_patch_v4',
  'mart.review_human_status_patch_v4',
  'mart.review_queue_patch_v4',
  'mart.review_article_filter_posting_patch_v4',
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_filter_posting_stats_v4',
  'mart.review_article_serving_payload_v4',
  'mart.review_article_summary_contribution_v4',
  'mart.review_article_count_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_unassessed_queue_serving_v4',
] as const

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

const getTableSql = (tableName: string) => {
  const [match = ''] = schemaMigrationSql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${escapeRegex(tableName)} \\([\\s\\S]*?\\n\\);`),
  ) ?? ['']

  return match
}

const getMissingColumns = (tableName: string, columnNames: readonly string[]) => {
  const tableSql = getTableSql(tableName)

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

test('Phase 1 schema migration includes the common delta envelope', () => {
  expect(getMissingColumns('app.import_run_article_delta', deltaEnvelopeColumns)).toEqual([])
  expect(getMissingColumns('app.review_change_delta', deltaEnvelopeColumns)).toEqual([])
})

test('Phase 1 schema migration separates logical snapshots from component bases and patches', () => {
  expect(
    getMissingColumns('mart.review_article_serving_v4', ['snapshot_id', 'base_generation', 'patch_watermark']),
  ).toEqual([])
  expect(
    getMissingColumns('mart.review_llm_status_patch_v4', ['base_generation', 'patch_watermark', 'tombstone']),
  ).toEqual([])
  expect(getMissingColumns('app.review_serving_snapshot_manifest', ['required_components_json'])).toEqual([])
  expect(getMissingColumns('app.review_serving_snapshot_manifest', ['optional_components_json'])).toEqual([])
})

test('Phase 1 schema migration keeps raw payloads out of import hot fields', () => {
  const hotFieldSql = getTableSql('app.review_import_article_hot_field')

  expect(hotFieldSql).toContain('selected_rank_key')
  expect(hotFieldSql).toContain('publication_year')
  expect(hotFieldSql).not.toContain('payload_json')
  expect(hotFieldSql).not.toContain('source_metadata JSON')
})

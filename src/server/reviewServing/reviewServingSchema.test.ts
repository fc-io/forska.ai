import {readFileSync} from 'node:fs'
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
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_article_summary_contribution_v4',
  'mart.review_article_count_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_filter_option_serving_v4',
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
  const matches = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${escapeRegex(tableName)} \\([\\s\\S]*?\\n\\);`, 'g'),
    ),
  ]
  const lastMatch = matches.at(-1)

  return lastMatch?.[0] ?? ''
}

const getTableColumns = (tableName: string) => {
  return new Set(
    [...getTableSql(tableName).matchAll(/^ {2}([a-z_][\w]*)\s+/gm)].map((match) => {
      return match[1]
    }),
  )
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

test('Phase 1 payload serving schema preserves prompt preview article ordering', () => {
  expect(getMissingColumns('mart.review_article_serving_payload_v4', ['article_created_at', 'article_id'])).toEqual([])
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
      'judgment_payload_json',
      'placeholder_kind',
    ]),
  ).toEqual([])
  expect(
    getMissingColumns('mart.review_filter_option_serving_v4', [
      'filter_kind',
      'filter_option_identity',
      'option_payload_json',
      'option_value_key',
      'search_identity',
    ]),
  ).toEqual([])
  expect(countScopeForwardMigrationSql).toContain(
    'CREATE TABLE IF NOT EXISTS mart.review_article_judgment_detail_serving_v4',
  )
  expect(countScopeForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_article_judgment_detail_serving_v4')
  expect(countScopeForwardMigrationSql).toContain("payload_kind VARCHAR NOT NULL DEFAULT 'llm'")
  expect(countScopeForwardMigrationSql).toContain(
    'PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)',
  )
  expect(countScopeForwardMigrationSql).toContain('CREATE TABLE IF NOT EXISTS mart.review_filter_option_serving_v4')
  expect(countScopeForwardMigrationSql).toContain('option_value_key VARCHAR NOT NULL')
  expect(filterOptionValueForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_filter_option_serving_v4')
  expect(filterOptionValueForwardMigrationSql).toContain('option_value_key VARCHAR NOT NULL')
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

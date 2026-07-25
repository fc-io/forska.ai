import {existsSync, readdirSync, readFileSync, unlinkSync} from 'node:fs'
import {resolve} from 'node:path'

import {expect, mock, test} from 'bun:test'

const migrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')
type MigrateDuckdbModule = {migrateDuckdb: () => Promise<void>}

const getDuckdbMigrationFiles = () => {
  return readdirSync(migrationsFolder)
    .filter((fileName) => {
      return fileName.endsWith('.sql')
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })
}

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

test('DuckDB migrations drop the obsolete review article filter row mart without recreating it', () => {
  const migrationFiles = getDuckdbMigrationFiles()
  const legacyCreateMigrations = migrationFiles.filter((fileName) => {
    const migrationSql = readFileSync(resolve(migrationsFolder, fileName), 'utf8')

    return migrationSql.includes('CREATE TABLE IF NOT EXISTS mart.review_article_filter_row')
  })
  const dropMigrationSql = readFileSync(
    resolve(migrationsFolder, '0051_dropReviewArticleFilterRowMart.sql'),
    'utf8',
  ).trim()

  expect(migrationFiles).not.toContain('0005_reviewArticleFilterRowMart.sql')
  expect(legacyCreateMigrations).toEqual([])
  expect(dropMigrationSql).toBe('DROP TABLE IF EXISTS mart.review_article_filter_row;')
})

test('DuckDB migrations rebuild review rebuild request indexes instead of updating corrupt rows', () => {
  const migrationSql = readFileSync(resolve(migrationsFolder, '0111_rebuildReviewRebuildRequestIndex.sql'), 'utf8')

  expect(migrationSql).toContain('CREATE TABLE app.review_rebuild_request_index_repair')
  expect(migrationSql).toContain('INSERT INTO app.review_rebuild_request_index_repair')
  expect(migrationSql).toContain('SELECT * FROM app.review_rebuild_request')
  expect(migrationSql).toContain('DROP TABLE app.review_rebuild_request')
  expect(migrationSql).toContain('ALTER TABLE app.review_rebuild_request_index_repair RENAME TO review_rebuild_request')
  expect(migrationSql).toContain('CREATE INDEX idx_review_rebuild_request_status')
  expect(migrationSql).not.toContain('UPDATE app.review_rebuild_request')
})

test('DuckDB migrations drop the posting stats index that duplicates the repaired unique key', () => {
  const migrationSql = readFileSync(
    resolve(migrationsFolder, '0114_dropReviewFilterPostingStatsLookupIndex.sql'),
    'utf8',
  ).trim()

  expect(migrationSql).toContain('DROP INDEX IF EXISTS mart.idx_review_filter_posting_stats_v4_lookup;')
  expect(migrationSql).toContain('DROP INDEX IF EXISTS idx_review_filter_posting_stats_v4_lookup;')
})

test('DuckDB migrations keep projector watermark unindexed after primary-key repair', () => {
  const foundationSql = readFileSync(resolve(migrationsFolder, '0097_reviewServingV4Foundation.sql'), 'utf8')
  const repairSql = readFileSync(
    resolve(migrationsFolder, '0115_rebuildReviewServingProjectorWatermarkWithoutPrimaryKey.sql'),
    'utf8',
  )
  const dropSql = readFileSync(
    resolve(migrationsFolder, '0116_dropReviewServingProjectorWatermarkLookupIndex.sql'),
    'utf8',
  ).trim()

  expect(foundationSql).not.toContain('idx_review_serving_projector_watermark_lookup')
  expect(repairSql).not.toContain('idx_review_serving_projector_watermark_lookup')
  expect(dropSql).toContain('DROP INDEX IF EXISTS app.idx_review_serving_projector_watermark_lookup;')
  expect(dropSql).toContain('DROP INDEX IF EXISTS idx_review_serving_projector_watermark_lookup;')
})

test('DuckDB migrations retire bounded review-serving storage with forward drops', () => {
  const reviewQueuePatchDropSql = readFileSync(
    resolve(migrationsFolder, '0118_dropReviewQueuePatchV4.sql'),
    'utf8',
  ).trim()
  const reviewHumanStatusPatchDropSql = readFileSync(
    resolve(migrationsFolder, '0119_dropReviewHumanStatusPatchV4.sql'),
    'utf8',
  ).trim()
  const reviewLlmStatusPatchDropSql = readFileSync(
    resolve(migrationsFolder, '0120_dropReviewLlmStatusPatchV4.sql'),
    'utf8',
  ).trim()
  const reviewArticleFilterPostingPatchDropSql = readFileSync(
    resolve(migrationsFolder, '0121_dropReviewArticleFilterPostingPatchV4.sql'),
    'utf8',
  ).trim()
  const reviewArticleDisplayPatchDropSql = readFileSync(
    resolve(migrationsFolder, '0122_dropReviewArticleDisplayPatchV4.sql'),
    'utf8',
  ).trim()
  const reviewTitleSearchActivitySortAtDropSql = readFileSync(
    resolve(migrationsFolder, '0123_dropReviewTitleSearchActivitySortAt.sql'),
    'utf8',
  ).trim()
  const reviewTitleSearchUnusedColumnDropSql = readFileSync(
    resolve(migrationsFolder, '0127_dropReviewTitleSearchUnusedColumns.sql'),
    'utf8',
  ).trim()
  const reviewFilterPostingStatsDerivedColumnDropSql = readFileSync(
    resolve(migrationsFolder, '0129_dropReviewFilterPostingStatsDerivedColumns.sql'),
    'utf8',
  ).trim()
  const reviewFilterOptionPayloadJsonDropSql = readFileSync(
    resolve(migrationsFolder, '0130_dropReviewFilterOptionPayloadJson.sql'),
    'utf8',
  ).trim()
  const reviewArticleServingSelectedRankCopyDropSql = readFileSync(
    resolve(migrationsFolder, '0131_dropReviewArticleServingSelectedRankCopy.sql'),
    'utf8',
  ).trim()
  const reviewPayloadBytesDropSql = readFileSync(
    resolve(migrationsFolder, '0132_dropReviewPayloadBytes.sql'),
    'utf8',
  ).trim()
  const reviewFilterPostingServingIdentityDropSql = readFileSync(
    resolve(migrationsFolder, '0133_dropReviewFilterPostingServingIdentity.sql'),
    'utf8',
  ).trim()
  const reviewFilterPostingServingUpdatedAtDropSql = readFileSync(
    resolve(migrationsFolder, '0140_dropReviewFilterPostingServingUpdatedAt.sql'),
    'utf8',
  ).trim()
  const reviewSummaryContributionServingDropSql = readFileSync(
    resolve(migrationsFolder, '0141_dropReviewSummaryContributionServing.sql'),
    'utf8',
  ).trim()
  const reviewSelectedImportBaseFlagDropSql = readFileSync(
    resolve(migrationsFolder, '0143_dropReviewSelectedImportBaseFlags.sql'),
    'utf8',
  ).trim()
  const reviewArticleServingReviewProgressCopyDropSql = readFileSync(
    resolve(migrationsFolder, '0134_dropReviewArticleServingReviewProgressCopy.sql'),
    'utf8',
  ).trim()
  const reviewJudgmentDetailModelIdDropSql = readFileSync(
    resolve(migrationsFolder, '0138_dropReviewJudgmentDetailModelId.sql'),
    'utf8',
  ).trim()
  const reviewSelectedImportDisplayCopyColumnDropSql = readFileSync(
    resolve(migrationsFolder, '0124_dropReviewSelectedImportDisplayCopyColumns.sql'),
    'utf8',
  ).trim()
  const reviewSelectedImportPatchDropSql = readFileSync(
    resolve(migrationsFolder, '0126_dropReviewSelectedImportPatchV4.sql'),
    'utf8',
  ).trim()

  expect(reviewQueuePatchDropSql).toBe('DROP TABLE IF EXISTS mart.review_queue_patch_v4;')
  expect(reviewHumanStatusPatchDropSql).toBe('DROP TABLE IF EXISTS mart.review_human_status_patch_v4;')
  expect(reviewLlmStatusPatchDropSql).toBe('DROP TABLE IF EXISTS mart.review_llm_status_patch_v4;')
  expect(reviewArticleFilterPostingPatchDropSql).toBe(
    'DROP TABLE IF EXISTS mart.review_article_filter_posting_patch_v4;',
  )
  expect(reviewArticleDisplayPatchDropSql).toBe('DROP TABLE IF EXISTS mart.review_article_display_patch_v4;')
  expect(reviewTitleSearchActivitySortAtDropSql).toContain('Retired by 0127')
  expect(reviewTitleSearchUnusedColumnDropSql).toContain('CREATE TABLE mart.review_title_search_serving_v4_repair')
  expect(reviewTitleSearchUnusedColumnDropSql).toContain('DROP TABLE mart.review_title_search_serving_v4;')
  expect(reviewTitleSearchUnusedColumnDropSql).toContain(
    'ALTER TABLE mart.review_title_search_serving_v4_repair RENAME TO review_title_search_serving_v4;',
  )
  expect(reviewTitleSearchUnusedColumnDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_title_search_serving_v4_repaired_pk',
  )
  expect(reviewTitleSearchUnusedColumnDropSql).not.toContain('PRIMARY KEY')
  expect(reviewTitleSearchUnusedColumnDropSql).not.toContain('activity_sort_at')
  expect(reviewTitleSearchUnusedColumnDropSql).not.toContain('title_prefix')
  expect(reviewTitleSearchUnusedColumnDropSql).not.toContain('search_updated_at')
  expect(reviewTitleSearchUnusedColumnDropSql).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_title_search_serving_v4_token',
  )
  expect(reviewFilterPostingStatsDerivedColumnDropSql).toContain(
    'CREATE TABLE mart.review_filter_posting_stats_v4_repair',
  )
  expect(reviewFilterPostingStatsDerivedColumnDropSql).toContain('DROP TABLE mart.review_filter_posting_stats_v4;')
  expect(reviewFilterPostingStatsDerivedColumnDropSql).toContain(
    'ALTER TABLE mart.review_filter_posting_stats_v4_repair RENAME TO review_filter_posting_stats_v4;',
  )
  expect(reviewFilterPostingStatsDerivedColumnDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filter_posting_stats_v4_repaired_pk',
  )
  expect(reviewFilterPostingStatsDerivedColumnDropSql).not.toContain('PRIMARY KEY')
  expect(reviewFilterPostingStatsDerivedColumnDropSql).not.toContain('selectivity')
  expect(reviewFilterPostingStatsDerivedColumnDropSql).not.toContain('posting_identity')
  expect(reviewFilterOptionPayloadJsonDropSql).toContain('CREATE TABLE mart.review_filter_option_serving_v4_repair')
  expect(reviewFilterOptionPayloadJsonDropSql).toContain('DROP TABLE mart.review_filter_option_serving_v4;')
  expect(reviewFilterOptionPayloadJsonDropSql).toContain(
    'ALTER TABLE mart.review_filter_option_serving_v4_repair RENAME TO review_filter_option_serving_v4;',
  )
  expect(reviewFilterOptionPayloadJsonDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_repaired_pk',
  )
  expect(reviewFilterOptionPayloadJsonDropSql).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_filter_option_serving_v4_lookup',
  )
  expect(reviewFilterOptionPayloadJsonDropSql).not.toContain('PRIMARY KEY')
  expect(reviewFilterOptionPayloadJsonDropSql).not.toContain('option_payload_json')
  expect(reviewArticleServingSelectedRankCopyDropSql).toContain('CREATE TABLE mart.review_article_serving_v4_repair')
  expect(reviewArticleServingSelectedRankCopyDropSql).toContain('DROP TABLE mart.review_article_serving_v4;')
  expect(reviewArticleServingSelectedRankCopyDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingSelectedRankCopyDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_v4_repaired_pk',
  )
  expect(reviewArticleServingSelectedRankCopyDropSql).not.toContain('PRIMARY KEY')
  expect(reviewArticleServingSelectedRankCopyDropSql).not.toContain('selected_rank_key')
  expect(reviewPayloadBytesDropSql).toContain('CREATE TABLE mart.review_article_serving_payload_v4_repair')
  expect(reviewPayloadBytesDropSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadBytesDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadBytesDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk',
  )
  expect(reviewPayloadBytesDropSql).not.toContain('PRIMARY KEY')
  expect(reviewPayloadBytesDropSql).not.toContain('payload_bytes')
  expect(reviewFilterPostingServingIdentityDropSql).toContain(
    'CREATE TABLE mart.review_article_filter_posting_serving_v4_repair',
  )
  expect(reviewFilterPostingServingIdentityDropSql).toContain(
    'DROP TABLE mart.review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingIdentityDropSql).toContain(
    'ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingIdentityDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_repaired_pk',
  )
  expect(reviewFilterPostingServingIdentityDropSql).not.toContain('PRIMARY KEY')
  expect(reviewFilterPostingServingIdentityDropSql).not.toContain('posting_identity')
  expect(reviewFilterPostingServingUpdatedAtDropSql).toContain(
    'CREATE TABLE mart.review_article_filter_posting_serving_v4_repair',
  )
  expect(reviewFilterPostingServingUpdatedAtDropSql).toContain(
    'DROP TABLE mart.review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingUpdatedAtDropSql).toContain(
    'ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingUpdatedAtDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_repaired_pk',
  )
  expect(reviewFilterPostingServingUpdatedAtDropSql).not.toContain('PRIMARY KEY')
  expect(reviewFilterPostingServingUpdatedAtDropSql).not.toContain('posting_updated_at')
  expect(reviewArticleServingReviewProgressCopyDropSql).toContain('CREATE TABLE mart.review_article_serving_v4_repair')
  expect(reviewArticleServingReviewProgressCopyDropSql).toContain('DROP TABLE mart.review_article_serving_v4;')
  expect(reviewArticleServingReviewProgressCopyDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingReviewProgressCopyDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_v4_repaired_pk',
  )
  expect(reviewArticleServingReviewProgressCopyDropSql).not.toContain('PRIMARY KEY')
  expect(reviewArticleServingReviewProgressCopyDropSql).not.toContain('review_opened')
  expect(reviewArticleServingReviewProgressCopyDropSql).not.toContain('review_sections_completed')
  expect(reviewJudgmentDetailModelIdDropSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair',
  )
  expect(reviewJudgmentDetailModelIdDropSql).toContain(
    'ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;',
  )
  expect(reviewJudgmentDetailModelIdDropSql).not.toContain('PRIMARY KEY')
  expect(reviewJudgmentDetailModelIdDropSql).not.toContain('model_id VARCHAR')
  expect(reviewJudgmentDetailModelIdDropSql).not.toContain('model_id,')
  expect(reviewSelectedImportDisplayCopyColumnDropSql).toContain(
    'CREATE TABLE app.review_selected_article_import_v4_repair',
  )
  expect(reviewSelectedImportDisplayCopyColumnDropSql).toContain(
    'INSERT INTO app.review_selected_article_import_v4_repair',
  )
  expect(reviewSelectedImportDisplayCopyColumnDropSql).toContain('DROP TABLE app.review_selected_article_import_v4;')
  expect(reviewSelectedImportDisplayCopyColumnDropSql).toContain(
    'ALTER TABLE app.review_selected_article_import_v4_repair RENAME TO review_selected_article_import_v4;',
  )
  expect(reviewSelectedImportDisplayCopyColumnDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_selected_article_import_v4_repaired_pk',
  )
  expect(reviewSelectedImportDisplayCopyColumnDropSql).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_selected_article_import_v4_order',
  )
  expect(reviewSelectedImportDisplayCopyColumnDropSql).not.toContain('PRIMARY KEY')
  expect(reviewSelectedImportDisplayCopyColumnDropSql).not.toContain('publication_year')
  expect(reviewSelectedImportDisplayCopyColumnDropSql).not.toContain('article_title')
  expect(reviewSelectedImportDisplayCopyColumnDropSql).not.toContain('journal_title')
  expect(reviewSelectedImportDisplayCopyColumnDropSql).not.toContain('external_id')
  expect(reviewSelectedImportDisplayCopyColumnDropSql).not.toContain('duplicate_flag')
  expect(reviewSelectedImportDisplayCopyColumnDropSql).not.toContain('conflict_flag')
  expect(reviewSelectedImportPatchDropSql).toBe('DROP TABLE IF EXISTS mart.review_selected_import_patch_v4;')
  expect(reviewSummaryContributionServingDropSql).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_article_summary_contribution_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_article_summary_contribution_v4_lookup;',
      'DROP TABLE IF EXISTS mart.review_article_summary_contribution_v4;',
    ].join('\n'),
  )
  expect(reviewSelectedImportBaseFlagDropSql).toContain(
    'CREATE TABLE app.review_selected_article_import_v4_flag_repair',
  )
  expect(reviewSelectedImportBaseFlagDropSql).toContain('DROP TABLE app.review_selected_article_import_v4;')
  expect(reviewSelectedImportBaseFlagDropSql).toContain(
    'ALTER TABLE app.review_selected_article_import_v4_flag_repair RENAME TO review_selected_article_import_v4;',
  )
  expect(reviewSelectedImportBaseFlagDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_selected_article_import_v4_repaired_pk',
  )
  expect(reviewSelectedImportBaseFlagDropSql).not.toContain('PRIMARY KEY')
  expect(reviewSelectedImportBaseFlagDropSql).not.toContain('duplicate_flag')
  expect(reviewSelectedImportBaseFlagDropSql).not.toContain('conflict_flag')
})

test('DuckDB migration drops selected-import base flags while preserving selected rows', async () => {
  const duckdbPath = `/tmp/forska-selected-import-base-flag-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0143_dropReviewSelectedImportBaseFlags.sql'
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        await database.run('CREATE SCHEMA IF NOT EXISTS app')
        await database.run(
          "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        await database.run(
          "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
            .map((fileName) => {
              return `('${fileName.replaceAll("'", "''")}')`
            })
            .join(', ')}"
        )
        await database.run(\`
          CREATE TABLE app.review_selected_article_import_v4 (
            project_id VARCHAR NOT NULL,
            project_scope_identity VARCHAR NOT NULL,
            selected_import_snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            import_route_id VARCHAR,
            source_record_key VARCHAR,
            selected_rank_key VARCHAR,
            selected_rank_numeric DOUBLE,
            duplicate_flag BOOLEAN,
            conflict_flag BOOLEAN,
            tombstone BOOLEAN NOT NULL DEFAULT FALSE,
            selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_selected_article_import_v4 (
            project_id,
            project_scope_identity,
            selected_import_snapshot_id,
            article_id,
            import_route_id,
            source_record_key,
            selected_rank_key,
            selected_rank_numeric,
            duplicate_flag,
            conflict_flag,
            tombstone,
            selected_import_updated_at
          ) VALUES
            ('project-1', 'scope-1', 'snapshot-1', 'article-false', 'route-1', 'source-false', 'rank-1', 1.5, FALSE, FALSE, FALSE, current_timestamp),
            ('project-1', 'scope-1', 'snapshot-1', 'article-true', 'route-1', 'source-true', 'rank-2', 2.5, TRUE, TRUE, TRUE, current_timestamp)
        \`)

        await migrateDuckdb()

        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'app'
            AND table_name = 'review_selected_article_import_v4'
          ORDER BY ordinal_position
        \`)
        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            import_route_id AS importRouteId,
            source_record_key AS sourceRecordKey,
            selected_rank_key AS selectedRankKey,
            selected_rank_numeric AS selectedRankNumeric,
            tombstone
          FROM app.review_selected_article_import_v4
          ORDER BY article_id
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0143_dropReviewSelectedImportBaseFlags.sql'"
        )

        console.log(JSON.stringify({columns, migrationRows, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39995',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39996',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB migration')
    }
    const output = result.stdout.toString().trim()
    expect(output).not.toBe('')
    const jsonLine = output.split('\n').find((line) => {
      return line.startsWith('{"columns"')
    })
    expect(jsonLine).toBeDefined()
    expect(JSON.parse(jsonLine ?? '')).toEqual({
      columns: [
        {columnName: 'project_id'},
        {columnName: 'project_scope_identity'},
        {columnName: 'selected_import_snapshot_id'},
        {columnName: 'article_id'},
        {columnName: 'import_route_id'},
        {columnName: 'source_record_key'},
        {columnName: 'selected_rank_key'},
        {columnName: 'selected_rank_numeric'},
        {columnName: 'tombstone'},
        {columnName: 'selected_import_updated_at'},
      ],
      migrationRows: [{name: '0143_dropReviewSelectedImportBaseFlags.sql'}],
      rows: [
        {
          articleId: 'article-false',
          importRouteId: 'route-1',
          selectedRankKey: 'rank-1',
          selectedRankNumeric: 1.5,
          sourceRecordKey: 'source-false',
          tombstone: false,
        },
        {
          articleId: 'article-true',
          importRouteId: 'route-1',
          selectedRankKey: 'rank-2',
          selectedRankNumeric: 2.5,
          sourceRecordKey: 'source-true',
          tombstone: true,
        },
      ],
    })
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops retired summary contribution serving table and lookup index', async () => {
  const duckdbPath = `/tmp/forska-review-summary-contribution-serving-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0141_dropReviewSummaryContributionServing.sql'
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        await database.run('CREATE SCHEMA IF NOT EXISTS app')
        await database.run('CREATE SCHEMA IF NOT EXISTS mart')
        await database.run(
          "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        await database.run(
          "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
            .map((fileName) => {
              return `('${fileName.replaceAll("'", "''")}')`
            })
            .join(', ')}"
        )
        await database.run(\`
          CREATE TABLE mart.review_article_summary_contribution_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            component_kind VARCHAR NOT NULL,
            summary_definition_version VARCHAR NOT NULL,
            contribution_key VARCHAR NOT NULL,
            contribution_value BIGINT NOT NULL,
            contribution_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE INDEX idx_review_article_summary_contribution_v4_lookup
          ON mart.review_article_summary_contribution_v4(
            project_id,
            review_config_hash,
            snapshot_id,
            component_kind,
            summary_definition_version,
            contribution_key
          )
        \`)

        await migrateDuckdb()

        const tableRows = await database.queryJson(
          "SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = 'mart' AND table_name = 'review_article_summary_contribution_v4'"
        )
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE index_name = 'idx_review_article_summary_contribution_v4_lookup'"
        )
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0141_dropReviewSummaryContributionServing.sql'"
        )

        console.log(JSON.stringify({indexRows, migrationRows, tableRows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39995',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39996',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB migration')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      indexRows: {indexName: string}[]
      migrationRows: {name: string}[]
      tableRows: {tableName: string}[]
    }

    expect(parsed.tableRows).toEqual([])
    expect(parsed.indexRows).toEqual([])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('DuckDB migration drops selected-import display-copy columns while preserving retained rows and upserts', async () => {
  const duckdbPath = `/tmp/forska-selected-import-display-copy-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0124_dropReviewSelectedImportDisplayCopyColumns.sql'
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        await database.run('CREATE SCHEMA IF NOT EXISTS app')
        await database.run(
          "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        await database.run(
          "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
            .map((fileName) => {
              return `('${fileName.replaceAll("'", "''")}')`
            })
            .join(', ')}"
        )
        await database.run(\`
          CREATE TABLE app.review_selected_article_import_v4 (
            project_id VARCHAR NOT NULL,
            project_scope_identity VARCHAR NOT NULL,
            selected_import_snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            import_route_id VARCHAR,
            source_record_key VARCHAR,
            selected_rank_key VARCHAR,
            selected_rank_numeric DOUBLE,
            publication_year INTEGER,
            article_title VARCHAR,
            journal_title VARCHAR,
            external_id VARCHAR,
            duplicate_flag BOOLEAN,
            conflict_flag BOOLEAN,
            tombstone BOOLEAN NOT NULL DEFAULT FALSE,
            selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            PRIMARY KEY(project_id, project_scope_identity, selected_import_snapshot_id, article_id)
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_selected_article_import_v4 (
            project_id,
            project_scope_identity,
            selected_import_snapshot_id,
            article_id,
            import_route_id,
            source_record_key,
            selected_rank_key,
            selected_rank_numeric,
            publication_year,
            article_title,
            journal_title,
            external_id,
            duplicate_flag,
            conflict_flag,
            tombstone,
            selected_import_updated_at
          )
          VALUES (
            'project-a',
            'scope-a',
            'snapshot-a',
            'article-a',
            'route-a',
            'source-a',
            'rank-a',
            42.5,
            2026,
            'Retired title copy',
            'Retired journal copy',
            'retired-external-id',
            TRUE,
            FALSE,
            FALSE,
            TIMESTAMPTZ '2026-07-24T08:00:00Z'
          )
        \`)

        await migrateDuckdb()

        await database.run(\`
          INSERT INTO app.review_selected_article_import_v4 (
            project_id,
            project_scope_identity,
            selected_import_snapshot_id,
            article_id,
            import_route_id,
            source_record_key,
            selected_rank_key,
            selected_rank_numeric,
            tombstone,
            selected_import_updated_at
          )
          VALUES (
            'project-a',
            'scope-a',
            'snapshot-a',
            'article-a',
            'route-b',
            'source-b',
            'rank-b',
            99.5,
            TRUE,
            TIMESTAMPTZ '2026-07-24T08:05:00Z'
          )
          ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, article_id) DO UPDATE SET
            import_route_id = excluded.import_route_id,
            source_record_key = excluded.source_record_key,
            selected_rank_key = excluded.selected_rank_key,
            selected_rank_numeric = excluded.selected_rank_numeric,
            tombstone = excluded.tombstone,
            selected_import_updated_at = excluded.selected_import_updated_at
        \`)

        const columnRows = await database.queryJson(
          "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'review_selected_article_import_v4' ORDER BY ordinal_position"
        )
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE schema_name = 'app' AND table_name = 'review_selected_article_import_v4' ORDER BY index_name"
        )
        const rows = await database.queryJson(\`
          SELECT
            import_route_id AS importRouteId,
            source_record_key AS sourceRecordKey,
            selected_rank_key AS selectedRankKey,
            selected_rank_numeric AS selectedRankNumeric,
            tombstone,
            selected_import_updated_at AS selectedImportUpdatedAt
          FROM app.review_selected_article_import_v4
          ORDER BY article_id
        \`)

        console.log(JSON.stringify({columnRows, indexRows, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39995',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39996',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB migration')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columnRows: {columnName: string}[]
      indexRows: {indexName: string}[]
      rows: {
        importRouteId: string
        selectedImportUpdatedAt: string
        selectedRankKey: string
        selectedRankNumeric: number
        sourceRecordKey: string
        tombstone: boolean
      }[]
    }
    const columns = parsed.columnRows.map((row) => {
      return row.columnName
    })
    const indexNames = parsed.indexRows.map((row) => {
      return row.indexName
    })

    expect(columns).toEqual([
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
    expect(columns).not.toContain('publication_year')
    expect(columns).not.toContain('article_title')
    expect(columns).not.toContain('journal_title')
    expect(columns).not.toContain('external_id')
    expect(indexNames).toContain('idx_review_selected_article_import_v4_repaired_pk')
    expect(indexNames).toContain('idx_review_selected_article_import_v4_order')
    expect(parsed.rows).toEqual([
      {
        importRouteId: 'route-b',
        selectedImportUpdatedAt: expect.stringContaining('2026-07-24') as string,
        selectedRankKey: 'rank-b',
        selectedRankNumeric: 99.5,
        sourceRecordKey: 'source-b',
        tombstone: true,
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('DuckDB migrations repair legacy review serving judgment detail payload-kind schema drift and prompt scalar shape', async () => {
  const duckdbPath = `/tmp/forska-review-serving-judgment-detail-payload-kind-${Date.now()}.duckdb`
  const targetMigrationFiles = new Set([
    '0109_reviewServingJudgmentDetailPayloadKindForwardMigration.sql',
    '0135_reviewServingJudgmentDetailPromptScalars.sql',
    '0137_reviewServingJudgmentDetailHumanScalars.sql',
    '0138_dropReviewJudgmentDetailModelId.sql',
  ])
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return !targetMigrationFiles.has(fileName)
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        await database.run('CREATE SCHEMA IF NOT EXISTS app')
        await database.run('CREATE SCHEMA IF NOT EXISTS mart')
        await database.run("CREATE TYPE project_prompt_criteria_disposition_v2 AS ENUM ('include', 'exclude', 'combined')")
        await database.run(
          "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        await database.run(\`
          CREATE TABLE app.review_rebuild_request (
            request_id VARCHAR PRIMARY KEY,
            project_id VARCHAR NOT NULL,
            status VARCHAR NOT NULL,
            admission_state VARCHAR NOT NULL DEFAULT 'pending',
            retry_after TIMESTAMPTZ,
            failed_at TIMESTAMPTZ,
            last_error VARCHAR,
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE TABLE app.review_rebuild_chunk_manifest (
            chunk_id VARCHAR PRIMARY KEY,
            request_id VARCHAR,
            projection_component VARCHAR NOT NULL,
            status VARCHAR NOT NULL,
            admission_state VARCHAR NOT NULL DEFAULT 'admitted',
            retry_count INTEGER DEFAULT 0,
            retry_after TIMESTAMPTZ,
            oom_category VARCHAR,
            over_budget_reason VARCHAR,
            lease_owner VARCHAR,
            lease_expires_at TIMESTAMPTZ,
            last_error VARCHAR,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(
          "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
            .map((fileName) => {
              return `('${fileName.replaceAll("'", "''")}')`
            })
            .join(', ')}"
        )
        await database.run(\`
          CREATE TABLE mart.review_article_judgment_detail_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR NOT NULL,
            prompt_order INTEGER,
            judgment_id VARCHAR,
            model_id VARCHAR,
            answered_original VARCHAR,
            answered_original_as_array VARCHAR[],
            judgment_payload_json JSON,
            placeholder_kind VARCHAR,
            detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, article_id, prompt_id)
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_judgment_detail_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            list_mode_key,
            article_id,
            prompt_id,
            prompt_order,
            judgment_id,
            model_id,
            answered_original,
            answered_original_as_array,
            judgment_payload_json,
            placeholder_kind
          )
          VALUES
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'global',
              'article-a',
              'prompt-a',
              1,
              'judgment-a',
              'model-a',
              'include',
              ['include'],
              '{"answer":"include","prompt":{"criteriaDisposition":"include","originalText":"Prompt A text","promptHeading":"Prompt A","type":"yes_no"}}',
              NULL
            ),
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'global',
              'article-b',
              'prompt-b',
              2,
              NULL,
              NULL,
              NULL,
              NULL,
              '{"isAnswered":false,"prompt":{"criteriaDisposition":"exclude","originalText":"Prompt B text","promptHeading":"Prompt B","type":"yes_no"}}',
              'llm.unanswered'
            )
        \`)
        await database.run(\`
          INSERT INTO app.review_rebuild_request (request_id, project_id, status, admission_state, retry_after, failed_at, last_error, created_at)
          VALUES (
            'request-a',
            'project-a',
            'blocked_over_budget',
            'blocked_over_budget',
            TIMESTAMPTZ '2026-06-27T12:10:00Z',
            TIMESTAMPTZ '2026-06-27T12:00:00Z',
            'Binder Error: Referenced column "payload_kind" not found in FROM clause',
            TIMESTAMPTZ '2026-06-27T11:55:00Z'
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_rebuild_chunk_manifest (
            chunk_id,
            request_id,
            projection_component,
            status,
            admission_state,
            retry_count,
            retry_after,
            oom_category,
            over_budget_reason,
            lease_owner,
            lease_expires_at,
            last_error
          )
          VALUES (
            'chunk-a',
            'request-a',
            'judgmentInputContent',
            'blocked_over_budget',
            'blocked_over_budget',
            3,
            TIMESTAMPTZ '2026-06-27T12:10:00Z',
            'binder',
            'schema drift',
            'worker-a',
            TIMESTAMPTZ '2026-06-27T12:05:00Z',
            'Binder Error: Referenced column "payload_kind" not found in FROM clause'
          )
        \`)

        await migrateDuckdb()

        const chunkRows = await database.queryJson(
          "SELECT admission_state AS admissionState, last_error AS lastError, retry_after AS retryAfter, retry_count AS retryCount, status FROM app.review_rebuild_chunk_manifest ORDER BY chunk_id"
        )
        const rows = await database.queryJson(
          "SELECT project_id AS projectId, payload_kind AS payloadKind, judgment_id AS judgmentId, judgment_created_at AS judgmentCreatedAt, human_comment AS humanComment, prompt_original_text AS promptOriginalText, prompt_heading AS promptHeading, CAST(prompt_criteria_disposition AS VARCHAR) AS promptCriteriaDisposition, judgment_payload_json AS judgmentPayloadJson, placeholder_kind AS placeholderKind FROM mart.review_article_judgment_detail_serving_v4 ORDER BY article_id"
        )
        const requestRows = await database.queryJson(
          "SELECT admission_state AS admissionState, failed_at AS failedAt, last_error AS lastError, retry_after AS retryAfter, status FROM app.review_rebuild_request ORDER BY request_id"
        )
        const uniqueIndexRows = await database.queryJson(
          "SELECT index_name AS indexName, sql FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_article_judgment_detail_serving_v4' ORDER BY index_name"
        )
        const duplicatePayloadKindAccepted = await database
          .run(\`
            INSERT INTO mart.review_article_judgment_detail_serving_v4 (
              project_id,
              review_config_hash,
              snapshot_id,
              list_mode_key,
              payload_kind,
              article_id,
              prompt_id,
              prompt_order,
              judgment_id
            )
            VALUES ('project-a', 'config-a', 'snapshot-a', 'global', 'human', 'article-a', 'prompt-a', 1, 'human-a')
          \`)
          .then(
            () => true,
            () => false,
          )

        const columns = await database.queryJson(
          "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_article_judgment_detail_serving_v4' ORDER BY ordinal_position"
        )
        console.log(JSON.stringify({chunkRows, columns, duplicatePayloadKindAccepted, requestRows, rows, uniqueIndexRows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39993',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39994',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB migration')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      duplicatePayloadKindAccepted: boolean
      columns: Array<{columnName: string}>
      chunkRows: Array<{
        admissionState: string
        lastError: string | null
        retryAfter: string | null
        retryCount: number
        status: string
      }>
      requestRows: Array<{
        admissionState: string
        failedAt: string | null
        lastError: string | null
        retryAfter: string | null
        status: string
      }>
      rows: Array<{
        judgmentId: string | null
        judgmentPayloadJson: unknown
        humanComment: string | null
        judgmentCreatedAt: string | null
        payloadKind: string
        placeholderKind: string | null
        projectId: string
        promptCriteriaDisposition: string | null
        promptHeading: string | null
        promptOriginalText: string | null
      }>
      uniqueIndexRows: Array<{indexName: string; sql: string}>
    }

    expect(parsed.chunkRows).toEqual([
      {admissionState: 'admitted', lastError: null, retryAfter: null, retryCount: 0, status: 'pending'},
    ])
    expect(parsed.requestRows).toEqual([
      {admissionState: 'admitted', failedAt: null, lastError: null, retryAfter: null, status: 'admitted'},
    ])
    expect(
      parsed.columns.map((row) => {
        return row.columnName
      }),
    ).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'list_mode_key',
      'payload_kind',
      'article_id',
      'prompt_id',
      'prompt_order',
      'judgment_id',
      'is_answered',
      'answered_original',
      'answered_original_as_array',
      'prompt_original_text',
      'prompt_heading',
      'prompt_type',
      'prompt_criteria_disposition',
      'judgment_created_at',
      'human_comment',
      'judgment_payload_json',
      'placeholder_kind',
      'detail_updated_at',
    ])
    expect(parsed.rows).toEqual([
      {
        judgmentId: 'judgment-a',
        judgmentCreatedAt: null,
        judgmentPayloadJson: expect.anything() as unknown,
        humanComment: null,
        payloadKind: 'llm',
        placeholderKind: null,
        projectId: 'project-a',
        promptCriteriaDisposition: 'include',
        promptHeading: 'Prompt A',
        promptOriginalText: 'Prompt A text',
      },
      {
        judgmentId: null,
        judgmentCreatedAt: null,
        judgmentPayloadJson: null,
        humanComment: null,
        payloadKind: 'llm',
        placeholderKind: 'llm.unanswered',
        projectId: 'project-a',
        promptCriteriaDisposition: 'exclude',
        promptHeading: 'Prompt B',
        promptOriginalText: 'Prompt B text',
      },
    ])
    expect(parsed.uniqueIndexRows).toEqual([
      {
        indexName: 'idx_review_article_judgment_detail_serving_v4_article',
        sql: expect.stringContaining(
          'ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order)',
        ) as string,
      },
      {
        indexName: 'idx_review_article_judgment_detail_serving_v4_repaired_pk',
        sql: expect.stringContaining(
          'ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)',
        ) as string,
      },
    ])
    expect(parsed.duplicatePayloadKindAccepted).toBe(true)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migrations drop summary partial serving key and collapse scalar-key duplicates', async () => {
  const duckdbPath = `/tmp/forska-review-summary-partial-serving-key-${Date.now()}.duckdb`
  const targetMigrationFiles = new Set(['0136_dropReviewSummaryPartialServingKey.sql'])
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return !targetMigrationFiles.has(fileName)
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        await database.run('CREATE SCHEMA IF NOT EXISTS app')
        await database.run('CREATE SCHEMA IF NOT EXISTS mart')
        await database.run(
          "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        await database.run(
          "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
            .map((fileName) => {
              return `('${fileName.replaceAll("'", "''")}')`
            })
            .join(', ')}"
        )
        await database.run(\`
          CREATE TABLE mart.review_article_summary_rebuild_partial_v4 (
            request_id VARCHAR NOT NULL,
            chunk_id VARCHAR NOT NULL,
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            summary_kind VARCHAR NOT NULL,
            summary_identity VARCHAR NOT NULL,
            list_mode_key VARCHAR,
            count_kind VARCHAR,
            serving_key VARCHAR NOT NULL,
            summary_definition_version VARCHAR NOT NULL,
            filter_key VARCHAR,
            facet_kind VARCHAR,
            facet_key VARCHAR,
            facet_value VARCHAR,
            prompt_id VARCHAR,
            answer_id INTEGER,
            answer_value VARCHAR,
            availability VARCHAR NOT NULL DEFAULT 'ready',
            stale_reason VARCHAR,
            count_value BIGINT,
            partial_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            PRIMARY KEY(request_id, chunk_id, serving_key)
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_summary_rebuild_partial_v4 (
            request_id,
            chunk_id,
            project_id,
            review_config_hash,
            snapshot_id,
            summary_kind,
            summary_identity,
            list_mode_key,
            count_kind,
            serving_key,
            summary_definition_version,
            filter_key,
            facet_kind,
            facet_key,
            facet_value,
            prompt_id,
            answer_id,
            answer_value,
            availability,
            stale_reason,
            count_value,
            partial_updated_at
          )
          VALUES
            (
              'request-a',
              'chunk-a',
              'project-a',
              'config-a',
              'snapshot-a',
              'prompt',
              'summary-a',
              NULL,
              'articles',
              'legacy-key-a',
              'v1',
              NULL,
              NULL,
              NULL,
              NULL,
              'prompt-a',
              NULL,
              'include',
              'ready',
              NULL,
              2,
              TIMESTAMPTZ '2026-07-25T07:00:00Z'
            ),
            (
              'request-a',
              'chunk-a',
              'project-a',
              'config-a',
              'snapshot-a',
              'prompt',
              'summary-a',
              NULL,
              'articles',
              'legacy-key-b',
              'v1',
              NULL,
              NULL,
              NULL,
              NULL,
              'prompt-a',
              NULL,
              'include',
              'ready',
              NULL,
              3,
              TIMESTAMPTZ '2026-07-25T07:01:00Z'
            ),
            (
              'request-a',
              'chunk-b',
              'project-a',
              'config-a',
              'snapshot-a',
              'prompt',
              'summary-b',
              'global',
              'articles',
              'legacy-key-c',
              'v1',
              'filter-a',
              NULL,
              NULL,
              NULL,
              'prompt-a',
              NULL,
              'exclude',
              'stale',
              'source changed',
              NULL,
              TIMESTAMPTZ '2026-07-25T07:02:00Z'
            )
        \`)

        await migrateDuckdb()

        const columns = await database.queryJson(
          "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_article_summary_rebuild_partial_v4' ORDER BY ordinal_position"
        )
        const indexes = await database.queryJson(
          "SELECT index_name AS indexName, sql FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_article_summary_rebuild_partial_v4' ORDER BY index_name"
        )
        const rows = await database.queryJson(
          "SELECT chunk_id AS chunkId, summary_identity AS summaryIdentity, filter_key AS filterKey, availability, stale_reason AS staleReason, CAST(count_value AS INTEGER) AS countValue FROM mart.review_article_summary_rebuild_partial_v4 ORDER BY chunk_id, summary_identity"
        )
        console.log(JSON.stringify({columns, indexes, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39993',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39994',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB migration')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: Array<{columnName: string}>
      indexes: Array<{indexName: string; sql: string}>
      rows: Array<{
        availability: string
        chunkId: string
        countValue: number | null
        filterKey: string | null
        staleReason: string | null
        summaryIdentity: string
      }>
    }
    const columns = parsed.columns.map((row) => {
      return row.columnName
    })
    const uniqueIndexSql = parsed.indexes.find((row) => {
      return row.indexName === 'idx_review_article_summary_rebuild_partial_v4_unique'
    })?.sql

    expect(columns).not.toContain('serving_key')
    expect(columns).toContain('summary_identity')
    expect(uniqueIndexSql).toContain("COALESCE(list_mode_key, 'global')")
    expect(uniqueIndexSql).toContain("COALESCE(filter_key, '')")
    expect(parsed.rows).toEqual([
      {
        availability: 'ready',
        chunkId: 'chunk-a',
        countValue: 5,
        filterKey: null,
        staleReason: null,
        summaryIdentity: 'summary-a',
      },
      {
        availability: 'stale',
        chunkId: 'chunk-b',
        countValue: null,
        filterKey: 'filter-a',
        staleReason: 'source changed',
        summaryIdentity: 'summary-b',
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migrations drop queue serving identity and collapse scalar-key duplicates', async () => {
  const duckdbPath = `/tmp/forska-review-queue-serving-identity-${Date.now()}.duckdb`
  const targetMigrationFiles = new Set(['0139_dropReviewQueueServingIdentity.sql'])
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return !targetMigrationFiles.has(fileName)
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        await database.run('CREATE SCHEMA IF NOT EXISTS app')
        await database.run('CREATE SCHEMA IF NOT EXISTS mart')
        await database.run(
          "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        await database.run(
          "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
            .map((fileName) => {
              return `('${fileName.replaceAll("'", "''")}')`
            })
            .join(', ')}"
        )
        await database.run(\`
          CREATE TABLE mart.review_unassessed_queue_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            queue_identity VARCHAR NOT NULL,
            queue_kind VARCHAR NOT NULL,
            priority_bucket INTEGER NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL,
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR,
            queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            PRIMARY KEY(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id, prompt_id, queue_identity)
          )
        \`)
        await database.run(\`
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
          VALUES
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'legacy-queue-a',
              'unassessed',
              10,
              TIMESTAMPTZ '2026-07-25T07:00:00Z',
              'article-a',
              'prompt-a',
              TIMESTAMPTZ '2026-07-25T07:01:00Z'
            ),
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'legacy-queue-b',
              'unassessed',
              10,
              TIMESTAMPTZ '2026-07-25T07:00:00Z',
              'article-a',
              'prompt-a',
              TIMESTAMPTZ '2026-07-25T07:02:00Z'
            )
        \`)

        await migrateDuckdb()

        const columns = await database.queryJson(
          "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_unassessed_queue_serving_v4' ORDER BY ordinal_position"
        )
        const rows = await database.queryJson(
          "SELECT article_id AS articleId, prompt_id AS promptId, queue_kind AS queueKind, queue_updated_at AS queueUpdatedAt FROM mart.review_unassessed_queue_serving_v4 ORDER BY article_id, prompt_id"
        )
        console.log(JSON.stringify({columns, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39993',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39994',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB migration')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: Array<{columnName: string}>
      rows: Array<{articleId: string; promptId: string; queueKind: string; queueUpdatedAt: string}>
    }
    const columns = parsed.columns.map((row) => {
      return row.columnName
    })

    expect(columns).toEqual([
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
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-a',
        promptId: 'prompt-a',
        queueKind: 'unassessed',
        queueUpdatedAt: expect.stringContaining('2026-07-25') as string,
      },
    ])
    expect(parsed.rows[0]?.queueUpdatedAt).toContain('09:02')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migrations add canonical article identifiers and keep legacy article ids non-unique', async () => {
  const duckdbPath = `/tmp/forska-canonical-article-identifier-${Date.now()}.duckdb`
  const canonicalSchemaMigrationSql = readFileSync(
    resolve(migrationsFolder, '0077_articleIdentifierCanonicalSchema.sql'),
    'utf8',
  )
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const articleConstraints = await database.queryJson(
          "SELECT constraint_type AS constraintType, constraint_column_names AS columnNames FROM duckdb_constraints() WHERE schema_name = 'app' AND table_name = 'article' ORDER BY constraint_name"
        )
        const identifierConstraints = await database.queryJson(
          "SELECT constraint_type AS constraintType, constraint_column_names AS columnNames FROM duckdb_constraints() WHERE schema_name = 'app' AND table_name = 'article_identifier' ORDER BY constraint_name"
        )

        await database.run(
          "INSERT INTO app.article (id, article_title, article_id) VALUES ('canonical-null-a', 'Null A', NULL), ('canonical-null-b', 'Null B', NULL), ('legacy-a', 'Legacy A', 'legacy:shared'), ('legacy-b', 'Legacy B', 'legacy:shared')"
        )
        await database.run(
          "INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source) VALUES ('identifier-a', 'legacy-a', 'doi', '10.1000/example', 'test')"
        )

        const duplicateIdentifierRejected = await database
          .run("INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source) VALUES ('identifier-b', 'legacy-b', 'doi', '10.1000/example', 'test')")
          .then(
            () => false,
            () => true,
          )
        const [nullLegacyRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article WHERE article_id IS NULL AND id IN ('canonical-null-a', 'canonical-null-b')"
        )
        const legacyRows = await database.queryJson(
          "SELECT legacy_article_id AS legacyArticleId, article_id AS articleId FROM app.article_legacy_id_lookup WHERE legacy_article_id = 'legacy:shared' ORDER BY article_id ASC"
        )

        console.log(JSON.stringify({articleConstraints, duplicateIdentifierRejected, identifierConstraints, legacyRows, nullLegacyRow}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify DuckDB migrations')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      articleConstraints: Array<{constraintType: string; columnNames: string[]}>
      duplicateIdentifierRejected: boolean
      identifierConstraints: Array<{constraintType: string; columnNames: string[]}>
      legacyRows: Array<{articleId: string; legacyArticleId: string}>
      nullLegacyRow: {count: number}
    }
    const articleUniqueColumns = parsed.articleConstraints
      .filter((constraint) => {
        return constraint.constraintType === 'UNIQUE'
      })
      .map((constraint) => {
        return constraint.columnNames
      })
    const identifierUniqueColumns = parsed.identifierConstraints
      .filter((constraint) => {
        return constraint.constraintType === 'UNIQUE'
      })
      .map((constraint) => {
        return constraint.columnNames
      })

    expect(articleUniqueColumns).not.toContainEqual(['article_id'])
    expect(identifierUniqueColumns).toContainEqual(['kind', 'normalized_value'])
    expect(canonicalSchemaMigrationSql).toContain('legacy_identifier_candidate AS')
    expect(canonicalSchemaMigrationSql).toContain('INSERT INTO app.article_identifier')
    expect(canonicalSchemaMigrationSql).toContain('identifier_article_count = 1')
    expect(canonicalSchemaMigrationSql).toContain('duplicate_legacy_identifier')
    expect(canonicalSchemaMigrationSql).not.toContain('ROW_NUMBER() OVER (PARTITION BY kind, normalized_value')
    expect(parsed.duplicateIdentifierRejected).toBe(true)
    expect(parsed.nullLegacyRow.count).toBe(2)
    expect(parsed.legacyRows).toEqual([
      {articleId: 'legacy-a', legacyArticleId: 'legacy:shared'},
      {articleId: 'legacy-b', legacyArticleId: 'legacy:shared'},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migrations add import-scoped source record identity and idempotency constraints', async () => {
  const duckdbPath = `/tmp/forska-import-scoped-source-record-${Date.now()}.duckdb`
  const sourceRecordMigrationSql = readFileSync(
    resolve(migrationsFolder, '0078_articleImportRouteSourceRecords.sql'),
    'utf8',
  )
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const importRouteColumns = await database.queryJson(
          "SELECT column_name AS columnName FROM duckdb_columns() WHERE schema_name = 'app' AND table_name = 'article_import_route' ORDER BY column_name"
        )
        const importRouteConstraints = await database.queryJson(
          "SELECT constraint_type AS constraintType, constraint_column_names AS columnNames FROM duckdb_constraints() WHERE schema_name = 'app' AND table_name = 'article_import_route' ORDER BY constraint_name"
        )
        const sourceRecordConstraints = await database.queryJson(
          "SELECT constraint_type AS constraintType, constraint_column_names AS columnNames FROM duckdb_constraints() WHERE schema_name = 'app' AND table_name = 'article_import_route_source_record' ORDER BY constraint_name"
        )
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE schema_name = 'app' AND table_name IN ('article_import_route', 'article_import_route_source_record') ORDER BY index_name ASC"
        )

        await database.run(
          "INSERT INTO app.import_route (id, route, name) VALUES ('source-record-route', 'source-record:test', 'Source Record Test')"
        )
        await database.run(
          "INSERT INTO app.article (id, article_title, article_id) VALUES ('source-record-article-a', 'Article A', NULL), ('source-record-article-b', 'Article B', NULL)"
        )
        await database.run(
          "INSERT INTO app.article_import_route (id, article_id, import_route_id) VALUES ('source-record-link-a', 'source-record-article-a', 'source-record-route'), ('source-record-link-b', 'source-record-article-b', 'source-record-route')"
        )
        await database.run(
          "INSERT INTO app.article_import_route_source_record (id, article_id, import_route_id, source_record_key, source_record_hash) VALUES ('source-record-row-a', 'source-record-article-a', 'source-record-route', 'source-key-a', 'hash-a')"
        )

        const duplicateCurrentMembershipRejected = await database
          .run("INSERT INTO app.article_import_route (id, article_id, import_route_id) VALUES ('source-record-link-duplicate', 'source-record-article-a', 'source-record-route')")
          .then(
            () => false,
            () => true,
          )
        const duplicateSourceKeyRejected = await database
          .run("INSERT INTO app.article_import_route_source_record (id, article_id, import_route_id, source_record_key, source_record_hash) VALUES ('source-record-row-b', 'source-record-article-b', 'source-record-route', 'source-key-a', 'hash-b')")
          .then(
            () => false,
            () => true,
          )
        const [nullableLegacyRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route WHERE import_route_id = 'source-record-route' AND external_article_id IS NULL AND source_record_key IS NULL AND source_record_hash IS NULL"
        )

        console.log(JSON.stringify({duplicateCurrentMembershipRejected, duplicateSourceKeyRejected, importRouteColumns, importRouteConstraints, indexRows, nullableLegacyRow, sourceRecordConstraints}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify import-scoped source record schema',
      )
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      duplicateCurrentMembershipRejected: boolean
      duplicateSourceKeyRejected: boolean
      importRouteColumns: Array<{columnName: string}>
      importRouteConstraints: Array<{constraintType: string; columnNames: string[]}>
      indexRows: Array<{indexName: string}>
      nullableLegacyRow: {count: number}
      sourceRecordConstraints: Array<{constraintType: string; columnNames: string[]}>
    }
    const indexNames = parsed.indexRows.map((row) => {
      return row.indexName
    })
    const importRouteColumnNames = parsed.importRouteColumns.map((column) => {
      return column.columnName
    })
    const currentUniqueColumns = parsed.importRouteConstraints
      .filter((constraint) => {
        return constraint.constraintType === 'UNIQUE'
      })
      .map((constraint) => {
        return constraint.columnNames
      })
    const sourceRecordUniqueColumns = parsed.sourceRecordConstraints
      .filter((constraint) => {
        return constraint.constraintType === 'UNIQUE'
      })
      .map((constraint) => {
        return constraint.columnNames
      })

    expect(importRouteColumnNames).toContain('external_article_id')
    expect(importRouteColumnNames).toContain('source_kind')
    expect(importRouteColumnNames).toContain('import_metadata')
    expect(importRouteColumnNames).toContain('match_metadata')
    expect(importRouteColumnNames).toContain('import_run_id')
    expect(importRouteColumnNames).toContain('source_record_key')
    expect(importRouteColumnNames).toContain('source_record_hash')
    expect(importRouteColumnNames).toContain('raw_payload')
    expect(sourceRecordMigrationSql).toContain('SET external_article_id =')
    expect(currentUniqueColumns).toContainEqual(['article_id', 'import_route_id'])
    expect(sourceRecordUniqueColumns).toContainEqual(['import_route_id', 'source_record_key'])
    expect(indexNames).toContain('idx_app_article_import_route_article_id')
    expect(indexNames).toContain('idx_app_article_import_route_external_article_id')
    expect(indexNames).toContain('idx_app_article_import_route_source_record_external_article_id')
    expect(parsed.duplicateCurrentMembershipRejected).toBe(true)
    expect(parsed.duplicateSourceKeyRejected).toBe(true)
    expect(parsed.nullableLegacyRow.count).toBe(2)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migrations add project transfer session and history invariants', async () => {
  const duckdbPath = `/tmp/forska-project-transfer-schema-${Date.now()}.duckdb`
  const transferMigrationSql = readFileSync(resolve(migrationsFolder, '0084_projectTransferSessionHistory.sql'), 'utf8')
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const sessionColumns = await database.queryJson(
          "SELECT column_name AS columnName FROM duckdb_columns() WHERE schema_name = 'app' AND table_name = 'project_transfer_session' ORDER BY column_index"
        )
        const historyColumns = await database.queryJson(
          "SELECT column_name AS columnName FROM duckdb_columns() WHERE schema_name = 'app' AND table_name = 'project_transfer_history' ORDER BY column_index"
        )
        const constraints = await database.queryJson(
          "SELECT table_name AS tableName, constraint_type AS constraintType, constraint_column_names AS columnNames FROM duckdb_constraints() WHERE schema_name = 'app' AND table_name IN ('project_transfer_session', 'project_transfer_history') ORDER BY table_name ASC, constraint_name ASC"
        )
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE schema_name = 'app' AND table_name IN ('project_transfer_session', 'project_transfer_history') ORDER BY index_name ASC"
        )

        await database.run(
          "INSERT INTO app.project_transfer_session (id, direction, state, expires_at) VALUES ('transfer-import-session', 'import', 'awaiting_upload', TIMESTAMPTZ '2026-01-01T00:00:00Z'), ('transfer-export-session', 'export', 'queued', TIMESTAMPTZ '2026-01-01T00:00:00Z')"
        )
        const importStateRejected = await database
          .run("INSERT INTO app.project_transfer_session (id, direction, state, expires_at) VALUES ('transfer-import-state-bad', 'import', 'ready', TIMESTAMPTZ '2026-01-01T00:00:00Z')")
          .then(
            () => false,
            () => true,
          )
        const exportStateRejected = await database
          .run("INSERT INTO app.project_transfer_session (id, direction, state, expires_at) VALUES ('transfer-export-state-bad', 'export', 'awaiting_upload', TIMESTAMPTZ '2026-01-01T00:00:00Z')")
          .then(
            () => false,
            () => true,
          )
        const directionRejected = await database
          .run("INSERT INTO app.project_transfer_session (id, direction, state, expires_at) VALUES ('transfer-direction-bad', 'sync', 'queued', TIMESTAMPTZ '2026-01-01T00:00:00Z')")
          .then(
            () => false,
            () => true,
          )

        await database.run(
          "INSERT INTO app.project_transfer_history (id, direction, session_id, commit_id, package_fingerprint, schema_version, source_project_id, source_project_name, target_project_id, target_project_name, payload_counts_json, completion_payload_json) VALUES ('transfer-history-import', 'import', 'transfer-import-session', 'commit-import-1', 'fingerprint-import-1', 1, 'source-project-1', 'Source Project', 'target-project-1', 'Target Project', CAST('{\\"articles\\":1}' AS JSON), CAST('{\\"status\\":\\"completed\\"}' AS JSON))"
        )
        const importCompletionRejected = await database
          .run("INSERT INTO app.project_transfer_history (id, direction, session_id, commit_id, package_fingerprint, schema_version, source_project_name, target_project_id, target_project_name, payload_counts_json) VALUES ('transfer-history-import-incomplete', 'import', 'transfer-import-session-incomplete', 'commit-import-incomplete', 'fingerprint-import-incomplete', 1, 'Source Project', 'target-project-incomplete', 'Target Project', CAST('{\\"articles\\":1}' AS JSON))")
          .then(
            () => false,
            () => true,
          )
        const sameSessionRejected = await database
          .run("INSERT INTO app.project_transfer_history (id, direction, session_id, commit_id, package_fingerprint, schema_version, source_project_name, target_project_id, target_project_name, payload_counts_json, completion_payload_json) VALUES ('transfer-history-import-retry', 'import', 'transfer-import-session', 'commit-import-retry', 'fingerprint-import-retry', 1, 'Source Project', 'target-project-retry', 'Target Project', CAST('{\\"articles\\":1}' AS JSON), CAST('{\\"status\\":\\"completed\\"}' AS JSON))")
          .then(
            () => false,
            () => true,
          )
        const duplicatePackageAllowed = await database
          .run("INSERT INTO app.project_transfer_history (id, direction, session_id, commit_id, package_fingerprint, schema_version, source_project_name, target_project_id, target_project_name, payload_counts_json, completion_payload_json) VALUES ('transfer-history-import-duplicate-package', 'import', 'transfer-import-session-2', 'commit-import-2', 'fingerprint-import-1', 1, 'Source Project', 'target-project-2', 'Target Project', CAST('{\\"articles\\":1}' AS JSON), CAST('{\\"status\\":\\"completed\\"}' AS JSON))")
          .then(
            () => true,
            () => false,
          )
        const exportHistoryAllowed = await database
          .run("INSERT INTO app.project_transfer_history (id, direction, package_fingerprint, schema_version, source_project_name, payload_counts_json) VALUES ('transfer-history-export', 'export', 'fingerprint-export-1', 1, 'Source Project', CAST('{\\"articles\\":1}' AS JSON))")
          .then(
            () => true,
            () => false,
          )

        console.log(JSON.stringify({constraints, directionRejected, duplicatePackageAllowed, exportHistoryAllowed, exportStateRejected, historyColumns, importCompletionRejected, importStateRejected, indexRows, sameSessionRejected, sessionColumns}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify project transfer schema',
      )
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      constraints: Array<{columnNames: string[]; constraintType: string; tableName: string}>
      directionRejected: boolean
      duplicatePackageAllowed: boolean
      exportHistoryAllowed: boolean
      exportStateRejected: boolean
      historyColumns: Array<{columnName: string}>
      importCompletionRejected: boolean
      importStateRejected: boolean
      indexRows: Array<{indexName: string}>
      sameSessionRejected: boolean
      sessionColumns: Array<{columnName: string}>
    }
    const sessionColumnNames = parsed.sessionColumns.map((column) => {
      return column.columnName
    })
    const historyColumnNames = parsed.historyColumns.map((column) => {
      return column.columnName
    })
    const indexNames = parsed.indexRows.map((row) => {
      return row.indexName
    })
    const foreignKeyConstraints = parsed.constraints.filter((constraint) => {
      return constraint.constraintType === 'FOREIGN KEY'
    })

    expect(sessionColumnNames).toEqual([
      'id',
      'direction',
      'state',
      'plan_revision',
      'package_fingerprint',
      'commit_id',
      'owner_token',
      'heartbeat_at',
      'expires_at',
      'progress_json',
      'plan_summary_json',
      'completion_payload_json',
      'error_json',
      'created_at',
      'updated_at',
      'terminal_cleanup_at',
    ])
    expect(historyColumnNames).toEqual([
      'id',
      'direction',
      'session_id',
      'commit_id',
      'package_fingerprint',
      'schema_version',
      'source_project_id',
      'source_project_name',
      'target_project_id',
      'target_project_name',
      'payload_counts_json',
      'completion_payload_json',
      'created_at',
    ])
    expect(transferMigrationSql).not.toContain('REFERENCES app.')
    expect(foreignKeyConstraints).toEqual([])
    expect(indexNames).toContain('idx_app_project_transfer_session_stale_recovery')
    expect(indexNames).toContain('idx_app_project_transfer_history_duplicate_warning')
    expect(indexNames).toContain('idx_app_project_transfer_history_session_completion')
    expect(indexNames).toContain('idx_app_project_transfer_history_direction_session_unique')
    expect(parsed.importStateRejected).toBe(true)
    expect(parsed.exportStateRejected).toBe(true)
    expect(parsed.directionRejected).toBe(true)
    expect(parsed.importCompletionRejected).toBe(true)
    expect(parsed.sameSessionRejected).toBe(true)
    expect(parsed.duplicatePackageAllowed).toBe(true)
    expect(parsed.exportHistoryAllowed).toBe(true)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migrations add project transfer target-state dirty token coverage tables', async () => {
  const duckdbPath = `/tmp/forska-project-transfer-target-state-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const dirtyTokenColumns = await database.queryJson(
          "SELECT column_name AS columnName FROM duckdb_columns() WHERE schema_name = 'app' AND table_name = 'project_transfer_target_state_dirty_token' ORDER BY column_index"
        )
        const unknownTokenColumns = await database.queryJson(
          "SELECT column_name AS columnName FROM duckdb_columns() WHERE schema_name = 'app' AND table_name = 'project_transfer_target_state_unknown_token' ORDER BY column_index"
        )
        const coverageColumns = await database.queryJson(
          "SELECT column_name AS columnName FROM duckdb_columns() WHERE schema_name = 'app' AND table_name = 'project_transfer_target_state_coverage' ORDER BY column_index"
        )
        const constraints = await database.queryJson(
          "SELECT table_name AS tableName, constraint_type AS constraintType, constraint_column_names AS columnNames FROM duckdb_constraints() WHERE schema_name = 'app' AND table_name IN ('project_transfer_target_state_dirty_token', 'project_transfer_target_state_unknown_token', 'project_transfer_target_state_coverage') ORDER BY table_name ASC, constraint_name ASC"
        )
        const [unknownToken] = await database.queryJson(
          "SELECT id, CAST(dirty_token AS INTEGER) AS dirtyToken FROM app.project_transfer_target_state_unknown_token WHERE id = 'global'"
        )

        console.log(JSON.stringify({constraints, coverageColumns, dirtyTokenColumns, unknownToken, unknownTokenColumns}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify target-state dirty token schema',
      )
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      constraints: Array<{columnNames: string[]; constraintType: string; tableName: string}>
      coverageColumns: Array<{columnName: string}>
      dirtyTokenColumns: Array<{columnName: string}>
      unknownToken: {dirtyToken: number; id: string} | null
      unknownTokenColumns: Array<{columnName: string}>
    }
    const dirtyTokenColumnNames = parsed.dirtyTokenColumns.map((column) => {
      return column.columnName
    })
    const unknownTokenColumnNames = parsed.unknownTokenColumns.map((column) => {
      return column.columnName
    })
    const coverageColumnNames = parsed.coverageColumns.map((column) => {
      return column.columnName
    })
    const primaryKeyConstraints = parsed.constraints.filter((constraint) => {
      return constraint.constraintType === 'PRIMARY KEY'
    })

    expect(dirtyTokenColumnNames).toEqual([
      'surface',
      'dirty_token',
      'last_reason',
      'last_advanced_at',
      'created_at',
      'updated_at',
    ])
    expect(unknownTokenColumnNames).toEqual([
      'id',
      'dirty_token',
      'last_reason',
      'last_advanced_at',
      'created_at',
      'updated_at',
    ])
    expect(coverageColumnNames).toEqual([
      'id',
      'coverage_code_version',
      'covered_surfaces_json',
      'dependency_fingerprint_algorithm',
      'dependency_fingerprint_code_version',
      'initialized_at',
      'updated_at',
    ])
    expect(primaryKeyConstraints).toHaveLength(3)
    expect(parsed.unknownToken).toEqual({dirtyToken: 0, id: 'global'})
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('provider model natural key migration deduplicates existing model references before adding the index', async () => {
  const duckdbPath = `/tmp/forska-provider-model-natural-key-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {readFileSync} = await import('node:fs')
        const [{getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        await database.run("CREATE SCHEMA app")
        await database.run("CREATE SCHEMA mart")
        await database.run("CREATE TABLE app.provider_connection (id VARCHAR PRIMARY KEY, provider_kind VARCHAR NOT NULL, label VARCHAR NOT NULL, config_json JSON, updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp)")
        await database.run("CREATE TABLE app.model (id VARCHAR PRIMARY KEY, provider_connection_id VARCHAR NOT NULL, name VARCHAR NOT NULL, remote_model_id VARCHAR, display_name VARCHAR, variant VARCHAR, source VARCHAR, enabled BOOLEAN NOT NULL DEFAULT TRUE, metadata_json JSON, created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp)")
        await database.run("CREATE TABLE app.project (id VARCHAR PRIMARY KEY, model_id VARCHAR NOT NULL REFERENCES app.model(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp)")
        await database.run("CREATE TABLE app.user_config (id VARCHAR PRIMARY KEY, full_text_conversion_model_id VARCHAR, updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp)")
        await database.run("CREATE TABLE app.article (id VARCHAR PRIMARY KEY, full_text_conversion_model_id VARCHAR, updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp)")
        await database.run("CREATE TABLE app.comparison_project (id VARCHAR PRIMARY KEY, model_ids VARCHAR[], updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp)")
        await database.run("CREATE TABLE app.comparison_project_serving_generation (comparison_project_id VARCHAR NOT NULL PRIMARY KEY, active_generation BIGINT NOT NULL, generation_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, serving_status VARCHAR DEFAULT 'missing', serving_generation BIGINT, serving_started_at TIMESTAMPTZ, serving_completed_at TIMESTAMPTZ, serving_failed_at TIMESTAMPTZ, serving_error VARCHAR, serving_phase VARCHAR, serving_phase_started_at TIMESTAMPTZ, serving_last_progressed_at TIMESTAMPTZ, serving_staged_article_count BIGINT DEFAULT 0, serving_staged_cell_count BIGINT DEFAULT 0, serving_staged_filter_member_count BIGINT DEFAULT 0, serving_staged_filter_stats_count BIGINT DEFAULT 0)")
        await database.run("CREATE TABLE app.judgment (id VARCHAR PRIMARY KEY, article_id VARCHAR NOT NULL, prompt_id VARCHAR NOT NULL, model_id VARCHAR NOT NULL REFERENCES app.model(id), use_title BOOLEAN NOT NULL DEFAULT TRUE, use_abstract BOOLEAN NOT NULL DEFAULT TRUE, use_fulltext BOOLEAN NOT NULL DEFAULT FALSE, use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE, is_answered BOOLEAN NOT NULL DEFAULT FALSE, answered_original VARCHAR, answered_original_as_array VARCHAR[], delete_generation BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, UNIQUE(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation))")
        await database.run("CREATE TABLE app.judgment_assessment (id VARCHAR PRIMARY KEY, judgment_id VARCHAR NOT NULL REFERENCES app.judgment(id), assessment_is_correct BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, UNIQUE(judgment_id))")
        await database.run("CREATE TABLE app.judgment_execution_snapshot (id VARCHAR PRIMARY KEY, model_id VARCHAR NOT NULL)")
        await database.run("CREATE TABLE app.judgment_job_sqlite_outbox_import (job_id VARCHAR NOT NULL, outbox_seq BIGINT NOT NULL, judgment_id VARCHAR, model_id VARCHAR, updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, PRIMARY KEY (job_id, outbox_seq))")
        await database.run("CREATE TABLE mart.judgment_fact (judgment_id VARCHAR PRIMARY KEY, model_id VARCHAR NOT NULL)")
        await database.run("CREATE TABLE mart.prompt_answer_fact (project_id VARCHAR NOT NULL, judgment_id VARCHAR NOT NULL, answer_value VARCHAR NOT NULL, model_id VARCHAR NOT NULL, PRIMARY KEY(project_id, judgment_id, answer_value))")
        await database.run("CREATE TABLE mart.review_article_serving_detail (project_id VARCHAR NOT NULL, generation BIGINT NOT NULL, judgment_id VARCHAR NOT NULL, model_id VARCHAR NOT NULL, PRIMARY KEY(project_id, generation, judgment_id))")
        await database.run("CREATE TABLE mart.comparison_cell_serving (comparison_project_id VARCHAR NOT NULL, generation BIGINT NOT NULL, article_id VARCHAR NOT NULL, column_id VARCHAR NOT NULL, model_id VARCHAR, PRIMARY KEY(comparison_project_id, generation, article_id, column_id))")
        await database.run("INSERT INTO app.provider_connection (id, provider_kind, label, config_json) VALUES ('connection-1', 'openai', 'Connection 1', CAST('{\\"archived\\":false,\\"disabledModelIds\\":[\\"model-a\\",\\"model-b\\"],\\"manualWorkerUrls\\":[],\\"workerUrlMode\\":\\"manual\\"}' AS JSON))")
        await database.run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, variant, source, enabled, metadata_json, created_at) VALUES ('model-a', 'connection-1', 'Remote 1', 'remote-1', 'Remote 1', NULL, 'manual', TRUE, NULL, TIMESTAMPTZ '2026-01-01T00:00:00Z'), ('model-b', 'connection-1', 'Remote 1 Duplicate', 'remote-1', 'Remote 1 Duplicate', '', 'manual', FALSE, CAST('{\\"options\\":{\\"thinking\\":\\"high\\"}}' AS JSON), TIMESTAMPTZ '2026-01-02T00:00:00Z'), ('model-answer-canonical', 'connection-1', 'Remote Answer', 'remote-answer', 'Remote Answer', NULL, 'manual', TRUE, NULL, TIMESTAMPTZ '2026-01-03T00:00:00Z'), ('model-answer-duplicate', 'connection-1', 'Remote Answer Duplicate', 'remote-answer', 'Remote Answer Duplicate', NULL, 'manual', TRUE, NULL, TIMESTAMPTZ '2026-01-04T00:00:00Z'), ('model-null-a', 'connection-1', 'Null A', NULL, 'Null A', NULL, 'manual', TRUE, NULL, TIMESTAMPTZ '2026-01-05T00:00:00Z'), ('model-null-b', 'connection-1', 'Null B', NULL, 'Null B', NULL, 'manual', TRUE, NULL, TIMESTAMPTZ '2026-01-06T00:00:00Z')")
        await database.run("INSERT INTO app.project (id, model_id) VALUES ('project-1', 'model-b')")
        await database.run("INSERT INTO app.user_config (id, full_text_conversion_model_id) VALUES ('user-1', 'model-b')")
        await database.run("INSERT INTO app.article (id, full_text_conversion_model_id) VALUES ('article-conversion-1', 'model-b')")
        await database.run("INSERT INTO app.comparison_project (id, model_ids) VALUES ('comparison-1', ['model-a', 'model-b', 'model-null-a'])")
        await database.run("INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation, serving_status, serving_generation, serving_completed_at) VALUES ('comparison-1', 1, 'ready', 1, current_timestamp)")
        await database.run("INSERT INTO app.judgment (id, article_id, prompt_id, model_id, is_answered, answered_original, answered_original_as_array, created_at) VALUES ('judgment-a', 'article-1', 'prompt-1', 'model-a', FALSE, NULL, NULL, TIMESTAMPTZ '2026-01-01T00:00:00Z'), ('judgment-b', 'article-1', 'prompt-1', 'model-b', FALSE, NULL, NULL, TIMESTAMPTZ '2026-01-02T00:00:00Z'), ('judgment-c', 'article-1', 'prompt-2', 'model-b', FALSE, NULL, NULL, TIMESTAMPTZ '2026-01-03T00:00:00Z'), ('judgment-unanswered-canonical', 'article-answer-1', 'prompt-answer-1', 'model-answer-canonical', FALSE, NULL, NULL, TIMESTAMPTZ '2026-01-04T00:00:00Z'), ('judgment-answered-duplicate', 'article-answer-1', 'prompt-answer-1', 'model-answer-duplicate', TRUE, 'include', ['include'], TIMESTAMPTZ '2026-01-05T00:00:00Z')")
        await database.run("INSERT INTO app.judgment_assessment (id, judgment_id, assessment_is_correct, created_at) VALUES ('assessment-a', 'judgment-a', TRUE, TIMESTAMPTZ '2026-01-01T00:00:00Z'), ('assessment-b', 'judgment-b', FALSE, TIMESTAMPTZ '2026-01-02T00:00:00Z'), ('assessment-c', 'judgment-c', TRUE, TIMESTAMPTZ '2026-01-03T00:00:00Z'), ('assessment-unanswered-canonical', 'judgment-unanswered-canonical', FALSE, TIMESTAMPTZ '2026-01-04T00:00:00Z'), ('assessment-answered-duplicate', 'judgment-answered-duplicate', TRUE, TIMESTAMPTZ '2026-01-05T00:00:00Z')")
        await database.run("INSERT INTO app.judgment_execution_snapshot (id, model_id) VALUES ('snapshot-1', 'model-b')")
        await database.run("INSERT INTO app.judgment_job_sqlite_outbox_import (job_id, outbox_seq, judgment_id, model_id) VALUES ('job-1', 1, 'judgment-b', 'model-b'), ('job-1', 2, 'judgment-c', 'model-b')")
        await database.run("INSERT INTO mart.judgment_fact (judgment_id, model_id) VALUES ('judgment-b', 'model-b'), ('judgment-c', 'model-b'), ('judgment-answered-duplicate', 'model-answer-duplicate')")
        await database.run("INSERT INTO mart.prompt_answer_fact (project_id, judgment_id, answer_value, model_id) VALUES ('project-1', 'judgment-b', 'yes', 'model-b'), ('project-1', 'judgment-c', 'no', 'model-b'), ('project-answer', 'judgment-answered-duplicate', 'include', 'model-answer-duplicate')")
        await database.run("INSERT INTO mart.review_article_serving_detail (project_id, generation, judgment_id, model_id) VALUES ('project-1', 1, 'judgment-b', 'model-b'), ('project-1', 1, 'judgment-c', 'model-b'), ('project-answer', 1, 'judgment-answered-duplicate', 'model-answer-duplicate')")
        await database.run("INSERT INTO mart.comparison_cell_serving (comparison_project_id, generation, article_id, column_id, model_id) VALUES ('comparison-1', 1, 'article-1', 'llm:model-b:prompt-1', 'model-b')")

        await database.run(readFileSync('./src/db/duckdbMigrations/0083_providerModelNaturalKey.sql', 'utf8'))

        const duplicateInsertRejected = await database
          .run("INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, variant) VALUES ('model-duplicate-rejected', 'connection-1', 'Duplicate Rejected', 'remote-1', NULL)")
          .then(
            () => false,
            () => true,
          )
        const models = await database.queryJson("SELECT id, COALESCE(enabled, TRUE) AS enabled, remote_model_id AS remoteModelId, json_extract_string(metadata_json, '$.options.thinking') AS thinking FROM app.model ORDER BY id ASC")
        const [providerConnection] = await database.queryJson("SELECT CAST(config_json AS VARCHAR) AS configJson FROM app.provider_connection WHERE id = 'connection-1'")
        const [project] = await database.queryJson("SELECT model_id AS modelId FROM app.project WHERE id = 'project-1'")
        const [userConfig] = await database.queryJson("SELECT full_text_conversion_model_id AS modelId FROM app.user_config WHERE id = 'user-1'")
        const [article] = await database.queryJson("SELECT full_text_conversion_model_id AS modelId FROM app.article WHERE id = 'article-conversion-1'")
        const [comparisonProject] = await database.queryJson("SELECT model_ids AS modelIds FROM app.comparison_project WHERE id = 'comparison-1'")
        const judgments = await database.queryJson("SELECT id, model_id AS modelId FROM app.judgment ORDER BY id ASC")
        const answeredJudgments = await database.queryJson("SELECT id, model_id AS modelId, is_answered AS isAnswered, answered_original AS answeredOriginal FROM app.judgment WHERE article_id = 'article-answer-1' ORDER BY id ASC")
        const assessments = await database.queryJson("SELECT id, judgment_id AS judgmentId FROM app.judgment_assessment ORDER BY id ASC")
        const [snapshot] = await database.queryJson("SELECT model_id AS modelId FROM app.judgment_execution_snapshot WHERE id = 'snapshot-1'")
        const outboxRows = await database.queryJson("SELECT outbox_seq::INTEGER AS outboxSeq, judgment_id AS judgmentId, model_id AS modelId FROM app.judgment_job_sqlite_outbox_import ORDER BY outbox_seq ASC")
        const martJudgmentFacts = await database.queryJson("SELECT judgment_id AS judgmentId, model_id AS modelId FROM mart.judgment_fact ORDER BY judgment_id ASC")
        const martPromptFacts = await database.queryJson("SELECT judgment_id AS judgmentId, model_id AS modelId FROM mart.prompt_answer_fact ORDER BY judgment_id ASC")
        const martReviewDetails = await database.queryJson("SELECT judgment_id AS judgmentId, model_id AS modelId FROM mart.review_article_serving_detail ORDER BY judgment_id ASC")
        const [comparisonCell] = await database.queryJson("SELECT model_id AS modelId FROM mart.comparison_cell_serving WHERE comparison_project_id = 'comparison-1'")
        const [comparisonServingGeneration] = await database.queryJson("SELECT CAST(active_generation AS INTEGER) AS activeGeneration, serving_status AS servingStatus FROM app.comparison_project_serving_generation WHERE comparison_project_id = 'comparison-1'")

        console.log(JSON.stringify({answeredJudgments, article, assessments, comparisonCell, comparisonProject, comparisonServingGeneration, duplicateInsertRejected, judgments, martJudgmentFacts, martPromptFacts, martReviewDetails, models, outboxRows, project, providerConnection, snapshot, userConfig}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify provider model dedupe')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      answeredJudgments: Array<{answeredOriginal: string | null; id: string; isAnswered: boolean; modelId: string}>
      article: {modelId: string}
      assessments: Array<{id: string; judgmentId: string}>
      comparisonCell: {modelId: string}
      comparisonProject: {modelIds: string[]}
      comparisonServingGeneration: {activeGeneration: number; servingStatus: string}
      duplicateInsertRejected: boolean
      judgments: Array<{id: string; modelId: string}>
      martJudgmentFacts: Array<{judgmentId: string; modelId: string}>
      martPromptFacts: Array<{judgmentId: string; modelId: string}>
      martReviewDetails: Array<{judgmentId: string; modelId: string}>
      models: Array<{enabled: boolean; id: string; remoteModelId: string | null; thinking: string | null}>
      outboxRows: Array<{judgmentId: string; modelId: string; outboxSeq: number}>
      project: {modelId: string}
      providerConnection: {configJson: string}
      snapshot: {modelId: string}
      userConfig: {modelId: string}
    }

    expect(parsed.duplicateInsertRejected).toBe(true)
    expect(parsed.models).toEqual([
      {enabled: true, id: 'model-answer-canonical', remoteModelId: 'remote-answer', thinking: null},
      {enabled: false, id: 'model-b', remoteModelId: 'remote-1', thinking: 'high'},
      {enabled: true, id: 'model-null-a', remoteModelId: null, thinking: null},
      {enabled: true, id: 'model-null-b', remoteModelId: null, thinking: null},
    ])
    expect(JSON.parse(parsed.providerConnection.configJson)).toMatchObject({disabledModelIds: ['model-b']})
    expect(parsed.project.modelId).toBe('model-b')
    expect(parsed.userConfig.modelId).toBe('model-b')
    expect(parsed.article.modelId).toBe('model-b')
    expect(parsed.comparisonProject.modelIds).toEqual(['model-b', 'model-null-a'])
    expect(parsed.judgments).toEqual([
      {id: 'judgment-answered-duplicate', modelId: 'model-answer-canonical'},
      {id: 'judgment-b', modelId: 'model-b'},
      {id: 'judgment-c', modelId: 'model-b'},
    ])
    expect(parsed.answeredJudgments).toEqual([
      {
        answeredOriginal: 'include',
        id: 'judgment-answered-duplicate',
        isAnswered: true,
        modelId: 'model-answer-canonical',
      },
    ])
    expect(parsed.assessments).toEqual([
      {id: 'assessment-answered-duplicate', judgmentId: 'judgment-answered-duplicate'},
      {id: 'assessment-b', judgmentId: 'judgment-b'},
      {id: 'assessment-c', judgmentId: 'judgment-c'},
    ])
    expect(parsed.snapshot.modelId).toBe('model-b')
    expect(parsed.outboxRows).toEqual([
      {judgmentId: 'judgment-b', modelId: 'model-b', outboxSeq: 1},
      {judgmentId: 'judgment-c', modelId: 'model-b', outboxSeq: 2},
    ])
    expect(parsed.martJudgmentFacts).toEqual([
      {judgmentId: 'judgment-answered-duplicate', modelId: 'model-answer-canonical'},
      {judgmentId: 'judgment-b', modelId: 'model-b'},
      {judgmentId: 'judgment-c', modelId: 'model-b'},
    ])
    expect(parsed.martPromptFacts).toEqual([
      {judgmentId: 'judgment-answered-duplicate', modelId: 'model-answer-canonical'},
      {judgmentId: 'judgment-b', modelId: 'model-b'},
      {judgmentId: 'judgment-c', modelId: 'model-b'},
    ])
    expect(parsed.martReviewDetails).toEqual([
      {judgmentId: 'judgment-answered-duplicate', modelId: 'model-answer-canonical'},
      {judgmentId: 'judgment-b', modelId: 'model-b'},
      {judgmentId: 'judgment-c', modelId: 'model-b'},
    ])
    expect(parsed.comparisonCell.modelId).toBe('model-b')
    expect(parsed.comparisonServingGeneration).toEqual({activeGeneration: 0, servingStatus: 'stale'})
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('migrateDuckdb preserves the original failure when rollback is already inactive', async () => {
  process.env.DUCKDB_PATH = '/tmp/forska-migrate-duckdb-test.duckdb'

  const targetMigrationFile = '0039_humanJudgmentSummaryMode.sql'
  const targetSql = readFileSync(resolve(migrationsFolder, targetMigrationFile), 'utf8').trim()
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const originalError = new Error(
    'Catalog Error: Type with name "project_prompt_criteria_disposition_v2" already exists!',
  )
  const rollbackError = new Error('TransactionContext Error: cannot rollback - no transaction is active')
  const appDatabaseServiceModulePath = new URL('../server/services/appDatabaseService.ts', import.meta.url).pathname
  const migrationModulePath = new URL('./migrateDuckdb.ts', import.meta.url).pathname
  const runStatements: string[] = []

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          close: async () => {},
          maintenance: async () => {},
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app_schema_migration')
              ? (appliedNames.map((name) => {
                  return {name}
                }) as T[])
              : []
          },
          run: async (statement: string) => {
            const normalizedStatement = statement.trim()
            runStatements.push(normalizedStatement)

            if (normalizedStatement === targetSql) {
              throw originalError
            }

            if (normalizedStatement === 'ROLLBACK') {
              throw rollbackError
            }
          },
        }
      },
    }
  })

  try {
    const {migrateDuckdb} = (await import(`${migrationModulePath}?rollback-test=${Date.now()}`)) as MigrateDuckdbModule
    const error: Error | null = await migrateDuckdb().then(
      () => {
        return null
      },
      (caughtError: unknown) => {
        return caughtError instanceof Error ? caughtError : new Error(String(caughtError))
      },
    )

    expect(error?.message ?? '').toContain(originalError.message)
    expect(error?.message ?? '').not.toContain(rollbackError.message)
    expect(runStatements).toContain('ROLLBACK')
  } finally {
    mock.restore()
  }
})

test('migrateDuckdb applies comparison serving conflict filter migration outside a transaction', async () => {
  process.env.DUCKDB_MEMORY_LIMIT = '20GB'
  process.env.DUCKDB_PATH = '/tmp/forska-migrate-duckdb-nontransactional-test.duckdb'

  const targetMigrationFile = '0076_comparisonServingHumanLlmTrueConflictFilter.sql'
  const targetSql = readFileSync(resolve(migrationsFolder, targetMigrationFile), 'utf8').trim()
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const appDatabaseServiceModulePath = new URL('../server/services/appDatabaseService.ts', import.meta.url).pathname
  const migrationModulePath = new URL('./migrateDuckdb.ts', import.meta.url).pathname
  const maintenanceCommands: string[] = []
  const runStatements: string[] = []

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          close: async () => {},
          maintenance: async (command: string) => {
            maintenanceCommands.push(command)
          },
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app_schema_migration')
              ? (appliedNames.map((name) => {
                  return {name}
                }) as T[])
              : []
          },
          run: async (statement: string) => {
            runStatements.push(statement.trim())
          },
        }
      },
    }
  })

  try {
    const {migrateDuckdb} = (await import(
      `${migrationModulePath}?nontransactional-test=${Date.now()}`
    )) as MigrateDuckdbModule

    await migrateDuckdb()

    const targetStatementIndex = runStatements.indexOf(targetSql)

    expect(targetStatementIndex).toBeGreaterThan(-1)
    expect(runStatements).not.toContain('BEGIN TRANSACTION')
    expect(runStatements).not.toContain('COMMIT')
    expect(runStatements[targetStatementIndex + 1] ?? '').toContain('INSERT INTO app_schema_migration')
    expect(maintenanceCommands).toEqual(['checkpoint'])
  } finally {
    mock.restore()
  }
})

test('migrateDuckdb skips checkpoint when no migration files are applied', async () => {
  process.env.DUCKDB_PATH = '/tmp/forska-migrate-duckdb-checkpoint-skip-test.duckdb'

  const appliedNames = getDuckdbMigrationFiles()
  const appDatabaseServiceModulePath = new URL('../server/services/appDatabaseService.ts', import.meta.url).pathname
  const migrationModulePath = new URL('./migrateDuckdb.ts', import.meta.url).pathname
  const maintenanceCommands: string[] = []

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          close: async () => {},
          maintenance: async (command: string) => {
            maintenanceCommands.push(command)
          },
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app_schema_migration')
              ? (appliedNames.map((name) => {
                  return {name}
                }) as T[])
              : []
          },
          run: async () => {},
        }
      },
    }
  })

  try {
    const {migrateDuckdb} = (await import(
      `${migrationModulePath}?checkpoint-skip-test=${Date.now()}`
    )) as MigrateDuckdbModule

    await migrateDuckdb()

    expect(maintenanceCommands).toEqual([])
  } finally {
    mock.restore()
  }
})

test('migrateDuckdb skips post-migration checkpoint under low-memory DuckDB profile', async () => {
  process.env.DUCKDB_MEMORY_LIMIT = '6400MiB'
  process.env.DUCKDB_PATH = '/tmp/forska-migrate-duckdb-low-memory-checkpoint-skip-test.duckdb'
  process.env.SERVER_ROLE = 'maintenance-worker'

  const targetMigrationFile = '0112_reviewServingSummaryRebuildPartial.sql'
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const appDatabaseServiceModulePath = new URL('../server/services/appDatabaseService.ts', import.meta.url).pathname
  const migrationModulePath = new URL('./migrateDuckdb.ts', import.meta.url).pathname
  const maintenanceCommands: string[] = []
  const runStatements: string[] = []

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          close: async () => {},
          maintenance: async (command: string) => {
            maintenanceCommands.push(command)
          },
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app_schema_migration')
              ? (appliedNames.map((name) => {
                  return {name}
                }) as T[])
              : []
          },
          run: async (statement: string) => {
            runStatements.push(statement)
          },
        }
      },
    }
  })

  try {
    const {migrateDuckdb} = (await import(
      `${migrationModulePath}?low-memory-checkpoint-skip-test=${Date.now()}`
    )) as MigrateDuckdbModule

    await migrateDuckdb()

    expect(runStatements.join('\n')).toContain(
      'CREATE TABLE IF NOT EXISTS mart.review_article_summary_rebuild_partial_v4',
    )
    expect(maintenanceCommands).toEqual([])
  } finally {
    mock.restore()
  }
})

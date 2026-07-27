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

test('DuckDB migration creates dirty source watermark aggregate with dirty-work backfill', () => {
  const migrationSql = readFileSync(resolve(migrationsFolder, '0186_reviewServingDirtySourceWatermark.sql'), 'utf8')

  expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS app.review_serving_project_dirty_source_watermark')
  expect(migrationSql).toContain('PRIMARY KEY(project_id, source_partition)')
  expect(migrationSql).toContain('MAX(latest_source_high_water_mark) AS source_high_water_mark')
  expect(migrationSql).toContain('FROM app.review_serving_dirty_work')
  expect(migrationSql).toContain('WHERE project_id IS NOT NULL')
  expect(migrationSql).toContain('GROUP BY project_id, source_partition')
  expect(migrationSql).toContain('ON CONFLICT(project_id, source_partition) DO UPDATE SET')
  expect(migrationSql).toContain('source_high_water_mark = GREATEST')
})

test('DuckDB migration refreshes dirty-source watermarks and leaves dirty-work pruning bounded at runtime', () => {
  const migrationSql = readFileSync(
    resolve(migrationsFolder, '0195_cleanupReviewServingDirtyWorkRetention.sql'),
    'utf8',
  )
  const watermarkInsertIndex = migrationSql.indexOf('INSERT INTO app.review_serving_project_dirty_source_watermark')

  expect(watermarkInsertIndex).toBeGreaterThanOrEqual(0)
  expect(migrationSql).toContain('FROM app.review_serving_dirty_work')
  expect(migrationSql).toContain('MAX(latest_source_high_water_mark) AS source_high_water_mark')
  expect(migrationSql).toContain('source_high_water_mark = GREATEST')
  expect(migrationSql).not.toContain('DELETE FROM app.review_serving_dirty_work')
  expect(migrationSql).not.toContain('DELETE FROM app.review_serving_dirty_work_ack')
  expect(migrationSql).not.toContain("status IN ('pending'")
  expect(migrationSql).not.toContain("status = 'pending'")
  expect(migrationSql).not.toContain("status = 'running'")
  expect(migrationSql).not.toContain("status = 'failed'")
})

test('DuckDB migration retires review article serving compatibility view without touching base/state tables', () => {
  const migrationSql = readFileSync(
    resolve(migrationsFolder, '0196_dropReviewArticleServingCompatibilityView.sql'),
    'utf8',
  ).trim()

  expect(migrationSql).toBe('DROP VIEW IF EXISTS mart.review_article_serving_v4;')
  expect(migrationSql).not.toContain('review_article_serving_base_v4')
  expect(migrationSql).not.toContain('review_article_serving_list_mode_state_v4')
})

test('DuckDB migration drops legacy review V3 marts and stale filter-state table', async () => {
  const duckdbPath = `/tmp/forska-drop-legacy-review-v3-marts-${Date.now()}.duckdb`
  const targetMigrationFile = '0201_dropLegacyReviewV3Marts.sql'
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
        await database.run("CREATE TABLE mart.review_article_serving (project_id VARCHAR NOT NULL, generation BIGINT NOT NULL, has_all_llm_judgments BOOLEAN NOT NULL, article_created_at TIMESTAMPTZ NOT NULL, article_id VARCHAR NOT NULL)")
        await database.run("CREATE TABLE mart.review_article_filter_member (project_id VARCHAR NOT NULL, generation BIGINT NOT NULL, prompt_id VARCHAR NOT NULL, answer_id BIGINT NOT NULL, article_id VARCHAR NOT NULL)")
        await database.run("CREATE TABLE mart.review_article_serving_detail (project_id VARCHAR NOT NULL, generation BIGINT NOT NULL, article_id VARCHAR NOT NULL, prompt_order INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL)")
        await database.run("CREATE TABLE mart.review_article_rollup (project_id VARCHAR NOT NULL, has_all_llm_judgments BOOLEAN NOT NULL, article_created_at TIMESTAMPTZ NOT NULL, article_id VARCHAR NOT NULL)")
        await database.run("CREATE TABLE mart.review_article_filter_state_serving_v4 (project_id VARCHAR NOT NULL, review_config_hash VARCHAR NOT NULL, snapshot_id VARCHAR NOT NULL, list_mode_key VARCHAR NOT NULL, article_id VARCHAR NOT NULL, duplicate_flag BOOLEAN NOT NULL, conflict_flag BOOLEAN NOT NULL, llm_status VARCHAR, human_status VARCHAR)")
        await database.run("CREATE INDEX idx_mart_review_article_serving_order ON mart.review_article_serving(project_id, generation, has_all_llm_judgments, article_created_at, article_id)")
        await database.run("CREATE INDEX idx_mart_review_article_filter_member_lookup ON mart.review_article_filter_member(project_id, generation, prompt_id, answer_id, article_id)")
        await database.run("CREATE INDEX idx_mart_review_article_serving_detail_lookup ON mart.review_article_serving_detail(project_id, generation, article_id, prompt_order, created_at)")
        await database.run("CREATE INDEX idx_mart_review_article_rollup_project_id ON mart.review_article_rollup(project_id, has_all_llm_judgments, article_created_at, article_id)")
        await database.run("CREATE UNIQUE INDEX idx_review_article_filter_state_serving_v4_pk ON mart.review_article_filter_state_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, article_id)")
        await database.run("CREATE INDEX idx_review_article_filter_state_serving_v4_lookup ON mart.review_article_filter_state_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, duplicate_flag, conflict_flag, llm_status, human_status, article_id)")

        await migrateDuckdb()

        const tableRows = await database.queryJson(\`
          SELECT table_name AS tableName
          FROM information_schema.tables
          WHERE table_schema = 'mart'
            AND table_name IN (
              'review_article_filter_state_serving_v4',
              'review_article_serving',
              'review_article_rollup',
              'review_article_filter_member',
              'review_article_serving_detail'
            )
          ORDER BY table_name
        \`)
        const indexRows = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE index_name IN (
            'idx_mart_review_article_serving_order',
            'idx_mart_review_article_filter_member_lookup',
            'idx_mart_review_article_serving_detail_lookup',
            'idx_mart_review_article_rollup_project_id',
            'idx_review_article_filter_state_serving_v4_lookup',
            'idx_review_article_filter_state_serving_v4_pk'
          )
          ORDER BY index_name
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0201_dropLegacyReviewV3Marts.sql'"
        )

        console.log(JSON.stringify({indexRows, migrationRows, tableRows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39987',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39988',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify legacy mart drop')
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
      indexRows: Array<{indexName: string}>
      migrationRows: Array<{name: string}>
      tableRows: Array<{tableName: string}>
    }

    expect(parsed.tableRows).toEqual([])
    expect(parsed.indexRows).toEqual([])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB legacy review V3 mart drop migration is idempotent when targets are absent', async () => {
  const duckdbPath = `/tmp/forska-drop-legacy-review-v3-marts-absent-${Date.now()}.duckdb`
  const targetMigrationFile = '0201_dropLegacyReviewV3Marts.sql'
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

        await migrateDuckdb()

        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0201_dropLegacyReviewV3Marts.sql'"
        )

        console.log(JSON.stringify({migrationRows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39985',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39986',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify idempotent legacy mart drop',
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
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {migrationRows: Array<{name: string}>}

    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migration backfills fixed list-mode membership flags', async () => {
  const duckdbPath = `/tmp/forska-review-list-mode-membership-flags-${Date.now()}.duckdb`
  const targetMigrationFile = '0197_reviewArticleServingListModeMembershipFlags.sql'
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
          CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            list_mode_keys VARCHAR[] NOT NULL,
            llm_patch_watermark BIGINT,
            human_patch_watermark BIGINT,
            both_patch_watermark BIGINT,
            unassessed_patch_watermark BIGINT,
            duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
            conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
            llm_status VARCHAR,
            human_status VARCHAR,
            llm_has_judgment BOOLEAN NOT NULL DEFAULT FALSE
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_list_mode_state_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            article_id,
            list_mode_keys
          )
          VALUES
            ('project-1', 'review-config-1', 'snapshot-1', 'article-1', ['llm', 'both']),
            ('project-1', 'review-config-1', 'snapshot-1', 'article-2', ['human', 'unassessed'])
        \`)

        await migrateDuckdb()

        await database.run(\`
          INSERT INTO mart.review_article_serving_list_mode_state_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            article_id,
            list_mode_keys
          )
          VALUES ('project-1', 'review-config-1', 'snapshot-1', 'article-3', [])
        \`)

        const columns = await database.queryJson(\`
          SELECT
            column_name AS columnName,
            is_nullable AS isNullable,
            column_default AS columnDefault
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_list_mode_state_v4'
            AND column_name LIKE 'has_%_list_mode'
          ORDER BY ordinal_position
        \`)
        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            has_llm_list_mode AS hasLlmListMode,
            has_human_list_mode AS hasHumanListMode,
            has_both_list_mode AS hasBothListMode,
            has_unassessed_list_mode AS hasUnassessedListMode
          FROM mart.review_article_serving_list_mode_state_v4
          ORDER BY article_id
        \`)

        console.log(JSON.stringify({columns, rows}))
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
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify list-mode membership migration',
      )
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      columns: Array<{columnDefault: string | null; columnName: string; isNullable: string}>
      rows: Array<{
        articleId: string
        hasBothListMode: boolean
        hasHumanListMode: boolean
        hasLlmListMode: boolean
        hasUnassessedListMode: boolean
      }>
    }

    expect(parsed.columns).toEqual([
      {columnDefault: "CAST('f' AS BOOLEAN)", columnName: 'has_llm_list_mode', isNullable: 'NO'},
      {columnDefault: "CAST('f' AS BOOLEAN)", columnName: 'has_human_list_mode', isNullable: 'NO'},
      {columnDefault: "CAST('f' AS BOOLEAN)", columnName: 'has_both_list_mode', isNullable: 'NO'},
      {columnDefault: "CAST('f' AS BOOLEAN)", columnName: 'has_unassessed_list_mode', isNullable: 'NO'},
    ])
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-1',
        hasBothListMode: true,
        hasHumanListMode: false,
        hasLlmListMode: true,
        hasUnassessedListMode: false,
      },
      {
        articleId: 'article-2',
        hasBothListMode: false,
        hasHumanListMode: true,
        hasLlmListMode: false,
        hasUnassessedListMode: true,
      },
      {
        articleId: 'article-3',
        hasBothListMode: false,
        hasHumanListMode: false,
        hasLlmListMode: false,
        hasUnassessedListMode: false,
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops review-serving list-mode key arrays after preserving membership flags', async () => {
  const duckdbPath = `/tmp/forska-review-list-mode-keys-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0199_dropReviewArticleServingListModeKeys.sql'
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
          CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            list_mode_keys VARCHAR[] NOT NULL,
            has_llm_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
            has_human_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
            has_both_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
            has_unassessed_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
            llm_patch_watermark BIGINT,
            human_patch_watermark BIGINT,
            both_patch_watermark BIGINT,
            unassessed_patch_watermark BIGINT,
            duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
            conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
            llm_status VARCHAR,
            human_status VARCHAR,
            llm_has_judgment BOOLEAN NOT NULL DEFAULT FALSE
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_list_mode_state_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            article_id,
            list_mode_keys,
            has_llm_list_mode,
            has_human_list_mode,
            has_both_list_mode,
            has_unassessed_list_mode,
            llm_patch_watermark,
            human_patch_watermark,
            both_patch_watermark,
            unassessed_patch_watermark,
            duplicate_flag,
            conflict_flag,
            llm_status,
            human_status,
            llm_has_judgment
          )
          VALUES
            ('project-1', 'review-config-1', 'snapshot-1', 'article-1', ['llm', 'both'], TRUE, FALSE, TRUE, FALSE, 11, 12, 13, 14, TRUE, FALSE, 'answered', NULL, TRUE),
            ('project-1', 'review-config-1', 'snapshot-1', 'article-2', ['human', 'unassessed'], FALSE, TRUE, FALSE, TRUE, NULL, 22, NULL, 24, FALSE, TRUE, NULL, 'unanswered', FALSE)
        \`)

        await migrateDuckdb()
        await database.run("DELETE FROM app_schema_migration WHERE name = '0199_dropReviewArticleServingListModeKeys.sql'")
        await migrateDuckdb()

        await database.run(\`
          INSERT INTO mart.review_article_serving_list_mode_state_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            article_id,
            has_llm_list_mode,
            has_human_list_mode,
            has_both_list_mode,
            has_unassessed_list_mode
          )
          VALUES ('project-1', 'review-config-1', 'snapshot-1', 'article-3', FALSE, FALSE, FALSE, FALSE)
        \`)

        const columns = await database.queryJson(\`
          SELECT
            column_name AS columnName,
            is_nullable AS isNullable,
            column_default AS columnDefault
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_list_mode_state_v4'
          ORDER BY ordinal_position
        \`)
        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            has_llm_list_mode AS hasLlmListMode,
            has_human_list_mode AS hasHumanListMode,
            has_both_list_mode AS hasBothListMode,
            has_unassessed_list_mode AS hasUnassessedListMode,
            llm_patch_watermark AS llmPatchWatermark,
            human_patch_watermark AS humanPatchWatermark,
            both_patch_watermark AS bothPatchWatermark,
            unassessed_patch_watermark AS unassessedPatchWatermark,
            duplicate_flag AS duplicateFlag,
            conflict_flag AS conflictFlag,
            llm_status AS llmStatus,
            human_status AS humanStatus,
            llm_has_judgment AS llmHasJudgment
          FROM mart.review_article_serving_list_mode_state_v4
          ORDER BY article_id
        \`)
        const indexRows = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE index_name = 'idx_review_article_serving_list_mode_state_v4_pk'
        \`)

        console.log(JSON.stringify({columns, indexRows, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39997',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39998',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify list-mode keys drop migration',
      )
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      columns: Array<{columnDefault: string | null; columnName: string; isNullable: string}>
      indexRows: Array<{indexName: string}>
      rows: Array<{
        articleId: string
        bothPatchWatermark: string | null
        conflictFlag: boolean
        duplicateFlag: boolean
        hasBothListMode: boolean
        hasHumanListMode: boolean
        hasLlmListMode: boolean
        hasUnassessedListMode: boolean
        humanPatchWatermark: string | null
        humanStatus: string | null
        llmHasJudgment: boolean
        llmPatchWatermark: string | null
        llmStatus: string | null
        unassessedPatchWatermark: string | null
      }>
    }

    expect(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    ).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'article_id',
      'has_llm_list_mode',
      'has_human_list_mode',
      'has_both_list_mode',
      'has_unassessed_list_mode',
      'llm_patch_watermark',
      'human_patch_watermark',
      'both_patch_watermark',
      'unassessed_patch_watermark',
      'duplicate_flag',
      'conflict_flag',
      'llm_status',
      'human_status',
      'llm_has_judgment',
    ])
    expect(parsed.columns).not.toContainEqual(expect.objectContaining({columnName: 'list_mode_keys'}))
    expect(parsed.indexRows).toEqual([{indexName: 'idx_review_article_serving_list_mode_state_v4_pk'}])
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-1',
        bothPatchWatermark: '13',
        conflictFlag: false,
        duplicateFlag: true,
        hasBothListMode: true,
        hasHumanListMode: false,
        hasLlmListMode: true,
        hasUnassessedListMode: false,
        humanPatchWatermark: '12',
        humanStatus: null,
        llmHasJudgment: true,
        llmPatchWatermark: '11',
        llmStatus: 'answered',
        unassessedPatchWatermark: '14',
      },
      {
        articleId: 'article-2',
        bothPatchWatermark: null,
        conflictFlag: true,
        duplicateFlag: false,
        hasBothListMode: false,
        hasHumanListMode: true,
        hasLlmListMode: false,
        hasUnassessedListMode: true,
        humanPatchWatermark: '22',
        humanStatus: 'unanswered',
        llmHasJudgment: false,
        llmPatchWatermark: null,
        llmStatus: null,
        unassessedPatchWatermark: '24',
      },
      {
        articleId: 'article-3',
        bothPatchWatermark: null,
        conflictFlag: false,
        duplicateFlag: false,
        hasBothListMode: false,
        hasHumanListMode: false,
        hasLlmListMode: false,
        hasUnassessedListMode: false,
        humanPatchWatermark: null,
        humanStatus: null,
        llmHasJudgment: false,
        llmPatchWatermark: null,
        llmStatus: null,
        unassessedPatchWatermark: null,
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
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
  const reviewTitleSearchTokenPostingSlimSql = readFileSync(
    resolve(migrationsFolder, '0179_slimReviewTitleSearchTokenPostings.sql'),
    'utf8',
  ).trim()
  const reviewTitleSearchTokenLookupIndexDropSql = readFileSync(
    resolve(migrationsFolder, '0188_dropReviewTitleSearchTokenLookupIndex.sql'),
    'utf8',
  ).trim()
  const reviewFilterPostingStatsDerivedColumnDropSql = readFileSync(
    resolve(migrationsFolder, '0129_dropReviewFilterPostingStatsDerivedColumns.sql'),
    'utf8',
  ).trim()
  const reviewFilterPostingStatsDropSql = readFileSync(
    resolve(migrationsFolder, '0147_dropReviewFilterPostingStats.sql'),
    'utf8',
  ).trim()
  const reviewFilterOptionPayloadJsonDropSql = readFileSync(
    resolve(migrationsFolder, '0130_dropReviewFilterOptionPayloadJson.sql'),
    'utf8',
  ).trim()
  const reviewFilterOptionLookupIndexDropSql = readFileSync(
    resolve(migrationsFolder, '0189_dropReviewFilterOptionLookupIndex.sql'),
    'utf8',
  ).trim()
  const reviewFilteredCountLookupIndexDropSql = readFileSync(
    resolve(migrationsFolder, '0190_dropReviewFilteredCountLookupIndex.sql'),
    'utf8',
  ).trim()
  const reviewFilteredCountComponentBreakoutDropSql = readFileSync(
    resolve(migrationsFolder, '0194_dropReviewFilteredCountComponentBreakoutColumns.sql'),
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
  const reviewFilterPostingServingSortKeyDropSql = readFileSync(
    resolve(migrationsFolder, '0162_dropReviewFilterPostingServingSortKey.sql'),
    'utf8',
  ).trim()
  const reviewFilterPostingServingLookupIndexDropSql = readFileSync(
    resolve(migrationsFolder, '0185_dropReviewFilterPostingLookupIndex.sql'),
    'utf8',
  ).trim()
  const reviewArticleServingDisplayCopyDropSql = readFileSync(
    resolve(migrationsFolder, '0163_dropReviewArticleServingDisplayCopies.sql'),
    'utf8',
  ).trim()
  const reviewPayloadDisplayRehydrationSql = readFileSync(
    resolve(migrationsFolder, '0164_rehydrateReviewPayloadDisplayColumns.sql'),
    'utf8',
  ).trim()
  const reviewPayloadDisplayStorageDropSql = readFileSync(
    resolve(migrationsFolder, '0173_dropReviewPayloadDisplayStorage.sql'),
    'utf8',
  ).trim()
  const reviewPayloadAbstractTextDropSql = readFileSync(
    resolve(migrationsFolder, '0165_dropReviewPayloadAbstractText.sql'),
    'utf8',
  ).trim()
  const reviewArticleServingPublicationYearDropSql = readFileSync(
    resolve(migrationsFolder, '0166_dropReviewArticleServingPublicationYear.sql'),
    'utf8',
  ).trim()
  const reviewArticleServingSelectedFlagCopyDropSql = readFileSync(
    resolve(migrationsFolder, '0167_dropReviewArticleServingSelectedFlagCopies.sql'),
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
  const reviewProjectImportDeltaCursorDropSql = readFileSync(
    resolve(migrationsFolder, '0144_dropReviewProjectImportDeltaCursor.sql'),
    'utf8',
  ).trim()
  const manualPr122ChunkManifestArtifactDropSql = readFileSync(
    resolve(migrationsFolder, '0145_dropManualPr122ChunkManifestArtifact.sql'),
    'utf8',
  ).trim()
  const reviewServingPayloadDisplayFieldsSql = readFileSync(
    resolve(migrationsFolder, '0146_reviewServingPayloadDisplayFields.sql'),
    'utf8',
  ).trim()
  const reviewPayloadDisplayCopyColumnDropSql = readFileSync(
    resolve(migrationsFolder, '0149_dropReviewPayloadDisplayCopyColumns.sql'),
    'utf8',
  ).trim()
  const reviewProjectorWatermarkLifecyclePlaceholderDropSql = readFileSync(
    resolve(migrationsFolder, '0150_dropReviewServingProjectorWatermarkLifecyclePlaceholders.sql'),
    'utf8',
  ).trim()
  const reviewPayloadServingCoverageBackfillSql = readFileSync(
    resolve(migrationsFolder, '0151_backfillReviewPayloadServingCoverage.sql'),
    'utf8',
  ).trim()
  const reviewArticleServingFullTextCopyDropSql = readFileSync(
    resolve(migrationsFolder, '0152_dropReviewArticleServingFullTextCopies.sql'),
    'utf8',
  ).trim()
  const reviewPayloadServingUpdatedAtDropSql = readFileSync(
    resolve(migrationsFolder, '0153_dropReviewPayloadServingUpdatedAt.sql'),
    'utf8',
  ).trim()
  const reviewImportHotFieldProvenanceDebugColumnDropSql = readFileSync(
    resolve(migrationsFolder, '0154_dropReviewImportHotFieldProvenanceDebugColumns.sql'),
    'utf8',
  ).trim()
  const reviewPayloadServingArticleCreatedAtDropSql = readFileSync(
    resolve(migrationsFolder, '0155_dropReviewPayloadServingArticleCreatedAt.sql'),
    'utf8',
  ).trim()
  const reviewPayloadServingFullTextPreviewDropSql = readFileSync(
    resolve(migrationsFolder, '0156_dropReviewPayloadFullTextPreview.sql'),
    'utf8',
  ).trim()
  const reviewSummaryContributionPartialJsonKeyDropSql = readFileSync(
    resolve(migrationsFolder, '0157_dropReviewSummaryContributionPartialJsonKey.sql'),
    'utf8',
  ).trim()
  const reviewSummaryContributionRebuildPartialDropSql = readFileSync(
    resolve(migrationsFolder, '0176_dropReviewSummaryContributionRebuildPartial.sql'),
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
  const reviewSummaryOptionUpdatedAtDropSql = readFileSync(
    resolve(migrationsFolder, '0192_dropReviewSummaryOptionUpdatedAt.sql'),
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
  expect(reviewTitleSearchTokenPostingSlimSql).toContain('LIST(DISTINCT article_id ORDER BY article_id) AS article_ids')
  expect(reviewTitleSearchTokenPostingSlimSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_title_search_serving_v4_repaired_pk',
  )
  expect(reviewTitleSearchTokenPostingSlimSql).not.toContain('PRIMARY KEY')
  expect(reviewTitleSearchTokenPostingSlimSql).not.toContain('token, article_id)')
  expect(reviewTitleSearchTokenLookupIndexDropSql).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_title_search_serving_v4_token;',
      'DROP INDEX IF EXISTS idx_review_title_search_serving_v4_token;',
    ].join('\n'),
  )
  expect(reviewFilterPostingStatsDerivedColumnDropSql).toBe(
    [
      '-- Retired by 0147_dropReviewFilterPostingStats.sql.',
      '-- Filter-posting stats are no longer materialized, so the old derived-column',
      '-- repair is intentionally skipped for fresh databases.',
    ].join('\n'),
  )
  expect(reviewFilterPostingStatsDerivedColumnDropSql).not.toContain('PRIMARY KEY')
  expect(reviewFilterPostingStatsDerivedColumnDropSql).not.toContain('selectivity')
  expect(reviewFilterPostingStatsDerivedColumnDropSql).not.toContain('posting_identity')
  expect(reviewFilterPostingStatsDropSql).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_filter_posting_stats_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_filter_posting_stats_v4_lookup;',
      'DROP INDEX IF EXISTS mart.idx_review_filter_posting_stats_v4_repaired_pk;',
      'DROP INDEX IF EXISTS idx_review_filter_posting_stats_v4_repaired_pk;',
      'DROP TABLE IF EXISTS mart.review_filter_posting_stats_v4;',
    ].join('\n'),
  )
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
  expect(reviewSummaryOptionUpdatedAtDropSql).toContain('CREATE TABLE mart.review_article_count_serving_v4_repair')
  expect(reviewSummaryOptionUpdatedAtDropSql).toContain('CREATE TABLE mart.review_filter_facet_serving_v4_repair')
  expect(reviewSummaryOptionUpdatedAtDropSql).toContain('CREATE TABLE mart.review_filter_option_serving_v4_repair')
  expect(reviewSummaryOptionUpdatedAtDropSql).toContain("column_name != 'count_updated_at'")
  expect(reviewSummaryOptionUpdatedAtDropSql).toContain("column_name != 'facet_updated_at'")
  expect(reviewSummaryOptionUpdatedAtDropSql).toContain("column_name != 'option_updated_at'")
  expect(reviewSummaryOptionUpdatedAtDropSql).not.toContain('count_updated_at TIMESTAMPTZ')
  expect(reviewSummaryOptionUpdatedAtDropSql).not.toContain('facet_updated_at TIMESTAMPTZ')
  expect(reviewSummaryOptionUpdatedAtDropSql).not.toContain('option_updated_at TIMESTAMPTZ')
  expect(reviewFilterOptionLookupIndexDropSql).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_filter_option_serving_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_filter_option_serving_v4_lookup;',
    ].join('\n'),
  )
  expect(reviewFilteredCountLookupIndexDropSql).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_filtered_count_serving_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_filtered_count_serving_v4_lookup;',
    ].join('\n'),
  )
  expect(reviewFilteredCountComponentBreakoutDropSql).toContain(
    'CREATE TABLE mart.review_filtered_count_serving_v4_repair',
  )
  expect(reviewFilteredCountComponentBreakoutDropSql).toContain('count_updated_at TIMESTAMPTZ')
  expect(reviewFilteredCountComponentBreakoutDropSql).not.toContain('project_scope_identity VARCHAR')
  expect(reviewFilteredCountComponentBreakoutDropSql).not.toContain('search_identity VARCHAR')
  expect(reviewFilteredCountComponentBreakoutDropSql).not.toContain('posting_identity VARCHAR')
  expect(reviewFilteredCountComponentBreakoutDropSql).not.toContain('queue_identity VARCHAR')
  expect(reviewFilteredCountComponentBreakoutDropSql).not.toContain('payload_identity VARCHAR')
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
  expect(reviewArticleServingSelectedRankCopyDropSql).not.toContain('publication_year INTEGER')
  expect(reviewArticleServingSelectedRankCopyDropSql).not.toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_serving_v4_publication_year',
  )
  expect(reviewPayloadBytesDropSql).toContain('CREATE TABLE mart.review_article_serving_payload_v4_repair')
  expect(reviewPayloadBytesDropSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadBytesDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadBytesDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk',
  )
  expect(reviewPayloadBytesDropSql).toContain('CREATE TABLE IF NOT EXISTS mart.review_article_serving_payload_v4')
  expect(reviewPayloadBytesDropSql).not.toContain('PRIMARY KEY')
  expect(reviewPayloadBytesDropSql).not.toContain('payload_bytes')
  expect(reviewPayloadAbstractTextDropSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_abstract_text_repair',
  )
  expect(reviewPayloadAbstractTextDropSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadAbstractTextDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_abstract_text_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadAbstractTextDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk',
  )
  expect(reviewPayloadAbstractTextDropSql).not.toContain('PRIMARY KEY')
  expect(reviewPayloadAbstractTextDropSql).not.toContain('abstract_text VARCHAR')
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
  expect(reviewFilterPostingServingIdentityDropSql).not.toContain('sort_key TIMESTAMPTZ')
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
  expect(reviewFilterPostingServingUpdatedAtDropSql).not.toContain('sort_key TIMESTAMPTZ')
  expect(reviewFilterPostingServingSortKeyDropSql).toContain(
    'CREATE TABLE mart.review_article_filter_posting_serving_v4_repair',
  )
  expect(reviewFilterPostingServingSortKeyDropSql).toContain(
    'DROP TABLE mart.review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingSortKeyDropSql).toContain(
    'ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingSortKeyDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_repaired_pk',
  )
  expect(reviewFilterPostingServingSortKeyDropSql).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_lookup',
  )
  expect(reviewFilterPostingServingLookupIndexDropSql).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_article_filter_posting_serving_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_article_filter_posting_serving_v4_lookup;',
    ].join('\n'),
  )
  expect(reviewFilterPostingServingSortKeyDropSql).not.toContain('PRIMARY KEY')
  expect(reviewFilterPostingServingSortKeyDropSql).not.toContain('sort_key TIMESTAMPTZ')
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
  expect(reviewProjectImportDeltaCursorDropSql).toBe(
    [
      'DROP INDEX IF EXISTS app.idx_review_project_import_delta_cursor_route;',
      'DROP INDEX IF EXISTS idx_review_project_import_delta_cursor_route;',
      'DROP TABLE IF EXISTS app.review_project_import_delta_cursor;',
    ].join('\n'),
  )
  expect(manualPr122ChunkManifestArtifactDropSql).toBe(
    'DROP TABLE IF EXISTS app.review_rebuild_chunk_manifest_manual_pr122_1783542053396;',
  )
  expect(reviewServingPayloadDisplayFieldsSql).toContain('Retired by 0149_dropReviewPayloadDisplayCopyColumns.sql')
  expect(reviewServingPayloadDisplayFieldsSql).not.toContain('CREATE TABLE')
  expect(reviewServingPayloadDisplayFieldsSql).not.toContain('ALTER TABLE')
  expect(reviewServingPayloadDisplayFieldsSql).not.toContain('DROP TABLE')
  expect(reviewPayloadDisplayCopyColumnDropSql).toContain('CREATE TABLE mart.review_article_serving_payload_v4_repair')
  expect(reviewPayloadDisplayCopyColumnDropSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadDisplayCopyColumnDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadDisplayCopyColumnDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk',
  )
  expect(reviewPayloadDisplayCopyColumnDropSql).not.toContain('PRIMARY KEY')
  expect(reviewPayloadDisplayCopyColumnDropSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadDisplayCopyColumnDropSql).not.toContain('article_external_id VARCHAR')
  expect(reviewPayloadDisplayCopyColumnDropSql).not.toContain('full_text_pdf')
  expect(reviewPayloadDisplayRehydrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_display_repair',
  )
  expect(reviewPayloadDisplayRehydrationSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadDisplayRehydrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_display_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadDisplayRehydrationSql).not.toContain('selected_import_snapshot_id')
  expect(reviewPayloadDisplayRehydrationSql).not.toContain('selected_hot.article_title')
  expect(reviewPayloadDisplayRehydrationSql).not.toContain('json_extract_string(selected_source.raw_payload')
  expect(reviewPayloadDisplayRehydrationSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadDisplayRehydrationSql).not.toContain('UPDATE mart.review_article_serving_payload_v4')
  expect(reviewPayloadDisplayStorageDropSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_display_storage_repair',
  )
  expect(reviewPayloadDisplayStorageDropSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadDisplayStorageDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_display_storage_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadDisplayStorageDropSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadDisplayStorageDropSql).not.toContain('article_external_id VARCHAR')
  expect(reviewPayloadServingCoverageBackfillSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_coverage_repair',
  )
  expect(reviewPayloadServingCoverageBackfillSql).toContain('FROM mart.review_article_serving_v4 serving')
  expect(reviewPayloadServingCoverageBackfillSql).toContain('FROM app.review_serving_snapshot_manifest manifest')
  expect(reviewPayloadServingCoverageBackfillSql).toContain(
    "json_extract_string(component_state.value, '$.projectionIdentity')",
  )
  expect(reviewPayloadServingCoverageBackfillSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadServingCoverageBackfillSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_coverage_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadServingCoverageBackfillSql).not.toContain('ADD COLUMN')
  expect(reviewPayloadServingCoverageBackfillSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadServingCoverageBackfillSql).not.toContain('full_text_pdf')
  expect(reviewArticleServingFullTextCopyDropSql).toContain('CREATE TABLE mart.review_article_serving_v4_repair')
  expect(reviewArticleServingFullTextCopyDropSql).toContain('DROP TABLE mart.review_article_serving_v4;')
  expect(reviewArticleServingFullTextCopyDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingFullTextCopyDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_v4_repaired_pk',
  )
  expect(reviewArticleServingFullTextCopyDropSql).not.toContain('PRIMARY KEY')
  expect(reviewArticleServingFullTextCopyDropSql).not.toContain('full_text_pdf')
  expect(reviewArticleServingFullTextCopyDropSql).not.toContain('full_text_fetched_at')
  expect(reviewArticleServingFullTextCopyDropSql).not.toContain('full_text_conversion_status')
  expect(reviewArticleServingFullTextCopyDropSql).not.toContain('publication_year INTEGER')
  expect(reviewArticleServingFullTextCopyDropSql).not.toContain('selected_import_route_id')
  expect(reviewArticleServingDisplayCopyDropSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_display_copy_repair',
  )
  expect(reviewArticleServingDisplayCopyDropSql).toContain('DROP TABLE mart.review_article_serving_v4;')
  expect(reviewArticleServingDisplayCopyDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_display_copy_repair RENAME TO review_article_serving_v4;',
  )
  const articleServingDisplayCopyRepairSql = reviewArticleServingDisplayCopyDropSql.slice(
    reviewArticleServingDisplayCopyDropSql.indexOf('CREATE TABLE mart.review_article_serving_v4_display_copy_repair'),
  )
  expect(articleServingDisplayCopyRepairSql).not.toContain('article_title VARCHAR')
  expect(articleServingDisplayCopyRepairSql).not.toContain('article_external_id VARCHAR')
  expect(articleServingDisplayCopyRepairSql).not.toContain('journal_title VARCHAR')
  expect(articleServingDisplayCopyRepairSql).not.toContain('publication_year INTEGER')
  expect(reviewArticleServingDisplayCopyDropSql).not.toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_serving_v4_publication_year',
  )
  expect(reviewArticleServingPublicationYearDropSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_publication_year_repair',
  )
  expect(reviewArticleServingPublicationYearDropSql).toContain('DROP TABLE mart.review_article_serving_v4;')
  expect(reviewArticleServingPublicationYearDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_publication_year_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingPublicationYearDropSql).not.toContain('publication_year INTEGER')
  expect(reviewArticleServingPublicationYearDropSql).not.toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_serving_v4_publication_year',
  )
  expect(reviewArticleServingSelectedFlagCopyDropSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_selected_flag_repair',
  )
  expect(reviewArticleServingSelectedFlagCopyDropSql).toContain('DROP TABLE mart.review_article_serving_v4;')
  expect(reviewArticleServingSelectedFlagCopyDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_selected_flag_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingSelectedFlagCopyDropSql).not.toContain('duplicate_flag')
  expect(reviewArticleServingSelectedFlagCopyDropSql).not.toContain('conflict_flag')
  expect(reviewPayloadServingUpdatedAtDropSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_updated_at_repair',
  )
  expect(reviewPayloadServingUpdatedAtDropSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadServingUpdatedAtDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_updated_at_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadServingUpdatedAtDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk',
  )
  expect(reviewPayloadServingUpdatedAtDropSql).not.toContain('payload_updated_at')
  expect(reviewPayloadServingArticleCreatedAtDropSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_article_created_at_repair',
  )
  expect(reviewPayloadServingArticleCreatedAtDropSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadServingArticleCreatedAtDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_article_created_at_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadServingArticleCreatedAtDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk',
  )
  expect(reviewPayloadServingArticleCreatedAtDropSql).not.toContain('article_created_at TIMESTAMPTZ')
  expect(reviewPayloadServingArticleCreatedAtDropSql).not.toContain(
    'idx_review_article_serving_payload_v4_preview_order',
  )
  expect(reviewPayloadServingFullTextPreviewDropSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_full_text_preview_repair',
  )
  expect(reviewPayloadServingFullTextPreviewDropSql).toContain('DROP TABLE mart.review_article_serving_payload_v4;')
  expect(reviewPayloadServingFullTextPreviewDropSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_full_text_preview_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadServingFullTextPreviewDropSql).not.toContain('abstract_text VARCHAR')
  expect(reviewPayloadServingFullTextPreviewDropSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadServingFullTextPreviewDropSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk',
  )
  expect(reviewPayloadServingFullTextPreviewDropSql).not.toContain('full_text_preview VARCHAR')
  expect(reviewSummaryContributionPartialJsonKeyDropSql).toContain(
    'CREATE TABLE mart.review_article_summary_contribution_rebuild_partial_v4_key_repair',
  )
  expect(reviewSummaryContributionPartialJsonKeyDropSql).toContain(
    "json_extract_string(contribution_key, '$.summaryIdentity') AS summary_identity",
  )
  expect(reviewSummaryContributionPartialJsonKeyDropSql).toContain(
    'ALTER TABLE mart.review_article_summary_contribution_rebuild_partial_v4_key_repair RENAME TO review_article_summary_contribution_rebuild_partial_v4;',
  )
  expect(reviewSummaryContributionPartialJsonKeyDropSql).not.toContain('contribution_key VARCHAR')
  expect(reviewSummaryContributionRebuildPartialDropSql).toContain(
    'DROP TABLE IF EXISTS mart.review_article_summary_contribution_rebuild_partial_v4;',
  )
  expect(reviewSummaryContributionRebuildPartialDropSql).toContain(
    "CHECK (partial_table IN ('mart.review_article_summary_rebuild_partial_v4'))",
  )
  expect(reviewSummaryContributionRebuildPartialDropSql).not.toContain(
    "partial_table IN ('mart.review_article_summary_contribution_rebuild_partial_v4'",
  )
  expect(reviewImportHotFieldProvenanceDebugColumnDropSql).toContain(
    'CREATE TABLE app.review_import_article_hot_field_repair',
  )
  expect(reviewImportHotFieldProvenanceDebugColumnDropSql).toContain('DROP TABLE app.review_import_article_hot_field;')
  expect(reviewImportHotFieldProvenanceDebugColumnDropSql).toContain(
    'ALTER TABLE app.review_import_article_hot_field_repair RENAME TO review_import_article_hot_field;',
  )
  expect(reviewImportHotFieldProvenanceDebugColumnDropSql).not.toContain('DROP COLUMN')
  expect(reviewProjectorWatermarkLifecyclePlaceholderDropSql).toContain(
    'CREATE TABLE app.review_serving_projector_watermark_repair',
  )
  expect(reviewProjectorWatermarkLifecyclePlaceholderDropSql).toContain(
    'DROP TABLE app.review_serving_projector_watermark;',
  )
  expect(reviewProjectorWatermarkLifecyclePlaceholderDropSql).not.toContain('snapshot_id')
  expect(reviewProjectorWatermarkLifecyclePlaceholderDropSql).not.toContain('lease_owner')
  expect(reviewProjectorWatermarkLifecyclePlaceholderDropSql).not.toContain('cursor_json')
  expect(reviewProjectorWatermarkLifecyclePlaceholderDropSql).not.toContain('last_error')
})

test('DuckDB migration drops filtered count component breakout columns while preserving legacy rows', async () => {
  const duckdbPath = `/tmp/forska-review-filtered-count-breakout-${Date.now()}.duckdb`
  const targetMigrationFile = '0194_dropReviewFilteredCountComponentBreakoutColumns.sql'
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {withDuckdbMaintenanceAccess}, {resetDuckdbServiceForTests, getMaintenanceDuckdbWorkloadContext}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbScriptAccess.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const workloadContext = getMaintenanceDuckdbWorkloadContext('filtered-count-breakout-test')
        const database = getAppDatabaseService()
        await withDuckdbMaintenanceAccess('filtered count breakout migration test', async () => {
          await database.run('CREATE SCHEMA IF NOT EXISTS app', workloadContext)
          await database.run('CREATE SCHEMA IF NOT EXISTS mart', workloadContext)
          await database.run(
            'CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
            workloadContext
          )
          await database.run(
            "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
              .map((fileName) => {
                return `('${fileName.replaceAll("'", "''")}')`
              })
              .join(', ')}",
            workloadContext
          )
          await database.run(\`
            CREATE TABLE mart.review_filtered_count_serving_v4 (
              project_id VARCHAR NOT NULL,
              review_config_hash VARCHAR NOT NULL,
              snapshot_id VARCHAR NOT NULL,
              list_mode_key VARCHAR NOT NULL,
              filter_signature VARCHAR NOT NULL,
              component_identity VARCHAR NOT NULL,
              project_scope_identity VARCHAR NOT NULL DEFAULT '',
              search_identity VARCHAR NOT NULL DEFAULT '',
              posting_identity VARCHAR NOT NULL DEFAULT '',
              queue_identity VARCHAR NOT NULL DEFAULT '',
              payload_identity VARCHAR NOT NULL DEFAULT '',
              count_value BIGINT NOT NULL,
              count_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
            )
          \`, workloadContext)
          await database.run(\`
            CREATE UNIQUE INDEX idx_review_filtered_count_serving_v4_repaired_pk
            ON mart.review_filtered_count_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, filter_signature, component_identity)
          \`, workloadContext)
          await database.run(\`
            CREATE INDEX idx_review_filtered_count_serving_v4_lookup
            ON mart.review_filtered_count_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, filter_signature)
          \`, workloadContext)
          await database.run(\`
            INSERT INTO mart.review_filtered_count_serving_v4 (
              project_id,
              review_config_hash,
              snapshot_id,
              list_mode_key,
              filter_signature,
              component_identity,
              project_scope_identity,
              search_identity,
              posting_identity,
              queue_identity,
              payload_identity,
              count_value,
              count_updated_at
            )
            VALUES (
              'project-a',
              'config-a',
              'snapshot-a',
              'llm',
              'filter-a',
              'component-a',
              'project-scope-a',
              'search-a',
              'posting-a',
              'queue-a',
              'payload-a',
              42,
              TIMESTAMPTZ '2026-07-25T07:01:00Z'
            )
          \`, workloadContext)

          await migrateDuckdb()

          const columns = await database.queryJson(
            "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_filtered_count_serving_v4' ORDER BY ordinal_position",
            workloadContext
          )
          const indexes = await database.queryJson(
            "SELECT index_name AS indexName FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_filtered_count_serving_v4' ORDER BY index_name",
            workloadContext
          )
          const migrationRows = await database.queryJson(
            "SELECT name FROM app_schema_migration WHERE name = '${targetMigrationFile}'",
            workloadContext
          )
          const rows = await database.queryJson(
            "SELECT project_id AS projectId, review_config_hash AS reviewConfigHash, snapshot_id AS snapshotId, list_mode_key AS listModeKey, filter_signature AS filterSignature, component_identity AS componentIdentity, CAST(count_value AS INTEGER) AS countValue, CAST(epoch(count_updated_at) AS INTEGER) AS countUpdatedAtEpoch FROM mart.review_filtered_count_serving_v4",
            workloadContext
          )

          console.log(JSON.stringify({columns, indexes, migrationRows, rows}))
        })
      `,
    ],
    {
      cwd: resolve(import.meta.dir, '../..'),
      env: {...process.env, DUCKDB_PATH: duckdbPath, FORSKA_DB_PATH: duckdbPath, NODE_ENV: 'test'},
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )

  removeFileIfExists(duckdbPath)
  removeFileIfExists(`${duckdbPath}.wal`)
  removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
  removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString() || result.stdout.toString() || 'Failed to migrate filtered count breakout columns',
    )
  }

  const output = result.stdout.toString()
  const parsedLine = output.split('\n').find((line) => {
    return line.startsWith('{"columns"')
  })

  expect(parsedLine).toBeDefined()

  const parsed = JSON.parse(parsedLine ?? '{}') as {
    columns: {columnName: string}[]
    indexes: {indexName: string}[]
    migrationRows: {name: string}[]
    rows: Array<Record<string, unknown>>
  }
  const columns = parsed.columns.map((column) => {
    return column.columnName
  })
  const indexes = parsed.indexes.map((index) => {
    return index.indexName
  })

  expect(columns).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'list_mode_key',
    'filter_signature',
    'component_identity',
    'count_value',
    'count_updated_at',
  ])
  expect(columns).not.toContain('project_scope_identity')
  expect(columns).not.toContain('search_identity')
  expect(columns).not.toContain('posting_identity')
  expect(columns).not.toContain('queue_identity')
  expect(columns).not.toContain('payload_identity')
  expect(indexes).toEqual(['idx_review_filtered_count_serving_v4_repaired_pk'])
  expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  expect(parsed.rows).toEqual([
    {
      componentIdentity: 'component-a',
      countUpdatedAtEpoch: 1784962860,
      countValue: 42,
      filterSignature: 'filter-a',
      listModeKey: 'llm',
      projectId: 'project-a',
      reviewConfigHash: 'config-a',
      snapshotId: 'snapshot-a',
    },
  ])
})

test('DuckDB migration drops review filter posting serving sort key while preserving rows', async () => {
  const duckdbPath = `/tmp/forska-review-filter-posting-sort-key-${Date.now()}.duckdb`
  const targetMigrationFile = '0162_dropReviewFilterPostingServingSortKey.sql'
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {withDuckdbMaintenanceAccess}, {getMaintenanceDuckdbWorkloadContext, resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbScriptAccess.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        const workloadContext = getMaintenanceDuckdbWorkloadContext('migrateDuckdb.test.filterPostingSortKey')
        await withDuckdbMaintenanceAccess('filter posting sort-key migration test', async () => {
          await database.run('CREATE SCHEMA IF NOT EXISTS mart', workloadContext)
          await database.run(
            "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
            workloadContext
          )
          await database.run(
            "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
              .map((fileName) => {
                return `('${fileName.replaceAll("'", "''")}')`
              })
              .join(', ')}",
            workloadContext
          )
          await database.run(\`
            CREATE TABLE mart.review_article_filter_posting_serving_v4 (
              project_id VARCHAR NOT NULL,
              review_config_hash VARCHAR NOT NULL,
              snapshot_id VARCHAR NOT NULL,
              filter_kind VARCHAR NOT NULL,
              filter_value VARCHAR NOT NULL,
              list_mode_key VARCHAR NOT NULL,
              sort_key TIMESTAMPTZ NOT NULL,
              article_id VARCHAR NOT NULL
            )
          \`, workloadContext)
          await database.run(\`
            CREATE INDEX idx_review_article_filter_posting_serving_v4_lookup
            ON mart.review_article_filter_posting_serving_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, sort_key, article_id)
          \`, workloadContext)
          await database.run(\`
            INSERT INTO mart.review_article_filter_posting_serving_v4
            VALUES ('project-1', 'review-config-1', 'snapshot-1', 'promptAnswer', 'yes', 'llm', TIMESTAMPTZ '2026-01-01T00:00:00Z', 'article-1')
          \`, workloadContext)

          await migrateDuckdb()

          const columns = await database.queryJson(
            "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_article_filter_posting_serving_v4' ORDER BY ordinal_position",
            workloadContext
          )
          const indexes = await database.queryJson(
            "SELECT index_name AS indexName FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_article_filter_posting_serving_v4' ORDER BY index_name",
            workloadContext
          )
          const migrationRows = await database.queryJson(
            "SELECT name FROM app_schema_migration WHERE name = '${targetMigrationFile}'",
            workloadContext
          )
          const rows = await database.queryJson(
            'SELECT * FROM mart.review_article_filter_posting_serving_v4 ORDER BY article_id',
            workloadContext
          )

          console.log(JSON.stringify({columns, indexes, migrationRows, rows}))
        })
      `,
    ],
    {
      cwd: resolve(import.meta.dir, '../..'),
      env: {...process.env, DUCKDB_PATH: duckdbPath, FORSKA_DB_PATH: duckdbPath, NODE_ENV: 'test'},
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )

  removeFileIfExists(duckdbPath)
  removeFileIfExists(`${duckdbPath}.wal`)

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to migrate filter posting sort key')
  }

  const output = result.stdout.toString()
  const parsedLine = output.split('\n').find((line) => {
    return line.startsWith('{"columns"')
  })

  expect(parsedLine).toBeDefined()

  const parsed = JSON.parse(parsedLine ?? '{}') as {
    columns: {columnName: string}[]
    indexes: {indexName: string}[]
    migrationRows: {name: string}[]
    rows: Array<Record<string, unknown>>
  }
  const columns = parsed.columns.map((column) => {
    return column.columnName
  })
  const indexes = parsed.indexes.map((index) => {
    return index.indexName
  })

  expect(columns).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'filter_kind',
    'filter_value',
    'list_mode_key',
    'article_id',
  ])
  expect(indexes).toContain('idx_review_article_filter_posting_serving_v4_repaired_pk')
  expect(indexes).toContain('idx_review_article_filter_posting_serving_v4_lookup')
  expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  expect(parsed.rows).toEqual([
    {
      article_id: 'article-1',
      filter_kind: 'promptAnswer',
      filter_value: 'yes',
      list_mode_key: 'llm',
      project_id: 'project-1',
      review_config_hash: 'review-config-1',
      snapshot_id: 'snapshot-1',
    },
  ])
})

test('DuckDB migration compacts review filter posting serving article memberships', async () => {
  const duckdbPath = `/tmp/forska-review-filter-posting-compact-${Date.now()}.duckdb`
  const targetMigrationFile = '0181_compactReviewFilterPostingServing.sql'
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {withDuckdbMaintenanceAccess}, {getMaintenanceDuckdbWorkloadContext, resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbScriptAccess.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        const workloadContext = getMaintenanceDuckdbWorkloadContext('migrateDuckdb.test.filterPostingCompact')
        await withDuckdbMaintenanceAccess('filter posting compact migration test', async () => {
          await database.run('CREATE SCHEMA IF NOT EXISTS mart', workloadContext)
          await database.run(
            "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
            workloadContext
          )
          await database.run(
            "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
              .map((fileName) => {
                return `('${fileName.replaceAll("'", "''")}')`
              })
              .join(', ')}",
            workloadContext
          )
          await database.run(\`
            CREATE TABLE mart.review_article_filter_posting_serving_v4 (
              project_id VARCHAR NOT NULL,
              review_config_hash VARCHAR NOT NULL,
              snapshot_id VARCHAR NOT NULL,
              filter_kind VARCHAR NOT NULL,
              filter_value VARCHAR NOT NULL,
              list_mode_key VARCHAR NOT NULL,
              article_id VARCHAR NOT NULL
            )
          \`, workloadContext)
          await database.run(\`
            CREATE UNIQUE INDEX idx_review_article_filter_posting_serving_v4_repaired_pk
            ON mart.review_article_filter_posting_serving_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, article_id)
          \`, workloadContext)
          await database.run(\`
            CREATE INDEX idx_review_article_filter_posting_serving_v4_lookup
            ON mart.review_article_filter_posting_serving_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key, article_id)
          \`, workloadContext)
          await database.run(\`
            INSERT INTO mart.review_article_filter_posting_serving_v4
            VALUES
              ('project-1', 'review-config-1', 'snapshot-1', 'promptAnswer', 'yes', 'llm', 'article-2'),
              ('project-1', 'review-config-1', 'snapshot-1', 'promptAnswer', 'yes', 'llm', 'article-1'),
              ('project-1', 'review-config-1', 'snapshot-1', 'importRoute', 'route-1', 'llm', 'article-1')
          \`, workloadContext)

          await migrateDuckdb()

          const columns = await database.queryJson(
            "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_article_filter_posting_serving_v4' ORDER BY ordinal_position",
            workloadContext
          )
          const indexes = await database.queryJson(
            "SELECT index_name AS indexName FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_article_filter_posting_serving_v4' ORDER BY index_name",
            workloadContext
          )
          const migrationRows = await database.queryJson(
            "SELECT name FROM app_schema_migration WHERE name = '${targetMigrationFile}'",
            workloadContext
          )
          const rows = await database.queryJson(
            'SELECT filter_kind AS filterKind, filter_value AS filterValue, list_mode_key AS listModeKey, article_ids AS articleIds FROM mart.review_article_filter_posting_serving_v4 ORDER BY filter_kind, filter_value',
            workloadContext
          )

          console.log(JSON.stringify({columns, indexes, migrationRows, rows}))
        })
      `,
    ],
    {
      cwd: resolve(import.meta.dir, '../..'),
      env: {...process.env, DUCKDB_PATH: duckdbPath, FORSKA_DB_PATH: duckdbPath, NODE_ENV: 'test'},
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )

  removeFileIfExists(duckdbPath)
  removeFileIfExists(`${duckdbPath}.wal`)

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to compact filter postings')
  }

  const output = result.stdout.toString()
  const parsedLine = output.split('\n').find((line) => {
    return line.startsWith('{"columns"')
  })

  expect(parsedLine).toBeDefined()

  const parsed = JSON.parse(parsedLine ?? '{}') as {
    columns: {columnName: string}[]
    indexes: {indexName: string}[]
    migrationRows: {name: string}[]
    rows: Array<{articleIds: string[]; filterKind: string; filterValue: string; listModeKey: string}>
  }
  const columns = parsed.columns.map((column) => {
    return column.columnName
  })
  const indexes = parsed.indexes.map((index) => {
    return index.indexName
  })

  expect(columns).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'filter_kind',
    'filter_value',
    'list_mode_key',
    'article_ids',
  ])
  expect(indexes).toContain('idx_review_article_filter_posting_serving_v4_repaired_pk')
  expect(indexes).toContain('idx_review_article_filter_posting_serving_v4_lookup')
  expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  expect(parsed.rows).toEqual([
    {articleIds: ['article-1'], filterKind: 'importRoute', filterValue: 'route-1', listModeKey: 'llm'},
    {articleIds: ['article-1', 'article-2'], filterKind: 'promptAnswer', filterValue: 'yes', listModeKey: 'llm'},
  ])
})

test('DuckDB migration drops redundant review filter posting lookup index', async () => {
  const duckdbPath = `/tmp/forska-review-filter-posting-lookup-index-${Date.now()}.duckdb`
  const targetMigrationFile = '0185_dropReviewFilterPostingLookupIndex.sql'
  const appliedNames = getDuckdbMigrationFiles().filter((fileName) => {
    return fileName !== targetMigrationFile
  })
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {getAppDatabaseService}, {withDuckdbMaintenanceAccess}, {getMaintenanceDuckdbWorkloadContext, resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbScriptAccess.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        const workloadContext = getMaintenanceDuckdbWorkloadContext('migrateDuckdb.test.filterPostingLookupIndex')
        await withDuckdbMaintenanceAccess('filter posting lookup index migration test', async () => {
          await database.run('CREATE SCHEMA IF NOT EXISTS mart', workloadContext)
          await database.run(
            "CREATE TABLE app_schema_migration (name VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
            workloadContext
          )
          await database.run(
            "INSERT INTO app_schema_migration (name) VALUES ${appliedNames
              .map((fileName) => {
                return `('${fileName.replaceAll("'", "''")}')`
              })
              .join(', ')}",
            workloadContext
          )
          await database.run(\`
            CREATE TABLE mart.review_article_filter_posting_serving_v4 (
              project_id VARCHAR NOT NULL,
              review_config_hash VARCHAR NOT NULL,
              snapshot_id VARCHAR NOT NULL,
              filter_kind VARCHAR NOT NULL,
              filter_value VARCHAR NOT NULL,
              list_mode_key VARCHAR NOT NULL,
              article_ids VARCHAR[] NOT NULL
            )
          \`, workloadContext)
          await database.run(\`
            CREATE UNIQUE INDEX idx_review_article_filter_posting_serving_v4_repaired_pk
            ON mart.review_article_filter_posting_serving_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key)
          \`, workloadContext)
          await database.run(\`
            CREATE INDEX idx_review_article_filter_posting_serving_v4_lookup
            ON mart.review_article_filter_posting_serving_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key)
          \`, workloadContext)
          await database.run(\`
            INSERT INTO mart.review_article_filter_posting_serving_v4
            VALUES ('project-1', 'review-config-1', 'snapshot-1', 'promptAnswer', 'yes', 'llm', ['article-1'])
          \`, workloadContext)

          await migrateDuckdb()

          const indexes = await database.queryJson(
            "SELECT index_name AS indexName FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_article_filter_posting_serving_v4' ORDER BY index_name",
            workloadContext
          )
          const migrationRows = await database.queryJson(
            "SELECT name FROM app_schema_migration WHERE name = '${targetMigrationFile}'",
            workloadContext
          )
          const rows = await database.queryJson(
            'SELECT * FROM mart.review_article_filter_posting_serving_v4',
            workloadContext
          )

          console.log(JSON.stringify({indexes, migrationRows, rows}))
        })
      `,
    ],
    {
      cwd: resolve(import.meta.dir, '../..'),
      env: {...process.env, DUCKDB_PATH: duckdbPath, FORSKA_DB_PATH: duckdbPath, NODE_ENV: 'test'},
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )

  removeFileIfExists(duckdbPath)
  removeFileIfExists(`${duckdbPath}.wal`)

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString() || result.stdout.toString() || 'Failed to drop filter posting lookup index',
    )
  }

  const output = result.stdout.toString()
  const parsedLine = output.split('\n').find((line) => {
    return line.startsWith('{"indexes"')
  })

  expect(parsedLine).toBeDefined()

  const parsed = JSON.parse(parsedLine ?? '{}') as {
    indexes: {indexName: string}[]
    migrationRows: {name: string}[]
    rows: Array<Record<string, unknown>>
  }
  const indexes = parsed.indexes.map((index) => {
    return index.indexName
  })

  expect(indexes).toEqual(['idx_review_article_filter_posting_serving_v4_repaired_pk'])
  expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  expect(parsed.rows).toEqual([
    {
      article_ids: ['article-1'],
      filter_kind: 'promptAnswer',
      filter_value: 'yes',
      list_mode_key: 'llm',
      project_id: 'project-1',
      review_config_hash: 'review-config-1',
      snapshot_id: 'snapshot-1',
    },
  ])
})

test('DuckDB migration marks retired payload display hydration as applied without rebuilding payload', async () => {
  const duckdbPath = `/tmp/forska-review-payload-display-fields-${Date.now()}.duckdb`
  const targetMigrationFile = '0146_reviewServingPayloadDisplayFields.sql'
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
          CREATE TABLE mart.review_article_serving_payload_v4 (
            project_id VARCHAR NOT NULL,
            display_identity VARCHAR NOT NULL,
            payload_identity VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            source_metadata JSON,
            abstract_text VARCHAR,
            full_text_preview VARCHAR,
            payload_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_payload_v4 (
            project_id,
            display_identity,
            payload_identity,
            snapshot_id,
            article_id,
            article_created_at,
            source_metadata,
            abstract_text,
            full_text_preview
          )
          VALUES (
            'project-1',
            'display-1',
            'payload-1',
            'snapshot-1',
            'article-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            json('{"source":"fixture"}'),
            'abstract',
            'preview'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId
          FROM mart.review_article_serving_payload_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_payload_v4'
          ORDER BY ordinal_position
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0146_reviewServingPayloadDisplayFields.sql'"
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

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: {columnName: string}[]
      migrationRows: {name: string}[]
      rows: {articleId: string}[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('article_title')).toBe(false)
    expect(columnNames.has('article_external_id')).toBe(false)
    expect(columnNames.has('full_text_conversion_status')).toBe(false)
    expect(columnNames.has('abstract_text')).toBe(true)
    expect(columnNames.has('full_text_preview')).toBe(true)
    expect(parsed.rows).toEqual([{articleId: 'article-1'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops payload display-copy columns while preserving payload content', async () => {
  const duckdbPath = `/tmp/forska-review-payload-display-copy-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0149_dropReviewPayloadDisplayCopyColumns.sql'
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
          CREATE TABLE mart.review_article_serving_payload_v4 (
            project_id VARCHAR NOT NULL,
            display_identity VARCHAR NOT NULL,
            payload_identity VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            article_title VARCHAR,
            article_external_id VARCHAR,
            article_updated_at TIMESTAMPTZ,
            arxiv_id VARCHAR,
            biorxiv_id VARCHAR,
            medrxiv_id VARCHAR,
            doi VARCHAR,
            pmid VARCHAR,
            journal_title VARCHAR,
            url VARCHAR,
            full_text_pdf VARCHAR,
            full_text_fetched_at TIMESTAMPTZ,
            full_text_conversion_status VARCHAR,
            source_metadata JSON,
            abstract_text VARCHAR,
            full_text_preview VARCHAR,
            payload_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_payload_v4 (
            project_id,
            display_identity,
            payload_identity,
            snapshot_id,
            article_id,
            article_created_at,
            article_title,
            article_external_id,
            article_updated_at,
            arxiv_id,
            biorxiv_id,
            medrxiv_id,
            doi,
            pmid,
            journal_title,
            url,
            full_text_pdf,
            full_text_fetched_at,
            full_text_conversion_status,
            source_metadata,
            abstract_text,
            full_text_preview
          )
          VALUES (
            'project-1',
            'display-1',
            'payload-1',
            'snapshot-1',
            'article-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            'Display title',
            'NCT-1',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            '2401.00001',
            NULL,
            NULL,
            '10.1000/example',
            '12345',
            'Journal',
            'https://example.test/article-1',
            'article-1.pdf',
            TIMESTAMPTZ '2026-01-03 00:00:00+00',
            'converted',
            json('{"source":"fixture"}'),
            'abstract',
            'preview'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId
          FROM mart.review_article_serving_payload_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_payload_v4'
          ORDER BY ordinal_position
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0149_dropReviewPayloadDisplayCopyColumns.sql'"
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

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: {columnName: string}[]
      migrationRows: {name: string}[]
      rows: {articleId: string}[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('article_created_at')).toBe(false)
    expect(columnNames.has('source_metadata')).toBe(false)
    expect(columnNames.has('abstract_text')).toBe(false)
    expect(columnNames.has('full_text_preview')).toBe(false)
    expect(columnNames.has('article_title')).toBe(false)
    expect(columnNames.has('article_external_id')).toBe(false)
    expect(columnNames.has('full_text_pdf')).toBe(false)
    expect(parsed.rows).toEqual([{articleId: 'article-1'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops payload abstract text and source metadata', async () => {
  const duckdbPath = `/tmp/forska-review-payload-abstract-text-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0165_dropReviewPayloadAbstractText.sql'
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
          CREATE TABLE mart.review_article_serving_payload_v4 (
            project_id VARCHAR NOT NULL,
            display_identity VARCHAR NOT NULL,
            payload_identity VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_title VARCHAR,
            article_external_id VARCHAR,
            article_updated_at TIMESTAMPTZ,
            arxiv_id VARCHAR,
            biorxiv_id VARCHAR,
            medrxiv_id VARCHAR,
            doi VARCHAR,
            pmid VARCHAR,
            journal_title VARCHAR,
            url VARCHAR,
            source_metadata JSON,
            abstract_text VARCHAR
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_payload_v4 (
            project_id,
            display_identity,
            payload_identity,
            snapshot_id,
            article_id,
            article_title,
            source_metadata,
            abstract_text
          )
          VALUES (
            'project-1',
            'display-1',
            'payload-1',
            'snapshot-1',
            'article-1',
            'Display title',
            json('{"source":"fixture"}'),
            'abstract should be dropped'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            project_id AS projectId,
            display_identity AS displayIdentity,
            payload_identity AS payloadIdentity,
            snapshot_id AS snapshotId,
            article_id AS articleId
          FROM mart.review_article_serving_payload_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_payload_v4'
          ORDER BY ordinal_position
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0165_dropReviewPayloadAbstractText.sql'"
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

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: {columnName: string}[]
      migrationRows: {name: string}[]
      rows: {
        articleId: string
        displayIdentity: string
        payloadIdentity: string
        projectId: string
        snapshotId: string
      }[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('source_metadata')).toBe(false)
    expect(columnNames.has('abstract_text')).toBe(false)
    expect(columnNames.has('article_title')).toBe(false)
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-1',
        displayIdentity: 'display-1',
        payloadIdentity: 'payload-1',
        projectId: 'project-1',
        snapshotId: 'snapshot-1',
      },
    ])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops article serving publication year and index while preserving rows', async () => {
  const duckdbPath = `/tmp/forska-review-article-serving-publication-year-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0166_dropReviewArticleServingPublicationYear.sql'
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
          CREATE TABLE mart.review_article_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            base_generation BIGINT NOT NULL,
            patch_watermark BIGINT NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            sort_key TIMESTAMPTZ NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL,
            selected_import_route_id VARCHAR,
            publication_year INTEGER,
            duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
            conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
            llm_status_key VARCHAR,
            human_status_key VARCHAR,
            llm_judged_prompt_count INTEGER NOT NULL DEFAULT 0,
            enabled_prompt_count INTEGER NOT NULL DEFAULT 0,
            human_answered_prompt_count INTEGER NOT NULL DEFAULT 0,
            serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE INDEX idx_review_article_serving_v4_publication_year
          ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, publication_year, sort_key, article_id)
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            base_generation,
            patch_watermark,
            list_mode_key,
            article_id,
            article_created_at,
            sort_key,
            activity_sort_at,
            selected_import_route_id,
            publication_year,
            duplicate_flag,
            conflict_flag
          )
          VALUES (
            'project-1',
            'review-config-1',
            'snapshot-1',
            1,
            2,
            'llm',
            'article-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            'route-1',
            2026,
            TRUE,
            FALSE
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId
          FROM mart.review_article_serving_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY ordinal_position
        \`)
        const indexes = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY index_name
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0166_dropReviewArticleServingPublicationYear.sql'"
        )

        console.log(JSON.stringify({columns, indexes, migrationRows, rows}))
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
      columns: {columnName: string}[]
      indexes: {indexName: string}[]
      migrationRows: {name: string}[]
      rows: {articleId: string}[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('publication_year')).toBe(false)
    expect(columnNames.has('duplicate_flag')).toBe(false)
    expect(columnNames.has('conflict_flag')).toBe(false)
    expect(columnNames.has('selected_import_route_id')).toBe(false)
    expect(parsed.indexes).toEqual([
      {indexName: 'idx_review_article_serving_v4_order'},
      {indexName: 'idx_review_article_serving_v4_repaired_pk'},
    ])
    expect(parsed.rows).toEqual([{articleId: 'article-1'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops article serving selected flag copies while preserving rows', async () => {
  const duckdbPath = `/tmp/forska-review-article-serving-selected-flag-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0167_dropReviewArticleServingSelectedFlagCopies.sql'
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
          CREATE TABLE mart.review_article_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            base_generation BIGINT NOT NULL,
            patch_watermark BIGINT NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            sort_key TIMESTAMPTZ NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL,
            selected_import_route_id VARCHAR,
            duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
            conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
            llm_status_key VARCHAR,
            human_status_key VARCHAR,
            llm_judged_prompt_count INTEGER NOT NULL DEFAULT 0,
            enabled_prompt_count INTEGER NOT NULL DEFAULT 0,
            human_answered_prompt_count INTEGER NOT NULL DEFAULT 0,
            serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            base_generation,
            patch_watermark,
            list_mode_key,
            article_id,
            article_created_at,
            sort_key,
            activity_sort_at,
            selected_import_route_id,
            duplicate_flag,
            conflict_flag
          )
          VALUES (
            'project-1',
            'review-config-1',
            'snapshot-1',
            1,
            2,
            'llm',
            'article-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            'route-1',
            TRUE,
            FALSE
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId
          FROM mart.review_article_serving_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY ordinal_position
        \`)
        const indexes = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY index_name
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0167_dropReviewArticleServingSelectedFlagCopies.sql'"
        )

        console.log(JSON.stringify({columns, indexes, migrationRows, rows}))
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
      columns: {columnName: string}[]
      indexes: {indexName: string}[]
      migrationRows: {name: string}[]
      rows: {articleId: string}[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('duplicate_flag')).toBe(false)
    expect(columnNames.has('conflict_flag')).toBe(false)
    expect(columnNames.has('selected_import_route_id')).toBe(false)
    expect(parsed.indexes).toEqual([
      {indexName: 'idx_review_article_serving_v4_order'},
      {indexName: 'idx_review_article_serving_v4_repaired_pk'},
    ])
    expect(parsed.rows).toEqual([{articleId: 'article-1'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops article serving selected-import route copy while preserving rows and indexes', async () => {
  const duckdbPath = `/tmp/forska-review-article-serving-selected-import-route-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0168_dropReviewArticleServingSelectedImportRouteId.sql'
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
          CREATE TABLE mart.review_article_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            base_generation BIGINT NOT NULL,
            patch_watermark BIGINT NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            sort_key TIMESTAMPTZ NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL,
            selected_import_route_id VARCHAR,
            llm_status_key VARCHAR,
            human_status_key VARCHAR,
            llm_judged_prompt_count INTEGER NOT NULL DEFAULT 0,
            enabled_prompt_count INTEGER NOT NULL DEFAULT 0,
            human_answered_prompt_count INTEGER NOT NULL DEFAULT 0,
            serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE UNIQUE INDEX idx_review_article_serving_v4_repaired_pk
          ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, article_id)
        \`)
        await database.run(\`
          CREATE INDEX idx_review_article_serving_v4_order
          ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, sort_key, article_id)
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            base_generation,
            patch_watermark,
            list_mode_key,
            article_id,
            article_created_at,
            sort_key,
            activity_sort_at,
            selected_import_route_id,
            llm_status_key,
            human_status_key,
            llm_judged_prompt_count,
            enabled_prompt_count,
            human_answered_prompt_count,
            serving_updated_at
          )
          VALUES (
            'project-1',
            'review-config-1',
            'snapshot-1',
            1,
            2,
            'llm',
            'article-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            'route-1',
            'included',
            'answered',
            3,
            4,
            5,
            TIMESTAMPTZ '2026-01-03 00:00:00+00'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId
          FROM mart.review_article_serving_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY ordinal_position
        \`)
        const indexes = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY index_name
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0168_dropReviewArticleServingSelectedImportRouteId.sql'"
        )

        console.log(JSON.stringify({columns, indexes, migrationRows, rows}))
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
      columns: {columnName: string}[]
      indexes: {indexName: string}[]
      migrationRows: {name: string}[]
      rows: {articleId: string}[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('selected_import_route_id')).toBe(false)
    expect(columnNames.has('llm_status_key')).toBe(false)
    expect(columnNames.has('human_status_key')).toBe(false)
    expect(columnNames.has('llm_judged_prompt_count')).toBe(false)
    expect(columnNames.has('enabled_prompt_count')).toBe(false)
    expect(columnNames.has('human_answered_prompt_count')).toBe(false)
    expect(parsed.indexes).toEqual([
      {indexName: 'idx_review_article_serving_v4_order'},
      {indexName: 'idx_review_article_serving_v4_repaired_pk'},
    ])
    expect(parsed.rows).toEqual([{articleId: 'article-1'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops article serving updated-at while preserving rows and indexes', async () => {
  const duckdbPath = `/tmp/forska-review-article-serving-updated-at-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0170_dropReviewArticleServingUpdatedAt.sql'
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
          CREATE TABLE mart.review_article_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            base_generation BIGINT NOT NULL,
            patch_watermark BIGINT NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            sort_key TIMESTAMPTZ NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL,
            llm_status_key VARCHAR,
            human_status_key VARCHAR,
            llm_judged_prompt_count INTEGER NOT NULL DEFAULT 0,
            enabled_prompt_count INTEGER NOT NULL DEFAULT 0,
            human_answered_prompt_count INTEGER NOT NULL DEFAULT 0,
            serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE UNIQUE INDEX idx_review_article_serving_v4_repaired_pk
          ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, article_id)
        \`)
        await database.run(\`
          CREATE INDEX idx_review_article_serving_v4_order
          ON mart.review_article_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, sort_key, article_id)
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            base_generation,
            patch_watermark,
            list_mode_key,
            article_id,
            article_created_at,
            sort_key,
            activity_sort_at,
            llm_status_key,
            human_status_key,
            llm_judged_prompt_count,
            enabled_prompt_count,
            human_answered_prompt_count,
            serving_updated_at
          )
          VALUES (
            'project-1',
            'review-config-1',
            'snapshot-1',
            1,
            2,
            'llm',
            'article-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            'included',
            'answered',
            3,
            4,
            5,
            TIMESTAMPTZ '2026-01-03 00:00:00+00'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId
          FROM mart.review_article_serving_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY ordinal_position
        \`)
        const indexes = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY index_name
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0170_dropReviewArticleServingUpdatedAt.sql'"
        )

        console.log(JSON.stringify({columns, indexes, migrationRows, rows}))
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
      columns: {columnName: string}[]
      indexes: {indexName: string}[]
      migrationRows: {name: string}[]
      rows: {articleId: string}[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('serving_updated_at')).toBe(false)
    expect(columnNames.has('llm_status_key')).toBe(false)
    expect(columnNames.has('human_status_key')).toBe(false)
    expect(columnNames.has('llm_judged_prompt_count')).toBe(false)
    expect(columnNames.has('enabled_prompt_count')).toBe(false)
    expect(columnNames.has('human_answered_prompt_count')).toBe(false)
    expect(parsed.indexes).toEqual([
      {indexName: 'idx_review_article_serving_v4_order'},
      {indexName: 'idx_review_article_serving_v4_repaired_pk'},
    ])
    expect(parsed.rows).toEqual([{articleId: 'article-1'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration normalizes judgment detail list-mode storage by payload identity', async () => {
  const duckdbPath = `/tmp/forska-review-judgment-detail-list-mode-normalize-${Date.now()}.duckdb`
  const targetMigrationFile = '0171_normalizeReviewJudgmentDetailListModeStorage.sql'
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
          CREATE TABLE mart.review_article_judgment_detail_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            payload_kind VARCHAR NOT NULL DEFAULT 'llm',
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR NOT NULL,
            prompt_order INTEGER,
            judgment_id VARCHAR,
            judgment_model_id VARCHAR,
            is_answered BOOLEAN,
            answered_original VARCHAR,
            answered_original_as_array VARCHAR[],
            judgment_created_at TIMESTAMPTZ,
            human_comment VARCHAR,
            explanation VARCHAR,
            quotes JSON,
            placeholder_kind VARCHAR,
            detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_judgment_detail_hydration_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            payload_kind VARCHAR NOT NULL DEFAULT 'llm',
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR NOT NULL,
            judgment_updated_at TIMESTAMPTZ,
            chunking_strategy VARCHAR,
            confidence_original DOUBLE,
            snapshot_project_id VARCHAR,
            snapshot_project_model_name VARCHAR,
            model_name VARCHAR,
            model_provider VARCHAR,
            model_thinking VARCHAR,
            model_version VARCHAR,
            assessment_id VARCHAR,
            assessment_judgment_id VARCHAR,
            assessment_is_correct BOOLEAN,
            assessment_comment VARCHAR,
            assessment_created_at TIMESTAMPTZ,
            assessment_updated_at TIMESTAMPTZ,
            detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_judgment_detail_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            list_mode_key,
            payload_kind,
            article_id,
            prompt_id,
            prompt_order,
            judgment_id,
            judgment_model_id,
            is_answered,
            answered_original,
            answered_original_as_array,
            judgment_created_at,
            human_comment,
            explanation,
            quotes,
            placeholder_kind,
            detail_updated_at
          )
          VALUES
            ('project-1', 'config-1', 'snapshot-1', 'llm', 'llm', 'article-1', 'prompt-1', 1, 'llm-canonical', 'model-canonical', true, 'include', ['include'], TIMESTAMPTZ '2026-01-01 00:00:00+00', NULL, 'canonical explanation', '["canonical"]', NULL, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'both', 'llm', 'article-1', 'prompt-1', 1, 'llm-both', 'model-both', true, 'exclude', ['exclude'], TIMESTAMPTZ '2026-01-02 00:00:00+00', NULL, 'both explanation', '["both"]', NULL, TIMESTAMPTZ '2026-01-02 00:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'both', 'llm', 'article-2', 'prompt-1', 2, 'llm-both-only', 'model-both-only', true, 'include', ['include'], TIMESTAMPTZ '2026-01-03 00:00:00+00', NULL, 'both only explanation', '["both-only"]', NULL, TIMESTAMPTZ '2026-01-03 00:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'human', 'human', 'article-3', 'prompt-1', 3, 'human-canonical', NULL, true, 'yes', ['yes'], TIMESTAMPTZ '2026-01-04 00:00:00+00', 'canonical human', NULL, NULL, NULL, TIMESTAMPTZ '2026-01-04 00:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'both', 'human', 'article-3', 'prompt-1', 3, 'human-both', NULL, true, 'no', ['no'], TIMESTAMPTZ '2026-01-05 00:00:00+00', 'both human', NULL, NULL, NULL, TIMESTAMPTZ '2026-01-05 00:00:00+00')
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_judgment_detail_hydration_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            list_mode_key,
            payload_kind,
            article_id,
            prompt_id,
            judgment_updated_at,
            chunking_strategy,
            confidence_original,
            snapshot_project_id,
            snapshot_project_model_name,
            model_name,
            model_provider,
            model_thinking,
            model_version,
            assessment_id,
            assessment_judgment_id,
            assessment_is_correct,
            assessment_comment,
            assessment_created_at,
            assessment_updated_at,
            detail_updated_at
          )
          VALUES
            ('project-1', 'config-1', 'snapshot-1', 'llm', 'llm', 'article-1', 'prompt-1', TIMESTAMPTZ '2026-01-01 01:00:00+00', 'canonical-strategy', 0.8, 'source-project', 'source-model', 'canonical model', 'openai', 'medium', 'v1', 'assessment-canonical', 'llm-canonical', true, 'canonical assessment', TIMESTAMPTZ '2026-01-01 02:00:00+00', TIMESTAMPTZ '2026-01-01 03:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'both', 'llm', 'article-1', 'prompt-1', TIMESTAMPTZ '2026-01-02 01:00:00+00', 'both-strategy', 0.9, 'source-project', 'source-model', 'both model', 'openai', 'high', 'v2', 'assessment-both', 'llm-both', false, 'both assessment', TIMESTAMPTZ '2026-01-02 02:00:00+00', TIMESTAMPTZ '2026-01-02 03:00:00+00', TIMESTAMPTZ '2026-01-02 00:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'both', 'llm', 'article-2', 'prompt-1', TIMESTAMPTZ '2026-01-03 01:00:00+00', 'both-only-strategy', 0.7, NULL, NULL, 'both-only model', 'openai', NULL, 'v1', NULL, NULL, NULL, NULL, NULL, NULL, TIMESTAMPTZ '2026-01-03 00:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'human', 'human', 'article-3', 'prompt-1', TIMESTAMPTZ '2026-01-04 01:00:00+00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, TIMESTAMPTZ '2026-01-04 00:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'both', 'human', 'article-3', 'prompt-1', TIMESTAMPTZ '2026-01-05 01:00:00+00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'both human assessment', NULL, NULL, TIMESTAMPTZ '2026-01-05 00:00:00+00')
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            detail.article_id AS articleId,
            detail.payload_kind AS payloadKind,
            detail.list_mode_key AS listModeKey,
            detail.judgment_id AS judgmentId,
            detail.answered_original AS answeredOriginal,
            detail.human_comment AS humanComment,
            hydration.chunking_strategy AS chunkingStrategy,
            hydration.model_name AS modelName,
            hydration.assessment_id AS assessmentId,
            hydration.assessment_comment AS assessmentComment
          FROM mart.review_article_judgment_detail_serving_v4 detail
          INNER JOIN mart.review_article_judgment_detail_hydration_serving_v4 hydration
            ON hydration.project_id = detail.project_id
           AND hydration.review_config_hash = detail.review_config_hash
           AND hydration.snapshot_id = detail.snapshot_id
           AND hydration.list_mode_key = detail.list_mode_key
           AND hydration.payload_kind = detail.payload_kind
           AND hydration.article_id = detail.article_id
           AND hydration.prompt_id = detail.prompt_id
          ORDER BY detail.article_id, detail.payload_kind
        \`)
        const indexes = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'mart'
            AND table_name = 'review_article_judgment_detail_serving_v4'
          ORDER BY index_name
        \`)
        const hydrationIndexes = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE schema_name = 'mart'
            AND table_name = 'review_article_judgment_detail_hydration_serving_v4'
          ORDER BY index_name
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0171_normalizeReviewJudgmentDetailListModeStorage.sql'"
        )

        console.log(JSON.stringify({hydrationIndexes, indexes, migrationRows, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39997',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39998',
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
      hydrationIndexes: {indexName: string}[]
      indexes: {indexName: string}[]
      migrationRows: {name: string}[]
      rows: {
        articleId: string
        answeredOriginal: string | null
        assessmentComment: string | null
        assessmentId: string | null
        chunkingStrategy: string | null
        humanComment: string | null
        judgmentId: string | null
        listModeKey: string
        modelName: string | null
        payloadKind: string
      }[]
    }

    expect(parsed.rows).toEqual([
      {
        articleId: 'article-1',
        answeredOriginal: 'include',
        assessmentComment: 'canonical assessment',
        assessmentId: 'assessment-canonical',
        chunkingStrategy: 'canonical-strategy',
        humanComment: null,
        judgmentId: 'llm-canonical',
        listModeKey: 'llm',
        modelName: 'canonical model',
        payloadKind: 'llm',
      },
      {
        articleId: 'article-2',
        answeredOriginal: 'include',
        assessmentComment: null,
        assessmentId: null,
        chunkingStrategy: 'both-only-strategy',
        humanComment: null,
        judgmentId: 'llm-both-only',
        listModeKey: 'llm',
        modelName: 'both-only model',
        payloadKind: 'llm',
      },
      {
        articleId: 'article-3',
        answeredOriginal: 'yes',
        assessmentComment: null,
        assessmentId: null,
        chunkingStrategy: null,
        humanComment: 'canonical human',
        judgmentId: 'human-canonical',
        listModeKey: 'human',
        modelName: null,
        payloadKind: 'human',
      },
    ])
    expect(parsed.indexes).toEqual([
      {indexName: 'idx_review_article_judgment_detail_serving_v4_article'},
      {indexName: 'idx_review_article_judgment_detail_serving_v4_payload_identity'},
      {indexName: 'idx_review_article_judgment_detail_serving_v4_repaired_pk'},
    ])
    expect(parsed.hydrationIndexes).toEqual([
      {indexName: 'idx_review_article_judgment_detail_hydration_serving_v4_article'},
      {indexName: 'idx_review_article_judgment_detail_hydration_serving_v4_payload_identity'},
      {indexName: 'idx_review_article_judgment_detail_hydration_serving_v4_repaired_pk'},
    ])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration keeps payload display storage key-only after article serving display copies are dropped', async () => {
  const duckdbPath = `/tmp/forska-review-payload-display-rehydrate-${Date.now()}.duckdb`
  const targetMigrationFile = '0164_rehydrateReviewPayloadDisplayColumns.sql'
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
          CREATE TABLE app.review_serving_snapshot_manifest (
            project_id VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            selected_import_snapshot_id VARCHAR
          )
        \`)
        await database.run(\`
          CREATE TABLE app.article (
            id VARCHAR NOT NULL,
            article_title VARCHAR,
            article_id VARCHAR,
            article_updated_at TIMESTAMPTZ,
            arxiv_id VARCHAR,
            biorxiv_id VARCHAR,
            medrxiv_id VARCHAR,
            doi VARCHAR,
            pubmed_id VARCHAR,
            url VARCHAR
          )
        \`)
        await database.run(\`
          CREATE TABLE app.review_selected_article_import_v4 (
            project_id VARCHAR NOT NULL,
            selected_import_snapshot_id VARCHAR NOT NULL,
            project_scope_identity VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            import_route_id VARCHAR,
            source_record_key VARCHAR,
            tombstone BOOLEAN NOT NULL
          )
        \`)
        await database.run(\`
          CREATE TABLE app.review_import_article_hot_field (
            import_route_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            source_record_key VARCHAR NOT NULL,
            article_title VARCHAR,
            external_id VARCHAR,
            journal_title VARCHAR,
            tombstone BOOLEAN NOT NULL
          )
        \`)
        await database.run(\`
          CREATE TABLE app.article_import_route_source_record (
            import_route_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            source_record_key VARCHAR NOT NULL,
            raw_payload JSON,
            quarantined_at TIMESTAMPTZ
          )
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_serving_payload_v4 (
            project_id VARCHAR NOT NULL,
            display_identity VARCHAR NOT NULL,
            payload_identity VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            source_metadata JSON,
            abstract_text VARCHAR
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_serving_snapshot_manifest
          VALUES ('project-1', 'snapshot-1', 'selected-snapshot-1')
        \`)
        await database.run(\`
          INSERT INTO app.article
          VALUES (
            'article-1',
            'Article fallback title',
            'ARTICLE-FALLBACK-ID',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            '2401.00001',
            NULL,
            NULL,
            '10.1000/example',
            '12345',
            'https://fallback.example/article-1'
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_selected_article_import_v4
          VALUES ('project-1', 'selected-snapshot-1', 'scope-1', 'article-1', 'route-1', 'source-1', FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.review_import_article_hot_field
          VALUES ('route-1', 'article-1', 'source-1', 'Selected title', 'EXT-1', 'Selected Journal', FALSE)
        \`)
        await database.run(\`
          INSERT INTO app.article_import_route_source_record
          VALUES (
            'route-1',
            'article-1',
            'source-1',
            json('{"covidence":{"citation":{"url":"https://selected.example/article-1"}}}'),
            NULL
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_payload_v4
          VALUES (
            'project-1',
            'display-1',
            'payload-1',
            'snapshot-1',
            'article-1',
            json('{"source":"kept"}'),
            'abstract'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            project_id AS projectId,
            display_identity AS displayIdentity,
            payload_identity AS payloadIdentity,
            snapshot_id AS snapshotId,
            article_id AS articleId
          FROM mart.review_article_serving_payload_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_payload_v4'
          ORDER BY ordinal_position
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0164_rehydrateReviewPayloadDisplayColumns.sql'"
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

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: {columnName: string}[]
      migrationRows: {name: string}[]
      rows: {
        articleId: string
        displayIdentity: string
        payloadIdentity: string
        projectId: string
        snapshotId: string
      }[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('article_title')).toBe(false)
    expect(columnNames.has('article_external_id')).toBe(false)
    expect(columnNames.has('article_updated_at')).toBe(false)
    expect(columnNames.has('journal_title')).toBe(false)
    expect(columnNames.has('url')).toBe(false)
    expect(columnNames.has('abstract_text')).toBe(false)
    expect(columnNames.has('source_metadata')).toBe(false)
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-1',
        displayIdentity: 'display-1',
        payloadIdentity: 'payload-1',
        projectId: 'project-1',
        snapshotId: 'snapshot-1',
      },
    ])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops payload display storage while preserving payload coverage rows', async () => {
  const duckdbPath = `/tmp/forska-review-payload-display-storage-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0173_dropReviewPayloadDisplayStorage.sql'
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
          CREATE TABLE mart.review_article_serving_payload_v4 (
            project_id VARCHAR NOT NULL,
            display_identity VARCHAR NOT NULL,
            payload_identity VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_title VARCHAR,
            article_external_id VARCHAR,
            article_updated_at TIMESTAMPTZ,
            arxiv_id VARCHAR,
            biorxiv_id VARCHAR,
            medrxiv_id VARCHAR,
            doi VARCHAR,
            pmid VARCHAR,
            journal_title VARCHAR,
            url VARCHAR
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_payload_v4
          VALUES (
            'project-1',
            'display-1',
            'payload-1',
            'snapshot-1',
            'article-1',
            'Title',
            'EXT-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            '2401.00001',
            NULL,
            NULL,
            '10.1000/example',
            '12345',
            'Journal',
            'https://example.test/article-1'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            project_id AS projectId,
            display_identity AS displayIdentity,
            payload_identity AS payloadIdentity,
            snapshot_id AS snapshotId,
            article_id AS articleId
          FROM mart.review_article_serving_payload_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_payload_v4'
          ORDER BY ordinal_position
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0173_dropReviewPayloadDisplayStorage.sql'"
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

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: {columnName: string}[]
      migrationRows: {name: string}[]
      rows: {
        articleId: string
        displayIdentity: string
        payloadIdentity: string
        projectId: string
        snapshotId: string
      }[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect([...columnNames]).toEqual([
      'project_id',
      'display_identity',
      'payload_identity',
      'snapshot_id',
      'article_id',
    ])
    expect(columnNames.has('article_title')).toBe(false)
    expect(columnNames.has('article_external_id')).toBe(false)
    expect(columnNames.has('url')).toBe(false)
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-1',
        displayIdentity: 'display-1',
        payloadIdentity: 'payload-1',
        projectId: 'project-1',
        snapshotId: 'snapshot-1',
      },
    ])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops payload updated-at copy while preserving payload content', async () => {
  const duckdbPath = `/tmp/forska-review-payload-updated-at-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0153_dropReviewPayloadServingUpdatedAt.sql'
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
          CREATE TABLE mart.review_article_serving_payload_v4 (
            project_id VARCHAR NOT NULL,
            display_identity VARCHAR NOT NULL,
            payload_identity VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            source_metadata JSON,
            abstract_text VARCHAR,
            full_text_preview VARCHAR,
            payload_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_payload_v4 (
            project_id,
            display_identity,
            payload_identity,
            snapshot_id,
            article_id,
            article_created_at,
            source_metadata,
            abstract_text,
            full_text_preview,
            payload_updated_at
          )
          VALUES (
            'project-1',
            'display-1',
            'payload-1',
            'snapshot-1',
            'article-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            json('{"source":"fixture"}'),
            'abstract',
            'preview',
            TIMESTAMPTZ '2026-01-02 00:00:00+00'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId
          FROM mart.review_article_serving_payload_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_payload_v4'
          ORDER BY ordinal_position
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0153_dropReviewPayloadServingUpdatedAt.sql'"
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

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: {columnName: string}[]
      migrationRows: {name: string}[]
      rows: {articleId: string}[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('article_created_at')).toBe(false)
    expect(columnNames.has('source_metadata')).toBe(false)
    expect(columnNames.has('abstract_text')).toBe(false)
    expect(columnNames.has('full_text_preview')).toBe(false)
    expect(columnNames.has('payload_updated_at')).toBe(false)
    expect(parsed.rows).toEqual([{articleId: 'article-1'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops import hot-field provenance debug columns while preserving hot rows', async () => {
  const duckdbPath = `/tmp/forska-review-import-hot-field-debug-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0154_dropReviewImportHotFieldProvenanceDebugColumns.sql'
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
          CREATE TABLE app.review_import_article_hot_field (
            import_route_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            source_record_key VARCHAR NOT NULL,
            source_record_hash VARCHAR,
            source_kind VARCHAR,
            selected_rank_key VARCHAR,
            selected_rank_numeric DOUBLE,
            publication_year INTEGER,
            article_title VARCHAR,
            journal_title VARCHAR,
            external_id VARCHAR,
            duplicate_key VARCHAR,
            duplicate_flag BOOLEAN,
            conflict_flag BOOLEAN,
            filter_bucket_key VARCHAR,
            filter_bucket_value VARCHAR,
            source_updated_at TIMESTAMPTZ,
            tombstone BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_import_article_hot_field (
            import_route_id,
            article_id,
            source_record_key,
            source_record_hash,
            source_kind,
            selected_rank_key,
            selected_rank_numeric,
            publication_year,
            article_title,
            journal_title,
            external_id,
            duplicate_key,
            duplicate_flag,
            conflict_flag,
            filter_bucket_key,
            filter_bucket_value,
            source_updated_at,
            tombstone
          )
          VALUES (
            'route-1',
            'article-1',
            'source-key-1',
            'hash-1',
            'covidence',
            '000000000001:article-1',
            1,
            2026,
            'Article title',
            'Journal',
            'external-1',
            'duplicate-1',
            FALSE,
            TRUE,
            'bucket',
            'bucket-value',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            FALSE
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            import_route_id AS importRouteId,
            article_id AS articleId,
            source_record_key AS sourceRecordKey,
            selected_rank_key AS selectedRankKey,
            duplicate_flag AS duplicateFlag,
            conflict_flag AS conflictFlag,
            tombstone
          FROM app.review_import_article_hot_field
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'app'
            AND table_name = 'review_import_article_hot_field'
          ORDER BY ordinal_position
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0154_dropReviewImportHotFieldProvenanceDebugColumns.sql'"
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

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: {columnName: string}[]
      migrationRows: {name: string}[]
      rows: {
        articleId: string
        conflictFlag: boolean
        duplicateFlag: boolean
        importRouteId: string
        selectedRankKey: string
        sourceRecordKey: string
        tombstone: boolean
      }[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('source_record_hash')).toBe(false)
    expect(columnNames.has('duplicate_key')).toBe(false)
    expect(columnNames.has('source_updated_at')).toBe(false)
    expect(columnNames.has('created_at')).toBe(false)
    expect(columnNames.has('updated_at')).toBe(false)
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-1',
        conflictFlag: true,
        duplicateFlag: false,
        importRouteId: 'route-1',
        selectedRankKey: '000000000001:article-1',
        sourceRecordKey: 'source-key-1',
        tombstone: false,
      },
    ])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration skips retired payload display-copy backfill', () => {
  const migrationSql = readFileSync(resolve(migrationsFolder, '0148_backfillReviewPayloadDisplayFields.sql'), 'utf8')

  expect(migrationSql).toContain('Retired by 0149_dropReviewPayloadDisplayCopyColumns.sql')
  expect(migrationSql).not.toContain('UPDATE')
  expect(migrationSql).not.toContain('ALTER TABLE')
  expect(migrationSql).not.toContain('DROP TABLE')
  expect(migrationSql).not.toContain('article_title')
})

test('DuckDB migration backfills missing payload rows for every serving snapshot identity', async () => {
  const duckdbPath = `/tmp/forska-review-payload-serving-coverage-${Date.now()}.duckdb`
  const targetMigrationFile = '0151_backfillReviewPayloadServingCoverage.sql'
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
          CREATE TABLE app.review_serving_snapshot_manifest (
            project_id VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            component_state_json JSON NOT NULL
          )
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_serving_v4 (
            project_id VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ
          )
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_serving_payload_v4 (
            project_id VARCHAR NOT NULL,
            display_identity VARCHAR NOT NULL,
            payload_identity VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            source_metadata JSON,
            abstract_text VARCHAR,
            full_text_preview VARCHAR,
            payload_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_serving_snapshot_manifest
          VALUES (
            'project-1',
            'snapshot-1',
            json('{"required":[{"component":"display","projectionIdentity":"display-1"},{"component":"payload","projectionIdentity":"payload-1"}],"optional":[]}')
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_v4
          VALUES
            ('project-1', 'snapshot-1', 'llm', 'article-existing', TIMESTAMPTZ '2026-01-01 00:00:00+00'),
            ('project-1', 'snapshot-1', 'human', 'article-missing', TIMESTAMPTZ '2026-01-02 00:00:00+00'),
            ('project-1', 'snapshot-1', 'both', 'article-missing', TIMESTAMPTZ '2026-01-02 00:00:00+00')
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_payload_v4 (
            project_id,
            display_identity,
            payload_identity,
            snapshot_id,
            article_id,
            article_created_at,
            source_metadata,
            abstract_text,
            full_text_preview
          )
          VALUES (
            'project-1',
            'display-1',
            'payload-1',
            'snapshot-1',
            'article-existing',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            json('{"source":"kept"}'),
            'kept abstract',
            'kept preview'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            display_identity AS displayIdentity,
            payload_identity AS payloadIdentity
          FROM mart.review_article_serving_payload_v4
          ORDER BY article_id
        \`)
        const duplicateGroups = await database.queryJson(\`
          SELECT article_id AS articleId, COUNT(*)::INTEGER AS rowCount
          FROM mart.review_article_serving_payload_v4
          GROUP BY article_id
          HAVING COUNT(*) > 1
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0151_backfillReviewPayloadServingCoverage.sql'"
        )

        console.log(JSON.stringify({duplicateGroups, migrationRows, rows}))
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
      duplicateGroups: {articleId: string; rowCount: number}[]
      migrationRows: {name: string}[]
      rows: {articleId: string; displayIdentity: string; payloadIdentity: string}[]
    }

    expect(parsed.rows).toEqual([
      {articleId: 'article-existing', displayIdentity: 'display-1', payloadIdentity: 'payload-1'},
      {articleId: 'article-missing', displayIdentity: 'display-1', payloadIdentity: 'payload-1'},
    ])
    expect(parsed.duplicateGroups).toEqual([])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops article-serving full-text copies while preserving serving rows', async () => {
  const duckdbPath = `/tmp/forska-review-article-serving-full-text-copy-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0152_dropReviewArticleServingFullTextCopies.sql'
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
          CREATE TABLE mart.review_article_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            base_generation BIGINT NOT NULL,
            patch_watermark BIGINT NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            article_updated_at TIMESTAMPTZ,
            sort_key TIMESTAMPTZ NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL,
            article_title VARCHAR NOT NULL,
            article_external_id VARCHAR,
            arxiv_id VARCHAR,
            biorxiv_id VARCHAR,
            medrxiv_id VARCHAR,
            doi VARCHAR,
            pmid VARCHAR,
            journal_title VARCHAR,
            url VARCHAR,
            full_text_pdf VARCHAR,
            full_text_fetched_at TIMESTAMPTZ,
            full_text_conversion_status VARCHAR,
            selected_import_route_id VARCHAR,
            publication_year INTEGER,
            duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
            conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
            llm_status_key VARCHAR,
            human_status_key VARCHAR,
            llm_judged_prompt_count INTEGER NOT NULL DEFAULT 0,
            enabled_prompt_count INTEGER NOT NULL DEFAULT 0,
            human_answered_prompt_count INTEGER NOT NULL DEFAULT 0,
            serving_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            base_generation,
            patch_watermark,
            list_mode_key,
            article_id,
            article_created_at,
            article_updated_at,
            sort_key,
            activity_sort_at,
            article_title,
            article_external_id,
            doi,
            pmid,
            url,
            full_text_pdf,
            full_text_fetched_at,
            full_text_conversion_status,
            selected_import_route_id,
            duplicate_flag,
            conflict_flag,
            serving_updated_at
          )
          VALUES (
            'project-1',
            'review-config-1',
            'snapshot-1',
            3,
            4,
            'llm',
            'article-1',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            TIMESTAMPTZ '2026-01-02 00:00:00+00',
            'Article title',
            'external-1',
            '10.1000/example',
            '12345',
            'https://example.test/article-1',
            'article-1.pdf',
            TIMESTAMPTZ '2026-01-03 00:00:00+00',
            'converted',
            'route-1',
            FALSE,
            FALSE,
            TIMESTAMPTZ '2026-01-04 00:00:00+00'
          )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId
          FROM mart.review_article_serving_v4
        \`)
        const columns = await database.queryJson(\`
          SELECT column_name AS columnName
          FROM information_schema.columns
          WHERE table_schema = 'mart'
            AND table_name = 'review_article_serving_v4'
          ORDER BY ordinal_position
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0152_dropReviewArticleServingFullTextCopies.sql'"
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

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .filter((line) => {
        return line.trim().startsWith('{')
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      columns: {columnName: string}[]
      migrationRows: {name: string}[]
      rows: {articleId: string}[]
    }
    const columnNames = new Set(
      parsed.columns.map((column) => {
        return column.columnName
      }),
    )

    expect(columnNames.has('article_title')).toBe(false)
    expect(columnNames.has('doi')).toBe(false)
    expect(columnNames.has('full_text_pdf')).toBe(false)
    expect(columnNames.has('full_text_fetched_at')).toBe(false)
    expect(columnNames.has('full_text_conversion_status')).toBe(false)
    expect(columnNames.has('selected_import_route_id')).toBe(false)
    expect(parsed.rows).toEqual([{articleId: 'article-1'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops retired manual PR122 chunk manifest artifact', async () => {
  const duckdbPath = `/tmp/forska-review-manual-pr122-chunk-manifest-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0145_dropManualPr122ChunkManifestArtifact.sql'
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
          CREATE TABLE app.review_rebuild_chunk_manifest (
            chunk_id VARCHAR PRIMARY KEY,
            request_id VARCHAR,
            projection_component VARCHAR NOT NULL,
            status VARCHAR NOT NULL
          )
        \`)
        await database.run(\`
          CREATE TABLE app.review_rebuild_chunk_manifest_manual_pr122_1783542053396 (
            chunk_id VARCHAR PRIMARY KEY,
            request_id VARCHAR,
            projection_component VARCHAR NOT NULL,
            status VARCHAR NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_rebuild_chunk_manifest_manual_pr122_1783542053396 (
            chunk_id,
            request_id,
            projection_component,
            status
          )
          VALUES ('manual-chunk-1', 'request-1', 'selectedImport', 'completed')
        \`)

        await migrateDuckdb()

        const manualRows = await database.queryJson(\`
          SELECT table_name AS tableName
          FROM information_schema.tables
          WHERE table_schema = 'app'
            AND table_name = 'review_rebuild_chunk_manifest_manual_pr122_1783542053396'
        \`)
        const activeManifestRows = await database.queryJson(\`
          SELECT table_name AS tableName
          FROM information_schema.tables
          WHERE table_schema = 'app'
            AND table_name = 'review_rebuild_chunk_manifest'
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0145_dropManualPr122ChunkManifestArtifact.sql'"
        )

        console.log(JSON.stringify({activeManifestRows, manualRows, migrationRows}))
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
      activeManifestRows: {tableName: string}[]
      manualRows: {tableName: string}[]
      migrationRows: {name: string}[]
    }

    expect(parsed.manualRows).toEqual([])
    expect(parsed.activeManifestRows).toEqual([{tableName: 'review_rebuild_chunk_manifest'}])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops retired project import delta cursor and route index', async () => {
  const duckdbPath = `/tmp/forska-review-project-import-delta-cursor-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0144_dropReviewProjectImportDeltaCursor.sql'
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
          CREATE TABLE app.review_project_import_delta_cursor (
            project_id VARCHAR NOT NULL,
            import_route_id VARCHAR NOT NULL,
            source_delta_high_water BIGINT NOT NULL DEFAULT 0,
            cursor_json JSON,
            status VARCHAR NOT NULL DEFAULT 'ready',
            lease_owner VARCHAR,
            lease_expires_at TIMESTAMPTZ,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error VARCHAR,
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            PRIMARY KEY(project_id, import_route_id)
          )
        \`)
        await database.run(\`
          CREATE INDEX idx_review_project_import_delta_cursor_route
          ON app.review_project_import_delta_cursor(import_route_id, source_delta_high_water)
        \`)

        await migrateDuckdb()

        const tableRows = await database.queryJson(\`
          SELECT table_name AS tableName
          FROM information_schema.tables
          WHERE table_schema = 'app'
            AND table_name = 'review_project_import_delta_cursor'
        \`)
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE index_name = 'idx_review_project_import_delta_cursor_route'"
        )
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0144_dropReviewProjectImportDeltaCursor.sql'"
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
    removeFileIfExists(`${duckdbPath}.wal`)
  }
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

test('DuckDB migration scalarizes summary contribution partial keys', async () => {
  const duckdbPath = `/tmp/forska-review-summary-contribution-partial-key-${Date.now()}.duckdb`
  const targetMigrationFile = '0157_dropReviewSummaryContributionPartialJsonKey.sql'
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
          CREATE TABLE mart.review_article_summary_contribution_rebuild_partial_v4 (
            request_id VARCHAR NOT NULL,
            chunk_id VARCHAR NOT NULL,
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
          INSERT INTO mart.review_article_summary_contribution_rebuild_partial_v4 (
            request_id,
            chunk_id,
            project_id,
            review_config_hash,
            snapshot_id,
            article_id,
            component_kind,
            summary_definition_version,
            contribution_key,
            contribution_value,
            contribution_updated_at
          ) VALUES
            (
              'request-a',
              'chunk-a',
              'project-a',
              'config-a',
              'snapshot-a',
              'article-a',
              'count',
              'review-serving-summary:v1',
              '{"countKind":"review.list.total","facetKind":null,"facetKey":null,"facetValue":null,"filterKey":"list:all","listModeKey":"llm","summaryIdentity":"review.list.total","summaryKind":"count"}',
              7,
              TIMESTAMPTZ '2026-07-25T08:00:00Z'
            ),
            (
              'request-a',
              'chunk-a',
              'project-a',
              'config-a',
              'snapshot-a',
              'article-a',
              'count',
              'review-serving-summary:v1',
              '{"answerId":2,"countKind":"review.list.total","facetKind":null,"facetKey":null,"facetValue":null,"filterKey":"list:all","listModeKey":"llm","summaryIdentity":"review.list.total","summaryKind":"count"}',
              5,
              TIMESTAMPTZ '2026-07-25T08:02:00Z'
            ),
            (
              'request-a',
              'chunk-a',
              'project-a',
              'config-a',
              'snapshot-a',
              'article-b',
              'count',
              'review-serving-summary:v1',
              '{"countKind":"review.human.filter.summaryAnswer","facetKind":"human","facetKey":"summaryAnswer","facetValue":"yes","filterKey":null,"listModeKey":null,"summaryIdentity":"review.human.filter.summaryAnswer","summaryKind":"facet"}',
              3,
              TIMESTAMPTZ '2026-07-25T08:01:00Z'
            )
        \`)

        await migrateDuckdb()

        const columns = await database.queryJson(
          "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_article_summary_contribution_rebuild_partial_v4' ORDER BY ordinal_position"
        )
        const indexes = await database.queryJson(
          "SELECT index_name AS indexName, sql FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_article_summary_contribution_rebuild_partial_v4' ORDER BY index_name"
        )
        const rows = await database.queryJson(
          "SELECT article_id AS articleId, summary_kind AS summaryKind, summary_identity AS summaryIdentity, list_mode_key AS listModeKey, count_kind AS countKind, filter_key AS filterKey, facet_kind AS facetKind, facet_key AS facetKey, facet_value AS facetValue, CAST(contribution_value AS INTEGER) AS contributionValue FROM mart.review_article_summary_contribution_rebuild_partial_v4 ORDER BY article_id"
        )
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0157_dropReviewSummaryContributionPartialJsonKey.sql'"
        )

        console.log(JSON.stringify({columns, indexes, migrationRows, rows}))
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
      columns: Array<{columnName: string}>
      indexes: Array<{indexName: string; sql: string}>
      migrationRows: {name: string}[]
      rows: Array<{
        articleId: string
        contributionValue: number
        countKind: string
        facetKey: string | null
        facetKind: string | null
        facetValue: string | null
        filterKey: string | null
        listModeKey: string
        summaryIdentity: string
        summaryKind: string
      }>
    }
    const columns = parsed.columns.map((row) => {
      return row.columnName
    })
    const uniqueIndexSql = parsed.indexes.find((row) => {
      return row.indexName === 'idx_review_article_summary_contribution_rebuild_partial_v4_unique'
    })?.sql

    expect(columns).not.toContain('contribution_key')
    expect(columns).toContain('summary_identity')
    expect(uniqueIndexSql).toContain("COALESCE(list_mode_key, 'global')")
    expect(uniqueIndexSql).toContain("COALESCE(facet_value, '')")
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-a',
        contributionValue: 12,
        countKind: 'review.list.total',
        facetKey: null,
        facetKind: null,
        facetValue: null,
        filterKey: 'list:all',
        listModeKey: 'llm',
        summaryIdentity: 'review.list.total',
        summaryKind: 'count',
      },
      {
        articleId: 'article-b',
        contributionValue: 3,
        countKind: 'review.human.filter.summaryAnswer',
        facetKey: 'summaryAnswer',
        facetKind: 'human',
        facetValue: 'yes',
        filterKey: null,
        listModeKey: 'global',
        summaryIdentity: 'review.human.filter.summaryAnswer',
        summaryKind: 'facet',
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('DuckDB migration drops retired summary contribution rebuild partial mart and cleanup authorization rows', async () => {
  const duckdbPath = `/tmp/forska-review-summary-contribution-partial-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0176_dropReviewSummaryContributionRebuildPartial.sql'
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
          CREATE TABLE mart.review_article_summary_contribution_rebuild_partial_v4 (
            request_id VARCHAR NOT NULL,
            chunk_id VARCHAR NOT NULL,
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            component_kind VARCHAR NOT NULL,
            summary_definition_version VARCHAR NOT NULL,
            summary_kind VARCHAR NOT NULL,
            summary_identity VARCHAR NOT NULL,
            list_mode_key VARCHAR,
            count_kind VARCHAR,
            filter_key VARCHAR,
            facet_kind VARCHAR,
            facet_key VARCHAR,
            facet_value VARCHAR,
            contribution_value BIGINT NOT NULL,
            contribution_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE UNIQUE INDEX idx_review_article_summary_contribution_rebuild_partial_v4_unique
          ON mart.review_article_summary_contribution_rebuild_partial_v4(
            request_id,
            chunk_id,
            project_id,
            review_config_hash,
            snapshot_id,
            article_id,
            component_kind,
            summary_definition_version,
            summary_kind,
            summary_identity,
            COALESCE(list_mode_key, 'global'),
            COALESCE(count_kind, ''),
            COALESCE(filter_key, ''),
            COALESCE(facet_kind, ''),
            COALESCE(facet_key, ''),
            COALESCE(facet_value, '')
          )
        \`)
        await database.run(\`
          CREATE INDEX idx_review_article_summary_contribution_rebuild_partial_v4_publish
          ON mart.review_article_summary_contribution_rebuild_partial_v4(request_id, project_id, review_config_hash, snapshot_id)
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_summary_contribution_rebuild_partial_v4_key_repair (
            request_id VARCHAR NOT NULL
          )
        \`)
        await database.run(\`
          CREATE TABLE app.review_rebuild_partial_cleanup_authorization (
            authorization_id VARCHAR PRIMARY KEY,
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            request_id VARCHAR NOT NULL,
            chunk_id VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            partial_table VARCHAR NOT NULL,
            cleanup_mode VARCHAR NOT NULL,
            reason VARCHAR NOT NULL,
            evidence_json JSON NOT NULL DEFAULT '{}',
            expected_row_count BIGINT NOT NULL,
            observed_row_count BIGINT NOT NULL,
            operator_ack VARCHAR NOT NULL,
            authorized_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            expires_at TIMESTAMPTZ NOT NULL,
            applied_at TIMESTAMPTZ,
            applied_row_count BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            CHECK (
              partial_table IN (
                'mart.review_article_summary_contribution_rebuild_partial_v4',
                'mart.review_article_summary_rebuild_partial_v4'
              )
            )
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_rebuild_partial_cleanup_authorization (
            authorization_id,
            project_id,
            review_config_hash,
            request_id,
            chunk_id,
            snapshot_id,
            partial_table,
            cleanup_mode,
            reason,
            expected_row_count,
            observed_row_count,
            operator_ack,
            authorized_at,
            expires_at
          ) VALUES
            (
              'authorization-retired',
              'project-a',
              'config-a',
              'request-a',
              'chunk-a',
              'snapshot-a',
              'mart.review_article_summary_contribution_rebuild_partial_v4',
              'stale_orphan_summary_partial',
              'retired table',
              1,
              1,
              'ack',
              TIMESTAMPTZ '2026-07-25T08:00:00Z',
              TIMESTAMPTZ '2026-07-25T09:00:00Z'
            ),
            (
              'authorization-summary',
              'project-a',
              'config-a',
              'request-a',
              'chunk-a',
              'snapshot-a',
              'mart.review_article_summary_rebuild_partial_v4',
              'stale_orphan_summary_partial',
              'active table',
              2,
              2,
              'ack',
              TIMESTAMPTZ '2026-07-25T08:00:00Z',
              TIMESTAMPTZ '2026-07-25T09:00:00Z'
            )
        \`)

        await migrateDuckdb()

        const tableRows = await database.queryJson(
          "SELECT table_schema AS tableSchema, table_name AS tableName FROM information_schema.tables WHERE (table_schema = 'mart' AND table_name IN ('review_article_summary_contribution_rebuild_partial_v4', 'review_article_summary_contribution_rebuild_partial_v4_key_repair')) OR (table_schema = 'app' AND table_name = 'review_rebuild_partial_cleanup_authorization_repair') ORDER BY table_schema, table_name"
        )
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE index_name IN ('idx_review_article_summary_contribution_rebuild_partial_v4_unique', 'idx_review_article_summary_contribution_rebuild_partial_v4_publish') ORDER BY index_name"
        )
        const authorizationRows = await database.queryJson(
          "SELECT authorization_id AS authorizationId, partial_table AS partialTable FROM app.review_rebuild_partial_cleanup_authorization ORDER BY authorization_id"
        )
        const insertResult = await database.queryJson(
          "INSERT INTO app.review_rebuild_partial_cleanup_authorization (authorization_id, project_id, review_config_hash, request_id, chunk_id, snapshot_id, partial_table, cleanup_mode, reason, expected_row_count, observed_row_count, operator_ack, authorized_at, expires_at) VALUES ('authorization-blocked', 'project-a', 'config-a', 'request-a', 'chunk-a', 'snapshot-a', 'mart.review_article_summary_contribution_rebuild_partial_v4', 'stale_orphan_summary_partial', 'blocked', 1, 1, 'ack', TIMESTAMPTZ '2026-07-25T08:00:00Z', TIMESTAMPTZ '2026-07-25T09:00:00Z') RETURNING authorization_id"
        ).catch((error) => {
          return [{error: error instanceof Error ? error.message : String(error)}]
        })
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0176_dropReviewSummaryContributionRebuildPartial.sql'"
        )

        console.log(JSON.stringify({authorizationRows, indexRows, insertResult, migrationRows, tableRows}))
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
      authorizationRows: Array<{authorizationId: string; partialTable: string}>
      indexRows: {indexName: string}[]
      insertResult: Array<{authorization_id?: string; error?: string}>
      migrationRows: {name: string}[]
      tableRows: {tableName: string; tableSchema: string}[]
    }

    expect(parsed.tableRows).toEqual([])
    expect(parsed.indexRows).toEqual([])
    expect(parsed.authorizationRows).toEqual([
      {authorizationId: 'authorization-summary', partialTable: 'mart.review_article_summary_rebuild_partial_v4'},
    ])
    expect(parsed.insertResult[0]?.error).toContain('CHECK')
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('DuckDB migration drops retired filter posting stats mart and lookup indexes', async () => {
  const duckdbPath = `/tmp/forska-review-filter-posting-stats-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0147_dropReviewFilterPostingStats.sql'
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
          CREATE TABLE mart.review_filter_posting_stats_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            filter_kind VARCHAR NOT NULL,
            filter_value VARCHAR NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            cardinality BIGINT NOT NULL,
            stats_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE INDEX idx_review_filter_posting_stats_v4_lookup
          ON mart.review_filter_posting_stats_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key)
        \`)
        await database.run(\`
          CREATE UNIQUE INDEX idx_review_filter_posting_stats_v4_repaired_pk
          ON mart.review_filter_posting_stats_v4(project_id, review_config_hash, snapshot_id, filter_kind, filter_value, list_mode_key)
        \`)

        await migrateDuckdb()

        const tableRows = await database.queryJson(
          "SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = 'mart' AND table_name = 'review_filter_posting_stats_v4'"
        )
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE index_name IN ('idx_review_filter_posting_stats_v4_lookup', 'idx_review_filter_posting_stats_v4_repaired_pk') ORDER BY index_name"
        )
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0147_dropReviewFilterPostingStats.sql'"
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
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify filter posting stats drop migration',
      )
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      indexRows: unknown[]
      migrationRows: Array<{name: string}>
      tableRows: unknown[]
    }

    expect(parsed.tableRows).toEqual([])
    expect(parsed.indexRows).toEqual([])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration preserves legacy filter state when backfilling list-mode state filters', async () => {
  const duckdbPath = `/tmp/forska-review-filter-state-list-mode-backfill-${Date.now()}.duckdb`
  const targetMigrationFile = '0183_backfillReviewArticleServingListModeStateFilters.sql'
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
          CREATE TABLE app.project (
            id VARCHAR PRIMARY KEY,
            human_judgment_mode VARCHAR
          )
        \`)
        await database.run("INSERT INTO app.project VALUES ('project-1', 'prompt')")
        await database.run(\`
          CREATE TABLE app.project_prompt (
            project_id VARCHAR NOT NULL,
            prompt_id VARCHAR NOT NULL,
            enabled BOOLEAN NOT NULL,
            archived BOOLEAN NOT NULL
          )
        \`)
        await database.run(\`
          CREATE TABLE app.prompt (
            id VARCHAR PRIMARY KEY,
            archived BOOLEAN
          )
        \`)
        await database.run("INSERT INTO app.prompt VALUES ('prompt-1', FALSE), ('prompt-2', FALSE)")
        await database.run("INSERT INTO app.project_prompt VALUES ('project-1', 'prompt-1', TRUE, FALSE), ('project-1', 'prompt-2', TRUE, FALSE)")
        await database.run(\`
          CREATE TABLE app.review_serving_snapshot_manifest (
            project_id VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            snapshot_status VARCHAR NOT NULL DEFAULT 'candidate',
            review_config_hash VARCHAR,
            composed_identity_json JSON NOT NULL,
            component_state_json JSON NOT NULL,
            required_components_json JSON NOT NULL,
            optional_components_json JSON NOT NULL,
            source_watermarks_json JSON NOT NULL,
            validation_result_json JSON,
            selected_import_snapshot_id VARCHAR,
            last_known_good_snapshot_id VARCHAR,
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            activated_at TIMESTAMPTZ,
            failed_at TIMESTAMPTZ,
            last_error VARCHAR
          )
        \`)
        await database.run(\`
          CREATE TABLE app.review_selected_import_snapshot (
            selected_import_snapshot_id VARCHAR PRIMARY KEY,
            project_id VARCHAR NOT NULL,
            project_scope_identity VARCHAR NOT NULL,
            source_delta_high_water BIGINT NOT NULL DEFAULT 0,
            cursor_json JSON,
            status VARCHAR NOT NULL DEFAULT 'candidate',
            owner VARCHAR,
            lease_owner VARCHAR,
            lease_expires_at TIMESTAMPTZ,
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            last_error VARCHAR,
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
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
            tombstone BOOLEAN NOT NULL DEFAULT FALSE,
            selected_import_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          CREATE TABLE app.review_import_article_hot_field (
            import_route_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            source_record_key VARCHAR NOT NULL,
            publication_year INTEGER,
            duplicate_flag BOOLEAN,
            conflict_flag BOOLEAN,
            tombstone BOOLEAN NOT NULL DEFAULT FALSE
          )
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_judgment_detail_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR NOT NULL,
            payload_kind VARCHAR NOT NULL,
            is_answered BOOLEAN,
            placeholder_kind VARCHAR
          )
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_serving_base_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            base_generation BIGINT NOT NULL,
            patch_watermark BIGINT NOT NULL,
            article_id VARCHAR NOT NULL,
            article_created_at TIMESTAMPTZ,
            sort_key TIMESTAMPTZ NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL
          )
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            list_mode_keys VARCHAR[] NOT NULL,
            llm_patch_watermark BIGINT,
            human_patch_watermark BIGINT,
            both_patch_watermark BIGINT,
            unassessed_patch_watermark BIGINT
          )
        \`)
        await database.run(\`
          CREATE TABLE mart.review_article_filter_state_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            article_id VARCHAR NOT NULL,
            duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
            conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
            llm_status VARCHAR,
            human_status VARCHAR
          )
        \`)
        await database.run(\`
          CREATE INDEX idx_review_article_filter_state_serving_v4_lookup
          ON mart.review_article_filter_state_serving_v4(project_id, review_config_hash, snapshot_id, list_mode_key, duplicate_flag, conflict_flag, llm_status, human_status, article_id)
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_base_v4
          VALUES
            (
              'project-1',
              'review-config-1',
              'snapshot-1',
              3,
              7,
              'article-1',
              TIMESTAMPTZ '2026-01-01 00:00:00+00',
              TIMESTAMPTZ '2026-01-02 00:00:00+00',
              TIMESTAMPTZ '2026-01-03 00:00:00+00'
            ),
            (
              'project-1',
              'review-config-1',
              'snapshot-1',
              3,
              7,
              'article-2',
              TIMESTAMPTZ '2026-01-04 00:00:00+00',
              TIMESTAMPTZ '2026-01-05 00:00:00+00',
              TIMESTAMPTZ '2026-01-06 00:00:00+00'
            )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_serving_list_mode_state_v4
          VALUES
            ('project-1', 'review-config-1', 'snapshot-1', 'article-1', ['llm', 'human'], 8, 9, NULL, NULL),
            ('project-1', 'review-config-1', 'snapshot-1', 'article-2', ['llm', 'human'], 8, 9, NULL, NULL)
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_filter_state_serving_v4
          VALUES
            ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'article-1', TRUE, FALSE, 'answered', NULL),
            ('project-1', 'review-config-1', 'snapshot-1', 'human', 'article-1', FALSE, TRUE, NULL, 'unanswered'),
            ('project-1', 'review-config-1', 'snapshot-1', 'human', 'article-2', FALSE, FALSE, NULL, 'unanswered')
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_judgment_detail_serving_v4
          VALUES
            ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'article-1', 'prompt-1', 'llm', TRUE, 'placeholder'),
            ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'article-2', 'prompt-1', 'llm', TRUE, NULL),
            ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'article-2', 'prompt-2', 'llm', FALSE, NULL),
            ('project-1', 'review-config-1', 'snapshot-1', 'human', 'article-2', 'prompt-1', 'human', TRUE, NULL),
            ('project-1', 'review-config-1', 'snapshot-1', 'both', 'article-2', 'prompt-1', 'human', TRUE, NULL)
        \`)
        await database.run(\`
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
            selected_import_snapshot_id
          )
          VALUES (
            'project-1',
            'snapshot-1',
            'active',
            'review-config-1',
            CAST('{}' AS JSON),
            CAST('{}' AS JSON),
            CAST('[]' AS JSON),
            CAST('[]' AS JSON),
            CAST('{}' AS JSON),
            'selected-snapshot-1'
          )
        \`)
        await database.run(\`
          INSERT INTO app.review_selected_import_snapshot (
            selected_import_snapshot_id,
            project_id,
            project_scope_identity,
            source_delta_high_water
          )
          VALUES ('selected-snapshot-1', 'project-1', 'project-scope-1', 0)
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
            selected_rank_numeric
          )
          VALUES ('project-1', 'project-scope-1', 'selected-snapshot-1', 'article-2', 'route-1', 'source-2', 'rank-2', 2)
        \`)
        await database.run(\`
          INSERT INTO app.review_import_article_hot_field (
            import_route_id,
            article_id,
            source_record_key,
            duplicate_flag,
            conflict_flag
          )
          VALUES ('route-1', 'article-2', 'source-2', TRUE, TRUE)
        \`)

        await migrateDuckdb()

        const stateRows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            duplicate_flag AS duplicateFlag,
            conflict_flag AS conflictFlag,
            llm_status AS llmStatus,
            human_status AS humanStatus,
            llm_has_judgment AS llmHasJudgment
          FROM mart.review_article_serving_list_mode_state_v4
          ORDER BY article_id
        \`)
        const viewRows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            list_mode_key AS listModeKey,
            duplicate_flag AS duplicateFlag,
            conflict_flag AS conflictFlag,
            llm_status AS llmStatus,
            human_status AS humanStatus
          FROM mart.review_article_serving_v4
          ORDER BY article_id, list_mode_key
        \`)
        const tableRows = await database.queryJson(
          "SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = 'mart' AND table_name = 'review_article_filter_state_serving_v4'"
        )
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE index_name IN ('idx_review_article_filter_state_serving_v4_lookup', 'idx_review_article_filter_state_serving_v4_pk') ORDER BY index_name"
        )
        const lookupRows = await database.queryJson(
          "SELECT index_name AS indexName FROM duckdb_indexes() WHERE index_name = 'idx_review_article_serving_list_mode_state_v4_lookup'"
        )
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0183_backfillReviewArticleServingListModeStateFilters.sql'"
        )

        console.log(JSON.stringify({indexRows, lookupRows, migrationRows, stateRows, tableRows, viewRows}))
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
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify filter state backfill migration',
      )
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      indexRows: unknown[]
      lookupRows: Array<{indexName: string}>
      migrationRows: Array<{name: string}>
      stateRows: Array<{
        articleId: string
        conflictFlag: boolean
        duplicateFlag: boolean
        humanStatus: string | null
        llmStatus: string | null
        llmHasJudgment: boolean
      }>
      tableRows: unknown[]
      viewRows: Array<{
        conflictFlag: boolean
        duplicateFlag: boolean
        humanStatus: string | null
        articleId: string
        listModeKey: string
        llmStatus: string | null
      }>
    }

    expect(parsed.stateRows).toEqual([
      {
        articleId: 'article-1',
        conflictFlag: true,
        duplicateFlag: true,
        humanStatus: 'unanswered',
        llmHasJudgment: false,
        llmStatus: 'unanswered',
      },
      {
        articleId: 'article-2',
        conflictFlag: true,
        duplicateFlag: true,
        humanStatus: 'unanswered',
        llmHasJudgment: true,
        llmStatus: 'unanswered',
      },
    ])
    expect(parsed.viewRows).toEqual([
      {
        articleId: 'article-1',
        conflictFlag: true,
        duplicateFlag: true,
        humanStatus: 'unanswered',
        listModeKey: 'human',
        llmStatus: 'unanswered',
      },
      {
        articleId: 'article-1',
        conflictFlag: true,
        duplicateFlag: true,
        humanStatus: 'unanswered',
        listModeKey: 'llm',
        llmStatus: 'unanswered',
      },
      {
        articleId: 'article-2',
        conflictFlag: true,
        duplicateFlag: true,
        humanStatus: 'unanswered',
        listModeKey: 'human',
        llmStatus: 'unanswered',
      },
      {
        articleId: 'article-2',
        conflictFlag: true,
        duplicateFlag: true,
        humanStatus: 'unanswered',
        listModeKey: 'llm',
        llmStatus: 'unanswered',
      },
    ])
    expect(parsed.tableRows).toEqual([])
    expect(parsed.indexRows).toEqual([])
    expect(parsed.lookupRows).toEqual([])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops judgment detail physical list-mode key and preserves canonical payload rows', async () => {
  const duckdbPath = `/tmp/forska-review-judgment-detail-drop-list-mode-${Date.now()}.duckdb`
  const targetMigrationFile = '0184_dropReviewJudgmentDetailListModeKey.sql'
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
          CREATE TABLE mart.review_article_judgment_detail_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            list_mode_key VARCHAR NOT NULL,
            payload_kind VARCHAR NOT NULL DEFAULT 'llm',
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR NOT NULL,
            prompt_order INTEGER,
            judgment_id VARCHAR,
            is_answered BOOLEAN,
            answered_original VARCHAR,
            answered_original_as_array VARCHAR[],
            judgment_created_at TIMESTAMPTZ,
            human_comment VARCHAR,
            placeholder_kind VARCHAR,
            detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_judgment_detail_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            list_mode_key,
            payload_kind,
            article_id,
            prompt_id,
            prompt_order,
            judgment_id,
            is_answered,
            answered_original,
            answered_original_as_array,
            judgment_created_at,
            human_comment,
            placeholder_kind,
            detail_updated_at
          )
	          VALUES
	            ('project-1', 'config-1', 'snapshot-1', 'both', 'llm', 'article-1', 'prompt-1', 1, 'llm-both', TRUE, 'yes', ['yes'], TIMESTAMPTZ '2026-01-02 00:00:00+00', NULL, NULL, TIMESTAMPTZ '2026-01-03 00:00:00+00'),
	            ('project-1', 'config-1', 'snapshot-1', 'llm', 'llm', 'article-1', 'prompt-1', 1, 'llm-canonical', TRUE, 'no', ['no'], TIMESTAMPTZ '2026-01-01 00:00:00+00', NULL, NULL, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
	            ('project-1', 'config-1', 'snapshot-1', 'both', 'human', 'article-1', 'prompt-1', 1, 'human-both', TRUE, 'maybe', ['maybe'], TIMESTAMPTZ '2026-01-02 00:00:00+00', 'both comment', NULL, TIMESTAMPTZ '2026-01-03 00:00:00+00'),
	            ('project-1', 'config-1', 'snapshot-1', 'human', 'human', 'article-1', 'prompt-1', 1, 'human-canonical', TRUE, 'yes', ['yes'], TIMESTAMPTZ '2026-01-01 00:00:00+00', 'canonical comment', NULL, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
	            ('project-1', 'config-1', 'snapshot-1', 'both', 'llm', 'article-1', 'prompt-2', 2, 'llm-both-answered', TRUE, 'new', ['new'], TIMESTAMPTZ '2026-01-05 00:00:00+00', NULL, NULL, TIMESTAMPTZ '2026-01-05 00:00:00+00'),
	            ('project-1', 'config-1', 'snapshot-1', 'llm', 'llm', 'article-1', 'prompt-2', 2, 'llm-canonical-placeholder', FALSE, NULL, [], TIMESTAMPTZ '2026-01-06 00:00:00+00', NULL, 'missing_judgment', TIMESTAMPTZ '2026-01-06 00:00:00+00'),
	            ('project-1', 'config-1', 'snapshot-1', 'both', 'llm', 'article-2', 'prompt-1', 1, 'llm-only-both', TRUE, 'yes', ['yes'], TIMESTAMPTZ '2026-01-04 00:00:00+00', NULL, NULL, TIMESTAMPTZ '2026-01-04 00:00:00+00')
	        \`)

        await migrateDuckdb()

        const columns = await database.queryJson(
          "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_article_judgment_detail_serving_v4' ORDER BY ordinal_position"
        )
        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            prompt_id AS promptId,
            payload_kind AS payloadKind,
            judgment_id AS judgmentId,
            answered_original AS answeredOriginal,
            human_comment AS humanComment
          FROM mart.review_article_judgment_detail_serving_v4
          ORDER BY article_id, payload_kind
        \`)
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName, sql FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_article_judgment_detail_serving_v4' ORDER BY index_name"
        )
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0184_dropReviewJudgmentDetailListModeKey.sql'"
        )

        console.log(JSON.stringify({columns, indexRows, migrationRows, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39997',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39998',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify judgment detail list-mode drop',
      )
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      columns: Array<{columnName: string}>
      indexRows: Array<{indexName: string; sql: string}>
      migrationRows: Array<{name: string}>
      rows: Array<{
        articleId: string
        answeredOriginal: string | null
        humanComment: string | null
        judgmentId: string | null
        payloadKind: string
        promptId: string
      }>
    }

    expect(
      parsed.columns.map((row) => {
        return row.columnName
      }),
    ).toEqual([
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'payload_kind',
      'article_id',
      'prompt_id',
      'prompt_order',
      'judgment_id',
      'is_answered',
      'answered_original',
      'answered_original_as_array',
      'judgment_created_at',
      'human_comment',
      'placeholder_kind',
      'detail_updated_at',
    ])
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-1',
        answeredOriginal: 'maybe',
        humanComment: 'both comment',
        judgmentId: 'human-both',
        payloadKind: 'human',
        promptId: 'prompt-1',
      },
      {
        articleId: 'article-1',
        answeredOriginal: 'yes',
        humanComment: null,
        judgmentId: 'llm-both',
        payloadKind: 'llm',
        promptId: 'prompt-1',
      },
      {
        articleId: 'article-1',
        answeredOriginal: 'new',
        humanComment: null,
        judgmentId: 'llm-both-answered',
        payloadKind: 'llm',
        promptId: 'prompt-2',
      },
      {
        articleId: 'article-2',
        answeredOriginal: 'yes',
        humanComment: null,
        judgmentId: 'llm-only-both',
        payloadKind: 'llm',
        promptId: 'prompt-1',
      },
    ])
    expect(parsed.indexRows).toEqual([
      {
        indexName: 'idx_review_article_judgment_detail_serving_v4_article',
        sql: expect.stringContaining(
          'ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order)',
        ) as string,
      },
      {
        indexName: 'idx_review_article_judgment_detail_serving_v4_repaired_pk',
        sql: expect.stringContaining(
          'ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id)',
        ) as string,
      },
    ])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration drops LLM unanswered judgment-detail placeholders without changing retained rows', async () => {
  const duckdbPath = `/tmp/forska-review-judgment-detail-llm-placeholder-drop-${Date.now()}.duckdb`
  const targetMigrationFile = '0193_dropReviewJudgmentDetailLlmPlaceholders.sql'
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
          CREATE TABLE mart.review_article_judgment_detail_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            payload_kind VARCHAR NOT NULL DEFAULT 'llm',
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR NOT NULL,
            prompt_order INTEGER,
            judgment_id VARCHAR,
            is_answered BOOLEAN,
            answered_original VARCHAR,
            answered_original_as_array VARCHAR[],
            judgment_created_at TIMESTAMPTZ,
            human_comment VARCHAR,
            placeholder_kind VARCHAR,
            detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_judgment_detail_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            payload_kind,
            article_id,
            prompt_id,
            prompt_order,
            judgment_id,
            is_answered,
            answered_original,
            answered_original_as_array,
            judgment_created_at,
            human_comment,
            placeholder_kind,
            detail_updated_at
          )
          VALUES
            ('project-1', 'config-1', 'snapshot-1', 'llm', 'article-1', 'prompt-1', 1, 'judgment-1', TRUE, 'yes', ['yes'], TIMESTAMPTZ '2026-01-01 00:00:00+00', NULL, NULL, TIMESTAMPTZ '2026-01-01 01:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'llm', 'article-1', 'prompt-2', 2, NULL, NULL, NULL, NULL, NULL, NULL, 'llm.unanswered', TIMESTAMPTZ '2026-01-01 02:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'human', 'article-1', 'prompt-2', 2, 'human-1', TRUE, 'no', ['no'], TIMESTAMPTZ '2026-01-01 03:00:00+00', 'comment', NULL, TIMESTAMPTZ '2026-01-01 04:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'human', 'article-1', 'prompt-3', 3, NULL, FALSE, NULL, NULL, NULL, NULL, 'human.unanswered', TIMESTAMPTZ '2026-01-01 05:00:00+00')
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            payload_kind AS payloadKind,
            prompt_id AS promptId,
            judgment_id AS judgmentId,
            placeholder_kind AS placeholderKind,
            detail_updated_at AS detailUpdatedAt
          FROM mart.review_article_judgment_detail_serving_v4
          ORDER BY payload_kind, prompt_id
        \`)
        const indexRows = await database.queryJson(
          "SELECT index_name AS indexName, sql FROM duckdb_indexes() WHERE schema_name = 'mart' AND table_name = 'review_article_judgment_detail_serving_v4' ORDER BY index_name"
        )
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0193_dropReviewJudgmentDetailLlmPlaceholders.sql'"
        )

        console.log(JSON.stringify({indexRows, migrationRows, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39997',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39998',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify LLM placeholder drop')
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      indexRows: Array<{indexName: string; sql: string}>
      migrationRows: Array<{name: string}>
      rows: Array<{
        detailUpdatedAt: string
        judgmentId: string | null
        payloadKind: string
        placeholderKind: string | null
        promptId: string
      }>
    }

    expect(parsed.rows).toEqual([
      {
        detailUpdatedAt: expect.any(String) as string,
        judgmentId: 'human-1',
        payloadKind: 'human',
        placeholderKind: null,
        promptId: 'prompt-2',
      },
      {
        detailUpdatedAt: expect.any(String) as string,
        judgmentId: null,
        payloadKind: 'human',
        placeholderKind: 'human.unanswered',
        promptId: 'prompt-3',
      },
      {
        detailUpdatedAt: expect.any(String) as string,
        judgmentId: 'judgment-1',
        payloadKind: 'llm',
        placeholderKind: null,
        promptId: 'prompt-1',
      },
    ])
    expect(parsed.indexRows).toEqual([
      {
        indexName: 'idx_review_article_judgment_detail_serving_v4_article',
        sql: expect.stringContaining(
          'ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order)',
        ) as string,
      },
      {
        indexName: 'idx_review_article_judgment_detail_serving_v4_repaired_pk',
        sql: expect.stringContaining(
          'ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id)',
        ) as string,
      },
    ])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
})

test('DuckDB migration nulls retained human judgment-detail answer arrays while preserving LLM arrays', async () => {
  const duckdbPath = `/tmp/forska-review-judgment-detail-human-answer-array-null-${Date.now()}.duckdb`
  const targetMigrationFile = '0198_nullHumanJudgmentDetailAnswerArray.sql'
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
          CREATE TABLE mart.review_article_judgment_detail_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            payload_kind VARCHAR NOT NULL DEFAULT 'llm',
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR NOT NULL,
            prompt_order INTEGER,
            judgment_id VARCHAR,
            is_answered BOOLEAN,
            answered_original VARCHAR,
            answered_original_as_array VARCHAR[],
            judgment_created_at TIMESTAMPTZ,
            human_comment VARCHAR,
            placeholder_kind VARCHAR,
            detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_article_judgment_detail_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            payload_kind,
            article_id,
            prompt_id,
            prompt_order,
            judgment_id,
            is_answered,
            answered_original,
            answered_original_as_array,
            judgment_created_at,
            human_comment,
            placeholder_kind,
            detail_updated_at
          )
          VALUES
            ('project-1', 'config-1', 'snapshot-1', 'human', 'article-1', 'prompt-1', 1, 'human-1', TRUE, 'include', ['include'], TIMESTAMPTZ '2026-01-01 00:00:00+00', 'comment', NULL, TIMESTAMPTZ '2026-01-01 01:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'human', 'article-1', 'prompt-2', 2, 'human-2', TRUE, 'exclude', NULL, TIMESTAMPTZ '2026-01-01 02:00:00+00', NULL, NULL, TIMESTAMPTZ '2026-01-01 03:00:00+00'),
            ('project-1', 'config-1', 'snapshot-1', 'llm', 'article-1', 'prompt-1', 1, 'llm-1', TRUE, 'maybe', ['maybe', 'include'], TIMESTAMPTZ '2026-01-01 04:00:00+00', NULL, NULL, TIMESTAMPTZ '2026-01-01 05:00:00+00')
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            payload_kind AS payloadKind,
            prompt_id AS promptId,
            answered_original AS answeredOriginal,
            answered_original_as_array IS NULL AS answerArrayIsNull,
            answered_original_as_array[1] AS answerArrayFirst,
            answered_original_as_array[2] AS answerArraySecond
          FROM mart.review_article_judgment_detail_serving_v4
          ORDER BY payload_kind, prompt_id
        \`)
        const migrationRows = await database.queryJson(
          "SELECT name FROM app_schema_migration WHERE name = '0198_nullHumanJudgmentDetailAnswerArray.sql'"
        )

        console.log(JSON.stringify({migrationRows, rows}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39997',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39998',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify human answer-array nulling',
      )
    }

    const parsed = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
      migrationRows: Array<{name: string}>
      rows: Array<{
        answerArrayFirst: string | null
        answerArrayIsNull: boolean
        answerArraySecond: string | null
        answeredOriginal: string | null
        payloadKind: string
        promptId: string
      }>
    }

    expect(parsed.rows).toEqual([
      {
        answerArrayFirst: null,
        answerArrayIsNull: true,
        answerArraySecond: null,
        answeredOriginal: 'include',
        payloadKind: 'human',
        promptId: 'prompt-1',
      },
      {
        answerArrayFirst: null,
        answerArrayIsNull: true,
        answerArraySecond: null,
        answeredOriginal: 'exclude',
        payloadKind: 'human',
        promptId: 'prompt-2',
      },
      {
        answerArrayFirst: 'maybe',
        answerArrayIsNull: false,
        answerArraySecond: 'include',
        answeredOriginal: 'maybe',
        payloadKind: 'llm',
        promptId: 'prompt-1',
      },
    ])
    expect(parsed.migrationRows).toEqual([{name: targetMigrationFile}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
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
    '0158_reviewJudgmentDetailListScalars.sql',
    '0159_reviewJudgmentDetailDetailHydrationScalars.sql',
    '0160_reviewJudgmentDetailHydrationSplit.sql',
    '0161_dropReviewJudgmentHydrationPromptMetadata.sql',
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
              '{"answer":"include","assessments":[{"assessmentComment":"Checked","assessmentIsCorrect":true,"createdAt":"2026-06-28T10:01:00.000Z","id":"assessment-a","judgmentId":"judgment-a","updatedAt":"2026-06-28T10:02:00.000Z"}],"chunkingStrategy":"semantic","confidenceOriginal":82,"explanation":"Because A","model":{"id":"model-a","name":"Model A","provider":"openai","thinking":"high","version":"v1"},"prompt":{"criteriaDisposition":"include","originalText":"Prompt A text","promptHeading":"Prompt A","type":"yes_no"},"quotes":["Quote A"],"snapshotProjectId":"project-source","snapshotProjectModelName":"Snapshot Model","updatedAt":"2026-06-28T10:00:00.000Z"}',
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
          "SELECT detail.project_id AS projectId, detail.payload_kind AS payloadKind, detail.judgment_id AS judgmentId, detail.judgment_model_id AS judgmentModelId, detail.judgment_created_at AS judgmentCreatedAt, hydration.judgment_updated_at AS judgmentUpdatedAt, detail.human_comment AS humanComment, detail.explanation, detail.quotes, hydration.chunking_strategy AS chunkingStrategy, hydration.confidence_original AS confidenceOriginal, hydration.snapshot_project_id AS snapshotProjectId, hydration.snapshot_project_model_name AS snapshotProjectModelName, hydration.model_name AS modelName, hydration.model_provider AS modelProvider, hydration.model_thinking AS modelThinking, hydration.model_version AS modelVersion, hydration.assessment_id AS assessmentId, hydration.assessment_judgment_id AS assessmentJudgmentId, hydration.assessment_is_correct AS assessmentIsCorrect, hydration.assessment_comment AS assessmentComment, hydration.assessment_created_at AS assessmentCreatedAt, hydration.assessment_updated_at AS assessmentUpdatedAt, detail.placeholder_kind AS placeholderKind FROM mart.review_article_judgment_detail_serving_v4 detail INNER JOIN mart.review_article_judgment_detail_hydration_serving_v4 hydration ON hydration.project_id = detail.project_id AND hydration.review_config_hash = detail.review_config_hash AND hydration.snapshot_id = detail.snapshot_id AND hydration.list_mode_key = detail.list_mode_key AND hydration.payload_kind = detail.payload_kind AND hydration.article_id = detail.article_id AND hydration.prompt_id = detail.prompt_id ORDER BY detail.article_id"
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
        const hydrationColumns = await database.queryJson(
          "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_article_judgment_detail_hydration_serving_v4' ORDER BY ordinal_position"
        )
        console.log(JSON.stringify({chunkRows, columns, duplicatePayloadKindAccepted, hydrationColumns, requestRows, rows, uniqueIndexRows}))
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
      hydrationColumns: Array<{columnName: string}>
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
        judgmentModelId: string | null
        judgmentUpdatedAt: string | null
        assessmentComment: string | null
        assessmentCreatedAt: string | null
        assessmentId: string | null
        assessmentIsCorrect: boolean | null
        assessmentJudgmentId: string | null
        assessmentUpdatedAt: string | null
        chunkingStrategy: string | null
        confidenceOriginal: number | null
        explanation: string | null
        quotes: unknown
        humanComment: string | null
        judgmentCreatedAt: string | null
        modelName: string | null
        modelProvider: string | null
        modelThinking: string | null
        modelVersion: string | null
        payloadKind: string
        placeholderKind: string | null
        projectId: string
        snapshotProjectId: string | null
        snapshotProjectModelName: string | null
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
      'judgment_model_id',
      'is_answered',
      'answered_original',
      'answered_original_as_array',
      'judgment_created_at',
      'human_comment',
      'explanation',
      'quotes',
      'placeholder_kind',
      'detail_updated_at',
    ])
    expect(
      parsed.hydrationColumns.map((row) => {
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
      'judgment_updated_at',
      'chunking_strategy',
      'confidence_original',
      'snapshot_project_id',
      'snapshot_project_model_name',
      'model_name',
      'model_provider',
      'model_thinking',
      'model_version',
      'assessment_id',
      'assessment_judgment_id',
      'assessment_is_correct',
      'assessment_comment',
      'assessment_created_at',
      'assessment_updated_at',
      'detail_updated_at',
    ])
    const normalizedRows = parsed.rows.map((row) => {
      return {
        ...row,
        assessmentCreatedAt: row.assessmentCreatedAt === null ? null : typeof row.assessmentCreatedAt,
        assessmentUpdatedAt: row.assessmentUpdatedAt === null ? null : typeof row.assessmentUpdatedAt,
        judgmentUpdatedAt: row.judgmentUpdatedAt === null ? null : typeof row.judgmentUpdatedAt,
        quotes: row.quotes === null ? null : typeof row.quotes === 'string' ? row.quotes : JSON.stringify(row.quotes),
      }
    })

    expect(normalizedRows).toEqual([
      {
        judgmentId: 'judgment-a',
        judgmentModelId: 'model-a',
        judgmentCreatedAt: null,
        judgmentUpdatedAt: 'string',
        assessmentComment: 'Checked',
        assessmentCreatedAt: 'string',
        assessmentId: 'assessment-a',
        assessmentIsCorrect: true,
        assessmentJudgmentId: 'judgment-a',
        assessmentUpdatedAt: 'string',
        chunkingStrategy: 'semantic',
        confidenceOriginal: 82,
        explanation: 'Because A',
        quotes: '["Quote A"]',
        humanComment: null,
        modelName: 'Model A',
        modelProvider: 'openai',
        modelThinking: 'high',
        modelVersion: 'v1',
        payloadKind: 'llm',
        placeholderKind: null,
        projectId: 'project-a',
        snapshotProjectId: 'project-source',
        snapshotProjectModelName: 'Snapshot Model',
      },
      {
        judgmentId: null,
        judgmentModelId: null,
        judgmentCreatedAt: null,
        judgmentUpdatedAt: 'string',
        assessmentComment: null,
        assessmentCreatedAt: null,
        assessmentId: null,
        assessmentIsCorrect: null,
        assessmentJudgmentId: null,
        assessmentUpdatedAt: null,
        chunkingStrategy: null,
        confidenceOriginal: null,
        explanation: null,
        quotes: null,
        humanComment: null,
        modelName: null,
        modelProvider: null,
        modelThinking: null,
        modelVersion: null,
        payloadKind: 'llm',
        placeholderKind: 'llm.unanswered',
        projectId: 'project-a',
        snapshotProjectId: null,
        snapshotProjectModelName: null,
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

test('DuckDB migrations drop queue serving identity and compact prompt rows into article queue rows', async () => {
  const duckdbPath = `/tmp/forska-review-queue-serving-identity-${Date.now()}.duckdb`
  const targetMigrationFiles = new Set([
    '0139_dropReviewQueueServingIdentity.sql',
    '0187_compactReviewUnassessedQueueServing.sql',
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
            queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
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
            ),
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'legacy-queue-c',
              'unassessed',
              10,
              TIMESTAMPTZ '2026-07-25T07:00:00Z',
              'article-a',
              'prompt-b',
              TIMESTAMPTZ '2026-07-25T07:03:00Z'
            )
        \`)

        await migrateDuckdb()

        const columns = await database.queryJson(
          "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = 'mart' AND table_name = 'review_unassessed_queue_serving_v4' ORDER BY ordinal_position"
        )
        const rows = await database.queryJson(
          "SELECT article_id AS articleId, prompt_ids AS promptIds, queue_kind AS queueKind, queue_updated_at AS queueUpdatedAt FROM mart.review_unassessed_queue_serving_v4 ORDER BY article_id"
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
      rows: Array<{articleId: string; promptIds: string[]; queueKind: string; queueUpdatedAt: string}>
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
      'prompt_ids',
      'queue_updated_at',
    ])
    expect(parsed.rows).toEqual([
      {
        articleId: 'article-a',
        promptIds: ['prompt-a', 'prompt-b'],
        queueKind: 'unassessed',
        queueUpdatedAt: expect.stringContaining('2026-07-25') as string,
      },
    ])
    expect(parsed.rows[0]?.queueUpdatedAt).toContain('09:03')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migration preserves legacy nullable queue prompt rows during compaction', async () => {
  const duckdbPath = `/tmp/forska-review-queue-null-prompt-${Date.now()}.duckdb`
  const targetMigrationFile = '0187_compactReviewUnassessedQueueServing.sql'
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
          CREATE TABLE mart.review_unassessed_queue_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            queue_kind VARCHAR NOT NULL,
            priority_bucket INTEGER NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL,
            article_id VARCHAR NOT NULL,
            prompt_id VARCHAR,
            queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_unassessed_queue_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
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
              'unassessed',
              5,
              TIMESTAMPTZ '2026-07-25T06:00:00Z',
              'article-null-prompt',
              NULL,
              TIMESTAMPTZ '2026-07-25T06:01:00Z'
            ),
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'unassessed',
              10,
              TIMESTAMPTZ '2026-07-25T07:00:00Z',
              'article-a',
              'prompt-a',
              TIMESTAMPTZ '2026-07-25T07:01:00Z'
            )
        \`)

        await migrateDuckdb()

        const rows = await database.queryJson(
          "SELECT article_id AS articleId, prompt_ids AS promptIds FROM mart.review_unassessed_queue_serving_v4 ORDER BY article_id"
        )
        console.log(JSON.stringify({rows}))
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
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {rows: Array<{articleId: string; promptIds: string[]}>}

    expect(parsed.rows).toEqual([
      {articleId: 'article-a', promptIds: ['prompt-a']},
      {articleId: 'article-null-prompt', promptIds: []},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('DuckDB migration derives unassessed queue article rank from one winning queue row', async () => {
  const duckdbPath = `/tmp/forska-review-queue-article-rank-${Date.now()}.duckdb`
  const targetMigrationFile = '0200_reviewUnassessedQueueArticleRankServing.sql'
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
          CREATE TABLE mart.review_unassessed_queue_serving_v4 (
            project_id VARCHAR NOT NULL,
            review_config_hash VARCHAR NOT NULL,
            snapshot_id VARCHAR NOT NULL,
            queue_kind VARCHAR NOT NULL,
            priority_bucket INTEGER NOT NULL,
            activity_sort_at TIMESTAMPTZ NOT NULL,
            article_id VARCHAR NOT NULL,
            prompt_ids VARCHAR[] NOT NULL,
            queue_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
          )
        \`)
        await database.run(\`
          INSERT INTO mart.review_unassessed_queue_serving_v4 (
            project_id,
            review_config_hash,
            snapshot_id,
            queue_kind,
            priority_bucket,
            activity_sort_at,
            article_id,
            prompt_ids,
            queue_updated_at
          )
          VALUES
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'unassessed',
              1,
              TIMESTAMPTZ '2026-07-25T09:00:00Z',
              'article-a',
              ['prompt-low'],
              TIMESTAMPTZ '2026-07-25T09:10:00Z'
            ),
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'unassessed',
              2,
              TIMESTAMPTZ '2026-07-25T08:00:00Z',
              'article-a',
              ['prompt-high'],
              TIMESTAMPTZ '2026-07-25T08:10:00Z'
            ),
            (
              'project-a',
              'config-a',
              'snapshot-a',
              'unassessed',
              1,
              TIMESTAMPTZ '2026-07-25T07:00:00Z',
              'article-b',
              ['prompt-b'],
              TIMESTAMPTZ '2026-07-25T07:10:00Z'
            )
        \`)

        await migrateDuckdb()
        await migrateDuckdb()

        const rows = await database.queryJson(\`
          SELECT
            article_id AS articleId,
            CAST(priority_bucket AS INTEGER) AS priorityBucket,
            activity_sort_at AS activitySortAt,
            queue_updated_at AS queueUpdatedAt
          FROM mart.review_unassessed_queue_article_rank_serving_v4
          ORDER BY article_id
        \`)
        const indexes = await database.queryJson(\`
          SELECT index_name AS indexName
          FROM duckdb_indexes()
          WHERE index_name = 'idx_review_unassessed_queue_article_rank_serving_v4_order'
        \`)
        console.log(JSON.stringify({indexes, rows}))
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
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to verify queue article-rank migration',
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
      indexes: Array<{indexName: string}>
      rows: Array<{activitySortAt: string; articleId: string; priorityBucket: number; queueUpdatedAt: string}>
    }

    expect(parsed.indexes).toEqual([{indexName: 'idx_review_unassessed_queue_article_rank_serving_v4_order'}])
    // Rank ordering comes from the winning queue row; freshness tracks the latest prompt queue row for the article.
    expect(parsed.rows).toEqual([
      {
        activitySortAt: expect.stringContaining('10:00') as string,
        articleId: 'article-a',
        priorityBucket: 2,
        queueUpdatedAt: expect.stringContaining('11:10') as string,
      },
      {
        activitySortAt: expect.stringContaining('09:00') as string,
        articleId: 'article-b',
        priorityBucket: 1,
        queueUpdatedAt: expect.stringContaining('09:10') as string,
      },
    ])
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

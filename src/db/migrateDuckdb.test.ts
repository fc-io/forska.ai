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

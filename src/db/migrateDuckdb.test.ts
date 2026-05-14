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
  const runStatements: string[] = []

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          close: async () => {},
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
  } finally {
    mock.restore()
  }
})

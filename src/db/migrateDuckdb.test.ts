import {readdirSync, readFileSync} from 'node:fs'
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

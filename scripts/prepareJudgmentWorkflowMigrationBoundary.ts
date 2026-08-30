import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {migrateDuckdb} from '../src/db/migrateDuckdb.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'

const [databasePath] = process.argv.slice(2)

if (!databasePath) {
  throw new Error('Usage: bun scripts/prepareJudgmentWorkflowMigrationBoundary.ts <duckdb-path>')
}

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'fixtures', 'judgmentWorkflowMigrationBoundary.json'), 'utf8'),
) as {boundaryMigration: string; seedStatements: string[]}

process.env.DUCKDB_PATH = resolve(databasePath)
process.env.DUCKDB_TEMP_DIRECTORY = resolve(databasePath, '..', 'migration-prefix-spill')

try {
  await migrateDuckdb({throughFileName: manifest.boundaryMigration})
  for (const statement of manifest.seedStatements) {
    await getAppDatabaseService().run(statement)
  }
  const appliedMigrations = await getAppDatabaseService().queryJson<{name: string}>(`
    SELECT name
    FROM app_schema_migration
    WHERE name IN (
      '0089_dropProjectJudgmentModelForeignKeys.sql',
      '0090_comparisonServingAnswerFilterBooleans.sql'
    )
    ORDER BY name
  `)
  const [sentinel] = await getAppDatabaseService().queryJson<{
    completionTokens: number
    promptTokens: number
    requests: number
    totalTokens: number
  }>(`
    SELECT
      requests,
      CAST(total_prompt_tokens AS INTEGER) AS promptTokens,
      CAST(total_completion_tokens AS INTEGER) AS completionTokens,
      CAST(total_tokens AS INTEGER) AS totalTokens
    FROM app.token_use
    WHERE id = 'judgment-workflow-migration-boundary-v1'
  `)
  const [requestAttemptState] = await getAppDatabaseService().queryJson<{requestAttempts: string | null}>(`
    SELECT request_attempts_json AS requestAttempts
    FROM app.token_use
    WHERE id = 'judgment-workflow-migration-boundary-v1'
  `)

  if (
    appliedMigrations.length !== 1
    || appliedMigrations[0]?.name !== manifest.boundaryMigration
    || requestAttemptState?.requestAttempts !== null
    || sentinel?.requests !== 1
    || sentinel.promptTokens !== 11
    || sentinel.completionTokens !== 7
    || sentinel.totalTokens !== 18
  ) {
    throw new Error('Migration-boundary fixture did not stop at the declared deployed schema with its sentinel intact')
  }
} finally {
  await getAppDatabaseService().close({checkpointBeforeClose: true})
}

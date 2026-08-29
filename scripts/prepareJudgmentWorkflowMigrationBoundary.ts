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
} finally {
  await getAppDatabaseService().close({checkpointBeforeClose: true})
}

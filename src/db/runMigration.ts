import {readFileSync} from 'fs'
import {join} from 'path'
import {Client} from 'pg'

import {env} from '../server/utils/env.ts'

const runMigration = async (): Promise<void> => {
  const client = new Client({connectionString: env.DATABASE_URL})
  await client.connect()

  try {
    const migrationPath = join(import.meta.dir, 'migrations', '0002_fix_judgments_tables.sql')
    const migrationSQL = readFileSync(migrationPath, 'utf8')

    // Split by statement-breakpoint and execute each statement
    const statements = migrationSQL.split('--> statement-breakpoint').filter((s) => {
      return s.trim()
    })

    await client.query('BEGIN')

    for (const statement of statements) {
      const trimmedStatement = statement.trim()
      if (trimmedStatement) {
        console.log(`Executing: ${trimmedStatement.substring(0, 50)}...`)
        await client.query(trimmedStatement)
      }
    }

    await client.query('COMMIT')
    console.log('Migration completed successfully!')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Migration failed:', error)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

void runMigration()

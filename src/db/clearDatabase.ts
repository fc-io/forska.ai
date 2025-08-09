import {sql} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'

import * as authSchema from '../../auth-schema.ts'
import {env} from '../server/utils/env.ts'
import * as schema from './schema.ts'

const db = drizzle(env.DATABASE_URL, {
  schema: {...schema, ...authSchema},
  logger: true,
})

const clearDatabase = async () => {
  try {
    console.log('🗑️ Starting database drop...')

    // Drop all views first
    await db.execute(sql`DROP VIEW IF EXISTS project_stats CASCADE`)
    console.log('✅ Dropped view: project_stats')

    // Drop all tables with CASCADE to handle foreign key constraints
    const tables = [
      'token_use',
      'judgments',
      'prompts',
      'projects',
      'models',
      'articles',
      'session',
      'user',
      'account',
      'verification',
    ]

    const dropTable = async (tableName: string): Promise<void> => {
      try {
        await db.execute(sql.raw(`DROP TABLE IF EXISTS "${tableName}" CASCADE`))
        console.log(`✅ Dropped table: ${tableName}`)
      } catch (error) {
        console.log(`⚠️ Could not drop table ${tableName}:`, error)
      }
    }

    // Drop tables sequentially to avoid deadlocks with foreign key constraints
    for (const tableName of tables) {
      await dropTable(tableName)
    }

    // Drop enums
    await db.execute(sql`DROP TYPE IF EXISTS agent_judgment CASCADE`)
    await db.execute(sql`DROP TYPE IF EXISTS publication_status_enum CASCADE`)
    console.log('✅ Dropped enum types')

    console.log(
      '✅ Database cleared successfully! All tables and types removed.',
    )
    process.exit(0)
  } catch (error) {
    console.error('❌ Error clearing database:', error)
    process.exit(1)
  }
}

void clearDatabase()

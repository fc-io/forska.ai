/**
 * Setup script for ClickHouse MaterializedPostgreSQL replication.
 *
 * This script:
 * 1. Parses the PostgreSQL connection from DATABASE_URL
 * 2. Creates the `pg` database in ClickHouse with MaterializedPostgreSQL engine
 * 3. Creates the `forska_helpers` database for views/CTEs
 *
 * Run with: bun run scripts/setupClickHouseMaterializedPG.ts
 */
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'
import {env} from '../src/server/utils/env.ts'

const parseDatabaseUrl = (url: string) => {
  // Parse postgresql://user:password@host:port/database
  const parsed = new URL(url)

  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: parsed.pathname.slice(1), // Remove leading /
    username: parsed.username,
    password: parsed.password,
  }
}

const setupClickHouseMaterializedPG = async () => {
  console.log('[ClickHouse Setup] Starting MaterializedPostgreSQL setup...')

  // Parse PostgreSQL connection details
  const pgConfig = parseDatabaseUrl(env.DATABASE_URL)
  console.log('[ClickHouse Setup] PostgreSQL config:', {
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    username: 'ch_replicator', // We use the replication user, not the main user
  })

  // Get ClickHouse client
  const client = getClickhouseClient()

  // Check if ch_replicator password is set in environment
  const chReplicatorPassword = process.env['CH_REPLICATOR_PASSWORD']
  if (!chReplicatorPassword) {
    console.error('[ClickHouse Setup] ERROR: CH_REPLICATOR_PASSWORD environment variable not set')
    console.error('[ClickHouse Setup] Please set CH_REPLICATOR_PASSWORD to the password for the ch_replicator PostgreSQL user')
    process.exit(1)
  }

  // 1. Create MaterializedPostgreSQL database
  console.log('[ClickHouse Setup] Creating MaterializedPostgreSQL database...')
  console.log('[ClickHouse Setup] Note: Experimental MaterializedPostgreSQL engine is enabled via server config')

  const createPgDbQuery = `
    CREATE DATABASE IF NOT EXISTS pg ENGINE = MaterializedPostgreSQL(
      '${pgConfig.host}:${pgConfig.port}',
      '${pgConfig.database}',
      'ch_replicator',
      '${chReplicatorPassword}'
    ) SETTINGS
      materialized_postgresql_tables_list = 'articles,projects,project_prompts,judgments,project_articles,project_route_link,article_route_link,import_route'
  `

  try {
    await client.command({query: createPgDbQuery})
    console.log('[ClickHouse Setup] ✓ MaterializedPostgreSQL database "pg" created successfully')
    console.log('[ClickHouse Setup] Initial sync may take several minutes to hours depending on data volume...')
  } catch (error) {
    console.error('[ClickHouse Setup] ERROR creating MaterializedPostgreSQL database:', error)
    throw error
  }

  // 2. Create forska_helpers database for views/CTEs
  console.log('[ClickHouse Setup] Creating forska_helpers database...')

  try {
    await client.command({query: 'CREATE DATABASE IF NOT EXISTS forska_helpers'})
    console.log('[ClickHouse Setup] ✓ forska_helpers database created successfully')
  } catch (error) {
    console.error('[ClickHouse Setup] ERROR creating forska_helpers database:', error)
    throw error
  }

  // 3. Create helper views
  console.log('[ClickHouse Setup] Creating helper views...')

  const createScopedArticlesView = `
    CREATE OR REPLACE VIEW forska_helpers.scoped_articles AS
    SELECT project_id, article_id FROM pg.project_articles
    UNION DISTINCT
    SELECT prl.project_id, arl.article_id
    FROM pg.project_route_link prl
    JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id
    UNION DISTINCT
    SELECT prl.project_id, a.id AS article_id
    FROM pg.project_route_link prl
    JOIN pg.import_route ir ON prl.import_route_id = ir.id
    JOIN pg.articles a ON a.import_route = ir.route
  `

  try {
    await client.command({query: createScopedArticlesView})
    console.log('[ClickHouse Setup] ✓ forska_helpers.scoped_articles view created')
  } catch (error) {
    console.error('[ClickHouse Setup] ERROR creating scoped_articles view:', error)
    throw error
  }

  console.log('[ClickHouse Setup] ✓ Setup complete!')
  console.log('[ClickHouse Setup] Monitor sync progress with: SELECT database, table, total_rows FROM system.tables WHERE database = \'pg\'')
}

// Run setup
setupClickHouseMaterializedPG()
  .then(() => {
    console.log('[ClickHouse Setup] Done')
    process.exit(0)
  })
  .catch((error) => {
    console.error('[ClickHouse Setup] Fatal error:', error)
    process.exit(1)
  })

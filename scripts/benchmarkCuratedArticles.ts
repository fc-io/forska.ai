/**
 * Benchmark script comparing temp table vs pre-synced table approaches.
 * Run with: bun --env-file=.env.local scripts/benchmarkCuratedArticles.ts
 */
import {getDatabase} from '../src/server/utils/getDatabase.ts'
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'
import {projectArticles} from '../src/db/schema.ts'
import {eq} from 'drizzle-orm'

// Project with 93K curated articles
const TEST_PROJECT_ID = '38b2dfb7-a8bc-4dd0-922f-2bf6c46a2dc9'
const JUDGMENTS_TABLE = process.env.CH_USE_FINAL === 'false' ? 'judgments' : 'judgments FINAL'

const main = async () => {
  const db = getDatabase()
  const ch = getClickhouseClient()

  console.log('🔍 Benchmarking Curated Articles Approaches')
  console.log(`Project ID: ${TEST_PROJECT_ID}`)
  console.log('')

  // Step 1: Fetch curated article IDs from PostgreSQL
  console.time('1. Fetch IDs from PostgreSQL')
  const curatedRows = await db
    .select({articleId: projectArticles.articleId})
    .from(projectArticles)
    .where(eq(projectArticles.projectId, TEST_PROJECT_ID))
  console.timeEnd('1. Fetch IDs from PostgreSQL')
  console.log(`   Found ${curatedRows.length} curated articles`)
  console.log('')

  const curatedIds = curatedRows.map((r) => r.articleId)

  // ========================================
  // OPTION 1: Temporary Table Approach
  // ========================================
  console.log('=== OPTION 1: Temporary Table (per-request) ===')

  // Step 2: Create temp table and insert IDs
  const tempTableName = `temp_curated_${Date.now()}`

  console.time('2a. Create temp table')
  await ch.command({
    query: `CREATE TABLE ${tempTableName} (articleId String) ENGINE = Memory`,
  })
  console.timeEnd('2a. Create temp table')

  // Batch insert the IDs (ClickHouse client batches automatically)
  console.time('2b. Insert IDs to temp table')
  const insertValues = curatedIds.map((id) => ({articleId: id}))

  // Insert in batches of 10000
  const BATCH_SIZE = 10000
  for (let i = 0; i < insertValues.length; i += BATCH_SIZE) {
    const batch = insertValues.slice(i, i + BATCH_SIZE)
    await ch.insert({
      table: tempTableName,
      values: batch,
      format: 'JSONEachRow',
    })
  }
  console.timeEnd('2b. Insert IDs to temp table')

  // Step 3: Query using JOIN with temp table
  console.time('2c. Query with temp table JOIN')
  const result1 = await ch.query({
    query: `
      SELECT
        j.articleId,
        any(j.articleTitle) AS title_,
        any(j.articleCreatedAt) AS created_
      FROM ${JUDGMENTS_TABLE} AS j
      INNER JOIN ${tempTableName} t ON j.articleId = t.articleId
      WHERE j._peerdb_is_deleted = 0
        AND j.promptId IN (
        SELECT DISTINCT promptId FROM ${JUDGMENTS_TABLE} WHERE _peerdb_is_deleted = 0 LIMIT 2
      )
      GROUP BY j.articleId
      ORDER BY created_ DESC NULLS LAST
      LIMIT 10
    `,
    format: 'JSONEachRow',
  })
  const data1 = await result1.json()
  console.timeEnd('2c. Query with temp table JOIN')
  console.log(`   Returned ${data1.length} articles`)

  // Cleanup
  console.time('2d. Drop temp table')
  await ch.command({query: `DROP TABLE ${tempTableName}`})
  console.timeEnd('2d. Drop temp table')

  console.log('')

  // ========================================
  // Pre-calculate: Create a persistent table for comparison
  // ========================================
  console.log('=== SETUP: Create persistent project_articles table ===')

  // Create persistent table if not exists
  console.time('3a. Create persistent table')
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS project_articles_ch (
        projectId String,
        articleId String
      ) ENGINE = MergeTree()
      ORDER BY (projectId, articleId)
    `,
  })
  console.timeEnd('3a. Create persistent table')

  // Check if data already exists
  const existingCount = await ch.query({
    query: `SELECT count() as cnt FROM project_articles_ch WHERE projectId = '${TEST_PROJECT_ID}'`,
    format: 'JSONEachRow',
  })
  const existingData = await existingCount.json<{cnt: string}>()
  const existingRows = parseInt(existingData[0]?.cnt || '0', 10)

  if (existingRows < curatedIds.length) {
    console.time('3b. Sync data to persistent table')
    // Truncate and re-insert
    await ch.command({
      query: `ALTER TABLE project_articles_ch DELETE WHERE projectId = '${TEST_PROJECT_ID}'`,
    })

    // Insert in batches
    const insertData = curatedIds.map((id) => ({projectId: TEST_PROJECT_ID, articleId: id}))
    for (let i = 0; i < insertData.length; i += BATCH_SIZE) {
      const batch = insertData.slice(i, i + BATCH_SIZE)
      await ch.insert({
        table: 'project_articles_ch',
        values: batch,
        format: 'JSONEachRow',
      })
    }
    console.timeEnd('3b. Sync data to persistent table')
  } else {
    console.log(`   Data already synced (${existingRows} rows)`)
  }

  console.log('')

  // ========================================
  // OPTION 4: Pre-Synced Table Approach
  // ========================================
  console.log('=== OPTION 4: Pre-Synced Table (query only) ===')

  console.time('4. Query with pre-synced table JOIN')
  const result4 = await ch.query({
    query: `
      SELECT
        j.articleId,
        any(j.articleTitle) AS title_,
        any(j.articleCreatedAt) AS created_
      FROM ${JUDGMENTS_TABLE} AS j
      INNER JOIN project_articles_ch pa ON j.articleId = pa.articleId
      WHERE pa.projectId = '${TEST_PROJECT_ID}'
        AND j._peerdb_is_deleted = 0
        AND j.promptId IN (
          SELECT DISTINCT promptId FROM ${JUDGMENTS_TABLE} WHERE _peerdb_is_deleted = 0 LIMIT 2
        )
      GROUP BY j.articleId
      ORDER BY created_ DESC NULLS LAST
      LIMIT 10
    `,
    format: 'JSONEachRow',
  })
  const data4 = await result4.json()
  console.timeEnd('4. Query with pre-synced table JOIN')
  console.log(`   Returned ${data4.length} articles`)

  console.log('')
  console.log('=== SUMMARY ===')
  console.log('Option 1 (Temp table): Total = 2a + 2b + 2c + 2d')
  console.log('Option 4 (Pre-synced): Total = 4 only')
  console.log('')
  console.log('Option 4 eliminates per-request INSERT overhead.')

  process.exit(0)
}

main().catch(console.error)

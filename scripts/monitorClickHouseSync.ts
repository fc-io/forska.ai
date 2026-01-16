/**
 * Monitor ClickHouse MaterializedPostgreSQL sync progress.
 *
 * Polls the pg database to check if tables have been synced from PostgreSQL.
 * Run with: bun run scripts/monitorClickHouseSync.ts
 */
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'

const monitorSync = async () => {
  console.log('[CH Sync Monitor] Monitoring MaterializedPostgreSQL sync progress...')

  const client = getClickhouseClient()

  const expectedTables = [
    'articles',
    'projects',
    'project_prompts',
    'judgments',
    'project_articles',
    'project_route_link',
    'article_route_link',
    'import_route',
  ]

  const checkInterval = 5000 // 5 seconds
  let previousRowCounts = new Map<string, number>()

  const pollRecursive = async (attempt: number): Promise<void> => {
    const query = `SELECT table, total_rows FROM system.tables WHERE database = 'pg' ORDER BY table`

    const result = await client.query({query})
    const tables = (await result.json()) as { data: Array<{ table: string; total_rows: string }> }

    const syncedTables = tables.data.map((row) => {
      return row.table
    })
    const syncedCount = syncedTables.length

    console.log(`\n[Attempt ${attempt}] Synced ${syncedCount}/${expectedTables.length} tables`)

    if (syncedCount === 0) {
      console.log('  No tables synced yet...')
    } else {
      tables.data.forEach((row) => {
        const rowCount = parseInt(row.total_rows, 10)
        const prevCount = previousRowCounts.get(row.table) ?? 0
        const delta = rowCount - prevCount
        const deltaStr = delta > 0 ? ` (+${delta})` : ''

        console.log(`  ✓ ${row.table}: ${rowCount.toLocaleString()} rows${deltaStr}`)
        previousRowCounts.set(row.table, rowCount)
      })

      const missing = expectedTables.filter((t) => {
        return !syncedTables.includes(t)
      })
      if (missing.length > 0) {
        console.log(`  ⏳ Waiting for: ${missing.join(', ')}`)
      }
    }

    if (syncedCount < expectedTables.length) {
      await new Promise((resolve) => {
        return setTimeout(resolve, checkInterval)
      })
      return pollRecursive(attempt + 1)
    }

    console.log('\n[CH Sync Monitor] ✓ All tables synced!')
    return Promise.resolve()
  }

  return pollRecursive(1)
}

monitorSync()
  .then(() => {
    console.log('[CH Sync Monitor] Monitoring complete')
    process.exit(0)
  })
  .catch((error) => {
    console.error('[CH Sync Monitor] Fatal error:', error)
    process.exit(1)
  })

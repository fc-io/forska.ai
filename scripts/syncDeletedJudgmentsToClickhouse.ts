/**
 * Sync deleted judgments from PostgreSQL to ClickHouse
 * Run with: bun run scripts/syncDeletedJudgmentsToClickhouse.ts
 */
import {isNotNull} from 'drizzle-orm'

import {judgments} from '../src/db/schema.ts'
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'
import {getDatabase} from '../src/server/utils/getDatabase.ts'

const CLICKHOUSE_DELETE_BATCH_SIZE = 1000

const deleteClickhouseJudgments = async (ids: string[]): Promise<void> => {
  const uniqueIds = [...new Set(ids)].filter((id) => {
    return typeof id === 'string' && id.length > 0
  })

  if (uniqueIds.length === 0) return

  const client = getClickhouseClient()

  const deleteRecursive = async (offset: number): Promise<void> => {
    const batch = uniqueIds.slice(offset, offset + CLICKHOUSE_DELETE_BATCH_SIZE)

    if (batch.length === 0) {
      return
    }

    await client.command({
      query: 'ALTER TABLE forska.judgments DELETE WHERE id IN ({ids:Array(String)})',
      query_params: {ids: batch},
    })

    return deleteRecursive(offset + CLICKHOUSE_DELETE_BATCH_SIZE)
  }

  return deleteRecursive(0)
}

const syncDeletedJudgments = async () => {
  const db = getDatabase()

  console.log('[Sync] Fetching deleted judgments from PostgreSQL...')

  const deletedJudgments = await db
    .select({id: judgments.id})
    .from(judgments)
    .where(isNotNull(judgments.deletedAt))

  console.log(`[Sync] Found ${deletedJudgments.length} deleted judgments in PostgreSQL`)

  if (deletedJudgments.length === 0) {
    console.log('[Sync] Nothing to sync')
    return
  }

  const idsToDelete = deletedJudgments.map((j) => {
    return j.id
  })
  await deleteClickhouseJudgments(idsToDelete)
  console.log(`[Sync] Done! Enqueued ${idsToDelete.length} deletes in ClickHouse.`)
}

syncDeletedJudgments()
  .then(() => {
    console.log('[Sync] Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('[Sync] Failed:', error)
    process.exit(1)
  })

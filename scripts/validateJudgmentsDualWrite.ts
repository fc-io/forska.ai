/**
 * Validates Phase 5 dual-write by comparing PostgreSQL and ClickHouse.
 *
 * Usage: bun scripts/validateJudgmentsDualWrite.ts
 *
 * Options:
 *   SAMPLE_SIZE=200 - number of most-recent judgment IDs to verify in ClickHouse
 */

import {sql} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'
import pg from 'pg'

import {env} from '../src/server/utils/env'
import {getClickhouseClient, pingClickhouse} from '../src/services/clickhouse/clickhouseClient'

const SAMPLE_SIZE = parseInt(process.env.SAMPLE_SIZE ?? '200', 10)

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

const pool = new pg.Pool({connectionString: env.DATABASE_URL, max: 2})
const db = drizzle(pool, {logger: false})

const getPostgresStats = async (): Promise<{count: number; maxCreatedAt: Date | null}> => {
  const result = await db.execute<{count: string; max_created_at: Date | null}>(sql`
    SELECT COUNT(*) AS count, MAX(created_at) AS max_created_at
    FROM judgments
    WHERE deleted_at IS NULL
  `)
  const row = result.rows[0]
  return {
    count: parseInt(row?.count ?? '0', 10),
    maxCreatedAt: row?.max_created_at ? new Date(row.max_created_at) : null,
  }
}

const getRecentJudgmentIds = async (limit: number): Promise<string[]> => {
  const result = await db.execute<{id: string}>(sql`
    SELECT id::text AS id
    FROM judgments
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)
  return result.rows
    .map((row) => {
      return row.id
    })
    .filter((id): id is string => {
      return Boolean(id)
    })
}

const getClickhouseStats = async (): Promise<{reachable: boolean; count: number | null; maxCreatedAt: Date | null}> => {
  const reachable = await pingClickhouse()
  if (!reachable) {
    return {reachable: false, count: null, maxCreatedAt: null}
  }

  const client = getClickhouseClient()
  const result = await client.query({
    query: `SELECT count() AS count, max(createdAt) AS maxCreatedAt FROM judgments WHERE deletedAt IS NULL`,
    format: 'JSONEachRow',
  })
  const [row] = await result.json<{count: number; maxCreatedAt: string | null}>()
  const maxCreatedAt = row?.maxCreatedAt ? new Date(row.maxCreatedAt) : null
  return {reachable: true, count: row?.count ?? 0, maxCreatedAt}
}

const escapeClickHouseString = (value: string): string => {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

const getClickhousePresenceCount = async (ids: string[]): Promise<number | null> => {
  const reachable = await pingClickhouse()
  if (!reachable) return null
  if (ids.length === 0) return 0

  const quoted = ids
    .map((id) => {
      return `'${escapeClickHouseString(id)}'`
    })
    .join(', ')

  const client = getClickhouseClient()
  const result = await client.query({
    query: `SELECT count() AS count FROM judgments WHERE deletedAt IS NULL AND id IN (${quoted})`,
    format: 'JSONEachRow',
  })
  const [row] = await result.json<{count: number}>()
  return row?.count ?? 0
}

const main = async (): Promise<void> => {
  log('=== Phase 5 Dual-Write Validation ===')
  log(`SAMPLE_SIZE=${SAMPLE_SIZE}`)

  const [pgStats, chStats] = await Promise.all([getPostgresStats(), getClickhouseStats()])

  log(
    `PostgreSQL: count=${pgStats.count.toLocaleString()} maxCreatedAt=${pgStats.maxCreatedAt?.toISOString() ?? 'null'}`,
  )
  log(
    `ClickHouse: reachable=${chStats.reachable} count=${chStats.count?.toLocaleString() ?? 'null'} maxCreatedAt=${
      chStats.maxCreatedAt?.toISOString() ?? 'null'
    }`,
  )

  const lagMs =
    pgStats.maxCreatedAt && chStats.maxCreatedAt
      ? pgStats.maxCreatedAt.getTime() - chStats.maxCreatedAt.getTime()
      : null
  log(`Ingestion lag (pg max - ch max): ${lagMs != null ? `${lagMs}ms` : 'null'}`)

  const ids = await getRecentJudgmentIds(SAMPLE_SIZE)
  const present = await getClickhousePresenceCount(ids)
  log(`Recent ID presence in ClickHouse: ${present != null ? `${present}/${ids.length}` : 'clickhouse unreachable'}`)

  await pool.end()
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

/**
 * FAST Backfill PostgreSQL judgments to Parquet files in S3 (SeaweedFS/Ceph RGW)
 *
 * Optimized version with:
 * - Keyset pagination (cursor-based) instead of OFFSET
 * - Parallel writing: fetch next batch while writing current
 * - Larger batch sizes by default (50,000)
 * - Multiple DB connections for parallel fetching
 *
 * Usage: bun scripts/backfillPostgresToParquetFast.ts
 *
 * Options (via env vars):
 *   LIMIT=0               - Number of rows to process (default: 0 = ALL)
 *   BATCH_SIZE=50000      - Number of rows per Parquet file (default: 50000)
 *   DRY_RUN=true          - Preview without writing to S3
 *   AFTER_ID=             - Resume from this judgment ID (keyset pagination)
 *   PARALLEL_WRITERS=3    - Number of parallel Parquet write operations
 *
 * Required env vars for S3:
 *   S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET
 */

import {sql} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'
import pg from 'pg'

import {env} from '../src/server/utils/env'
import {writeBatch} from '../src/services/parquet/parquetWriter'
import type {DenormalizedJudgmentAnalytics} from '../src/services/parquet/types'
import {ensureBucket, getS3Config} from '../src/services/s3/s3Client'

// Configuration
const LIMIT = parseInt(process.env.LIMIT ?? '0', 10) // 0 = no limit
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '50000', 10)
const DRY_RUN = process.env.DRY_RUN === 'true'
const AFTER_ID = process.env.AFTER_ID ?? '' // Resume from this ID
const PARALLEL_WRITERS = parseInt(process.env.PARALLEL_WRITERS ?? '3', 10)

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

// Database connection with higher pool size for parallel fetching
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 5, // Increased for parallel operations
})

const db = drizzle(pool, {logger: false})

/**
 * Get total count of judgments to process
 */
const getTotalCount = async (afterId?: string): Promise<number> => {
  if (afterId) {
    const result = await db.execute<{count: string}>(sql`
      SELECT COUNT(*) as count FROM judgments
      WHERE deleted_at IS NULL AND id > ${afterId}::uuid
    `)
    return parseInt(result.rows[0]?.count ?? '0', 10)
  }
  const result = await db.execute<{count: string}>(sql`
    SELECT COUNT(*) as count FROM judgments WHERE deleted_at IS NULL
  `)
  return parseInt(result.rows[0]?.count ?? '0', 10)
}

/**
 * Fetch a batch of judgments using keyset pagination (much faster than OFFSET)
 */
const fetchBatch = async (afterId: string | null, limit: number): Promise<DenormalizedJudgmentAnalytics[]> => {
  // Use keyset pagination: WHERE id > last_seen_id ORDER BY id
  // This is O(1) vs O(n) for OFFSET
  const result = await db.execute<{
    id: string
    created_at: Date
    deleted_at: Date | null
    article_id: string
    article_title: string | null
    article_created_at: Date | null
    article_updated_at: Date | null
    article_created_year: number | null
    article_updated_year: number | null
    article_import_route: string | null
    article_imported_by: string | null
    prompt_id: string
    model_id: string
    answered_original: string | null
    answered_original_as_array: string[] | null
    explanation: string | null
    quotes: unknown
  }>(
    afterId
      ? sql`
      SELECT
        j.id::text,
        j.created_at,
        j.deleted_at,
        j.article_id::text,
        COALESCE(j.article_title, a.article_title) as article_title,
        COALESCE(j.article_created_at, a.article_created_at) as article_created_at,
        COALESCE(j.article_updated_at, a.article_updated_at) as article_updated_at,
        COALESCE(j.article_created_year, EXTRACT(YEAR FROM a.article_created_at)::integer) as article_created_year,
        COALESCE(j.article_updated_year, EXTRACT(YEAR FROM a.article_updated_at)::integer) as article_updated_year,
        COALESCE(j.article_import_route, a.import_route) as article_import_route,
        COALESCE(j.article_imported_by, a.imported_by) as article_imported_by,
        j.prompt_id::text,
        j.model_id::text,
        j.answered_original,
        j.answered_original_as_array,
        j.explanation,
        j.quotes
      FROM judgments j
      LEFT JOIN articles a ON j.article_id = a.id
      WHERE j.deleted_at IS NULL AND j.id > ${afterId}::uuid
      ORDER BY j.id ASC
      LIMIT ${limit}
    `
      : sql`
      SELECT
        j.id::text,
        j.created_at,
        j.deleted_at,
        j.article_id::text,
        COALESCE(j.article_title, a.article_title) as article_title,
        COALESCE(j.article_created_at, a.article_created_at) as article_created_at,
        COALESCE(j.article_updated_at, a.article_updated_at) as article_updated_at,
        COALESCE(j.article_created_year, EXTRACT(YEAR FROM a.article_created_at)::integer) as article_created_year,
        COALESCE(j.article_updated_year, EXTRACT(YEAR FROM a.article_updated_at)::integer) as article_updated_year,
        COALESCE(j.article_import_route, a.import_route) as article_import_route,
        COALESCE(j.article_imported_by, a.imported_by) as article_imported_by,
        j.prompt_id::text,
        j.model_id::text,
        j.answered_original,
        j.answered_original_as_array,
        j.explanation,
        j.quotes
      FROM judgments j
      LEFT JOIN articles a ON j.article_id = a.id
      WHERE j.deleted_at IS NULL
      ORDER BY j.id ASC
      LIMIT ${limit}
    `,
  )

  return result.rows.map((row) => {
    return {
      id: row.id,
      createdAt: new Date(row.created_at),
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      articleId: row.article_id,
      articleTitle: row.article_title,
      articleCreatedAt: row.article_created_at ? new Date(row.article_created_at) : null,
      articleUpdatedAt: row.article_updated_at ? new Date(row.article_updated_at) : null,
      articleCreatedYear: row.article_created_year,
      articleUpdatedYear: row.article_updated_year,
      articleImportRoute: row.article_import_route,
      articleImportedBy: row.article_imported_by,
      promptId: row.prompt_id,
      modelId: row.model_id,
      useTitle: false,
      useAbstract: false,
      useFulltext: false,
      useFulltextNoImages: false,
      answeredOriginal: row.answered_original,
      answeredOriginalAsArray: row.answered_original_as_array,
      explanation: row.explanation,
      quotes: row.quotes ? JSON.stringify(row.quotes) : null,
    }
  })
}

/**
 * Write batch with concurrency control
 */
class ParallelWriter {
  private queue: Promise<string>[] = []
  private writtenFiles: string[] = []
  private maxConcurrency: number

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency
  }

  async submit(batch: DenormalizedJudgmentAnalytics[], dryRun: boolean): Promise<void> {
    // Wait if we've hit max concurrency
    while (this.queue.length >= this.maxConcurrency) {
      await Promise.race(this.queue)
    }

    if (dryRun) {
      log(`[DRY RUN] Would write ${batch.length} records to Parquet`)
      return
    }

    const writePromise = writeBatch(batch).then((key) => {
      this.writtenFiles.push(key)
      return key
    })

    // Add to queue and set up cleanup when done
    this.queue.push(writePromise)
    writePromise.finally(() => {
      this.queue = this.queue.filter((p) => p !== writePromise)
    })
  }

  async flush(): Promise<void> {
    await Promise.all(this.queue)
  }

  getWrittenFiles(): string[] {
    return this.writtenFiles
  }
}

/**
 * Main backfill function
 */
const main = async () => {
  log('=== PostgreSQL → Parquet FAST Backfill ===')
  log(`Configuration:`)
  log(`  LIMIT: ${LIMIT === 0 ? 'ALL' : LIMIT}`)
  log(`  BATCH_SIZE: ${BATCH_SIZE}`)
  log(`  DRY_RUN: ${DRY_RUN}`)
  log(`  AFTER_ID: ${AFTER_ID || '(start from beginning)'}`)
  log(`  PARALLEL_WRITERS: ${PARALLEL_WRITERS}`)

  // Validate S3 config
  try {
    const s3Config = getS3Config()
    log(`  S3_ENDPOINT: ${s3Config.endpoint}`)
    log(`  S3_BUCKET: ${s3Config.bucket}`)

    if (!DRY_RUN) {
      await ensureBucket(s3Config.bucket)
      log(`  Bucket '${s3Config.bucket}' ready`)
    }
  } catch (error) {
    log(`ERROR: S3 configuration missing. Set S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET`)
    throw error
  }

  // Get total count
  const totalInDb = await getTotalCount(AFTER_ID || undefined)
  log(`Total judgments to process: ${totalInDb.toLocaleString()}`)

  const totalToProcess = LIMIT === 0 ? totalInDb : Math.min(LIMIT, totalInDb)
  log(`Rows to process: ${totalToProcess.toLocaleString()}`)

  if (totalToProcess <= 0) {
    log('No rows to process.')
    await pool.end()
    return
  }

  // Process in batches with parallel writing
  const startTime = Date.now()
  let processedRows = 0
  let lastId = AFTER_ID || null
  const writer = new ParallelWriter(PARALLEL_WRITERS)

  // Pre-fetch first batch
  let currentBatch = await fetchBatch(lastId, Math.min(BATCH_SIZE, totalToProcess))
  let fetchTime = 0
  let writeTime = 0

  while (currentBatch.length > 0 && processedRows < totalToProcess) {
    const batchStartTime = Date.now()

    // Get the last ID for the next fetch
    const lastRecord = currentBatch[currentBatch.length - 1]
    if (!lastRecord) break
    lastId = lastRecord.id

    // Start fetching next batch in parallel with writing
    const remainingToProcess = totalToProcess - processedRows - currentBatch.length
    const nextBatchSize = Math.min(BATCH_SIZE, remainingToProcess)
    const nextBatchPromise = nextBatchSize > 0 ? fetchBatch(lastId, nextBatchSize) : Promise.resolve([])

    // Write current batch (non-blocking if within parallelism limit)
    const writeStart = Date.now()
    await writer.submit(currentBatch, DRY_RUN)
    writeTime += Date.now() - writeStart

    processedRows += currentBatch.length

    // Wait for next batch
    const fetchStart = Date.now()
    currentBatch = await nextBatchPromise
    fetchTime += Date.now() - fetchStart

    // Progress log
    const elapsed = (Date.now() - startTime) / 1000
    const rate = processedRows / elapsed
    const remaining = totalToProcess - processedRows
    const eta = remaining / rate

    log(
      `Progress: ${processedRows.toLocaleString()}/${totalToProcess.toLocaleString()} ` +
        `(${((processedRows / totalToProcess) * 100).toFixed(1)}%) | ` +
        `Files: ${writer.getWrittenFiles().length} | ` +
        `Rate: ${rate.toFixed(0)}/s | ETA: ${formatDuration(eta)} | ` +
        `Last ID: ${lastId?.slice(0, 8)}...`,
    )
  }

  // Wait for all writes to complete
  await writer.flush()
  const writtenFiles = writer.getWrittenFiles()

  // Summary
  const totalTime = (Date.now() - startTime) / 1000
  log('')
  log('=== Backfill Complete ===')
  log(`Processed: ${processedRows.toLocaleString()} rows`)
  log(`Parquet files written: ${writtenFiles.length}`)
  log(`Total time: ${formatDuration(totalTime)}`)
  log(`Average rate: ${(processedRows / totalTime).toFixed(0)} rows/s`)
  log(`Fetch time: ${formatDuration(fetchTime / 1000)} | Write time: ${formatDuration(writeTime / 1000)}`)

  if (writtenFiles.length > 0) {
    log('')
    log('=== Verifying Parquet Files ===')
    log(`First file: s3://${getS3Config().bucket}/${writtenFiles[0]}`)
    log(`Last file: s3://${getS3Config().bucket}/${writtenFiles[writtenFiles.length - 1]}`)
    log('')
    log('To inspect the data, use:')
    log(`  duckdb -c "SELECT * FROM read_parquet('./data/seaweedfs/${writtenFiles[0]}') LIMIT 10"`)
  }

  if (lastId) {
    log('')
    log('=== Resume Information ===')
    log(`To resume from where we left off, run with:`)
    log(`  AFTER_ID=${lastId} bun scripts/backfillPostgresToParquetFast.ts`)
  }

  await pool.end()
}

main().catch(async (err) => {
  console.error('Backfill failed:', err)
  await pool.end()
  process.exit(1)
})

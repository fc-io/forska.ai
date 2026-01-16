/**
 * Backfill PostgreSQL judgments to Parquet files in S3 (SeaweedFS/Ceph RGW)
 *
 * This script reads judgments from PostgreSQL, denormalizes them with article metadata,
 * and writes Parquet files to S3 for ClickHouse ingestion.
 *
 * Usage: bun scripts/backfillPostgresToParquet.ts
 *
 * Options (via env vars):
 *   LIMIT=1000           - Number of rows to process (default: 1000 for testing, set to 0 for all)
 *   BATCH_SIZE=5000      - Number of rows per Parquet file (default: 5000)
 *   DRY_RUN=true         - Preview without writing to S3
 *   OFFSET=0             - Start from this offset (for resuming)
 *
 * Required env vars for S3:
 *   S3_ENDPOINT          - S3 endpoint URL (e.g., http://localhost:8333)
 *   S3_ACCESS_KEY        - S3 access key
 *   S3_SECRET_KEY        - S3 secret key
 *   S3_BUCKET            - S3 bucket name (e.g., forska-judgments)
 *
 * Verifying Parquet files (see output after script runs for exact paths):
 *   1. DuckDB: duckdb -c "SELECT ... FROM read_parquet('./data/seaweedfs/...') LIMIT 10"
 *   2. Python: df = pd.read_parquet('./data/seaweedfs/...')
 *   3. ClickHouse: SELECT ... FROM judgments LIMIT 10 (after S3Queue setup)
 */

import {sql} from 'drizzle-orm'
import {drizzle} from 'drizzle-orm/node-postgres'
import pg from 'pg'

import {env} from '../src/server/utils/env'
import {writeBatch} from '../src/services/parquet/parquetWriter'
import type {DenormalizedJudgmentAnalytics} from '../src/services/parquet/types'
import {ensureBucket, getS3Config} from '../src/services/s3/s3Client'

// Configuration
const LIMIT = parseInt(process.env.LIMIT ?? '1000', 10) // 0 = no limit
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '5000', 10)
const DRY_RUN = process.env.DRY_RUN === 'true'
const OFFSET = parseInt(process.env.OFFSET ?? '0', 10)

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

// Database connection
const pool = new pg.Pool({connectionString: env.DATABASE_URL, max: 2})

const db = drizzle(pool, {logger: false})

/**
 * Get total count of judgments to process
 */
const getTotalCount = async (): Promise<number> => {
  const result = await db.execute<{count: string}>(sql`
    SELECT COUNT(*) as count FROM judgments WHERE deleted_at IS NULL
  `)
  return parseInt(result.rows[0]?.count ?? '0', 10)
}

/**
 * Fetch a batch of judgments with article metadata
 */
const fetchBatch = async (offset: number, limit: number): Promise<DenormalizedJudgmentAnalytics[]> => {
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
    use_title: boolean
    use_abstract: boolean
    use_fulltext: boolean
    use_fulltext_no_images: boolean
    answered_original: string | null
    answered_original_as_array: string[] | null
    explanation: string | null
    quotes: unknown
  }>(sql`
    SELECT
      j.id::text,
      j.created_at,
      j.deleted_at,
      j.article_id::text,
      a.article_title as article_title,
      a.article_created_at as article_created_at,
      a.article_updated_at as article_updated_at,
      EXTRACT(YEAR FROM a.article_created_at)::integer as article_created_year,
      EXTRACT(YEAR FROM a.article_updated_at)::integer as article_updated_year,
      a.import_route as article_import_route,
      a.imported_by as article_imported_by,
      j.prompt_id::text,
      j.model_id::text,
      j.use_title,
      j.use_abstract,
      j.use_fulltext,
      j.use_fulltext_no_images,
      j.answered_original,
      j.answered_original_as_array,
      j.explanation,
      j.quotes
    FROM judgments j
    LEFT JOIN articles a ON j.article_id = a.id
    WHERE j.deleted_at IS NULL
    ORDER BY j.created_at ASC
    OFFSET ${offset}
    LIMIT ${limit}
  `)

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
      useTitle: row.use_title ?? true,
      useAbstract: row.use_abstract ?? true,
      useFulltext: row.use_fulltext ?? false,
      useFulltextNoImages: row.use_fulltext_no_images ?? false,
      answeredOriginal: row.answered_original,
      answeredOriginalAsArray: row.answered_original_as_array,
      explanation: row.explanation,
      quotes: row.quotes ? JSON.stringify(row.quotes) : null,
    }
  })
}

/**
 * Main backfill function
 */
const main = async () => {
  log('=== PostgreSQL → Parquet Backfill ===')
  log(`Configuration:`)
  log(`  LIMIT: ${LIMIT === 0 ? 'ALL' : LIMIT}`)
  log(`  BATCH_SIZE: ${BATCH_SIZE}`)
  log(`  DRY_RUN: ${DRY_RUN}`)
  log(`  OFFSET: ${OFFSET}`)

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
  const totalInDb = await getTotalCount()
  log(`Total judgments in PostgreSQL: ${totalInDb.toLocaleString()}`)

  const totalToProcess = LIMIT === 0 ? totalInDb - OFFSET : Math.min(LIMIT, totalInDb - OFFSET)
  log(`Rows to process: ${totalToProcess.toLocaleString()} (starting from offset ${OFFSET})`)

  if (totalToProcess <= 0) {
    log('No rows to process.')
    await pool.end()
    return
  }

  // Process in batches
  const startTime = Date.now()
  let processedRows = 0
  let writtenFiles: string[] = []
  let currentOffset = OFFSET

  while (processedRows < totalToProcess) {
    const batchLimit = Math.min(BATCH_SIZE, totalToProcess - processedRows)
    const batch = await fetchBatch(currentOffset, batchLimit)

    if (batch.length === 0) {
      log('No more rows to fetch.')
      break
    }

    if (DRY_RUN) {
      log(`[DRY RUN] Would write ${batch.length} records to Parquet`)
    } else {
      const key = await writeBatch(batch)
      writtenFiles.push(key)
    }

    processedRows += batch.length
    currentOffset += batch.length

    // Progress log
    const elapsed = (Date.now() - startTime) / 1000
    const rate = processedRows / elapsed
    const remaining = totalToProcess - processedRows
    const eta = remaining / rate

    log(
      `Progress: ${processedRows.toLocaleString()}/${totalToProcess.toLocaleString()} `
        + `(${((processedRows / totalToProcess) * 100).toFixed(1)}%) | `
        + `Files: ${writtenFiles.length} | `
        + `Rate: ${rate.toFixed(0)}/s | ETA: ${formatDuration(eta)}`,
    )
  }

  // Summary
  const totalTime = (Date.now() - startTime) / 1000
  log('')
  log('=== Backfill Complete ===')
  log(`Processed: ${processedRows.toLocaleString()} rows`)
  log(`Parquet files written: ${writtenFiles.length}`)
  log(`Total time: ${formatDuration(totalTime)}`)
  log(`Average rate: ${(processedRows / totalTime).toFixed(0)} rows/s`)

  if (writtenFiles.length > 0) {
    log('')
    log('=== Verifying Parquet Files ===')
    log('Files written:')
    writtenFiles.forEach((f) => {
      return log(`  - s3://${getS3Config().bucket}/${f}`)
    })
    log('')
    log('To inspect the data, use one of these methods:')
    log('')
    log('1. DuckDB (recommended):')
    log(`   duckdb -c "SELECT * FROM read_parquet('./data/seaweedfs/${writtenFiles[0]}') LIMIT 10"`)
    log('')
    log('2. ClickHouse (after S3Queue setup):')
    log(`   SELECT * FROM judgments LIMIT 10`)
    log('')
    log('3. Python + pandas:')
    log(`   import pandas as pd; df = pd.read_parquet('./data/seaweedfs/${writtenFiles[0]}'); print(df.head())`)
  }

  await pool.end()
}

main().catch(async (err) => {
  console.error('Backfill failed:', err)
  await pool.end()
  process.exit(1)
})

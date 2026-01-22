/**
 * Backfill script for S3Queue files that were processed with 0 rows due to schema mismatch.
 *
 * The S3Queue table expected DateTime64(6) but Parquet files had DateTime64(3).
 * This script reads ALL files via s3() function and inserts into judgments.
 * ReplacingMergeTree will deduplicate existing records.
 *
 * Usage: bun --env-file=.env.local scripts/backfillFailedS3QueueFiles.ts
 */

import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient'

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

const getFailedFileCount = async (): Promise<number> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `SELECT count(*) as cnt FROM system.s3queue WHERE rows_processed = 0`,
    format: 'JSONEachRow',
  })
  const [row] = await result.json<{cnt: number}>()
  return row?.cnt ?? 0
}

const getS3FileCount = async (): Promise<number> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `SELECT count(*) as cnt FROM s3('http://seaweedfs:8333/forska-judgments/judgments/**/*.parquet', 'admin', 'admin', 'Parquet')`,
    format: 'JSONEachRow',
  })
  const [row] = await result.json<{cnt: number}>()
  return row?.cnt ?? 0
}

const backfillAllFiles = async (): Promise<void> => {
  const client = getClickhouseClient()

  log('Reading all Parquet files and inserting into judgments table...')
  log('(ReplacingMergeTree will deduplicate existing records)')

  // Read all files via s3() and insert into judgments table
  // The timestamps are in milliseconds, multiply by 1000 for microseconds
  const insertQuery = `
    INSERT INTO forska.judgments
    SELECT
      coalesce(id, '') AS id,
      coalesce(createdAt, now64(6)) AS createdAt,
      deletedAt,
      coalesce(articleId, '') AS articleId,
      coalesce(articleTitle, '') AS articleTitle,
      articleCreatedAt,
      articleUpdatedAt,
      articleCreatedYear,
      articleUpdatedYear,
      articleImportRoute,
      articleImportedBy,
      coalesce(promptId, '') AS promptId,
      coalesce(modelId, '') AS modelId,
      coalesce(useTitle, true) AS useTitle,
      coalesce(useAbstract, true) AS useAbstract,
      coalesce(useFulltext, false) AS useFulltext,
      coalesce(useFulltextNoImages, false) AS useFulltextNoImages,
      answeredOriginal,
      answeredOriginalAsArray,
      explanation,
      quotes
    FROM s3(
      'http://seaweedfs:8333/forska-judgments/judgments/**/*.parquet',
      'admin',
      'admin',
      'Parquet'
    )
  `

  await client.command({query: insertQuery, clickhouse_settings: {max_execution_time: 3600}})
  log('Insert complete')
}

const getJudgmentsCount = async (): Promise<number> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `SELECT count(*) as cnt FROM forska.judgments WHERE deletedAt IS NULL`,
    format: 'JSONEachRow',
  })
  const [row] = await result.json<{cnt: number}>()
  return row?.cnt ?? 0
}

const optimizeTable = async (): Promise<void> => {
  const client = getClickhouseClient()
  log('Running OPTIMIZE FINAL to deduplicate...')
  await client.command({
    query: `OPTIMIZE TABLE forska.judgments FINAL`,
    clickhouse_settings: {max_execution_time: 3600},
  })
  log('Optimize complete')
}

const main = async (): Promise<void> => {
  log('=== S3Queue Failed Files Backfill ===')

  const failedCount = await getFailedFileCount()
  log(`Files with 0 rows in S3Queue: ${failedCount}`)

  const s3RowCount = await getS3FileCount()
  log(`Total rows in S3 Parquet files: ${s3RowCount.toLocaleString()}`)

  const beforeCount = await getJudgmentsCount()
  log(`Judgments count before: ${beforeCount.toLocaleString()}`)

  if (failedCount === 0) {
    log('No failed files to backfill')
    return
  }

  await backfillAllFiles()
  await optimizeTable()

  const afterCount = await getJudgmentsCount()
  log(`Judgments count after: ${afterCount.toLocaleString()}`)
  log(`Net change: ${(afterCount - beforeCount).toLocaleString()}`)

  log('=== Backfill complete ===')
}

void main().catch((error) => {
  console.error('Backfill failed:', error)
  process.exit(1)
})

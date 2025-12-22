/**
 * Parquet Writer Service
 *
 * Writes denormalized judgment analytics to Parquet files in S3 (SeaweedFS/Ceph RGW).
 *
 * File structure: {bucket}/{prefix}/year=YYYY/month=MM/{ulid}.parquet
 *
 * The Parquet schema matches the DenormalizedJudgmentAnalytics interface and is
 * designed for ingestion by ClickHouse's S3Queue engine.
 */

import {ParquetSchema, ParquetWriter, type WriterOptions} from '@dsnp/parquetjs'
import {ulid} from 'ulid'

import {ensureBucket, getS3Config, uploadToS3} from '../s3/s3Client'
import type {DenormalizedJudgmentAnalytics, ParquetWriterConfig} from './types'

/**
 * Parquet schema for DenormalizedJudgmentAnalytics.
 *
 * Maps TypeScript types to Parquet logical types:
 * - string -> UTF8
 * - Date -> TIMESTAMP_MILLIS
 * - number -> INT32
 * - string[] -> LIST of UTF8
 * - nullable fields use optional: true
 */
export const judgmentAnalyticsSchema = new ParquetSchema({
  id: {type: 'UTF8'},
  createdAt: {type: 'TIMESTAMP_MILLIS'},
  deletedAt: {type: 'TIMESTAMP_MILLIS', optional: true},

  // Article dimensions
  articleId: {type: 'UTF8'},
  articleTitle: {type: 'UTF8', optional: true},
  articleCreatedAt: {type: 'TIMESTAMP_MILLIS', optional: true},
  articleUpdatedAt: {type: 'TIMESTAMP_MILLIS', optional: true},
  articleCreatedYear: {type: 'INT32', optional: true},
  articleUpdatedYear: {type: 'INT32', optional: true},
  articleImportRoute: {type: 'UTF8', optional: true},
  articleImportedBy: {type: 'UTF8', optional: true},

  // Prompt/Model dimensions
  promptId: {type: 'UTF8'},
  modelId: {type: 'UTF8'},

  // Answer data
  answeredOriginal: {type: 'UTF8', optional: true},
  // For array columns, we use a repeated UTF8 field (Parquet LIST)
  answeredOriginalAsArray: {type: 'UTF8', repeated: true, optional: true},

  // Large text fields
  explanation: {type: 'UTF8', optional: true},
  quotes: {type: 'UTF8', optional: true},
})

/**
 * Convert a DenormalizedJudgmentAnalytics record to Parquet row format.
 * Handles Date -> timestamp conversion and null handling.
 */
const toParquetRow = (record: DenormalizedJudgmentAnalytics): Record<string, unknown> => {
  return {
    id: record.id,
    createdAt: record.createdAt.getTime(),
    deletedAt: record.deletedAt?.getTime() ?? null,

    articleId: record.articleId,
    articleTitle: record.articleTitle,
    articleCreatedAt: record.articleCreatedAt?.getTime() ?? null,
    articleUpdatedAt: record.articleUpdatedAt?.getTime() ?? null,
    articleCreatedYear: record.articleCreatedYear,
    articleUpdatedYear: record.articleUpdatedYear,
    articleImportRoute: record.articleImportRoute,
    articleImportedBy: record.articleImportedBy,

    promptId: record.promptId,
    modelId: record.modelId,

    answeredOriginal: record.answeredOriginal,
    // Convert null/undefined to empty array for repeated field
    answeredOriginalAsArray: record.answeredOriginalAsArray ?? [],

    explanation: record.explanation,
    quotes: record.quotes,
  }
}

/**
 * Generate the S3 key for a Parquet file using Hive-style partitioning.
 *
 * @param prefix - Base prefix (e.g., 'judgments')
 * @param date - Date for partitioning (uses year and month)
 * @returns S3 key like 'judgments/year=2024/month=12/{ulid}.parquet'
 */
export const generateParquetKey = (prefix: string, date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const filename = `${ulid()}.parquet`
  return `${prefix}/year=${year}/month=${month}/${filename}`
}

/**
 * Write records to an in-memory buffer.
 * Uses parquetjs file writer with a temp file, then reads back into memory.
 * This approach is more compatible than the stream API.
 */
const writeToBuffer = async (records: DenormalizedJudgmentAnalytics[]): Promise<Buffer> => {
  const os = await import('os')
  const path = await import('path')
  const fs = await import('fs/promises')

  // Create a unique temp file path
  const tempPath = path.join(os.tmpdir(), `parquet-${ulid()}.parquet`)

  try {
    // Create writer options for compression
    const writerOptions: WriterOptions = {
      // SNAPPY is the default and works well for ClickHouse
      useDataPageV2: true,
      // Row group size for efficient reading
      rowGroupSize: Math.min(records.length, 10000),
    }

    // Create writer to temp file
    const writer = await ParquetWriter.openFile(judgmentAnalyticsSchema, tempPath, writerOptions)

    // Append all records
    for (const record of records) {
      await writer.appendRow(toParquetRow(record))
    }

    // Close the writer (flushes data)
    await writer.close()

    // Read the file into a buffer
    const buffer = await fs.readFile(tempPath)

    return buffer
  } finally {
    // Clean up temp file
    try {
      const fsCleanup = await import('fs/promises')
      await fsCleanup.unlink(tempPath)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Write a batch of judgment analytics records to a Parquet file in S3.
 *
 * @param records - Array of DenormalizedJudgmentAnalytics records
 * @param config - Configuration for bucket, prefix, etc.
 * @returns The S3 key where the file was written
 */
export const writeBatch = async (
  records: DenormalizedJudgmentAnalytics[],
  config?: Partial<ParquetWriterConfig>,
): Promise<string> => {
  if (records.length === 0) {
    throw new Error('Cannot write empty batch')
  }

  // Determine bucket and prefix
  const s3Config = getS3Config()
  const bucket = config?.bucket ?? s3Config.bucket
  const prefix = config?.prefix ?? 'judgments'

  // Ensure bucket exists
  await ensureBucket(bucket)

  // Get the first record for partitioning (we already validated length > 0)
  const firstRecord = records[0]
  if (!firstRecord) {
    throw new Error('Cannot write empty batch')
  }
  const partitionDate = firstRecord.createdAt
  const key = generateParquetKey(prefix, partitionDate)

  // Write to a temporary buffer using parquetjs
  const buffer = await writeToBuffer(records)

  // Upload to S3
  await uploadToS3(bucket, key, buffer, 'application/vnd.apache.parquet')

  console.log(`Wrote ${records.length} records to s3://${bucket}/${key}`)

  return key
}

/**
 * Write a single judgment as a tombstone record (for soft deletes).
 *
 * Creates a Parquet file with just the tombstone record, which ClickHouse's
 * ReplacingMergeTree will use to mark the original record as deleted.
 *
 * @param id - The judgment ID to mark as deleted
 * @param originalRecord - The original record (used for partitioning by createdAt)
 * @param deletedAt - When the deletion occurred
 * @param config - Configuration for bucket, prefix, etc.
 * @returns The S3 key where the tombstone was written
 */
export const writeTombstone = async (
  id: string,
  originalRecord: DenormalizedJudgmentAnalytics,
  deletedAt: Date = new Date(),
  config?: Partial<ParquetWriterConfig>,
): Promise<string> => {
  // Create a tombstone record - same as original but with deletedAt set
  const tombstone: DenormalizedJudgmentAnalytics = {...originalRecord, id, deletedAt}

  return writeBatch([tombstone], config)
}

/**
 * JudgmentParquetWriter class for batched writing.
 *
 * Collects records and flushes to S3 when batch size is reached.
 * Useful for streaming writes from the LLM worker.
 */
export class JudgmentParquetWriter {
  private buffer: DenormalizedJudgmentAnalytics[] = []
  private readonly config: Required<ParquetWriterConfig>
  private flushPromise: Promise<void> | null = null

  constructor(config?: Partial<ParquetWriterConfig>) {
    const s3Config = getS3Config()
    this.config = {
      bucket: config?.bucket ?? s3Config.bucket,
      prefix: config?.prefix ?? 'judgments',
      batchSize: config?.batchSize ?? 1000,
    }
  }

  /**
   * Add a record to the buffer. Flushes automatically when batch size is reached.
   */
  add = async (record: DenormalizedJudgmentAnalytics): Promise<void> => {
    this.buffer.push(record)

    if (this.buffer.length >= this.config.batchSize) {
      await this.flush()
    }
  }

  /**
   * Add multiple records to the buffer.
   */
  addMany = async (records: DenormalizedJudgmentAnalytics[]): Promise<void> => {
    for (const record of records) {
      await this.add(record)
    }
  }

  /**
   * Flush the current buffer to S3.
   * Returns immediately if a flush is already in progress (to avoid concurrent writes).
   */
  flush = async (): Promise<void> => {
    if (this.buffer.length === 0) {
      return
    }

    // If a flush is in progress, wait for it
    if (this.flushPromise) {
      await this.flushPromise
    }

    const records = this.buffer
    this.buffer = []

    this.flushPromise = writeBatch(records, this.config)
      .then(() => {
        this.flushPromise = null
      })
      .catch((error) => {
        // On error, restore records to buffer for retry
        this.buffer = [...records, ...this.buffer]
        this.flushPromise = null
        throw error
      })

    await this.flushPromise
  }

  /**
   * Get the number of records currently in the buffer.
   */
  get pendingCount(): number {
    return this.buffer.length
  }
}

// Export a default writer instance for convenience
let _defaultWriter: JudgmentParquetWriter | null = null

export const getDefaultWriter = (config?: Partial<ParquetWriterConfig>): JudgmentParquetWriter => {
  if (!_defaultWriter) {
    _defaultWriter = new JudgmentParquetWriter(config)
  }
  return _defaultWriter
}

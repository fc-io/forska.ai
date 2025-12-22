/**
 * DenormalizedJudgmentAnalytics
 *
 * This is the flat, denormalized schema written to Parquet files for ClickHouse analytics.
 * It's designed for efficient columnar storage and aggregation queries.
 *
 * Key design decisions:
 * - No projectId: Project scoping is done via promptIds (derived from project_prompts table)
 *   and articleImportRoute (for scope filtering). This avoids redundancy.
 * - Soft deletes via `deletedAt`: Parquet files are immutable; deletes are handled by writing
 *   a tombstone record with the same `id` but `deletedAt` set.
 * - answeredOriginalAsArray: Supports multi-value answers for checkbox-style prompts.
 */
export interface DenormalizedJudgmentAnalytics {
  // Primary Identifier (Unique - no deduplication needed for fresh writes)
  id: string

  // Lifecycle
  createdAt: Date
  deletedAt: Date | null // Soft delete support (tombstone pattern)

  // Analytic Dimensions
  articleId: string
  articleTitle: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleCreatedYear: number | null
  articleUpdatedYear: number | null
  articleImportRoute: string | null
  articleImportedBy: string | null
  promptId: string
  modelId: string

  // Answer Data
  answeredOriginal: string | null // For single-value answers
  answeredOriginalAsArray: string[] | null // For multi-value/array answers

  // Large Text Fields
  explanation: string | null
  quotes: string | null // Serialized JSON
}

/**
 * Configuration for the Parquet Writer service.
 */
export interface ParquetWriterConfig {
  /** S3 bucket name for storing Parquet files */
  bucket: string
  /** Prefix path within the bucket (e.g., 'judgments') */
  prefix?: string
  /** Minimum number of records before flushing to a Parquet file */
  batchSize?: number
}

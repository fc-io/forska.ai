/**
 * Parquet service module - exports for Parquet writer and types.
 */

// Types
export type {DenormalizedJudgmentAnalytics, ParquetWriterConfig} from './types'

// Writer functions and schema
export {
  generateParquetKey,
  getDefaultWriter,
  judgmentAnalyticsSchema,
  JudgmentParquetWriter,
  writeBatch,
  writeTombstone,
} from './parquetWriter'

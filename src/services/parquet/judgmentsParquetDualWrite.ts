import {flushDefaultWriterIfPresent, getDefaultWriter, getDefaultWriterPendingCount} from './parquetWriter'
import type {DenormalizedJudgmentAnalytics} from './types'

type JudgmentsParquetDualWriteConfig = {
  enabled: boolean
  s3Configured: boolean
  batchSize: number
  flushIntervalMs: number
}

const hasS3Config = (): boolean => {
  return Boolean(
    process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY && process.env.S3_BUCKET,
  )
}

const parseEnvBool = (value: string | undefined): boolean | null => {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return null
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  const floored = Number.isFinite(n) ? Math.floor(n) : fallback
  return floored > 0 ? floored : fallback
}

export const getJudgmentsParquetDualWriteConfig = (): JudgmentsParquetDualWriteConfig => {
  const s3Configured = hasS3Config()
  const enabledEnv = parseEnvBool(process.env.PARQUET_JUDGMENTS_DUAL_WRITE)
  const enabled = s3Configured && (enabledEnv ?? true)

  const batchSize = parsePositiveInt(process.env.PARQUET_JUDGMENTS_BATCH_SIZE, 1000)
  const flushIntervalMs = parsePositiveInt(process.env.PARQUET_JUDGMENTS_FLUSH_INTERVAL_MS, 10_000)

  return {enabled, s3Configured, batchSize, flushIntervalMs}
}

let flushTimer: ReturnType<typeof setTimeout> | null = null

const scheduleFlushIfPending = (): void => {
  if (flushTimer) return

  const pendingCount = getDefaultWriterPendingCount()
  if (pendingCount === 0) return

  const {flushIntervalMs} = getJudgmentsParquetDualWriteConfig()
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushDefaultWriterIfPresent()
      .then(() => {
        scheduleFlushIfPending()
      })
      .catch((error: unknown) => {
        console.error('[Parquet Dual Write] Flush failed', error)
        scheduleFlushIfPending()
      })
  }, flushIntervalMs)
}

export const writeJudgmentAnalyticsToParquet = async (record: DenormalizedJudgmentAnalytics): Promise<void> => {
  const config = getJudgmentsParquetDualWriteConfig()
  if (!config.enabled) return

  const writer = getDefaultWriter({batchSize: config.batchSize})
  await writer
    .add(record)
    .then(() => {
      scheduleFlushIfPending()
    })
    .catch((error: unknown) => {
      const safeError =
        error instanceof Error
          ? {name: error.name, message: error.message, stack: error.stack}
          : {message: String(error)}
      console.error('[Parquet Dual Write] Failed to add record', {id: record.id, error: safeError})
    })
}

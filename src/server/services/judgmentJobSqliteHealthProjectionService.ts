import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

type JudgmentJobPromptCounts = {claimed: number; judged: number; ready: number; running: number; skipped: number}

export type JudgmentJobSqliteHealthSnapshotForProjection = {
  claimedOutboxCount: number
  hasOutboxRows: boolean
  hasPendingCompletionAck: boolean
  hasQueueRows: boolean
  lastAckSeq: number | null
  oldestUnackedCompletionAgeMs: number | null
  oldestUnexportedAgeMs: number | null
  orphanedJudgedRowCount: number
  outboxRowCount: number
  pendingCompletionAckCount: number
  promptCounts: JudgmentJobPromptCounts
  retainedRowCount: number
  sqliteFileBytes: number | null
  walBytes: number
}

export type JudgmentJobSqliteHealthProjectionRecord = JudgmentJobSqliteHealthSnapshotForProjection & {
  freshUntilAt: Date
  jobId: string
  projectedAt: Date
  projectedBy: string | null
  projectionSource: string
}

type JudgmentJobSqliteHealthProjectionRow = {
  claimedOutboxCount: number | null
  freshUntilAt: unknown
  hasOutboxRows: boolean | null
  hasPendingCompletionAck: boolean | null
  hasQueueRows: boolean | null
  jobId: string
  lastAckSeq: number | null
  oldestUnackedCompletionAgeMs: number | null
  oldestUnexportedAgeMs: number | null
  orphanedJudgedRowCount: number | null
  outboxRowCount: number | null
  pendingCompletionAckCount: number | null
  projectedAt: unknown
  projectedBy: string | null
  projectionSource: string
  promptClaimedCount: number | null
  promptJudgedCount: number | null
  promptReadyCount: number | null
  promptRunningCount: number | null
  promptSkippedCount: number | null
  retainedRowCount: number | null
  sqliteFileBytes: number | null
  walBytes: number | null
}

type JudgmentJobSqliteHealthProjectionReader = {queryJson: <T>(statement: string) => Promise<T[]>}

const judgmentJobSqliteHealthProjectionFreshnessMs = 30_000

const getProjectionFreshUntilAt = (now: Date) => {
  return new Date(now.getTime() + judgmentJobSqliteHealthProjectionFreshnessMs)
}

const getProjectionSelectSql = () => {
  return `
    job_id AS jobId,
    projection_source AS projectionSource,
    projected_by AS projectedBy,
    projected_at AS projectedAt,
    fresh_until_at AS freshUntilAt,
    has_outbox_rows AS hasOutboxRows,
    has_queue_rows AS hasQueueRows,
    outbox_row_count AS outboxRowCount,
    claimed_outbox_count AS claimedOutboxCount,
    oldest_unexported_age_ms AS oldestUnexportedAgeMs,
    orphaned_judged_row_count AS orphanedJudgedRowCount,
    retained_row_count AS retainedRowCount,
    last_ack_seq AS lastAckSeq,
    pending_completion_ack_count AS pendingCompletionAckCount,
    has_pending_completion_ack AS hasPendingCompletionAck,
    oldest_unacked_completion_age_ms AS oldestUnackedCompletionAgeMs,
    sqlite_file_bytes AS sqliteFileBytes,
    wal_bytes AS walBytes,
    prompt_ready_count AS promptReadyCount,
    prompt_claimed_count AS promptClaimedCount,
    prompt_running_count AS promptRunningCount,
    prompt_judged_count AS promptJudgedCount,
    prompt_skipped_count AS promptSkippedCount
  `
}

const getNumberOrNull = (value: number | null | undefined) => {
  return value == null ? null : Number(value)
}

const getNumberOrZero = (value: number | null | undefined) => {
  return Number(value ?? 0)
}

const mapProjectionRow = (row: JudgmentJobSqliteHealthProjectionRow): JudgmentJobSqliteHealthProjectionRecord => {
  return {
    claimedOutboxCount: getNumberOrZero(row.claimedOutboxCount),
    freshUntilAt: getDateValue(row.freshUntilAt) ?? new Date(0),
    hasOutboxRows: Boolean(row.hasOutboxRows),
    hasPendingCompletionAck: Boolean(row.hasPendingCompletionAck),
    hasQueueRows: Boolean(row.hasQueueRows),
    jobId: row.jobId,
    lastAckSeq: getNumberOrNull(row.lastAckSeq),
    oldestUnackedCompletionAgeMs: getNumberOrNull(row.oldestUnackedCompletionAgeMs),
    oldestUnexportedAgeMs: getNumberOrNull(row.oldestUnexportedAgeMs),
    orphanedJudgedRowCount: getNumberOrZero(row.orphanedJudgedRowCount),
    outboxRowCount: getNumberOrZero(row.outboxRowCount),
    pendingCompletionAckCount: getNumberOrZero(row.pendingCompletionAckCount),
    projectedAt: getDateValue(row.projectedAt) ?? new Date(0),
    projectedBy: row.projectedBy,
    projectionSource: row.projectionSource,
    promptCounts: {
      claimed: getNumberOrZero(row.promptClaimedCount),
      judged: getNumberOrZero(row.promptJudgedCount),
      ready: getNumberOrZero(row.promptReadyCount),
      running: getNumberOrZero(row.promptRunningCount),
      skipped: getNumberOrZero(row.promptSkippedCount),
    },
    retainedRowCount: getNumberOrZero(row.retainedRowCount),
    sqliteFileBytes: getNumberOrNull(row.sqliteFileBytes),
    walBytes: getNumberOrZero(row.walBytes),
  }
}

const getFreshProjectionRows = async ({
  db,
  jobIds,
  now,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobIds: string[]
  now: Date
}) => {
  return jobIds.length === 0
    ? []
    : db.queryJson<JudgmentJobSqliteHealthProjectionRow>(`
        SELECT ${getProjectionSelectSql()}
        FROM app.judgment_job_sqlite_health_projection
        WHERE job_id IN (${getQuotedStringList(jobIds).join(', ')})
          AND fresh_until_at > ${getTimestampLiteral(now)}
        ORDER BY job_id ASC
      `)
}

const publishJudgmentJobSqliteHealthProjection = async ({
  health,
  jobId,
  projectedBy,
  projectionSource,
  now = new Date(),
}: {
  health: JudgmentJobSqliteHealthSnapshotForProjection
  jobId: string
  now?: Date
  projectedBy?: string | null
  projectionSource: string
}) => {
  const freshUntilAt = getProjectionFreshUntilAt(now)

  await getAppDatabaseService().run(`
    INSERT INTO app.judgment_job_sqlite_health_projection (
      job_id,
      projection_source,
      projected_by,
      projected_at,
      fresh_until_at,
      has_outbox_rows,
      has_queue_rows,
      outbox_row_count,
      claimed_outbox_count,
      oldest_unexported_age_ms,
      orphaned_judged_row_count,
      retained_row_count,
      last_ack_seq,
      pending_completion_ack_count,
      has_pending_completion_ack,
      oldest_unacked_completion_age_ms,
      sqlite_file_bytes,
      wal_bytes,
      prompt_ready_count,
      prompt_claimed_count,
      prompt_running_count,
      prompt_judged_count,
      prompt_skipped_count,
      updated_at
    ) VALUES (
      ${getSqlLiteral(jobId)},
      ${getSqlLiteral(projectionSource)},
      ${getSqlLiteral(projectedBy ?? null)},
      ${getTimestampLiteral(now)},
      ${getTimestampLiteral(freshUntilAt)},
      ${getSqlLiteral(health.hasOutboxRows)},
      ${getSqlLiteral(health.hasQueueRows)},
      ${getSqlLiteral(health.outboxRowCount)},
      ${getSqlLiteral(health.claimedOutboxCount)},
      ${getSqlLiteral(health.oldestUnexportedAgeMs)},
      ${getSqlLiteral(health.orphanedJudgedRowCount)},
      ${getSqlLiteral(health.retainedRowCount)},
      ${getSqlLiteral(health.lastAckSeq)},
      ${getSqlLiteral(health.pendingCompletionAckCount)},
      ${getSqlLiteral(health.hasPendingCompletionAck)},
      ${getSqlLiteral(health.oldestUnackedCompletionAgeMs)},
      ${getSqlLiteral(health.sqliteFileBytes)},
      ${getSqlLiteral(health.walBytes)},
      ${getSqlLiteral(health.promptCounts.ready)},
      ${getSqlLiteral(health.promptCounts.claimed)},
      ${getSqlLiteral(health.promptCounts.running)},
      ${getSqlLiteral(health.promptCounts.judged)},
      ${getSqlLiteral(health.promptCounts.skipped)},
      ${getTimestampLiteral(now)}
    )
    ON CONFLICT(job_id) DO UPDATE SET
      projection_source = EXCLUDED.projection_source,
      projected_by = EXCLUDED.projected_by,
      projected_at = EXCLUDED.projected_at,
      fresh_until_at = EXCLUDED.fresh_until_at,
      has_outbox_rows = EXCLUDED.has_outbox_rows,
      has_queue_rows = EXCLUDED.has_queue_rows,
      outbox_row_count = EXCLUDED.outbox_row_count,
      claimed_outbox_count = EXCLUDED.claimed_outbox_count,
      oldest_unexported_age_ms = EXCLUDED.oldest_unexported_age_ms,
      orphaned_judged_row_count = EXCLUDED.orphaned_judged_row_count,
      retained_row_count = EXCLUDED.retained_row_count,
      last_ack_seq = EXCLUDED.last_ack_seq,
      pending_completion_ack_count = EXCLUDED.pending_completion_ack_count,
      has_pending_completion_ack = EXCLUDED.has_pending_completion_ack,
      oldest_unacked_completion_age_ms = EXCLUDED.oldest_unacked_completion_age_ms,
      sqlite_file_bytes = EXCLUDED.sqlite_file_bytes,
      wal_bytes = EXCLUDED.wal_bytes,
      prompt_ready_count = EXCLUDED.prompt_ready_count,
      prompt_claimed_count = EXCLUDED.prompt_claimed_count,
      prompt_running_count = EXCLUDED.prompt_running_count,
      prompt_judged_count = EXCLUDED.prompt_judged_count,
      prompt_skipped_count = EXCLUDED.prompt_skipped_count,
      updated_at = EXCLUDED.updated_at
  `)
}

const getFreshJudgmentJobSqliteHealthProjection = async ({
  db,
  jobId,
  now = new Date(),
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
  now?: Date
}) => {
  const [row] = await getFreshProjectionRows({db, jobIds: [jobId], now})

  return row ? mapProjectionRow(row) : null
}

const getFreshJudgmentJobSqliteHealthProjections = async ({
  db,
  jobIds,
  now = new Date(),
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobIds: string[]
  now?: Date
}) => {
  const rows = await getFreshProjectionRows({db, jobIds, now})

  return rows.reduce((map, row) => {
    map.set(row.jobId, mapProjectionRow(row))
    return map
  }, new Map<string, JudgmentJobSqliteHealthProjectionRecord>())
}

const judgmentJobSqliteHealthProjectionService = {
  getFreshJudgmentJobSqliteHealthProjection,
  getFreshJudgmentJobSqliteHealthProjections,
  getProjectionFreshnessMs: () => {
    return judgmentJobSqliteHealthProjectionFreshnessMs
  },
  publishJudgmentJobSqliteHealthProjection,
}

export const getJudgmentJobSqliteHealthProjectionService = () => {
  return judgmentJobSqliteHealthProjectionService
}

export type {JudgmentJobSqliteHealthProjectionReader}

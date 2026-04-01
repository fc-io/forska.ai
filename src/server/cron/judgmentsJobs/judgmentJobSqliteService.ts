import {randomUUID} from 'node:crypto'
import {existsSync, rmSync, statSync, writeFileSync} from 'node:fs'

import {Database} from 'bun:sqlite'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {registerWriterDemotionHandler} from '../../utils/serverRuntimeRole.ts'
import {
  acquireJudgmentJobLease,
  type JudgmentJobLease,
  releaseJudgmentJobLease,
  updateJudgmentJobLeaseHeartbeat,
} from './judgmentJobLease.ts'
import {getJudgmentJobLeasePath, getJudgmentJobSqliteJobIds, getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'

type JobInfoRow = {
  cursorLastArticleId: string | null
  cursorLastDate: unknown
  createdAt: unknown
  jobId: string
  modelBaseUrl: string | null
  modelId: string | null
  modelMetadataJson: unknown
  modelName: string | null
  modelProvider: string | null
  modelSecretRef: string | null
  modelVersion: string | null
  projectId: string | null
  providerConfigJson: unknown
  useAbstract: boolean | null
  useFulltext: boolean | null
  useFulltextNoImages: boolean | null
  useTitle: boolean | null
}

type LiveModelRuntimeRow = {
  modelBaseUrl: string | null
  modelMetadataJson: unknown
  modelName: string | null
  modelProvider: string | null
  modelSecretRef: string | null
  modelVersion: string | null
  providerConfigJson: unknown
}

export type JudgmentJobSqliteInfo = {
  createdAt: Date
  cursor: JobCursor | null
  jobId: string
  modelBaseUrl: string | null
  modelId: string
  modelMetadataJson: unknown
  modelName: string
  modelProvider: string
  modelSecretRef: string | null
  modelVersion: string | null
  projectId: string
  providerConfigJson: unknown
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type JobCursor = {lastDate: Date; lastArticleId: string}

type QueueCountRow = {count: number; status: string}

type QueuePromptRow = {articleId: string; id: string; promptId: string}

type QueuePromptInsert = {articleId: string; promptId: string}

type QueuePromptClaim = {articleId: string; jobId: string; promptId: string; recordId: string}

type QueuePromptOutboxInsert = {
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  articleId: string
  chunkingStrategy: string | null
  confidenceOriginal: number
  createdAt: Date
  explanation: string | null
  isAnswered: boolean
  judgmentId: string
  modelId: string
  projectId: string | null
  promptId: string
  queuePromptId: string
  quotes: unknown
  rawResponseJson: unknown
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  updatedAt: Date
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type OutboxRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: string | null
  articleId: string
  chunkingStrategy: string | null
  confidenceOriginal: number
  createdAt: string
  explanation: string | null
  jobId: string
  judgmentId: string
  modelId: string
  outboxSeq: number
  projectId: string | null
  promptId: string
  queuePromptId: string
  quotesJson: string | null
  rawResponseJson: string | null
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  updatedAt: string
  useAbstract: number
  useFulltext: number
  useFulltextNoImages: number
  useTitle: number
}

export type JudgmentJobSqliteOutboxEntry = {
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  articleId: string
  chunkingStrategy: string | null
  confidenceOriginal: number
  createdAt: Date
  explanation: string | null
  isAnswered: boolean
  jobId: string
  judgmentId: string
  modelId: string
  outboxSeq: number
  projectId: string | null
  promptId: string
  queuePromptId: string
  quotes: unknown
  rawResponseJson: unknown
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  updatedAt: Date
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type JudgmentJobSqliteOutboxClaim = {claimId: string; jobId: string; rowCount: number}

export type JudgmentJobSqliteHealthSnapshot = {
  claimedOutboxCount: number
  lastAckSeq: number | null
  oldestUnexportedAgeMs: number | null
  outboxRowCount: number
  promptCounts: {judged: number; ready: number; sent: number; skipped: number}
  retainedRowCount: number
  sqliteFileBytes: number | null
  walBytes: number
}

export type JudgmentJobSqlitePreflightSnapshot = {
  outboxSampleCount: number
  queueSampleCount: number
  sqliteFileBytes: number
  walBytes: number
}

export type JudgmentJobSystemSqliteFallbackStep = 'checkpoint' | 'diagnostic' | 'export'

export type JudgmentJobSystemSqliteFallbackResult = {
  command: string[]
  exitCode: number
  exportBytes: number | null
  exportPath: string | null
  ok: boolean
  stderr: string
  step: JudgmentJobSystemSqliteFallbackStep
  stdout: string
  walBytesAfter: number | null
  walBytesBefore: number | null
}

type ScanStateRow = {
  cursorLastArticleId: string | null
  cursorLastDate: string | null
  exhaustedAt: string | null
  lastProjectRefreshAckSeq: number | null
  scanEpoch: number | null
  wrapVisibilityAckSeq: number | null
}

type JobScanState = {
  cursor: JobCursor | null
  exhaustedAt: Date | null
  lastProjectRefreshAckSeq: number | null
  scanEpoch: number
  wrapVisibilityAckSeq: number | null
}

type JobScanStateUpdate = {
  cursor?: JobCursor | null
  exhaustedAt?: Date | null
  lastProjectRefreshAckSeq?: number | null
  scanEpoch?: number
  wrapVisibilityAckSeq?: number | null
}

type SqliteTableInfoRow = {name: string}

type SqliteMasterRow = {name: string}

export type JudgmentJobSqliteClaimedOutboxBatch = {
  claim: JudgmentJobSqliteOutboxClaim
  rows: JudgmentJobSqliteOutboxEntry[]
}

type ClaimedOutboxRow = {claimId: string; rowCount: number}

type RetentionEligibleOutboxRow = {outboxSeq: number; queuePromptId: string}

type RetentionPruneResult = {outboxRowsDeleted: number; queuePromptRowsDeleted: number}

type JudgmentJobStorageRow = {id: string}

type WalCheckpointRow = {busy: number; checkpointed: number; log: number}

const openDatabases = new Map<string, Database>()
const ownedJobLeases = new Map<string, JudgmentJobLease>()
const ownedJobLeaseOperationCounts = new Map<string, number>()
const judgmentJobLeaseHeartbeatIntervalMs = 5_000
const judgmentJobLeaseLogger = createRateLimitedLogger({windowMs: 30_000})
let judgmentJobLeaseHeartbeatStarted = false

export class JudgmentJobLeaseError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'JudgmentJobLeaseError'
  }
}

export class JudgmentJobSqlitePreflightError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'JudgmentJobSqlitePreflightError'
  }
}

const closeOpenDatabase = (jobId: string) => {
  const database = openDatabases.get(jobId)

  if (!database) {
    return
  }

  database.close(false)
  openDatabases.delete(jobId)
}

const releaseOwnedJobLeaseState = (jobId: string) => {
  ownedJobLeases.delete(jobId)
  closeOpenDatabase(jobId)
}

const getOwnedJobLeaseOperationCount = (jobId: string) => {
  return ownedJobLeaseOperationCounts.get(jobId) ?? 0
}

const startOwnedJobLeaseOperation = (jobId: string) => {
  ownedJobLeaseOperationCounts.set(jobId, getOwnedJobLeaseOperationCount(jobId) + 1)
}

const finishOwnedJobLeaseOperation = (jobId: string) => {
  const nextCount = Math.max(0, getOwnedJobLeaseOperationCount(jobId) - 1)

  return nextCount === 0
    ? ownedJobLeaseOperationCounts.delete(jobId)
    : ownedJobLeaseOperationCounts.set(jobId, nextCount)
}

const hasOwnedJobLeaseOperation = (jobId: string) => {
  return getOwnedJobLeaseOperationCount(jobId) > 0
}

const heartbeatOwnedJobLease = async (jobId: string) => {
  const currentLease = ownedJobLeases.get(jobId)

  if (!currentLease) {
    return
  }

  try {
    const nextLease = await updateJudgmentJobLeaseHeartbeat(currentLease)
    ownedJobLeases.set(jobId, nextLease)
  } catch (error) {
    releaseOwnedJobLeaseState(jobId)
    judgmentJobLeaseLogger.warn(`judgments:lease-heartbeat:${jobId}`, '[judgments] lost SQLite job lease heartbeat', {
      error: error instanceof Error ? error.message : String(error),
      jobId,
    })
  }
}

const startOwnedJobLeaseHeartbeatMonitor = () => {
  if (judgmentJobLeaseHeartbeatStarted) {
    return
  }

  judgmentJobLeaseHeartbeatStarted = true
  const interval = setInterval(() => {
    return void Promise.all(
      Array.from(ownedJobLeases.keys()).map((jobId) => {
        return heartbeatOwnedJobLease(jobId)
      }),
    )
  }, judgmentJobLeaseHeartbeatIntervalMs)

  interval.unref()
}

const getOpenDatabase = (jobId: string, createIfMissing: boolean): Database | null => {
  const cached = openDatabases.get(jobId)

  if (cached) {
    return cached
  }

  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  if (!createIfMissing && !existsSync(sqlitePath)) {
    return null
  }

  const database = new Database(sqlitePath, {create: true})

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS job_info (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_version TEXT,
      model_base_url TEXT,
      model_secret_ref TEXT,
      model_metadata_json TEXT,
      provider_config_json TEXT,
      use_title INTEGER NOT NULL,
      use_abstract INTEGER NOT NULL,
      use_fulltext INTEGER NOT NULL,
      use_fulltext_no_images INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_scan_state (
      job_id TEXT PRIMARY KEY,
      cursor_last_date TEXT,
      cursor_last_article_id TEXT,
      scan_epoch INTEGER NOT NULL DEFAULT 0,
      exhausted_at TEXT,
      last_project_refresh_ack_seq INTEGER,
      wrap_visibility_ack_seq INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue_prompt (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      status TEXT NOT NULL,
      terminal_kind TEXT,
      skip_reason TEXT,
      server_id TEXT,
      claim_id TEXT,
      sent_at TEXT,
      judged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, article_id, prompt_id)
    );
    CREATE INDEX IF NOT EXISTS idx_queue_prompt_status_created
      ON queue_prompt(status, created_at, article_id);
    CREATE TABLE IF NOT EXISTS judgment_outbox (
      outbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      queue_prompt_id TEXT NOT NULL UNIQUE,
      judgment_id TEXT NOT NULL UNIQUE,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      project_id TEXT,
      snapshot_project_id TEXT,
      snapshot_project_model_name TEXT,
      use_title INTEGER NOT NULL,
      use_abstract INTEGER NOT NULL,
      use_fulltext INTEGER NOT NULL,
      use_fulltext_no_images INTEGER NOT NULL,
      chunking_strategy TEXT,
      is_answered INTEGER NOT NULL,
      answered_original TEXT,
      answered_original_as_array TEXT,
      confidence_original INTEGER NOT NULL,
      explanation TEXT,
      quotes_json TEXT,
      raw_response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exported_at TEXT,
      export_claim_id TEXT,
      export_claimed_at TEXT,
      export_claimed_by TEXT,
      export_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_judgment_outbox_exported
      ON judgment_outbox(exported_at, outbox_seq);
  `)

  ensureJobScanStateSchema(database)
  ensureOutboxClaimSchema(database)

  openDatabases.set(jobId, database)
  return database
}

const withJobDatabase = <T>(
  jobId: string,
  createIfMissing: boolean,
  operation: (database: Database) => T,
): T | null => {
  const database = getOpenDatabase(jobId, createIfMissing)
  return database ? operation(database) : null
}

const toBoolean = (value: number | boolean | null | undefined) => {
  return value === true || value === 1
}

const parseJsonText = (value: string | null) => {
  if (value == null || value === '') {
    return null
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const parseStringArrayText = (value: string | null) => {
  const parsed = parseJsonText(value)
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

const outboxClaimColumns = [
  {name: 'export_claim_id', sql: 'TEXT'},
  {name: 'export_claimed_at', sql: 'TEXT'},
  {name: 'export_claimed_by', sql: 'TEXT'},
] as const

const judgmentJobSqliteRequiredSchema = {
  job_info: [
    'job_id',
    'project_id',
    'model_id',
    'model_name',
    'model_provider',
    'use_title',
    'use_abstract',
    'use_fulltext',
    'use_fulltext_no_images',
    'created_at',
  ],
  job_scan_state: [
    'job_id',
    'cursor_last_date',
    'cursor_last_article_id',
    'scan_epoch',
    'exhausted_at',
    'last_project_refresh_ack_seq',
    'wrap_visibility_ack_seq',
    'updated_at',
  ],
  queue_prompt: [
    'id',
    'job_id',
    'article_id',
    'prompt_id',
    'status',
    'server_id',
    'claim_id',
    'sent_at',
    'created_at',
    'updated_at',
  ],
  judgment_outbox: [
    'outbox_seq',
    'job_id',
    'queue_prompt_id',
    'judgment_id',
    'article_id',
    'prompt_id',
    'model_id',
    'created_at',
    'updated_at',
    'exported_at',
    'export_claim_id',
    'export_claimed_at',
    'export_claimed_by',
  ],
} as const

const jobScanStateColumns = [
  {name: 'scan_epoch', sql: 'INTEGER NOT NULL DEFAULT 0'},
  {name: 'last_project_refresh_ack_seq', sql: 'INTEGER'},
  {name: 'wrap_visibility_ack_seq', sql: 'INTEGER'},
] as const

const addMissingOutboxClaimColumns = (
  database: Database,
  columns: ReadonlyArray<(typeof outboxClaimColumns)[number]>,
): void => {
  const [currentColumn] = columns

  if (!currentColumn) {
    return
  }

  database.exec(`ALTER TABLE judgment_outbox ADD COLUMN ${currentColumn.name} ${currentColumn.sql}`)
  return addMissingOutboxClaimColumns(database, columns.slice(1))
}

const addMissingJobScanStateColumns = (
  database: Database,
  columns: ReadonlyArray<(typeof jobScanStateColumns)[number]>,
): void => {
  const [currentColumn] = columns

  if (!currentColumn) {
    return
  }

  database.exec(`ALTER TABLE job_scan_state ADD COLUMN ${currentColumn.name} ${currentColumn.sql}`)
  return addMissingJobScanStateColumns(database, columns.slice(1))
}

const ensureOutboxClaimSchema = (database: Database) => {
  const existingColumnNames = new Set(
    (database.query(`PRAGMA table_info('judgment_outbox')`).all() as SqliteTableInfoRow[]).map((row) => {
      return row.name
    }),
  )
  const missingColumns = outboxClaimColumns.filter((column) => {
    return !existingColumnNames.has(column.name)
  })

  addMissingOutboxClaimColumns(database, missingColumns)
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_judgment_outbox_claim
      ON judgment_outbox(exported_at, export_claimed_at, outbox_seq)
  `)
}

const getJobScanState = (row: ScanStateRow | null | undefined): JobScanState => {
  const lastDate = getDateValue(row?.cursorLastDate)
  const exhaustedAt = getDateValue(row?.exhaustedAt)

  return {
    cursor: lastDate && row?.cursorLastArticleId ? {lastArticleId: row.cursorLastArticleId, lastDate} : null,
    exhaustedAt,
    lastProjectRefreshAckSeq: row?.lastProjectRefreshAckSeq == null ? null : Number(row.lastProjectRefreshAckSeq),
    scanEpoch: Number(row?.scanEpoch ?? 0),
    wrapVisibilityAckSeq: row?.wrapVisibilityAckSeq == null ? null : Number(row.wrapVisibilityAckSeq),
  }
}

const ensureJobScanStateSchema = (database: Database) => {
  const existingColumnNames = new Set(
    (database.query(`PRAGMA table_info('job_scan_state')`).all() as SqliteTableInfoRow[]).map((row) => {
      return row.name
    }),
  )
  const missingColumns = jobScanStateColumns.filter((column) => {
    return !existingColumnNames.has(column.name)
  })

  addMissingJobScanStateColumns(database, missingColumns)
}

const getStoredScanState = (database: Database, jobId: string) => {
  const row = database
    .query(
      `
        SELECT
          cursor_last_date AS cursorLastDate,
          cursor_last_article_id AS cursorLastArticleId,
          exhausted_at AS exhaustedAt,
          scan_epoch AS scanEpoch,
          last_project_refresh_ack_seq AS lastProjectRefreshAckSeq,
          wrap_visibility_ack_seq AS wrapVisibilityAckSeq
        FROM job_scan_state
        WHERE job_id = ?
        LIMIT 1
      `,
    )
    .get(jobId) as ScanStateRow | null

  return getJobScanState(row)
}

const getForwardOnlyAckSeq = (currentAckSeq: number | null, nextAckSeq: number | null) => {
  return nextAckSeq == null ? currentAckSeq : currentAckSeq == null ? nextAckSeq : Math.max(currentAckSeq, nextAckSeq)
}

const getExistingOutboxJobIds = (jobId?: string) => {
  return jobId
    ? [jobId].filter((value) => {
        return existsSync(getJudgmentJobSqlitePath(value))
      })
    : getJudgmentJobSqliteJobIds()
}

const getTrackedJudgmentJobIds = async (jobId?: string) => {
  return jobId
    ? getExistingOutboxJobIds(jobId)
    : (
        await getAppDatabaseService().queryJson<{id: string}>(`
          SELECT id
          FROM app.judgment_job
          ORDER BY created_at ASC, id ASC
        `)
      )
        .map((row) => {
          return row.id
        })
        .filter((trackedJobId) => {
          return existsSync(getJudgmentJobSqlitePath(trackedJobId))
        })
}

const sqliteCleanupTerminalStatuses = ['completed', 'project_removed'] as const

const deleteJobFiles = (jobId: string) => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  rmSync(sqlitePath, {force: true})
  rmSync(`${sqlitePath}-shm`, {force: true})
  rmSync(`${sqlitePath}-wal`, {force: true})
  rmSync(getJudgmentJobLeasePath(jobId), {force: true})
}

const getSqliteCleanupCandidateJobIds = async ({
  jobId,
  storageState,
}: {
  jobId?: string
  storageState: 'drained' | 'draining'
}) => {
  const existingJobIds = await getTrackedJudgmentJobIds(jobId)

  return existingJobIds.length === 0
    ? []
    : (
        await getAppDatabaseService().queryJson<JudgmentJobStorageRow>(`
           SELECT id
           FROM app.judgment_job
           WHERE id IN (${getQuotedStringList(existingJobIds).join(', ')})
             AND status IN (${getQuotedStringList([...sqliteCleanupTerminalStatuses]).join(', ')})
             AND storage_state = ${getSqlLiteral(storageState)}
         `)
      ).map((row) => {
        return row.id
      })
}

const getActiveQueueRowCount = (database: Database) => {
  const row = database.query(`SELECT COUNT(*) AS count FROM queue_prompt WHERE status IN ('ready', 'sent')`).get() as {
    count: number
  } | null

  return Number(row?.count ?? 0)
}

const getRetainedOutboxCount = (database: Database) => {
  const row = database.query(`SELECT COUNT(*) AS count FROM judgment_outbox`).get() as {count: number} | null

  return Number(row?.count ?? 0)
}

const getClaimedOutboxCount = (database: Database) => {
  const row = database
    .query(
      `
      SELECT COUNT(*) AS count
      FROM judgment_outbox
      WHERE exported_at IS NULL
        AND export_claim_id IS NOT NULL
    `,
    )
    .get() as {count: number} | null

  return Number(row?.count ?? 0)
}

const getOldestUnexportedAgeMs = (database: Database) => {
  const row = database
    .query(
      `
      SELECT MIN(created_at) AS createdAt
      FROM judgment_outbox
      WHERE exported_at IS NULL
    `,
    )
    .get() as {createdAt: string | null} | null
  const createdAt = getDateValue(row?.createdAt)

  return createdAt ? Math.max(0, Date.now() - createdAt.getTime()) : null
}

const getRetainedQueueRowCount = (database: Database) => {
  const row = database.query(`SELECT COUNT(*) AS count FROM queue_prompt`).get() as {count: number} | null

  return Number(row?.count ?? 0)
}

const getPromptCounts = (database: Database) => {
  const promptCounts = {judged: 0, ready: 0, sent: 0, skipped: 0}

  ;(
    database
      .query(
        `
        SELECT
          CASE WHEN status = 'judged' AND terminal_kind = 'skipped' THEN 'skipped' ELSE status END AS status,
          COUNT(*) AS count
        FROM queue_prompt
        GROUP BY CASE WHEN status = 'judged' AND terminal_kind = 'skipped' THEN 'skipped' ELSE status END
      `,
      )
      .all() as QueueCountRow[]
  ).forEach((row) => {
    if (row.status === 'ready') promptCounts.ready = Number(row.count)
    if (row.status === 'sent') promptCounts.sent = Number(row.count)
    if (row.status === 'judged') promptCounts.judged = Number(row.count)
    if (row.status === 'skipped') promptCounts.skipped = Number(row.count)
  })

  return promptCounts
}

const getFileByteSize = (filePath: string) => {
  return existsSync(filePath) ? statSync(filePath).size : 0
}

const getSqliteFileByteSize = (jobId: string) => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  return existsSync(sqlitePath) ? statSync(sqlitePath).size : null
}

const getSystemSqliteExportPath = (jobId: string) => {
  return `${getJudgmentJobSqlitePath(jobId)}.repair-export.sql`
}

const decodeSpawnOutput = (output: Uint8Array | Buffer | string | null | undefined) => {
  return typeof output === 'string' ? output : Buffer.from(output ?? []).toString('utf8')
}

const getSystemSqliteFallbackCommand = ({jobId, step}: {jobId: string; step: JudgmentJobSystemSqliteFallbackStep}) => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  return step === 'diagnostic'
    ? [
        'sqlite3',
        sqlitePath,
        'PRAGMA quick_check; PRAGMA page_count; PRAGMA freelist_count; SELECT COUNT(*) AS queue_prompt_count FROM queue_prompt; SELECT COUNT(*) AS judgment_outbox_count FROM judgment_outbox;',
      ]
    : step === 'checkpoint'
      ? ['sqlite3', sqlitePath, 'PRAGMA wal_checkpoint(TRUNCATE);']
      : ['sqlite3', sqlitePath, '.dump']
}

const runSystemSqliteFallbackStep = ({
  jobId,
  step,
}: {
  jobId: string
  step: JudgmentJobSystemSqliteFallbackStep
}): JudgmentJobSystemSqliteFallbackResult => {
  const command = getSystemSqliteFallbackCommand({jobId, step})
  const exportPath = step === 'export' ? getSystemSqliteExportPath(jobId) : null
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const walPath = `${sqlitePath}-wal`
  const walBytesBefore = existsSync(walPath) ? getFileByteSize(walPath) : null
  const result = globalThis.Bun.spawnSync(command, {
    cwd: process.cwd(),
    env: {...process.env},
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const stdout = decodeSpawnOutput(result.stdout).trim()
  const stderr = decodeSpawnOutput(result.stderr).trim()
  const ok = result.exitCode === 0

  if (ok && exportPath) {
    writeFileSync(exportPath, stdout)
  }

  return {
    command,
    exitCode: result.exitCode,
    exportBytes: exportPath && ok ? getFileByteSize(exportPath) : null,
    exportPath: exportPath && ok ? exportPath : null,
    ok,
    stderr,
    step,
    stdout,
    walBytesAfter: step === 'checkpoint' && ok ? getFileByteSize(walPath) : walBytesBefore,
    walBytesBefore,
  }
}

const getEmptyHealthSnapshot = (): JudgmentJobSqliteHealthSnapshot => {
  return {
    claimedOutboxCount: 0,
    lastAckSeq: null,
    oldestUnexportedAgeMs: null,
    outboxRowCount: 0,
    promptCounts: {judged: 0, ready: 0, sent: 0, skipped: 0},
    retainedRowCount: 0,
    sqliteFileBytes: null,
    walBytes: 0,
  }
}

const getExistingTableNames = (database: Database) => {
  return new Set(
    (database.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as SqliteMasterRow[]).map((row) => {
      return row.name
    }),
  )
}

const getTableColumnNames = (database: Database, tableName: string) => {
  return new Set(
    (database.query(`PRAGMA table_info('${tableName}')`).all() as SqliteTableInfoRow[]).map((row) => {
      return row.name
    }),
  )
}

const getJudgmentJobSqliteSchemaProblems = (database: Database) => {
  const existingTables = getExistingTableNames(database)

  return Object.entries(judgmentJobSqliteRequiredSchema).reduce<string[]>((problems, [tableName, requiredColumns]) => {
    if (!existingTables.has(tableName)) {
      return [...problems, `missing table ${tableName}`]
    }

    const existingColumns = getTableColumnNames(database, tableName)
    const missingColumns = requiredColumns.filter((columnName) => {
      return !existingColumns.has(columnName)
    })

    return missingColumns.length === 0
      ? problems
      : [...problems, `missing columns on ${tableName}: ${missingColumns.join(', ')}`]
  }, [])
}

const getIsolatedPreflightSnapshot = (database: Database, jobId: string): JudgmentJobSqlitePreflightSnapshot => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const walPath = `${sqlitePath}-wal`
  const schemaProblems = getJudgmentJobSqliteSchemaProblems(database)

  if (schemaProblems.length > 0) {
    throw new JudgmentJobSqlitePreflightError(
      `SQLite job DB preflight failed for ${jobId}: ${schemaProblems.join('; ')}`,
    )
  }

  const queueSampleCount = (
    database
      .query(
        `
          SELECT id
          FROM queue_prompt
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `,
      )
      .all() as Array<{id: string}>
  ).length
  const outboxSampleCount = (
    database
      .query(
        `
          SELECT outbox_seq
          FROM judgment_outbox
          ORDER BY outbox_seq ASC
          LIMIT 1
        `,
      )
      .all() as Array<{outboxSeq: number}>
  ).length

  database
    .query(
      `
        SELECT job_id AS jobId
        FROM job_scan_state
        WHERE job_id = ?
        LIMIT 1
      `,
    )
    .get(jobId)

  return {
    outboxSampleCount,
    queueSampleCount,
    sqliteFileBytes: getFileByteSize(sqlitePath),
    walBytes: getFileByteSize(walPath),
  }
}

const runIsolatedJudgmentJobSqlitePreflight = (jobId: string): JudgmentJobSqlitePreflightSnapshot => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  if (!existsSync(sqlitePath)) {
    throw new JudgmentJobSqlitePreflightError(`SQLite job DB preflight failed for ${jobId}: SQLite DB is missing`)
  }

  let database: Database | null = null

  try {
    database = new Database(sqlitePath, {readonly: true})
    database.exec(`
      PRAGMA query_only = 1;
      PRAGMA busy_timeout = 1000;
    `)

    return getIsolatedPreflightSnapshot(database, jobId)
  } catch (error) {
    throw error instanceof JudgmentJobSqlitePreflightError
      ? error
      : new JudgmentJobSqlitePreflightError(`SQLite job DB preflight failed for ${jobId}`, {cause: error})
  } finally {
    database?.close(false)
  }
}

const isDrainedSqliteJob = (database: Database, _jobId: string) => {
  return getActiveQueueRowCount(database) === 0 && getRetainedOutboxCount(database) === 0
}

const runWalCheckpoint = (database: Database) => {
  const row = database.query(`PRAGMA wal_checkpoint(TRUNCATE)`).get() as WalCheckpointRow | null

  return Number(row?.busy ?? 1) === 0
}

const markJudgmentJobStorageState = async ({
  fromStorageState,
  jobId,
  toStorageState,
}: {
  fromStorageState: string
  jobId: string
  toStorageState: string
}) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET storage_state = ${getSqlLiteral(toStorageState)},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
      AND storage_state = ${getSqlLiteral(fromStorageState)}
  `)
}

const finalizeDrainingSqliteJobs = async ({
  jobIds,
  serverJobId,
}: {
  jobIds: string[]
  serverJobId?: string
}): Promise<string[]> => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return []
  }

  try {
    const shouldMarkDrained = await withOwnedJobDatabase(
      currentJobId,
      false,
      (database) => {
        return isDrainedSqliteJob(database, currentJobId) && runWalCheckpoint(database)
      },
      serverJobId,
    )

    if (!shouldMarkDrained) {
      return finalizeDrainingSqliteJobs({jobIds: jobIds.slice(1), serverJobId})
    }

    await markJudgmentJobStorageState({fromStorageState: 'draining', jobId: currentJobId, toStorageState: 'drained'})

    return [currentJobId, ...(await finalizeDrainingSqliteJobs({jobIds: jobIds.slice(1), serverJobId}))]
  } catch (error) {
    return error instanceof JudgmentJobLeaseError
      ? finalizeDrainingSqliteJobs({jobIds: jobIds.slice(1), serverJobId})
      : Promise.reject(error)
  }
}

const deleteDrainedSqliteJobs = async ({
  jobIds,
  serverJobId,
}: {
  jobIds: string[]
  serverJobId?: string
}): Promise<string[]> => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return []
  }

  try {
    const shouldDelete = await withOwnedJobDatabase(
      currentJobId,
      false,
      (database) => {
        return isDrainedSqliteJob(database, currentJobId) && runWalCheckpoint(database)
      },
      serverJobId,
    )

    if (!shouldDelete) {
      return deleteDrainedSqliteJobs({jobIds: jobIds.slice(1), serverJobId})
    }

    await ensureOwnedJobLease(currentJobId, serverJobId)
    await releaseOwnedJobLease(currentJobId)
    deleteJobFiles(currentJobId)

    return [currentJobId, ...(await deleteDrainedSqliteJobs({jobIds: jobIds.slice(1), serverJobId}))]
  } catch (error) {
    return error instanceof JudgmentJobLeaseError
      ? deleteDrainedSqliteJobs({jobIds: jobIds.slice(1), serverJobId})
      : Promise.reject(error)
  }
}

const emptyRetentionPruneResult = (): RetentionPruneResult => {
  return {outboxRowsDeleted: 0, queuePromptRowsDeleted: 0}
}

const addRetentionPruneResults = (left: RetentionPruneResult, right: RetentionPruneResult): RetentionPruneResult => {
  return {
    outboxRowsDeleted: left.outboxRowsDeleted + right.outboxRowsDeleted,
    queuePromptRowsDeleted: left.queuePromptRowsDeleted + right.queuePromptRowsDeleted,
  }
}

const getSqlPlaceholders = (count: number) => {
  return Array.from({length: count}, () => {
    return '?'
  })
}

const getVisibilityAckedOutboxRows = (database: Database, visibilityAckSeq: number, limit: number) => {
  return database
    .query(
      `
        SELECT
          outbox_seq AS outboxSeq,
          queue_prompt_id AS queuePromptId
        FROM judgment_outbox
        WHERE exported_at IS NOT NULL
          AND outbox_seq <= ?
        ORDER BY outbox_seq ASC
        LIMIT ?
      `,
    )
    .all(visibilityAckSeq, limit) as RetentionEligibleOutboxRow[]
}

const getOutboxEntry = (row: OutboxRow) => {
  return {
    answeredOriginal: row.answeredOriginal,
    answeredOriginalAsArray: parseStringArrayText(row.answeredOriginalAsArray),
    articleId: row.articleId,
    chunkingStrategy: row.chunkingStrategy,
    confidenceOriginal: Number(row.confidenceOriginal ?? 0),
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    explanation: row.explanation,
    isAnswered: true,
    jobId: row.jobId,
    judgmentId: row.judgmentId,
    modelId: row.modelId,
    outboxSeq: Number(row.outboxSeq),
    projectId: row.projectId,
    promptId: row.promptId,
    queuePromptId: row.queuePromptId,
    quotes: parseJsonText(row.quotesJson),
    rawResponseJson: parseJsonText(row.rawResponseJson),
    snapshotProjectId: row.snapshotProjectId,
    snapshotProjectModelName: row.snapshotProjectModelName,
    updatedAt: getDateValue(row.updatedAt) ?? new Date(0),
    useAbstract: toBoolean(row.useAbstract),
    useFulltext: toBoolean(row.useFulltext),
    useFulltextNoImages: toBoolean(row.useFulltextNoImages),
    useTitle: toBoolean(row.useTitle),
  } satisfies JudgmentJobSqliteOutboxEntry
}

const getBoundedOutboxBatch = ({
  initialBytes,
  maxBytes,
  maxRows,
  rows,
}: {
  initialBytes: number
  maxBytes: number
  maxRows: number
  rows: OutboxRow[]
}) => {
  return rows.reduce(
    (state, row) => {
      const nextRow = getOutboxEntry(row)
      const nextBytes = state.bytes + JSON.stringify(nextRow).length

      return state.rows.length >= maxRows || (state.bytes > 0 && nextBytes > maxBytes)
        ? state
        : {bytes: nextBytes, rows: [...state.rows, nextRow]}
    },
    {bytes: initialBytes, rows: [] as JudgmentJobSqliteOutboxEntry[]},
  )
}

const getJobInfoForInitialization = async (jobId: string): Promise<JudgmentJobSqliteInfo> => {
  const [row] = await getAppDatabaseService().queryJson<JobInfoRow>(`
    SELECT
      jj.id AS jobId,
      jj.project_id AS projectId,
      jj.created_at AS createdAt,
      jj.cursor_last_created_at AS cursorLastDate,
      jj.cursor_last_article_id AS cursorLastArticleId,
      p.model_id AS modelId,
      pc.secret_ref AS modelSecretRef,
      COALESCE(pc.provider_kind, 'unknown') AS modelProvider,
      COALESCE(m.remote_model_id, m.name, m.display_name) AS modelName,
      m.variant AS modelVersion,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      pc.base_url AS modelBaseUrl,
      TO_JSON(pc.config_json) AS providerConfigJson,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages
    FROM app.judgment_job jj
    INNER JOIN app.project p ON p.id = jj.project_id
    INNER JOIN app.model m ON m.id = p.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.id = '${escapeSqlString(jobId)}'
    LIMIT 1
  `)

  const createdAt = getDateValue(row?.createdAt)
  const cursorLastDate = getDateValue(row?.cursorLastDate)

  if (!row?.projectId || !row.modelId || !row.modelName || !createdAt) {
    throw new Error(`Failed to initialize SQLite judgments job state for ${jobId}`)
  }

  return {
    createdAt,
    cursor:
      cursorLastDate && row.cursorLastArticleId
        ? {lastArticleId: row.cursorLastArticleId, lastDate: cursorLastDate}
        : null,
    jobId: row.jobId,
    modelBaseUrl: row.modelBaseUrl ?? null,
    modelId: row.modelId,
    modelMetadataJson:
      parseJsonText(
        typeof row.modelMetadataJson === 'string' ? row.modelMetadataJson : JSON.stringify(row.modelMetadataJson),
      ) ?? null,
    modelName: row.modelName,
    modelProvider: row.modelProvider ?? 'unknown',
    modelSecretRef: row.modelSecretRef ?? null,
    modelVersion: row.modelVersion ?? null,
    projectId: row.projectId,
    providerConfigJson:
      parseJsonText(
        typeof row.providerConfigJson === 'string' ? row.providerConfigJson : JSON.stringify(row.providerConfigJson),
      ) ?? null,
    useAbstract: row.useAbstract ?? true,
    useFulltext: row.useFulltext ?? false,
    useFulltextNoImages: row.useFulltextNoImages ?? false,
    useTitle: row.useTitle ?? true,
  }
}

const getLatestRuntimeInfoForModel = async (
  modelId: string,
): Promise<Pick<
  JudgmentJobSqliteInfo,
  | 'modelBaseUrl'
  | 'modelMetadataJson'
  | 'modelName'
  | 'modelProvider'
  | 'modelSecretRef'
  | 'modelVersion'
  | 'providerConfigJson'
> | null> => {
  const [row] = await getAppDatabaseService().queryJson<LiveModelRuntimeRow>(`
    SELECT
      pc.base_url AS modelBaseUrl,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      COALESCE(m.remote_model_id, m.name, m.display_name) AS modelName,
      COALESCE(pc.provider_kind, 'unknown') AS modelProvider,
      pc.secret_ref AS modelSecretRef,
      m.variant AS modelVersion,
      TO_JSON(pc.config_json) AS providerConfigJson
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = '${escapeSqlString(modelId)}'
    LIMIT 1
  `)

  return row?.modelName
    ? {
        modelBaseUrl: row.modelBaseUrl ?? null,
        modelMetadataJson:
          parseJsonText(
            typeof row.modelMetadataJson === 'string' ? row.modelMetadataJson : JSON.stringify(row.modelMetadataJson),
          ) ?? null,
        modelName: row.modelName,
        modelProvider: row.modelProvider ?? 'unknown',
        modelSecretRef: row.modelSecretRef ?? null,
        modelVersion: row.modelVersion ?? null,
        providerConfigJson:
          parseJsonText(
            typeof row.providerConfigJson === 'string'
              ? row.providerConfigJson
              : JSON.stringify(row.providerConfigJson),
          ) ?? null,
      }
    : null
}

// This service currently enforces exclusive local ownership of a SQLite job.
// It does not try to distribute one job across multiple servers yet.
const ensureOwnedJobLease = async (jobId: string, serverJobId = getDefaultJudgmentServerJobId()) => {
  startOwnedJobLeaseHeartbeatMonitor()

  const currentLease = ownedJobLeases.get(jobId)

  if (currentLease) {
    try {
      const nextLease = await updateJudgmentJobLeaseHeartbeat(currentLease)
      ownedJobLeases.set(jobId, nextLease)
      return nextLease
    } catch (error) {
      releaseOwnedJobLeaseState(jobId)
      throw new JudgmentJobLeaseError(`Failed to refresh SQLite job lease for ${jobId}`, {cause: error})
    }
  }

  try {
    const nextLease = await acquireJudgmentJobLease({
      apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
      jobId,
      serverJobId,
    })
    ownedJobLeases.set(jobId, nextLease)
    return nextLease
  } catch (error) {
    throw new JudgmentJobLeaseError(`Failed to acquire SQLite job lease for ${jobId}`, {cause: error})
  }
}

const withOwnedJobDatabase = async <T>(
  jobId: string,
  createIfMissing: boolean,
  operation: (database: Database) => T,
  serverJobId?: string,
): Promise<T | null> => {
  startOwnedJobLeaseOperation(jobId)

  try {
    await ensureOwnedJobLease(jobId, serverJobId)
    return withJobDatabase(jobId, createIfMissing, operation)
  } finally {
    finishOwnedJobLeaseOperation(jobId)
  }
}

const releaseOwnedJobLease = async (jobId: string) => {
  const currentLease = ownedJobLeases.get(jobId)

  releaseOwnedJobLeaseState(jobId)

  if (!currentLease) {
    return
  }

  await releaseJudgmentJobLease(currentLease)
}

const getClaimableOutboxRows = (database: Database, limit: number) => {
  return database
    .query(
      `
        SELECT
          outbox_seq AS outboxSeq,
          job_id AS jobId,
          queue_prompt_id AS queuePromptId,
          judgment_id AS judgmentId,
          article_id AS articleId,
          prompt_id AS promptId,
          model_id AS modelId,
          project_id AS projectId,
          snapshot_project_id AS snapshotProjectId,
          snapshot_project_model_name AS snapshotProjectModelName,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          chunking_strategy AS chunkingStrategy,
          answered_original AS answeredOriginal,
          answered_original_as_array AS answeredOriginalAsArray,
          confidence_original AS confidenceOriginal,
          explanation,
          quotes_json AS quotesJson,
          raw_response_json AS rawResponseJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM judgment_outbox
        WHERE exported_at IS NULL
          AND export_claim_id IS NULL
        ORDER BY outbox_seq ASC
        LIMIT ?
      `,
    )
    .all(limit) as OutboxRow[]
}

const getClaimedOutboxRows = (database: Database, claimId: string) => {
  return database
    .query(
      `
        SELECT
          outbox_seq AS outboxSeq,
          job_id AS jobId,
          queue_prompt_id AS queuePromptId,
          judgment_id AS judgmentId,
          article_id AS articleId,
          prompt_id AS promptId,
          model_id AS modelId,
          project_id AS projectId,
          snapshot_project_id AS snapshotProjectId,
          snapshot_project_model_name AS snapshotProjectModelName,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          chunking_strategy AS chunkingStrategy,
          answered_original AS answeredOriginal,
          answered_original_as_array AS answeredOriginalAsArray,
          confidence_original AS confidenceOriginal,
          explanation,
          quotes_json AS quotesJson,
          raw_response_json AS rawResponseJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM judgment_outbox
        WHERE exported_at IS NULL
          AND export_claim_id = ?
        ORDER BY outbox_seq ASC
      `,
    )
    .all(claimId) as OutboxRow[]
}

const getOldestClaimedOutboxRow = (database: Database) => {
  return database
    .query(
      `
        SELECT
          export_claim_id AS claimId,
          COUNT(*) AS rowCount
        FROM judgment_outbox
        WHERE exported_at IS NULL
          AND export_claim_id IS NOT NULL
        GROUP BY export_claim_id
        ORDER BY MIN(COALESCE(export_claimed_at, created_at)) ASC, MIN(outbox_seq) ASC
        LIMIT 1
      `,
    )
    .get() as ClaimedOutboxRow | null
}

const getOutboxPlaceholders = (outboxSeqs: number[]) => {
  return outboxSeqs.map(() => {
    return '?'
  })
}

const claimOutboxRows = ({
  claimedBy,
  database,
  jobId,
  rows,
}: {
  claimedBy: string
  database: Database
  jobId: string
  rows: JudgmentJobSqliteOutboxEntry[]
}): JudgmentJobSqliteClaimedOutboxBatch | null => {
  const claimId = randomUUID()
  const now = new Date().toISOString()
  const outboxSeqs = rows.map((row) => {
    return row.outboxSeq
  })
  const placeholders = getOutboxPlaceholders(outboxSeqs)
  const result = database
    .query(
      `
        UPDATE judgment_outbox
        SET export_claim_id = ?,
            export_claimed_at = ?,
            export_claimed_by = ?,
            export_attempts = export_attempts + 1,
            last_error = NULL
        WHERE outbox_seq IN (${placeholders.join(', ')})
          AND exported_at IS NULL
          AND export_claim_id IS NULL
      `,
    )
    .run(claimId, now, claimedBy, ...outboxSeqs) as {changes?: number}

  return Number(result.changes ?? 0) === rows.length ? {claim: {claimId, jobId, rowCount: rows.length}, rows} : null
}

const claimPendingOutboxBatchForJob = async ({
  claimedBy,
  jobId,
  maxBytes,
  maxRows,
}: {
  claimedBy: string
  jobId: string
  maxBytes: number
  maxRows: number
}): Promise<JudgmentJobSqliteClaimedOutboxBatch | null> => {
  return withOwnedJobDatabase(
    jobId,
    false,
    (database) => {
      return database.transaction(() => {
        const rows = getBoundedOutboxBatch({
          initialBytes: 0,
          maxBytes,
          maxRows,
          rows: getClaimableOutboxRows(database, maxRows),
        }).rows

        return rows.length === 0 ? null : claimOutboxRows({claimedBy, database, jobId, rows})
      })()
    },
    claimedBy,
  )
}

const getClaimedOutboxBatchForJob = async ({
  jobId,
  serverJobId,
}: {
  jobId: string
  serverJobId?: string
}): Promise<JudgmentJobSqliteClaimedOutboxBatch | null> => {
  return withOwnedJobDatabase(
    jobId,
    false,
    (database) => {
      const claimedRow = getOldestClaimedOutboxRow(database)

      return claimedRow
        ? {
            claim: {claimId: claimedRow.claimId, jobId, rowCount: Number(claimedRow.rowCount)},
            rows: getClaimedOutboxRows(database, claimedRow.claimId).map(getOutboxEntry),
          }
        : null
    },
    serverJobId,
  )
}

const claimPendingOutboxBatchForJobIds = async ({
  claimedBy,
  jobIds,
  maxBytes,
  maxRows,
}: {
  claimedBy: string
  jobIds: string[]
  maxBytes: number
  maxRows: number
}): Promise<JudgmentJobSqliteClaimedOutboxBatch | null> => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return null
  }

  const claimedBatch = await claimPendingOutboxBatchForJob({claimedBy, jobId: currentJobId, maxBytes, maxRows})

  return claimedBatch ?? claimPendingOutboxBatchForJobIds({claimedBy, jobIds: jobIds.slice(1), maxBytes, maxRows})
}

const pruneVisibilityAckedRetentionForJob = async ({
  jobId,
  maxRows,
  serverJobId,
}: {
  jobId: string
  maxRows: number
  serverJobId?: string
}): Promise<RetentionPruneResult> => {
  return (
    (await withOwnedJobDatabase(
      jobId,
      false,
      (database) => {
        const visibilityAckSeq = getStoredScanState(database, jobId).lastProjectRefreshAckSeq

        if (visibilityAckSeq == null || maxRows <= 0) {
          return emptyRetentionPruneResult()
        }

        return database.transaction((ackSeq: number) => {
          const eligibleRows = getVisibilityAckedOutboxRows(database, ackSeq, maxRows)

          if (eligibleRows.length === 0) {
            return emptyRetentionPruneResult()
          }

          const outboxSeqs = eligibleRows.map((row) => {
            return row.outboxSeq
          })
          const queuePromptIds = eligibleRows.map((row) => {
            return row.queuePromptId
          })
          const outboxPlaceholders = getSqlPlaceholders(outboxSeqs.length)
          const queuePromptPlaceholders = getSqlPlaceholders(queuePromptIds.length)
          const queuePromptDelete = database.query(`
            DELETE FROM queue_prompt
            WHERE id IN (${queuePromptPlaceholders.join(', ')})
              AND status = 'judged'
          `)
          const outboxDelete = database.query(`
            DELETE FROM judgment_outbox
            WHERE outbox_seq IN (${outboxPlaceholders.join(', ')})
              AND exported_at IS NOT NULL
              AND outbox_seq <= ?
          `)
          const queuePromptResult = queuePromptDelete.run(...queuePromptIds) as {changes?: number}
          const outboxResult = outboxDelete.run(...outboxSeqs, ackSeq) as {changes?: number}

          return {
            outboxRowsDeleted: Number(outboxResult.changes ?? 0),
            queuePromptRowsDeleted: Number(queuePromptResult.changes ?? 0),
          }
        })(visibilityAckSeq)
      },
      serverJobId,
    )) ?? emptyRetentionPruneResult()
  )
}

const pruneVisibilityAckedRetentionForJobIds = async ({
  jobIds,
  maxRows,
  serverJobId,
}: {
  jobIds: string[]
  maxRows: number
  serverJobId?: string
}): Promise<RetentionPruneResult> => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId || maxRows <= 0) {
    return emptyRetentionPruneResult()
  }

  const currentResult = await pruneVisibilityAckedRetentionForJob({jobId: currentJobId, maxRows, serverJobId})
  const remainingRows = maxRows - currentResult.outboxRowsDeleted

  return remainingRows <= 0
    ? currentResult
    : addRetentionPruneResults(
        currentResult,
        await pruneVisibilityAckedRetentionForJobIds({jobIds: jobIds.slice(1), maxRows: remainingRows, serverJobId}),
      )
}

const sqliteService = {
  addReadyPrompts: async (
    jobId: string,
    promptEntries: QueuePromptInsert[],
    serverJobId: string,
    maxInserted = Number.POSITIVE_INFINITY,
  ): Promise<number> => {
    const insertedCount = await withOwnedJobDatabase(
      jobId,
      false,
      (database) => {
        const normalizedMaxInserted = Number.isFinite(maxInserted)
          ? Math.max(0, Math.floor(maxInserted))
          : Number.POSITIVE_INFINITY

        if (promptEntries.length === 0 || normalizedMaxInserted === 0) {
          return 0
        }

        const insert = database.query(`
        INSERT OR IGNORE INTO queue_prompt (
          id,
          job_id,
          article_id,
          prompt_id,
          status,
          server_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?)
      `)
        const now = new Date().toISOString()

        return database.transaction((entries: QueuePromptInsert[]) => {
          return entries.reduce((count, entry) => {
            if (count >= normalizedMaxInserted) {
              return count
            }

            const result = insert.run(randomUUID(), jobId, entry.articleId, entry.promptId, serverJobId, now, now) as {
              changes?: number
            }

            return count + (result.changes === 1 ? 1 : 0)
          }, 0)
        })(promptEntries)
      },
      serverJobId,
    )

    return insertedCount ?? 0
  },
  claimReadyPrompts: async (jobId: string, serverJobId: string, limit: number): Promise<QueuePromptClaim[]> => {
    const claimed = await withOwnedJobDatabase(
      jobId,
      false,
      (database) => {
        const selectReady = database.query(`
        SELECT id, article_id AS articleId, prompt_id AS promptId
        FROM queue_prompt
        WHERE status = 'ready'
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `)
        const markSent = database.query(`
        UPDATE queue_prompt
        SET status = 'sent',
            sent_at = ?,
            updated_at = ?,
            server_id = ?,
            claim_id = ?
        WHERE id = ?
          AND status = 'ready'
      `)

        return database.transaction((requestedLimit: number) => {
          const now = new Date().toISOString()
          const readyRows = selectReady.all(requestedLimit) as QueuePromptRow[]

          return readyRows.flatMap((row) => {
            const claimId = randomUUID()
            const result = markSent.run(now, now, serverJobId, claimId, row.id) as {changes?: number}

            return result.changes === 1
              ? [{articleId: row.articleId, jobId, promptId: row.promptId, recordId: row.id}]
              : []
          })
        })(limit)
      },
      serverJobId,
    )

    return claimed ?? []
  },
  clearActiveQueue: async (jobId: string) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()

      database.transaction(() => {
        database.query(`DELETE FROM queue_prompt WHERE status = 'ready'`).run()
        database
          .query(
            `
          UPDATE job_scan_state
          SET cursor_last_date = NULL,
              cursor_last_article_id = NULL,
              scan_epoch = 0,
              exhausted_at = NULL,
              updated_at = ?
          WHERE job_id = ?
        `,
          )
          .run(now, jobId)
      })()
    })
  },
  closeAll: async () => {
    await Promise.all(
      Array.from(ownedJobLeases.keys()).map((jobId) => {
        return releaseOwnedJobLease(jobId)
      }),
    )
    openDatabases.forEach((_database, jobId) => {
      closeOpenDatabase(jobId)
    })
  },
  deleteJob: async (jobId: string) => {
    await ensureOwnedJobLease(jobId)
    await releaseOwnedJobLease(jobId)
    closeOpenDatabase(jobId)

    deleteJobFiles(jobId)
  },
  deleteDrainedJobs: async ({jobId, serverJobId}: {jobId?: string; serverJobId?: string} = {}) => {
    return deleteDrainedSqliteJobs({
      jobIds: await getSqliteCleanupCandidateJobIds({jobId, storageState: 'drained'}),
      serverJobId,
    })
  },
  finalizeDrainingJobs: async ({jobId, serverJobId}: {jobId?: string; serverJobId?: string} = {}) => {
    return finalizeDrainingSqliteJobs({
      jobIds: await getSqliteCleanupCandidateJobIds({jobId, storageState: 'draining'}),
      serverJobId,
    })
  },
  getInFlightCount: async (jobId: string): Promise<number> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        const row = database.query(`SELECT COUNT(*) AS count FROM queue_prompt WHERE status = 'sent'`).get() as {
          count: number
        } | null

        return Number(row?.count ?? 0)
      }) ?? 0
    )
  },
  getJobInfo: async (jobId: string): Promise<JudgmentJobSqliteInfo | null> => {
    const storedJobInfo =
      withJobDatabase(jobId, false, (database) => {
        const row = database
          .query(
            `
          SELECT
            job_id AS jobId,
            project_id AS projectId,
            model_id AS modelId,
            model_name AS modelName,
            model_provider AS modelProvider,
            model_version AS modelVersion,
            model_base_url AS modelBaseUrl,
            model_secret_ref AS modelSecretRef,
            model_metadata_json AS modelMetadataJson,
            provider_config_json AS providerConfigJson,
            use_title AS useTitle,
            use_abstract AS useAbstract,
            use_fulltext AS useFulltext,
            use_fulltext_no_images AS useFulltextNoImages,
            created_at AS createdAt
          FROM job_info
          WHERE job_id = ?
          LIMIT 1
        `,
          )
          .get(jobId) as {
          createdAt: string
          jobId: string
          modelBaseUrl: string | null
          modelId: string
          modelMetadataJson: string | null
          modelName: string
          modelProvider: string
          modelSecretRef: string | null
          modelVersion: string | null
          projectId: string
          providerConfigJson: string | null
          useAbstract: number
          useFulltext: number
          useFulltextNoImages: number
          useTitle: number
        } | null
        const createdAt = getDateValue(row?.createdAt)

        return row && createdAt
          ? {
              createdAt,
              cursor: null,
              jobId: row.jobId,
              modelBaseUrl: row.modelBaseUrl,
              modelId: row.modelId,
              modelMetadataJson: parseJsonText(row.modelMetadataJson),
              modelName: row.modelName,
              modelProvider: row.modelProvider,
              modelSecretRef: row.modelSecretRef,
              modelVersion: row.modelVersion,
              projectId: row.projectId,
              providerConfigJson: parseJsonText(row.providerConfigJson),
              useAbstract: toBoolean(row.useAbstract),
              useFulltext: toBoolean(row.useFulltext),
              useFulltextNoImages: toBoolean(row.useFulltextNoImages),
              useTitle: toBoolean(row.useTitle),
            }
          : null
      }) ?? null

    if (!storedJobInfo) {
      return null
    }

    const latestRuntimeInfo = await getLatestRuntimeInfoForModel(storedJobInfo.modelId)

    return latestRuntimeInfo ? {...storedJobInfo, ...latestRuntimeInfo} : storedJobInfo
  },
  getPendingOutboxBatch: async ({jobId, maxBytes, maxRows}: {jobId?: string; maxBytes: number; maxRows: number}) => {
    const initialState = {bytes: 0, rows: [] as JudgmentJobSqliteOutboxEntry[]}
    const candidateJobIds = await getTrackedJudgmentJobIds(jobId)

    return candidateJobIds.reduce((state, currentJobId) => {
      if (state.rows.length >= maxRows || state.bytes >= maxBytes) {
        return state
      }

      const remainingRows = Math.max(1, maxRows - state.rows.length)
      const rawRows =
        withJobDatabase(currentJobId, false, (database) => {
          return getClaimableOutboxRows(database, remainingRows)
        }) ?? []
      const nextBatch = getBoundedOutboxBatch({initialBytes: state.bytes, maxBytes, maxRows, rows: rawRows})

      return {bytes: nextBatch.bytes, rows: [...state.rows, ...nextBatch.rows]}
    }, initialState).rows
  },
  claimPendingOutboxBatch: async ({
    claimedBy,
    jobId,
    maxBytes,
    maxRows,
  }: {
    claimedBy: string
    jobId?: string
    maxBytes: number
    maxRows: number
  }) => {
    return claimPendingOutboxBatchForJobIds({
      claimedBy,
      jobIds: await getTrackedJudgmentJobIds(jobId),
      maxBytes,
      maxRows,
    })
  },
  getClaimedOutboxBatch: async ({jobId, serverJobId}: {jobId: string; serverJobId?: string}) => {
    return getClaimedOutboxBatchForJob({jobId, serverJobId})
  },
  getPromptStatusCounts: async (jobId: string): Promise<QueueCountRow[]> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        return database
          .query(
            `
          SELECT
            CASE WHEN status = 'judged' AND terminal_kind = 'skipped' THEN 'skipped' ELSE status END AS status,
            COUNT(*) AS count
          FROM queue_prompt
          GROUP BY CASE WHEN status = 'judged' AND terminal_kind = 'skipped' THEN 'skipped' ELSE status END
        `,
          )
          .all() as QueueCountRow[]
      }) ?? []
    )
  },
  getReadyCount: async (jobId: string): Promise<number> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        const row = database.query(`SELECT COUNT(*) AS count FROM queue_prompt WHERE status = 'ready'`).get() as {
          count: number
        } | null

        return Number(row?.count ?? 0)
      }) ?? 0
    )
  },
  getScanState: async (jobId: string): Promise<JobScanState> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        return getStoredScanState(database, jobId)
      }) ?? {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    )
  },
  getMaxOutboxSeq: async (jobId: string): Promise<number | null> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        const row = database.query(`SELECT MAX(outbox_seq) AS maxOutboxSeq FROM judgment_outbox`).get() as {
          maxOutboxSeq: number | null
        } | null

        return row?.maxOutboxSeq == null ? null : Number(row.maxOutboxSeq)
      }) ?? null
    )
  },
  getOutboxCount: async (jobId: string): Promise<number> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        const row = database.query(`SELECT COUNT(*) AS count FROM judgment_outbox`).get() as {count: number} | null

        return Number(row?.count ?? 0)
      }) ?? 0
    )
  },
  getHealthSnapshot: async (jobId: string): Promise<JudgmentJobSqliteHealthSnapshot> => {
    const sqlitePath = getJudgmentJobSqlitePath(jobId)
    const walPath = `${sqlitePath}-wal`
    const liveSnapshot = withJobDatabase(jobId, false, (database) => {
      return {
        claimedOutboxCount: getClaimedOutboxCount(database),
        lastAckSeq: getStoredScanState(database, jobId).lastProjectRefreshAckSeq,
        oldestUnexportedAgeMs: getOldestUnexportedAgeMs(database),
        outboxRowCount: getRetainedOutboxCount(database),
        promptCounts: getPromptCounts(database),
        retainedRowCount: getRetainedQueueRowCount(database),
      }
    })

    return liveSnapshot
      ? {...liveSnapshot, sqliteFileBytes: getSqliteFileByteSize(jobId), walBytes: getFileByteSize(walPath)}
      : getEmptyHealthSnapshot()
  },
  getUnexportedOutboxCount: async (jobId: string): Promise<number> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        const row = database.query(`SELECT COUNT(*) AS count FROM judgment_outbox WHERE exported_at IS NULL`).get() as {
          count: number
        } | null

        return Number(row?.count ?? 0)
      }) ?? 0
    )
  },
  hasJob: (jobId: string) => {
    return existsSync(getJudgmentJobSqlitePath(jobId))
  },
  runSystemSqliteFallback: async ({
    jobId,
    serverJobId,
    steps,
  }: {
    jobId: string
    serverJobId?: string
    steps: JudgmentJobSystemSqliteFallbackStep[]
  }): Promise<JudgmentJobSystemSqliteFallbackResult[]> => {
    if (!existsSync(getJudgmentJobSqlitePath(jobId)) || steps.length === 0) {
      return []
    }

    await ensureOwnedJobLease(jobId, serverJobId)
    closeOpenDatabase(jobId)

    return steps.reduce<Promise<JudgmentJobSystemSqliteFallbackResult[]>>(async (resultsPromise, step) => {
      const results = await resultsPromise
      return [...results, runSystemSqliteFallbackStep({jobId, step})]
    }, Promise.resolve([]))
  },
  checkpointWal: async ({jobId, serverJobId}: {jobId: string; serverJobId?: string}) => {
    return (
      (await withOwnedJobDatabase(
        jobId,
        false,
        (database) => {
          return runWalCheckpoint(database)
        },
        serverJobId,
      )) ?? false
    )
  },
  runIsolatedPreflight: async (jobId: string): Promise<JudgmentJobSqlitePreflightSnapshot> => {
    return runIsolatedJudgmentJobSqlitePreflight(jobId)
  },
  hasLocalJudgment: async (jobId: string, articleId: string, promptId: string): Promise<boolean> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        const row = database
          .query(
            `
          SELECT id
          FROM queue_prompt
          WHERE article_id = ?
            AND prompt_id = ?
            AND status = 'judged'
          LIMIT 1
        `,
          )
          .get(articleId, promptId) as {id: string} | null

        return Boolean(row)
      }) ?? false
    )
  },
  initializeJob: async (jobId: string) => {
    const jobInfo = await getJobInfoForInitialization(jobId)

    return withOwnedJobDatabase(jobId, true, (database) => {
      const createdAt = jobInfo.createdAt.toISOString()
      database.transaction(() => {
        database
          .query(
            `
          INSERT OR IGNORE INTO job_info (
            job_id,
            project_id,
            model_id,
            model_name,
            model_provider,
            model_version,
            model_base_url,
            model_secret_ref,
            model_metadata_json,
            provider_config_json,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            jobInfo.jobId,
            jobInfo.projectId,
            jobInfo.modelId,
            jobInfo.modelName,
            jobInfo.modelProvider,
            jobInfo.modelVersion,
            jobInfo.modelBaseUrl,
            jobInfo.modelSecretRef,
            JSON.stringify(jobInfo.modelMetadataJson),
            JSON.stringify(jobInfo.providerConfigJson),
            Number(jobInfo.useTitle),
            Number(jobInfo.useAbstract),
            Number(jobInfo.useFulltext),
            Number(jobInfo.useFulltextNoImages),
            createdAt,
          )
        database
          .query(
            `
          INSERT OR IGNORE INTO job_scan_state (
            job_id,
            cursor_last_date,
            cursor_last_article_id,
            scan_epoch,
            exhausted_at,
            last_project_refresh_ack_seq,
            wrap_visibility_ack_seq,
            updated_at
          ) VALUES (?, ?, ?, 0, NULL, NULL, NULL, ?)
        `,
          )
          .run(jobId, jobInfo.cursor?.lastDate.toISOString() ?? null, jobInfo.cursor?.lastArticleId ?? null, createdAt)
      })()
    })
  },
  listJobIds: () => {
    return getJudgmentJobSqliteJobIds()
  },
  hasOwnedLease: (jobId: string) => {
    return ownedJobLeases.has(jobId)
  },
  ensureOwnedLease: async (jobId: string, serverJobId?: string) => {
    return ensureOwnedJobLease(jobId, serverJobId)
  },
  releaseOwnedLease: async (jobId: string) => {
    await releaseOwnedJobLease(jobId)
  },
  syncOwnedLeases: async (jobIds: string[]) => {
    const activeJobIds = new Set(jobIds)
    await Promise.all(
      Array.from(ownedJobLeases.keys())
        .filter((jobId) => {
          return !activeJobIds.has(jobId) && !hasOwnedJobLeaseOperation(jobId)
        })
        .map((jobId) => {
          return releaseOwnedJobLease(jobId)
        }),
    )
  },
  completeOutboxClaim: async ({claimId, jobId}: {claimId: string; jobId: string}) => {
    return (
      (await withOwnedJobDatabase(jobId, false, (database) => {
        const now = new Date().toISOString()
        const result = database
          .query(
            `
              UPDATE judgment_outbox
              SET exported_at = ?,
                  export_claim_id = NULL,
                  export_claimed_at = NULL,
                  export_claimed_by = NULL,
                  last_error = NULL
              WHERE export_claim_id = ?
                AND exported_at IS NULL
            `,
          )
          .run(now, claimId) as {changes?: number}

        return Number(result.changes ?? 0)
      })) ?? 0
    )
  },
  completeClaimedOutboxRows: async ({
    claimId,
    jobId,
    rows,
  }: {
    claimId: string
    jobId: string
    rows: Array<{errorMessage: string | null; outboxSeq: number}>
  }) => {
    return rows.length === 0
      ? 0
      : ((await withOwnedJobDatabase(jobId, false, (database) => {
          const now = new Date().toISOString()
          const update = database.query(`
            UPDATE judgment_outbox
            SET exported_at = ?,
                export_claim_id = NULL,
                export_claimed_at = NULL,
                export_claimed_by = NULL,
                last_error = ?
            WHERE outbox_seq = ?
              AND export_claim_id = ?
              AND exported_at IS NULL
          `)

          return database.transaction((claimedRows: Array<{errorMessage: string | null; outboxSeq: number}>) => {
            return claimedRows.reduce((count, row) => {
              const result = update.run(now, row.errorMessage, row.outboxSeq, claimId) as {changes?: number}
              return count + Number(result.changes ?? 0)
            }, 0)
          })(rows)
        })) ?? 0)
  },
  releaseOutboxClaim: async ({
    claimId,
    errorMessage,
    jobId,
  }: {
    claimId: string
    errorMessage: string | null
    jobId: string
  }) => {
    return (
      (await withOwnedJobDatabase(jobId, false, (database) => {
        const result = database
          .query(
            `
              UPDATE judgment_outbox
              SET export_claim_id = NULL,
                  export_claimed_at = NULL,
                  export_claimed_by = NULL,
                  last_error = ?
              WHERE export_claim_id = ?
                AND exported_at IS NULL
            `,
          )
          .run(errorMessage, claimId) as {changes?: number}

        return Number(result.changes ?? 0)
      })) ?? 0
    )
  },
  reapStaleOutboxClaims: async ({jobId, staleBefore}: {jobId?: string; staleBefore: Date}) => {
    const reapedCounts = await Promise.all(
      getExistingOutboxJobIds(jobId).map((currentJobId) => {
        return withOwnedJobDatabase(currentJobId, false, (database) => {
          const result = database
            .query(
              `
                UPDATE judgment_outbox
                SET export_claim_id = NULL,
                    export_claimed_at = NULL,
                    export_claimed_by = NULL,
                    last_error = COALESCE(last_error, 'stale claim reaped')
                WHERE exported_at IS NULL
                  AND export_claim_id IS NOT NULL
                  AND export_claimed_at IS NOT NULL
                  AND export_claimed_at <= ?
              `,
            )
            .run(staleBefore.toISOString()) as {changes?: number}

          return Number(result.changes ?? 0)
        })
      }),
    )

    return reapedCounts
      .map((count) => {
        return Number(count ?? 0)
      })
      .reduce((totalCount, currentCount) => {
        return totalCount + currentCount
      }, 0)
  },
  markOutboxExported: async (entries: Array<{jobId: string; outboxSeq: number}>) => {
    const grouped = entries.reduce((map, entry) => {
      const current = map.get(entry.jobId) ?? []
      map.set(entry.jobId, [...current, entry.outboxSeq])
      return map
    }, new Map<string, number[]>())

    return Promise.all(
      Array.from(grouped.entries()).map(([jobId, outboxSeqs]) => {
        return withOwnedJobDatabase(jobId, false, (database) => {
          const placeholders = outboxSeqs.map(() => {
            return '?'
          })
          const now = new Date().toISOString()

          database
            .query(
              `
          UPDATE judgment_outbox
          SET exported_at = ?,
              export_attempts = export_attempts + 1,
              last_error = NULL
          WHERE outbox_seq IN (${placeholders.join(', ')})
        `,
            )
            .run(now, ...outboxSeqs)
        })
      }),
    )
  },
  markOutboxExportFailed: async (entries: Array<{jobId: string; outboxSeq: number}>, errorMessage: string) => {
    const grouped = entries.reduce((map, entry) => {
      const current = map.get(entry.jobId) ?? []
      map.set(entry.jobId, [...current, entry.outboxSeq])
      return map
    }, new Map<string, number[]>())

    return Promise.all(
      Array.from(grouped.entries()).map(([jobId, outboxSeqs]) => {
        return withOwnedJobDatabase(jobId, false, (database) => {
          const placeholders = outboxSeqs.map(() => {
            return '?'
          })

          database
            .query(
              `
          UPDATE judgment_outbox
          SET export_attempts = export_attempts + 1,
              last_error = ?
          WHERE outbox_seq IN (${placeholders.join(', ')})
        `,
            )
            .run(errorMessage, ...outboxSeqs)
        })
      }),
    )
  },
  markPromptAsJudged: async (jobId: string, recordId: string) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      database
        .query(
          `
        UPDATE queue_prompt
        SET status = 'judged',
            terminal_kind = NULL,
            skip_reason = NULL,
            judged_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
        )
        .run(now, now, recordId)
    })
  },
  markPromptAsRetry: async (jobId: string, recordId: string) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      database
        .query(
          `
        UPDATE queue_prompt
        SET status = 'ready',
            sent_at = NULL,
            updated_at = ?,
            claim_id = NULL
        WHERE id = ?
      `,
        )
        .run(now, recordId)
    })
  },
  markPromptAsSkipped: async (
    jobId: string,
    recordId: string,
    skipReason: 'conversion_failed' | 'fulltext_too_large' | 'no_fulltext',
  ) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      database
        .query(
          `
        UPDATE queue_prompt
        SET status = 'judged',
            terminal_kind = 'skipped',
            skip_reason = ?,
            judged_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
        )
        .run(skipReason, now, now, recordId)
    })
  },
  recordJudgmentSuccess: async (jobId: string, outboxInsert: QueuePromptOutboxInsert) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      database.transaction((input: QueuePromptOutboxInsert) => {
        database
          .query(
            `
          INSERT OR IGNORE INTO judgment_outbox (
            job_id,
            queue_prompt_id,
            judgment_id,
            article_id,
            prompt_id,
            model_id,
            project_id,
            snapshot_project_id,
            snapshot_project_model_name,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            chunking_strategy,
            is_answered,
            answered_original,
            answered_original_as_array,
            confidence_original,
            explanation,
            quotes_json,
            raw_response_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            jobId,
            input.queuePromptId,
            input.judgmentId,
            input.articleId,
            input.promptId,
            input.modelId,
            input.projectId,
            input.snapshotProjectId,
            input.snapshotProjectModelName,
            Number(input.useTitle),
            Number(input.useAbstract),
            Number(input.useFulltext),
            Number(input.useFulltextNoImages),
            input.chunkingStrategy,
            Number(input.isAnswered),
            input.answeredOriginal,
            JSON.stringify(input.answeredOriginalAsArray),
            input.confidenceOriginal,
            input.explanation,
            JSON.stringify(input.quotes),
            JSON.stringify(input.rawResponseJson),
            input.createdAt.toISOString(),
            input.updatedAt.toISOString(),
          )
        database
          .query(
            `
          UPDATE queue_prompt
          SET status = 'judged',
              terminal_kind = NULL,
              skip_reason = NULL,
              judged_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
          )
          .run(input.updatedAt.toISOString(), input.updatedAt.toISOString(), input.queuePromptId)
      })(outboxInsert)
    })
  },
  requeueAbandonedSentPrompts: async ({
    jobId,
    serverJobId,
    staleBefore,
  }: {
    jobId: string
    serverJobId: string
    staleBefore: Date
  }): Promise<number> => {
    return (
      (await withOwnedJobDatabase(
        jobId,
        false,
        (database) => {
          const result = database
            .query(
              `
          UPDATE queue_prompt
          SET status = 'ready',
              sent_at = NULL,
              updated_at = ?,
              server_id = ?,
              claim_id = NULL
          WHERE status = 'sent'
            AND COALESCE(server_id, '') <> ?
            AND sent_at <= ?
        `,
            )
            .run(new Date().toISOString(), serverJobId, serverJobId, staleBefore.toISOString()) as {changes?: number}

          return Number(result.changes ?? 0)
        },
        serverJobId,
      )) ?? 0
    )
  },
  setExhaustedAt: async (jobId: string, exhaustedAt: Date | null) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      database
        .query(
          `
        UPDATE job_scan_state
        SET exhausted_at = ?,
            updated_at = ?
        WHERE job_id = ?
      `,
        )
        .run(exhaustedAt?.toISOString() ?? null, now, jobId)
    })
  },
  setLastProjectRefreshAckSeq: async (jobId: string, lastProjectRefreshAckSeq: number | null) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      const nextAckSeq = getForwardOnlyAckSeq(
        getStoredScanState(database, jobId).lastProjectRefreshAckSeq,
        lastProjectRefreshAckSeq,
      )

      database
        .query(
          `
        UPDATE job_scan_state
        SET last_project_refresh_ack_seq = ?,
            updated_at = ?
        WHERE job_id = ?
      `,
        )
        .run(nextAckSeq, now, jobId)
    })
  },
  setScanState: async (jobId: string, state: JobScanStateUpdate) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      const currentState = getStoredScanState(database, jobId)
      const nextState = {
        cursor: Object.hasOwn(state, 'cursor') ? (state.cursor ?? null) : currentState.cursor,
        exhaustedAt: Object.hasOwn(state, 'exhaustedAt') ? (state.exhaustedAt ?? null) : currentState.exhaustedAt,
        lastProjectRefreshAckSeq: Object.hasOwn(state, 'lastProjectRefreshAckSeq')
          ? getForwardOnlyAckSeq(currentState.lastProjectRefreshAckSeq, state.lastProjectRefreshAckSeq ?? null)
          : currentState.lastProjectRefreshAckSeq,
        scanEpoch: state.scanEpoch ?? currentState.scanEpoch,
        wrapVisibilityAckSeq: Object.hasOwn(state, 'wrapVisibilityAckSeq')
          ? (state.wrapVisibilityAckSeq ?? null)
          : currentState.wrapVisibilityAckSeq,
      } satisfies JobScanState

      database
        .query(
          `
        UPDATE job_scan_state
        SET cursor_last_date = ?,
            cursor_last_article_id = ?,
            scan_epoch = ?,
            exhausted_at = ?,
            last_project_refresh_ack_seq = ?,
            wrap_visibility_ack_seq = ?,
            updated_at = ?
        WHERE job_id = ?
      `,
        )
        .run(
          nextState.cursor?.lastDate.toISOString() ?? null,
          nextState.cursor?.lastArticleId ?? null,
          nextState.scanEpoch,
          nextState.exhaustedAt?.toISOString() ?? null,
          nextState.lastProjectRefreshAckSeq,
          nextState.wrapVisibilityAckSeq,
          now,
          jobId,
        )
    })
  },
  pruneVisibilityAckedRetention: async ({
    jobId,
    maxRows,
    serverJobId,
  }: {
    jobId?: string
    maxRows: number
    serverJobId?: string
  }) => {
    const normalizedMaxRows = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0

    return pruneVisibilityAckedRetentionForJobIds({
      jobIds: await getTrackedJudgmentJobIds(jobId),
      maxRows: normalizedMaxRows,
      serverJobId,
    })
  },
}

registerWriterDemotionHandler(async () => {
  await sqliteService.closeAll()
})

export const getJudgmentJobSqliteService = () => {
  return sqliteService
}

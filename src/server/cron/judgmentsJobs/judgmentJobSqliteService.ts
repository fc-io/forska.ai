import {randomUUID} from 'node:crypto'
import {existsSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'

import {Database} from 'bun:sqlite'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createJudgmentExecutionSnapshotForClaim} from '../../services/judgmentExecutionSnapshotService.ts'
import {getJudgmentJobSqliteHealthProjectionService} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {writeRuntimeFailureLogEvent} from '../../utils/runtimeLogger.ts'
import {registerDuckdbOwnerDemotionHandler} from '../../utils/serverRuntimeRole.ts'
import {
  acquireJudgmentJobLease,
  isJudgmentJobLeaseHeldError,
  type JudgmentJobLease,
  type JudgmentJobLeaseMetadata,
  readJudgmentJobLease,
  releaseJudgmentJobLease,
  updateJudgmentJobLeaseHeartbeat,
} from './judgmentJobLease.ts'
import {
  getJudgmentJobLeasePath,
  getJudgmentJobSqliteJobIds,
  getJudgmentJobSqlitePath,
  getJudgmentJobsRootDirectory,
} from './judgmentJobPaths.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {recordJudgmentJobStorageTransfer} from './judgmentJobStorageTransferRuntime.ts'
import {
  appendRequestAttemptManifestRepairMarker,
  createRequestAttemptManifestRepairMarker,
  getRequestAttemptManifestMutationIds,
  getRequestAttemptManifestOwnerId,
  JudgmentRequestAttemptManifestCasExhaustedError,
  type JudgmentRequestAttemptManifestMutation,
  type JudgmentRequestAttemptManifestOwner,
  mutateRequestAttemptManifestEntries,
  parseRequestAttempts,
  requestAttemptManifestChanged,
  shouldExhaustRequestAttemptManifestCas,
  stringifyManifestEntries,
} from './judgmentRequestAttemptManifest.ts'

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

export type JobCursor = {lastDate: Date; lastArticleId: string; priorityBucket: number}

type QueueCountRow = {count: number; status: string}

type QueuePromptRow = {articleId: string; id: string; promptId: string}

type QueuePromptInsert = {articleId: string; promptId: string}

type QueuePromptClaim = {
  articleId: string
  claimId: string
  executionSnapshotHash: string
  executionSnapshotId: string
  jobId: string
  modelId: string
  projectId: string
  promptId: string
  recordId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

const queuePromptReadyOrderColumnName = 'ready_insert_seq'

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
  claimId?: string
  completionTokenUseId?: string | null
  executionSnapshotHash?: string
  executionSnapshotId?: string
  modelId: string
  projectId: string | null
  promptId: string
  queuePromptId: string
  quotes: unknown
  rawResponseJson: unknown
  requestAttemptsJson?: string | null
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
  claimId: string | null
  executionSnapshotHash: string | null
  executionSnapshotId: string | null
  modelId: string
  outboxSeq: number
  projectId: string | null
  promptId: string
  queuePromptId: string
  quotesJson: string | null
  rawResponseJson: string | null
  requestAttemptsJson: string | null
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
  claimId: string | null
  executionSnapshotHash: string | null
  executionSnapshotId: string | null
  modelId: string
  outboxSeq: number
  projectId: string | null
  promptId: string
  queuePromptId: string
  quotes: unknown
  rawResponseJson: unknown
  requestAttemptsJson: string | null
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
  hasOutboxRows: boolean
  hasPendingCompletionAck: boolean
  hasQueueRows: boolean
  lastAckSeq: number | null
  oldestUnackedCompletionAgeMs: number | null
  oldestUnexportedAgeMs: number | null
  orphanedJudgedRowCount: number
  outboxRowCount: number
  pendingCompletionAckCount: number
  promptCounts: {claimed: number; judged: number; ready: number; running: number; skipped: number}
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
  cursorPriorityBucket: number | null
  exhaustedAt: string | null
  lastProjectRefreshAckToken: number | null
  scanEpoch: number | null
  wrapVisibilityAckToken: number | null
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
type OrphanedJudgedQueueRepairCounts = {deletedRows: number; requeuedRows: number}
type OrphanedJudgedQueueRepairJobInfo = {
  modelId: string
  projectId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type OrphanedJudgedQueueRow = {articleId: string; promptId: string; queuePromptId: string}

type RetentionEligibleOutboxRow = {outboxSeq: number; queuePromptId: string}

type RetentionPruneResult = {outboxRowsDeleted: number; queuePromptRowsDeleted: number}

type PromptDispatchCounts = {claimed: number; running: number}

type PromptClaimIdentity = {
  articleId: string
  claimId: string
  executionSnapshotHash: string
  executionSnapshotId: string
  jobId: string
  modelId: string
  projectId: string
  promptId: string
  queueRecordId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type PromptClaimIdentityRow = {
  articleId: string
  claimId: string | null
  executionSnapshotHash: string | null
  executionSnapshotId: string | null
  promptId: string
}

type PromptCompletionAck = {
  claimId: string
  queuePromptId: string
  status: 'failed' | 'judged' | 'retry' | 'skipped'
  requestAttemptsJson?: string | null
  tokenUseId?: string | null
}

type PromptCompletionAckRow = {
  claimId: string
  completedAt: string
  queuePromptId: string
  status: 'failed' | 'judged' | 'retry' | 'skipped'
  requestAttemptsJson: string | null
  tokenUseId: string | null
}

type JudgmentJobStorageRow = {id: string}

type ProjectRefreshAckStateRow = {lastCompletedRefreshToken: number | null; projectId: string}

type ProjectRefreshVisibilityStateRow = {dirtyToken: number | null; lastCompletedRefreshToken: number | null}

type WalCheckpointRow = {busy: number; checkpointed: number; log: number}
type PendingCompletionAckRow = {count: number; exportedAt: string | null}
type QueuePromptManifestOwner = Extract<JudgmentRequestAttemptManifestOwner, {kind: 'queue_prompt'}>
type RequestAttemptManifestRow = {
  requestAttemptManifestJson: string | null
  requestAttemptManifestRepairJson: string | null
  requestAttemptManifestVersion: number
}

const openDatabases = new Map<string, Database>()
const ownedJobLeases = new Map<string, JudgmentJobLease>()
const ownedJobLeaseOperationCounts = new Map<string, number>()
const judgmentJobLeaseHeartbeatIntervalMs = 5_000
const judgmentJobLeaseOperationDrainPollMs = 25
const judgmentJobLeaseOperationDrainTimeoutMs = 10_000
const judgmentJobLeaseLogger = createRateLimitedLogger({windowMs: 30_000})
const judgmentJobHealthProjectionLogger = createRateLimitedLogger({windowMs: 30_000})
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

export class JudgmentPromptClaimIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JudgmentPromptClaimIdentityError'
  }
}

export type JudgmentJobLeaseRecoverySummary = {deleted: string[]; ignored: string[]; recovered: string[]}

const isValidJudgmentJobLeaseMetadata = (leaseMetadata: unknown): leaseMetadata is JudgmentJobLeaseMetadata => {
  return (
    typeof leaseMetadata === 'object'
    && leaseMetadata !== null
    && typeof (leaseMetadata as JudgmentJobLeaseMetadata).acquiredAt === 'string'
    && typeof (leaseMetadata as JudgmentJobLeaseMetadata).apiServerPort === 'number'
    && typeof (leaseMetadata as JudgmentJobLeaseMetadata).heartbeatAt === 'string'
    && typeof (leaseMetadata as JudgmentJobLeaseMetadata).hostname === 'string'
    && typeof (leaseMetadata as JudgmentJobLeaseMetadata).jobId === 'string'
    && typeof (leaseMetadata as JudgmentJobLeaseMetadata).leaseId === 'string'
    && typeof (leaseMetadata as JudgmentJobLeaseMetadata).pid === 'number'
    && typeof (leaseMetadata as JudgmentJobLeaseMetadata).serverJobId === 'string'
  )
}

const getRecoverableJudgmentJobLeaseIds = ({jobIds}: {jobIds?: string[]}) => {
  if (jobIds && jobIds.length > 0) {
    return jobIds.filter((jobId) => {
      return existsSync(getJudgmentJobLeasePath(jobId))
    })
  }

  const rootDirectory = getJudgmentJobsRootDirectory()

  return existsSync(rootDirectory)
    ? readdirSync(rootDirectory).reduce<string[]>((result, entry) => {
        return entry.endsWith('.lease.json') ? [...result, entry.slice(0, -'.lease.json'.length)] : result
      }, [])
    : []
}

const recoverJudgmentJobLeaseFromFile = async (jobId: string): Promise<'deleted' | 'ignored' | 'recovered'> => {
  const leasePath = getJudgmentJobLeasePath(jobId)
  const currentLeaseMetadata = await readJudgmentJobLease(jobId).catch((error) => {
    writeRuntimeFailureLogEvent({
      attrs: {error, jobId, leasePath},
      event: 'judgments.sqlite-lease.startup-recovery.read-failure',
      message: '[judgments] failed to read SQLite job lease during startup recovery',
      terminalArgs: [jobId, error],
    })
    rmSync(leasePath, {force: true})
    return null
  })

  if (!currentLeaseMetadata || !isValidJudgmentJobLeaseMetadata(currentLeaseMetadata)) {
    rmSync(leasePath, {force: true})
    return 'deleted'
  }

  if (currentLeaseMetadata.jobId !== jobId || !existsSync(getJudgmentJobSqlitePath(jobId))) {
    rmSync(leasePath, {force: true})
    return 'deleted'
  }

  const recoveredLease = await acquireJudgmentJobLease({
    apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
    jobId,
    serverJobId: currentLeaseMetadata.serverJobId ?? getDefaultJudgmentServerJobId(),
    takeoverLeaseId: currentLeaseMetadata.leaseId,
  }).catch((error) => {
    if (isJudgmentJobLeaseHeldError(error)) {
      return null
    }

    writeRuntimeFailureLogEvent({
      attrs: {error, jobId},
      event: 'judgments.sqlite-lease.startup-recovery.acquire-failure',
      message: '[judgments] failed to recover SQLite job lease during startup recovery',
      terminalArgs: [jobId, error],
    })
    return null
  })

  if (!recoveredLease) {
    return 'ignored'
  }

  ownedJobLeases.set(jobId, recoveredLease)
  return 'recovered'
}

const recoverStartupJudgmentJobLeases = async ({
  jobIds,
}: {jobIds?: string[]} = {}): Promise<JudgmentJobLeaseRecoverySummary> => {
  const candidates = getRecoverableJudgmentJobLeaseIds({jobIds})
  const initialSummary = {deleted: [] as string[], ignored: [] as string[], recovered: [] as string[]}

  return candidates.reduce<Promise<JudgmentJobLeaseRecoverySummary>>(async (summaryPromise, candidateJobId) => {
    const summary = await summaryPromise
    const status = await recoverJudgmentJobLeaseFromFile(candidateJobId)

    if (status === 'recovered') {
      return {...summary, recovered: [...summary.recovered, candidateJobId]}
    }

    if (status === 'deleted') {
      return {...summary, deleted: [...summary.deleted, candidateJobId]}
    }

    return {...summary, ignored: [...summary.ignored, candidateJobId]}
  }, Promise.resolve(initialSummary))
}

const getJudgmentJobLeaseMetadataForJob = async (jobId: string): Promise<JudgmentJobLeaseMetadata | null> => {
  const leaseMetadata = await readJudgmentJobLease(jobId).catch(() => {
    return null
  })

  return leaseMetadata && isValidJudgmentJobLeaseMetadata(leaseMetadata) ? leaseMetadata : null
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

const waitForOwnedJobLeaseOperationsToDrain = async (jobId: string, startedAtMs = Date.now()): Promise<void> => {
  if (!hasOwnedJobLeaseOperation(jobId)) {
    return
  }

  if (Date.now() - startedAtMs >= judgmentJobLeaseOperationDrainTimeoutMs) {
    judgmentJobLeaseLogger.warn(
      `judgment-job-lease:operation-drain-timeout:${jobId}`,
      '[judgments] timed out waiting for SQLite job operations before releasing lease',
      {activeOperations: getOwnedJobLeaseOperationCount(jobId), jobId},
    )
    return
  }

  await new Promise((resolve) => {
    setTimeout(resolve, judgmentJobLeaseOperationDrainPollMs)
  })
  return waitForOwnedJobLeaseOperationsToDrain(jobId, startedAtMs)
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
    const recoveredLease = await acquireJudgmentJobLeaseWithCurrentServerId({currentLease}).catch(() => {
      return null
    })

    if (recoveredLease) {
      ownedJobLeases.set(jobId, recoveredLease)
      return
    }

    releaseOwnedJobLeaseState(jobId)
    judgmentJobLeaseLogger.warn(`judgments:lease-heartbeat:${jobId}`, '[judgments] lost SQLite job lease heartbeat', {
      error: error instanceof Error ? error.message : String(error),
      jobId,
    })
  }
}

const acquireJudgmentJobLeaseWithCurrentServerId = async ({currentLease}: {currentLease: JudgmentJobLease}) => {
  const {metadata} = currentLease
  return acquireJudgmentJobLease({
    apiServerPort: Number(process.env.API_SERVER_PORT ?? 0),
    jobId: metadata.jobId,
    serverJobId: metadata.serverJobId ?? getDefaultJudgmentServerJobId(),
    takeoverLeaseId: metadata.leaseId,
  })
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
      cursor_priority_bucket INTEGER NOT NULL DEFAULT 0,
      scan_epoch INTEGER NOT NULL DEFAULT 0,
      exhausted_at TEXT,
      last_project_refresh_ack_token INTEGER,
      wrap_visibility_ack_token INTEGER,
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
      execution_snapshot_id TEXT,
      execution_snapshot_hash TEXT,
      sent_at TEXT,
      judged_at TEXT,
      extra_retry_count INTEGER NOT NULL DEFAULT 0,
      last_recoverable_error_code TEXT,
      retry_after_at TEXT,
      request_attempt_manifest_json TEXT NOT NULL DEFAULT '[]',
      request_attempt_manifest_version INTEGER NOT NULL DEFAULT 0,
      request_attempt_manifest_repair_json TEXT,
      ready_insert_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, article_id, prompt_id)
    );
    CREATE TABLE IF NOT EXISTS judgment_outbox (
      outbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      queue_prompt_id TEXT NOT NULL UNIQUE,
      judgment_id TEXT NOT NULL UNIQUE,
      claim_id TEXT,
      execution_snapshot_id TEXT,
      execution_snapshot_hash TEXT,
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
      request_attempts_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exported_at TEXT,
      export_claim_id TEXT,
      export_claimed_at TEXT,
      export_claimed_by TEXT,
      export_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS completion_ack (
      claim_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      queue_prompt_id TEXT NOT NULL,
      status TEXT NOT NULL,
      token_use_id TEXT,
      request_attempts_json TEXT,
      completed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_judgment_outbox_exported
      ON judgment_outbox(exported_at, outbox_seq);
  `)

  ensureJobScanStateSchema(database)
  ensureQueuePromptSchema(database)
  ensureOutboxClaimSchema(database)
  ensureCompletionAckSchema(database)

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
    'cursor_priority_bucket',
    'scan_epoch',
    'exhausted_at',
    'last_project_refresh_ack_token',
    'wrap_visibility_ack_token',
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
    'execution_snapshot_id',
    'execution_snapshot_hash',
    'sent_at',
    'ready_insert_seq',
    'request_attempt_manifest_json',
    'request_attempt_manifest_version',
    'request_attempt_manifest_repair_json',
    'created_at',
    'updated_at',
  ],
  judgment_outbox: [
    'outbox_seq',
    'job_id',
    'queue_prompt_id',
    'judgment_id',
    'claim_id',
    'execution_snapshot_id',
    'execution_snapshot_hash',
    'article_id',
    'prompt_id',
    'model_id',
    'created_at',
    'updated_at',
    'exported_at',
    'export_claim_id',
    'export_claimed_at',
    'export_claimed_by',
    'request_attempts_json',
  ],
  completion_ack: [
    'claim_id',
    'job_id',
    'queue_prompt_id',
    'status',
    'request_attempts_json',
    'completed_at',
    'updated_at',
  ],
} as const

const jobScanStateColumns = [
  {name: 'cursor_priority_bucket', sql: 'INTEGER NOT NULL DEFAULT 0'},
  {name: 'scan_epoch', sql: 'INTEGER NOT NULL DEFAULT 0'},
  {name: 'last_project_refresh_ack_token', sql: 'INTEGER'},
  {name: 'wrap_visibility_ack_token', sql: 'INTEGER'},
] as const

const queuePromptColumns = [
  {name: queuePromptReadyOrderColumnName, sql: 'INTEGER'},
  {name: 'extra_retry_count', sql: 'INTEGER NOT NULL DEFAULT 0'},
  {name: 'last_recoverable_error_code', sql: 'TEXT'},
  {name: 'retry_after_at', sql: 'TEXT'},
  {name: 'execution_snapshot_id', sql: 'TEXT'},
  {name: 'execution_snapshot_hash', sql: 'TEXT'},
  {name: 'request_attempt_manifest_json', sql: `TEXT NOT NULL DEFAULT '[]'`},
  {name: 'request_attempt_manifest_version', sql: 'INTEGER NOT NULL DEFAULT 0'},
  {name: 'request_attempt_manifest_repair_json', sql: 'TEXT'},
] as const

const judgmentOutboxColumns = [
  {name: 'claim_id', sql: 'TEXT'},
  {name: 'execution_snapshot_id', sql: 'TEXT'},
  {name: 'execution_snapshot_hash', sql: 'TEXT'},
  {name: 'request_attempts_json', sql: 'TEXT'},
] as const

const completionAckColumns = [
  {name: 'token_use_id', sql: 'TEXT'},
  {name: 'request_attempts_json', sql: 'TEXT'},
] as const

const legacyJobScanStateAckColumns = [
  {legacyName: 'last_project_refresh_ack_seq', nextName: 'last_project_refresh_ack_token'},
  {legacyName: 'wrap_visibility_ack_seq', nextName: 'wrap_visibility_ack_token'},
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

const addMissingQueuePromptColumns = (
  database: Database,
  columns: ReadonlyArray<(typeof queuePromptColumns)[number]>,
): void => {
  const [currentColumn] = columns

  if (!currentColumn) {
    return
  }

  database.exec(`ALTER TABLE queue_prompt ADD COLUMN ${currentColumn.name} ${currentColumn.sql}`)
  return addMissingQueuePromptColumns(database, columns.slice(1))
}

const addMissingJudgmentOutboxColumns = (
  database: Database,
  columns: ReadonlyArray<(typeof judgmentOutboxColumns)[number]>,
): void => {
  const [currentColumn] = columns

  if (!currentColumn) {
    return
  }

  database.exec(`ALTER TABLE judgment_outbox ADD COLUMN ${currentColumn.name} ${currentColumn.sql}`)
  return addMissingJudgmentOutboxColumns(database, columns.slice(1))
}

const addMissingCompletionAckColumns = (
  database: Database,
  columns: ReadonlyArray<(typeof completionAckColumns)[number]>,
): void => {
  const [currentColumn] = columns

  if (!currentColumn) {
    return
  }

  database.exec(`ALTER TABLE completion_ack ADD COLUMN ${currentColumn.name} ${currentColumn.sql}`)
  return addMissingCompletionAckColumns(database, columns.slice(1))
}

const renameLegacyJobScanStateAckColumns = (
  database: Database,
  columns: ReadonlyArray<(typeof legacyJobScanStateAckColumns)[number]>,
  existingColumnNames: Set<string>,
): void => {
  const [currentColumn] = columns

  if (!currentColumn) {
    return
  }

  if (existingColumnNames.has(currentColumn.legacyName) && !existingColumnNames.has(currentColumn.nextName)) {
    database.exec(`ALTER TABLE job_scan_state RENAME COLUMN ${currentColumn.legacyName} TO ${currentColumn.nextName}`)
  }

  return renameLegacyJobScanStateAckColumns(database, columns.slice(1), existingColumnNames)
}

const backfillJobScanStateAckTokens = (database: Database, existingColumnNames: Set<string>) => {
  const hasRefreshAckColumns =
    existingColumnNames.has('last_project_refresh_ack_seq') && existingColumnNames.has('last_project_refresh_ack_token')
  const hasWrapAckColumns =
    existingColumnNames.has('wrap_visibility_ack_seq') && existingColumnNames.has('wrap_visibility_ack_token')

  if (!hasRefreshAckColumns && !hasWrapAckColumns) {
    return
  }

  database.exec(`
    UPDATE job_scan_state
    SET last_project_refresh_ack_token = ${
      hasRefreshAckColumns
        ? `CASE
             WHEN last_project_refresh_ack_token IS NULL THEN last_project_refresh_ack_seq
             WHEN last_project_refresh_ack_seq IS NULL THEN last_project_refresh_ack_token
             ELSE MAX(last_project_refresh_ack_token, last_project_refresh_ack_seq)
           END`
        : 'last_project_refresh_ack_token'
    },
        wrap_visibility_ack_token = ${
          hasWrapAckColumns
            ? `CASE
                 WHEN wrap_visibility_ack_token IS NULL THEN wrap_visibility_ack_seq
                 WHEN wrap_visibility_ack_seq IS NULL THEN wrap_visibility_ack_token
                 ELSE MAX(wrap_visibility_ack_token, wrap_visibility_ack_seq)
               END`
            : 'wrap_visibility_ack_token'
        }
  `)
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
  const missingIdentityColumns = judgmentOutboxColumns.filter((column) => {
    return !existingColumnNames.has(column.name)
  })

  addMissingOutboxClaimColumns(database, missingColumns)
  addMissingJudgmentOutboxColumns(database, missingIdentityColumns)
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_judgment_outbox_claim
      ON judgment_outbox(exported_at, export_claimed_at, outbox_seq)
  `)
}

const getJobScanState = (row: ScanStateRow | null | undefined): JobScanState => {
  const lastDate = getDateValue(row?.cursorLastDate)
  const exhaustedAt = getDateValue(row?.exhaustedAt)

  return {
    cursor:
      lastDate && row?.cursorLastArticleId
        ? {lastArticleId: row.cursorLastArticleId, lastDate, priorityBucket: Number(row.cursorPriorityBucket ?? 0)}
        : null,
    exhaustedAt,
    lastProjectRefreshAckSeq: row?.lastProjectRefreshAckToken == null ? null : Number(row.lastProjectRefreshAckToken),
    scanEpoch: Number(row?.scanEpoch ?? 0),
    wrapVisibilityAckSeq: row?.wrapVisibilityAckToken == null ? null : Number(row.wrapVisibilityAckToken),
  }
}

const ensureJobScanStateSchema = (database: Database) => {
  const existingColumnNames = new Set(
    (database.query(`PRAGMA table_info('job_scan_state')`).all() as SqliteTableInfoRow[]).map((row) => {
      return row.name
    }),
  )
  renameLegacyJobScanStateAckColumns(database, legacyJobScanStateAckColumns, existingColumnNames)

  const upgradedColumnNames = new Set(
    (database.query(`PRAGMA table_info('job_scan_state')`).all() as SqliteTableInfoRow[]).map((row) => {
      return row.name
    }),
  )
  const missingColumns = jobScanStateColumns.filter((column) => {
    return !upgradedColumnNames.has(column.name)
  })

  addMissingJobScanStateColumns(database, missingColumns)

  const finalColumnNames = new Set(
    (database.query(`PRAGMA table_info('job_scan_state')`).all() as SqliteTableInfoRow[]).map((row) => {
      return row.name
    }),
  )

  backfillJobScanStateAckTokens(database, finalColumnNames)
}

const backfillQueuePromptReadyInsertSeq = (database: Database) => {
  database.exec(`
    WITH ordered_rows AS (
      SELECT
        id,
        ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS ready_insert_seq
      FROM queue_prompt
    )
    UPDATE queue_prompt
    SET ready_insert_seq = (
      SELECT ordered_rows.ready_insert_seq
      FROM ordered_rows
      WHERE ordered_rows.id = queue_prompt.id
    )
    WHERE ready_insert_seq IS NULL
  `)
}

const ensureQueuePromptSchema = (database: Database) => {
  const existingColumnNames = getTableColumnNames(database, 'queue_prompt')
  const missingColumns = queuePromptColumns.filter((column) => {
    return !existingColumnNames.has(column.name)
  })

  addMissingQueuePromptColumns(database, missingColumns)
  backfillQueuePromptReadyInsertSeq(database)
  database.exec(`DROP INDEX IF EXISTS idx_queue_prompt_status_created`)
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_prompt_status_ready_insert_seq
      ON queue_prompt(status, ready_insert_seq, id)
  `)
}

const ensureCompletionAckSchema = (database: Database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS completion_ack (
      claim_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      queue_prompt_id TEXT NOT NULL,
      status TEXT NOT NULL,
      token_use_id TEXT,
      request_attempts_json TEXT,
      completed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const existingColumnNames = getTableColumnNames(database, 'completion_ack')
  const missingColumns = completionAckColumns.filter((column) => {
    return !existingColumnNames.has(column.name)
  })

  addMissingCompletionAckColumns(database, missingColumns)
}

const getStoredScanState = (database: Database, jobId: string) => {
  const row = database
    .query(
      `
        SELECT
          cursor_last_date AS cursorLastDate,
          cursor_last_article_id AS cursorLastArticleId,
          cursor_priority_bucket AS cursorPriorityBucket,
          exhausted_at AS exhaustedAt,
          scan_epoch AS scanEpoch,
          last_project_refresh_ack_token AS lastProjectRefreshAckToken,
          wrap_visibility_ack_token AS wrapVisibilityAckToken
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
  return [...getExistingOutboxJobIds(jobId)].sort()
}

const getTrackedJudgmentJobIdsForProject = async (projectId: string) => {
  const trackedJobIds = getExistingOutboxJobIds().sort()

  if (trackedJobIds.length === 0) {
    return []
  }

  return (
    await getAppDatabaseService().queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_job
      WHERE id IN (${getQuotedStringList(trackedJobIds).join(', ')})
        AND project_id = ${getSqlLiteral(projectId)}
      ORDER BY id
    `)
  ).map((row) => {
    return row.id
  })
}

const getTrackedProjectRefreshAckStates = async (projectId?: string) => {
  const trackedJobIds = getExistingOutboxJobIds().sort()

  if (trackedJobIds.length === 0) {
    return []
  }

  const projectFilter = projectId === undefined ? '' : `AND project_id = ${getSqlLiteral(projectId)}`

  return getAppDatabaseService().queryJson<ProjectRefreshAckStateRow>(`
    SELECT
      project_id AS projectId,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken
    FROM app.project_mart_refresh_state
    WHERE project_id IN (
      SELECT DISTINCT project_id
      FROM app.judgment_job
      WHERE id IN (${getQuotedStringList(trackedJobIds).join(', ')})
        ${projectFilter}
    )
    ORDER BY project_id
  `)
}

const publishProjectRefreshAckForJobIds = async ({ackToken, jobIds}: {ackToken: number | null; jobIds: string[]}) => {
  return jobIds.reduce<Promise<number>>(async (updatedCountPromise, currentJobId) => {
    const updatedCount = await updatedCountPromise

    try {
      await sqliteService.setLastProjectRefreshAckSeq(currentJobId, ackToken)
      return updatedCount + 1
    } catch (error) {
      return error instanceof JudgmentJobLeaseError ? updatedCount : Promise.reject(error)
    }
  }, Promise.resolve(0))
}

const publishProjectRefreshAckForProject = async ({
  ackToken,
  projectId,
}: {
  ackToken: number | null
  projectId: string
}) => {
  return publishProjectRefreshAckForJobIds({ackToken, jobIds: await getTrackedJudgmentJobIdsForProject(projectId)})
}

const reconcileProjectRefreshAcks = async ({projectId}: {projectId?: string} = {}) => {
  return (await getTrackedProjectRefreshAckStates(projectId)).reduce<Promise<number>>(
    async (updatedCountPromise, currentState) => {
      const updatedCount = await updatedCountPromise

      return (
        updatedCount
        + (await publishProjectRefreshAckForProject({
          ackToken: currentState.lastCompletedRefreshToken,
          projectId: currentState.projectId,
        }))
      )
    },
    Promise.resolve(0),
  )
}

const sqliteCleanupTerminalStatuses = ['completed', 'paused', 'project_removed'] as const

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
  const row = database
    .query(`SELECT COUNT(*) AS count FROM queue_prompt WHERE status IN ('ready', 'claimed', 'running', 'sent')`)
    .get() as {count: number} | null

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

const getPendingCompletionAckState = ({
  database,
  projectDirtyToken,
  visibilityAckSeq,
}: {
  database: Database
  projectDirtyToken: number | null
  visibilityAckSeq: number | null
}) => {
  const isWaitingOnVisibilityAck =
    visibilityAckSeq == null || (projectDirtyToken !== null && visibilityAckSeq < projectDirtyToken)

  if (!isWaitingOnVisibilityAck) {
    return {hasPendingCompletionAck: false, oldestUnackedCompletionAgeMs: null, pendingCompletionAckCount: 0}
  }

  const row = database
    .query(
      `
      SELECT
        COUNT(*) AS count,
        MIN(exported_at) AS exportedAt
      FROM judgment_outbox
      WHERE exported_at IS NOT NULL
    `,
    )
    .get() as PendingCompletionAckRow | null
  const exportedAt = getDateValue(row?.exportedAt)
  const pendingCompletionAckCount = Number(row?.count ?? 0)

  return {
    hasPendingCompletionAck: pendingCompletionAckCount > 0,
    oldestUnackedCompletionAgeMs: exportedAt ? Math.max(0, Date.now() - exportedAt.getTime()) : null,
    pendingCompletionAckCount,
  }
}

const getRetainedQueueRowCount = (database: Database) => {
  const row = database.query(`SELECT COUNT(*) AS count FROM queue_prompt`).get() as {count: number} | null

  return Number(row?.count ?? 0)
}

const getOrphanedJudgedQueueRowCount = (database: Database) => {
  const row = database
    .query(
      `
      SELECT COUNT(*) AS count
      FROM queue_prompt qp
      WHERE qp.status = 'judged'
        AND qp.terminal_kind IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM judgment_outbox jo
          WHERE jo.queue_prompt_id = qp.id
        )
    `,
    )
    .get() as {count: number} | null

  return Number(row?.count ?? 0)
}

const getPromptCounts = (database: Database) => {
  const promptCounts = {claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0}

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
    if (row.status === 'claimed' || row.status === 'sent') promptCounts.claimed += Number(row.count)
    if (row.status === 'judged') promptCounts.judged = Number(row.count)
    if (row.status === 'running') promptCounts.running = Number(row.count)
    if (row.status === 'skipped') promptCounts.skipped = Number(row.count)
  })

  return promptCounts
}

const getDispatchCounts = (database: Database): PromptDispatchCounts => {
  const row = database
    .query(
      `
        SELECT
          SUM(CASE WHEN status IN ('claimed', 'sent') THEN 1 ELSE 0 END) AS claimedCount,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount
        FROM queue_prompt
      `,
    )
    .get() as {claimedCount: number | null; runningCount: number | null} | null

  return {claimed: Number(row?.claimedCount ?? 0), running: Number(row?.runningCount ?? 0)}
}

const getFileByteSize = (filePath: string) => {
  return existsSync(filePath) ? statSync(filePath).size : 0
}

const getSqliteFileByteSize = (jobId: string) => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  return existsSync(sqlitePath) ? statSync(sqlitePath).size : null
}

const getHealthSnapshotFromDatabase = (
  database: Database,
  jobId: string,
  projectRefreshState: ProjectRefreshVisibilityStateRow | null,
): Omit<JudgmentJobSqliteHealthSnapshot, 'sqliteFileBytes' | 'walBytes'> => {
  const scanState = getStoredScanState(database, jobId)
  const outboxRowCount = getRetainedOutboxCount(database)
  const retainedRowCount = getRetainedQueueRowCount(database)
  const pendingCompletionAck = getPendingCompletionAckState({
    database,
    projectDirtyToken: projectRefreshState?.dirtyToken ?? null,
    visibilityAckSeq: scanState.lastProjectRefreshAckSeq,
  })

  return {
    claimedOutboxCount: getClaimedOutboxCount(database),
    hasOutboxRows: outboxRowCount > 0,
    hasQueueRows: retainedRowCount > 0,
    lastAckSeq: scanState.lastProjectRefreshAckSeq,
    oldestUnexportedAgeMs: getOldestUnexportedAgeMs(database),
    orphanedJudgedRowCount: getOrphanedJudgedQueueRowCount(database),
    outboxRowCount,
    promptCounts: getPromptCounts(database),
    retainedRowCount,
    ...pendingCompletionAck,
  }
}

const publishHealthProjection = async ({health, jobId}: {health: JudgmentJobSqliteHealthSnapshot; jobId: string}) => {
  try {
    await getJudgmentJobSqliteHealthProjectionService().publishJudgmentJobSqliteHealthProjection({
      health,
      jobId,
      projectedBy: getDefaultJudgmentServerJobId(),
      projectionSource: 'local-sqlite',
    })
  } catch (error) {
    judgmentJobHealthProjectionLogger.warn(
      `judgments:sqlite-health-projection:${jobId}`,
      '[judgments] failed to publish SQLite health projection',
      {error: error instanceof Error ? error.message : String(error), jobId},
    )
  }
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
    cwd: dirname(sqlitePath),
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
    hasOutboxRows: false,
    hasPendingCompletionAck: false,
    hasQueueRows: false,
    lastAckSeq: null,
    oldestUnackedCompletionAgeMs: null,
    oldestUnexportedAgeMs: null,
    orphanedJudgedRowCount: 0,
    outboxRowCount: 0,
    pendingCompletionAckCount: 0,
    promptCounts: {claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0},
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
          ORDER BY ready_insert_seq ASC, id ASC
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

const upgradeJudgmentJobSqliteSchemaInPlace = (jobId: string) => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const cachedDatabase = openDatabases.get(jobId)
  let database: Database | null = null

  if (cachedDatabase) {
    ensureJobScanStateSchema(cachedDatabase)
    ensureQueuePromptSchema(cachedDatabase)
    ensureOutboxClaimSchema(cachedDatabase)
    ensureCompletionAckSchema(cachedDatabase)
    return
  }

  try {
    database = new Database(sqlitePath)
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
    `)

    const existingTables = getExistingTableNames(database)

    if (existingTables.has('job_scan_state')) {
      ensureJobScanStateSchema(database)
    }

    if (existingTables.has('queue_prompt')) {
      ensureQueuePromptSchema(database)
    }

    if (existingTables.has('judgment_outbox')) {
      ensureOutboxClaimSchema(database)
    }

    ensureCompletionAckSchema(database)
  } finally {
    database?.close(false)
  }
}

const runIsolatedJudgmentJobSqlitePreflight = (jobId: string): JudgmentJobSqlitePreflightSnapshot => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

  if (!existsSync(sqlitePath)) {
    throw new JudgmentJobSqlitePreflightError(`SQLite job DB preflight failed for ${jobId}: SQLite DB is missing`)
  }

  upgradeJudgmentJobSqliteSchemaInPlace(jobId)

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
  return (
    getActiveQueueRowCount(database) === 0
    && getRetainedOutboxCount(database) === 0
    && getOrphanedJudgedQueueRowCount(database) === 0
  )
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

const getVisibilityAckedOutboxRows = (database: Database, limit: number) => {
  return database
    .query(
      `
        SELECT
          outbox_seq AS outboxSeq,
          queue_prompt_id AS queuePromptId
        FROM judgment_outbox
        WHERE exported_at IS NOT NULL
        ORDER BY outbox_seq ASC
        LIMIT ?
      `,
    )
    .all(limit) as RetentionEligibleOutboxRow[]
}

const getProjectRefreshVisibilityStateForJob = async (
  jobId: string,
): Promise<ProjectRefreshVisibilityStateRow | null> => {
  const [row] = await getAppDatabaseService().queryJson<ProjectRefreshVisibilityStateRow>(`
    SELECT
      CAST(pmrs.dirty_token AS INTEGER) AS dirtyToken,
      CAST(pmrs.last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken
    FROM app.judgment_job jj
    INNER JOIN app.project_mart_refresh_state pmrs ON pmrs.project_id = jj.project_id
    WHERE jj.id = ${getSqlLiteral(jobId)}
    LIMIT 1
  `)

  return row ?? null
}

const getOrphanedJudgedQueuePairKey = ({articleId, promptId}: {articleId: string; promptId: string}) => {
  return `${articleId}|${promptId}`
}

const getOrphanedJudgedQueueRows = (database: Database, limit: number) => {
  return database
    .query(
      `
        SELECT
          qp.article_id AS articleId,
          qp.prompt_id AS promptId,
          qp.id AS queuePromptId
        FROM queue_prompt qp
        WHERE qp.status = 'judged'
          AND qp.terminal_kind IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM judgment_outbox jo
            WHERE jo.queue_prompt_id = qp.id
          )
        ORDER BY qp.updated_at ASC, qp.id ASC
        LIMIT ?
      `,
    )
    .all(limit) as OrphanedJudgedQueueRow[]
}

const getOrphanedJudgedQueueRepairJobInfo = (
  database: Database,
  jobId: string,
): OrphanedJudgedQueueRepairJobInfo | null => {
  const row = database
    .query(
      `
        SELECT
          model_id AS modelId,
          project_id AS projectId,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          use_title AS useTitle
        FROM job_info
        WHERE job_id = ?
        LIMIT 1
      `,
    )
    .get(jobId) as {
    modelId: string
    projectId: string
    useAbstract: number
    useFulltext: number
    useFulltextNoImages: number
    useTitle: number
  } | null

  return row
    ? {
        modelId: row.modelId,
        projectId: row.projectId,
        useAbstract: toBoolean(row.useAbstract),
        useFulltext: toBoolean(row.useFulltext),
        useFulltextNoImages: toBoolean(row.useFulltextNoImages),
        useTitle: toBoolean(row.useTitle),
      }
    : null
}

const getExistingEntityIds = async (
  tableName: 'app.article' | 'app.model' | 'app.project' | 'app.prompt',
  ids: string[],
) => {
  const uniqueIds = Array.from(new Set(ids))

  return uniqueIds.length === 0
    ? new Set<string>()
    : new Set(
        (
          await getAppDatabaseService().queryJson<{id: string}>(`
            SELECT id
            FROM ${tableName}
            WHERE id IN (${getQuotedStringList(uniqueIds).join(', ')})
          `)
        ).map((row) => {
          return row.id
        }),
      )
}

const getExistingJudgmentPairsForOrphanedQueueRows = async ({
  jobInfo,
  rows,
}: {
  jobInfo: OrphanedJudgedQueueRepairJobInfo
  rows: OrphanedJudgedQueueRow[]
}) => {
  return rows.length === 0
    ? new Set<string>()
    : new Set(
        (
          await getAppDatabaseService().queryJson<{articleId: string; promptId: string}>(`
            SELECT article_id AS articleId, prompt_id AS promptId
            FROM app.judgment
            WHERE model_id = ${getSqlLiteral(jobInfo.modelId)}
              AND use_title = ${getSqlLiteral(jobInfo.useTitle)}
              AND use_abstract = ${getSqlLiteral(jobInfo.useAbstract)}
              AND use_fulltext = ${getSqlLiteral(jobInfo.useFulltext)}
              AND use_fulltext_no_images = ${getSqlLiteral(jobInfo.useFulltextNoImages)}
              AND delete_generation = 0
              AND deleted_at IS NULL
              AND (${rows
                .map((row) => {
                  return `(article_id = ${getSqlLiteral(row.articleId)} AND prompt_id = ${getSqlLiteral(row.promptId)})`
                })
                .join(' OR ')})
          `)
        ).map((row) => {
          return getOrphanedJudgedQueuePairKey(row)
        }),
      )
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
    claimId: row.claimId,
    executionSnapshotHash: row.executionSnapshotHash,
    executionSnapshotId: row.executionSnapshotId,
    modelId: row.modelId,
    outboxSeq: Number(row.outboxSeq),
    projectId: row.projectId,
    promptId: row.promptId,
    queuePromptId: row.queuePromptId,
    quotes: parseJsonText(row.quotesJson),
    rawResponseJson: parseJsonText(row.rawResponseJson),
    requestAttemptsJson: row.requestAttemptsJson,
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
        ? {lastArticleId: row.cursorLastArticleId, lastDate: cursorLastDate, priorityBucket: 0}
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
      const recoveredLease = await acquireJudgmentJobLeaseWithCurrentServerId({currentLease}).catch(() => {
        return null
      })

      if (recoveredLease) {
        ownedJobLeases.set(jobId, recoveredLease)
        return recoveredLease
      }

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
  await waitForOwnedJobLeaseOperationsToDrain(jobId)

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
          claim_id AS claimId,
          execution_snapshot_id AS executionSnapshotId,
          execution_snapshot_hash AS executionSnapshotHash,
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
          request_attempts_json AS requestAttemptsJson,
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
          claim_id AS claimId,
          execution_snapshot_id AS executionSnapshotId,
          execution_snapshot_hash AS executionSnapshotHash,
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
          request_attempts_json AS requestAttemptsJson,
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
  const projectRefreshState = await getProjectRefreshVisibilityStateForJob(jobId)

  return (
    (await withOwnedJobDatabase(
      jobId,
      false,
      (database) => {
        const visibilityAckSeq = getStoredScanState(database, jobId).lastProjectRefreshAckSeq
        const projectDirtyToken = projectRefreshState?.dirtyToken ?? null

        if (visibilityAckSeq == null || maxRows <= 0) {
          return emptyRetentionPruneResult()
        }

        if (projectDirtyToken != null && visibilityAckSeq < projectDirtyToken) {
          return emptyRetentionPruneResult()
        }

        return database.transaction(() => {
          const eligibleRows = getVisibilityAckedOutboxRows(database, maxRows)

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
          `)
          const queuePromptResult = queuePromptDelete.run(...queuePromptIds) as {changes?: number}
          const outboxResult = outboxDelete.run(...outboxSeqs) as {changes?: number}

          return {
            outboxRowsDeleted: Number(outboxResult.changes ?? 0),
            queuePromptRowsDeleted: Number(queuePromptResult.changes ?? 0),
          }
        })()
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

  const currentResult = await pruneVisibilityAckedRetentionForJob({jobId: currentJobId, maxRows, serverJobId}).catch(
    (error: unknown) => {
      return error instanceof JudgmentJobLeaseError ? emptyRetentionPruneResult() : Promise.reject(error)
    },
  )
  const remainingRows = maxRows - currentResult.outboxRowsDeleted

  return remainingRows <= 0
    ? currentResult
    : addRetentionPruneResults(
        currentResult,
        await pruneVisibilityAckedRetentionForJobIds({jobIds: jobIds.slice(1), maxRows: remainingRows, serverJobId}),
      )
}

const emptyOrphanedJudgedQueueRepairCounts = (): OrphanedJudgedQueueRepairCounts => {
  return {deletedRows: 0, requeuedRows: 0}
}

const repairOrphanedJudgedQueueRowsForJob = async ({
  jobId,
  maxRows,
  serverJobId,
}: {
  jobId: string
  maxRows: number
  serverJobId?: string
}): Promise<OrphanedJudgedQueueRepairCounts> => {
  if (maxRows <= 0) {
    return emptyOrphanedJudgedQueueRepairCounts()
  }

  const repairBatch = await withOwnedJobDatabase(
    jobId,
    false,
    (database) => {
      const jobInfo = getOrphanedJudgedQueueRepairJobInfo(database, jobId)
      return jobInfo ? {jobInfo, rows: getOrphanedJudgedQueueRows(database, maxRows)} : null
    },
    serverJobId,
  )

  if (!repairBatch?.jobInfo || repairBatch.rows.length === 0) {
    return emptyOrphanedJudgedQueueRepairCounts()
  }

  const {jobInfo, rows} = repairBatch
  const [existingJudgmentPairs, existingArticleIds, existingPromptIds, existingProjectIds, existingModelIds] =
    await Promise.all([
      getExistingJudgmentPairsForOrphanedQueueRows({jobInfo, rows}),
      getExistingEntityIds(
        'app.article',
        rows.map((row) => {
          return row.articleId
        }),
      ),
      getExistingEntityIds(
        'app.prompt',
        rows.map((row) => {
          return row.promptId
        }),
      ),
      getExistingEntityIds('app.project', [jobInfo.projectId]),
      getExistingEntityIds('app.model', [jobInfo.modelId]),
    ])
  const canRepairJob = existingProjectIds.has(jobInfo.projectId) && existingModelIds.has(jobInfo.modelId)
  const repairPlan = rows.reduce(
    (state, row) => {
      const alreadyStored = existingJudgmentPairs.has(getOrphanedJudgedQueuePairKey(row))
      const canRequeue =
        !alreadyStored && canRepairJob && existingArticleIds.has(row.articleId) && existingPromptIds.has(row.promptId)

      return canRequeue
        ? {...state, requeueIds: [...state.requeueIds, row.queuePromptId]}
        : {...state, deleteIds: [...state.deleteIds, row.queuePromptId]}
    },
    {deleteIds: [] as string[], requeueIds: [] as string[]},
  )

  return (
    (await withOwnedJobDatabase(
      jobId,
      false,
      (database) => {
        return database.transaction(() => {
          const now = new Date().toISOString()
          const deletedRows =
            repairPlan.deleteIds.length === 0
              ? 0
              : Number(
                  (
                    database
                      .query(
                        `
                      DELETE FROM queue_prompt
                      WHERE id IN (${getSqlPlaceholders(repairPlan.deleteIds.length).join(', ')})
                        AND status = 'judged'
                        AND terminal_kind IS NULL
                        AND NOT EXISTS (
                          SELECT 1
                          FROM judgment_outbox jo
                          WHERE jo.queue_prompt_id = queue_prompt.id
                        )
                    `,
                      )
                      .run(...repairPlan.deleteIds) as {changes?: number}
                  ).changes ?? 0,
                )
          const requeuedRows =
            repairPlan.requeueIds.length === 0
              ? 0
              : Number(
                  (
                    database
                      .query(
                        `
                      UPDATE queue_prompt
                      SET status = 'ready',
                          terminal_kind = NULL,
                          skip_reason = NULL,
                          server_id = NULL,
                          claim_id = NULL,
                          execution_snapshot_id = NULL,
                          execution_snapshot_hash = NULL,
                          sent_at = NULL,
                          retry_after_at = NULL,
                          judged_at = NULL,
                          updated_at = ?
                      WHERE id IN (${getSqlPlaceholders(repairPlan.requeueIds.length).join(', ')})
                        AND status = 'judged'
                        AND terminal_kind IS NULL
                        AND NOT EXISTS (
                          SELECT 1
                          FROM judgment_outbox jo
                          WHERE jo.queue_prompt_id = queue_prompt.id
                        )
                    `,
                      )
                      .run(now, ...repairPlan.requeueIds) as {changes?: number}
                  ).changes ?? 0,
                )

          return {deletedRows, requeuedRows}
        })()
      },
      serverJobId,
    )) ?? emptyOrphanedJudgedQueueRepairCounts()
  )
}

const getReadyQueuePromptRows = (database: Database, limit: number): QueuePromptRow[] => {
  return database
    .query(
      `
        SELECT id, article_id AS articleId, prompt_id AS promptId
        FROM queue_prompt
        WHERE status = 'ready'
          AND (retry_after_at IS NULL OR retry_after_at <= ?)
        ORDER BY ready_insert_seq ASC, id ASC
        LIMIT ?
      `,
    )
    .all(new Date().toISOString(), limit) as QueuePromptRow[]
}

const markReadyQueuePromptClaimed = ({
  claim,
  database,
  row,
  serverJobId,
}: {
  claim: Omit<QueuePromptClaim, 'articleId' | 'jobId' | 'promptId' | 'recordId'>
  database: Database
  row: QueuePromptRow
  serverJobId: string
}) => {
  const now = new Date().toISOString()
  const result = database
    .query(
      `
        UPDATE queue_prompt
        SET status = 'claimed',
            sent_at = ?,
            updated_at = ?,
            server_id = ?,
            claim_id = ?,
            execution_snapshot_id = ?,
            execution_snapshot_hash = ?
        WHERE id = ?
          AND status = 'ready'
      `,
    )
    .run(now, now, serverJobId, claim.claimId, claim.executionSnapshotId, claim.executionSnapshotHash, row.id) as {
    changes?: number
  }

  return Number(result.changes ?? 0) === 1
}

const claimReadyQueuePromptRow = async ({
  jobId,
  row,
  serverJobId,
}: {
  jobId: string
  row: QueuePromptRow
  serverJobId: string
}): Promise<QueuePromptClaim[]> => {
  const claimId = randomUUID()
  const snapshot = await createJudgmentExecutionSnapshotForClaim({
    articleId: row.articleId,
    claimId,
    claimedBy: serverJobId,
    jobId,
    promptId: row.promptId,
    queueRecordId: row.id,
  })
  const claim = {claimId, ...snapshot}
  await ensureOwnedJobLease(jobId, serverJobId)
  const database = getOpenDatabase(jobId, false)
  const claimed = database ? markReadyQueuePromptClaimed({claim, database, row, serverJobId}) : false

  return claimed ? [{articleId: row.articleId, jobId, promptId: row.promptId, recordId: row.id, ...claim}] : []
}

const claimReadyQueuePromptRows = async ({
  jobId,
  rows,
  serverJobId,
}: {
  jobId: string
  rows: QueuePromptRow[]
  serverJobId: string
}): Promise<QueuePromptClaim[]> => {
  return rows.reduce<Promise<QueuePromptClaim[]>>(async (claimedPromise, row) => {
    const claimed = await claimedPromise
    const nextClaim = await claimReadyQueuePromptRow({jobId, row, serverJobId})

    return [...claimed, ...nextClaim]
  }, Promise.resolve([]))
}

const getPromptClaimIdentityFromDatabase = (
  database: Database,
  jobId: string,
  queueRecordId: string,
): PromptClaimIdentity | null => {
  const row = database
    .query(
      `
        SELECT
          qp.article_id AS articleId,
          qp.prompt_id AS promptId,
          qp.claim_id AS claimId,
          qp.execution_snapshot_id AS executionSnapshotId,
          qp.execution_snapshot_hash AS executionSnapshotHash
        FROM queue_prompt qp
        WHERE qp.id = ?
          AND qp.job_id = ?
        LIMIT 1
      `,
    )
    .get(queueRecordId, jobId) as PromptClaimIdentityRow | null
  const jobInfo = getOrphanedJudgedQueueRepairJobInfo(database, jobId)

  return row?.claimId && row.executionSnapshotId && row.executionSnapshotHash && jobInfo
    ? {
        articleId: row.articleId,
        claimId: row.claimId,
        executionSnapshotHash: row.executionSnapshotHash,
        executionSnapshotId: row.executionSnapshotId,
        jobId,
        modelId: jobInfo.modelId,
        projectId: jobInfo.projectId,
        promptId: row.promptId,
        queueRecordId,
        useAbstract: jobInfo.useAbstract,
        useFulltext: jobInfo.useFulltext,
        useFulltextNoImages: jobInfo.useFulltextNoImages,
        useTitle: jobInfo.useTitle,
      }
    : null
}

const getPromptClaimIdentityMismatch = (expected: PromptClaimIdentity, actual: PromptClaimIdentity | null) => {
  if (!actual) {
    return 'missing claimed prompt identity'
  }

  const mismatchedKey = (
    [
      'articleId',
      'claimId',
      'executionSnapshotHash',
      'executionSnapshotId',
      'jobId',
      'modelId',
      'projectId',
      'promptId',
      'queueRecordId',
      'useAbstract',
      'useFulltext',
      'useFulltextNoImages',
      'useTitle',
    ] as const
  ).find((key) => {
    return actual[key] !== expected[key]
  })

  return mismatchedKey ? `snapshot claim identity mismatch for ${mismatchedKey}` : null
}

const assertPromptClaimIdentityFromDatabase = (
  database: Database,
  expected: PromptClaimIdentity,
): PromptClaimIdentity => {
  const actual = getPromptClaimIdentityFromDatabase(database, expected.jobId, expected.queueRecordId)
  const mismatch = getPromptClaimIdentityMismatch(expected, actual)

  if (mismatch) {
    throw new JudgmentPromptClaimIdentityError(mismatch)
  }

  return actual as PromptClaimIdentity
}

const getPromptClaimIdentityFromOutboxInsert = (
  jobId: string,
  input: QueuePromptOutboxInsert,
): PromptClaimIdentity | null => {
  return input.claimId && input.executionSnapshotId && input.executionSnapshotHash && input.projectId
    ? {
        articleId: input.articleId,
        claimId: input.claimId,
        executionSnapshotHash: input.executionSnapshotHash,
        executionSnapshotId: input.executionSnapshotId,
        jobId,
        modelId: input.modelId,
        projectId: input.projectId,
        promptId: input.promptId,
        queueRecordId: input.queuePromptId,
        useAbstract: input.useAbstract,
        useFulltext: input.useFulltext,
        useFulltextNoImages: input.useFulltextNoImages,
        useTitle: input.useTitle,
      }
    : null
}

const recordPromptCompletionAckFromDatabase = (database: Database, jobId: string, ack: PromptCompletionAck): void => {
  const now = new Date().toISOString()

  database
    .query(
      `
        INSERT INTO completion_ack (
          claim_id,
          job_id,
          queue_prompt_id,
          status,
          token_use_id,
          request_attempts_json,
          completed_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET
          token_use_id = COALESCE(completion_ack.token_use_id, EXCLUDED.token_use_id),
          request_attempts_json = COALESCE(completion_ack.request_attempts_json, EXCLUDED.request_attempts_json),
          updated_at = EXCLUDED.updated_at
      `,
    )
    .run(
      ack.claimId,
      jobId,
      ack.queuePromptId,
      ack.status,
      ack.tokenUseId ?? null,
      ack.requestAttemptsJson ?? null,
      now,
      now,
    )
}

const getPromptCompletionAckFromDatabase = (
  database: Database,
  jobId: string,
  claimId: string,
): PromptCompletionAckRow | null => {
  return database
    .query(
      `
        SELECT
          claim_id AS claimId,
          queue_prompt_id AS queuePromptId,
          status,
          token_use_id AS tokenUseId,
          request_attempts_json AS requestAttemptsJson,
          completed_at AS completedAt
        FROM completion_ack
        WHERE job_id = ?
          AND claim_id = ?
        LIMIT 1
      `,
    )
    .get(jobId, claimId) as PromptCompletionAckRow | null
}

const getQueuePromptManifestRow = (
  database: Database,
  owner: QueuePromptManifestOwner,
): RequestAttemptManifestRow | null => {
  return database
    .query(
      `
        SELECT
          request_attempt_manifest_json AS requestAttemptManifestJson,
          request_attempt_manifest_version AS requestAttemptManifestVersion,
          request_attempt_manifest_repair_json AS requestAttemptManifestRepairJson
        FROM queue_prompt
        WHERE id = ?
          AND job_id = ?
        LIMIT 1
      `,
    )
    .get(owner.queueRecordId, owner.jobId) as RequestAttemptManifestRow | null
}

const updateQueuePromptManifestRow = ({
  database,
  expectedVersion,
  json,
  owner,
}: {
  database: Database
  expectedVersion: number
  json: string
  owner: QueuePromptManifestOwner
}): boolean => {
  const result = database
    .query(
      `
        UPDATE queue_prompt
        SET request_attempt_manifest_json = ?,
            request_attempt_manifest_version = request_attempt_manifest_version + 1,
            updated_at = ?
        WHERE id = ?
          AND job_id = ?
          AND request_attempt_manifest_version = ?
      `,
    )
    .run(json, new Date().toISOString(), owner.queueRecordId, owner.jobId, expectedVersion) as {changes?: number}

  return Number(result.changes ?? 0) === 1
}

const appendQueuePromptManifestRepairMarker = ({
  database,
  owner,
  reason,
  requestAttemptIds,
}: {
  database: Database
  owner: QueuePromptManifestOwner
  reason: string
  requestAttemptIds: string[]
}): void => {
  const row = getQueuePromptManifestRow(database, owner)

  if (!row) {
    return
  }

  const markerJson = appendRequestAttemptManifestRepairMarker({
    currentJson: row.requestAttemptManifestRepairJson,
    marker: createRequestAttemptManifestRepairMarker({owner, reason, requestAttemptIds}),
  })

  database
    .query(
      `
        UPDATE queue_prompt
        SET request_attempt_manifest_repair_json = ?,
            updated_at = ?
        WHERE id = ?
          AND job_id = ?
      `,
    )
    .run(markerJson, new Date().toISOString(), owner.queueRecordId, owner.jobId)
}

const mutateQueuePromptManifestFromDatabase = ({
  attemptIndex = 1,
  database,
  mutation,
  owner,
}: {
  attemptIndex?: number
  database: Database
  mutation: JudgmentRequestAttemptManifestMutation
  owner: QueuePromptManifestOwner
}): void => {
  const row = getQueuePromptManifestRow(database, owner)

  if (!row) {
    return
  }

  const currentEntries = parseRequestAttempts(row.requestAttemptManifestJson)
  const nextEntries = mutateRequestAttemptManifestEntries({currentEntries, mutation})

  if (!requestAttemptManifestChanged(currentEntries, nextEntries)) {
    return
  }

  const updated = updateQueuePromptManifestRow({
    database,
    expectedVersion: Number(row.requestAttemptManifestVersion ?? 0),
    json: stringifyManifestEntries(nextEntries),
    owner,
  })

  if (updated) {
    return
  }

  const requestAttemptIds = getRequestAttemptManifestMutationIds(mutation)

  if (shouldExhaustRequestAttemptManifestCas(attemptIndex)) {
    appendQueuePromptManifestRepairMarker({database, owner, reason: 'cas_exhausted', requestAttemptIds})
    throw new JudgmentRequestAttemptManifestCasExhaustedError({
      ownerId: getRequestAttemptManifestOwnerId(owner),
      ownerKind: owner.kind,
      requestAttemptIds,
    })
  }

  return mutateQueuePromptManifestFromDatabase({attemptIndex: attemptIndex + 1, database, mutation, owner})
}

const compactQueuePromptManifestCloseoutFromDatabase = ({
  database,
  jobId,
  queueRecordId,
  requestAttemptsJson,
}: {
  database: Database
  jobId: string
  queueRecordId: string
  requestAttemptsJson?: string | null
}): void => {
  const entries = parseRequestAttempts(requestAttemptsJson)

  if (entries.length === 0) {
    return
  }

  mutateQueuePromptManifestFromDatabase({
    database,
    mutation: {
      compactRequestAttemptIds: entries.map((entry) => {
        return entry.requestAttemptId
      }),
      mergeEntries: entries,
    },
    owner: {jobId, kind: 'queue_prompt', queueRecordId},
  })
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
          ready_insert_seq,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?)
      `)
        const now = new Date().toISOString()
        const selectMaxReadyInsertSeq = database.query(`
          SELECT COALESCE(MAX(ready_insert_seq), 0) AS maxReadyInsertSeq
          FROM queue_prompt
        `)

        return database.transaction((entries: QueuePromptInsert[]) => {
          const maxReadyInsertSeq = Number(
            (selectMaxReadyInsertSeq.get() as {maxReadyInsertSeq: number | null} | null)?.maxReadyInsertSeq ?? 0,
          )

          return entries.reduce(
            (state, entry) => {
              if (state.count >= normalizedMaxInserted) {
                return state
              }

              const result = insert.run(
                randomUUID(),
                jobId,
                entry.articleId,
                entry.promptId,
                serverJobId,
                state.nextReadyInsertSeq,
                now,
                now,
              ) as {changes?: number}

              return {
                count: state.count + (result.changes === 1 ? 1 : 0),
                nextReadyInsertSeq: state.nextReadyInsertSeq + 1,
              }
            },
            {count: 0, nextReadyInsertSeq: maxReadyInsertSeq + 1},
          ).count
        })(promptEntries)
      },
      serverJobId,
    )

    return insertedCount ?? 0
  },
  claimReadyPrompts: async (jobId: string, serverJobId: string, limit: number): Promise<QueuePromptClaim[]> => {
    startOwnedJobLeaseOperation(jobId)

    try {
      await ensureOwnedJobLease(jobId, serverJobId)
      const database = getOpenDatabase(jobId, false)

      if (!database) {
        return []
      }

      return await claimReadyQueuePromptRows({jobId, rows: getReadyQueuePromptRows(database, limit), serverJobId})
    } finally {
      finishOwnedJobLeaseOperation(jobId)
    }
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
              cursor_priority_bucket = 0,
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
        const dispatchCounts = getDispatchCounts(database)
        return dispatchCounts.claimed + dispatchCounts.running
      }) ?? 0
    )
  },
  getClaimedCount: async (jobId: string): Promise<number> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        return getDispatchCounts(database).claimed
      }) ?? 0
    )
  },
  getRunningCount: async (jobId: string): Promise<number> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        return getDispatchCounts(database).running
      }) ?? 0
    )
  },
  getDispatchCounts: async (jobId: string): Promise<PromptDispatchCounts> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        return getDispatchCounts(database)
      }) ?? {claimed: 0, running: 0}
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
  repairOrphanedJudgedQueueRows: async ({
    jobId,
    maxRows,
    serverJobId,
  }: {
    jobId: string
    maxRows: number
    serverJobId?: string
  }): Promise<OrphanedJudgedQueueRepairCounts> => {
    const normalizedMaxRows = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0
    return repairOrphanedJudgedQueueRowsForJob({jobId, maxRows: normalizedMaxRows, serverJobId})
  },
  getHealthSnapshot: async (jobId: string): Promise<JudgmentJobSqliteHealthSnapshot> => {
    const sqlitePath = getJudgmentJobSqlitePath(jobId)
    const walPath = `${sqlitePath}-wal`
    const projectRefreshState = await getProjectRefreshVisibilityStateForJob(jobId).catch(() => {
      return null
    })
    const liveSnapshot = withJobDatabase(jobId, false, (database) => {
      return getHealthSnapshotFromDatabase(database, jobId, projectRefreshState)
    })

    if (!liveSnapshot) {
      return getEmptyHealthSnapshot()
    }

    const health = {...liveSnapshot, sqliteFileBytes: getSqliteFileByteSize(jobId), walBytes: getFileByteSize(walPath)}

    await publishHealthProjection({health, jobId})

    return health
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
  filterOutLocallyJudgedPrompts: async (
    jobId: string,
    entries: Array<{articleId: string; promptId: string}>,
  ): Promise<Array<{articleId: string; promptId: string}>> => {
    return entries.length === 0
      ? []
      : (withJobDatabase(jobId, false, (database) => {
          const locallyJudgedPairs = database
            .query(
              `
                  WITH pairs(article_id, prompt_id) AS (
                    VALUES ${entries
                      .map(() => {
                        return '(?, ?)'
                      })
                      .join(', ')}
                  )
                  SELECT qp.article_id AS articleId, qp.prompt_id AS promptId
                  FROM queue_prompt qp
                  INNER JOIN pairs p ON p.article_id = qp.article_id AND p.prompt_id = qp.prompt_id
                  WHERE qp.status = 'judged'
                `,
            )
            .all(
              ...entries.flatMap((entry) => {
                return [entry.articleId, entry.promptId]
              }),
            ) as Array<{articleId: string; promptId: string}>
          const locallyJudgedSet = new Set(
            locallyJudgedPairs.map((entry) => {
              return `${entry.articleId}:${entry.promptId}`
            }),
          )

          return entries.filter((entry) => {
            return !locallyJudgedSet.has(`${entry.articleId}:${entry.promptId}`)
          })
        }) ?? [])
  },
  filterOutExistingQueuedPrompts: async (
    jobId: string,
    entries: Array<{articleId: string; promptId: string}>,
  ): Promise<Array<{articleId: string; promptId: string}>> => {
    return entries.length === 0
      ? []
      : (withJobDatabase(jobId, false, (database) => {
          const existingQueuedPairs = database
            .query(
              `
                  WITH pairs(article_id, prompt_id) AS (
                    VALUES ${entries
                      .map(() => {
                        return '(?, ?)'
                      })
                      .join(', ')}
                  )
                  SELECT qp.article_id AS articleId, qp.prompt_id AS promptId
                  FROM queue_prompt qp
                  INNER JOIN pairs p ON p.article_id = qp.article_id AND p.prompt_id = qp.prompt_id
                `,
            )
            .all(
              ...entries.flatMap((entry) => {
                return [entry.articleId, entry.promptId]
              }),
            ) as Array<{articleId: string; promptId: string}>
          const existingQueuedSet = new Set(
            existingQueuedPairs.map((entry) => {
              return `${entry.articleId}:${entry.promptId}`
            }),
          )

          return entries.filter((entry) => {
            return !existingQueuedSet.has(`${entry.articleId}:${entry.promptId}`)
          })
        }) ?? [])
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
  getPromptClaimIdentity: async (jobId: string, queueRecordId: string): Promise<PromptClaimIdentity | null> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        return getPromptClaimIdentityFromDatabase(database, jobId, queueRecordId)
      }) ?? null
    )
  },
  getPromptCompletionAck: async (jobId: string, claimId: string): Promise<PromptCompletionAckRow | null> => {
    return (
      withJobDatabase(jobId, false, (database) => {
        return getPromptCompletionAckFromDatabase(database, jobId, claimId)
      }) ?? null
    )
  },
  mutateRequestAttemptManifest: async (
    owner: QueuePromptManifestOwner,
    mutation: JudgmentRequestAttemptManifestMutation,
  ): Promise<void> => {
    await withOwnedJobDatabase(owner.jobId, false, (database) => {
      return mutateQueuePromptManifestFromDatabase({database, mutation, owner})
    })
  },
  assertPromptClaimIdentity: async (identity: PromptClaimIdentity): Promise<PromptClaimIdentity> => {
    return (
      (await withOwnedJobDatabase(identity.jobId, false, (database) => {
        return assertPromptClaimIdentityFromDatabase(database, identity)
      })) ?? Promise.reject(new JudgmentPromptClaimIdentityError('missing SQLite job database'))
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
            cursor_priority_bucket,
            scan_epoch,
            exhausted_at,
            last_project_refresh_ack_token,
            wrap_visibility_ack_token,
            updated_at
          ) VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, ?)
        `,
          )
          .run(
            jobId,
            jobInfo.cursor?.lastDate.toISOString() ?? null,
            jobInfo.cursor?.lastArticleId ?? null,
            jobInfo.cursor?.priorityBucket ?? 0,
            createdAt,
          )
      })()
    })
  },
  listJobIds: () => {
    return getJudgmentJobSqliteJobIds()
  },
  hasOwnedLease: (jobId: string) => {
    return ownedJobLeases.has(jobId)
  },
  getJudgmentJobLeaseMetadata: async (jobId: string) => {
    return getJudgmentJobLeaseMetadataForJob(jobId)
  },
  recoverJudgmentJobLeasesOnStartup: async ({jobIds}: {jobIds?: string[]} = {}) => {
    return recoverStartupJudgmentJobLeases({jobIds})
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
  publishHealthProjections: async (jobIds?: string[]) => {
    const candidateJobIds = jobIds ?? getExistingOutboxJobIds()
    const snapshots = await Promise.all(
      candidateJobIds.map(async (jobId) => {
        return getJudgmentJobSqliteService().getHealthSnapshot(jobId)
      }),
    )

    return snapshots.length
  },
  completeOutboxClaim: async ({claimId, jobId}: {claimId: string; jobId: string}) => {
    const completedCount =
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

    await getJudgmentJobSqliteService().getHealthSnapshot(jobId)

    return completedCount
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
        }).catch((error: unknown) => {
          return error instanceof JudgmentJobLeaseError ? 0 : Promise.reject(error)
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
  markPromptAsJudged: async (jobId: string, recordId: string, completionAck?: PromptCompletionAck) => {
    await withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      database.transaction(() => {
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

        if (completionAck) {
          recordPromptCompletionAckFromDatabase(database, jobId, completionAck)
        }
      })()
    })
    await withOwnedJobDatabase(jobId, false, (database) => {
      return completionAck
        ? compactQueuePromptManifestCloseoutFromDatabase({
            database,
            jobId,
            queueRecordId: completionAck.queuePromptId,
            requestAttemptsJson: completionAck.requestAttemptsJson,
          })
        : undefined
    })
  },
  markPromptAsRunning: async (jobId: string, recordId: string) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      database
        .query(
          `
        UPDATE queue_prompt
        SET status = 'running',
            sent_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status IN ('claimed', 'sent')
      `,
        )
        .run(now, now, recordId)
    })
  },
  markPromptAsRetry: async (
    jobId: string,
    recordId: string,
    retryAfterMs: number | null = null,
    completionAck?: PromptCompletionAck,
  ) => {
    await withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      const retryAfterAt = retryAfterMs && retryAfterMs > 0 ? new Date(Date.now() + retryAfterMs).toISOString() : null

      database.transaction(() => {
        const nextReadyInsertSeq = Number(
          (
            database
              .query(
                `
                SELECT COALESCE(MAX(ready_insert_seq), 0) + 1 AS nextReadyInsertSeq
                FROM queue_prompt
              `,
              )
              .get() as {nextReadyInsertSeq: number | null} | null
          )?.nextReadyInsertSeq ?? 1,
        )

        database
          .query(
            `
          UPDATE queue_prompt
          SET status = 'ready',
              sent_at = NULL,
              retry_after_at = ?,
              updated_at = ?,
              claim_id = NULL,
              execution_snapshot_id = NULL,
              execution_snapshot_hash = NULL,
              ready_insert_seq = ?
          WHERE id = ?
        `,
          )
          .run(retryAfterAt, now, nextReadyInsertSeq, recordId)

        if (completionAck) {
          recordPromptCompletionAckFromDatabase(database, jobId, completionAck)
        }
      })()
    })
    await withOwnedJobDatabase(jobId, false, (database) => {
      return completionAck
        ? compactQueuePromptManifestCloseoutFromDatabase({
            database,
            jobId,
            queueRecordId: completionAck.queuePromptId,
            requestAttemptsJson: completionAck.requestAttemptsJson,
          })
        : undefined
    })
  },
  consumePromptExtraRetry: async ({
    errorCode,
    jobId,
    maxExtraRetries,
    recordId,
  }: {
    errorCode: string
    jobId: string
    maxExtraRetries: number
    recordId: string
  }): Promise<boolean> => {
    return (
      (await withOwnedJobDatabase(jobId, false, (database) => {
        const now = new Date().toISOString()
        const result = database
          .query(
            `
              UPDATE queue_prompt
              SET extra_retry_count = extra_retry_count + 1,
                  last_recoverable_error_code = ?,
                  updated_at = ?
              WHERE id = ?
                AND extra_retry_count < ?
            `,
          )
          .run(errorCode, now, recordId, maxExtraRetries) as {changes?: number}

        return Number(result.changes ?? 0) === 1
      })) ?? false
    )
  },
  markPromptAsRecoverable: async (jobId: string, recordId: string) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      database
        .query(
          `
        UPDATE queue_prompt
        SET status = 'ready',
            sent_at = NULL,
            retry_after_at = NULL,
            updated_at = ?,
            claim_id = NULL,
            execution_snapshot_id = NULL,
            execution_snapshot_hash = NULL
        WHERE id = ?
          AND status IN ('claimed', 'running', 'sent')
      `,
        )
        .run(now, recordId)
    })
  },
  markPromptAsSkipped: async (
    jobId: string,
    recordId: string,
    skipReason: 'conversion_failed' | 'fulltext_too_large' | 'no_fulltext',
    completionAck?: PromptCompletionAck,
  ) => {
    await withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      database.transaction(() => {
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

        if (completionAck) {
          recordPromptCompletionAckFromDatabase(database, jobId, completionAck)
        }
      })()
    })
    await withOwnedJobDatabase(jobId, false, (database) => {
      return completionAck
        ? compactQueuePromptManifestCloseoutFromDatabase({
            database,
            jobId,
            queueRecordId: completionAck.queuePromptId,
            requestAttemptsJson: completionAck.requestAttemptsJson,
          })
        : undefined
    })
  },
  recordJudgmentSuccess: async (jobId: string, outboxInsert: QueuePromptOutboxInsert) => {
    return withOwnedJobDatabase(jobId, false, (database) => {
      const insertedRows = database.transaction((input: QueuePromptOutboxInsert) => {
        const expectedIdentity = getPromptClaimIdentityFromOutboxInsert(jobId, input)

        if (expectedIdentity) {
          assertPromptClaimIdentityFromDatabase(database, expectedIdentity)
        }

        const insertResult = database
          .query(
            `
          INSERT OR IGNORE INTO judgment_outbox (
            job_id,
            queue_prompt_id,
            judgment_id,
            claim_id,
            execution_snapshot_id,
            execution_snapshot_hash,
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
            request_attempts_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            jobId,
            input.queuePromptId,
            input.judgmentId,
            input.claimId ?? null,
            input.executionSnapshotId ?? null,
            input.executionSnapshotHash ?? null,
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
            input.requestAttemptsJson ?? null,
            input.createdAt.toISOString(),
            input.updatedAt.toISOString(),
          ) as {changes?: number}
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

        if (input.claimId) {
          recordPromptCompletionAckFromDatabase(database, jobId, {
            claimId: input.claimId,
            queuePromptId: input.queuePromptId,
            status: 'judged',
            requestAttemptsJson: input.requestAttemptsJson ?? null,
            tokenUseId: input.completionTokenUseId ?? null,
          })
        }

        return Number(insertResult.changes ?? 0)
      })(outboxInsert)

      compactQueuePromptManifestCloseoutFromDatabase({
        database,
        jobId,
        queueRecordId: outboxInsert.queuePromptId,
        requestAttemptsJson: outboxInsert.requestAttemptsJson,
      })
      recordJudgmentJobStorageTransfer({addedRows: insertedRows, jobId})
    })
  },
  requeueAbandonedSentPrompts: async ({
    jobId,
    protectedRecordIds,
    serverJobId,
    staleBefore,
  }: {
    jobId: string
    protectedRecordIds?: string[]
    serverJobId: string
    staleBefore: Date
  }): Promise<number> => {
    return (
      (await withOwnedJobDatabase(
        jobId,
        false,
        (database) => {
          const shouldRecoverCurrentServer = protectedRecordIds !== undefined
          const protectedIds = Array.from(new Set(protectedRecordIds ?? []))
          const currentServerRecoveryPredicate =
            shouldRecoverCurrentServer && protectedIds.length > 0
              ? `id NOT IN (${getSqlPlaceholders(protectedIds.length).join(', ')})`
              : shouldRecoverCurrentServer
                ? '1 = 1'
                : '0 = 1'
          const result = database
            .query(
              `
          UPDATE queue_prompt
          SET status = 'ready',
              sent_at = NULL,
              retry_after_at = NULL,
              updated_at = ?,
              server_id = ?,
              claim_id = NULL,
              execution_snapshot_id = NULL,
              execution_snapshot_hash = NULL
          WHERE status IN ('claimed', 'running', 'sent')
            AND sent_at <= ?
            AND (COALESCE(server_id, '') <> ? OR ${currentServerRecoveryPredicate})
        `,
            )
            .run(new Date().toISOString(), serverJobId, staleBefore.toISOString(), serverJobId, ...protectedIds) as {
            changes?: number
          }

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
    const result = await withOwnedJobDatabase(jobId, false, (database) => {
      const now = new Date().toISOString()
      const nextAckSeq = getForwardOnlyAckSeq(
        getStoredScanState(database, jobId).lastProjectRefreshAckSeq,
        lastProjectRefreshAckSeq,
      )

      database
        .query(
          `
        UPDATE job_scan_state
        SET last_project_refresh_ack_token = ?,
            updated_at = ?
        WHERE job_id = ?
      `,
        )
        .run(nextAckSeq, now, jobId)
    })

    await getJudgmentJobSqliteService().getHealthSnapshot(jobId)

    return result
  },
  publishProjectRefreshAck: async ({ackToken, projectId}: {ackToken: number | null; projectId: string}) => {
    return publishProjectRefreshAckForProject({ackToken, projectId})
  },
  reconcileProjectRefreshAcks: async ({projectId}: {projectId?: string} = {}) => {
    return reconcileProjectRefreshAcks({projectId})
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
            cursor_priority_bucket = ?,
            scan_epoch = ?,
            exhausted_at = ?,
            last_project_refresh_ack_token = ?,
            wrap_visibility_ack_token = ?,
            updated_at = ?
        WHERE job_id = ?
      `,
        )
        .run(
          nextState.cursor?.lastDate.toISOString() ?? null,
          nextState.cursor?.lastArticleId ?? null,
          nextState.cursor?.priorityBucket ?? 0,
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

registerDuckdbOwnerDemotionHandler(async () => {
  await sqliteService.closeAll()
})

export const getJudgmentJobSqliteService = () => {
  return sqliteService
}

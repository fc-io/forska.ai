import {existsSync, mkdirSync} from 'node:fs'
import {dirname} from 'node:path'

import {Database} from 'bun:sqlite'

import {duckdbOwnerPrivateApiPrefix} from '../../routes/apiRouteClassification.ts'
import type {JudgmentExecutionSnapshotRecord} from '../../services/judgmentExecutionSnapshotService.ts'
import {getEnv} from '../../utils/env.ts'
import {getCurrentJudgeWorkerJournalIdentity} from '../../utils/judgeWorkerJournalIdentity.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {
  getLegacyRequestAttempts,
  getLegacyRequestAttemptsJson,
  getRequestAttemptRepairState,
  legacyCompletionEvidencePendingRepairReason,
} from './judgmentLegacyEvidenceRepair.ts'
import {getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import {
  appendRequestAttemptManifestRepairMarker,
  createRequestAttemptManifestRepairMarker,
  getRequestAttemptManifestMutationIds,
  getRequestAttemptManifestOwnerId,
  type JudgmentRequestAttemptJsonEntry,
  JudgmentRequestAttemptManifestCasExhaustedError,
  type JudgmentRequestAttemptManifestMutation,
  type JudgmentRequestAttemptManifestOwner,
  mutateRequestAttemptManifestEntries,
  parseRequestAttempts,
  requestAttemptManifestChanged,
  requestAttemptManifestVersion,
  shouldExhaustRequestAttemptManifestCas,
  stringifyManifestEntries,
  stringifyRequestAttempts,
  withDurableCloseoutRef,
} from './judgmentRequestAttemptManifest.ts'
import type {RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'
import type {PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'
import type {ProviderBucketSnapshot} from './providerAdmissionLease.ts'

export type JudgeWorkerTokenUseSummary = {
  failedRequests: number
  failedRequestsDetails: unknown[]
  gpuGpusPerNode?: number | null
  gpuNnodes?: number | null
  gpuShape?: string | null
  gpuTotalGpus?: number | null
  hasFailedRequests: boolean
  modelName: string | null
  sglangMaxRunningRequests?: number | null
  duration?: number | null
  finishedAt?: string | null
  successfulRequests: number
  startedAt?: string | null
  dpSize?: number | null
  tpSize?: number | null
  totalCompletionTokens: number
  totalFailedCompletionTokens: number
  totalFailedPromptTokens: number
  totalFailedTokens: number
  totalPromptTokens: number
  totalRequests: number
  totalSuccessCompletionTokens: number
  totalSuccessPromptTokens: number
  totalSuccessTokens: number
  totalTokens: number
  requestAttempts?: JudgmentRequestAttemptJsonEntry[] | null
}

export type JudgeWorkerAcceptedClaimLifecycleRow = {
  acceptedAt: string
  jobId: string
  payloadJson: string
  queueRecordId: string
  requestAttemptManifestJson: string | null
  updatedAt: string
}

export type JudgeWorkerCompletionPayload = {
  answeredOriginal?: unknown
  answeredOriginalAsArray?: unknown
  articleId: string
  chunkingStrategy?: string | null
  claimId: string
  confidenceOriginal?: number
  executionSnapshotHash: string
  executionSnapshotId: string
  explanation?: string | null
  isAnswered?: boolean
  jobId: string
  judgment?: unknown
  judgmentId?: string
  modelId: string
  projectId: string
  promptId: string
  queueRecordId: string
  quotes?: unknown
  rawResponseJson?: unknown
  requestAttempts?: JudgmentRequestAttemptJsonEntry[] | null
  retryAfterMs?: number | null
  skipReason?: 'conversion_failed' | 'fulltext_too_large' | 'no_fulltext'
  status?: 'completed' | 'failed' | 'judged' | 'retry' | 'skipped' | 'succeeded'
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type OwnerBackedJudgmentJobInfo = ProviderBucketSnapshot & {
  modelBaseUrl: string | null
  modelId: string
  modelMetadataJson: unknown
  modelName: string
  modelProvider: string
  modelSecretRef: string | null
  modelVersion: string | null
  projectId: string
  providerConfigJson: unknown
  resolvedRuntime: {modelBaseUrl: string; modelProvider: string; modelWorkerUrls: string[]} | null
  runtimeMatchReason: string
  runtimeMatchStatus: 'ambiguous' | 'manual-only' | 'matched' | 'unreachable'
  runtimeResolutionMode: 'auto-detect' | 'manual'
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type CompletionOutboxRow = {
  ackedAt: string | null
  articleId: string | null
  claimId: string
  jobId: string
  localAppliedAt: string | null
  payloadJson: string
  promptId: string | null
  queueRecordId: string
  status: string
  requestAttemptsJson: string | null
  tokenUseJson: string | null
  updatedAt: string
}

type CompletionReplayResult = {ackedCount: number; discardedCount: number; failedCount: number}
type CompletionReplayOptions = {limit?: number}
type JudgeWorkerRolloutCleanupOptions = CompletionReplayOptions
type CompletionSendResult = {claimId: string; queueRecordId: string; status: string}
type PendingTokenUseJsonRow = {requestAttemptsJson: string | null; tokenUseJson: string}
type AcceptedClaimManifestOwner = Extract<JudgmentRequestAttemptManifestOwner, {kind: 'accepted_claim'}>
type AcceptedClaimManifestRow = {
  requestAttemptManifestJson: string | null
  requestAttemptManifestRepairJson: string | null
  requestAttemptManifestVersion: number
}
type PendingTokenUseRow = {
  articleId: string
  claimId: string
  createdAt: string
  jobId: string
  promptId: string
  queueRecordId: string
  requestAttemptId: string
  requestAttemptsJson: string | null
  tokenUseJson: string
  updatedAt: string
}
type TokenUseCompletionLookupInput = {
  articleId: string
  jobId: string
  promptIds: string[]
  queueRecordIds?: string[]
  requestAttempts?: JudgmentRequestAttemptJsonEntry[]
}
type AcceptedClaimRolloutRow = AcceptedClaimManifestRow & {
  claimId: string
  jobId: string
  payloadJson: string
  queueRecordId: string
}
type AcceptedClaimProtectedPrompt = {jobId: string; queueRecordId: string}
type CompletionClaimIdentityKey =
  | 'articleId'
  | 'claimId'
  | 'executionSnapshotHash'
  | 'executionSnapshotId'
  | 'jobId'
  | 'modelId'
  | 'projectId'
  | 'promptId'
  | 'queueRecordId'
  | 'useAbstract'
  | 'useFulltext'
  | 'useFulltextNoImages'
  | 'useTitle'
export type JudgeWorkerRolloutCleanupResult = {
  acceptedClaimsDeleted: number
  closeoutIntentsInserted: number
  replay: CompletionReplayResult
}

class OwnerBackedJudgmentRequestError extends Error {
  responseText: string
  status: number

  constructor({message, responseText, status}: {message: string; responseText: string; status: number}) {
    super(message)
    this.name = 'OwnerBackedJudgmentRequestError'
    this.responseText = responseText
    this.status = status
  }
}

const completionJournalLogger = createRateLimitedLogger({windowMs: 30_000})
const successCompletionTokenUseReplayGraceMs = 30_000
const completionReplayFailureBackoffMs = 60_000
const ownerBackedRequestTimeoutMs = 30_000
const ownerBackedClaimRequestTimeoutMs = 120_000
const ownerBackedCompletionRequestTimeoutMs = 120_000
const ownerBackedRequestRetryDelayMs = 100
const ownerBackedRequestMaxAttempts = 3
const ownerBackedCompletionReplayConcurrency = 8
const tokenUseCompletionLookupLimit = 128
const legacyRequestAttemptRepairCandidateSql = `
  request_attempts_json IS NULL
  OR TRIM(request_attempts_json) IN ('', '[]', 'null')
  OR TRIM(request_attempts_json) NOT LIKE '[%'
  OR request_attempts_json NOT LIKE '%"requestAttemptId"%'
`

let journalDatabase: Database | null = null
let ownerBackedCompletionReplayInFlight = 0
const ownerBackedCompletionReplayWaiters: Array<(release: () => void) => void> = []

export const shouldUseJudgeWorkerOwnerHandoff = (): boolean => {
  const configuredRole = String(process.env.SERVER_ROLE ?? '').trim()

  return configuredRole === 'judge-worker'
}

const parseJson = <T>(value: string): T => {
  return JSON.parse(value) as T
}

const robustSendRolloutDiscardedReason = 'robustSendRolloutDiscarded'

const getErrorMessageValue = (value: unknown): string => {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
}

const getOwnerResponseMessage = ({
  detail,
  method,
  path,
  status,
  type,
}: {
  detail: string
  method: 'GET' | 'POST'
  path: string
  status: number
  type: 'failed' | 'invalid JSON' | 'no data'
}) => {
  const context = `[${method} ${path}]`
  const messageDetail = detail.trim().length > 0 ? `${detail} ${context}` : context
  const messagePrefix = type === 'failed' ? 'failed' : `returned ${type}`

  return `owner-backed judgment request ${messagePrefix} (${status}): ${messageDetail}`
}

const tryParseOwnerResponse = <T>(text: string): {data?: T; error?: unknown} | null => {
  try {
    return text.length > 0 ? (JSON.parse(text) as {data?: T; error?: unknown}) : {}
  } catch {
    return null
  }
}

const getJournalPath = (): string => {
  return getCurrentJudgeWorkerJournalIdentity()?.journalPath ?? getEnv().JUDGE_WORKER_JOURNAL_PATH
}

const getOwnerUrl = (): string => {
  const configuredUrl = String(process.env.SERVER_DUCKDB_OWNER_URL ?? getEnv().SERVER_DUCKDB_OWNER_URL ?? '').trim()
  const fallbackUrl = `http://127.0.0.1:${getEnv().API_SERVER_PORT}`
  const ownerUrl = configuredUrl.length > 0 ? configuredUrl : shouldUseJudgeWorkerOwnerHandoff() ? '' : fallbackUrl

  if (ownerUrl.length === 0) {
    throw new Error('SERVER_DUCKDB_OWNER_URL is required for judge-worker owner-backed judgment handoff')
  }

  return ownerUrl.endsWith('/') ? ownerUrl.slice(0, -1) : ownerUrl
}

const openJournalDatabase = (): Database => {
  if (journalDatabase) {
    return journalDatabase
  }

  const journalPath = getJournalPath()
  mkdirSync(dirname(journalPath), {recursive: true})
  const database = new Database(journalPath, {create: true})

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS accepted_claim (
      claim_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      queue_record_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      request_attempt_manifest_json TEXT NOT NULL DEFAULT '[]',
      request_attempt_manifest_version INTEGER NOT NULL DEFAULT 0,
      request_attempt_manifest_repair_json TEXT,
      accepted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS completion_outbox (
      claim_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      queue_record_id TEXT NOT NULL,
      article_id TEXT,
      prompt_id TEXT,
      payload_json TEXT NOT NULL,
      token_use_json TEXT,
      request_attempts_json TEXT,
      status TEXT NOT NULL,
      acked_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_token_use (
      job_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      queue_record_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      request_attempt_id TEXT NOT NULL,
      token_use_json TEXT NOT NULL,
      request_attempts_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, queue_record_id, request_attempt_id)
    );

    CREATE INDEX IF NOT EXISTS idx_completion_outbox_unacked
      ON completion_outbox(acked_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_completion_outbox_unacked_created_claim
      ON completion_outbox(acked_at, created_at, claim_id);

    CREATE INDEX IF NOT EXISTS idx_completion_outbox_job_queue_acked_created
      ON completion_outbox(job_id, queue_record_id, acked_at, created_at, claim_id);

    CREATE INDEX IF NOT EXISTS idx_completion_outbox_legacy_repair
      ON completion_outbox(created_at, claim_id)
      WHERE ${legacyRequestAttemptRepairCandidateSql};

    CREATE INDEX IF NOT EXISTS idx_pending_token_use_created
      ON pending_token_use(created_at);

    CREATE INDEX IF NOT EXISTS idx_accepted_claim_accepted
      ON accepted_claim(accepted_at, claim_id);
    CREATE INDEX IF NOT EXISTS idx_accepted_claim_job_accepted
      ON accepted_claim(job_id, accepted_at, claim_id);
  `)

  ensureJournalSchema(database)
  ensureJournalIndexes(database)
  repairLegacyJournalEvidence(database)
  journalDatabase = database
  return database
}

type JournalColumnRow = {name: string}

const getJournalColumnNames = (database: Database, tableName: string): Set<string> => {
  return new Set(
    (database.query(`PRAGMA table_info('${tableName}')`).all() as JournalColumnRow[]).map((row) => {
      return row.name
    }),
  )
}

const addMissingJournalColumns = (
  database: Database,
  tableName: string,
  columns: ReadonlyArray<{name: string; sql: string}>,
): void => {
  const currentColumn = columns[0]

  if (!currentColumn) {
    return
  }

  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${currentColumn.name} ${currentColumn.sql}`)
  return addMissingJournalColumns(database, tableName, columns.slice(1))
}

const ensureAcceptedClaimSchema = (database: Database): void => {
  const existingColumns = getJournalColumnNames(database, 'accepted_claim')
  const missingColumns = [
    {name: 'request_attempt_manifest_json', sql: `TEXT NOT NULL DEFAULT '[]'`},
    {name: 'request_attempt_manifest_version', sql: `INTEGER NOT NULL DEFAULT 0`},
    {name: 'request_attempt_manifest_repair_json', sql: 'TEXT'},
  ].filter((column) => {
    return !existingColumns.has(column.name)
  })

  addMissingJournalColumns(database, 'accepted_claim', missingColumns)
}

const ensureCompletionOutboxSchema = (database: Database): void => {
  const existingColumns = getJournalColumnNames(database, 'completion_outbox')
  const missingColumns = [
    {name: 'article_id', sql: 'TEXT'},
    {name: 'prompt_id', sql: 'TEXT'},
    {name: 'request_attempts_json', sql: 'TEXT'},
    {name: 'local_applied_at', sql: 'TEXT'},
  ].filter((column) => {
    return !existingColumns.has(column.name)
  })

  addMissingJournalColumns(database, 'completion_outbox', missingColumns)
}

const ensurePendingTokenUseSchema = (database: Database): void => {
  const existingColumns = getJournalColumnNames(database, 'pending_token_use')
  const hasExactIdentity =
    existingColumns.has('claim_id')
    && existingColumns.has('queue_record_id')
    && existingColumns.has('request_attempt_id')
    && existingColumns.has('request_attempts_json')

  if (hasExactIdentity) {
    return
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS pending_token_use_next (
      job_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      queue_record_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      request_attempt_id TEXT NOT NULL,
      token_use_json TEXT NOT NULL,
      request_attempts_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, queue_record_id, request_attempt_id)
    );
    INSERT OR IGNORE INTO pending_token_use_next (
      job_id,
      claim_id,
      queue_record_id,
      article_id,
      prompt_id,
      request_attempt_id,
      token_use_json,
      request_attempts_json,
      created_at,
      updated_at
    )
    SELECT
      job_id,
      ${existingColumns.has('claim_id') ? "COALESCE(claim_id, '')" : "''"},
      ${existingColumns.has('queue_record_id') ? 'COALESCE(queue_record_id, prompt_id)' : 'prompt_id'},
      article_id,
      prompt_id,
      ${
        existingColumns.has('request_attempt_id')
          ? "COALESCE(request_attempt_id, 'legacy:' || job_id || ':' || article_id || ':' || prompt_id)"
          : "'legacy:' || job_id || ':' || article_id || ':' || prompt_id"
      },
      token_use_json,
      ${existingColumns.has('request_attempts_json') ? 'request_attempts_json' : 'NULL'},
      created_at,
      updated_at
    FROM pending_token_use;
    DROP TABLE pending_token_use;
    ALTER TABLE pending_token_use_next RENAME TO pending_token_use;
  `)
}

const ensureJournalSchema = (database: Database): void => {
  ensureAcceptedClaimSchema(database)
  ensureCompletionOutboxSchema(database)
  ensurePendingTokenUseSchema(database)
}

const ensureJournalIndexes = (database: Database): void => {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_completion_outbox_job_article_prompt_acked_created
      ON completion_outbox(job_id, article_id, prompt_id, acked_at, created_at, claim_id);
    CREATE INDEX IF NOT EXISTS idx_completion_outbox_local_retry
      ON completion_outbox(status, created_at, claim_id)
      WHERE acked_at IS NULL
        AND local_applied_at IS NULL
        AND status = 'retry';
  `)
}

const waitForOwnerBackedRetry = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ownerBackedRequestRetryDelayMs)
  })
}

const getOwnerBackedRequestTimeoutMs = (path: string): number => {
  return path.includes('/claims')
    ? ownerBackedClaimRequestTimeoutMs
    : path.includes('/completions')
      ? ownerBackedCompletionRequestTimeoutMs
      : ownerBackedRequestTimeoutMs
}

const drainOwnerBackedCompletionReplayWaiters = (): void => {
  const waiterIndex = ownerBackedCompletionReplayWaiters.findIndex(() => {
    return ownerBackedCompletionReplayInFlight < ownerBackedCompletionReplayConcurrency
  })
  const nextWaiter =
    waiterIndex >= 0 ? ownerBackedCompletionReplayWaiters.splice(waiterIndex, 1)[0] : null

  if (nextWaiter) {
    ownerBackedCompletionReplayInFlight += 1
    nextWaiter(() => {
      releaseOwnerBackedCompletionReplaySlot()
    })
    drainOwnerBackedCompletionReplayWaiters()
  }
}

const releaseOwnerBackedCompletionReplaySlot = (): void => {
  ownerBackedCompletionReplayInFlight = Math.max(0, ownerBackedCompletionReplayInFlight - 1)
  drainOwnerBackedCompletionReplayWaiters()
}

const acquireOwnerBackedCompletionReplaySlot = async (): Promise<() => void> => {
  if (ownerBackedCompletionReplayInFlight < ownerBackedCompletionReplayConcurrency) {
    ownerBackedCompletionReplayInFlight += 1
    return () => {
      releaseOwnerBackedCompletionReplaySlot()
    }
  }

  return new Promise((resolve) => {
    ownerBackedCompletionReplayWaiters.push(resolve)
  })
}

const withOwnerBackedCompletionReplaySlot = async <T>(work: () => Promise<T>): Promise<T> => {
  const release = await acquireOwnerBackedCompletionReplaySlot()

  try {
    return await work()
  } finally {
    release()
  }
}

const requestOwnerJsonOnce = async <T>({
  body,
  method,
  path,
}: {
  body?: unknown
  method: 'GET' | 'POST'
  path: string
}): Promise<T> => {
  const hasBody = body !== undefined
  const response = await fetch(`${getOwnerUrl()}${duckdbOwnerPrivateApiPrefix}${path}`, {
    body: hasBody ? JSON.stringify(body) : undefined,
    headers: hasBody ? {'content-type': 'application/json'} : undefined,
    method,
    signal: AbortSignal.timeout(getOwnerBackedRequestTimeoutMs(path)),
  })
  const text = await response.text()
  const parsed = tryParseOwnerResponse<T>(text)
  const parsedError = parsed && 'error' in parsed ? parsed.error : undefined

  if (!response.ok || parsedError) {
    const responseError = getErrorMessageValue(parsedError) || text || response.statusText

    throw new OwnerBackedJudgmentRequestError({
      message: getOwnerResponseMessage({detail: responseError, method, path, status: response.status, type: 'failed'}),
      responseText: text,
      status: response.status,
    })
  }

  if (!parsed) {
    throw new OwnerBackedJudgmentRequestError({
      message: getOwnerResponseMessage({detail: text, method, path, status: response.status, type: 'invalid JSON'}),
      responseText: text,
      status: response.status,
    })
  }

  if (!('data' in parsed)) {
    throw new OwnerBackedJudgmentRequestError({
      message: getOwnerResponseMessage({detail: text, method, path, status: response.status, type: 'no data'}),
      responseText: text,
      status: response.status,
    })
  }

  return parsed.data as T
}

const requestOwnerJson = async <T>(
  input: {
    body?: unknown
    method: 'GET' | 'POST'
    path: string
  },
  attempt = 1,
): Promise<T> => {
  try {
    return await requestOwnerJsonOnce<T>(input)
  } catch (error) {
    const shouldRetry =
      error instanceof OwnerBackedJudgmentRequestError
      && error.status === 200
      && error.responseText.trim() === ''
      && attempt < ownerBackedRequestMaxAttempts

    if (!shouldRetry) {
      throw error
    }

    await waitForOwnerBackedRetry()
    return requestOwnerJson<T>(input, attempt + 1)
  }
}

export const claimOwnerJudgmentJobPrompts = async ({
  claimedBy,
  jobId,
  limit,
  protectedRecordIds,
}: {
  claimedBy: string
  jobId: string
  limit: number
  protectedRecordIds?: string[]
}): Promise<PromptToProcess[]> => {
  const data = await requestOwnerJson<{claims: PromptToProcess[]}>({
    body: {claimedBy, limit, protectedRecordIds},
    method: 'POST',
    path: `/api/judgmentsjobs/${jobId}/claims`,
  })

  return data.claims
}

export const getOwnerBackedJudgmentJobInfo = async (jobId: string): Promise<OwnerBackedJudgmentJobInfo | null> => {
  const data = await requestOwnerJson<{job: OwnerBackedJudgmentJobInfo | null}>({
    method: 'GET',
    path: `/api/judgmentsjobs/${jobId}/runtime`,
  })

  return data.job
}

export const getOwnerBackedRunningJudgmentJobs = async (): Promise<RunningJudgmentJob[]> => {
  const data = await requestOwnerJson<{jobs: RunningJudgmentJob[]}>({method: 'GET', path: '/api/judgmentsjobs-running'})

  return data.jobs
}

export const heartbeatOwnerBackedJudgmentWorker = async ({
  claimedBy,
  jobIds,
}: {
  claimedBy: string
  jobIds: string[]
}): Promise<void> => {
  const uniqueJobIds = Array.from(new Set(jobIds))

  if (uniqueJobIds.length === 0) {
    return
  }

  await requestOwnerJson<{jobIds: string[]}>({
    body: {claimedBy, jobIds: uniqueJobIds},
    method: 'POST',
    path: '/api/judgmentsjobs-worker-heartbeats',
  })
}

export const getOwnerBackedJudgmentExecutionSnapshot = async ({
  executionSnapshotHash,
  executionSnapshotId,
}: {
  executionSnapshotHash: string
  executionSnapshotId: string
}): Promise<JudgmentExecutionSnapshotRecord> => {
  return requestOwnerJson<JudgmentExecutionSnapshotRecord>({
    method: 'GET',
    path: `/api/judgmentsjobs/execution-snapshots/${encodeURIComponent(executionSnapshotId)}?executionSnapshotHash=${encodeURIComponent(executionSnapshotHash)}`,
  })
}

const sendCompletionToOwner = async (
  payload: JudgeWorkerCompletionPayload & {tokenUse?: JudgeWorkerTokenUseSummary},
) => {
  const data = await requestOwnerJson<CompletionSendResult>({
    body: payload,
    method: 'POST',
    path: `/api/judgmentsjobs/${payload.jobId}/completions`,
  })

  return data
}

export const recordAcceptedJudgeWorkerClaims = async (claims: PromptToProcess[]): Promise<void> => {
  if (claims.length === 0) {
    return
  }

  const database = openJournalDatabase()
  const insert = database.query(`
    INSERT INTO accepted_claim (
      claim_id,
      job_id,
      queue_record_id,
      payload_json,
      request_attempt_manifest_json,
      request_attempt_manifest_version,
      request_attempt_manifest_repair_json,
      accepted_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(claim_id) DO UPDATE SET
      payload_json = EXCLUDED.payload_json,
      updated_at = EXCLUDED.updated_at
  `)
  const now = new Date().toISOString()

  database.transaction((entries: PromptToProcess[]) => {
    return entries.reduce((count, claim) => {
      insert.run(
        claim.claimId,
        claim.jobId,
        claim.recordId,
        JSON.stringify(claim),
        '[]',
        requestAttemptManifestVersion,
        null,
        now,
        now,
      )
      return count + 1
    }, 0)
  })(claims)
}

export const getAcceptedJudgeWorkerClaimLifecycleRows = (jobId: string): JudgeWorkerAcceptedClaimLifecycleRow[] => {
  const database = openJournalDatabase()

  return database
    .query(
      `
        SELECT
          accepted_at AS acceptedAt,
          job_id AS jobId,
          payload_json AS payloadJson,
          queue_record_id AS queueRecordId,
          request_attempt_manifest_json AS requestAttemptManifestJson,
          updated_at AS updatedAt
        FROM accepted_claim
        WHERE job_id = ?
      `,
    )
    .all(jobId) as JudgeWorkerAcceptedClaimLifecycleRow[]
}

const getAcceptedClaimPromptRows = (database: Database, jobId: string, limit: number): AcceptedClaimRolloutRow[] => {
  return database
    .query(
      `
        SELECT
          ac.claim_id AS claimId,
          ac.job_id AS jobId,
          ac.queue_record_id AS queueRecordId,
          ac.payload_json AS payloadJson,
          ac.request_attempt_manifest_json AS requestAttemptManifestJson,
          ac.request_attempt_manifest_version AS requestAttemptManifestVersion,
          ac.request_attempt_manifest_repair_json AS requestAttemptManifestRepairJson
        FROM accepted_claim ac
        WHERE ac.job_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM completion_outbox co
            WHERE co.claim_id = ac.claim_id
          )
        ORDER BY ac.accepted_at ASC, ac.claim_id ASC
        LIMIT ?
      `,
    )
    .all(jobId, limit) as AcceptedClaimRolloutRow[]
}

const getAcceptedClaimManifestRow = (
  database: Database,
  owner: AcceptedClaimManifestOwner,
): AcceptedClaimManifestRow | null => {
  return database
    .query(
      `
        SELECT
          request_attempt_manifest_json AS requestAttemptManifestJson,
          request_attempt_manifest_version AS requestAttemptManifestVersion,
          request_attempt_manifest_repair_json AS requestAttemptManifestRepairJson
        FROM accepted_claim
        WHERE claim_id = ?
          AND job_id = ?
          AND queue_record_id = ?
        LIMIT 1
      `,
    )
    .get(owner.claimId, owner.jobId, owner.queueRecordId) as AcceptedClaimManifestRow | null
}

const updateAcceptedClaimManifestRow = ({
  database,
  expectedVersion,
  json,
  owner,
}: {
  database: Database
  expectedVersion: number
  json: string
  owner: AcceptedClaimManifestOwner
}): boolean => {
  const result = database
    .query(
      `
        UPDATE accepted_claim
        SET request_attempt_manifest_json = ?,
            request_attempt_manifest_version = request_attempt_manifest_version + 1,
            updated_at = ?
        WHERE claim_id = ?
          AND job_id = ?
          AND queue_record_id = ?
          AND request_attempt_manifest_version = ?
      `,
    )
    .run(json, new Date().toISOString(), owner.claimId, owner.jobId, owner.queueRecordId, expectedVersion) as {
    changes?: number
  }

  return Number(result.changes ?? 0) === 1
}

const appendAcceptedClaimManifestRepairMarker = ({
  database,
  owner,
  reason,
  requestAttemptIds,
}: {
  database: Database
  owner: AcceptedClaimManifestOwner
  reason: string
  requestAttemptIds: string[]
}): void => {
  const row = getAcceptedClaimManifestRow(database, owner)

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
        UPDATE accepted_claim
        SET request_attempt_manifest_repair_json = ?,
            updated_at = ?
        WHERE claim_id = ?
          AND job_id = ?
          AND queue_record_id = ?
      `,
    )
    .run(markerJson, new Date().toISOString(), owner.claimId, owner.jobId, owner.queueRecordId)
}

const mutateAcceptedClaimManifestFromDatabase = ({
  attemptIndex = 1,
  database,
  mutation,
  owner,
}: {
  attemptIndex?: number
  database: Database
  mutation: JudgmentRequestAttemptManifestMutation
  owner: AcceptedClaimManifestOwner
}): void => {
  const row = getAcceptedClaimManifestRow(database, owner)

  if (!row) {
    return
  }

  const currentEntries = parseRequestAttempts(row.requestAttemptManifestJson)
  const nextEntries = mutateRequestAttemptManifestEntries({currentEntries, mutation})

  if (!requestAttemptManifestChanged(currentEntries, nextEntries)) {
    return
  }

  const updated = updateAcceptedClaimManifestRow({
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
    appendAcceptedClaimManifestRepairMarker({database, owner, reason: 'cas_exhausted', requestAttemptIds})
    throw new JudgmentRequestAttemptManifestCasExhaustedError({
      ownerId: getRequestAttemptManifestOwnerId(owner),
      ownerKind: owner.kind,
      requestAttemptIds,
    })
  }

  return mutateAcceptedClaimManifestFromDatabase({attemptIndex: attemptIndex + 1, database, mutation, owner})
}

const compactAcceptedClaimManifestCloseoutFromDatabase = ({
  database,
  owner,
  requestAttempts,
}: {
  database: Database
  owner: AcceptedClaimManifestOwner
  requestAttempts: JudgmentRequestAttemptJsonEntry[]
}): void => {
  if (requestAttempts.length === 0) {
    return
  }

  mutateAcceptedClaimManifestFromDatabase({
    database,
    mutation: {
      compactRequestAttemptIds: requestAttempts.map((attempt) => {
        return attempt.requestAttemptId
      }),
      mergeEntries: requestAttempts,
    },
    owner,
  })
}

export const mutateAcceptedClaimRequestAttemptManifest = async ({
  mutation,
  owner,
}: {
  mutation: JudgmentRequestAttemptManifestMutation
  owner: AcceptedClaimManifestOwner
}): Promise<void> => {
  const database = openJournalDatabase()
  mutateAcceptedClaimManifestFromDatabase({database, mutation, owner})
}

const getPendingTokenUseForCompletion = (
  database: Database,
  payload: JudgeWorkerCompletionPayload,
): PendingTokenUseJsonRow | null => {
  const row = database
    .query(
      `
        SELECT
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson
        FROM pending_token_use
        WHERE job_id = ?
          AND (
            queue_record_id = ?
            OR (article_id = ? AND prompt_id = ?)
          )
        LIMIT 1
      `,
    )
    .get(payload.jobId, payload.queueRecordId, payload.articleId, payload.promptId) as PendingTokenUseJsonRow | null

  return row ?? null
}

const deletePendingTokenUseByIdentity = (
  database: Database,
  input: {articleId: string; jobId: string; promptId: string; queueRecordId?: string | null},
): void => {
  database
    .query(
      `
        DELETE FROM pending_token_use
        WHERE job_id = ?
          AND (
            queue_record_id = ?
            OR (article_id = ? AND prompt_id = ?)
          )
      `,
    )
    .run(input.jobId, input.queueRecordId ?? '', input.articleId, input.promptId)
}

const deletePendingTokenUse = (database: Database, payload: JudgeWorkerCompletionPayload): void => {
  deletePendingTokenUseByIdentity(database, payload)
}

const getPendingTokenUseRows = (database: Database): PendingTokenUseRow[] => {
  return database
    .query(
      `
        SELECT
          job_id AS jobId,
          claim_id AS claimId,
          queue_record_id AS queueRecordId,
          article_id AS articleId,
          prompt_id AS promptId,
          request_attempt_id AS requestAttemptId,
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM pending_token_use
        ORDER BY created_at ASC
      `,
    )
    .all() as PendingTokenUseRow[]
}

const getJournalLegacyProviderKey = (provider: string | null | undefined): string => {
  return provider && provider.trim().length > 0 ? `legacy:${provider}` : 'legacy:unknown'
}

const getCompletionLegacyOutcome = (status: string): JudgmentRequestAttemptJsonEntry['outcome'] => {
  return status === 'completed' || status === 'judged' || status === 'succeeded' || status === 'skipped'
    ? 'success'
    : 'failure'
}

const parseCompletionPayloadOrNull = (payloadJson: string): JudgeWorkerCompletionPayload | null => {
  try {
    return parseJson<JudgeWorkerCompletionPayload>(payloadJson)
  } catch {
    return null
  }
}

const getLegacyCompletionOutboxRequestAttemptsJson = (row: CompletionOutboxRow): string | null => {
  const state = getRequestAttemptRepairState(row.requestAttemptsJson)

  if (state.kind !== 'legacy') {
    return null
  }

  const payload = parseCompletionPayloadOrNull(row.payloadJson)

  if (!payload) {
    return null
  }

  return getLegacyRequestAttemptsJson({
    closeoutKind: 'completion_outbox',
    durableRef: {claimId: row.claimId, jobId: row.jobId, queueRecordId: row.queueRecordId},
    durableRowRef: {
      claimId: row.claimId,
      jobId: row.jobId,
      queueRecordId: row.queueRecordId,
      surface: 'completion_outbox',
    },
    existingEntries: state.entries,
    fallback: {
      articleId: payload.articleId,
      claimId: row.claimId,
      createdAt: row.updatedAt,
      finishedAt: row.updatedAt,
      jobId: row.jobId,
      outcome: getCompletionLegacyOutcome(row.status),
      promptId: payload.promptId,
      promptIds: [payload.promptId],
      providerKey: getJournalLegacyProviderKey(payload.modelId),
      queueRecordId: row.queueRecordId,
      startedAt: row.updatedAt,
    },
  })
}

const getLegacyCompletionRows = (database: Database): CompletionOutboxRow[] => {
  return database
    .query(
      `
        SELECT
          acked_at AS ackedAt,
          article_id AS articleId,
          claim_id AS claimId,
          job_id AS jobId,
          local_applied_at AS localAppliedAt,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
          prompt_id AS promptId,
          status,
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson,
          updated_at AS updatedAt
        FROM completion_outbox
        WHERE ${legacyRequestAttemptRepairCandidateSql}
        ORDER BY created_at DESC, claim_id DESC
      `,
    )
    .all() as CompletionOutboxRow[]
}

const repairLegacyCompletionOutboxRows = (database: Database): void => {
  getLegacyCompletionRows(database).forEach((row) => {
    const state = getRequestAttemptRepairState(row.requestAttemptsJson)
    const requestAttemptsJson = getLegacyCompletionOutboxRequestAttemptsJson(row)

    if (state.kind === 'quarantined') {
      database
        .query(
          `
            UPDATE completion_outbox
            SET last_error = ?,
                updated_at = ?
            WHERE claim_id = ?
          `,
        )
        .run(state.reason, new Date().toISOString(), row.claimId)
      return
    }

    if (requestAttemptsJson === null) {
      if (state.kind === 'legacy') {
        database
          .query(
            `
              UPDATE completion_outbox
              SET last_error = ?,
                  updated_at = ?
              WHERE claim_id = ?
            `,
          )
          .run(legacyCompletionEvidencePendingRepairReason, new Date().toISOString(), row.claimId)
      }
      return
    }

    database
      .query(
        `
          UPDATE completion_outbox
          SET request_attempts_json = ?,
              updated_at = ?
          WHERE claim_id = ?
        `,
      )
      .run(requestAttemptsJson, new Date().toISOString(), row.claimId)
  })
}

const getLegacyPendingTokenUseRequestAttempts = (row: PendingTokenUseRow): JudgmentRequestAttemptJsonEntry[] => {
  const state = getRequestAttemptRepairState(row.requestAttemptsJson)

  return state.kind === 'legacy'
    ? getLegacyRequestAttempts({
        closeoutKind: 'pending_token_use',
        durableRef: {
          claimId: row.claimId,
          id: row.requestAttemptId,
          jobId: row.jobId,
          queueRecordId: row.queueRecordId,
        },
        durableRowRef: {
          claimId: row.claimId,
          id: row.requestAttemptId,
          jobId: row.jobId,
          queueRecordId: row.queueRecordId,
          requestAttemptId: row.requestAttemptId,
          surface: 'pending_token_use',
        },
        existingEntries: state.entries,
        fallback: {
          articleId: row.articleId,
          claimId: row.claimId,
          createdAt: row.createdAt,
          finishedAt: row.updatedAt,
          jobId: row.jobId,
          outcome: 'unknown',
          promptId: row.promptId,
          promptIds: [row.promptId],
          providerKey: 'legacy:unknown',
          queueRecordId: row.queueRecordId,
          startedAt: row.createdAt,
        },
      })
    : []
}

const repairLegacyPendingTokenUseRows = (database: Database): void => {
  getPendingTokenUseRows(database).forEach((row) => {
    const state = getRequestAttemptRepairState(row.requestAttemptsJson)
    const requestAttempts = getLegacyPendingTokenUseRequestAttempts(row)
    const [firstAttempt] = requestAttempts
    const requestAttemptsJson = stringifyRequestAttempts(requestAttempts)

    if (state.kind !== 'legacy' || !firstAttempt || requestAttemptsJson === null) {
      return
    }

    database.transaction(() => {
      database
        .query(
          `
            INSERT INTO pending_token_use (
              job_id,
              claim_id,
              queue_record_id,
              article_id,
              prompt_id,
              request_attempt_id,
              token_use_json,
              request_attempts_json,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id, queue_record_id, request_attempt_id) DO UPDATE SET
              token_use_json = EXCLUDED.token_use_json,
              request_attempts_json = EXCLUDED.request_attempts_json,
              updated_at = EXCLUDED.updated_at
          `,
        )
        .run(
          row.jobId,
          row.claimId,
          row.queueRecordId,
          row.articleId,
          row.promptId,
          firstAttempt.requestAttemptId,
          row.tokenUseJson,
          requestAttemptsJson,
          row.createdAt,
          new Date().toISOString(),
        )
      database
        .query(
          `
            DELETE FROM pending_token_use
            WHERE job_id = ?
              AND queue_record_id = ?
              AND request_attempt_id = ?
              AND request_attempt_id != ?
          `,
        )
        .run(row.jobId, row.queueRecordId, row.requestAttemptId, firstAttempt.requestAttemptId)
    })()
  })
}

const repairLegacyJournalEvidence = (database: Database): void => {
  repairLegacyCompletionOutboxRows(database)
  repairLegacyPendingTokenUseRows(database)
}

const getAcceptedClaimRolloutRows = (database: Database): AcceptedClaimRolloutRow[] => {
  return database
    .query(
      `
        SELECT
          claim_id AS claimId,
          job_id AS jobId,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
          request_attempt_manifest_json AS requestAttemptManifestJson,
          request_attempt_manifest_version AS requestAttemptManifestVersion,
          request_attempt_manifest_repair_json AS requestAttemptManifestRepairJson
        FROM accepted_claim
        ORDER BY accepted_at ASC, claim_id ASC
      `,
    )
    .all() as AcceptedClaimRolloutRow[]
}

const getAcceptedClaimPromptKey = ({jobId, queueRecordId}: AcceptedClaimProtectedPrompt): string => {
  return `${jobId}\n${queueRecordId}`
}

const getProtectedAcceptedClaimPromptKeys = (prompts: AcceptedClaimProtectedPrompt[]): Set<string> => {
  return new Set(
    prompts.map((prompt) => {
      return getAcceptedClaimPromptKey(prompt)
    }),
  )
}

const acceptedClaimHasCompletionOutboxIntent = (database: Database, claimId: string): boolean => {
  const row = database
    .query(
      `
        SELECT claim_id AS claimId
        FROM completion_outbox
        WHERE claim_id = ?
        LIMIT 1
      `,
    )
    .get(claimId) as {claimId: string} | null

  return row !== null
}

const getRolloutCloseoutRequestAttempts = ({
  now,
  row,
}: {
  now: string
  row: AcceptedClaimRolloutRow
}): JudgmentRequestAttemptJsonEntry[] => {
  const prompt = parseJson<PromptToProcess>(row.payloadJson)
  const manifestAttempts = parseRequestAttempts(row.requestAttemptManifestJson)

  if (manifestAttempts.length === 0) {
    return getLegacyRequestAttempts({
      closeoutKind: 'completion_outbox',
      durableRef: {claimId: row.claimId, jobId: row.jobId, queueRecordId: row.queueRecordId},
      durableRowRef: {
        claimId: row.claimId,
        jobId: row.jobId,
        queueRecordId: row.queueRecordId,
        surface: 'completion_outbox',
      },
      fallback: {
        articleId: prompt.articleId,
        claimId: row.claimId,
        createdAt: now,
        finishedAt: now,
        jobId: row.jobId,
        outcome: 'failure',
        promptId: prompt.promptId,
        promptIds: [prompt.promptId],
        providerKey: getJournalLegacyProviderKey(prompt.modelProvider),
        queueRecordId: row.queueRecordId,
        startedAt: now,
      },
    })
  }

  const requestAttempts = manifestAttempts.map((attempt) => {
    return {
      ...attempt,
      closeoutKind: 'completion_outbox' as const,
      closeoutReason: robustSendRolloutDiscardedReason,
      finishedAt: attempt.finishedAt ?? now,
      outcome: attempt.outcome === 'success' ? ('success' as const) : ('failure' as const),
      updatedAt: now,
    }
  })

  return withDurableCloseoutRef({
    closeoutKind: 'completion_outbox',
    ref: {claimId: row.claimId, jobId: row.jobId, queueRecordId: row.queueRecordId},
    requestAttempts,
  })
}

const getRolloutCompletionPayload = (row: AcceptedClaimRolloutRow): JudgeWorkerCompletionPayload => {
  const prompt = parseJson<PromptToProcess>(row.payloadJson)
  const requestAttempts = getRolloutCloseoutRequestAttempts({now: new Date().toISOString(), row})

  return {
    articleId: prompt.articleId,
    claimId: row.claimId,
    executionSnapshotHash: prompt.executionSnapshotHash,
    executionSnapshotId: prompt.executionSnapshotId,
    jobId: row.jobId,
    modelId: prompt.modelId,
    projectId: prompt.projectId,
    promptId: prompt.promptId,
    queueRecordId: row.queueRecordId,
    requestAttempts,
    retryAfterMs: null,
    status: 'retry',
    useAbstract: prompt.useAbstract,
    useFulltext: prompt.useFulltext,
    useFulltextNoImages: prompt.useFulltextNoImages,
    useTitle: prompt.useTitle,
  }
}

const insertRolloutCloseoutIntent = (database: Database, row: AcceptedClaimRolloutRow): number => {
  const payload = getRolloutCompletionPayload(row)
  const requestAttemptsJson = stringifyRequestAttempts(payload.requestAttempts)
  const now = new Date().toISOString()
  const result = database
    .query(
      `
        INSERT INTO completion_outbox (
          claim_id,
          job_id,
          queue_record_id,
          article_id,
          prompt_id,
          payload_json,
          request_attempts_json,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET
          article_id = COALESCE(completion_outbox.article_id, EXCLUDED.article_id),
          prompt_id = COALESCE(completion_outbox.prompt_id, EXCLUDED.prompt_id),
          request_attempts_json = COALESCE(completion_outbox.request_attempts_json, EXCLUDED.request_attempts_json),
          updated_at = EXCLUDED.updated_at
        WHERE completion_outbox.acked_at IS NULL
      `,
    )
    .run(
      payload.claimId,
      payload.jobId,
      payload.queueRecordId,
      payload.articleId,
      payload.promptId,
      JSON.stringify(payload),
      requestAttemptsJson,
      payload.status ?? 'retry',
      now,
      now,
    ) as {changes?: number}

  return Number(result.changes ?? 0)
}

const recordRolloutCloseoutIntents = (database: Database, protectedPromptKeys: Set<string> = new Set()): number => {
  return database.transaction((rows: AcceptedClaimRolloutRow[]) => {
    return rows.reduce((count, row) => {
      return protectedPromptKeys.has(getAcceptedClaimPromptKey(row))
        || acceptedClaimHasCompletionOutboxIntent(database, row.claimId)
        ? count
        : count + insertRolloutCloseoutIntent(database, row)
    }, 0)
  })(getAcceptedClaimRolloutRows(database))
}

const deleteAcceptedClaimsWithOwnerAck = (database: Database): number => {
  const result = database
    .query(
      `
        DELETE FROM accepted_claim
        WHERE EXISTS (
          SELECT 1
          FROM completion_outbox co
          WHERE co.claim_id = accepted_claim.claim_id
            AND co.acked_at IS NOT NULL
        )
      `,
    )
    .run() as {changes?: number}

  return Number(result.changes ?? 0)
}

export const enqueueJudgeWorkerCompletion = async (payload: JudgeWorkerCompletionPayload): Promise<void> => {
  const database = openJournalDatabase()
  const now = new Date().toISOString()
  const status = payload.status ?? 'judged'
  const pendingTokenUse = getPendingTokenUseForCompletion(database, payload)
  const requestAttemptsJson = pendingTokenUse?.requestAttemptsJson ?? stringifyRequestAttempts(payload.requestAttempts)
  const requestAttempts = parseRequestAttempts(requestAttemptsJson ?? payload.requestAttempts ?? null)

  const persisted = database.transaction(() => {
    const result = database
      .query(
        `
          INSERT INTO completion_outbox (
            claim_id,
            job_id,
            queue_record_id,
            article_id,
            prompt_id,
            payload_json,
            token_use_json,
            request_attempts_json,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(claim_id) DO UPDATE SET
            job_id = EXCLUDED.job_id,
            queue_record_id = EXCLUDED.queue_record_id,
            article_id = EXCLUDED.article_id,
            prompt_id = EXCLUDED.prompt_id,
            payload_json = EXCLUDED.payload_json,
            token_use_json = COALESCE(completion_outbox.token_use_json, EXCLUDED.token_use_json),
            request_attempts_json = COALESCE(EXCLUDED.request_attempts_json, completion_outbox.request_attempts_json),
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at
          WHERE completion_outbox.acked_at IS NULL
        `,
      )
      .run(
        payload.claimId,
        payload.jobId,
        payload.queueRecordId,
        payload.articleId,
        payload.promptId,
        JSON.stringify(payload),
        pendingTokenUse?.tokenUseJson ?? null,
        requestAttemptsJson ?? null,
        status,
        now,
        now,
      ) as {changes?: number}
    const insertedOrUpdated = Number(result.changes ?? 0) > 0
    const reactivated =
      !insertedOrUpdated && pendingTokenUse
        ? reactivateAckedCompletionWithTokenUse(
            database,
            payload.claimId,
            pendingTokenUse.tokenUseJson,
            requestAttemptsJson ?? null,
          ) > 0
        : false

    if (insertedOrUpdated || reactivated) {
      deletePendingTokenUse(database, payload)
    }

    return insertedOrUpdated || reactivated
  })()

  if (persisted) {
    compactAcceptedClaimManifestCloseoutFromDatabase({
      database,
      owner: {
        articleId: payload.articleId,
        claimId: payload.claimId,
        jobId: payload.jobId,
        kind: 'accepted_claim',
        promptId: payload.promptId,
        promptIds: [payload.promptId],
        queueRecordId: payload.queueRecordId,
      },
      requestAttempts,
    })
  }
}

const reactivateAckedCompletionWithTokenUse = (
  database: Database,
  claimId: string,
  tokenUseJson: string,
  requestAttemptsJson: string | null,
): number => {
  const result = database
    .query(
      `
        UPDATE completion_outbox
        SET token_use_json = COALESCE(token_use_json, ?),
            request_attempts_json = COALESCE(?, request_attempts_json),
            acked_at = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE claim_id = ?
          AND acked_at IS NOT NULL
      `,
    )
    .run(tokenUseJson, requestAttemptsJson, new Date().toISOString(), claimId) as {changes?: number}

  return Number(result.changes ?? 0)
}

const getNormalizedCompletionReplayLimit = (limit: number | null | undefined): number | null => {
  return typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : null
}

const getCompletionReplayLimitSql = (limit: number | null): string => {
  return limit === null ? '' : `LIMIT ${limit}`
}

const getUnackedCompletionRows = (database: Database, claimId?: string): CompletionOutboxRow[] => {
  return database
    .query(
      `
        SELECT
          acked_at AS ackedAt,
          article_id AS articleId,
          claim_id AS claimId,
          job_id AS jobId,
          local_applied_at AS localAppliedAt,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
          prompt_id AS promptId,
          status,
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson,
          updated_at AS updatedAt
        FROM completion_outbox
        WHERE acked_at IS NULL
          ${claimId ? 'AND claim_id = ?' : ''}
        ORDER BY created_at ASC, claim_id ASC
      `,
    )
    .all(...(claimId ? [claimId] : [])) as CompletionOutboxRow[]
}

const getCompletionReplayCandidateRows = (
  database: Database,
  claimId: string | undefined,
  limit: number | undefined,
): CompletionOutboxRow[] => {
  const normalizedLimit = getNormalizedCompletionReplayLimit(limit)
  const replayGraceCutoff = new Date(Date.now() - successCompletionTokenUseReplayGraceMs).toISOString()
  const failureBackoffCutoff = new Date(Date.now() - completionReplayFailureBackoffMs).toISOString()

  return database
    .query(
      `
        SELECT
          acked_at AS ackedAt,
          article_id AS articleId,
          claim_id AS claimId,
          job_id AS jobId,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
          prompt_id AS promptId,
          status,
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson,
          updated_at AS updatedAt
        FROM completion_outbox
        WHERE acked_at IS NULL
          ${claimId ? 'AND claim_id = ?' : ''}
          AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
          AND (
            status NOT IN ('completed', 'judged', 'succeeded')
            OR token_use_json IS NOT NULL
            OR updated_at <= ?
          )
        ORDER BY created_at ASC, claim_id ASC
        ${getCompletionReplayLimitSql(normalizedLimit)}
      `,
    )
    .all(...(claimId ? [claimId, failureBackoffCutoff, replayGraceCutoff] : [failureBackoffCutoff, replayGraceCutoff])) as CompletionOutboxRow[]
}

const getCompletionLocalApplyRows = (database: Database, limit: number | undefined): CompletionOutboxRow[] => {
  const normalizedLimit = getNormalizedCompletionReplayLimit(limit)

  return database
    .query(
      `
        SELECT
          acked_at AS ackedAt,
          article_id AS articleId,
          claim_id AS claimId,
          job_id AS jobId,
          local_applied_at AS localAppliedAt,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
          prompt_id AS promptId,
          status,
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson,
          updated_at AS updatedAt
        FROM completion_outbox
        WHERE acked_at IS NULL
          AND local_applied_at IS NULL
          AND status = 'retry'
          AND status != 'discarded_stale'
        ORDER BY created_at ASC, claim_id ASC
        ${getCompletionReplayLimitSql(normalizedLimit)}
      `,
    )
    .all() as CompletionOutboxRow[]
}

const completionStatusNeedsTokenUseBeforeReplay = (status: string): boolean => {
  return status === 'completed' || status === 'judged' || status === 'succeeded'
}

const completionRowIsReplayable = (row: CompletionOutboxRow): boolean => {
  const updatedAt = new Date(row.updatedAt).getTime()
  const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : successCompletionTokenUseReplayGraceMs

  return (
    !completionStatusNeedsTokenUseBeforeReplay(row.status)
    || row.tokenUseJson !== null
    || ageMs >= successCompletionTokenUseReplayGraceMs
  )
}

const completionRowMatchesPendingTokenUse = (row: CompletionOutboxRow, pending: PendingTokenUseRow): boolean => {
  const payload = parseJson<JudgeWorkerCompletionPayload>(row.payloadJson)

  return (
    payload.jobId === pending.jobId
    && (payload.queueRecordId === pending.queueRecordId
      || (payload.articleId === pending.articleId && payload.promptId === pending.promptId))
  )
}

const getRequestAttemptQueueRecordIds = (requestAttempts: JudgmentRequestAttemptJsonEntry[]): string[] => {
  return requestAttempts.flatMap((attempt) => {
    return typeof attempt.queueRecordId === 'string' && attempt.queueRecordId.trim().length > 0
      ? [attempt.queueRecordId]
      : []
  })
}

const getTokenUseCompletionLookupQueueRecordIds = ({
  promptIds,
  queueRecordIds = [],
  requestAttempts = [],
}: Pick<TokenUseCompletionLookupInput, 'promptIds' | 'queueRecordIds' | 'requestAttempts'>): string[] => {
  return Array.from(new Set([...queueRecordIds, ...getRequestAttemptQueueRecordIds(requestAttempts), ...promptIds]))
    .map((id) => {
      return id.trim()
    })
    .filter((id) => {
      return id.length > 0
    })
    .slice(0, tokenUseCompletionLookupLimit)
}

const completionRowMatchesTokenUseInput = (row: CompletionOutboxRow, input: TokenUseCompletionLookupInput): boolean => {
  if (row.articleId !== null && row.promptId !== null) {
    return row.jobId === input.jobId && row.articleId === input.articleId && input.promptIds.includes(row.promptId)
  }

  const payload = parseJson<JudgeWorkerCompletionPayload>(row.payloadJson)

  return (
    payload.jobId === input.jobId && payload.articleId === input.articleId && input.promptIds.includes(payload.promptId)
  )
}

const getCompletionRowsByTokenUseIdentity = (
  database: Database,
  input: TokenUseCompletionLookupInput,
  ackedState: 'acked' | 'unacked',
): CompletionOutboxRow[] => {
  const queueRecordIds = getTokenUseCompletionLookupQueueRecordIds(input)
  const promptIds = input.promptIds
    .map((id) => {
      return id.trim()
    })
    .filter((id) => {
      return id.length > 0
    })
    .slice(0, tokenUseCompletionLookupLimit)
  const queueRecordPlaceholders = queueRecordIds
    .map(() => {
      return '?'
    })
    .join(', ')
  const promptIdPlaceholders = promptIds
    .map(() => {
      return '?'
    })
    .join(', ')
  const queueRecordCondition = queueRecordIds.length > 0 ? `queue_record_id IN (${queueRecordPlaceholders})` : 'FALSE'
  const promptIdCondition =
    promptIds.length > 0 ? `(article_id = ? AND prompt_id IN (${promptIdPlaceholders}))` : 'FALSE'

  if (queueRecordIds.length === 0 && promptIds.length === 0) {
    return []
  }

  const rows = database
    .query(
      `
        SELECT
          acked_at AS ackedAt,
          article_id AS articleId,
          claim_id AS claimId,
          job_id AS jobId,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
          prompt_id AS promptId,
          status,
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson,
          updated_at AS updatedAt
        FROM completion_outbox
        WHERE job_id = ?
          AND (${queueRecordCondition} OR ${promptIdCondition})
          AND acked_at IS ${ackedState === 'acked' ? 'NOT NULL' : 'NULL'}
        ORDER BY created_at DESC, claim_id DESC
        LIMIT ${tokenUseCompletionLookupLimit}
      `,
    )
    .all(
      input.jobId,
      ...queueRecordIds,
      ...(promptIds.length > 0 ? [input.articleId, ...promptIds] : []),
    ) as CompletionOutboxRow[]

  return rows.filter((row) => {
    return completionRowMatchesTokenUseInput(row, input)
  })
}

const reactivateAckedCompletionsWithPendingTokenUse = (database: Database): number => {
  const pendingRows = getPendingTokenUseRows(database)

  if (pendingRows.length === 0) {
    return 0
  }

  return database.transaction((rows: PendingTokenUseRow[]) => {
    return rows.reduce((count, pending) => {
      const completionRow = getCompletionRowsByTokenUseIdentity(
        database,
        {
          articleId: pending.articleId,
          jobId: pending.jobId,
          promptIds: [pending.promptId],
          queueRecordIds: [pending.queueRecordId],
          requestAttempts: parseRequestAttempts(pending.requestAttemptsJson),
        },
        'acked',
      ).find((row) => {
        return (
          row.ackedAt !== null
          && completionStatusNeedsTokenUseBeforeReplay(row.status)
          && completionRowMatchesPendingTokenUse(row, pending)
        )
      })

      if (!completionRow) {
        return count
      }

      const changed = reactivateAckedCompletionWithTokenUse(
        database,
        completionRow.claimId,
        pending.tokenUseJson,
        pending.requestAttemptsJson,
      )

      if (changed > 0) {
        deletePendingTokenUseByIdentity(database, pending)
      }

      return count + changed
    }, 0)
  })(pendingRows)
}

const markCompletionAttemptFailed = (database: Database, claimId: string, error: unknown): void => {
  database
    .query(
      `
        UPDATE completion_outbox
        SET attempts = attempts + 1,
            last_attempt_at = ?,
            last_error = ?,
            updated_at = ?
        WHERE claim_id = ?
          AND acked_at IS NULL
      `,
    )
    .run(
      new Date().toISOString(),
      error instanceof Error ? error.message : String(error),
      new Date().toISOString(),
      claimId,
    )
}

const markCompletionAcked = (database: Database, claimId: string): void => {
  const now = new Date().toISOString()

  database
    .query(
      `
        UPDATE completion_outbox
        SET acked_at = ?,
            last_error = NULL,
            updated_at = ?
        WHERE claim_id = ?
          AND acked_at IS NULL
      `,
    )
    .run(now, now, claimId)
}

const markCompletionDiscarded = (database: Database, claimId: string, error: unknown): void => {
  const now = new Date().toISOString()

  database
    .query(
      `
        UPDATE completion_outbox
        SET attempts = attempts + 1,
            last_attempt_at = ?,
            last_error = ?,
            status = 'discarded_stale',
            acked_at = ?,
            updated_at = ?
        WHERE claim_id = ?
          AND acked_at IS NULL
      `,
    )
    .run(now, error instanceof Error ? error.message : String(error), now, now, claimId)
}

const markCompletionLocallyApplied = (database: Database, claimId: string): void => {
  const now = new Date().toISOString()

  database
    .query(
      `
        UPDATE completion_outbox
        SET local_applied_at = ?,
            updated_at = ?
        WHERE claim_id = ?
          AND local_applied_at IS NULL
      `,
    )
    .run(now, now, claimId)
}

const getCompletionAckStatus = (
  payload: JudgeWorkerCompletionPayload,
): 'failed' | 'judged' | 'retry' | 'skipped' => {
  return payload.status === 'retry'
    ? 'retry'
    : payload.status === 'skipped'
      ? 'skipped'
      : payload.status === 'failed'
        ? 'failed'
        : 'judged'
}

const getCompletionTokenUseId = (row: CompletionOutboxRow): string | null => {
  return row.tokenUseJson ? `judgment-completion-token-use:${row.claimId}` : null
}

const getCompletionAck = (row: CompletionOutboxRow, payload: JudgeWorkerCompletionPayload) => {
  return {
    claimId: payload.claimId,
    queuePromptId: payload.queueRecordId,
    status: getCompletionAckStatus(payload),
    requestAttemptsJson: row.requestAttemptsJson,
    tokenUseId: getCompletionTokenUseId(row),
  }
}

const getStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

const getCompletionJudgmentRecord = (payload: JudgeWorkerCompletionPayload): Record<string, unknown> => {
  return payload.judgment && typeof payload.judgment === 'object' && !Array.isArray(payload.judgment)
    ? (payload.judgment as Record<string, unknown>)
    : {}
}

const getCompletionAnsweredOriginal = (payload: JudgeWorkerCompletionPayload): string | null => {
  const judgment = getCompletionJudgmentRecord(payload)
  const value = payload.answeredOriginal ?? judgment.answer

  return Array.isArray(value)
    ? JSON.stringify(getStringArray(value))
    : typeof value === 'string'
      ? value
      : value == null
        ? null
        : JSON.stringify(value)
}

const getCompletionAnsweredOriginalAsArray = (payload: JudgeWorkerCompletionPayload): string[] => {
  const judgment = getCompletionJudgmentRecord(payload)
  const explicit = getStringArray(payload.answeredOriginalAsArray)
  const fallback = payload.answeredOriginal ?? judgment.answer

  return explicit.length > 0
    ? explicit
    : Array.isArray(fallback)
      ? getStringArray(fallback)
      : typeof fallback === 'string'
        ? [fallback]
        : []
}

const applyJudgedCompletionLocally = async (
  row: CompletionOutboxRow,
  payload: JudgeWorkerCompletionPayload,
): Promise<void> => {
  const judgment = getCompletionJudgmentRecord(payload)
  const now = new Date()

  await getJudgmentJobSqliteService().recordJudgmentSuccess(payload.jobId, {
    answeredOriginal: getCompletionAnsweredOriginal(payload),
    answeredOriginalAsArray: getCompletionAnsweredOriginalAsArray(payload),
    articleId: payload.articleId,
    claimId: payload.claimId,
    chunkingStrategy: payload.chunkingStrategy ?? null,
    confidenceOriginal: payload.confidenceOriginal ?? 50,
    createdAt: now,
    explanation: payload.explanation ?? (typeof judgment.explanation === 'string' ? judgment.explanation : null),
    executionSnapshotHash: payload.executionSnapshotHash,
    executionSnapshotId: payload.executionSnapshotId,
    isAnswered: payload.isAnswered ?? true,
    judgmentId: payload.judgmentId ?? crypto.randomUUID(),
    modelId: payload.modelId,
    projectId: payload.projectId,
    promptId: payload.promptId,
    queuePromptId: payload.queueRecordId,
    completionTokenUseId: getCompletionTokenUseId(row),
    quotes: payload.quotes ?? judgment.quotes ?? null,
    rawResponseJson: payload.rawResponseJson ?? payload.judgment ?? null,
    requestAttemptsJson: row.requestAttemptsJson,
    snapshotProjectId: payload.projectId,
    snapshotProjectModelName: null,
    updatedAt: now,
    useAbstract: payload.useAbstract,
    useFulltext: payload.useFulltext,
    useFulltextNoImages: payload.useFulltextNoImages,
    useTitle: payload.useTitle,
  })
}

const applyTerminalCompletionLocally = async (
  row: CompletionOutboxRow,
  payload: JudgeWorkerCompletionPayload,
): Promise<void> => {
  const completionAck = getCompletionAck(row, payload)

  return payload.status === 'retry'
    ? getJudgmentJobSqliteService().markPromptAsRetryWithoutLease(
        payload.jobId,
        payload.queueRecordId,
        payload.retryAfterMs ?? null,
        completionAck,
      )
    : payload.status === 'skipped'
      ? getJudgmentJobSqliteService().markPromptAsSkipped(
          payload.jobId,
          payload.queueRecordId,
          payload.skipReason ?? 'no_fulltext',
          completionAck,
        )
      : getJudgmentJobSqliteService().markPromptAsClosed(
          payload.jobId,
          payload.queueRecordId,
          'ownerCompletionFailed',
          completionAck,
        )
}

const applyCompletionRowLocally = async (database: Database, row: CompletionOutboxRow): Promise<boolean> => {
  if (!existsSync(getJudgmentJobSqlitePath(row.jobId))) {
    return false
  }

  try {
    const payload = getCompletionPayloadFromRow(row)
    const mismatch = await getLocalClaimIdentityMismatch(getCompletionClaimIdentity(payload))

    if (mismatch) {
      markCompletionLocallyApplied(database, row.claimId)
      return false
    }

    await (getCompletionAckStatus(payload) === 'judged'
      ? applyJudgedCompletionLocally(row, payload)
      : applyTerminalCompletionLocally(row, payload))
    markCompletionLocallyApplied(database, row.claimId)
    return true
  } catch (error) {
    completionJournalLogger.warn(
      `judge-worker:completion-local-apply-failed:${row.claimId}`,
      '[judge-worker] local completion apply failed',
      {
        claimId: row.claimId,
        error: error instanceof Error ? error.message : String(error),
        jobId: row.jobId,
        queueRecordId: row.queueRecordId,
      },
    )
    return false
  }
}

const applyCompletionRowsLocally = async (
  database: Database,
  rows: CompletionOutboxRow[],
): Promise<{appliedCount: number; skippedCount: number}> => {
  const [row, ...remainingRows] = rows

  if (!row) {
    return {appliedCount: 0, skippedCount: 0}
  }

  const applied = await applyCompletionRowLocally(database, row)
  const rest = await applyCompletionRowsLocally(database, remainingRows)

  return {
    appliedCount: rest.appliedCount + (applied ? 1 : 0),
    skippedCount: rest.skippedCount + (applied ? 0 : 1),
  }
}

export const applyJudgeWorkerCompletionOutboxLocally = async ({
  limit,
}: {
  limit?: number
} = {}): Promise<{appliedCount: number; skippedCount: number}> => {
  const database = openJournalDatabase()

  return applyCompletionRowsLocally(database, getCompletionLocalApplyRows(database, limit))
}

const isStaleCompletionReplayError = (error: unknown): boolean => {
  const text = error instanceof OwnerBackedJudgmentRequestError ? error.responseText || error.message : ''
  const normalized = text.toLowerCase()

  return (
    error instanceof OwnerBackedJudgmentRequestError
    && error.status === 409
    && (normalized.includes('missing claimed prompt identity')
      || normalized.includes('missing sqlite job database')
      || (normalized.includes('snapshot') && normalized.includes('identity mismatch')))
  )
}

const completionClaimIdentityKeys: CompletionClaimIdentityKey[] = [
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
]

type CompletionClaimIdentity = Record<CompletionClaimIdentityKey, string | boolean>

const getClaimIdentityMismatch = (
  expected: CompletionClaimIdentity,
  actual: CompletionClaimIdentity | null,
): string | null => {
  if (!actual) {
    return 'missing claimed prompt identity'
  }

  const mismatchedKey = completionClaimIdentityKeys.find((key) => {
    return actual[key] !== expected[key]
  })

  return mismatchedKey ? `snapshot claim identity mismatch for ${mismatchedKey}` : null
}

const getCompletionClaimIdentity = (payload: JudgeWorkerCompletionPayload): CompletionClaimIdentity => {
  return {
    articleId: payload.articleId,
    claimId: payload.claimId,
    executionSnapshotHash: payload.executionSnapshotHash,
    executionSnapshotId: payload.executionSnapshotId,
    jobId: payload.jobId,
    modelId: payload.modelId,
    projectId: payload.projectId,
    promptId: payload.promptId,
    queueRecordId: payload.queueRecordId,
    useAbstract: payload.useAbstract,
    useFulltext: payload.useFulltext,
    useFulltextNoImages: payload.useFulltextNoImages,
    useTitle: payload.useTitle,
  }
}

const getPromptClaimIdentity = (prompt: PromptToProcess): CompletionClaimIdentity => {
  return {
    articleId: prompt.articleId,
    claimId: prompt.claimId,
    executionSnapshotHash: prompt.executionSnapshotHash,
    executionSnapshotId: prompt.executionSnapshotId,
    jobId: prompt.jobId,
    modelId: prompt.modelId,
    projectId: prompt.projectId,
    promptId: prompt.promptId,
    queueRecordId: prompt.recordId,
    useAbstract: prompt.useAbstract,
    useFulltext: prompt.useFulltext,
    useFulltextNoImages: prompt.useFulltextNoImages,
    useTitle: prompt.useTitle,
  }
}

const getLocalClaimIdentityMismatch = async (identity: CompletionClaimIdentity): Promise<string | null> => {
  const actual = await getJudgmentJobSqliteService().getPromptClaimIdentity(identity.jobId, identity.queueRecordId)

  return getClaimIdentityMismatch(identity, actual)
}

const getLocalStaleCompletionReplayReason = async (row: CompletionOutboxRow): Promise<string | null> => {
  if (!existsSync(getJudgmentJobSqlitePath(row.jobId))) {
    return null
  }

  return getLocalClaimIdentityMismatch(getCompletionClaimIdentity(getCompletionPayloadFromRow(row)))
}

const getCompletionPayloadFromRow = (row: CompletionOutboxRow) => {
  const payload = parseJson<JudgeWorkerCompletionPayload>(row.payloadJson)
  const tokenUse = row.tokenUseJson ? parseJson<JudgeWorkerTokenUseSummary>(row.tokenUseJson) : undefined
  const requestAttempts = parseRequestAttempts(row.requestAttemptsJson ?? payload.requestAttempts ?? null)
  const payloadWithAttempts = requestAttempts.length > 0 ? {...payload, requestAttempts} : payload
  const tokenUseWithAttempts =
    tokenUse && requestAttempts.length > 0 && !tokenUse.requestAttempts ? {...tokenUse, requestAttempts} : tokenUse

  return tokenUseWithAttempts ? {...payloadWithAttempts, tokenUse: tokenUseWithAttempts} : payloadWithAttempts
}

export const getAcceptedJudgeWorkerClaimPrompts = async ({
  excludedQueueRecordIds = new Set(),
  jobId,
  limit,
}: {
  excludedQueueRecordIds?: Set<string>
  jobId: string
  limit: number
}): Promise<PromptToProcess[]> => {
  const normalizedLimit = getNormalizedCompletionReplayLimit(limit) ?? 0

  if (normalizedLimit <= 0 || !existsSync(getJudgmentJobSqlitePath(jobId))) {
    return []
  }

  const database = openJournalDatabase()
  const rows = getAcceptedClaimPromptRows(database, jobId, normalizedLimit + excludedQueueRecordIds.size)
  const prompts = await Promise.all(
    rows.map(async (row) => {
      if (excludedQueueRecordIds.has(row.queueRecordId)) {
        return null
      }

      const prompt = parseJson<PromptToProcess>(row.payloadJson)
      const rowMismatch =
        prompt.claimId !== row.claimId
          ? 'accepted claim payload claimId mismatch'
          : prompt.jobId !== row.jobId
            ? 'accepted claim payload jobId mismatch'
            : prompt.recordId !== row.queueRecordId
              ? 'accepted claim payload queueRecordId mismatch'
              : null
      const localMismatch = rowMismatch ?? (await getLocalClaimIdentityMismatch(getPromptClaimIdentity(prompt)))

      if (localMismatch) {
        completionJournalLogger.warn(
          `judge-worker:accepted-claim-resume-stale:${row.jobId}`,
          '[judge-worker] accepted claim resume skipped stale local prompt',
          {claimId: row.claimId, jobId: row.jobId, reason: localMismatch, queueRecordId: row.queueRecordId},
        )
        return null
      }

      return prompt
    }),
  )

  return prompts.flatMap((prompt) => {
    return prompt ? [prompt] : []
  }).slice(0, normalizedLimit)
}

const getRunningJobFromAcceptedPrompt = (prompt: PromptToProcess): RunningJudgmentJob => {
  return {
    id: prompt.jobId,
    maxInflightRequests: prompt.maxInflightRequests ?? prompt.providerMaxInflightRequests ?? null,
    modelId: prompt.modelId,
    modelName: prompt.modelName,
    modelProvider: prompt.modelProvider,
    projectId: prompt.projectId,
    providerConnectionId: prompt.providerConnectionId,
    providerFamily: prompt.providerFamily,
    providerId: prompt.providerId,
    providerKey: prompt.providerKey,
    providerLimit: prompt.providerLimit,
    providerLimitVersion: prompt.providerLimitVersion,
    providerName: prompt.providerName,
    providerUsesFamilyDefault: prompt.providerUsesFamilyDefault,
    quarantineReason: null,
    resolvedDefaultCapacity: prompt.resolvedDefaultCapacity,
    storageState: 'active',
  }
}

export const getAcceptedJudgeWorkerClaimRunningJobs = (): RunningJudgmentJob[] => {
  const database = openJournalDatabase()
  const rows = database
    .query(
      `
        SELECT payload_json AS payloadJson
        FROM accepted_claim
        ORDER BY accepted_at DESC, claim_id DESC
      `,
    )
    .all() as Array<{payloadJson: string}>
  const jobById = rows.reduce((state, row) => {
    const prompt = parseJson<PromptToProcess>(row.payloadJson)

    return state.has(prompt.jobId) ? state : new Map(state).set(prompt.jobId, getRunningJobFromAcceptedPrompt(prompt))
  }, new Map<string, RunningJudgmentJob>())

  return Array.from(jobById.values())
}

const replayCompletionRows = async (rows: CompletionOutboxRow[]): Promise<CompletionReplayResult> => {
  const database = openJournalDatabase()
  const replayableRows = rows.filter(completionRowIsReplayable)

  return replayableRows.reduce<Promise<CompletionReplayResult>>(
    async (summaryPromise, row) => {
      const summary = await summaryPromise

      try {
        const localStaleReason = await getLocalStaleCompletionReplayReason(row)

        if (localStaleReason) {
          markCompletionDiscarded(database, row.claimId, new Error(localStaleReason))
          completionJournalLogger.warn(
            `judge-worker:completion-replay-discarded-local:${row.jobId}`,
            '[judge-worker] owner completion replay discarded locally as stale',
            {claimId: row.claimId, error: localStaleReason, jobId: row.jobId},
          )
          return {...summary, discardedCount: summary.discardedCount + 1}
        }

        await withOwnerBackedCompletionReplaySlot(() => {
          return sendCompletionToOwner(getCompletionPayloadFromRow(row))
        })
        markCompletionAcked(database, row.claimId)
        return {...summary, ackedCount: summary.ackedCount + 1}
      } catch (error) {
        if (isStaleCompletionReplayError(error)) {
          markCompletionDiscarded(database, row.claimId, error)
          completionJournalLogger.warn(
            `judge-worker:completion-replay-discarded:${row.jobId}`,
            '[judge-worker] owner completion replay discarded as stale',
            {claimId: row.claimId, error: error instanceof Error ? error.message : String(error), jobId: row.jobId},
          )
          return {...summary, discardedCount: summary.discardedCount + 1}
        }

        markCompletionAttemptFailed(database, row.claimId, error)
        completionJournalLogger.warn(
          `judge-worker:completion-replay-failed:${row.claimId}`,
          '[judge-worker] owner completion replay failed',
          {claimId: row.claimId, error: error instanceof Error ? error.message : String(error), jobId: row.jobId},
        )
        return {...summary, failedCount: summary.failedCount + 1}
      }
    },
    Promise.resolve({ackedCount: 0, discardedCount: 0, failedCount: 0}),
  )
}

const replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup = async ({
  limit,
}: CompletionReplayOptions = {}): Promise<CompletionReplayResult> => {
  const database = openJournalDatabase()
  reactivateAckedCompletionsWithPendingTokenUse(database)

  return replayCompletionRows(getCompletionReplayCandidateRows(database, undefined, limit))
}

export const replayJudgeWorkerCompletionOutbox = async (
  options: CompletionReplayOptions = {},
): Promise<CompletionReplayResult> => {
  const replay = await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup(options)
  deleteAcceptedClaimsWithOwnerAck(openJournalDatabase())

  return replay
}

export const runJudgeWorkerRolloutCleanup = async ({
  limit,
}: JudgeWorkerRolloutCleanupOptions = {}): Promise<JudgeWorkerRolloutCleanupResult> => {
  const firstReplay = await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup({limit})
  const database = openJournalDatabase()
  const closeoutIntentsInserted = recordRolloutCloseoutIntents(database)
  const secondReplay =
    closeoutIntentsInserted > 0
      ? await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup({limit})
      : {ackedCount: 0, discardedCount: 0, failedCount: 0}
  const acceptedClaimsDeleted = deleteAcceptedClaimsWithOwnerAck(database)

  return {
    acceptedClaimsDeleted,
    closeoutIntentsInserted,
    replay: {
      ackedCount: firstReplay.ackedCount + secondReplay.ackedCount,
      discardedCount: firstReplay.discardedCount + secondReplay.discardedCount,
      failedCount: firstReplay.failedCount + secondReplay.failedCount,
    },
  }
}

let judgeWorkerStartupRolloutCleanupPromise: Promise<JudgeWorkerRolloutCleanupResult> | null = null
const judgeWorkerStartupRolloutReplayLimit = 1

export const startJudgeWorkerStartupRolloutCleanup = (): Promise<JudgeWorkerRolloutCleanupResult> => {
  if (!judgeWorkerStartupRolloutCleanupPromise) {
    judgeWorkerStartupRolloutCleanupPromise = runJudgeWorkerRolloutCleanup({
      limit: judgeWorkerStartupRolloutReplayLimit,
    })
  }

  return judgeWorkerStartupRolloutCleanupPromise
}

export const waitForJudgeWorkerStartupRolloutCleanup = async (): Promise<void> => {
  if (judgeWorkerStartupRolloutCleanupPromise) {
    await judgeWorkerStartupRolloutCleanupPromise
  }
}

export const recoverAbandonedJudgeWorkerAcceptedClaims = async ({
  limit,
  protectedPrompts = [],
}: {
  limit?: number
  protectedPrompts?: AcceptedClaimProtectedPrompt[]
} = {}): Promise<JudgeWorkerRolloutCleanupResult> => {
  const firstReplay = await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup({limit})
  const database = openJournalDatabase()
  const closeoutIntentsInserted = recordRolloutCloseoutIntents(
    database,
    getProtectedAcceptedClaimPromptKeys(protectedPrompts),
  )
  const secondReplay =
    closeoutIntentsInserted > 0
      ? await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup({limit})
      : {ackedCount: 0, discardedCount: 0, failedCount: 0}
  const acceptedClaimsDeleted = deleteAcceptedClaimsWithOwnerAck(database)

  return {
    acceptedClaimsDeleted,
    closeoutIntentsInserted,
    replay: {
      ackedCount: firstReplay.ackedCount + secondReplay.ackedCount,
      discardedCount: firstReplay.discardedCount + secondReplay.discardedCount,
      failedCount: firstReplay.failedCount + secondReplay.failedCount,
    },
  }
}

export const flushJudgeWorkerCompletionOutboxForClaim = async (claimId: string): Promise<CompletionReplayResult> => {
  const replay = await replayCompletionRows(getUnackedCompletionRows(openJournalDatabase(), claimId))
  deleteAcceptedClaimsWithOwnerAck(openJournalDatabase())

  return replay
}

export const hasUnackedJudgeWorkerCompletion = async (claimId: string): Promise<boolean> => {
  return getUnackedCompletionRows(openJournalDatabase(), claimId).length > 0
}

const getPendingTokenUseIdentities = ({
  articleId,
  jobId,
  promptIds,
  requestAttempts,
}: {
  articleId: string
  jobId: string
  promptIds: string[]
  requestAttempts: JudgmentRequestAttemptJsonEntry[]
}): Array<{
  articleId: string
  claimId: string
  jobId: string
  promptId: string
  queueRecordId: string
  requestAttemptId: string
}> => {
  return requestAttempts.length > 0
    ? requestAttempts.map((attempt) => {
        const [fallbackPromptId = ''] = promptIds
        return {
          articleId: attempt.articleId ?? articleId,
          claimId: attempt.claimId ?? '',
          jobId: attempt.jobId ?? jobId,
          promptId: attempt.promptId ?? fallbackPromptId,
          queueRecordId: attempt.queueRecordId ?? attempt.promptId ?? fallbackPromptId,
          requestAttemptId: attempt.requestAttemptId,
        }
      })
    : promptIds.slice(0, 1).map((promptId) => {
        return {
          articleId,
          claimId: '',
          jobId,
          promptId,
          queueRecordId: promptId,
          requestAttemptId: `legacy:${jobId}:${articleId}:${promptId}`,
        }
      })
}

export const attachTokenUseToPendingJudgeWorkerCompletion = async ({
  articleId,
  jobId,
  promptIds,
  requestAttempts = [],
  tokenUse,
}: {
  articleId: string
  jobId: string
  promptIds: string[]
  requestAttempts?: JudgmentRequestAttemptJsonEntry[]
  tokenUse: JudgeWorkerTokenUseSummary
}): Promise<boolean> => {
  const database = openJournalDatabase()
  const requestAttemptsJson = stringifyRequestAttempts(requestAttempts)
  const lookupInput = {articleId, jobId, promptIds, requestAttempts}
  const row = getCompletionRowsByTokenUseIdentity(database, lookupInput, 'unacked')[0] ?? null
  const ackedSuccessRow = row
    ? null
    : getCompletionRowsByTokenUseIdentity(database, lookupInput, 'acked').find((completionRow) => {
        return completionRow.ackedAt !== null && completionStatusNeedsTokenUseBeforeReplay(completionRow.status)
      })
  const completionRow = row ?? ackedSuccessRow

  if (!completionRow) {
    const identities = getPendingTokenUseIdentities({articleId, jobId, promptIds, requestAttempts})

    if (identities.length === 0) {
      return false
    }

    const now = new Date().toISOString()
    const insert = database.query(
      `
        INSERT INTO pending_token_use (
          job_id,
          claim_id,
          queue_record_id,
          article_id,
          prompt_id,
          request_attempt_id,
          token_use_json,
          request_attempts_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, queue_record_id, request_attempt_id) DO UPDATE SET
          token_use_json = EXCLUDED.token_use_json,
          request_attempts_json = EXCLUDED.request_attempts_json,
          updated_at = EXCLUDED.updated_at
      `,
    )

    database.transaction((rows: ReturnType<typeof getPendingTokenUseIdentities>) => {
      return rows.reduce((count, identity) => {
        insert.run(
          identity.jobId,
          identity.claimId,
          identity.queueRecordId,
          identity.articleId,
          identity.promptId,
          identity.requestAttemptId,
          JSON.stringify(tokenUse),
          requestAttemptsJson,
          now,
          now,
        )
        return count + 1
      }, 0)
    })(identities)

    const [firstIdentity] = identities

    if (firstIdentity?.claimId) {
      compactAcceptedClaimManifestCloseoutFromDatabase({
        database,
        owner: {
          articleId: firstIdentity.articleId,
          claimId: firstIdentity.claimId,
          jobId: firstIdentity.jobId,
          kind: 'accepted_claim',
          promptId: firstIdentity.promptId,
          promptIds,
          queueRecordId: firstIdentity.queueRecordId,
        },
        requestAttempts,
      })
    }

    return true
  }

  database
    .query(
      `
        UPDATE completion_outbox
        SET token_use_json = ?,
            request_attempts_json = COALESCE(?, request_attempts_json),
            acked_at = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE claim_id = ?
      `,
    )
    .run(JSON.stringify(tokenUse), requestAttemptsJson, new Date().toISOString(), completionRow.claimId)

  const payload = parseJson<JudgeWorkerCompletionPayload>(completionRow.payloadJson)
  compactAcceptedClaimManifestCloseoutFromDatabase({
    database,
    owner: {
      articleId: payload.articleId,
      claimId: payload.claimId,
      jobId: payload.jobId,
      kind: 'accepted_claim',
      promptId: payload.promptId,
      promptIds,
      queueRecordId: payload.queueRecordId,
    },
    requestAttempts,
  })

  return true
}

export const resetJudgeWorkerCompletionJournalForTests = (): void => {
  if (journalDatabase) {
    journalDatabase.close(false)
    journalDatabase = null
  }
  ownerBackedCompletionReplayInFlight = 0
  ownerBackedCompletionReplayWaiters.splice(0, ownerBackedCompletionReplayWaiters.length)
}

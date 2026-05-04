import {mkdirSync} from 'node:fs'
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
  claimId: string
  jobId: string
  payloadJson: string
  queueRecordId: string
  status: string
  requestAttemptsJson: string | null
  tokenUseJson: string | null
  updatedAt: string
}

type CompletionReplayResult = {ackedCount: number; discardedCount: number; failedCount: number}
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
type AcceptedClaimRolloutRow = AcceptedClaimManifestRow & {
  claimId: string
  jobId: string
  payloadJson: string
  queueRecordId: string
}
type AcceptedClaimProtectedPrompt = {jobId: string; queueRecordId: string}
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
const ownerBackedRequestTimeoutMs = 30_000

let journalDatabase: Database | null = null

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
  `)

  ensureJournalSchema(database)
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
  const missingColumns = [{name: 'request_attempts_json', sql: 'TEXT'}].filter((column) => {
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

const requestOwnerJson = async <T>({
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
    signal: AbortSignal.timeout(ownerBackedRequestTimeoutMs),
  })
  const text = await response.text()
  const parsed = tryParseOwnerResponse<T>(text)
  const parsedError = parsed && 'error' in parsed ? parsed.error : undefined

  if (!response.ok || parsedError) {
    const responseError = getErrorMessageValue(parsedError) || text || response.statusText

    throw new OwnerBackedJudgmentRequestError({
      message: `owner-backed judgment request failed (${response.status}): ${responseError}`,
      responseText: text,
      status: response.status,
    })
  }

  if (!parsed) {
    throw new OwnerBackedJudgmentRequestError({
      message: `owner-backed judgment request returned invalid JSON (${response.status}): ${text}`,
      responseText: text,
      status: response.status,
    })
  }

  if (!('data' in parsed)) {
    throw new Error('owner-backed judgment request returned no data')
  }

  return parsed.data as T
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

const repairLegacyCompletionOutboxRows = (database: Database): void => {
  getCompletionRows(database).forEach((row) => {
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
          payload_json,
          request_attempts_json,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET
          request_attempts_json = COALESCE(completion_outbox.request_attempts_json, EXCLUDED.request_attempts_json),
          updated_at = EXCLUDED.updated_at
        WHERE completion_outbox.acked_at IS NULL
      `,
    )
    .run(
      payload.claimId,
      payload.jobId,
      payload.queueRecordId,
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
        WHERE claim_id IN (
          SELECT ac.claim_id
          FROM accepted_claim ac
          INNER JOIN completion_outbox co ON co.claim_id = ac.claim_id
          WHERE co.acked_at IS NOT NULL
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
            payload_json,
            token_use_json,
            request_attempts_json,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(claim_id) DO UPDATE SET
            job_id = EXCLUDED.job_id,
            queue_record_id = EXCLUDED.queue_record_id,
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

const getUnackedCompletionRows = (database: Database, claimId?: string): CompletionOutboxRow[] => {
  return database
    .query(
      `
        SELECT
          acked_at AS ackedAt,
          claim_id AS claimId,
          job_id AS jobId,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
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

const getCompletionRows = (database: Database): CompletionOutboxRow[] => {
  return database
    .query(
      `
        SELECT
          acked_at AS ackedAt,
          claim_id AS claimId,
          job_id AS jobId,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
          status,
          request_attempts_json AS requestAttemptsJson,
          token_use_json AS tokenUseJson,
          updated_at AS updatedAt
        FROM completion_outbox
        ORDER BY created_at DESC, claim_id DESC
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

const reactivateAckedCompletionsWithPendingTokenUse = (database: Database): number => {
  const pendingRows = getPendingTokenUseRows(database)
  const completionRows = getCompletionRows(database)

  return database.transaction((rows: PendingTokenUseRow[]) => {
    return rows.reduce((count, pending) => {
      const completionRow = completionRows.find((row) => {
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

const getCompletionPayloadFromRow = (row: CompletionOutboxRow) => {
  const payload = parseJson<JudgeWorkerCompletionPayload>(row.payloadJson)
  const tokenUse = row.tokenUseJson ? parseJson<JudgeWorkerTokenUseSummary>(row.tokenUseJson) : undefined
  const requestAttempts = parseRequestAttempts(row.requestAttemptsJson ?? payload.requestAttempts ?? null)
  const payloadWithAttempts = requestAttempts.length > 0 ? {...payload, requestAttempts} : payload
  const tokenUseWithAttempts =
    tokenUse && requestAttempts.length > 0 && !tokenUse.requestAttempts ? {...tokenUse, requestAttempts} : tokenUse

  return tokenUseWithAttempts ? {...payloadWithAttempts, tokenUse: tokenUseWithAttempts} : payloadWithAttempts
}

const replayCompletionRows = async (rows: CompletionOutboxRow[]): Promise<CompletionReplayResult> => {
  const database = openJournalDatabase()
  const replayableRows = rows.filter(completionRowIsReplayable)

  return replayableRows.reduce<Promise<CompletionReplayResult>>(
    async (summaryPromise, row) => {
      const summary = await summaryPromise

      try {
        await sendCompletionToOwner(getCompletionPayloadFromRow(row))
        markCompletionAcked(database, row.claimId)
        return {...summary, ackedCount: summary.ackedCount + 1}
      } catch (error) {
        if (isStaleCompletionReplayError(error)) {
          markCompletionDiscarded(database, row.claimId, error)
          completionJournalLogger.warn(
            `judge-worker:completion-replay-discarded:${row.claimId}`,
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

const replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup = async (): Promise<CompletionReplayResult> => {
  const database = openJournalDatabase()
  reactivateAckedCompletionsWithPendingTokenUse(database)

  return replayCompletionRows(getUnackedCompletionRows(database))
}

export const replayJudgeWorkerCompletionOutbox = async (): Promise<CompletionReplayResult> => {
  const replay = await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup()
  deleteAcceptedClaimsWithOwnerAck(openJournalDatabase())

  return replay
}

export const runJudgeWorkerRolloutCleanup = async (): Promise<JudgeWorkerRolloutCleanupResult> => {
  const firstReplay = await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup()
  const database = openJournalDatabase()
  const closeoutIntentsInserted = recordRolloutCloseoutIntents(database)
  const secondReplay =
    closeoutIntentsInserted > 0
      ? await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup()
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

export const recoverAbandonedJudgeWorkerAcceptedClaims = async ({
  protectedPrompts = [],
}: {protectedPrompts?: AcceptedClaimProtectedPrompt[]} = {}): Promise<JudgeWorkerRolloutCleanupResult> => {
  const firstReplay = await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup()
  const database = openJournalDatabase()
  const closeoutIntentsInserted = recordRolloutCloseoutIntents(
    database,
    getProtectedAcceptedClaimPromptKeys(protectedPrompts),
  )
  const secondReplay =
    closeoutIntentsInserted > 0
      ? await replayJudgeWorkerCompletionOutboxWithoutAcceptedClaimCleanup()
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
  const row = getUnackedCompletionRows(database).find((completionRow) => {
    const payload = parseJson<JudgeWorkerCompletionPayload>(completionRow.payloadJson)

    return payload.jobId === jobId && payload.articleId === articleId && promptIds.includes(payload.promptId)
  })
  const ackedSuccessRow = row
    ? null
    : getCompletionRows(database).find((completionRow) => {
        const payload = parseJson<JudgeWorkerCompletionPayload>(completionRow.payloadJson)

        return (
          completionRow.ackedAt !== null
          && completionStatusNeedsTokenUseBeforeReplay(completionRow.status)
          && payload.jobId === jobId
          && payload.articleId === articleId
          && promptIds.includes(payload.promptId)
        )
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
}

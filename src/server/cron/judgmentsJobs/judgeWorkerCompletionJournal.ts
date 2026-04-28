import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'

import {Database} from 'bun:sqlite'

import {duckdbOwnerPrivateApiPrefix} from '../../routes/apiRouteClassification.ts'
import type {JudgmentExecutionSnapshotRecord} from '../../services/judgmentExecutionSnapshotService.ts'
import {getEnv} from '../../utils/env.ts'
import {getCurrentJudgeWorkerJournalIdentity} from '../../utils/judgeWorkerJournalIdentity.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import type {RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'
import type {PromptToProcess} from './judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'

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
  retryAfterMs?: number | null
  skipReason?: 'conversion_failed' | 'fulltext_too_large' | 'no_fulltext'
  status?: 'completed' | 'failed' | 'judged' | 'retry' | 'skipped' | 'succeeded'
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type OwnerBackedJudgmentJobInfo = {
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

type CompletionOutboxRow = {
  claimId: string
  jobId: string
  payloadJson: string
  queueRecordId: string
  tokenUseJson: string | null
}

type CompletionReplayResult = {ackedCount: number; discardedCount: number; failedCount: number}
type CompletionSendResult = {claimId: string; queueRecordId: string; status: string}
type PendingTokenUseRow = {tokenUseJson: string}

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

let journalDatabase: Database | null = null

export const shouldUseJudgeWorkerOwnerHandoff = (): boolean => {
  const configuredRole = String(process.env.SERVER_ROLE ?? '').trim()

  return configuredRole === 'judge-worker'
}

const parseJson = <T>(value: string): T => {
  return JSON.parse(value) as T
}

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
      accepted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS completion_outbox (
      claim_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      queue_record_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      token_use_json TEXT,
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
      article_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      token_use_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, article_id, prompt_id)
    );

    CREATE INDEX IF NOT EXISTS idx_completion_outbox_unacked
      ON completion_outbox(acked_at, created_at);
  `)

  journalDatabase = database
  return database
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
      accepted_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(claim_id) DO UPDATE SET
      payload_json = EXCLUDED.payload_json,
      updated_at = EXCLUDED.updated_at
  `)
  const now = new Date().toISOString()

  database.transaction((entries: PromptToProcess[]) => {
    return entries.reduce((count, claim) => {
      insert.run(claim.claimId, claim.jobId, claim.recordId, JSON.stringify(claim), now, now)
      return count + 1
    }, 0)
  })(claims)
}

const getPendingTokenUseJson = (database: Database, payload: JudgeWorkerCompletionPayload): string | null => {
  const row = database
    .query(
      `
        SELECT token_use_json AS tokenUseJson
        FROM pending_token_use
        WHERE job_id = ?
          AND article_id = ?
          AND prompt_id = ?
        LIMIT 1
      `,
    )
    .get(payload.jobId, payload.articleId, payload.promptId) as PendingTokenUseRow | null

  return row?.tokenUseJson ?? null
}

const deletePendingTokenUse = (database: Database, payload: JudgeWorkerCompletionPayload): void => {
  database
    .query(
      `
        DELETE FROM pending_token_use
        WHERE job_id = ?
          AND article_id = ?
          AND prompt_id = ?
      `,
    )
    .run(payload.jobId, payload.articleId, payload.promptId)
}

export const enqueueJudgeWorkerCompletion = async (payload: JudgeWorkerCompletionPayload): Promise<void> => {
  const database = openJournalDatabase()
  const now = new Date().toISOString()
  const status = payload.status ?? 'judged'
  const pendingTokenUseJson = getPendingTokenUseJson(database, payload)

  database.transaction(() => {
    database
      .query(
        `
          INSERT INTO completion_outbox (
            claim_id,
            job_id,
            queue_record_id,
            payload_json,
            token_use_json,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(claim_id) DO UPDATE SET
            job_id = EXCLUDED.job_id,
            queue_record_id = EXCLUDED.queue_record_id,
            payload_json = EXCLUDED.payload_json,
            token_use_json = COALESCE(completion_outbox.token_use_json, EXCLUDED.token_use_json),
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
        pendingTokenUseJson,
        status,
        now,
        now,
      )
    deletePendingTokenUse(database, payload)
  })()
}

const getUnackedCompletionRows = (database: Database, claimId?: string): CompletionOutboxRow[] => {
  return database
    .query(
      `
        SELECT
          claim_id AS claimId,
          job_id AS jobId,
          queue_record_id AS queueRecordId,
          payload_json AS payloadJson,
          token_use_json AS tokenUseJson
        FROM completion_outbox
        WHERE acked_at IS NULL
          ${claimId ? 'AND claim_id = ?' : ''}
        ORDER BY created_at ASC, claim_id ASC
      `,
    )
    .all(...(claimId ? [claimId] : [])) as CompletionOutboxRow[]
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
    && normalized.includes('missing claimed prompt identity')
  )
}

const getCompletionPayloadFromRow = (row: CompletionOutboxRow) => {
  const payload = parseJson<JudgeWorkerCompletionPayload>(row.payloadJson)
  const tokenUse = row.tokenUseJson ? parseJson<JudgeWorkerTokenUseSummary>(row.tokenUseJson) : undefined

  return tokenUse ? {...payload, tokenUse} : payload
}

const replayCompletionRows = async (rows: CompletionOutboxRow[]): Promise<CompletionReplayResult> => {
  const database = openJournalDatabase()

  return rows.reduce<Promise<CompletionReplayResult>>(
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

export const replayJudgeWorkerCompletionOutbox = async (): Promise<CompletionReplayResult> => {
  return replayCompletionRows(getUnackedCompletionRows(openJournalDatabase()))
}

export const flushJudgeWorkerCompletionOutboxForClaim = async (claimId: string): Promise<CompletionReplayResult> => {
  return replayCompletionRows(getUnackedCompletionRows(openJournalDatabase(), claimId))
}

export const hasUnackedJudgeWorkerCompletion = async (claimId: string): Promise<boolean> => {
  return getUnackedCompletionRows(openJournalDatabase(), claimId).length > 0
}

export const attachTokenUseToPendingJudgeWorkerCompletion = async ({
  articleId,
  jobId,
  promptIds,
  tokenUse,
}: {
  articleId: string
  jobId: string
  promptIds: string[]
  tokenUse: JudgeWorkerTokenUseSummary
}): Promise<boolean> => {
  const database = openJournalDatabase()
  const row = getUnackedCompletionRows(database).find((completionRow) => {
    const payload = parseJson<JudgeWorkerCompletionPayload>(completionRow.payloadJson)

    return payload.jobId === jobId && payload.articleId === articleId && promptIds.includes(payload.promptId)
  })

  if (!row) {
    const [promptId] = promptIds

    if (!promptId) {
      return false
    }

    const now = new Date().toISOString()
    database
      .query(
        `
          INSERT INTO pending_token_use (
            job_id,
            article_id,
            prompt_id,
            token_use_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id, article_id, prompt_id) DO UPDATE SET
            token_use_json = EXCLUDED.token_use_json,
            updated_at = EXCLUDED.updated_at
        `,
      )
      .run(jobId, articleId, promptId, JSON.stringify(tokenUse), now, now)

    return true
  }

  database
    .query(
      `
        UPDATE completion_outbox
        SET token_use_json = ?,
            updated_at = ?
        WHERE claim_id = ?
          AND acked_at IS NULL
      `,
    )
    .run(JSON.stringify(tokenUse), new Date().toISOString(), row.claimId)

  return true
}

export const resetJudgeWorkerCompletionJournalForTests = (): void => {
  if (journalDatabase) {
    journalDatabase.close(false)
    journalDatabase = null
  }
}

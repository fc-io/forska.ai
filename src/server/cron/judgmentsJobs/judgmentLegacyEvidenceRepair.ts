import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {projectRequestAttemptCloseoutsForTokenUse} from '../../services/requestAttemptCloseoutService.ts'
import {
  type JudgmentRequestAttemptCloseoutKind,
  type JudgmentRequestAttemptCloseoutTimestampValue,
  type JudgmentRequestAttemptDurableCloseoutRef,
  type JudgmentRequestAttemptJsonEntry,
  stringifyRequestAttempts,
  withDurableCloseoutRef,
} from './judgmentRequestAttemptManifest.ts'

export const legacyCompletionEvidencePendingRepairReason = 'legacyCompletionEvidencePendingRepair'
export const legacyCompletionEvidenceQuarantinedReason = 'legacyCompletionEvidenceQuarantined'
export const legacyRolloutImportedCloseoutReason = 'legacyRolloutImported'

export type LegacyCompletionEvidenceSurface =
  | 'completion_ack'
  | 'completion_outbox'
  | 'judgment_outbox'
  | 'pending_token_use'
  | 'token_use'

export type LegacyDurableRowRef = {
  surface: LegacyCompletionEvidenceSurface
  claimId?: string | null
  id?: string | null
  jobId?: string | null
  outboxSeq?: number | null
  queueRecordId?: string | null
  requestAttemptId?: string | null
}

export type LegacyEvidenceRepairResult = {convertedCount: number; pendingRepairCount: number; quarantinedCount: number}

type LegacyRequestAttemptJsonEntry = JudgmentRequestAttemptJsonEntry & {
  legacyDurableRowRef: LegacyDurableRowRef
  legacyRequestAttemptId: string
}

type RequestAttemptRepairState =
  | {kind: 'exact'; entries: JudgmentRequestAttemptJsonEntry[]}
  | {kind: 'legacy'; entries: Record<string, unknown>[]}
  | {kind: 'quarantined'; reason: string}

type LegacyRequestAttemptInput = {
  closeoutKind: JudgmentRequestAttemptCloseoutKind
  durableRef: Omit<JudgmentRequestAttemptDurableCloseoutRef, 'kind' | 'requestAttemptId'>
  durableRowRef: LegacyDurableRowRef
  existingEntries?: Record<string, unknown>[]
  fallback: {
    articleId?: string | null
    claimId?: string | null
    completionTokens?: number | null
    createdAt?: string | null
    error?: string | null
    errorCode?: string | null
    finishedAt?: string | null
    jobId?: string | null
    outcome?: JudgmentRequestAttemptJsonEntry['outcome']
    promptId?: string | null
    promptIds?: string[]
    promptTokens?: number | null
    providerKey?: string | null
    queueRecordId?: string | null
    startedAt?: string | null
    totalTokens?: number | null
  }
}

type LegacyTokenUseRow = {
  createdAt: unknown
  failedRequests: number | null
  finishedAt: unknown
  id: string
  judgmentJobId: string
  requestAttemptsJson: unknown
  startedAt: unknown
  successfulRequests: number | null
  totalCompletionTokens: number
  totalPromptTokens: number
  totalTokens: number
}

type LegacyTokenUseRepairRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type LegacyTokenUseCloseoutProjectionRow = {
  createdAt: JudgmentRequestAttemptCloseoutTimestampValue
  finishedAt: JudgmentRequestAttemptCloseoutTimestampValue
  id: string
  requestAttemptsJson: unknown
  startedAt: JudgmentRequestAttemptCloseoutTimestampValue
}

const emptyLegacyEvidenceRepairResult = (): LegacyEvidenceRepairResult => {
  return {convertedCount: 0, pendingRepairCount: 0, quarantinedCount: 0}
}

export const addLegacyEvidenceRepairResults = (
  left: LegacyEvidenceRepairResult,
  right: LegacyEvidenceRepairResult,
): LegacyEvidenceRepairResult => {
  return {
    convertedCount: left.convertedCount + right.convertedCount,
    pendingRepairCount: left.pendingRepairCount + right.pendingRepairCount,
    quarantinedCount: left.quarantinedCount + right.quarantinedCount,
  }
}

const getStableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(getStableJsonValue)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((record, key) => {
        return {...record, [key]: getStableJsonValue((value as Record<string, unknown>)[key])}
      }, {})
  }

  return value
}

export const getLegacyRequestAttemptId = (durableRowRef: LegacyDurableRowRef): string => {
  const stableJson = JSON.stringify(getStableJsonValue(durableRowRef))
  const digest = createHash('sha256').update(stableJson).digest('hex').slice(0, 32)

  return `legacyRequestAttemptId:${durableRowRef.surface}:${digest}`
}

const getParsedRequestAttempts = (value: unknown): {parsed: unknown; validJson: boolean} => {
  if (value === null || value === undefined || value === '' || value === 'null') {
    return {parsed: [], validJson: true}
  }

  const jsonValue = getJsonValue(value)

  if (jsonValue !== null) {
    return {parsed: jsonValue, validJson: true}
  }

  return {parsed: null, validJson: false}
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const hasExactRequestAttemptId = (entry: Record<string, unknown>): boolean => {
  return typeof entry.requestAttemptId === 'string' && entry.requestAttemptId.trim().length > 0
}

export const getRequestAttemptRepairState = (value: unknown): RequestAttemptRepairState => {
  const {parsed, validJson} = getParsedRequestAttempts(value)

  if (!validJson) {
    return {kind: 'quarantined', reason: 'invalid request_attempts_json'}
  }

  if (!Array.isArray(parsed)) {
    return {kind: 'quarantined', reason: 'request_attempts_json is not an array'}
  }

  if (parsed.length === 0) {
    return {kind: 'legacy', entries: []}
  }

  const entries = parsed.filter(isRecord)

  if (entries.length !== parsed.length) {
    return {kind: 'quarantined', reason: 'request_attempts_json has non-object entries'}
  }

  return entries.every(hasExactRequestAttemptId)
    ? {kind: 'exact', entries: entries as JudgmentRequestAttemptJsonEntry[]}
    : {kind: 'legacy', entries}
}

export const requestAttemptsNeedLegacyRepair = (value: unknown): boolean => {
  return getRequestAttemptRepairState(value).kind !== 'exact'
}

const getStringValue = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getNumberValue = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getOutcomeValue = (value: unknown, fallback: JudgmentRequestAttemptJsonEntry['outcome']) => {
  return value === 'failure' || value === 'success' || value === 'unknown' ? value : fallback
}

const getPromptIdsValue = (value: unknown, fallback?: string[]): string[] | undefined => {
  if (!Array.isArray(value)) {
    return fallback
  }

  const promptIds = value.filter((entry): entry is string => {
    return typeof entry === 'string' && entry.trim().length > 0
  })

  return promptIds.length > 0 ? promptIds : fallback
}

const getLegacyRequestAttemptEntry = ({
  closeoutKind,
  durableRowRef,
  existingEntry,
  fallback,
  index,
}: LegacyRequestAttemptInput & {
  existingEntry: Record<string, unknown>
  index: number
}): LegacyRequestAttemptJsonEntry => {
  const indexedDurableRowRef = {...durableRowRef, requestAttemptId: getStringValue(existingEntry.requestAttemptId)}
  const legacyRequestAttemptId = getLegacyRequestAttemptId(
    index === 0 ? indexedDurableRowRef : {...indexedDurableRowRef, id: `${indexedDurableRowRef.id ?? ''}#${index}`},
  )

  return {
    articleId: getStringValue(existingEntry.articleId) ?? fallback.articleId ?? null,
    claimId: getStringValue(existingEntry.claimId) ?? fallback.claimId ?? null,
    closeoutKind,
    closeoutReason: legacyRolloutImportedCloseoutReason,
    completionTokens: getNumberValue(existingEntry.completionTokens) ?? fallback.completionTokens ?? null,
    createdAt: getStringValue(existingEntry.createdAt) ?? fallback.createdAt ?? null,
    durableCloseoutRef: null,
    error: getStringValue(existingEntry.error) ?? fallback.error ?? null,
    errorCode: getStringValue(existingEntry.errorCode) ?? fallback.errorCode ?? null,
    finishedAt: getStringValue(existingEntry.finishedAt) ?? fallback.finishedAt ?? fallback.createdAt ?? null,
    jobId: getStringValue(existingEntry.jobId) ?? fallback.jobId ?? null,
    legacyDurableRowRef: indexedDurableRowRef,
    legacyRequestAttemptId,
    outcome: getOutcomeValue(existingEntry.outcome, fallback.outcome ?? 'unknown'),
    promptId: getStringValue(existingEntry.promptId) ?? fallback.promptId ?? null,
    promptIds: getPromptIdsValue(existingEntry.promptIds, fallback.promptIds),
    promptTokens: getNumberValue(existingEntry.promptTokens) ?? fallback.promptTokens ?? null,
    providerDiagnostics: existingEntry.providerDiagnostics ?? null,
    providerKey: getStringValue(existingEntry.providerKey) ?? fallback.providerKey ?? 'legacy:unknown',
    queueRecordId: getStringValue(existingEntry.queueRecordId) ?? fallback.queueRecordId ?? null,
    requestAttemptId: getStringValue(existingEntry.requestAttemptId) ?? legacyRequestAttemptId,
    startedAt: getStringValue(existingEntry.startedAt) ?? fallback.startedAt ?? fallback.createdAt ?? null,
    totalTokens: getNumberValue(existingEntry.totalTokens) ?? fallback.totalTokens ?? null,
    updatedAt: fallback.finishedAt ?? fallback.createdAt ?? null,
  }
}

export const getLegacyRequestAttempts = (input: LegacyRequestAttemptInput): JudgmentRequestAttemptJsonEntry[] => {
  const existingEntries = input.existingEntries && input.existingEntries.length > 0 ? input.existingEntries : [{}]
  const requestAttempts = existingEntries.map((existingEntry, index) => {
    return getLegacyRequestAttemptEntry({...input, existingEntry, index})
  })

  return withDurableCloseoutRef({closeoutKind: input.closeoutKind, ref: input.durableRef, requestAttempts})
}

export const getLegacyRequestAttemptsJson = (input: LegacyRequestAttemptInput): string | null => {
  return stringifyRequestAttempts(getLegacyRequestAttempts(input))
}

export const getLegacyRepairReason = (result: LegacyEvidenceRepairResult): string | null => {
  return result.quarantinedCount > 0
    ? legacyCompletionEvidenceQuarantinedReason
    : result.pendingRepairCount > 0
      ? legacyCompletionEvidencePendingRepairReason
      : null
}

export const recordLegacyCompletionEvidenceRepairState = async ({
  jobId,
  reason,
}: {
  jobId: string
  reason: string
}): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = CASE WHEN status = 'running' THEN 'paused' ELSE status END,
        storage_state = 'draining',
        pause_requested_at = current_timestamp,
        last_import_error_at = current_timestamp,
        last_import_error = ${getSqlLiteral(reason)},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
      AND storage_state IN ('active', 'draining')
  `)
}

export const clearLegacyCompletionEvidenceRepairState = async (jobId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET last_import_error_at = CASE
          WHEN last_import_error IN (
            ${getSqlLiteral(legacyCompletionEvidencePendingRepairReason)},
            ${getSqlLiteral(legacyCompletionEvidenceQuarantinedReason)}
          ) THEN NULL
          ELSE last_import_error_at
        END,
        last_import_error = CASE
          WHEN last_import_error IN (
            ${getSqlLiteral(legacyCompletionEvidencePendingRepairReason)},
            ${getSqlLiteral(legacyCompletionEvidenceQuarantinedReason)}
          ) THEN NULL
          ELSE last_import_error
        END,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

const getDateString = (value: unknown): string | null => {
  if (value instanceof Date) {
    return value.toISOString()
  }

  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getTokenUseOutcome = (row: LegacyTokenUseRow): JudgmentRequestAttemptJsonEntry['outcome'] => {
  return Number(row.successfulRequests ?? 0) > 0
    ? 'success'
    : Number(row.failedRequests ?? 0) > 0
      ? 'failure'
      : 'unknown'
}

const getLegacyTokenUseRequestAttemptsJson = (row: LegacyTokenUseRow): string | null => {
  const state = getRequestAttemptRepairState(row.requestAttemptsJson)

  return state.kind === 'exact'
    ? null
    : state.kind === 'legacy'
      ? getLegacyRequestAttemptsJson({
          closeoutKind: 'token_use',
          durableRef: {id: row.id, jobId: row.judgmentJobId},
          durableRowRef: {id: row.id, jobId: row.judgmentJobId, surface: 'token_use'},
          existingEntries: state.entries,
          fallback: {
            completionTokens: Number(row.totalCompletionTokens ?? 0),
            createdAt: getDateString(row.createdAt),
            finishedAt: getDateString(row.finishedAt) ?? getDateString(row.createdAt),
            jobId: row.judgmentJobId,
            outcome: getTokenUseOutcome(row),
            promptTokens: Number(row.totalPromptTokens ?? 0),
            providerKey: 'legacy:unknown',
            startedAt: getDateString(row.startedAt) ?? getDateString(row.createdAt),
            totalTokens: Number(row.totalTokens ?? 0),
          },
        })
      : null
}

const legacyTokenUseCloseoutProjectionReturningSql = `
  id,
  TO_JSON(request_attempts_json) AS requestAttemptsJson,
  started_at AS startedAt,
  finished_at AS finishedAt,
  created_at AS createdAt
`

const updateLegacyTokenUseRequestAttemptsJson = async ({
  requestAttemptsJson,
  row,
  runner,
}: {
  requestAttemptsJson: string
  row: LegacyTokenUseRow
  runner: LegacyTokenUseRepairRunner
}): Promise<LegacyTokenUseCloseoutProjectionRow | null> => {
  const [updatedRow] = await runner.queryJson<LegacyTokenUseCloseoutProjectionRow>(`
    UPDATE app.token_use
    SET request_attempts_json = CAST(${getSqlLiteral(requestAttemptsJson)} AS JSON),
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(row.id)}
    RETURNING ${legacyTokenUseCloseoutProjectionReturningSql}
  `)

  return updatedRow ?? null
}

const projectLegacyTokenUseCloseoutProjection = async ({
  runner,
  tokenUse,
}: {
  runner: LegacyTokenUseRepairRunner
  tokenUse: LegacyTokenUseCloseoutProjectionRow
}): Promise<void> => {
  await projectRequestAttemptCloseoutsForTokenUse({
    runner,
    tokenUse: {
      requestAttemptsJson: tokenUse.requestAttemptsJson,
      tokenUseCreatedAt: tokenUse.createdAt,
      tokenUseFinishedAt: tokenUse.finishedAt,
      tokenUseId: tokenUse.id,
      tokenUseStartedAt: tokenUse.startedAt,
    },
  })
}

const repairLegacyTokenUseRow = async (row: LegacyTokenUseRow): Promise<LegacyEvidenceRepairResult> => {
  const state = getRequestAttemptRepairState(row.requestAttemptsJson)
  const requestAttemptsJson = getLegacyTokenUseRequestAttemptsJson(row)

  if (state.kind === 'exact') {
    return emptyLegacyEvidenceRepairResult()
  }

  if (state.kind === 'quarantined' || requestAttemptsJson === null) {
    return {convertedCount: 0, pendingRepairCount: 0, quarantinedCount: 1}
  }

  return getAppDatabaseService().transaction(async (tx) => {
    const updatedRow = await updateLegacyTokenUseRequestAttemptsJson({requestAttemptsJson, row, runner: tx})

    if (!updatedRow) {
      return emptyLegacyEvidenceRepairResult()
    }

    await projectLegacyTokenUseCloseoutProjection({runner: tx, tokenUse: updatedRow})

    return {convertedCount: 1, pendingRepairCount: 0, quarantinedCount: 0}
  }) as Promise<LegacyEvidenceRepairResult>
}

export const repairLegacyTokenUseEvidenceForJob = async (jobId: string): Promise<LegacyEvidenceRepairResult> => {
  const rows = await getAppDatabaseService().queryJson<LegacyTokenUseRow>(`
    SELECT
      id,
      judgment_job_id AS judgmentJobId,
      request_attempts_json AS requestAttemptsJson,
      started_at AS startedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      successful_requests AS successfulRequests,
      failed_requests AS failedRequests,
      CAST(total_prompt_tokens AS DOUBLE) AS totalPromptTokens,
      CAST(total_completion_tokens AS DOUBLE) AS totalCompletionTokens,
      CAST(total_tokens AS DOUBLE) AS totalTokens
    FROM app.token_use
    WHERE judgment_job_id = ${getSqlLiteral(jobId)}
    ORDER BY created_at ASC, id ASC
  `)

  const result = await rows.reduce<Promise<LegacyEvidenceRepairResult>>(async (resultPromise, row) => {
    return addLegacyEvidenceRepairResults(await resultPromise, await repairLegacyTokenUseRow(row))
  }, Promise.resolve(emptyLegacyEvidenceRepairResult()))
  const reason = getLegacyRepairReason(result)

  if (reason) {
    await recordLegacyCompletionEvidenceRepairState({jobId, reason})
    return result
  }

  if (result.convertedCount > 0) {
    await clearLegacyCompletionEvidenceRepairState(jobId)
  }

  return result
}

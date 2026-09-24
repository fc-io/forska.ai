import {getTokenUseQueryService} from '../../services/tokenUseQueryService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import {
  type JudgmentRequestAttemptJsonEntry,
  stringifyRequestAttempts,
  withDurableCloseoutRef,
} from './judgmentRequestAttemptManifest.ts'

export type JudgmentCompletionTokenUseSummary = {
  dpSize?: number | null
  duration?: number | null
  failedRequests: number
  failedRequestsDetails: unknown[]
  finishedAt?: string | null
  gpuGpusPerNode?: number | null
  gpuNnodes?: number | null
  gpuShape?: string | null
  gpuTotalGpus?: number | null
  hasFailedRequests: boolean
  modelName: string | null
  sglangMaxRunningRequests?: number | null
  startedAt?: string | null
  successfulRequests: number
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

export type JudgmentCompletionTokenUseInput = {
  claimId: string
  jobId: string
  queueRecordId: string
  requestAttempts?: JudgmentRequestAttemptJsonEntry[] | null
  tokenUse?: JudgmentCompletionTokenUseSummary | null
}

const completionTokenUseOutboxDrainLimit = 500
const completionTokenUseLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})

export const getCompletionTokenUseId = (input: {claimId: string}) => {
  return `judgment-completion-token-use:${input.claimId}`
}

export const getCompletionTokenUseIdOrNull = (input: JudgmentCompletionTokenUseInput): string | null => {
  return input.tokenUse && input.tokenUse.totalRequests > 0 ? getCompletionTokenUseId(input) : null
}

const getCompletionTokenUseInsertValues = (
  input: JudgmentCompletionTokenUseInput,
  tokenUse: JudgmentCompletionTokenUseSummary,
): Record<string, unknown> => {
  const tokenUseId = getCompletionTokenUseId(input)

  return {
    id: tokenUseId,
    judgment_job_id: input.jobId,
    gpu_nnodes: tokenUse.gpuNnodes ?? null,
    gpu_gpus_per_node: tokenUse.gpuGpusPerNode ?? null,
    gpu_total_gpus: tokenUse.gpuTotalGpus ?? null,
    tp_size: tokenUse.tpSize ?? null,
    dp_size: tokenUse.dpSize ?? null,
    gpu_shape: tokenUse.gpuShape ?? null,
    sglang_max_running_requests: tokenUse.sglangMaxRunningRequests ?? null,
    sglang_model: tokenUse.modelName,
    requests: tokenUse.totalRequests,
    total_prompt_tokens: tokenUse.totalPromptTokens,
    total_completion_tokens: tokenUse.totalCompletionTokens,
    total_tokens: tokenUse.totalTokens,
    successful_requests: tokenUse.successfulRequests,
    failed_requests: tokenUse.failedRequests,
    has_failed_requests: tokenUse.hasFailedRequests,
    failed_requests_details: tokenUse.failedRequestsDetails.length > 0 ? tokenUse.failedRequestsDetails : null,
    total_success_prompt_tokens: tokenUse.totalSuccessPromptTokens,
    total_success_completion_tokens: tokenUse.totalSuccessCompletionTokens,
    total_success_tokens: tokenUse.totalSuccessTokens,
    total_failed_prompt_tokens: tokenUse.totalFailedPromptTokens,
    total_failed_completion_tokens: tokenUse.totalFailedCompletionTokens,
    total_failed_tokens: tokenUse.totalFailedTokens,
    request_attempts_json: stringifyRequestAttempts(
      withDurableCloseoutRef({
        closeoutKind: 'token_use',
        ref: {claimId: input.claimId, id: tokenUseId, jobId: input.jobId, queueRecordId: input.queueRecordId},
        requestAttempts: tokenUse.requestAttempts ?? input.requestAttempts ?? [],
      }),
    ),
    started_at: tokenUse.startedAt ? new Date(tokenUse.startedAt) : null,
    finished_at: tokenUse.finishedAt ? new Date(tokenUse.finishedAt) : null,
    duration: tokenUse.duration == null ? null : Math.round(tokenUse.duration),
  }
}

// Records accepted completion token use in the job SQLite store. The background import writes it
// to DuckDB, so the completion ack only waits on SQLite.
export const enqueueCompletionTokenUse = async (input: JudgmentCompletionTokenUseInput): Promise<string | null> => {
  const tokenUseId = getCompletionTokenUseIdOrNull(input)

  if (!tokenUseId) {
    return null
  }

  await getJudgmentJobSqliteService().enqueueCompletionTokenUse({
    completionJson: JSON.stringify({
      claimId: input.claimId,
      jobId: input.jobId,
      queueRecordId: input.queueRecordId,
      requestAttempts: input.requestAttempts ?? null,
      tokenUse: input.tokenUse,
    } satisfies JudgmentCompletionTokenUseInput),
    jobId: input.jobId,
    tokenUseId,
  })

  return tokenUseId
}

export const drainCompletionTokenUseOutbox = async (jobId: string): Promise<number> => {
  const sqliteService = getJudgmentJobSqliteService()
  const rows = await sqliteService.getPendingCompletionTokenUse(jobId, completionTokenUseOutboxDrainLimit)
  const inputs = rows.flatMap((row) => {
    const input = JSON.parse(row.completionJson) as JudgmentCompletionTokenUseInput

    return input.tokenUse ? [getCompletionTokenUseInsertValues(input, input.tokenUse)] : []
  })

  if (rows.length === 0) {
    return 0
  }

  const {conflicts} = await getTokenUseQueryService().insertTokenUsesOnce(inputs)

  conflicts.forEach((conflict) => {
    completionTokenUseLogger.warn(
      `judgmentsJobs:completion-token-use-conflict:${jobId}`,
      '[judgmentsJobs] completion token use replay conflict ignored after accepted completion',
      {jobId, mismatch: conflict.mismatch, tokenUseId: conflict.id},
    )
  })
  await sqliteService.deleteCompletionTokenUse(
    jobId,
    rows.map((row) => {
      return row.tokenUseId
    }),
  )

  return rows.length
}

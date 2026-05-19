import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'
import {deleteJudgmentProviderTelemetryHistoryForJob} from './judgmentProviderTelemetryHistoryService.ts'

type JudgmentJobDeleteTx = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}
type JudgmentJobSqliteDeletePendingRow = {jobId: string}
type JudgmentJobLocalStateDeleter = {deleteJob: (jobId: string) => Promise<void>; hasJob: (jobId: string) => boolean}

const tokenUseCreateSql = `
  CREATE TABLE app.token_use (
    id VARCHAR PRIMARY KEY,
    judgment_job_id VARCHAR,
    requests INTEGER NOT NULL,
    total_prompt_tokens BIGINT NOT NULL,
    total_completion_tokens BIGINT NOT NULL,
    total_tokens BIGINT NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    duration BIGINT,
    gpu_nnodes INTEGER,
    gpu_gpus_per_node INTEGER,
    gpu_total_gpus INTEGER,
    tp_size INTEGER,
    dp_size INTEGER,
    gpu_shape VARCHAR,
    sglang_max_running_requests INTEGER,
    sglang_model VARCHAR,
    successful_requests INTEGER,
    failed_requests INTEGER,
    has_failed_requests BOOLEAN,
    failed_requests_details JSON,
    total_success_prompt_tokens BIGINT,
    total_success_completion_tokens BIGINT,
    total_success_tokens BIGINT,
    total_failed_prompt_tokens BIGINT,
    total_failed_completion_tokens BIGINT,
    total_failed_tokens BIGINT,
    request_attempts_json JSON,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
  )
`

const getTempTableName = (prefix: string) => {
  return `temp_${prefix}_${crypto.randomUUID().replaceAll('-', '_')}`
}

const tokenUseColumns = [
  'id',
  'judgment_job_id',
  'requests',
  'total_prompt_tokens',
  'total_completion_tokens',
  'total_tokens',
  'started_at',
  'finished_at',
  'duration',
  'gpu_nnodes',
  'gpu_gpus_per_node',
  'gpu_total_gpus',
  'tp_size',
  'dp_size',
  'gpu_shape',
  'sglang_max_running_requests',
  'sglang_model',
  'successful_requests',
  'failed_requests',
  'has_failed_requests',
  'failed_requests_details',
  'total_success_prompt_tokens',
  'total_success_completion_tokens',
  'total_success_tokens',
  'total_failed_prompt_tokens',
  'total_failed_completion_tokens',
  'total_failed_tokens',
  'request_attempts_json',
  'created_at',
  'updated_at',
]

export const rebuildTokenUseWithoutJobTx = async ({jobId, tx}: {jobId: string; tx: JudgmentJobDeleteTx}) => {
  const tempTableName = getTempTableName('judgment_job_delete_token_use')

  await tx.run(`
    CREATE TEMP TABLE ${tempTableName} AS
    SELECT *
    FROM app.token_use
    WHERE judgment_job_id != ${getSqlLiteral(jobId)}
       OR judgment_job_id IS NULL
  `)
  await tx.run(`DROP TABLE app.token_use`)
  await tx.run(tokenUseCreateSql)
  await tx.run(`
    INSERT INTO app.token_use (${tokenUseColumns.join(', ')})
    SELECT
      id,
      judgment_job_id,
      requests,
      total_prompt_tokens,
      total_completion_tokens,
      total_tokens,
      started_at,
      finished_at,
      duration,
      gpu_nnodes,
      gpu_gpus_per_node,
      gpu_total_gpus,
      tp_size,
      dp_size,
      gpu_shape,
      sglang_max_running_requests,
      sglang_model,
      successful_requests,
      failed_requests,
      has_failed_requests,
      failed_requests_details,
      total_success_prompt_tokens,
      total_success_completion_tokens,
      total_success_tokens,
      total_failed_prompt_tokens,
      total_failed_completion_tokens,
      total_failed_tokens,
      request_attempts_json,
      COALESCE(created_at, current_timestamp),
      COALESCE(updated_at, current_timestamp)
    FROM ${tempTableName}
  `)
  await tx.run(`DROP TABLE ${tempTableName}`)
}

const deleteRequestAttemptCloseoutsForJobTx = async ({jobId, tx}: {jobId: string; tx: JudgmentJobDeleteTx}) => {
  await tx.run(`
    DELETE FROM app.request_attempt_closeout
    WHERE token_use_id IN (
      SELECT id
      FROM app.token_use
      WHERE judgment_job_id = ${getSqlLiteral(jobId)}
    )
  `)
}

export const deleteJudgmentJobSafelyTx = async ({jobId, tx}: {jobId: string; tx: JudgmentJobDeleteTx}) => {
  await deleteRequestAttemptCloseoutsForJobTx({jobId, tx})
  await rebuildTokenUseWithoutJobTx({jobId, tx})
  await deleteJudgmentProviderTelemetryHistoryForJob({jobId, runner: tx})
  await tx.run(`
    DELETE FROM app.judgment_job
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

export const markJudgmentJobSqliteDeletePendingTx = async ({jobId, tx}: {jobId: string; tx: JudgmentJobDeleteTx}) => {
  await tx.run(`
    INSERT INTO app.judgment_job_sqlite_delete_pending (job_id)
    VALUES (${getSqlLiteral(jobId)})
    ON CONFLICT(job_id) DO UPDATE SET
      updated_at = now()
  `)
}

export const clearJudgmentJobSqliteDeletePending = async (jobId: string) => {
  await getAppDatabaseService().run(`
    DELETE FROM app.judgment_job_sqlite_delete_pending
    WHERE job_id = ${getSqlLiteral(jobId)}
  `)
}

const recordJudgmentJobSqliteDeletePendingFailure = async (params: {error: unknown; jobId: string}) => {
  const message = params.error instanceof Error ? params.error.message : String(params.error)

  await getAppDatabaseService().run(`
    UPDATE app.judgment_job_sqlite_delete_pending
    SET last_attempt_at = current_timestamp,
        attempt_count = attempt_count + 1,
        last_error = ${getSqlLiteral(message)},
        updated_at = current_timestamp
    WHERE job_id = ${getSqlLiteral(params.jobId)}
  `)
}

const getPendingJudgmentJobSqliteDeleteRows = async (limit: number) => {
  return getAppDatabaseService().queryJson<JudgmentJobSqliteDeletePendingRow>(`
    SELECT job_id AS jobId
    FROM app.judgment_job_sqlite_delete_pending
    ORDER BY last_attempt_at ASC NULLS FIRST, requested_at ASC, job_id ASC
    LIMIT ${limit}
  `)
}

const retryPendingJudgmentJobSqliteDelete = async (params: {
  jobId: string
  sqliteService: JudgmentJobLocalStateDeleter
}) => {
  try {
    if (params.sqliteService.hasJob(params.jobId)) {
      await params.sqliteService.deleteJob(params.jobId)
    }

    await clearJudgmentJobSqliteDeletePending(params.jobId)
    return {deleted: true, jobId: params.jobId}
  } catch (error) {
    await recordJudgmentJobSqliteDeletePendingFailure({error, jobId: params.jobId})
    return {deleted: false, jobId: params.jobId}
  }
}

export const retryPendingJudgmentJobSqliteDeletes = async (params: {
  limit?: number
  sqliteService: JudgmentJobLocalStateDeleter
}) => {
  const rows = await getPendingJudgmentJobSqliteDeleteRows(params.limit ?? 25)
  const results = await rows.reduce<Promise<Array<{deleted: boolean; jobId: string}>>>(async (promise, row) => {
    const completed = await promise
    const result = await retryPendingJudgmentJobSqliteDelete({jobId: row.jobId, sqliteService: params.sqliteService})
    return [...completed, result]
  }, Promise.resolve([]))
  const deletedCount = results.filter((result) => {
    return result.deleted
  }).length

  return {deletedCount, attemptedCount: results.length}
}

export const deletePendingJudgmentJobSqliteState = async (params: {
  jobId: string
  sqliteService: JudgmentJobLocalStateDeleter
}) => {
  const result = await retryPendingJudgmentJobSqliteDelete(params)

  return {localCleanupPending: !result.deleted}
}

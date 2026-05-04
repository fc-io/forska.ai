import {getSqlLiteral} from './appQueryHelpers.ts'

type JudgmentJobDeleteTx = {run: (statement: string) => Promise<void>}

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

export const deleteJudgmentJobSafelyTx = async ({jobId, tx}: {jobId: string; tx: JudgmentJobDeleteTx}) => {
  await rebuildTokenUseWithoutJobTx({jobId, tx})
  await tx.run(`
    DELETE FROM app.judgment_job
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

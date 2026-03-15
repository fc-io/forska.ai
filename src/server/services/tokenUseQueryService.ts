import type {TokenUseRecord} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from './appQueryHelpers.ts'

type TokenUseRow = {
  id: string
  createdAt: unknown
  updatedAt: unknown
  judgmentsJobId: string | null
  requests: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  startedAt: unknown
  finishedAt: unknown
  duration: number | null
  gpuNnodes: number | null
  gpuGpusPerNode: number | null
  gpuTotalGpus: number | null
  tpSize: number | null
  dpSize: number | null
  gpuShape: string | null
  sglangMaxRunningRequests: number | null
  sglangModel: string | null
  successfulRequests: number | null
  failedRequests: number | null
  hasFailedRequests: boolean | null
  failedRequestsDetails: unknown
  totalSuccessPromptTokens: number | null
  totalSuccessCompletionTokens: number | null
  totalSuccessTokens: number | null
  totalFailedPromptTokens: number | null
  totalFailedCompletionTokens: number | null
  totalFailedTokens: number | null
}

type TokenUseProjection = {
  createdAt: Date
  totalPromptTokens?: number | string | null
  totalCompletionTokens?: number | string | null
  totalTokens?: number | string | null
  requests?: number | string | null
  totalSuccessPromptTokens?: number | string | null
  totalSuccessCompletionTokens?: number | string | null
  totalSuccessTokens?: number | string | null
  totalFailedTokens?: number | string | null
}

type ModelInfo = {provider: string | null; modelName: string | null; version: string | null}

const getTokenUseValue = (row: TokenUseRow): TokenUseRecord => {
  return {
    id: row.id,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    updatedAt: getDateValue(row.updatedAt) ?? new Date(0),
    judgmentsJobId: row.judgmentsJobId,
    requests: row.requests,
    totalPromptTokens: row.totalPromptTokens,
    totalCompletionTokens: row.totalCompletionTokens,
    totalTokens: row.totalTokens,
    startedAt: getDateValue(row.startedAt),
    finishedAt: getDateValue(row.finishedAt),
    duration: row.duration,
    gpuNnodes: row.gpuNnodes,
    gpuGpusPerNode: row.gpuGpusPerNode,
    gpuTotalGpus: row.gpuTotalGpus,
    tpSize: row.tpSize,
    dpSize: row.dpSize,
    gpuShape: row.gpuShape,
    sglangMaxRunningRequests: row.sglangMaxRunningRequests,
    sglangModel: row.sglangModel,
    successfulRequests: row.successfulRequests,
    failedRequests: row.failedRequests,
    hasFailedRequests: row.hasFailedRequests ?? false,
    failedRequestsDetails: getJsonValue(row.failedRequestsDetails) as TokenUseRecord['failedRequestsDetails'],
    totalSuccessPromptTokens: row.totalSuccessPromptTokens,
    totalSuccessCompletionTokens: row.totalSuccessCompletionTokens,
    totalSuccessTokens: row.totalSuccessTokens,
    totalFailedPromptTokens: row.totalFailedPromptTokens,
    totalFailedCompletionTokens: row.totalFailedCompletionTokens,
    totalFailedTokens: row.totalFailedTokens,
  }
}

const tokenUseSelectClause = `
  id,
  created_at AS createdAt,
  updated_at AS updatedAt,
  judgment_job_id AS judgmentsJobId,
  requests,
  total_prompt_tokens AS totalPromptTokens,
  total_completion_tokens AS totalCompletionTokens,
  total_tokens AS totalTokens,
  started_at AS startedAt,
  finished_at AS finishedAt,
  duration,
  gpu_nnodes AS gpuNnodes,
  gpu_gpus_per_node AS gpuGpusPerNode,
  gpu_total_gpus AS gpuTotalGpus,
  tp_size AS tpSize,
  dp_size AS dpSize,
  gpu_shape AS gpuShape,
  sglang_max_running_requests AS sglangMaxRunningRequests,
  sglang_model AS sglangModel,
  successful_requests AS successfulRequests,
  failed_requests AS failedRequests,
  has_failed_requests AS hasFailedRequests,
  TO_JSON(failed_requests_details) AS failedRequestsDetails,
  total_success_prompt_tokens AS totalSuccessPromptTokens,
  total_success_completion_tokens AS totalSuccessCompletionTokens,
  total_success_tokens AS totalSuccessTokens,
  total_failed_prompt_tokens AS totalFailedPromptTokens,
  total_failed_completion_tokens AS totalFailedCompletionTokens,
  total_failed_tokens AS totalFailedTokens
`

const insertTokenUse = async (values: Record<string, unknown>) => {
  const columns = Object.keys(values)
  const rowValues = Object.values(values)
  const [row] = await getAppDatabaseService().queryJson<TokenUseRow>(`
    INSERT INTO app.token_use (${columns.join(', ')})
    VALUES (${rowValues
      .map((value) => {
        return getSqlLiteral(value)
      })
      .join(', ')})
    RETURNING ${tokenUseSelectClause}
  `)

  return row ? getTokenUseValue(row) : null
}

const getLargestSingleRequestRows = async (orderColumn: 'total_prompt_tokens' | 'total_completion_tokens') => {
  const rows = await getAppDatabaseService().queryJson<TokenUseRow>(`
    SELECT ${tokenUseSelectClause}
    FROM app.token_use
    WHERE requests = 1
    ORDER BY ${orderColumn} DESC NULLS LAST
    LIMIT 5
  `)

  return rows.map((row) => {
    return getTokenUseValue(row)
  })
}

const getTotals = async (params: {startTime?: string; endTime?: string}) => {
  const whereParts = [
    params.startTime ? `created_at >= ${getTimestampLiteral(new Date(params.startTime))}` : null,
    params.endTime ? `created_at <= ${getTimestampLiteral(new Date(params.endTime))}` : null,
  ].filter((part): part is string => {
    return part !== null
  })
  const [row] = await getAppDatabaseService().queryJson<{
    totalPromptTokens: number | null
    totalCompletionTokens: number | null
    totalTokens: number | null
  }>(`
    SELECT
      SUM(total_prompt_tokens) AS totalPromptTokens,
      SUM(total_completion_tokens) AS totalCompletionTokens,
      SUM(total_tokens) AS totalTokens
    FROM app.token_use
    ${whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''}
  `)

  return {
    totalPromptTokens: Number(row?.totalPromptTokens ?? 0),
    totalCompletionTokens: Number(row?.totalCompletionTokens ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
  }
}

const getTimelineRowsForProject = async (params: {projectId: string; startDate: Date; endDate: Date}) => {
  const rows = await getAppDatabaseService().queryJson<{
    createdAt: unknown
    totalPromptTokens: number | null
    totalCompletionTokens: number | null
    totalTokens: number | null
    requests: number | null
    totalSuccessPromptTokens: number | null
    totalSuccessCompletionTokens: number | null
    totalSuccessTokens: number | null
    totalFailedTokens: number | null
  }>(`
    SELECT
      tu.created_at AS createdAt,
      tu.total_prompt_tokens AS totalPromptTokens,
      tu.total_completion_tokens AS totalCompletionTokens,
      tu.total_tokens AS totalTokens,
      tu.requests,
      tu.total_success_prompt_tokens AS totalSuccessPromptTokens,
      tu.total_success_completion_tokens AS totalSuccessCompletionTokens,
      tu.total_success_tokens AS totalSuccessTokens,
      tu.total_failed_tokens AS totalFailedTokens
    FROM app.token_use tu
    INNER JOIN app.judgment_job jj ON jj.id = tu.judgment_job_id
    WHERE jj.project_id = '${escapeSqlString(params.projectId)}'
      AND tu.created_at >= ${getTimestampLiteral(params.startDate)}
      AND tu.created_at < ${getTimestampLiteral(params.endDate)}
  `)

  return rows.reduce<TokenUseProjection[]>((acc, row) => {
    const createdAt = getDateValue(row.createdAt)
    return createdAt ? [...acc, {...row, createdAt}] : acc
  }, [])
}

const getTimelineRowsAllJobs = async (params: {startDate: Date; endDate: Date}) => {
  const rows = await getAppDatabaseService().queryJson<{
    createdAt: unknown
    totalPromptTokens: number | null
    totalCompletionTokens: number | null
    totalTokens: number | null
    requests: number | null
    totalSuccessPromptTokens: number | null
    totalSuccessCompletionTokens: number | null
    totalSuccessTokens: number | null
    totalFailedTokens: number | null
  }>(`
    SELECT
      created_at AS createdAt,
      total_prompt_tokens AS totalPromptTokens,
      total_completion_tokens AS totalCompletionTokens,
      total_tokens AS totalTokens,
      requests,
      total_success_prompt_tokens AS totalSuccessPromptTokens,
      total_success_completion_tokens AS totalSuccessCompletionTokens,
      total_success_tokens AS totalSuccessTokens,
      total_failed_tokens AS totalFailedTokens
    FROM app.token_use
    WHERE judgment_job_id IS NOT NULL
      AND created_at >= ${getTimestampLiteral(params.startDate)}
      AND created_at < ${getTimestampLiteral(params.endDate)}
  `)

  return rows.reduce<TokenUseProjection[]>((acc, row) => {
    const createdAt = getDateValue(row.createdAt)
    return createdAt ? [...acc, {...row, createdAt}] : acc
  }, [])
}

const getFailedRequestsRows = async (params: {limit: number; offset: number}) => {
  const rows = await getAppDatabaseService().queryJson<{
    id: string
    createdAt: unknown
    judgmentsJobId: string | null
    projectId: string | null
    projectName: string | null
    modelName: string | null
    failedRequests: number | null
    failedRequestsDetails: unknown
    totalTokens: number
  }>(`
    SELECT
      tu.id AS id,
      tu.created_at AS createdAt,
      tu.judgment_job_id AS judgmentsJobId,
      p.id AS projectId,
      p.name AS projectName,
      tu.sglang_model AS modelName,
      tu.failed_requests AS failedRequests,
      TO_JSON(tu.failed_requests_details) AS failedRequestsDetails,
      tu.total_tokens AS totalTokens
    FROM app.token_use tu
    LEFT JOIN app.judgment_job jj ON tu.judgment_job_id = jj.id
    LEFT JOIN app.project p ON jj.project_id = p.id
    WHERE tu.has_failed_requests = TRUE
    ORDER BY tu.created_at DESC
    LIMIT ${params.limit}
    OFFSET ${params.offset}
  `)

  return rows.map((row) => {
    return {
      ...row,
      createdAt: getDateValue(row.createdAt),
      failedRequestsDetails: getJsonValue(row.failedRequestsDetails),
    }
  })
}

const getFailedRequestsCount = async () => {
  const [row] = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.token_use
    WHERE has_failed_requests = TRUE
  `)

  return Number(row?.count ?? 0)
}

const getPromptHeadingMap = async (promptIds: string[]) => {
  if (promptIds.length === 0) {
    return new Map<string, string | null>()
  }

  const rows = await getAppDatabaseService().queryJson<{id: string; promptHeading: string | null}>(`
    SELECT id, prompt_heading AS promptHeading
    FROM app.prompt
    WHERE id IN (${getQuotedStringList(promptIds).join(', ')})
  `)

  return new Map(
    rows.map((row) => {
      return [row.id, row.promptHeading]
    }),
  )
}

const getModelInfoMap = async (modelIds: string[]) => {
  if (modelIds.length === 0) {
    return new Map<string, ModelInfo>()
  }

  const rows = await getAppDatabaseService().queryJson<{
    id: string
    provider: string | null
    modelName: string | null
    version: string | null
  }>(`
    SELECT id, provider, model_name AS modelName, version
    FROM app.model
    WHERE id IN (${getQuotedStringList(modelIds).join(', ')})
  `)

  return new Map(
    rows.map((row) => {
      return [row.id, {provider: row.provider, modelName: row.modelName, version: row.version}]
    }),
  )
}

const getFailedRequestById = async (id: string) => {
  const [row] = await getAppDatabaseService().queryJson<{
    id: string
    createdAt: unknown
    judgmentsJobId: string | null
    projectId: string | null
    modelName: string | null
    failedRequests: number | null
    failedRequestsDetails: unknown
    totalTokens: number
    requests: number
    successfulRequests: number | null
  }>(`
    SELECT
      tu.id AS id,
      tu.created_at AS createdAt,
      tu.judgment_job_id AS judgmentsJobId,
      jj.project_id AS projectId,
      tu.sglang_model AS modelName,
      tu.failed_requests AS failedRequests,
      TO_JSON(tu.failed_requests_details) AS failedRequestsDetails,
      tu.total_tokens AS totalTokens,
      tu.requests AS requests,
      tu.successful_requests AS successfulRequests
    FROM app.token_use tu
    LEFT JOIN app.judgment_job jj ON tu.judgment_job_id = jj.id
    WHERE tu.id = '${escapeSqlString(id)}'
    LIMIT 1
  `)

  return row
    ? {...row, createdAt: getDateValue(row.createdAt), failedRequestsDetails: getJsonValue(row.failedRequestsDetails)}
    : null
}

export const tokenUseQueryService = {
  getFailedRequestById,
  getFailedRequestsCount,
  getFailedRequestsRows,
  getLargestSingleRequestRows,
  getModelInfoMap,
  getPromptHeadingMap,
  getTimelineRowsAllJobs,
  getTimelineRowsForProject,
  getTotals,
  insertTokenUse,
}

export const getTokenUseQueryService = () => {
  return tokenUseQueryService
}

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
import {projectRequestAttemptCloseoutsForTokenUse} from './requestAttemptCloseoutService.ts'

type TokenUseMutationRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

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
  requestAttemptsJson: unknown
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

type TokenUseProjectionDatabaseRow = Omit<TokenUseProjection, 'createdAt'> & {createdAt: unknown}

type TokenTimelineInterval = '1min' | '5min' | '15min' | '1h' | '24h' | '1w' | '1m'

type ModelInfo = {provider: string | null; modelName: string | null; version: string | null}
type FailedRequestDetailRecord = Record<string, unknown>

export class TokenUseIdempotencyConflictError extends Error {
  id: string
  mismatch: string

  constructor({id, mismatch}: {id: string; mismatch: string}) {
    super(`token use idempotency conflict for ${id}: ${mismatch} mismatch`)
    this.name = 'TokenUseIdempotencyConflictError'
    this.id = id
    this.mismatch = mismatch
  }
}

const getFailedRequestDetailRecord = (value: unknown): FailedRequestDetailRecord | null => {
  const parsedValue = typeof value === 'string' ? getJsonValue(value) : value

  return parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
    ? (parsedValue as FailedRequestDetailRecord)
    : null
}

const getFailedRequestsDetailsValue = (value: unknown): TokenUseRecord['failedRequestsDetails'] => {
  const parsedValue = getJsonValue(value)
  const arrayValue = Array.isArray(parsedValue) ? (parsedValue as unknown[]) : null

  return arrayValue
    ? arrayValue.map<unknown>((entry) => {
        return getFailedRequestDetailRecord(entry) ?? entry
      })
    : null
}

const getJsonLiteral = (value: unknown) => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getJsonTextLiteral = (value: unknown) => {
  return typeof value === 'string' ? `CAST(${getSqlLiteral(value)} AS JSON)` : getJsonLiteral(value)
}

const getTokenUseInsertLiteral = (column: string, value: unknown) => {
  return column === 'failed_requests_details'
    ? getJsonLiteral(value)
    : column === 'request_attempts_json'
      ? getJsonTextLiteral(value)
      : getSqlLiteral(value)
}

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
    failedRequestsDetails: getFailedRequestsDetailsValue(row.failedRequestsDetails),
    totalSuccessPromptTokens: row.totalSuccessPromptTokens,
    totalSuccessCompletionTokens: row.totalSuccessCompletionTokens,
    totalSuccessTokens: row.totalSuccessTokens,
    totalFailedPromptTokens: row.totalFailedPromptTokens,
    totalFailedCompletionTokens: row.totalFailedCompletionTokens,
    totalFailedTokens: row.totalFailedTokens,
    requestAttemptsJson: getJsonValue(row.requestAttemptsJson),
  }
}

const getTimelineProjectionRows = (rows: TokenUseProjectionDatabaseRow[]): TokenUseProjection[] => {
  return rows.flatMap((row) => {
    const createdAt = getDateValue(row.createdAt)

    return createdAt ? [{...row, createdAt}] : []
  })
}

const timelineBucketExpressions: Record<TokenTimelineInterval, string> = {
  '1min': "date_trunc('minute', created_at)",
  '5min': "time_bucket(INTERVAL '5 minutes', created_at)",
  '15min': "time_bucket(INTERVAL '15 minutes', created_at)",
  '1h': "date_trunc('hour', created_at)",
  '24h': "date_trunc('day', created_at)",
  '1w': "time_bucket(INTERVAL '1 week', created_at)",
  '1m': "date_trunc('month', created_at)",
}

const getTimelineBucketExpression = (interval: TokenTimelineInterval): string => {
  return timelineBucketExpressions[interval]
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
  total_failed_tokens AS totalFailedTokens,
  TO_JSON(request_attempts_json) AS requestAttemptsJson
`

const getInsertTokenUseValues = (values: Record<string, unknown>) => {
  const existingId = typeof values.id === 'string' ? values.id.trim() : ''

  return existingId.length > 0 ? values : {...values, id: crypto.randomUUID()}
}

const tokenUseInsertColumnValueGetters: Record<string, (row: TokenUseRecord) => unknown> = {
  created_at: (row) => {
    return row.createdAt
  },
  dp_size: (row) => {
    return row.dpSize
  },
  duration: (row) => {
    return row.duration
  },
  failed_requests: (row) => {
    return row.failedRequests
  },
  failed_requests_details: (row) => {
    return row.failedRequestsDetails
  },
  finished_at: (row) => {
    return row.finishedAt
  },
  gpu_gpus_per_node: (row) => {
    return row.gpuGpusPerNode
  },
  gpu_nnodes: (row) => {
    return row.gpuNnodes
  },
  gpu_shape: (row) => {
    return row.gpuShape
  },
  gpu_total_gpus: (row) => {
    return row.gpuTotalGpus
  },
  has_failed_requests: (row) => {
    return row.hasFailedRequests
  },
  id: (row) => {
    return row.id
  },
  judgment_job_id: (row) => {
    return row.judgmentsJobId
  },
  request_attempts_json: (row) => {
    return row.requestAttemptsJson
  },
  requests: (row) => {
    return row.requests
  },
  sglang_max_running_requests: (row) => {
    return row.sglangMaxRunningRequests
  },
  sglang_model: (row) => {
    return row.sglangModel
  },
  started_at: (row) => {
    return row.startedAt
  },
  successful_requests: (row) => {
    return row.successfulRequests
  },
  total_completion_tokens: (row) => {
    return row.totalCompletionTokens
  },
  total_failed_completion_tokens: (row) => {
    return row.totalFailedCompletionTokens
  },
  total_failed_prompt_tokens: (row) => {
    return row.totalFailedPromptTokens
  },
  total_failed_tokens: (row) => {
    return row.totalFailedTokens
  },
  total_prompt_tokens: (row) => {
    return row.totalPromptTokens
  },
  total_success_completion_tokens: (row) => {
    return row.totalSuccessCompletionTokens
  },
  total_success_prompt_tokens: (row) => {
    return row.totalSuccessPromptTokens
  },
  total_success_tokens: (row) => {
    return row.totalSuccessTokens
  },
  total_tokens: (row) => {
    return row.totalTokens
  },
  tp_size: (row) => {
    return row.tpSize
  },
  updated_at: (row) => {
    return row.updatedAt
  },
}

const tokenUseJsonColumns = new Set(['failed_requests_details', 'request_attempts_json'])
const tokenUseTimestampColumns = new Set(['created_at', 'finished_at', 'started_at', 'updated_at'])

const getStableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      return getStableJsonValue(entry)
    })
  }

  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((stableValue, key) => {
        return {...stableValue, [key]: getStableJsonValue((value as Record<string, unknown>)[key])}
      }, {})
  }

  return value instanceof Date ? value.toISOString() : value
}

const getTokenUseComparableValue = (column: string, value: unknown): string => {
  if (tokenUseTimestampColumns.has(column)) {
    return getDateValue(value)?.toISOString() ?? 'null'
  }

  if (tokenUseJsonColumns.has(column)) {
    return JSON.stringify(getStableJsonValue(getJsonValue(value)) ?? null)
  }

  return value === null || value === undefined
    ? 'null'
    : typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
        ? String(value)
        : JSON.stringify(getStableJsonValue(value))
}

const getTokenUseConflictMismatch = (
  existingRow: TokenUseRecord,
  insertValues: Record<string, unknown>,
): string | null => {
  return Object.keys(insertValues).reduce<string | null>((mismatch, column) => {
    const getExistingValue = tokenUseInsertColumnValueGetters[column]

    if (mismatch || !getExistingValue) {
      return mismatch
    }

    const existingValue = getTokenUseComparableValue(column, getExistingValue(existingRow))
    const incomingValue = getTokenUseComparableValue(column, insertValues[column])

    return existingValue === incomingValue ? null : column
  }, null)
}

const assertTokenUseIdempotentConflictMatches = (
  existingRow: TokenUseRecord,
  insertValues: Record<string, unknown>,
): void => {
  const mismatch = getTokenUseConflictMismatch(existingRow, insertValues)

  if (mismatch) {
    throw new TokenUseIdempotencyConflictError({id: existingRow.id, mismatch})
  }
}

const getInsertTokenUseSql = (insertValues: Record<string, unknown>): string => {
  const columns = Object.keys(insertValues)

  return `
    INSERT INTO app.token_use (${columns.join(', ')})
    VALUES (${columns
      .map((column) => {
        return getTokenUseInsertLiteral(column, insertValues[column])
      })
      .join(', ')})
    RETURNING ${tokenUseSelectClause}
  `
}

const getInsertTokenUseOnceSql = (insertValues: Record<string, unknown>): string => {
  const columns = Object.keys(insertValues)

  return `
    INSERT INTO app.token_use (${columns.join(', ')})
    VALUES (${columns
      .map((column) => {
        return getTokenUseInsertLiteral(column, insertValues[column])
      })
      .join(', ')})
    ON CONFLICT(id) DO NOTHING
    RETURNING ${tokenUseSelectClause}
  `
}

const getTokenUseById = async (runner: TokenUseMutationRunner, id: string): Promise<TokenUseRecord | null> => {
  const [existingRow] = await runner.queryJson<TokenUseRow>(`
    SELECT ${tokenUseSelectClause}
    FROM app.token_use
    WHERE id = ${getSqlLiteral(id)}
    LIMIT 1
  `)

  return existingRow ? getTokenUseValue(existingRow) : null
}

const projectRequestAttemptCloseoutsForTokenUseValue = async (
  runner: TokenUseMutationRunner,
  tokenUse: TokenUseRecord,
): Promise<void> => {
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

const insertTokenUse = async (values: Record<string, unknown>) => {
  const insertValues = getInsertTokenUseValues(values)

  return getAppDatabaseService().transaction(async (tx) => {
    const [row] = await tx.queryJson<TokenUseRow>(getInsertTokenUseSql(insertValues))
    const tokenUse = row ? getTokenUseValue(row) : null

    if (tokenUse) {
      await projectRequestAttemptCloseoutsForTokenUseValue(tx, tokenUse)
    }

    return tokenUse
  }) as Promise<TokenUseRecord | null>
}

const insertTokenUseOnce = async (values: Record<string, unknown>) => {
  const insertValues = getInsertTokenUseValues(values)

  return getAppDatabaseService().transaction(async (tx) => {
    const [insertedRow] = await tx.queryJson<TokenUseRow>(getInsertTokenUseOnceSql(insertValues))

    if (insertedRow) {
      const insertedValue = getTokenUseValue(insertedRow)
      await projectRequestAttemptCloseoutsForTokenUseValue(tx, insertedValue)
      return insertedValue
    }

    const id = typeof insertValues.id === 'string' ? insertValues.id : ''
    const existingValue = await getTokenUseById(tx, id)

    if (!existingValue) {
      return null
    }

    assertTokenUseIdempotentConflictMatches(existingValue, insertValues)
    await projectRequestAttemptCloseoutsForTokenUseValue(tx, existingValue)

    return existingValue
  }) as Promise<TokenUseRecord | null>
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
  const rows = await getAppDatabaseService().queryJson<TokenUseProjectionDatabaseRow>(`
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

  return getTimelineProjectionRows(rows)
}

const getTimelineRowsAllJobs = async (params: {startDate: Date; endDate: Date}) => {
  const rows = await getAppDatabaseService().queryJson<TokenUseProjectionDatabaseRow>(`
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

  return getTimelineProjectionRows(rows)
}

const getTimelineBucketRowsAllJobs = async (params: {
  endDate: Date
  interval: TokenTimelineInterval
  startDate: Date
}) => {
  const bucketExpression = getTimelineBucketExpression(params.interval)
  const rows = await getAppDatabaseService().queryJson<TokenUseProjectionDatabaseRow>(`
    SELECT
      ${bucketExpression} AS createdAt,
      SUM(COALESCE(total_prompt_tokens, 0)) AS totalPromptTokens,
      SUM(COALESCE(total_completion_tokens, 0)) AS totalCompletionTokens,
      SUM(COALESCE(total_tokens, 0)) AS totalTokens,
      SUM(COALESCE(requests, 0)) AS requests,
      SUM(COALESCE(total_success_prompt_tokens, 0)) AS totalSuccessPromptTokens,
      SUM(COALESCE(total_success_completion_tokens, 0)) AS totalSuccessCompletionTokens,
      SUM(COALESCE(total_success_tokens, 0)) AS totalSuccessTokens,
      SUM(COALESCE(total_failed_tokens, 0)) AS totalFailedTokens
    FROM app.token_use
    WHERE judgment_job_id IS NOT NULL
      AND created_at >= ${getTimestampLiteral(params.startDate)}
      AND created_at < ${getTimestampLiteral(params.endDate)}
    GROUP BY 1
    ORDER BY 1
  `)

  return getTimelineProjectionRows(rows)
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
      failedRequestsDetails: getFailedRequestsDetailsValue(row.failedRequestsDetails),
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
    SELECT
      m.id AS id,
      pc.provider_kind AS provider,
      m.remote_model_id AS modelName,
      m.variant AS version
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id IN (${getQuotedStringList(modelIds).join(', ')})
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
    ? {
        ...row,
        createdAt: getDateValue(row.createdAt),
        failedRequestsDetails: getFailedRequestsDetailsValue(row.failedRequestsDetails),
      }
    : null
}

export const tokenUseQueryService = {
  getFailedRequestById,
  getFailedRequestsCount,
  getFailedRequestsRows,
  getLargestSingleRequestRows,
  getTimelineBucketRowsAllJobs,
  getModelInfoMap,
  getPromptHeadingMap,
  getTimelineRowsAllJobs,
  getTimelineRowsForProject,
  getTotals,
  insertTokenUse,
  insertTokenUseOnce,
}

export const getTokenUseQueryService = () => {
  return tokenUseQueryService
}
